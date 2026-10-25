// Demo-only fixture. Never sent to Discord or written to the project database.
const at = (time: string) => Date.parse(`2026-10-25T${time}:00-07:00`);
export const discordDemoSnapshot = {
  project: { id: -1, name: 'Blockchain project proposal', final_deadline: at('23:59'), submitted_at: null },
  members: [{ id: 'demo-mahi', name: 'Mahi' }, { id: 'demo-pradnya', name: 'Pradnya' },
    { id: 'demo-sahana', name: 'Sahana' }, { id: 'demo-yash', name: 'Yash' }],
  tasks: [
    { id: 1, title: 'Problem Statement + Motivation', description: 'Draft these two sections of the proposal.', owner_id: 'demo-mahi', status: 'confirmed', due_at: at('15:00') },
    { id: 2, title: 'Literature Review + References', description: 'Brief relevant review and reference list.', owner_id: 'demo-pradnya', status: 'confirmed', due_at: at('15:00') },
    { id: 3, title: 'Proposed Architecture + Chosen Platform', description: 'Architecture description/diagram and platform justification.', owner_id: 'demo-sahana', status: 'confirmed', due_at: at('15:00') },
    { id: 4, title: 'Team Contract', description: 'Completed team contract.', owner_id: 'demo-yash', status: 'done', due_at: null },
    { id: 5, title: 'Merge, format and submit', description: 'Combine the proposal and team contract, check formatting, and submit.', owner_id: 'demo-yash', status: 'confirmed', due_at: at('21:00') }
  ],
  dependencies: [], decisions: [], requirements: [],
  meetings: [{ id: -1, title: 'Work session to review drafts', status: 'confirmed', confirmed_start: at('17:00') }]
};

export const discordDemoFeed = {
  names: {},
  messages: [{ id: 'demo-tesseract-update', author: 'Tesseract', bot: true, at: at('10:43'),
    text: `Here's where things stand:
- **Mahi:** #1 Problem Statement + Motivation (due 3 PM MST)
- **pradnya:** #2 Literature Review + References (due 3 PM MST)
- **Sahana:** #3 Proposed Architecture + Chosen Platform (due 3 PM MST)
- **Yash:** #4 Team Contract (done), and #5 Merge, format and submit (due 9 PM MST)

Final deadline is 11:59 PM MST tonight.

Nothing's been assigned yet. The project has no tasks or requirements recorded, and only you are listed as a member.

The final deadline is **today, Sun Oct 25, 11:59 PM MST**, so we need to move fast. Paste the rubric or tell me who's doing what, and I'll set up the tasks.

Here's where everyone stands:
- **Mahi:** Problem Statement + Motivation (#1), due 3 PM today.
- **Pradnya:** Literature Review + References (#2), due 3 PM today.
- **Sahana:** Proposed Architecture + Chosen Platform (#3), due 3 PM today.
- **Yash:** The Team Contract (#4) is done. He also has Merge, format and submit (#5), due 9 PM today.

We have a work session at 5 PM to review the drafts. The final deadline is 11:59 PM tonight.`,
    embeds: [], attachments: [], url: '' }]
};
