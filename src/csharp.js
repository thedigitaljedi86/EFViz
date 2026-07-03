/**
 * Minimal C# lexing helpers.
 *
 * We never need a full C# parser: EF Core migration designers and model
 * snapshots are machine-generated with a very regular shape, and entity
 * classes only need property/attribute extraction. These helpers deal with
 * the tricky parts (strings, comments, balanced delimiters) so the parsers
 * on top can stay simple and robust.
 */

/** Remove // and /* *\/ comments while preserving string literals (incl. verbatim @"" and $""). */
export function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || (c === '@' && next === '"') || (c === '$' && next === '"')) {
      const start = i;
      i = skipString(code, i);
      out += code.slice(start, i);
      continue;
    }
    if (c === "'") {
      const start = i;
      i++;
      while (i < n && code[i] !== "'") {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      out += code.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Given index at the start of a string literal (", @", or $"), return index just past its end. */
export function skipString(code, i) {
  const n = code.length;
  let verbatim = false;
  while (code[i] === '@' || code[i] === '$') {
    if (code[i] === '@') verbatim = true;
    i++;
  }
  if (code[i] !== '"') return i + 1;
  i++;
  while (i < n) {
    if (verbatim) {
      if (code[i] === '"') {
        if (code[i + 1] === '"') { i += 2; continue; }
        return i + 1;
      }
      i++;
    } else {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === '"') return i + 1;
      i++;
    }
  }
  return i;
}

const OPEN = { '{': '}', '(': ')', '[': ']' };

/**
 * Given index of an opening delimiter, return the index of its matching
 * closing delimiter (or -1). String-literal aware.
 */
export function findMatching(code, openIdx) {
  const open = code[openIdx];
  const close = OPEN[open];
  if (!close) return -1;
  let depth = 0;
  let i = openIdx;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || ((c === '@' || c === '$') && code[i + 1] === '"')) {
      i = skipString(code, i);
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && code[i] !== "'") {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split a string on a separator that occurs at delimiter-depth 0 (string aware). */
export function splitTopLevel(code, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || ((c === '@' || c === '$') && code[i + 1] === '"')) {
      i = skipString(code, i);
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && code[i] !== "'") {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 0 && c === sep) {
      parts.push(code.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  const last = code.slice(start);
  if (last.trim() !== '') parts.push(last);
  return parts;
}

/** Parse a C# string literal to its value; returns input unchanged if not a string literal. */
export function unquote(raw) {
  const s = raw.trim();
  if (s.startsWith('@"') && s.endsWith('"')) {
    return s.slice(2, -1).replace(/""/g, '"');
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '0': '\0' }[c] ?? c));
  }
  return s;
}

/** Best-effort conversion of a C# literal argument to a JS value. */
export function literalValue(raw) {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '(string)null') return null;
  if (/^-?\d+(\.\d+)?[mMfFdDlL]?$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') || s.startsWith('@"')) return unquote(s);
  return s;
}

/**
 * Parse a fluent chain like:
 *   b.Property<int>("Id").ValueGeneratedOnAdd().HasColumnType("int")
 * into: { root: 'b', calls: [{ name, generic, args: [raw...] }] }
 * Arguments are kept raw (strings, lambdas, enums) for the caller to interpret.
 * Returns null when the statement is not a simple chain (e.g. assignments).
 */
export function parseChain(stmt) {
  const s = stmt.trim();
  const rootMatch = /^([A-Za-z_][\w.]*)\s*(?=[.(<])/.exec(s);
  if (!rootMatch) return null;

  // Find where the root ends and the first `.Call(` begins. The root may itself
  // be dotted (e.g. modelBuilder.Entity → root "modelBuilder", call "Entity").
  const calls = [];
  let root = rootMatch[1];
  let i;
  const lastDot = root.lastIndexOf('.');
  if (lastDot !== -1) {
    // Treat the final segment as the first call if it is followed by ( or <.
    const after = s.slice(rootMatch[0].length).trimStart();
    if (after.startsWith('(') || after.startsWith('<')) {
      const firstCall = root.slice(lastDot + 1);
      root = root.slice(0, lastDot);
      i = s.indexOf(firstCall, root.length) ;
      i = parseCallAt(s, i, firstCall, calls);
      if (i === -1) return null;
    } else {
      return null;
    }
  } else {
    i = rootMatch[0].length;
  }

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return calls.length ? { root, calls } : null;
    i++;
    const nameMatch = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (!nameMatch) return null;
    i = parseCallAt(s, i, nameMatch[0], calls);
    if (i === -1) return null;
  }
  return { root, calls };
}

function parseCallAt(s, i, name, calls) {
  i += name.length;
  let generic = null;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '<') {
    const end = findGenericEnd(s, i);
    if (end === -1) return -1;
    generic = s.slice(i + 1, end).trim();
    i = end + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  if (s[i] !== '(') {
    // Property access, not a call — treat as arg-less call.
    calls.push({ name, generic, args: [] });
    return i;
  }
  const close = findMatching(s, i);
  if (close === -1) return -1;
  const inner = s.slice(i + 1, close);
  const args = inner.trim() === '' ? [] : splitTopLevel(inner, ',').map((a) => a.trim());
  calls.push({ name, generic, args });
  return close + 1;
}

function findGenericEnd(s, i) {
  // i points at '<'; match nested angle brackets (no strings occur inside generics here).
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') {
      depth--;
      if (depth === 0) return i;
    } else if (s[i] === '(' || s[i] === ';') return -1;
  }
  return -1;
}

/** Extract the body of a lambda argument like `b => { ... }`; returns null if not a block lambda. */
export function lambdaBody(raw) {
  const m = /^\s*[A-Za-z_]\w*\s*=>\s*/.exec(raw);
  if (!m) return null;
  const rest = raw.slice(m[0].length).trim();
  if (rest.startsWith('{')) {
    const close = findMatching(rest, 0);
    if (close === -1) return null;
    return rest.slice(1, close);
  }
  return rest;
}

/** Shorten a fully-qualified C# type name to its simple name (handles nested + generics lightly). */
export function simpleName(fqn) {
  const noGenerics = fqn.split('<')[0];
  const parts = noGenerics.split('.');
  let name = parts[parts.length - 1];
  if (name.includes('+')) name = name.split('+').pop();
  return name;
}
