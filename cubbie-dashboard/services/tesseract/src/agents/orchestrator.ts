import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { createMessage, textOf } from '../claude/client';
import * as repo from '../db/repo';
import type { Project } from '../db/repo';
import { stateSnapshot, type Out } from '../core/actions';
import { log } from '../core/log';
import { AGENT_PROMPTS, ROUTER_PROMPT } from './prompts';
import { runTool, toolSpecs, type AgentName, type ToolContext } from './tools';

const ROUTE_TO_AGENT: Record<string, AgentName> = {
  planner: 'Planner', dependency: 'Dependency Manager', meeting: 'Meeting Coordinator', accountability: 'Accountability Manager', answer: 'Assistant',
};
const MAX_STEPS = 8;

export interface TriggerContext {
  project: Project;
  actorId: string;
  actorName: string;
  channelId: string;
  text: string;
  sourceUrl?: string;
  /** passive = bot wasn't mentioned; agents must stay quiet unless clearly useful */
  mode: 'mention' | 'passive' | 'command';
  /** extra content blocks (e.g. an uploaded rubric PDF) */
  attachments?: Anthropic.ContentBlockParam[];
  /** force a specific chain instead of routing */
  forceAgents?: AgentName[];
}

export interface OrchestratorResult {
  reply: string;           // text to post (may be empty)
  outs: Out[];             // cards / notifications produced by tools
  agents: AgentName[];     // which agents ran, in order
}

/** Step 1 — the orchestrator decides which specialists should handle this message. */
export async function route(ctx: TriggerContext): Promise<AgentName[]> {
  if (ctx.forceAgents) return ctx.forceAgents;
  const res = await createMessage({
    model: config.fastModel,
    max_tokens: 300,
    system: ROUTER_PROMPT,
    tools: [{
      name: 'route',
      description: 'Choose agents to handle the message.',
      input_schema: {
        type: 'object',
        properties: {
          agents: { type: 'array', items: { type: 'string', enum: Object.keys(ROUTE_TO_AGENT) } },
          reason: { type: 'string' },
        },
        required: ['agents'],
      },
    }],
    tool_choice: { type: 'tool', name: 'route' },
    messages: [{ role: 'user', content: `MODE: ${ctx.mode}\nPENDING PROPOSALS: ${repo.listDecisions(ctx.project.id, 'pending').length}\nSPEAKER: ${ctx.actorName}\nRECENT CHAT:\n${recentChatText(ctx.project.id, 6)}\n\nMESSAGE TO ROUTE:\n${ctx.text}` }],
  });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const picked = ((call?.input as any)?.agents ?? []) as string[];
  let agents = [...new Set(picked.map(a => ROUTE_TO_AGENT[a]).filter(Boolean))];
  if (ctx.mode === 'passive') agents = agents.filter(a => a !== 'Assistant');
  else if (!agents.length) agents = ['Assistant'];
  if (COMPLETION_SIGNAL.test(ctx.text) && !agents.includes('Accountability Manager')) agents.push('Accountability Manager');
  repo.logAgent(ctx.project.id, 'Orchestrator', 'routed', { mode: ctx.mode, agents, reason: (call?.input as any)?.reason });
  return agents;
}

function recentChatText(projectId: number, n: number) {
  return repo.recentChat(projectId, n).map(c => `${c.author_name}: ${c.content}`).join('\n') || '(none)';
}

