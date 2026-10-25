import { describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo';
import * as actions from '../src/core/actions';
import { tick, type Sender } from '../src/scheduler/reminders';
import { HOUR, MINUTE } from '../src/core/time';
import { ALEX, MAYA, freshProject } from './helpers';

function capture() {
  const sent: { to: string; content: string }[] = [];
  const sender: Sender = {
    channel: async (_p, payload) => { sent.push({ to: 'channel', content: String(payload.content ?? '') }); },
    dm: async (u, payload) => { sent.push({ to: `dm:${u}`, content: String(payload.content ?? '') }); return true; },
  };
  return { sent, sender };
}

describe('reminder engine', () => {
  it('sends due-soon reminders, then an overdue check that warns blocked teammates', async () => {
    const p = freshProject();
    const now = Date.now();
    const research = actions.proposeTask(p, { title: 'Research', owner_id: ALEX, due_at: now + 30 * HOUR, proposedBy: ALEX, selfConsent: true }).task;
    const slides = actions.proposeTask(p, { title: 'Slides', owner_id: MAYA, due_at: now + 60 * HOUR, proposedBy: MAYA, selfConsent: true }).task;
    actions.addDependencyAction(p, research.id, slides.id, null, MAYA);
    repo.updateMember(p.id, MAYA, { dm_reminders: 1 });

    const { sent, sender } = capture();
    await tick(sender, now + 7 * HOUR); // 23h before due → 24h reminder + dependency risk
    expect(sent.some(s => s.content.includes('Research') && s.content.includes("Slides** is waiting"))).toBe(true);
    expect(sent.some(s => s.content.includes('Heads-up') && s.content.includes('Slides'))).toBe(true);

    sent.length = 0;
    await tick(sender, now + 30 * HOUR + 6 * MINUTE); // past due
    expect(repo.getTask(research.id)!.status).toBe('overdue');
    expect(sent.some(s => s.to === 'channel' && s.content.includes('hit its deadline'))).toBe(true);
    expect(sent.some(s => s.to === `dm:${MAYA}` && s.content.includes('depends on **Research**'))).toBe(true);
  });

  it('skips stale reminders when the task was finished early', async () => {
    const p = freshProject();
    const now = Date.now();
    const t = actions.proposeTask(p, { title: 'Report', owner_id: ALEX, due_at: now + 10 * HOUR, proposedBy: ALEX, selfConsent: true }).task;
    actions.completeTask(p, t.id, ALEX);
    const { sent, sender } = capture();
    await tick(sender, now + 11 * HOUR);
    expect(sent).toEqual([]);
  });

  it('runs the submission guardian and never assumes submission', async () => {
    const p = freshProject(1); // deadline in 24h
    actions.scheduleSubmissionGuards(p);
    repo.replaceRequirements(p.id, [{ title: 'Final report' }]);
    const { sent, sender } = capture();
    await tick(sender, p.final_deadline! - 2 * HOUR);
    expect(sent.some(s => s.content.includes('Nobody owns') && s.content.includes('No submitter'))).toBe(true);
    sent.length = 0;
    await tick(sender, p.final_deadline! + 20 * MINUTE);
    expect(sent.some(s => s.content.includes("haven't seen a submission confirmation"))).toBe(true);
  });
});
