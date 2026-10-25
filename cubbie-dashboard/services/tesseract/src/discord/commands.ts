import { SlashCommandBuilder } from 'discord.js';

const taskOpt = (b: any, name = 'task', desc = 'Pick a task') => b.addIntegerOption((o: any) => o.setName(name).setDescription(desc).setRequired(true).setAutocomplete(true));

export const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Turn this channel into a Tesseract project')
    .addStringOption(o => o.setName('name').setDescription('Project name, e.g. "CSE 360 Team Project"').setRequired(true))
    .addStringOption(o => o.setName('deadline').setDescription('Final deadline, e.g. "Dec 5 11:59pm" or "next Friday 5pm"').setRequired(true))
    .addStringOption(o => o.setName('course').setDescription('Course, e.g. CSE 360'))
    .addAttachmentOption(o => o.setName('rubric').setDescription('Assignment rubric (PDF, TXT, MD or a photo) — Claude extracts the deliverables'))
    .addUserOption(o => o.setName('submitter').setDescription('Who will submit the final project?'))
    .addStringOption(o => o.setName('timezone').setDescription('IANA timezone, default America/Phoenix')),
  new SlashCommandBuilder().setName('rubric').setDescription('Upload or replace the assignment rubric')
    .addAttachmentOption(o => o.setName('file').setDescription('PDF, TXT, MD or photo').setRequired(true)),
  new SlashCommandBuilder().setName('join').setDescription('Join this project so Tesseract can assign and remind you'),
  new SlashCommandBuilder().setName('status').setDescription('Project progress, what needs attention, and the next step'),
  new SlashCommandBuilder().setName('tasks').setDescription("Everyone's tasks"),
  new SlashCommandBuilder().setName('mytasks').setDescription('Only your tasks (private)'),
  new SlashCommandBuilder().setName('blocked').setDescription('Tasks waiting on teammates'),
  new SlashCommandBuilder().setName('task').setDescription('Create a task')
    .addStringOption(o => o.setName('title').setDescription('What needs doing').setRequired(true))
    .addUserOption(o => o.setName('owner').setDescription('Who should own it (they will be asked to confirm)'))
    .addStringOption(o => o.setName('due').setDescription('e.g. "Wednesday 6pm"'))
    .addStringOption(o => o.setName('description').setDescription('Details')),
  taskOpt(new SlashCommandBuilder().setName('claim').setDescription('Take ownership of an open task')),
  taskOpt(new SlashCommandBuilder().setName('done').setDescription('Mark one of your tasks complete')),
  taskOpt(new SlashCommandBuilder().setName('deadline').setDescription('Set the deadline on your task'))
    .addStringOption((o: any) => o.setName('due').setDescription('e.g. "Wednesday 6pm"').setRequired(true)),
  taskOpt(taskOpt(new SlashCommandBuilder().setName('depends').setDescription('Record that one task needs another first'), 'needs', 'The task that must finish first'), 'task', 'The task that is waiting')
    .addStringOption((o: any) => o.setName('note').setDescription('Why')),
  new SlashCommandBuilder().setName('meet').setDescription('Find a meeting time that avoids everyone\'s classes')
    .addStringOption(o => o.setName('title').setDescription('e.g. "Demo run-through"').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Length (default 60)').setMinValue(15).setMaxValue(240))
    .addIntegerOption(o => o.setName('days').setDescription('How many days ahead to look (default 5)').setMinValue(1).setMaxValue(14))
    .addIntegerOption(o => o.setName('earliest').setDescription('Earliest start hour, 0-23 (default 9)').setMinValue(0).setMaxValue(23))
    .addIntegerOption(o => o.setName('latest').setDescription('Must end by this hour, 1-24 (default 22)').setMinValue(1).setMaxValue(24)),
  new SlashCommandBuilder().setName('classes').setDescription('Your weekly class/work schedule (kept private)')
    .addSubcommand(s => s.setName('add').setDescription('Add a recurring busy block')
      .addStringOption(o => o.setName('days').setDescription('e.g. MWF, TTh, Mon/Wed').setRequired(true))
      .addStringOption(o => o.setName('start').setDescription('e.g. 10:30am').setRequired(true))
      .addStringOption(o => o.setName('end').setDescription('e.g. 11:45am').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Private label, e.g. CSE 340')))
    .addSubcommand(s => s.setName('list').setDescription('See your saved schedule'))
    .addSubcommand(s => s.setName('clear').setDescription('Remove your saved schedule')),
  new SlashCommandBuilder().setName('rescue').setDescription('Behind schedule? Get a recovery plan proposed to the team'),
  new SlashCommandBuilder().setName('readiness').setDescription('Check deliverables against the rubric and submission status'),
  new SlashCommandBuilder().setName('submitter').setDescription('Choose who submits the final project')
    .addUserOption(o => o.setName('user').setDescription('Submitter').setRequired(true)),
  new SlashCommandBuilder().setName('submitted').setDescription('Submitter only: confirm the project was actually turned in')
    .addStringOption(o => o.setName('proof').setDescription('Confirmation number, link, or note'))
    .addAttachmentOption(o => o.setName('screenshot').setDescription('Screenshot of the submission confirmation')),
  new SlashCommandBuilder().setName('settings').setDescription('Your reminder preferences and project settings')
    .addStringOption(o => o.setName('reminders').setDescription('How often to remind you').addChoices(
      { name: 'Minimal (3h before)', value: 'minimal' }, { name: 'Normal (24h + 3h before)', value: 'normal' }, { name: 'Frequent (48h, 24h, 3h, 1h)', value: 'frequent' }))
    .addBooleanOption(o => o.setName('dm').setDescription('Send your reminders privately by DM'))
    .addBooleanOption(o => o.setName('listen').setDescription('Project-wide: let Tesseract pick up tasks from chat without being tagged')),
  new SlashCommandBuilder().setName('ask').setDescription('Ask Tesseract anything (same as @mentioning it)')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('agents').setDescription('See what the AI agents did recently (transparency log)'),
  new SlashCommandBuilder().setName('help').setDescription('How to use Tesseract'),
];

export const commandJson = commands.map(c => c.toJSON());
