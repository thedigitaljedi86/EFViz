/**
 * Emits the final self-contained HTML file: template + styles + viewer app
 * + the diagram data, all inlined. No network access needed to view it.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export function emitHtml(data, options = {}) {
  const template = readFileSync(join(here, 'viewer', 'template.html'), 'utf8');
  const styles = readFileSync(join(here, 'viewer', 'styles.css'), 'utf8');
  const app = readFileSync(join(here, 'viewer', 'app.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

  const title = options.title ?? defaultTitle(data);
  // </script> inside the JSON payload would terminate the script block early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  // Replacer functions: literal insertion, immune to `$&`-style patterns
  // that occur naturally in the viewer's JavaScript.
  return template
    .replaceAll('__TITLE__', () => escapeHtml(title))
    .replace('__VERSION__', () => pkg.version)
    .replace('__STYLES__', () => styles)
    .replace('__DATA__', () => json)
    .replace('__APP__', () => app);
}

function defaultTitle(data) {
  if (data.contexts.length === 1) return `${data.contexts[0].name} — Entity Diagram`;
  return 'Entity Diagram';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
