/* EFViz interactive viewer */
(() => {
  'use strict';

  const DATA = JSON.parse(document.getElementById('efviz-data').textContent);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const svg = $('diagram');
  const viewport = $('viewport');
  const host = $('canvasHost');

  /* ---------------- state ---------------- */

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('efviz:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('efviz:' + key, JSON.stringify(value));
      } catch { /* private mode */ }
    },
  };

  const state = {
    ctxIndex: 0,
    step: -1,
    selected: null,
    search: '',
    searchHits: [],
    searchCursor: -1,
    hideJoins: store.get('hideJoins', true),
    showChanges: false,
    view: { x: 0, y: 0, k: 1 },
    playTimer: null,
    layout: new Map(),
    displayed: null,
  };

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.mode = store.get('mode', prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.accent = store.get('accent', 'indigo');

  /* ---------------- steps ---------------- */

  function ctx() {
    return DATA.contexts[state.ctxIndex];
  }

  function getSteps(c) {
    const steps = [];
    for (const m of c.migrations) {
      steps.push({ kind: 'migration', id: m.id, label: m.name, timestamp: m.timestamp, model: m.model, diff: m.diff });
    }
    if (c.pendingChanges && c.currentModel) {
      steps.push({ kind: 'pending', id: '(snapshot)', label: 'Pending model changes', timestamp: null, model: c.currentModel, diff: c.pendingChanges });
    }
    if (steps.length === 0) {
      steps.push({
        kind: 'current',
        id: '(current)',
        label: c.modelSource === 'source' ? 'Current model (from source)' : 'Current model',
        timestamp: null,
        model: c.currentModel,
        diff: null,
      });
    }
    return steps;
  }

  /* ------------- display model (with diff ghosts) ------------- */

  function buildDisplayModel(c, stepIdx) {
    const steps = getSteps(c);
    const step = steps[stepIdx];
    const prev = stepIdx > 0 ? steps[stepIdx - 1] : null;
    const diff = step.diff;

    const added = new Set(diff ? diff.addedEntities : []);
    const removed = new Set(diff ? diff.removedEntities : []);
    const modified = new Map(diff ? diff.modifiedEntities.map((m) => [m.entity, m]) : []);

    const entities = step.model.entities.map((e) => {
      const clone = { ...e, columns: e.columns.map((col) => ({ ...col })) };
      if (added.has(e.fullName)) clone.diffStatus = 'added';
      else if (modified.has(e.fullName)) {
        clone.diffStatus = 'modified';
        const m = modified.get(e.fullName);
        const addedCols = new Set(m.addedColumns);
        const modCols = new Set(m.modifiedColumns.map((mc) => mc.column));
        for (const col of clone.columns) {
          if (addedCols.has(col.name)) col.diffStatus = 'added';
          else if (modCols.has(col.name)) col.diffStatus = 'modified';
        }
        if (prev) {
          const prevE = prev.model.entities.find((pe) => pe.fullName === e.fullName);
          for (const rc of m.removedColumns) {
            const prevCol = prevE?.columns.find((pc) => pc.name === rc);
            clone.columns.push({ ...(prevCol ?? { name: rc, columnName: rc }), diffStatus: 'removed' });
          }
        }
      }
      return clone;
    });

    if (prev) {
      for (const name of removed) {
        const prevE = prev.model.entities.find((pe) => pe.fullName === name);
        if (prevE) entities.push({ ...prevE, columns: prevE.columns.map((col) => ({ ...col })), diffStatus: 'removed' });
      }
    }

    const relKey = (r) => `${r.type}|${r.dependent}|${r.principal}|${(r.foreignKey ?? []).join(',')}|${r.via ?? ''}`;
    const addedRels = new Set((diff?.addedRelationships ?? []).map(relKey));
    const relationships = step.model.relationships.map((r) => {
      const clone = { ...r };
      if (addedRels.has(relKey(r))) clone.diffStatus = 'added';
      return clone;
    });
    if (prev && diff) {
      const removedKeys = new Set(diff.removedRelationships.map(relKey));
      for (const r of prev.model.relationships) {
        if (removedKeys.has(relKey(r))) relationships.push({ ...r, diffStatus: 'removed' });
      }
    }

    return { entities, relationships, step, steps };
  }

  /* ---------------- text measurement ---------------- */

  const measureCanvas = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    measureCanvas.font = font;
    return measureCanvas.measureText(text).width;
  }
  const FONT_TITLE = '650 13.5px -apple-system, "Segoe UI", Roboto, sans-serif';
  const FONT_ROW = '12px -apple-system, "Segoe UI", Roboto, sans-serif';
  const FONT_TYPE = '11px "SF Mono", Consolas, Menlo, monospace';

  /* ---------------- layout ---------------- */

  const HEADER_H = 42;
  const ROW_H = 22;
  const PAD_X = 12;
  const MAX_ROWS = 16;
  const COL_GAP_X = 150;
  const NODE_GAP_Y = 42;

  function typeLabel(col) {
    let t = col.storeType ?? col.clrType ?? '';
    if (!col.isRequired && !/\?$/.test(t) && !/nullable/i.test(t)) t += '?';
    return t;
  }

  function displayHeight(entity) {
    const rows = Math.min(entity.columns.length, MAX_ROWS);
    const extra = entity.columns.length > MAX_ROWS ? 1 : 0;
    return HEADER_H + (rows + extra) * ROW_H + 8;
  }

  function nodeSize(entity) {
    const h = displayHeight(entity);
    let w = textWidth(entity.name, FONT_TITLE) + 90;
    const sub = tableLabel(entity);
    w = Math.max(w, textWidth(sub, '10.5px sans-serif') + 60);
    for (const col of entity.columns.slice(0, MAX_ROWS)) {
      const rowW = 30 + textWidth(col.columnName ?? col.name, FONT_ROW) + 26 + textWidth(typeLabel(col), FONT_TYPE) + PAD_X;
      w = Math.max(w, rowW);
    }
    return { w: Math.min(Math.max(Math.ceil(w), 200), 380), h };
  }

  function tableLabel(entity) {
    if (!entity.table) return entity.fullName;
    return entity.schema ? `${entity.schema}.${entity.table}` : entity.table;
  }

  function computeLayout(entities, relationships) {
    const nodes = new Map();
    for (const e of entities) {
      const { w, h } = nodeSize(e);
      nodes.set(e.fullName, { entity: e, w, h, x: 0, y: 0 });
    }

    // Layer assignment: principals to the left of dependents.
    const layerOf = new Map();
    for (const name of nodes.keys()) layerOf.set(name, 0);
    const structural = relationships.filter(
      (r) => r.type !== 'many-to-many' && r.dependent !== r.principal && nodes.has(r.dependent) && nodes.has(r.principal)
    );
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const r of structural) {
        const want = layerOf.get(r.principal) + 1;
        if (layerOf.get(r.dependent) < want && want < 24) {
          layerOf.set(r.dependent, want);
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Compact: shift isolated nodes into the densest area (layer 0 is fine).

    const layers = [];
    for (const [name, layer] of layerOf) {
      (layers[layer] ??= []).push(name);
    }
    const compact = layers.filter((l) => l && l.length);

    // Order within layers via neighbor barycenter (few sweeps).
    const neighbors = new Map();
    for (const r of structural) {
      (neighbors.get(r.dependent) ?? neighbors.set(r.dependent, []).get(r.dependent)).push(r.principal);
      (neighbors.get(r.principal) ?? neighbors.set(r.principal, []).get(r.principal)).push(r.dependent);
    }
    const orderIndex = new Map();
    compact.forEach((layer) => layer.sort().forEach((n, i) => orderIndex.set(n, i)));
    for (let sweep = 0; sweep < 4; sweep++) {
      for (const layer of compact) {
        layer.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
        layer.forEach((n, i) => orderIndex.set(n, i));
      }
    }
    function bary(name) {
      const ns = neighbors.get(name);
      if (!ns || !ns.length) return orderIndex.get(name) ?? 0;
      return ns.reduce((s, n) => s + (orderIndex.get(n) ?? 0), 0) / ns.length;
    }

    // Coordinates.
    let x = 0;
    const layerHeights = compact.map((layer) =>
      layer.reduce((s, n) => s + nodes.get(n).h + NODE_GAP_Y, -NODE_GAP_Y)
    );
    const maxH = Math.max(...layerHeights, 0);
    compact.forEach((layer, li) => {
      const colW = Math.max(...layer.map((n) => nodes.get(n).w));
      let y = (maxH - layerHeights[li]) / 2;
      for (const name of layer) {
        const node = nodes.get(name);
        node.x = x + (colW - node.w) / 2;
        node.y = y;
        y += node.h + NODE_GAP_Y;
      }
      x += colW + COL_GAP_X;
    });

    // Apply saved positions.
    const saved = store.get('pos:' + ctx().name, {});
    for (const [name, node] of nodes) {
      const p = saved[name];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        node.x = p.x;
        node.y = p.y;
      }
    }
    return nodes;
  }

  function savePositions() {
    const saved = {};
    for (const [name, node] of state.layout) saved[name] = { x: Math.round(node.x), y: Math.round(node.y) };
    store.set('pos:' + ctx().name, saved);
  }

  /* ---------------- svg helpers ---------------- */

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(parent, x, y, content, cls, anchor) {
    const t = el('text', { x, y, class: cls, 'text-anchor': anchor ?? 'start' }, parent);
    t.textContent = content;
    return t;
  }

  /* ---------------- icons (svg path data) ---------------- */

  const ICON_KEY = 'M7.5 1.2a4 4 0 0 0-3.9 4.9L.4 9.3a.9.9 0 0 0-.26.63v1.62c0 .5.4.9.9.9h1.62c.5 0 .9-.4.9-.9v-.72h.72c.5 0 .9-.4.9-.9v-.72h.72c.24 0 .47-.1.64-.26l.53-.53A4 4 0 1 0 7.5 1.2Zm1.3 4a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Z';
  const ICON_LINK = 'M5.2 6.8a3 3 0 0 0 4.2.3l1.8-1.6A3 3 0 0 0 7.2 1L6.1 2a.75.75 0 1 0 1 1.1l1.1-1a1.5 1.5 0 0 1 2 2.2L8.4 5.9a1.5 1.5 0 0 1-2.1-.1.75.75 0 0 0-1.1 1Zm1.6-1.6a3 3 0 0 0-4.2-.3L.8 6.5A3 3 0 0 0 4.8 11l1.1-1a.75.75 0 1 0-1-1.1l-1.1 1a1.5 1.5 0 0 1-2-2.2l1.8-1.6a1.5 1.5 0 0 1 2.1.1.75.75 0 0 0 1.1-1Z';

  /* ---------------- rendering: nodes ---------------- */

  function renderNode(entity, node) {
    const g = el('g', { class: 'node', 'data-entity': entity.fullName, transform: `translate(${node.x},${node.y})` });
    if (entity.diffStatus) g.classList.add('diff-' + entity.diffStatus);
    if (state.selected === entity.fullName) g.classList.add('selected');

    el('rect', { class: 'node-box', width: node.w, height: node.h, rx: 10 }, g);
    // Header
    el('path', {
      class: 'node-header',
      d: `M1 10 a9 9 0 0 1 9-9 h${node.w - 20} a9 9 0 0 1 9 9 v${HEADER_H - 11} h-${node.w - 2} Z`,
    }, g);
    el('rect', { class: 'header-accent', x: 0, y: 12, width: 3.5, height: HEADER_H - 22, rx: 1.75 }, g);
    text(g, PAD_X, 18.5, entity.name, 'node-title');
    text(g, PAD_X, 33, tableLabel(entity), 'node-subtitle');

    const chips = [];
    if (entity.isJoinTable) chips.push('JOIN');
    if (entity.isOwned) chips.push('OWNED');
    if (entity.isView) chips.push('VIEW');
    if (entity.baseType) chips.push('TPH');
    if (chips.length) text(g, node.w - 9, 17, chips.join(' · '), 'chip-join', 'end');

    el('line', { class: 'row-sep', x1: 0, y1: HEADER_H, x2: node.w, y2: HEADER_H }, g);

    const uniqueCols = new Set(entity.indexes.filter((i) => i.isUnique && i.columns.length === 1).map((i) => i.columns[0]));

    const shown = entity.columns.slice(0, MAX_ROWS);
    shown.forEach((col, i) => {
      const y = HEADER_H + i * ROW_H;
      if (col.diffStatus) {
        el('rect', { class: 'row-bg ' + col.diffStatus, x: 1, y, width: node.w - 2, height: ROW_H }, g);
      }
      const cy = y + ROW_H / 2;
      const iconCls = col.isPrimaryKey ? 'col-icon pk' : col.isForeignKey ? 'col-icon fk' : 'col-icon';
      if (col.isPrimaryKey) {
        el('path', { d: ICON_KEY, class: iconCls, transform: `translate(${PAD_X - 3},${cy - 6}) scale(0.92)` }, g);
      } else if (col.isForeignKey) {
        el('path', { d: ICON_LINK, class: iconCls, transform: `translate(${PAD_X - 3},${cy - 6})` }, g);
      } else {
        el('circle', { class: iconCls, cx: PAD_X + 2.5, cy, r: 1.8 }, g);
      }
      const nameCls = ['col-name'];
      if (col.isPrimaryKey) nameCls.push('pk');
      if (col.diffStatus) nameCls.push(col.diffStatus);
      const label = (col.columnName ?? col.name) + (uniqueCols.has(col.name) ? ' ⁺' : '');
      text(g, PAD_X + 14, cy + 4, label, nameCls.join(' '));
      text(g, node.w - PAD_X + 2, cy + 4, typeLabel(col), 'col-type' + (col.diffStatus === 'removed' ? ' removed' : ''), 'end');
    });
    if (entity.columns.length > MAX_ROWS) {
      const y = HEADER_H + MAX_ROWS * ROW_H;
      text(g, PAD_X + 14, y + ROW_H / 2 + 4, `+ ${entity.columns.length - MAX_ROWS} more columns…`, 'more-rows');
    }
    return g;
  }

  /* ---------------- rendering: edges ---------------- */

  function rowY(entity, node, columnName) {
    const idx = entity.columns.findIndex((col) => col.name === columnName || col.columnName === columnName);
    if (idx === -1 || idx >= MAX_ROWS) return node.y + HEADER_H / 2;
    return node.y + HEADER_H + idx * ROW_H + ROW_H / 2;
  }

  function edgePath(rel, index, siblings) {
    const dep = state.layout.get(rel.dependent);
    const prin = state.layout.get(rel.principal);
    if (!dep || !prin) return null;

    // Self reference: loop on the right edge.
    if (rel.dependent === rel.principal) {
      const y1 = rowY(dep.entity, dep, rel.foreignKey?.[0]) ?? dep.y + 20;
      const y2 = dep.y + HEADER_H / 2 + 6;
      const x = dep.x + dep.w;
      const ext = 46 + index * 14;
      return {
        d: `M ${x} ${y1} C ${x + ext} ${y1}, ${x + ext} ${y2}, ${x} ${y2}`,
        from: { x, y: y1, dir: 1 },
        to: { x, y: y2, dir: 1 },
        mid: { x: x + ext * 0.78, y: (y1 + y2) / 2 },
      };
    }

    const depCx = dep.x + dep.w / 2;
    const prinCx = prin.x + prin.w / 2;
    const fromRight = prinCx >= depCx; // principal sits to the right → exit dependent's right side
    const fkY = rel.foreignKey?.length ? rowY(dep.entity, dep, rel.foreignKey[0]) : dep.y + dep.h / 2;
    const pkY = prin.entity.primaryKey?.length
      ? rowY(prin.entity, prin, prin.entity.primaryKey[0])
      : prin.y + HEADER_H / 2;

    const x1 = fromRight ? dep.x + dep.w : dep.x;
    const x2 = fromRight ? prin.x : prin.x + prin.w;
    const spread = (index - (siblings - 1) / 2) * 16;
    const y1 = fkY + spread * 0.3;
    const y2 = pkY + spread;

    const dx = Math.abs(x2 - x1);
    const bend = Math.max(46, Math.min(dx / 2, 170));
    const c1x = x1 + (fromRight ? bend : -bend);
    const c2x = x2 + (fromRight ? -bend : bend);
    return {
      d: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
      from: { x: x1, y: y1, dir: fromRight ? 1 : -1 },
      to: { x: x2, y: y2, dir: fromRight ? -1 : 1 },
      mid: bezierPoint(x1, y1, c1x, y1, c2x, y2, x2, y2, 0.5),
    };
  }

  function bezierPoint(x1, y1, cx1, cy1, cx2, cy2, x2, y2, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * mt * x1 + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x2,
      y: mt * mt * mt * y1 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y2,
    };
  }

  /** Cardinality / kind glyphs drawn at an edge endpoint. dir = direction the edge leaves the node (+1 right). */
  function drawEnd(g, pt, kind) {
    const { x, y, dir } = pt;
    const d = dir; // glyphs extend away from the node
    switch (kind) {
      case 'many': // crow's foot against the node border
        el('path', { class: 'edge-end', d: `M ${x + 9 * d} ${y} L ${x} ${y - 5.5} M ${x + 9 * d} ${y} L ${x} ${y + 5.5} M ${x + 9 * d} ${y} L ${x} ${y}` }, g);
        break;
      case 'one':
        el('path', { class: 'edge-end', d: `M ${x + 6 * d} ${y - 5.5} L ${x + 6 * d} ${y + 5.5}` }, g);
        break;
      case 'one-optional':
        el('path', { class: 'edge-end', d: `M ${x + 4 * d} ${y - 5.5} L ${x + 4 * d} ${y + 5.5}` }, g);
        el('circle', { class: 'edge-end hollow', cx: x + 11 * d, cy: y, r: 4 }, g);
        break;
      case 'triangle':
        el('path', { class: 'edge-end hollow', d: `M ${x} ${y} L ${x + 11 * d} ${y - 6.5} L ${x + 11 * d} ${y + 6.5} Z` }, g);
        break;
      case 'diamond':
        el('path', { class: 'edge-end filled', d: `M ${x} ${y} L ${x + 7 * d} ${y - 4.5} L ${x + 14 * d} ${y} L ${x + 7 * d} ${y + 4.5} Z` }, g);
        break;
    }
  }

  function renderEdge(rel, index, siblings, edgeId) {
    const geo = edgePath(rel, index, siblings);
    if (!geo) return null;
    const g = el('g', { class: 'edge', 'data-edge': edgeId });
    if (rel.diffStatus) g.classList.add('diff-' + rel.diffStatus);
    if (rel.type === 'inheritance') g.classList.add('inheritance');
    if (rel.isOwnership) g.classList.add('ownership');
    if (state.selected && (rel.dependent === state.selected || rel.principal === state.selected)) g.classList.add('highlight');

    el('path', { class: 'edge-line', d: geo.d }, g);
    el('path', { class: 'edge-hit', d: geo.d }, g);

    if (rel.type === 'inheritance') {
      drawEnd(g, geo.to, 'triangle');
    } else if (rel.isOwnership) {
      drawEnd(g, geo.to, 'diamond');
    } else if (rel.type === 'many-to-many') {
      drawEnd(g, geo.from, 'many');
      drawEnd(g, geo.to, 'many');
    } else if (rel.type === 'one-to-one') {
      drawEnd(g, geo.from, 'one');
      drawEnd(g, geo.to, rel.isRequired ? 'one' : 'one-optional');
    } else {
      drawEnd(g, geo.from, 'many');
      drawEnd(g, geo.to, rel.isRequired ? 'one' : 'one-optional');
    }

    const label =
      rel.type === 'many-to-many'
        ? `via ${short(rel.via ?? '')}`.trim()
        : rel.foreignKey?.length
          ? rel.foreignKey.join(', ')
          : rel.type;
    const t = text(g, geo.mid.x, geo.mid.y - 6, label, 'edge-label', 'middle');
    const title = el('title', {}, g);
    title.textContent = describeRel(rel);
    return g;
  }

  function describeRel(rel) {
    if (rel.type === 'inheritance') return `${short(rel.dependent)} inherits ${short(rel.principal)}`;
    if (rel.type === 'many-to-many') return `${short(rel.dependent)} ↔ ${short(rel.principal)} (many-to-many via ${short(rel.via ?? 'join table')})`;
    const card = rel.type === 'one-to-one' ? '1 : 1' : '* : 1';
    const fk = rel.foreignKey?.length ? ` — FK ${rel.foreignKey.join(', ')}` : '';
    const del = rel.onDelete ? ` — on delete ${rel.onDelete}` : '';
    const own = rel.isOwnership ? ' (owned)' : '';
    return `${short(rel.dependent)} ${card} ${short(rel.principal)}${fk}${del}${own}`;
  }

  function short(fqn) {
    const parts = String(fqn).split('.');
    return parts[parts.length - 1];
  }

  /* ---------------- main render ---------------- */

  function visibleModel() {
    const dm = buildDisplayModel(ctx(), state.step);
    let { entities, relationships } = dm;
    if (state.hideJoins) {
      const joins = new Set(entities.filter((e) => e.isJoinTable).map((e) => e.fullName));
      entities = entities.filter((e) => !joins.has(e.fullName));
      relationships = relationships.filter((r) => !joins.has(r.dependent) && !joins.has(r.principal));
    } else {
      relationships = relationships.filter((r) => r.type !== 'many-to-many');
    }
    return { ...dm, entities, relationships };
  }

  function render(relayout) {
    const dm = visibleModel();
    state.displayed = dm;
    if (relayout || !state.layoutFor || state.layoutFor !== layoutKey()) {
      // Lay out the union of all timeline steps so every entity keeps a stable
      // position while scrubbing through migrations — no reshuffling.
      const union = unionForLayout();
      state.layout = computeLayout(union.entities, union.relationships);
      state.layoutFor = layoutKey();
    }

    // Heights follow the displayed step (diff ghosts add rows).
    for (const e of dm.entities) {
      const node = state.layout.get(e.fullName);
      if (node) node.h = displayHeight(e);
    }

    viewport.innerHTML = '';
    const edgeLayer = el('g', { class: 'edges' }, viewport);
    const nodeLayer = el('g', { class: 'nodes' }, viewport);

    // group parallel edges between same pair
    const pairCount = new Map();
    const pairKey = (r) => [r.dependent, r.principal].sort().join('→');
    for (const r of dm.relationships) pairCount.set(pairKey(r), (pairCount.get(pairKey(r)) ?? 0) + 1);
    const pairIndex = new Map();
    dm.relationships.forEach((r, i) => {
      const key = pairKey(r);
      const idx = pairIndex.get(key) ?? 0;
      pairIndex.set(key, idx + 1);
      const g = renderEdge(r, idx, pairCount.get(key), i);
      if (g) edgeLayer.appendChild(g);
    });

    for (const e of dm.entities) {
      const node = state.layout.get(e.fullName);
      if (node) nodeLayer.appendChild(renderNode(e, node));
    }

    applySearchDim();
    applyViewTransform();
    renderStats(dm);
    renderTimeline(dm);
    renderChanges(dm);
    if (state.selected) openDetails(state.selected, true);
  }

  function layoutKey() {
    return `${state.ctxIndex}|${state.hideJoins}`;
  }

  function unionForLayout() {
    const steps = getSteps(ctx());
    const entities = new Map();
    const relationships = [];
    const relSeen = new Set();
    for (const s of steps) {
      for (const e of s.model.entities) entities.set(e.fullName, e); // later steps win (usually larger)
      for (const r of s.model.relationships) {
        const key = `${r.type}|${r.dependent}|${r.principal}|${(r.foreignKey ?? []).join(',')}`;
        if (!relSeen.has(key)) {
          relSeen.add(key);
          relationships.push(r);
        }
      }
    }
    let ents = [...entities.values()];
    let rels = relationships;
    if (state.hideJoins) {
      const joins = new Set(ents.filter((e) => e.isJoinTable).map((e) => e.fullName));
      ents = ents.filter((e) => !joins.has(e.fullName));
      rels = rels.filter((r) => !joins.has(r.dependent) && !joins.has(r.principal));
    }
    return { entities: ents, relationships: rels };
  }

  /* ---------------- stats + subtitle ---------------- */

  function renderStats(dm) {
    const c = ctx();
    const cols = dm.entities.reduce((s, e) => s + e.columns.filter((col) => col.diffStatus !== 'removed').length, 0);
    const rels = dm.relationships.filter((r) => r.diffStatus !== 'removed' && r.type !== 'inheritance').length;
    const live = dm.entities.filter((e) => e.diffStatus !== 'removed').length;
    $('stats').innerHTML =
      `<span><b>${live}</b> entities</span>` +
      `<span><b>${rels}</b> relations</span>` +
      `<span><b>${cols}</b> columns</span>` +
      (c.provider ? `<span class="badge"><span class="dot"></span>${esc(c.provider)}</span>` : '');
    const bits = [];
    if (c.namespace) bits.push(c.namespace);
    const pv = dm.step.model.productVersion;
    if (pv) bits.push('EF Core ' + pv);
    $('subTitle').textContent = bits.join(' · ');
  }

  /* ---------------- timeline ---------------- */

  function renderTimeline(dm) {
    const steps = dm.steps;
    const wrap = $('tlSteps');
    wrap.innerHTML = '';
    steps.forEach((s, i) => {
      if (i > 0) {
        const conn = document.createElement('div');
        conn.className = 'tl-connector' + (i <= state.step ? ' past' : '');
        wrap.appendChild(conn);
      }
      const btn = document.createElement('button');
      btn.className = 'tl-step' + (i === state.step ? ' active' : i < state.step ? ' past' : '');
      btn.title = s.id;
      const changes = s.diff ? s.diff.changeCount : 0;
      btn.innerHTML =
        (changes && i > 0 ? `<span class="tl-changes-badge">${changes}</span>` : '') +
        `<span class="tl-dot"></span>` +
        `<span class="tl-name">${esc(s.label)}</span>` +
        `<span class="tl-date">${s.timestamp ? esc(s.timestamp.slice(0, 10)) : ''}${i === steps.length - 1 ? (s.timestamp ? ' · ' : '') + 'latest' : ''}</span>`;
      btn.addEventListener('click', () => gotoStep(i));
      wrap.appendChild(btn);
    });
    $('tlPrev').disabled = state.step <= 0;
    $('tlNext').disabled = state.step >= steps.length - 1;
    const active = wrap.querySelector('.tl-step.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function gotoStep(i) {
    const steps = getSteps(ctx());
    state.step = Math.max(0, Math.min(i, steps.length - 1));
    state.showChanges = true;
    render(false);
  }

  function stopPlay() {
    if (state.playTimer) {
      clearInterval(state.playTimer);
      state.playTimer = null;
      $('iconPlay').style.display = '';
      $('iconPause').style.display = 'none';
    }
  }

  function togglePlay() {
    if (state.playTimer) {
      stopPlay();
      return;
    }
    const steps = getSteps(ctx());
    if (steps.length < 2) return;
    if (state.step >= steps.length - 1) gotoStep(0);
    $('iconPlay').style.display = 'none';
    $('iconPause').style.display = '';
    state.playTimer = setInterval(() => {
      if (state.step >= getSteps(ctx()).length - 1) stopPlay();
      else gotoStep(state.step + 1);
    }, 1700);
  }

  /* ---------------- changes drawer ---------------- */

  function renderChanges(dm) {
    const panel = $('changes');
    const diff = dm.step.diff;
    const isFirst = state.step === 0 && dm.step.kind === 'migration';
    if (!diff || !state.showChanges || (dm.steps.length === 1 && !diff.changeCount)) {
      panel.classList.remove('open');
      return;
    }
    panel.classList.add('open');
    $('changesSub').textContent = dm.step.kind === 'pending' ? 'model snapshot vs last migration' : dm.step.label;
    const body = $('changesBody');
    body.innerHTML = '';

    const add = (cls, what, detail, focus) => {
      const item = document.createElement('div');
      item.className = 'chg-item';
      item.innerHTML = `<span class="chg-icon ${cls}">${cls === 'add' ? '+' : cls === 'rem' ? '−' : '~'}</span><span><span class="chg-what">${esc(what)}</span>${detail ? `<div class="chg-detail">${esc(detail)}</div>` : ''}</span>`;
      if (focus) item.addEventListener('click', () => focusEntity(focus));
      body.appendChild(item);
    };

    if (isFirst) {
      const names = diff.addedEntities.map(short).join(', ');
      add('add', `Initial schema — ${diff.addedEntities.length} tables`, names);
      diff.addedEntities.forEach((e) => add('add', short(e), 'table created', e));
      return;
    }

    for (const e of diff.addedEntities) add('add', short(e), 'table created', e);
    for (const e of diff.removedEntities) add('rem', short(e), 'table dropped', e);
    for (const m of diff.modifiedEntities) {
      const bits = [];
      if (m.addedColumns.length) bits.push(`+ ${m.addedColumns.join(', ')}`);
      if (m.removedColumns.length) bits.push(`− ${m.removedColumns.join(', ')}`);
      for (const mc of m.modifiedColumns) {
        bits.push(`~ ${mc.column}: ${mc.changes.map((ch) => `${ch.field.replace(/^is/, '').toLowerCase()} ${fmt(ch.from)} → ${fmt(ch.to)}`).join('; ')}`);
      }
      if (m.addedIndexes.length) bits.push(`+ index ${m.addedIndexes.join('; ')}`);
      if (m.removedIndexes.length) bits.push(`− index ${m.removedIndexes.join('; ')}`);
      if (m.tableChanged) bits.push(`renamed ${m.tableChanged.from} → ${m.tableChanged.to}`);
      add('mod', m.name, bits.join('  ·  '), m.entity);
    }
    for (const r of diff.addedRelationships) {
      if (r.type === 'inheritance') continue;
      add('add', `${short(r.dependent)} → ${short(r.principal)}`, r.type + (r.foreignKey.length ? ` (${r.foreignKey.join(', ')})` : ''), r.dependent);
    }
    for (const r of diff.removedRelationships) {
      if (r.type === 'inheritance') continue;
      add('rem', `${short(r.dependent)} → ${short(r.principal)}`, r.type, r.dependent);
    }
    if (!body.children.length) body.innerHTML = '<div class="chg-empty">No structural changes.</div>';
  }

  function fmt(v) {
    if (v === null || v === undefined) return '∅';
    return String(v);
  }

  /* ---------------- details panel ---------------- */

  function openDetails(fullName, keepIfMissing) {
    const dm = state.displayed;
    const entity = dm.entities.find((e) => e.fullName === fullName);
    if (!entity) {
      if (!keepIfMissing) closeDetails();
      return;
    }
    state.selected = fullName;
    document.querySelectorAll('.node').forEach((n) => n.classList.toggle('selected', n.dataset.entity === fullName));
    document.querySelectorAll('.edge').forEach((e) => {
      const idx = Number(e.dataset.edge);
      const rel = dm.relationships[idx];
      e.classList.toggle('highlight', !!rel && (rel.dependent === fullName || rel.principal === fullName));
    });

    $('dTitle').innerHTML =
      esc(entity.name) +
      (entity.isJoinTable ? '<span class="pill">JOIN TABLE</span>' : '') +
      (entity.isOwned ? '<span class="pill owned">OWNED</span>' : '') +
      (entity.diffStatus ? `<span class="pill ${entity.diffStatus === 'added' ? 'add' : entity.diffStatus === 'removed' ? 'rem' : 'mod'}">${entity.diffStatus.toUpperCase()}</span>` : '');
    $('dSub').textContent = entity.fullName;

    const body = $('dBody');
    body.innerHTML = '';

    // Overview
    const kv = [];
    kv.push(['Table', tableLabel(entity)]);
    if (entity.schema) kv.push(['Schema', entity.schema]);
    if (entity.primaryKey?.length) kv.push(['Primary key', entity.primaryKey.join(', ')]);
    if (entity.baseType) kv.push(['Inherits', short(entity.baseType)]);
    if (entity.discriminator) kv.push(['Discriminator', entity.discriminator.column]);
    if (entity.seedCount) kv.push(['Seed rows', String(entity.seedCount)]);
    section(body, 'Overview', `<dl class="d-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);

    // Columns
    const uniqueCols = new Set(entity.indexes.filter((i) => i.isUnique && i.columns.length === 1).map((i) => i.columns[0]));
    const rows = entity.columns
      .map((col) => {
        const flags = [];
        if (col.isPrimaryKey) flags.push('<span class="pill pk">PK</span>');
        if (col.isForeignKey) flags.push('<span class="pill fk">FK</span>');
        if (uniqueCols.has(col.name)) flags.push('<span class="pill uniq">UQ</span>');
        if (col.owned) flags.push('<span class="pill owned">OWN</span>');
        if (col.isConcurrencyToken) flags.push('<span class="pill">CC</span>');
        if (col.isIdentity || col.valueGenerated === 'OnAdd') flags.push('<span class="pill">GEN</span>');
        if (col.diffStatus) flags.push(`<span class="pill ${col.diffStatus === 'added' ? 'add' : col.diffStatus === 'removed' ? 'rem' : 'mod'}">${col.diffStatus === 'added' ? 'NEW' : col.diffStatus === 'removed' ? 'DEL' : 'CHG'}</span>`);
        const extras = [];
        if (col.maxLength != null) extras.push(`max ${col.maxLength}`);
        if (col.defaultValue !== undefined && col.defaultValue !== null) extras.push(`default ${col.defaultValue}`);
        if (col.defaultValueSql) extras.push(`default ${col.defaultValueSql}`);
        if (col.computedSql) extras.push('computed');
        return `<tr><td class="c-name">${esc(col.columnName ?? col.name)}</td><td class="c-type">${esc(typeLabel(col))}${extras.length ? `<div>${esc(extras.join(' · '))}</div>` : ''}</td><td class="c-flags">${flags.join('')}</td></tr>`;
      })
      .join('');
    section(body, `Columns (${entity.columns.length})`, `<table class="d-table">${rows}</table>`);

    // Relationships
    const rels = state.displayed.relationships.filter(
      (r) => (r.dependent === fullName || r.principal === fullName) && r.type !== 'inheritance'
    );
    if (rels.length) {
      const html = rels
        .map((r) => {
          const outgoing = r.dependent === fullName;
          const other = outgoing ? r.principal : r.dependent;
          const arrow = outgoing
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>';
          const meta = [];
          if (r.type === 'many-to-many') meta.push(`many-to-many via ${short(r.via ?? 'join')}`);
          else meta.push(outgoing ? `${r.type} → ${short(other)}` : `${short(other)} ${r.type} → this`);
          if (r.foreignKey?.length) meta.push(`FK ${r.foreignKey.join(', ')}`);
          if (r.onDelete) meta.push(`on delete ${r.onDelete}`);
          if (r.isOwnership) meta.push('ownership');
          const navs = [r.navigation, r.inverseNavigation].filter(Boolean).join(' / ');
          return `<div class="rel-item" data-target="${esc(other)}">${arrow}<div><div class="rel-what">${esc(short(other))}${navs ? ` <span style="color:var(--text-faint);font-weight:400">· ${esc(navs)}</span>` : ''}</div><div class="rel-meta">${esc(meta.join(' — '))}</div></div></div>`;
        })
        .join('');
      section(body, `Relationships (${rels.length})`, html);
    }

    // Indexes
    if (entity.indexes.length) {
      const html = entity.indexes
        .map((i) => `<tr><td class="c-name">${esc(i.columns.join(', '))}</td><td class="c-flags">${i.isUnique ? '<span class="pill uniq">UNIQUE</span>' : ''}${i.filter ? `<span class="pill">FILTERED</span>` : ''}</td></tr>`)
        .join('');
      section(body, `Indexes (${entity.indexes.length})`, `<table class="d-table">${html}</table>`);
    }

    // Owned types
    if (entity.ownedTypes?.length) {
      const html = entity.ownedTypes
        .map((o) => `<div class="history-item"><span class="h-dot"></span><div><div class="h-name">${esc(o.navigation ?? short(o.type))}</div><div class="h-desc">${esc(short(o.type))}${o.inline ? ' — stored in this table' : ' — separate table'}</div></div></div>`)
        .join('');
      section(body, 'Owned types', html);
    }

    // Migration history
    const c = ctx();
    if (c.migrations.length) {
      const items = [];
      for (const m of c.migrations) {
        if (m.diff?.addedEntities.includes(fullName)) items.push({ cls: 'add', name: m.name, desc: 'table created', ts: m.timestamp });
        const mod = m.diff?.modifiedEntities.find((me) => me.entity === fullName);
        if (mod) {
          const bits = [];
          if (mod.addedColumns.length) bits.push(`+${mod.addedColumns.length} col`);
          if (mod.removedColumns.length) bits.push(`−${mod.removedColumns.length} col`);
          if (mod.modifiedColumns.length) bits.push(`~${mod.modifiedColumns.length} col`);
          if (mod.addedIndexes.length || mod.removedIndexes.length) bits.push('indexes');
          items.push({ cls: 'mod', name: m.name, desc: bits.join(', '), ts: m.timestamp });
        }
        if (m.diff?.removedEntities.includes(fullName)) items.push({ cls: 'rem', name: m.name, desc: 'table dropped', ts: m.timestamp });
      }
      if (items.length) {
        const html = items
          .map((i) => `<div class="history-item"><span class="h-dot ${i.cls}"></span><div><div class="h-name">${esc(i.name)}</div><div class="h-desc">${esc(i.desc)}${i.ts ? ` — ${esc(i.ts.slice(0, 10))}` : ''}</div></div></div>`)
          .join('');
        section(body, 'Migration history', html);
      }
    }

    body.querySelectorAll('.rel-item').forEach((elm) => {
      elm.addEventListener('click', () => focusEntity(elm.dataset.target));
    });

    $('details').classList.add('open');
  }

  function section(parent, title, innerHTML) {
    const div = document.createElement('div');
    div.className = 'd-section';
    div.innerHTML = `<h4>${esc(title)}</h4>${innerHTML}`;
    parent.appendChild(div);
  }

  function closeDetails() {
    state.selected = null;
    $('details').classList.remove('open');
    document.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
    document.querySelectorAll('.edge.highlight').forEach((e) => e.classList.remove('highlight'));
  }

  function focusEntity(fullName) {
    const node = state.layout.get(fullName);
    if (!node) return;
    openDetails(fullName);
    panTo(node.x + node.w / 2, node.y + node.h / 2);
  }

  /* ---------------- pan & zoom ---------------- */

  function applyViewTransform() {
    const { x, y, k } = state.view;
    viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    $('zoomPct').textContent = Math.round(k * 100) + '%';
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const k = Math.min(2.6, Math.max(0.12, state.view.k * factor));
    const scale = k / state.view.k;
    state.view.x = px - (px - state.view.x) * scale;
    state.view.y = py - (py - state.view.y) * scale;
    state.view.k = k;
    applyViewTransform();
  }

  function contentBBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of state.layout.values()) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 100, h: 100 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function fitToView() {
    const box = contentBBox();
    const rect = svg.getBoundingClientRect();
    const pad = 60;
    const k = Math.min(2, Math.max(0.12, Math.min((rect.width - pad) / box.w, (rect.height - pad) / box.h)));
    state.view.k = k;
    state.view.x = (rect.width - box.w * k) / 2 - box.x * k;
    state.view.y = (rect.height - box.h * k) / 2 - box.y * k;
    applyViewTransform();
  }

  function panTo(cx, cy) {
    const rect = svg.getBoundingClientRect();
    state.view.x = rect.width / 2 - cx * state.view.k;
    state.view.y = rect.height / 2 - cy * state.view.k;
    applyViewTransform();
  }

  /* ---------------- interactions ---------------- */

  let drag = null;

  host.addEventListener('pointerdown', (ev) => {
    const nodeEl = ev.target.closest('.node');
    if (nodeEl) {
      const name = nodeEl.dataset.entity;
      const node = state.layout.get(name);
      drag = { kind: 'node', name, node, startX: ev.clientX, startY: ev.clientY, origX: node.x, origY: node.y, moved: false, el: nodeEl };
    } else if (!ev.target.closest('.edge')) {
      drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, origX: state.view.x, origY: state.view.y, moved: false };
      host.classList.add('panning');
    }
    if (drag) host.setPointerCapture(ev.pointerId);
  });

  host.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.kind === 'pan') {
      state.view.x = drag.origX + dx;
      state.view.y = drag.origY + dy;
      applyViewTransform();
    } else if (drag.kind === 'node' && drag.moved) {
      drag.node.x = drag.origX + dx / state.view.k;
      drag.node.y = drag.origY + dy / state.view.k;
      drag.el.setAttribute('transform', `translate(${drag.node.x},${drag.node.y})`);
      redrawEdges();
    }
  });

  host.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    host.classList.remove('panning');
    if (drag.kind === 'node') {
      if (!drag.moved) {
        if (state.selected === drag.name) closeDetails();
        else openDetails(drag.name);
      } else {
        savePositions();
      }
    } else if (drag.kind === 'pan' && !drag.moved) {
      closeDetails();
    }
    drag = null;
  });

  function redrawEdges() {
    const dm = state.displayed;
    const edgeLayer = viewport.querySelector('.edges');
    if (!edgeLayer || !dm) return;
    edgeLayer.innerHTML = '';
    const pairCount = new Map();
    const pairKey = (r) => [r.dependent, r.principal].sort().join('→');
    for (const r of dm.relationships) pairCount.set(pairKey(r), (pairCount.get(pairKey(r)) ?? 0) + 1);
    const pairIndex = new Map();
    dm.relationships.forEach((r, i) => {
      const key = pairKey(r);
      const idx = pairIndex.get(key) ?? 0;
      pairIndex.set(key, idx + 1);
      const g = renderEdge(r, idx, pairCount.get(key), i);
      if (g) edgeLayer.appendChild(g);
    });
  }

  host.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    zoomAt(ev.clientX, ev.clientY, factor);
  }, { passive: false });

  host.addEventListener('dblclick', (ev) => {
    if (!ev.target.closest('.node')) fitToView();
  });

  /* ---------------- search ---------------- */

  $('search').addEventListener('input', (ev) => {
    state.search = ev.target.value.trim().toLowerCase();
    state.searchCursor = -1;
    applySearchDim();
  });

  $('search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && state.searchHits.length) {
      state.searchCursor = (state.searchCursor + 1) % state.searchHits.length;
      focusEntity(state.searchHits[state.searchCursor]);
    }
    if (ev.key === 'Escape') {
      ev.target.value = '';
      state.search = '';
      applySearchDim();
      ev.target.blur();
    }
    ev.stopPropagation();
  });

  function applySearchDim() {
    const q = state.search;
    state.searchHits = [];
    const dm = state.displayed;
    if (!dm) return;
    for (const e of dm.entities) {
      const hit =
        !q ||
        e.name.toLowerCase().includes(q) ||
        (e.table ?? '').toLowerCase().includes(q) ||
        e.columns.some((col) => (col.columnName ?? col.name).toLowerCase().includes(q));
      if (q && hit) state.searchHits.push(e.fullName);
      const nodeEl = viewport.querySelector(`.node[data-entity="${cssEscape(e.fullName)}"]`);
      if (nodeEl) nodeEl.classList.toggle('dimmed', !!q && !hit);
    }
    document.querySelectorAll('.edge').forEach((edgeEl) => {
      const rel = dm.relationships[Number(edgeEl.dataset.edge)];
      const dimmed = !!q && rel && !(state.searchHits.includes(rel.dependent) && state.searchHits.includes(rel.principal));
      edgeEl.classList.toggle('dimmed', dimmed);
    });
    $('searchCount').textContent = q ? `${state.searchHits.length}` : '';
  }

  function cssEscape(s) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  /* ---------------- toolbar ---------------- */

  $('modeToggle').addEventListener('click', () => {
    const mode = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.mode = mode;
    store.set('mode', mode);
    syncModeIcon();
  });
  function syncModeIcon() {
    const dark = document.documentElement.dataset.mode === 'dark';
    $('iconMoon').style.display = dark ? 'none' : '';
    $('iconSun').style.display = dark ? '' : 'none';
  }

  document.querySelectorAll('.accent-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      document.documentElement.dataset.accent = sw.dataset.accent;
      store.set('accent', sw.dataset.accent);
      syncAccentSwatches();
    });
  });
  function syncAccentSwatches() {
    document.querySelectorAll('.accent-swatch').forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.accent === document.documentElement.dataset.accent);
    });
  }

  $('toggleJoins').addEventListener('click', () => {
    state.hideJoins = !state.hideJoins;
    store.set('hideJoins', state.hideJoins);
    $('toggleJoins').classList.toggle('active', !state.hideJoins);
    render(false);
    toast(state.hideJoins ? 'Join tables collapsed to many-to-many edges' : 'Join tables shown');
  });

  $('toggleLegend').addEventListener('click', () => {
    $('legend').classList.toggle('hidden');
  });

  $('contextSelect').addEventListener('change', (ev) => {
    state.ctxIndex = Number(ev.target.value);
    state.step = getSteps(ctx()).length - 1;
    state.selected = null;
    closeDetails();
    render(true);
    fitToView();
  });

  $('detailsClose').addEventListener('click', closeDetails);
  $('changesClose').addEventListener('click', () => {
    state.showChanges = false;
    $('changes').classList.remove('open');
  });

  $('zoomIn').addEventListener('click', () => {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25);
  });
  $('zoomOut').addEventListener('click', () => {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 0.8);
  });
  $('zoomFit').addEventListener('click', fitToView);
  $('zoomReset').addEventListener('click', () => {
    store.set('pos:' + ctx().name, {});
    render(true);
    fitToView();
    toast('Layout reset');
  });

  $('tlPrev').addEventListener('click', () => gotoStep(state.step - 1));
  $('tlNext').addEventListener('click', () => gotoStep(state.step + 1));
  $('tlFirst').addEventListener('click', () => gotoStep(0));
  $('tlLast').addEventListener('click', () => gotoStep(getSteps(ctx()).length - 1));
  $('tlPlay').addEventListener('click', togglePlay);

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    switch (ev.key) {
      case 'ArrowLeft': gotoStep(state.step - 1); break;
      case 'ArrowRight': gotoStep(state.step + 1); break;
      case '+': case '=': $('zoomIn').click(); break;
      case '-': $('zoomOut').click(); break;
      case 'f': case 'F': fitToView(); break;
      case 'r': case 'R': $('zoomReset').click(); break;
      case 'Escape': setExportMenu(false); closeDetails(); break;
      case '/':
        ev.preventDefault();
        $('search').focus();
        break;
      case ' ':
        ev.preventDefault();
        togglePlay();
        break;
    }
  });

  /* ---------------- export ---------------- */

  const exportMenu = $('exportMenu');
  function setExportMenu(open) {
    exportMenu.hidden = !open;
    $('exportBtn').setAttribute('aria-expanded', String(open));
    $('exportBtn').classList.toggle('active', open);
  }
  $('exportBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setExportMenu(exportMenu.hidden);
  });
  $('exportSvg').addEventListener('click', () => { setExportMenu(false); downloadSvg(); });
  $('exportPng').addEventListener('click', () => { setExportMenu(false); downloadPng(); });
  document.addEventListener('click', (ev) => {
    if (!exportMenu.hidden && !ev.target.closest('.menu-wrap')) setExportMenu(false);
  });

  function buildExportSvg() {
    const box = contentBBox();
    const pad = 40;
    const clone = viewport.cloneNode(true);
    clone.removeAttribute('transform');
    const out = document.createElementNS(SVG_NS, 'svg');
    out.setAttribute('xmlns', SVG_NS);
    out.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`);
    out.setAttribute('width', box.w + pad * 2);
    out.setAttribute('height', box.h + pad * 2);
    out.dataset.mode = document.documentElement.dataset.mode;
    out.dataset.accent = document.documentElement.dataset.accent;
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = document.querySelector('style').textContent;
    out.appendChild(style);
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', box.x - pad);
    bg.setAttribute('y', box.y - pad);
    bg.setAttribute('width', box.w + pad * 2);
    bg.setAttribute('height', box.h + pad * 2);
    bg.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    out.appendChild(bg);
    out.appendChild(clone);
    return { out, w: box.w + pad * 2, h: box.h + pad * 2 };
  }

  function downloadSvg() {
    const { out } = buildExportSvg();
    const blob = new Blob([new XMLSerializer().serializeToString(out)], { type: 'image/svg+xml' });
    triggerDownload(URL.createObjectURL(blob), exportName() + '.svg');
    toast('SVG exported');
  }

  function downloadPng() {
    const { out, w, h } = buildExportSvg();
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(out)], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h * 2;
      const c2d = canvas.getContext('2d');
      c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        triggerDownload(URL.createObjectURL(blob), exportName() + '.png');
        toast('PNG exported');
      });
    };
    img.src = url;
  }

  function exportName() {
    return (ctx().name || 'entity-diagram').replace(/[^\w-]+/g, '-').toLowerCase();
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- misc ---------------- */

  let toastTimer = null;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------- boot ---------------- */

  function boot() {
    const select = $('contextSelect');
    DATA.contexts.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = c.name + (c.migrations.length ? ` (${c.migrations.length} migrations)` : '');
      select.appendChild(opt);
    });
    if (DATA.contexts.length <= 1) $('contextWrap').style.display = DATA.contexts.length === 0 ? 'none' : '';
    if (DATA.contexts.length === 0) {
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:var(--text-muted)">No DbContext found in this workspace.</div>';
      return;
    }
    state.step = getSteps(ctx()).length - 1;
    $('toggleJoins').classList.toggle('active', !state.hideJoins);
    syncModeIcon();
    syncAccentSwatches();
    render(true);
    fitToView();
    if (DATA.warnings?.length) console.warn('EFViz warnings:', DATA.warnings);
  }

  boot();
})();
