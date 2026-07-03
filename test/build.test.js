import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildDiagramData } from '../src/build.js';
import { emitHtml } from '../src/emit.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

test('builds complete diagram data for the WebShop example', () => {
  const data = buildDiagramData(join(examples, 'WebShop'));
  assert.equal(data.contexts.length, 1);
  const ctx = data.contexts[0];
  assert.equal(ctx.name, 'ShopContext');
  assert.equal(ctx.provider, 'SQL Server');
  assert.equal(ctx.migrations.length, 4);
  assert.equal(ctx.modelSource, 'snapshot');
  assert.equal(ctx.currentModel.entities.length, 8);
  // Migrations are chronological and each carries a diff.
  const ids = ctx.migrations.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const m of ctx.migrations) assert.ok(m.diff);
  // Snapshot matches the last migration → no pending changes.
  assert.equal(ctx.pendingChanges, undefined);
});

test('scanning the whole examples folder finds both contexts', () => {
  const data = buildDiagramData(examples);
  assert.deepEqual(data.contexts.map((c) => c.name).sort(), ['ShopContext', 'TodoContext']);
  const todo = data.contexts.find((c) => c.name === 'TodoContext');
  assert.equal(todo.modelSource, 'source');
  assert.equal(todo.migrations.length, 0);
});

test('context filter narrows the output', () => {
  const data = buildDiagramData(examples, { context: 'TodoContext' });
  assert.equal(data.contexts.length, 1);
  assert.equal(data.contexts[0].name, 'TodoContext');
});

test('emitHtml produces a self-contained page with embedded data', () => {
  const data = buildDiagramData(join(examples, 'WebShop'));
  const html = emitHtml(data, { title: 'Test & Title' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('Test &amp; Title'));
  assert.ok(!html.includes('__DATA__'));
  assert.ok(!html.includes('__STYLES__'));
  assert.ok(!html.includes('__APP__'));
  // Data survives a round-trip through the embedded script tag.
  const m = /<script id="efviz-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/.exec(html);
  assert.ok(m);
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.contexts[0].name, 'ShopContext');
  // No external resources: keep it viewable offline.
  assert.ok(!/\bsrc="https?:/.test(html));
  assert.ok(!/\bhref="https?:/.test(html));
});
