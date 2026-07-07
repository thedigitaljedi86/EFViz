#!/usr/bin/env node
/**
 * EFViz CLI — scan a workspace for EF Core DbContexts and
 * migrations, and generate an interactive ER diagram as a single HTML file.
 *
 * Re-run the same command any time migrations change to refresh the diagram.
 */

import { writeFileSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { buildDiagramData } from '../src/build.js';
import { emitHtml } from '../src/emit.js';
import { isDirectory } from '../src/scan.js';
import { buildDiagramDataFromSqlite, looksLikeSqlite } from '../src/sqliteParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const HELP = `
EFViz v${pkg.version}
Interactive ER diagrams for Entity Framework Core — straight from your code.

Usage
  efviz-scan [path] [options]
  efviz [path] [options]        (alias)

  path                    An EF Core workspace directory (default: .), OR a
                          SQLite database file (.sqlite/.db) to introspect

Options
  -o, --output <file>     Output HTML file           (default: efviz-diagram.html)
  -c, --context <name>    Only include this DbContext (default: all found)
  -t, --title <text>      Title shown in the diagram header
      --sqlite            Treat <path> as a SQLite database file
      --json <file>       Also write the raw model + diff data as JSON
      --open              Open the generated diagram in your browser
  -q, --quiet             Suppress non-error output
  -v, --version           Print version
  -h, --help              Show this help

Examples
  efviz-scan                                 Scan the current EF Core workspace
  efviz-scan ./src -o docs/db-diagram.html   Scan ./src, write to docs/
  efviz-scan ./data/app.sqlite -o db.html    Diagram a SQLite database directly
  efviz-scan --context OrdersContext --open  One context, open when done

SQLite mode reads the schema straight from the database file (tables, columns,
keys, indexes) and works for any stack — better-sqlite3, node:sqlite, Drizzle,
raw SQL, … It needs Node >= 22.5; EF Core scanning works on Node >= 18.
`;

function parseArgs(argv) {
  const opts = { path: '.', output: 'efviz-diagram.html', context: null, title: null, json: null, open: false, quiet: false, sqlite: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
      case '-o': case '--output': opts.output = expect(args, a); break;
      case '-c': case '--context': opts.context = expect(args, a); break;
      case '-t': case '--title': opts.title = expect(args, a); break;
      case '--json': opts.json = expect(args, a); break;
      case '--sqlite': opts.sqlite = true; break;
      case '--open': opts.open = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      default:
        if (a.startsWith('-')) fail(`Unknown option: ${a}\n${HELP}`);
        opts.path = a;
    }
  }
  return opts;
}

function expect(args, flag) {
  const v = args.shift();
  if (v === undefined) fail(`Missing value for ${flag}`);
  return v;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const target = resolve(opts.path);
const log = (...args) => { if (!opts.quiet) console.log(...args); };
const started = Date.now();

// A SQLite database file → introspect it directly (works for any stack:
// better-sqlite3, node:sqlite, Drizzle, raw SQL, …). Otherwise scan the
// directory for EF Core DbContexts and migrations.
const sqliteMode = opts.sqlite || (!isDirectory(target) && looksLikeSqlite(target));

let data;
if (sqliteMode) {
  log(`Reading SQLite database ${target} …`);
  try {
    data = buildDiagramDataFromSqlite(target);
  } catch (err) {
    fail(`Could not read SQLite database: ${err.message}`);
  }
} else {
  if (!isDirectory(target)) {
    fail(
      `Not a directory: ${target}\n` +
      `(For a SQLite database file, pass the .sqlite/.db path or add --sqlite.)`
    );
  }
  log(`Scanning ${target} …`);
  data = buildDiagramData(target, { context: opts.context });
  if (data.contexts.length === 0) {
    fail(
      'No DbContext found.\n' +
      'Looked for classes deriving from DbContext, EF Core migration designer files, and model snapshots.\n' +
      (opts.context ? `(filtered to context '${opts.context}')` : '')
    );
  }
}

for (const w of data.warnings) console.warn(`warning: ${w}`);

for (const c of data.contexts) {
  const m = c.currentModel;
  const rels = m.relationships.filter((r) => r.type !== 'inheritance').length;
  if (c.modelSource === 'database') {
    const views = m.entities.filter((e) => e.isView).length;
    log(
      `  ${c.name}: ${m.entities.length - views} tables${views ? `, ${views} views` : ''}, ` +
      `${rels} relationships — from the SQLite database` + (c.provider ? ` (${c.provider})` : '')
    );
    continue;
  }
  const src = c.modelSource === 'source' ? 'from entity classes (no migrations found)' : c.modelSource === 'snapshot' ? 'from model snapshot' : 'from migrations';
  log(
    `  ${c.name}: ${m.entities.length} entities, ${rels} relationships, ` +
    `${c.migrations.length} migration${c.migrations.length === 1 ? '' : 's'} — ${src}` +
    (c.provider ? ` (${c.provider})` : '')
  );
  if (c.pendingChanges) {
    log(`    note: model snapshot has ${c.pendingChanges.changeCount} change(s) not yet in a migration`);
  }
}

const html = emitHtml(data, { title: opts.title ?? undefined });
const outPath = resolve(opts.output);
writeFileSync(outPath, html);
log(`\n✔ Diagram written to ${outPath} (${(html.length / 1024).toFixed(0)} kB) in ${Date.now() - started} ms`);
log(sqliteMode
  ? '  Re-run this command to refresh after the schema changes.'
  : '  Re-run this command after adding migrations to refresh the diagram.');

if (opts.json) {
  writeFileSync(resolve(opts.json), JSON.stringify(data, null, 2));
  log(`✔ Model data written to ${resolve(opts.json)}`);
}

if (opts.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', outPath] : [outPath];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
