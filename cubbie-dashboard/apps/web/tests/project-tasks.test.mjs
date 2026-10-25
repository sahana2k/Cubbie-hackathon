import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const module = { exports: {} };
const output = ts.transpileModule(readFileSync(new URL('../src/lib/projectTasks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
new Function('module', 'exports', output)(module, module.exports);
test('completed cards leave the active list without deleting project history', () => {
  const tasks = [{ id: 1, status: 'in_progress' }, { id: 2, status: 'done' }, { id: 3, status: 'proposed' }, { id: 4, status: 'declined' }];
  assert.deepEqual(module.exports.activeProjectTasks(tasks).map(t => t.id), [1, 3]);
  assert.equal(tasks.length, 4);
  tasks[0].status = 'done';
  assert.deepEqual(module.exports.activeProjectTasks(tasks).map(t => t.id), [3]);
});
