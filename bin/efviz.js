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

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const HELP = `
EFViz v${pkg.version}
Interactive ER diagrams for Entity Framework Core — straight from your code.

Usage
  efviz-scan [path] [options]
  efviz [path] [options]        (alias)

  path                    Workspace root to scan (default: current directory)

Options
  -o, --output <file>     Output HTML file           (default: entity-diagram.html)
  -c, --context <name>    Only include this DbContext (default: all found)
  -t, --title <text>      Title shown in the diagram header
      --json <file>       Also write the raw model + diff data as JSON
      --open              Open the generated diagram in your browser
  -q, --quiet             Suppress non-error output
  -v, --version           Print version
  -h, --help              Show this help

Examples
  efviz-scan                                 Scan current directory
  efviz-scan ./src -o docs/db-diagram.html   Scan ./src, write to docs/
  efviz-scan --context OrdersContext --open  One context, open when done
`;

function parseArgs(argv) {
  const opts = { path: '.', output: 'entity-diagram.html', context: null, title: null, json: null, open: false, quiet: false };
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
const root = resolve(opts.path);
if (!isDirectory(root)) fail(`Not a directory: ${root}`);

const log = (...args) => { if (!opts.quiet) console.log(...args); };

const started = Date.now();
log(`Scanning ${root} …`);

const data = buildDiagramData(root, { context: opts.context });

if (data.contexts.length === 0) {
  fail(
    'No DbContext found.\n' +
    'Looked for classes deriving from DbContext, EF Core migration designer files, and model snapshots.\n' +
    (opts.context ? `(filtered to context '${opts.context}')` : '')
  );
}

for (const w of data.warnings) console.warn(`warning: ${w}`);

for (const c of data.contexts) {
  const m = c.currentModel;
  const src = c.modelSource === 'source' ? 'from entity classes (no migrations found)' : c.modelSource === 'snapshot' ? 'from model snapshot' : 'from migrations';
  log(
    `  ${c.name}: ${m.entities.length} entities, ${m.relationships.filter((r) => r.type !== 'inheritance').length} relationships, ` +
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
log('  Re-run this command after adding migrations to refresh the diagram.');

if (opts.json) {
  writeFileSync(resolve(opts.json), JSON.stringify(data, null, 2));
  log(`✔ Model data written to ${resolve(opts.json)}`);
}

if (opts.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', outPath] : [outPath];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