/** Step 2 — run one specialist with its own tools over the shared state. */
export async function runAgent(agent: AgentName, ctx: TriggerContext, notes: string[], outs: Out[]): Promise<string> {
  const toolCtx: ToolContext = { project: ctx.project, actorId: ctx.actorId, channelId: ctx.channelId, sourceUrl: ctx.sourceUrl, agent, outs, notes };
  const system = `${AGENT_PROMPTS[agent]}

══ PROJECT STATE (shared by all agents) ══
${stateSnapshot(repo.getProject(ctx.project.id)!)}

══ RECENT CHAT ══
${recentChatText(ctx.project.id, agent === 'Assistant' ? 25 : 10)}
${notes.length ? `\n══ HAND-OFF NOTES FROM OTHER AGENTS ══\n${notes.join('\n')}` : ''}
${ctx.mode === 'passive' ? '\nPASSIVE MODE: you were not mentioned. Act only if clearly useful; if no action is needed reply with exactly NO_ACTION.' : ''}`;

  const userContent: Anthropic.ContentBlockParam[] = [
    ...(ctx.attachments ?? []),
    { type: 'text', text: `CURRENT SPEAKER: ${ctx.actorName} (discord_id ${ctx.actorId})\nMESSAGE: ${ctx.text}` },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

  let finalText = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await createMessage({ model: config.model, max_tokens: 2048, system, tools: toolSpecs(agent), messages });
    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    finalText = textOf(res);
    if (!toolUses.length || res.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const r = await runTool(agent, tu.name, tu.input, toolCtx);
      repo.logAgent(ctx.project.id, agent, `tool:${tu.name}`, { input: tu.input, error: r.isError ? r.content : undefined });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, is_error: r.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  if (finalText.trim() === 'NO_ACTION' || finalText.trim().endsWith('NO_ACTION')) finalText = '';
  return finalText;
}

/** Orchestrate: route → run specialists in order, sharing state + hand-off notes → merge replies. */
export async function orchestrate(ctx: TriggerContext): Promise<OrchestratorResult> {
  const agents = await route(ctx);
  const outs: Out[] = [];
  const notes: string[] = [];
  const replies: string[] = [];
  for (const agent of agents) {
    try {
      const text = await runAgent(agent, ctx, notes, outs);
      if (text) replies.push(agents.length > 1 && agent !== 'Assistant' ? `**${agentEmoji(agent)} ${agent}:** ${text}` : text);
    } catch (e) {
      log.error(`agent ${agent} failed`, e);
      repo.logAgent(ctx.project.id, agent, 'failed', (e as Error).message);
      if (ctx.mode !== 'passive') replies.push(`⚠️ ${agent} hit an error — try again in a moment.`);
    }
  }
  if (ctx.mode === 'passive' && !outs.length) return { reply: '', outs, agents };
  return { reply: replies.join('\n\n').slice(0, 1900), outs, agents };
}

export function agentEmoji(a: string) {
  return ({ 'Planner': '🗂️', 'Dependency Manager': '🔗', 'Meeting Coordinator': '📅', 'Accountability Manager': '⏰', 'Assistant': '💬', 'Orchestrator': '🧭', 'system': '⚙️' } as Record<string, string>)[a] ?? '🤖';
}

// ─── Passive listening pre-filter ────────────────────────
const SIGNAL = /\b(i'?ll|i will|i can|i can't|i cannot|can't make|can you|could you|who'?s|who is|due|deadline|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight)|meet|meeting|free|available|done|finished|complete|completed|submitted|stuck|blocked|need .* (first|before)|depends|sick|confirm|on it|take (it|that)|handle|do the|working on|remind)\b|\b(class|lecture|lab|work)\b.*\d/i;
export const COMPLETION_SIGNAL = /\b(done|finished|completed|complete)\b/i;
const PASSIVE_COOLDOWN_MS = 15_000;

/** Cheap gate before spending a Claude call on an un-mentioned message. */
export function shouldScanPassively(project: Project, text: string, nowMs = Date.now()): boolean {
  if (!project.passive_mode) return false;
  if ((!COMPLETION_SIGNAL.test(text) && text.length < 6) || text.startsWith('/')) return false;
  if (!SIGNAL.test(text)) return false;
  if (!COMPLETION_SIGNAL.test(text) && nowMs - project.last_passive_at < PASSIVE_COOLDOWN_MS) return false;
  return true;
}
