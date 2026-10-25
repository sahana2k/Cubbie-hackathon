import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const module = { exports: {} };
const output = ts.transpileModule(readFileSync(new URL('../src/lib/discordMarkdown.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
new Function('module', 'exports', output)(module, module.exports);
const { parseInline, parseBlocks } = module.exports;
const now = Date.UTC(2026, 9, 25, 7, 0);

test('bold, inline code and italics from Tesseract cards are parsed, not shown raw', () => {
  assert.deepEqual(parseInline('**24h until** pick one with `/submitter` *unassigned*', {}, now), [
    { kind: 'bold', children: [{ kind: 'text', text: '24h until' }] },
    { kind: 'text', text: ' pick one with ' },
    { kind: 'code', text: '/submitter' },
    { kind: 'text', text: ' ' },
    { kind: 'italic', children: [{ kind: 'text', text: 'unassigned' }] }
  ]);
});

test('mentions use resolved names and fall back without exposing raw IDs', () => {
  const names = { '@933999237904105493': 'Sahana', '#42': 'general', '@&7': 'Team' };
  assert.deepEqual(parseInline('<@933999237904105493>, <@!1> <#42> <@&7>', names, now).filter(n => n.kind === 'mention').map(n => n.text),
    ['@Sahana', '@unknown-user', '#general', '@Team']);
});

test('Discord timestamps render as dates and relative times', () => {
  const [relative] = parseInline('<t:1792997940:R>', {}, now);
  assert.equal(relative.kind, 'time');
  assert.match(relative.text, /^in \d+ (hours|day)/);
  const [full] = parseInline('<t:1792997940:f>', {}, now);
  assert.equal(full.kind, 'time');
  assert.doesNotMatch(full.text, /<t:/);
});

test('snake_case words are not italicised and links stay clickable', () => {
  assert.deepEqual(parseInline('run final_deadline_check', {}, now), [{ kind: 'text', text: 'run final_deadline_check' }]);
  assert.deepEqual(parseInline('see https://discord.com/x.', {}, now)[1], { kind: 'link', href: 'https://discord.com/x', children: [{ kind: 'text', text: 'https://discord.com/x' }] });
});

test('lines become blocks with headings, bullets, quotes and code blocks', () => {
  const kinds = parseBlocks('## Plan\n- one\n> note\n\n```js\nconst a = 1;\n```\nend\n', {}, now).map(b => b.kind);
  assert.deepEqual(kinds, ['heading', 'bullet', 'quote', 'gap', 'codeblock', 'line']);
});
