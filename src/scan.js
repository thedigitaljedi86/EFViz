/**
 * Workspace discovery: walks a directory tree and finds DbContext classes,
 * migration designer files, and model snapshot files.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SKIP_DIRS = new Set([
  'bin', 'obj', 'node_modules', '.git', '.vs', '.idea', '.vscode',
  'packages', 'TestResults', 'artifacts', '.svn', 'dist', 'out',
]);

/** Recursively collect .cs files under root (skipping build/VCS folders). */
export function findCsFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.cs')) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

const DBCONTEXT_BASES = /(?:^|[\s,:(])(?:\w+\.)*((?:Identity)?DbContext|IdentityUserContext)\b/;

/**
 * Scan the workspace. Returns:
 * {
 *   contexts: [{ name, namespace, filePath, dbSets: [{ entityType, propertyName }] }],
 *   migrationSets: Map<contextTypeName, [{ id, name, timestamp, filePath, code }]>,
 *   snapshots: Map<contextTypeName, { filePath, code }>,
 *   csFiles: [paths]
 * }
 */
export function scanWorkspace(root) {
  const csFiles = findCsFiles(root);
  const contexts = [];
  const migrationSets = new Map();
  const snapshots = new Map();

  for (const file of csFiles) {
    let code;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Migration designer files: [Migration("id")] + BuildTargetModel
    if (file.endsWith('.Designer.cs') && code.includes('[Migration(') && code.includes('BuildTargetModel')) {
      const idMatch = /\[Migration\(\s*"([^"]+)"\s*\)\]/.exec(code);
      const ctxMatch = /\[DbContext\(typeof\(([\w.]+)\)\)\]/.exec(code);
      if (idMatch) {
        const ctxType = ctxMatch ? shortTypeName(ctxMatch[1]) : '?';
        if (!migrationSets.has(ctxType)) migrationSets.set(ctxType, []);
        migrationSets.get(ctxType).push({ id: idMatch[1], filePath: file, code });
      }
      continue;
    }

    // Model snapshot files
    if (code.includes('ModelSnapshot') && code.includes('BuildModel') && code.includes('[DbContext(')) {
      const ctxMatch = /\[DbContext\(typeof\(([\w.]+)\)\)\]/.exec(code);
      if (ctxMatch) {
        snapshots.set(shortTypeName(ctxMatch[1]), { filePath: file, code });
        continue;
      }
    }

    // DbContext classes (user code)
    const classRe = /(?:public|internal|protected|private)?\s*(?:sealed\s+|abstract\s+|partial\s+)*class\s+(\w+)\s*(?:<[^>]*>)?\s*:\s*([^\n{]+)/g;
    let m;
    while ((m = classRe.exec(code)) !== null) {
      const bases = m[2];
      if (!DBCONTEXT_BASES.test(bases)) continue;
      if (bases.includes('Migration')) continue;
      const name = m[1];
      if (name.endsWith('ModelSnapshot')) continue;
      const nsMatch = /namespace\s+([\w.]+)/.exec(code);
      const dbSets = [];
      const dbSetRe = /DbSet<([\w.<>?]+)>\s*(\w+)\s*(?:\{|=>)/g;
      let ds;
      while ((ds = dbSetRe.exec(code)) !== null) {
        dbSets.push({ entityType: ds[1], propertyName: ds[2] });
      }
      contexts.push({
        name,
        namespace: nsMatch ? nsMatch[1] : null,
        filePath: file,
        relativePath: relative(root, file).split(sep).join('/'),
        dbSets,
        isAbstract: /abstract\s+(?:partial\s+)?class\s+/.test(m[0]),
        code,
      });
    }
  }

  // Sort migrations chronologically by id prefix.
  for (const list of migrationSets.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
  }

  return { contexts, migrationSets, snapshots, csFiles };
}

function shortTypeName(fqn) {
  const parts = fqn.split('.');
  return parts[parts.length - 1];
}

/** True if a path exists and is a directory. */
export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
