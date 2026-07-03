# Contributing to AutoEntityDiagram

Thanks for your interest! This project aims to stay **small, fast, and dependency-free**.

## Development setup

You only need Node.js ≥ 18 — there is nothing to install:

```bash
git clone https://github.com/thedigitaljedi86/AutoEntityDiagram.git
cd AutoEntityDiagram
node --test                                          # run the test suite
node bin/auto-entity-diagram.js examples/WebShop \
  -o /tmp/webshop.html                               # try it on the sample project
```

## Project layout

| Path | Purpose |
| --- | --- |
| `bin/auto-entity-diagram.js` | CLI entry point (arg parsing, orchestration) |
| `src/scan.js` | Workspace walking; discovery of DbContexts, designers, snapshots |
| `src/csharp.js` | String-aware C# lexing helpers (comments, balanced blocks, fluent chains) |
| `src/snapshotParser.js` | Parses EF Core generated `*.Designer.cs` / `*ModelSnapshot.cs` |
| `src/sourceParser.js` | Convention + annotation based model from POCOs (no-migrations fallback) |
| `src/diff.js` | Structural diff between two model snapshots |
| `src/build.js` | Ties scan → parse → diff into the final data payload |
| `src/emit.js` | Inlines data + viewer into one HTML file |
| `src/viewer/` | The interactive viewer (template.html, styles.css, app.js) |
| `examples/` | Sample projects used by tests, docs, and screenshots |
| `test/` | `node:test` suites |

## Guidelines

- **No runtime dependencies.** The CLI must keep working with nothing but Node.
- **The output HTML must stay self-contained** — no CDN scripts, fonts, or network calls.
- **Add a test** when you fix a parser bug: extend the example projects (or add a fixture
  string) so the regression is covered.
- Parsers should **degrade gracefully**: unknown fluent calls are ignored, never fatal.
- Run `node --test` before opening a PR; CI runs it on Node 18/20/22.

## Reporting parser issues

The most useful bug report is a snippet of the `*.Designer.cs` / entity class that parses
incorrectly, plus what you expected. If you can, run with `--json` and attach the relevant
part of the model output.

## Ideas that would make great PRs

- Mermaid / PlantUML / dbml export
- `--watch` mode
- TPT / TPC inheritance edges
- Sequences, check constraints, triggers from migration operations
- Localization of the viewer UI
