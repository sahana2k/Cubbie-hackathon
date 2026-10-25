import { describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo';
import * as actions from '../src/core/actions';
import { lockMeeting, startMeetingPoll } from '../src/core/meetings';
import { commandJson } from '../src/discord/commands';
import { claimBoardMessage, decisionMessage, meetingConfirmedMessage, meetingPollMessage, readinessEmbed, statusEmbed } from '../src/discord/render';
import { helpEmbed } from '../src/discord/interactions';
import { ALEX, MAYA, SAM, freshProject } from './helpers';

const json = (m: any) => ({ ...m, embeds: (m.embeds ?? []).map((e: any) => e.toJSON()), components: (m.components ?? []).map((c: any) => c.toJSON()) });

describe('Discord surface', () => {
  it('slash command definitions are valid', () => {
    expect(commandJson.length).toBeGreaterThanOrEqual(20);
    const names = commandJson.map(c => c.name);
    for (const n of ['setup', 'rubric', 'status', 'tasks', 'mytasks', 'blocked', 'meet', 'done', 'rescue', 'readiness', 'submitted', 'ask']) expect(names).toContain(n);
  });

  it('renders every card type within Discord limits', () => {
    const p = freshProject();
    repo.replaceRequirements(p.id, [{ title: 'Report', points: 40 }]);
    const r = actions.proposeTask(p, { title: 'Slides', owner_id: MAYA, due_at: Date.now() + 86_400_000, proposedBy: ALEX }).task;
    const d = repo.listDecisions(p.id)[0];
    d.conflicts.push('Example conflict');
    const dm = json(decisionMessage(d));
    expect(dm.components[0].components).toHaveLength(2);

    const unowned = [1, 2, 3, 4, 5, 6, 7].map(i => actions.proposeTask(p, { title: `Deliverable ${i} with a fairly long descriptive title to test label limits`, proposedBy: 'Planner' }).task.id);
    const board = json(claimBoardMessage(p, unowned));
    expect(board.components).toHaveLength(2);

    const { meetingId } = startMeetingPoll(p, { title: 'Sync', durationMin: 45, createdBy: ALEX });
    expect(json(meetingPollMessage(meetingId)).components[0].components.length).toBeGreaterThan(0);
    repo.toggleVote(meetingId, 0, ALEX);
    lockMeeting(p, meetingId, 0, ALEX);
    const confirmed = meetingConfirmedMessage(meetingId);
    expect(confirmed.files).toHaveLength(1);

    expect(statusEmbed(p).toJSON().fields!.some(f => f.name === 'Next step')).toBe(true);
    expect(readinessEmbed(p).toJSON().title).toContain('readiness');
    expect(helpEmbed().toJSON().fields!.length).toBeGreaterThan(3);
    expect(r).toBeTruthy(); expect(SAM).toBeTruthy();
  });
});
