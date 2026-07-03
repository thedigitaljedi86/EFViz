import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseSnapshotModel, parseMigrationMeta, detectProvider } from '../src/snapshotParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'examples', 'WebShop', 'Migrations');
const finalDesigner = readFileSync(join(migrations, '20250620160800_AddReviewsAndAuditColumns.Designer.cs'), 'utf8');
const initialDesigner = readFileSync(join(migrations, '20250110093000_InitialCreate.Designer.cs'), 'utf8');

test('parses migration metadata', () => {
  const meta = parseMigrationMeta(finalDesigner);
  assert.equal(meta.id, '20250620160800_AddReviewsAndAuditColumns');
  assert.equal(meta.name, 'AddReviewsAndAuditColumns');
  assert.equal(meta.timestamp, '2025-06-20T16:08:00');
  assert.equal(meta.contextType, 'ShopContext');
});

test('detects provider', () => {
  assert.equal(detectProvider(finalDesigner), 'SQL Server');
});

test('parses all entities from the final designer', () => {
  const model = parseSnapshotModel(finalDesigner);
  assert.deepEqual(
    model.entities.map((e) => e.name).sort(),
    ['Category', 'Customer', 'Order', 'OrderItem', 'Product', 'ProductTag', 'Review', 'Tag']
  );
  assert.equal(model.productVersion, '8.0.6');
});

test('parses column facets: identity, required, maxlength, defaults, concurrency', () => {
  const model = parseSnapshotModel(finalDesigner);
  const product = model.entities.find((e) => e.name === 'Product');

  const id = product.columns.find((c) => c.name === 'Id');
  assert.equal(id.isIdentity, true);
  assert.equal(id.isPrimaryKey, true);
  assert.equal(id.valueGenerated, 'OnAdd');

  const name = product.columns.find((c) => c.name === 'Name');
  assert.equal(name.isRequired, true);
  assert.equal(name.maxLength, 200);
  assert.equal(name.storeType, 'nvarchar(200)');

  const disc = product.columns.find((c) => c.name === 'IsDiscontinued');
  assert.equal(disc.defaultValue, false);

  const rv = product.columns.find((c) => c.name === 'RowVersion');
  assert.equal(rv.isConcurrencyToken, true);
  assert.equal(rv.valueGenerated, 'OnAddOrUpdate');

  const desc = product.columns.find((c) => c.name === 'Description');
  assert.equal(desc.isRequired, false);
});

test('parses keys and indexes', () => {
  const model = parseSnapshotModel(finalDesigner);
  const customer = model.entities.find((e) => e.name === 'Customer');
  assert.deepEqual(customer.primaryKey, ['Id']);
  const emailIdx = customer.indexes.find((i) => i.columns.join() === 'Email');
  assert.equal(emailIdx.isUnique, true);
});

test('folds owned type into owner with prefixed columns', () => {
  const model = parseSnapshotModel(finalDesigner);
  const customer = model.entities.find((e) => e.name === 'Customer');
  const street = customer.columns.find((c) => c.columnName === 'Address_Street');
  assert.ok(street, 'owned Street column folded into Customer');
  assert.equal(street.owned, true);
  assert.equal(street.maxLength, 200);
  assert.equal(customer.ownedTypes.length, 1);
  assert.equal(customer.ownedTypes[0].navigation, 'Address');
  // Owned type sharing the table must not become its own entity.
  assert.ok(!model.entities.some((e) => e.name === 'Address'));
});

test('parses relationships with delete behavior and requiredness', () => {
  const model = parseSnapshotModel(finalDesigner);
  const orderCustomer = model.relationships.find(
    (r) => r.dependent.endsWith('Order') && r.principal.endsWith('Customer')
  );
  assert.equal(orderCustomer.type, 'many-to-one');
  assert.equal(orderCustomer.onDelete, 'Restrict');
  assert.equal(orderCustomer.isRequired, true);
  assert.deepEqual(orderCustomer.foreignKey, ['CustomerId']);

  const reviewCustomer = model.relationships.find(
    (r) => r.dependent.endsWith('Review') && r.principal.endsWith('Customer')
  );
  assert.equal(reviewCustomer.onDelete, 'SetNull');
  assert.equal(reviewCustomer.isRequired, false);
});

test('detects implicit many-to-many join entity and synthesizes relationship', () => {
  const model = parseSnapshotModel(finalDesigner);
  const join = model.entities.find((e) => e.name === 'ProductTag');
  assert.equal(join.isJoinTable, true);
  const m2m = model.relationships.find((r) => r.type === 'many-to-many');
  assert.ok(m2m);
  assert.equal(m2m.via, 'ProductTag');
});

test('self-referencing relationship is preserved', () => {
  const model = parseSnapshotModel(finalDesigner);
  const selfRef = model.relationships.find(
    (r) => r.dependent === r.principal && r.dependent.endsWith('Category')
  );
  assert.ok(selfRef);
  assert.deepEqual(selfRef.foreignKey, ['ParentCategoryId']);
});

test('counts seed data', () => {
  const model = parseSnapshotModel(finalDesigner);
  const tag = model.entities.find((e) => e.name === 'Tag');
  assert.equal(tag.seedCount, 2);
});

test('initial designer has no Review/Tag and keeps legacy column', () => {
  const model = parseSnapshotModel(initialDesigner);
  assert.equal(model.entities.length, 5);
  const product = model.entities.find((e) => e.name === 'Product');
  assert.ok(product.columns.some((c) => c.name === 'LegacyCode'));
  const price = product.columns.find((c) => c.name === 'Price');
  assert.equal(price.storeType, 'decimal(10,2)');
});
