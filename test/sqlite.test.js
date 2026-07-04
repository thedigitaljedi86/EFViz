import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildModelFromSqlite, buildDiagramDataFromSqlite, looksLikeSqlite } from '../src/sqliteParser.js';

const require = createRequire(import.meta.url);

// node:sqlite arrived in Node 22.5 — skip the whole suite on older runtimes.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  /* older Node */
}
const skip = DatabaseSync ? false : 'requires node:sqlite (Node >= 22.5)';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'efviz-sqlite-'));
  const path = join(dir, 'shop.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      note TEXT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    -- pure join table (only the two FKs) → should collapse to many-to-many
    CREATE TABLE product_tags (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, tag_id)
    );
    -- association table with a payload column → stays a first-class entity
    CREATE TABLE recipe_lines (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
      quantity REAL NOT NULL,
      PRIMARY KEY (product_id, tag_id)
    );
    CREATE VIEW v_catalog AS SELECT p.id, p.name, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id;
    INSERT INTO categories (id, name, slug) VALUES (1, 'Bread', 'bread');
    INSERT INTO products (id, name, price, category_id) VALUES (1, 'Rye', 30, 1);
  `);
  db.close();
  return { path, dir };
}

test('looksLikeSqlite recognises DB files by extension', () => {
  assert.equal(looksLikeSqlite('foo.sqlite'), true);
  assert.equal(looksLikeSqlite('foo.db'), true);
  assert.equal(looksLikeSqlite('foo.sqlite3'), true);
  assert.equal(looksLikeSqlite('Program.cs'), false);
});

test('introspects tables, columns, keys and a view', { skip }, () => {
  const { path, dir } = makeDb();
  try {
    const { model, provider } = buildModelFromSqlite(path);
    assert.equal(provider, 'SQLite');
    assert.deepEqual(
      model.entities.map((e) => e.name).sort(),
      ['categories', 'product_tags', 'products', 'recipe_lines', 'tags', 'v_catalog']
    );

    const products = model.entities.find((e) => e.name === 'products');
    assert.deepEqual(products.primaryKey, ['id']);
    const id = products.columns.find((c) => c.name === 'id');
    assert.equal(id.isPrimaryKey, true);
    assert.equal(id.isIdentity, true); // INTEGER PRIMARY KEY → rowid alias
    const price = products.columns.find((c) => c.name === 'price');
    assert.equal(price.isRequired, true);
    assert.equal(price.storeType, 'REAL');
    const note = products.columns.find((c) => c.name === 'note');
    assert.equal(note.isRequired, false);
    const catFk = products.columns.find((c) => c.name === 'category_id');
    assert.equal(catFk.isForeignKey, true);

    const view = model.entities.find((e) => e.name === 'v_catalog');
    assert.equal(view.isView, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign keys carry the on-delete behaviour', { skip }, () => {
  const { path, dir } = makeDb();
  try {
    const { model } = buildModelFromSqlite(path);
    const prodCat = model.relationships.find((r) => r.dependent === 'products' && r.principal === 'categories');
    assert.equal(prodCat.onDelete, 'Cascade');
    assert.equal(prodCat.isRequired, true);
    assert.deepEqual(prodCat.foreignKey, ['category_id']);

    const selfRef = model.relationships.find((r) => r.dependent === 'categories' && r.principal === 'categories');
    assert.equal(selfRef.onDelete, 'SetNull');
    assert.deepEqual(selfRef.foreignKey, ['parent_id']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unique index is detected', { skip }, () => {
  const { path, dir } = makeDb();
  try {
    const { model } = buildModelFromSqlite(path);
    const categories = model.entities.find((e) => e.name === 'categories');
    assert.ok(categories.indexes.some((i) => i.isUnique && i.columns.join() === 'slug'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pure join table becomes many-to-many; association table stays an entity', { skip }, () => {
  const { path, dir } = makeDb();
  try {
    const { model } = buildModelFromSqlite(path);
    const join = model.entities.find((e) => e.name === 'product_tags');
    assert.equal(join.isJoinTable, true);
    assert.ok(model.relationships.some((r) => r.type === 'many-to-many' && r.via === 'product_tags'));

    const assoc = model.entities.find((e) => e.name === 'recipe_lines');
    assert.notEqual(assoc.isJoinTable, true); // has a `quantity` payload column
    assert.ok(!model.relationships.some((r) => r.type === 'many-to-many' && r.via === 'recipe_lines'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildDiagramDataFromSqlite yields a single database-sourced context', { skip }, () => {
  const { path, dir } = makeDb();
  try {
    const data = buildDiagramDataFromSqlite(path);
    assert.equal(data.tool, 'EFViz');
    assert.equal(data.contexts.length, 1);
    const ctx = data.contexts[0];
    assert.equal(ctx.name, 'shop');
    assert.equal(ctx.provider, 'SQLite');
    assert.equal(ctx.modelSource, 'database');
    assert.equal(ctx.migrations.length, 0);
    assert.equal(ctx.dbSetCount, 5); // 5 tables, view excluded
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
