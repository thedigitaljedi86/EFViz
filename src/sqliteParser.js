/**
 * SQLite introspection: build an EFViz model directly from a `.sqlite` file.
 *
 * This makes EFViz useful for any project that talks to SQLite — including
 * JavaScript/TypeScript stacks (better-sqlite3, node:sqlite, Drizzle, Prisma's
 * SQLite, raw SQL, …) that have no Entity Framework at all. The schema is read
 * exactly from the database itself (sqlite_master + PRAGMAs), never guessed.
 *
 * Uses Node's built-in `node:sqlite` (added in Node 22.5), so there are no
 * runtime dependencies. It reads the same files as better-sqlite3.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { createRequire } from 'module';
import { finalizeModel } from './snapshotParser.js';

const require = createRequire(import.meta.url);
const SQLITE_HEADER = 'SQLite format 3\0';

/** True if the file is a SQLite database (by magic header) or has a DB extension. */
export function looksLikeSqlite(filePath) {
  if (/\.(sqlite3?|db)$/i.test(filePath)) return true;
  try {
    const fd = readFileSync(filePath);
    return fd.subarray(0, 16).toString('binary') === SQLITE_HEADER;
  } catch {
    return false;
  }
}

/** Load the built-in node:sqlite module, silencing its experimental warning. Returns null if unavailable. */
function loadSqlite() {
  const originalEmit = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (text.includes('SQLite is an experimental')) return;
    return originalEmit.call(process, warning, ...args);
  };
  try {
    return require('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = originalEmit;
  }
}

/** SQLite type affinity → a short, friendly label for the diagram. */
function friendlyType(declared, isView) {
  const t = (declared || '').trim();
  if (t === '') return isView ? 'expr' : 'blob';
  const u = t.toUpperCase();
  if (u.includes('INT')) return 'integer';
  if (u.includes('CHAR') || u.includes('CLOB') || u.includes('TEXT')) return 'text';
  if (u.includes('REAL') || u.includes('FLOA') || u.includes('DOUB')) return 'real';
  if (u.includes('BLOB')) return 'blob';
  return 'numeric';
}

function normalizeOnDelete(v) {
  const m = {
    CASCADE: 'Cascade',
    'SET NULL': 'SetNull',
    'SET DEFAULT': 'SetDefault',
    RESTRICT: 'Restrict',
    'NO ACTION': 'NoAction',
  };
  return m[(v || '').toUpperCase()] ?? null;
}

function newColumn(name) {
  return {
    name,
    columnName: name,
    clrType: null,
    storeType: null,
    isRequired: true,
    maxLength: null,
    precision: null,
    scale: null,
    valueGenerated: null,
    isIdentity: false,
    isConcurrencyToken: false,
    defaultValueSql: null,
    computedSql: null,
    comment: null,
    isUnicode: null,
  };
}

/**
 * Introspect a SQLite database file into an EFViz model.
 * @returns {{ model: object, provider: string }}
 */
export function buildModelFromSqlite(dbPath) {
  let mod;
  try {
    mod = loadSqlite();
  } catch {
    mod = null;
  }
  if (!mod || !mod.DatabaseSync) {
    const [maj, min] = process.versions.node.split('.').map(Number);
    const tooOld = maj < 22 || (maj === 22 && min < 5);
    throw new Error(
      tooOld
        ? `SQLite mode needs Node ≥ 22.5 (this is ${process.versions.node}). EF Core scanning still works on Node ≥ 18.`
        : `Could not load the built-in node:sqlite module on Node ${process.versions.node}.`
    );
  }

  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  try {
    const objects = db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();

    const entities = [];
    const relationships = [];

    for (const { type, name } of objects) {
      const isView = type === 'view';
      const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all();

      const entity = {
        name,
        fullName: name,
        table: name,
        schema: null,
        isView,
        columns: [],
        primaryKey: [],
        alternateKeys: [],
        indexes: [],
        discriminator: null,
        baseType: null,
        ownedTypes: [],
        seedCount: 0,
        annotations: {},
      };

      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      entity.primaryKey = pkCols.map((c) => c.name);

      for (const c of cols) {
        const col = newColumn(c.name);
        col.storeType = c.type || null;
        col.clrType = friendlyType(c.type, isView);
        col.isRequired = c.notnull === 1 || c.pk > 0;
        if (c.dflt_value !== null && c.dflt_value !== undefined) {
          col.defaultValueSql = String(c.dflt_value);
        }
        // A single INTEGER PRIMARY KEY is SQLite's rowid alias (autoincrement-like).
        if (c.pk > 0 && pkCols.length === 1 && /INT/i.test(c.type || '')) {
          col.valueGenerated = 'OnAdd';
          col.isIdentity = true;
        }
        entity.columns.push(col);
      }

      // Foreign keys, grouped by id so composite FKs stay together.
      const fkRows = db.prepare(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`).all();
      const byId = new Map();
      for (const r of fkRows) {
        if (!byId.has(r.id)) byId.set(r.id, []);
        byId.get(r.id).push(r);
      }
      for (const rows of byId.values()) {
        rows.sort((a, b) => a.seq - b.seq);
        const fk = rows.map((r) => r.from);
        const required = fk.every((f) => {
          const c = cols.find((x) => x.name === f);
          return c && (c.notnull === 1 || c.pk > 0);
        });
        relationships.push({
          dependent: name,
          principal: rows[0].table,
          navigation: null,
          inverseNavigation: null,
          foreignKey: fk,
          principalKey: rows.map((r) => r.to),
          type: 'many-to-one',
          onDelete: normalizeOnDelete(rows[0].on_delete),
          isRequired: required,
        });
      }

      // Indexes (skip the implicit primary-key index).
      const idxList = db.prepare(`PRAGMA index_list("${name.replace(/"/g, '""')}")`).all();
      for (const idx of idxList) {
        if (idx.origin === 'pk') continue;
        const info = db
          .prepare(`PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`)
          .all()
          .sort((a, b) => a.seqno - b.seqno);
        const columns = info.map((i) => i.name).filter((n) => n != null);
        if (!columns.length) continue;
        entity.indexes.push({
          columns,
          isUnique: idx.unique === 1,
          name: idx.name,
          filter: idx.partial ? 'partial' : null,
        });
      }

      // Live row count → shown as "seed rows" in the detail panel.
      if (!isView) {
        try {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get();
          entity.seedCount = Number(n?.n ?? 0);
        } catch {
          /* ignore */
        }
      }

      entities.push(entity);
    }

    const model = { productVersion: null, annotations: {}, entities, relationships };
    finalizeModel(model); // FK flags, many-to-many join detection, stable ordering
    return { model, provider: 'SQLite' };
  } finally {
    db.close();
  }
}

/** Build a full EFViz DiagramData payload from a SQLite file (single context). */
export function buildDiagramDataFromSqlite(dbPath) {
  const { model, provider } = buildModelFromSqlite(dbPath);
  const name = basename(dbPath).replace(/\.(sqlite3?|db)$/i, '') || 'database';
  return {
    tool: 'EFViz',
    generatedAt: new Date().toISOString(),
    root: dbPath,
    contexts: [
      {
        name,
        namespace: null,
        filePath: dbPath,
        provider,
        dbSetCount: model.entities.filter((e) => !e.isView).length,
        modelSource: 'database',
        migrations: [],
        currentModel: model,
      },
    ],
    warnings: [],
  };
}
