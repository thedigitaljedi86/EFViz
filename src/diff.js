/**
 * Computes structural differences between two model snapshots (typically two
 * consecutive migrations). The result drives the timeline view's highlights
 * and change list.
 */

const COLUMN_FIELDS = [
  'columnName', 'clrType', 'storeType', 'isRequired', 'maxLength', 'precision',
  'scale', 'valueGenerated', 'isIdentity', 'isConcurrencyToken', 'defaultValue',
  'defaultValueSql', 'computedSql', 'isPrimaryKey', 'isForeignKey',
];

export function diffModels(before, after) {
  const diff = {
    addedEntities: [],
    removedEntities: [],
    modifiedEntities: [],
    addedRelationships: [],
    removedRelationships: [],
    changeCount: 0,
  };

  const beforeMap = new Map((before?.entities ?? []).map((e) => [e.fullName, e]));
  const afterMap = new Map((after?.entities ?? []).map((e) => [e.fullName, e]));

  for (const [name, e] of afterMap) {
    if (!beforeMap.has(name)) diff.addedEntities.push(e.fullName);
  }
  for (const [name, e] of beforeMap) {
    if (!afterMap.has(name)) diff.removedEntities.push(e.fullName);
  }

  for (const [name, afterE] of afterMap) {
    const beforeE = beforeMap.get(name);
    if (!beforeE) continue;
    const entityDiff = diffEntity(beforeE, afterE);
    if (entityDiff) diff.modifiedEntities.push(entityDiff);
  }

  const relKey = (r) => `${r.type}|${r.dependent}|${r.principal}|${(r.foreignKey ?? []).join(',')}|${r.via ?? ''}`;
  const beforeRels = new Map((before?.relationships ?? []).map((r) => [relKey(r), r]));
  const afterRels = new Map((after?.relationships ?? []).map((r) => [relKey(r), r]));
  for (const [key, r] of afterRels) {
    if (!beforeRels.has(key)) diff.addedRelationships.push(describeRel(r));
  }
  for (const [key, r] of beforeRels) {
    if (!afterRels.has(key)) diff.removedRelationships.push(describeRel(r));
  }

  diff.changeCount =
    diff.addedEntities.length +
    diff.removedEntities.length +
    diff.addedRelationships.length +
    diff.removedRelationships.length +
    diff.modifiedEntities.reduce(
      (n, e) => n + e.addedColumns.length + e.removedColumns.length + e.modifiedColumns.length + e.addedIndexes.length + e.removedIndexes.length + (e.tableChanged ? 1 : 0),
      0
    );
  return diff;
}

function diffEntity(before, after) {
  const result = {
    entity: after.fullName,
    name: after.name,
    addedColumns: [],
    removedColumns: [],
    modifiedColumns: [],
    addedIndexes: [],
    removedIndexes: [],
    tableChanged: null,
  };

  const beforeCols = new Map(before.columns.map((c) => [c.name, c]));
  const afterCols = new Map(after.columns.map((c) => [c.name, c]));

  for (const [name] of afterCols) {
    if (!beforeCols.has(name)) result.addedColumns.push(name);
  }
  for (const [name] of beforeCols) {
    if (!afterCols.has(name)) result.removedColumns.push(name);
  }
  for (const [name, afterC] of afterCols) {
    const beforeC = beforeCols.get(name);
    if (!beforeC) continue;
    const changes = [];
    for (const f of COLUMN_FIELDS) {
      const a = normalize(afterC[f]);
      const b = normalize(beforeC[f]);
      if (a !== b) changes.push({ field: f, from: beforeC[f] ?? null, to: afterC[f] ?? null });
    }
    if (changes.length) result.modifiedColumns.push({ column: name, changes });
  }

  const idxKey = (i) => `${i.columns.join(',')}|${i.isUnique ? 'u' : ''}|${i.filter ?? ''}`;
  const beforeIdx = new Map(before.indexes.map((i) => [idxKey(i), i]));
  const afterIdx = new Map(after.indexes.map((i) => [idxKey(i), i]));
  for (const [key, i] of afterIdx) {
    if (!beforeIdx.has(key)) result.addedIndexes.push(describeIndex(i));
  }
  for (const [key, i] of beforeIdx) {
    if (!afterIdx.has(key)) result.removedIndexes.push(describeIndex(i));
  }

  if (before.table !== after.table || (before.schema ?? null) !== (after.schema ?? null)) {
    result.tableChanged = { from: qualified(before), to: qualified(after) };
  }

  const empty =
    !result.addedColumns.length &&
    !result.removedColumns.length &&
    !result.modifiedColumns.length &&
    !result.addedIndexes.length &&
    !result.removedIndexes.length &&
    !result.tableChanged;
  return empty ? null : result;
}

function normalize(v) {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

function qualified(e) {
  return e.schema ? `${e.schema}.${e.table}` : e.table;
}

function describeIndex(i) {
  return `${i.isUnique ? 'unique ' : ''}(${i.columns.join(', ')})${i.filter ? ` where ${i.filter}` : ''}`;
}

function describeRel(r) {
  return {
    type: r.type,
    dependent: r.dependent,
    principal: r.principal,
    foreignKey: r.foreignKey ?? [],
    via: r.via ?? null,
    onDelete: r.onDelete ?? null,
  };
}
