import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseSnapshotModel } from '../src/snapshotParser.js';
import { diffModels } from '../src/diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'examples', 'WebShop', 'Migrations');
const load = (f) => parseSnapshotModel(readFileSync(join(migrations, f), 'utf8'));

const m1 = load('20250110093000_InitialCreate.Designer.cs');
const m2 = load('20250214141500_AddCustomerAddressAndCategoryTree.Designer.cs');
const m3 = load('20250401110200_AddProductTags.Designer.cs');
const m4 = load('20250620160800_AddReviewsAndAuditColumns.Designer.cs');

test('diff against nothing marks everything as added', () => {
  const d = diffModels(null, m1);
  assert.equal(d.addedEntities.length, 5);
  assert.equal(d.removedEntities.length, 0);
});

test('adding owned type and self-reference shows as column/index/relationship changes', () => {
  const d = diffModels(m1, m2);
  assert.equal(d.addedEntities.length, 0);
  const customer = d.modifiedEntities.find((e) => e.name === 'Customer');
  assert.ok(customer.addedColumns.includes('LoyaltyPoints'));
  assert.ok(customer.addedColumns.includes('Address.Street'));
  assert.ok(customer.addedIndexes.some((i) => i.includes('unique') && i.includes('Email')));
  const category = d.modifiedEntities.find((e) => e.name === 'Category');
  assert.deepEqual(category.addedColumns, ['ParentCategoryId']);
  assert.ok(d.addedRelationships.some((r) => r.dependent.endsWith('Category') && r.principal.endsWith('Category')));
});

test('new join table shows added entities and many-to-many relationship', () => {
  const d = diffModels(m2, m3);
  assert.deepEqual(d.addedEntities.map((e) => e.split('.').pop()).sort(), ['ProductTag', 'Tag']);
  assert.ok(d.addedRelationships.some((r) => r.type === 'many-to-many'));
});

test('column removal, type change and additions are all detected', () => {
  const d = diffModels(m3, m4);
  const product = d.modifiedEntities.find((e) => e.name === 'Product');
  assert.deepEqual(product.removedColumns, ['LegacyCode']);
  assert.ok(product.addedColumns.includes('RowVersion'));
  const price = product.modifiedColumns.find((c) => c.column === 'Price');
  assert.ok(price.changes.some((ch) => ch.field === 'storeType' && ch.to === 'decimal(18,2)'));
  assert.ok(d.addedEntities.some((e) => e.endsWith('Review')));
  assert.ok(d.changeCount > 0);
});

test('identical models produce an empty diff', () => {
  const d = diffModels(m4, m4);
  assert.equal(d.changeCount, 0);
  assert.equal(d.modifiedEntities.length, 0);
});
