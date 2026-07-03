import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scanWorkspace } from '../src/scan.js';
import { buildModelFromSource, pluralize } from '../src/sourceParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'examples', 'MinimalTodo');

function build() {
  const scan = scanWorkspace(root);
  const context = scan.contexts.find((c) => c.name === 'TodoContext');
  assert.ok(context, 'TodoContext discovered');
  return buildModelFromSource(context, scan.csFiles);
}

test('discovers DbContext and DbSets', () => {
  const scan = scanWorkspace(root);
  const context = scan.contexts[0];
  assert.equal(context.name, 'TodoContext');
  assert.deepEqual(context.dbSets.map((d) => d.entityType).sort(), ['Person', 'TodoItem', 'TodoList']);
});

test('builds entities with convention primary keys', () => {
  const model = build();
  assert.deepEqual(model.entities.map((e) => e.name).sort(), ['Person', 'TodoItem', 'TodoList']);
  for (const e of model.entities) assert.deepEqual(e.primaryKey, ['Id']);
});

test('table names come from [Table] attribute or DbSet property name', () => {
  const model = build();
  assert.equal(model.entities.find((e) => e.name === 'Person').table, 'People');
  assert.equal(model.entities.find((e) => e.name === 'TodoList').table, 'Lists');
  assert.equal(model.entities.find((e) => e.name === 'TodoItem').table, 'Items');
});

test('annotations map to column facets', () => {
  const model = build();
  const item = model.entities.find((e) => e.name === 'TodoItem');
  const text = item.columns.find((c) => c.name === 'Text');
  assert.equal(text.isRequired, true);
  assert.equal(text.maxLength, 200);
  const due = item.columns.find((c) => c.name === 'DueAt');
  assert.equal(due.isRequired, false);
});

test('infers relationships with FK conventions and optionality', () => {
  const model = build();
  const itemList = model.relationships.find((r) => r.dependent.endsWith('TodoItem') && r.principal.endsWith('TodoList'));
  assert.deepEqual(itemList.foreignKey, ['TodoListId']);
  assert.equal(itemList.isRequired, true);

  const assignee = model.relationships.find(
    (r) => r.dependent.endsWith('TodoItem') && r.principal.endsWith('Person') && r.navigation === 'Assignee'
  );
  assert.deepEqual(assignee.foreignKey, ['AssigneeId']);
  assert.equal(assignee.isRequired, false);

  const fkCol = model.entities.find((e) => e.name === 'TodoItem').columns.find((c) => c.name === 'TodoListId');
  assert.equal(fkCol.isForeignKey, true);
});

test('pluralize covers common English forms', () => {
  assert.equal(pluralize('Product'), 'Products');
  assert.equal(pluralize('Category'), 'Categories');
  assert.equal(pluralize('Address'), 'Addresses');
  assert.equal(pluralize('Box'), 'Boxes');
});
