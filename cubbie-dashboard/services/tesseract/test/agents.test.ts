import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import * as repo from '../src/db/repo';
import { setClaudeForTests } from '../src/claude/client';
import { orchestrate, shouldScanPassively } from '../src/agents/orchestrator';
import { ALEX, MAYA, SAM, freshProject } from './helpers';

/** Builds a fake Messages API that replays a script per agent and records what it was sent. */
function fakeClaude(script: { route: string[]; agents: Record<string, Array<{ tool?: [string, any]; text?: string }>> }) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const step: Record<string, number> = {};
  const fn = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    calls.push(params);
    const sys = String(params.system);
    const base = { id: 'm', type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as any;
    if (params.tool_choice && (params.tool_choice as any).name === 'route')
      return { ...base, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'route', input: { agents: script.route } }] };
    const agent = Object.keys(script.agents).find(a => sys.includes(`You are the ${a}`) || sys.includes(a))!;
    const i = step[agent] = (step[agent] ?? -1) + 1;
    const s = script.agents[agent][i] ?? { text: 'ok' };
    if (s.tool) return { ...base, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${agent}${i}`, name: s.tool[0], input: s.tool[1] }] };
    return { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: s.text }] };
  };
  return { fn, calls };
}

afterEach(() => setClaudeForTests(null));

describe('multi-agent orchestration', () => {
  it('Planner then Dependency Manager share state for "I\'ll do research, Maya slides, she needs mine first"', async () => {
    const p = freshProject();
    const fake = fakeClaude({
      route: ['planner', 'dependency'],
      agents: {
        'PROJECT PLANNER': [
          { tool: ['propose_tasks', { tasks: [
            { title: 'Research', owner_id: ALEX, due: new Date(Date.now() + 2 * 86400000).toISOString(), speaker_committed: true },
            { title: 'Presentation slides', owner_id: MAYA, due: new Date(Date.now() + 4 * 86400000).toISOString() },
            { title: 'Testing', owner_id: SAM },
          ] }] },
          { tool: ['handoff_note', { note: 'Slides (#2) depend on research (#1).' }] },
          { text: 'Got it — research is yours, Alex. Maya and Sam, confirm below.' },
        ],
        'DEPENDENCY MANAGER': [
          { tool: ['add_dependency', { blocking_task_id: 1, dependent_task_id: 2, note: 'slides need research' }] },
          { text: 'Slides wait on research; I\'ll ping Maya when it\'s done.' },
        ],
      },
    });
    setClaudeForTests(fake.fn);
    const res = await orchestrate({ project: p, actorId: ALEX, actorName: 'Alex', channelId: 'c1', mode: 'mention',
      text: "I'll handle research, Maya can do slides, and Sam can do testing. Maya needs my research first." });

    expect(res.agents).toEqual(['Planner', 'Dependency Manager']);
    expect(repo.getTask(1)).toMatchObject({ owner_id: ALEX, status: 'confirmed' });   // speaker's own commitment
    expect(repo.getTask(2)!.status).toBe('proposed');                                 // Maya must confirm
    expect(repo.getTask(3)!.status).toBe('proposed');
    expect(repo.listDependencies(p.id, 'active')).toHaveLength(1);
    expect(res.outs.filter(o => o.kind === 'decision')).toHaveLength(2);
    // The second agent saw the first agent's hand-off note AND the new tasks in shared state.
    const depSystem = String(fake.calls.find(c => String(c.system).includes('DEPENDENCY MANAGER'))!.system);
    expect(depSystem).toContain('Slides (#2) depend on research (#1).');
    expect(depSystem).toContain('#1 "Research"');
    expect(res.reply).toContain('Planner');
    expect(repo.recentAgentLog(p.id, 50).some(r => r.action === 'routed')).toBe(true);
  });

  it('enforces permissions even if Claude tries to overstep', async () => {
    const p = freshProject();
    const t = repo.createTask({ project_id: p.id, title: 'Research', owner_id: ALEX, status: 'confirmed' });
    const fake = fakeClaude({
      route: ['accountability'],
      agents: { 'ACCOUNTABILITY MANAGER': [{ tool: ['update_task_status', { task_id: t.id, status: 'done' }] }, { text: 'Only Alex can mark that done.' }] },
    });
    setClaudeForTests(fake.fn);
    await orchestrate({ project: p, actorId: MAYA, actorName: 'Maya', channelId: 'c1', mode: 'mention', text: 'research is done' });
    expect(repo.getTask(t.id)!.status).toBe('confirmed');
    const toolResultMsg = fake.calls.at(-1)!.messages.at(-1)!;
    expect(JSON.stringify(toolResultMsg.content)).toContain('Only Alex can mark');
  });

  it('a natural-language "confirmed" answers the pending proposal for the speaker', async () => {
    const p = freshProject();
    const t = repo.createTask({ project_id: p.id, title: 'Slides', owner_id: MAYA });
    const d = repo.createDecision({ project_id: p.id, kind: 'assign_task', payload: { task_id: t.id }, summary: 'Maya slides?', required_approvers: [MAYA], proposed_by: 'Planner' });
    setClaudeForTests(fakeClaude({ route: ['accountability'], agents: { 'ACCOUNTABILITY MANAGER': [{ tool: ['respond_to_proposal', { decision_id: d.id, approve: true }] }, { text: 'Locked in.' }] } }).fn);
    await orchestrate({ project: p, actorId: MAYA, actorName: 'Maya', channelId: 'c1', mode: 'mention', text: 'Confirmed!' });
    expect(repo.getTask(t.id)!.status).toBe('confirmed');
  });

  it('passive mode stays silent on casual chat', async () => {
    const p = freshProject();
    expect(shouldScanPassively(p, 'lol that lecture was wild')).toBe(false);
    expect(shouldScanPassively(p, "I'll do the slides")).toBe(true);
    setClaudeForTests(fakeClaude({ route: [], agents: {} }).fn);
    const res = await orchestrate({ project: p, actorId: SAM, actorName: 'Sam', channelId: 'c1', mode: 'passive', text: 'anyone free to grab food?' });
    expect(res).toMatchObject({ reply: '', agents: [] });
  });

  it('passes an uploaded rubric PDF to the Planner as a native document block', async () => {
    const p = freshProject();
    const fake = fakeClaude({ route: [], agents: { 'PROJECT PLANNER': [
      { tool: ['set_requirements', { requirements: [{ title: 'Research report', points: 40 }, { title: 'Slides', points: 30 }, { title: 'Live demo', points: 30 }], submission_instructions: 'Upload to Canvas' }] },
      { tool: ['propose_tasks', { tasks: [{ title: 'Research report', requirement_id: 1 }, { title: 'Slides', requirement_id: 2 }, { title: 'Live demo', requirement_id: 3 }] }] },
      { text: 'Three deliverables: report, slides, demo.' },
    ] } });
    setClaudeForTests(fake.fn);
    const res = await orchestrate({ project: p, actorId: ALEX, actorName: 'Alex', channelId: 'c1', mode: 'command', forceAgents: ['Planner'], text: 'rubric',
      attachments: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }] });
    expect((fake.calls[0].messages[0].content as any[])[0].type).toBe('document');
    expect(repo.listRequirements(p.id)).toHaveLength(3);
    expect(res.outs.find(o => o.kind === 'claim_board')).toMatchObject({ taskIds: [1, 2, 3] });
    expect(repo.getProject(p.id)!.submission_instructions).toBe('Upload to Canvas');
  });
});

it('records an owner completion after rapid messages even if routing omits accountability', async () => {
  const p = freshProject();
  p.last_passive_at = Date.now();
  expect(shouldScanPassively(p, 'I completed the research')).toBe(true);
  expect(shouldScanPassively(p, 'done')).toBe(true);
  expect(shouldScanPassively(p, "I'll do more slides")).toBe(false);
  const task = repo.createTask({ project_id: p.id, title: 'Research', owner_id: ALEX, status: 'in_progress' });
  setClaudeForTests(fakeClaude({ route: [], agents: { 'ACCOUNTABILITY MANAGER': [
    { tool: ['update_task_status', { task_id: task.id, status: 'done' }] }, { text: 'Research completed.' }
  ] } }).fn);
  await orchestrate({ project: p, actorId: ALEX, actorName: 'Alex', channelId: 'c1', mode: 'passive', text: 'I completed the research' });
  expect(repo.getTask(task.id)?.status).toBe('done');
  expect(repo.getTask(task.id)?.owner_id).toBe(ALEX);
  expect(repo.getTask(task.id)?.completed_at).toBeTruthy();
});
