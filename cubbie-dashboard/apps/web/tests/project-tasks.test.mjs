import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const module = { exports: {} };
const output = ts.transpileModule(readFileSync(new URL('../src/lib/projectTasks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
new Function('module', 'exports', output)(module, module.exports);
test('completed cards leave the active list without deleting project history', () => {
  const tasks = [{ id: 1, status: 'in_progress' }, { id: 2, status: 'done' }, { id: 3, status: 'proposed' }, { id: 4, status: 'declined' }];
  assert.deepEqual(module.exports.activeProjectTasks(tasks).map(t => t.id), [1, 3]);
  assert.equal(tasks.length, 4);
  tasks[0].status = 'done';
  assert.deepEqual(module.exports.activeProjectTasks(tasks).map(t => t.id), [3]);
});

test('Discord opens a project channel with work while preserving an explicit channel choice', () => {
  const channels = [{ id: 'general', name: 'general' },
    { id: 'empty', name: 'empty', project: { name: 'Empty', activeTasks: 0 } },
    { id: 'project', name: 'project', project: { name: 'Project', activeTasks: 3 } }];
  assert.equal(module.exports.defaultProjectChannel(channels, ''), 'project');
  assert.equal(module.exports.defaultProjectChannel(channels, 'general'), 'general');
  assert.equal(module.exports.defaultProjectChannel(channels, 'removed'), 'project');
  assert.equal(module.exports.defaultProjectChannel([], ''), '');
});

test('assignment cards follow owners, retain approval state and leave the board when completed', () => {
  const members = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bea' }, { id: 'c', name: 'No tasks' }];
  const tasks = [
    { id: 1, title: 'Build API', description: 'Routes', owner_id: 'a', status: 'in_progress' },
    { id: 2, title: 'Design', description: null, owner_id: 'b', status: 'proposed' },
    { id: 3, title: 'Testing', description: null, owner_id: null, status: 'confirmed' },
    { id: 4, title: 'Old work', description: null, owner_id: 'a', status: 'done' }
  ];
  const columns = module.exports.projectTaskColumns(tasks, members);
  assert.deepEqual(columns.map(c => [c.name, c.tasks.map(t => t.id)]), [['Alex', [1]], ['Bea', [2]], ['Unassigned', [3]]]);
  assert.equal(columns[1].tasks[0].status, 'proposed');
  tasks[0].owner_id = 'b';
  assert.deepEqual(module.exports.projectTaskColumns(tasks, members, 'Bea')[0].tasks.map(t => t.id), [1, 2]);
  tasks[0].status = 'done';
  assert.deepEqual(module.exports.projectTaskColumns(tasks, members, 'api'), []);
});

test('Discord reference layout includes every teammate and an Unassigned column without inventing cards', () => {
  const members = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bea' }];
  const tasks = [{ title: 'Completed', description: null, owner_id: 'a', status: 'done' }];
  assert.deepEqual(module.exports.projectTaskColumns(tasks, members, '', true).map(c => [c.name, c.tasks.length]),
    [['Alex', 0], ['Bea', 0], ['Unassigned', 0]]);
  assert.deepEqual(module.exports.projectTaskColumns(tasks, members, 'missing', true), []);
});

test('Discord demo uses the supplied assignments and Phoenix deadlines without changing project data', () => {
  const fixture = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/data/discordDemo.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function('module', 'exports', code)(fixture, fixture.exports);
  const { discordDemoSnapshot: snapshot, discordDemoFeed: feed } = fixture.exports;
  assert.deepEqual(snapshot.members.map(m => m.name), ['Mahi', 'Pradnya', 'Sahana', 'Yash']);
  assert.deepEqual(module.exports.activeProjectTasks(snapshot.tasks).map(t => t.id), [1, 2, 3, 5]);
  assert.equal(snapshot.tasks.find(t => t.id === 4).status, 'done');
  assert.equal(snapshot.tasks[0].due_at, Date.parse('2026-10-25T15:00:00-07:00'));
  assert.equal(snapshot.tasks[4].due_at, Date.parse('2026-10-25T21:00:00-07:00'));
  assert.equal(snapshot.project.final_deadline, Date.parse('2026-10-25T23:59:00-07:00'));
  assert.equal(snapshot.meetings[0].confirmed_start, Date.parse('2026-10-25T17:00:00-07:00'));
  assert.ok(feed.messages[0].text.includes("Nothing's been assigned yet."));
  assert.equal(feed.messages[0].at, Date.parse('2026-10-25T10:43:00-07:00'));
});
