/**
 * Fallback model builder for projects WITHOUT migrations: reconstructs a
 * best-effort model from entity POCOs referenced by a DbContext's DbSet<>
 * properties, using EF Core conventions and data annotations.
 *
 * This is intentionally convention-first — it won't see everything a
 * compiled model would (custom fluent config beyond annotations), but it
 * produces a faithful diagram for the common case.
 */

import { readFileSync } from 'fs';
import { stripComments, findMatching, simpleName } from './csharp.js';
import { finalizeModel } from './snapshotParser.js';

const SCALAR_TYPES = new Set([
  'int', 'long', 'short', 'byte', 'uint', 'ulong', 'ushort', 'sbyte',
  'bool', 'string', 'decimal', 'double', 'float', 'char', 'object',
  'Guid', 'DateTime', 'DateTimeOffset', 'DateOnly', 'TimeOnly', 'TimeSpan',
  'byte[]', 'Int32', 'Int64', 'Boolean', 'String', 'Decimal', 'Double', 'Single',
]);

const COLLECTION_RE = /^(?:System\.Collections\.Generic\.)?(?:ICollection|IList|List|IEnumerable|HashSet|ISet|IReadOnlyCollection|IReadOnlyList|ObservableCollection)<(.+)>$/;

/**
 * Build a model from source for one context.
 * @param context  a context record from scanWorkspace()
 * @param csFiles  all .cs files in the workspace
 */
export function buildModelFromSource(context, csFiles) {
  const classIndex = indexClasses(csFiles);
  const model = { productVersion: null, annotations: {}, entities: [], relationships: [] };
  const included = new Map(); // simple name -> entity record
  const queue = [];

  for (const ds of context.dbSets) {
    const t = simpleName(ds.entityType);
    if (!included.has(t)) {
      queue.push(t);
      included.set(t, null);
    }
  }

  // Breadth-first over navigation targets so entities referenced only via
  // navigations still make it into the diagram.
  // EF's default table name is the DbSet property name.
  const dbSetNames = new Map(context.dbSets.map((ds) => [simpleName(ds.entityType), ds.propertyName]));

  while (queue.length) {
    const typeName = queue.shift();
    const cls = classIndex.get(typeName);
    if (!cls) {
      included.delete(typeName);
      continue;
    }
    const entity = parseEntityClass(cls, classIndex);
    if (dbSetNames.has(typeName) && !cls.attributes.some((a) => a.name === 'Table')) {
      entity.table = dbSetNames.get(typeName);
    }
    included.set(typeName, entity);
    model.entities.push(entity);

    for (const nav of entity._navs) {
      const target = nav.target;
      if (!included.has(target) && classIndex.has(target)) {
        included.set(target, null);
        queue.push(target);
      }
    }
    if (cls.baseClass && classIndex.has(cls.baseClass) && !included.has(cls.baseClass)) {
      included.set(cls.baseClass, null);
      queue.push(cls.baseClass);
    }
  }

  // Resolve navigations into relationships now that the entity set is known.
  for (const entity of model.entities) {
    resolveNavigations(entity, included, model);
  }

  // Owned types ([Owned] attribute): fold into owner like table splitting.
  for (const entity of [...model.entities]) {
    foldOwnedTypes(entity, included, model, classIndex);
  }
  model.entities = model.entities.filter((e) => !e._removed);

  // Base type edges.
  for (const entity of model.entities) {
    if (entity._baseClass && included.get(entity._baseClass)) {
      entity.baseType = included.get(entity._baseClass).fullName;
    }
  }

  for (const e of model.entities) cleanupScratch(e);
  finalizeModel(model);
  return model;
}

/** Index class declarations across the workspace by simple name. */
export function indexClasses(csFiles) {
  const index = new Map();
  for (const file of csFiles) {
    let code;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/\b(class|record)\s+\w+/.test(code)) continue;
    const clean = stripComments(code);
    const nsMatch = /namespace\s+([\w.]+)/.exec(clean);
    const re = /(\[[^\]]*\]\s*)*(?:public|internal)?\s*(?:sealed\s+|abstract\s+|partial\s+)*(class|record)\s+(\w+)(?:\s*:\s*([^{\n]+))?\s*\{/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const name = m[3];
      if (index.has(name)) continue; // first declaration wins
      const bodyStart = clean.indexOf('{', m.index + m[0].length - 1);
      const bodyEnd = findMatching(clean, bodyStart);
      if (bodyEnd === -1) continue;
      // Attributes directly above the declaration are part of the match.
      const attrs = collectAttributes(m[0]);
      const bases = (m[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const baseClass = bases.find((b) => !b.startsWith('I') || /^[A-Z][a-z]/.test(b));
      index.set(name, {
        name,
        namespace: nsMatch ? nsMatch[1] : null,
        filePath: file,
        body: clean.slice(bodyStart + 1, bodyEnd),
        attributes: attrs,
        baseClass: baseClass && !SCALAR_TYPES.has(baseClass) ? simpleName(baseClass.split('<')[0]) : null,
        isEnum: false,
      });
    }
    // Enums, so enum-typed properties map to int columns.
    const enumRe = /(?:public|internal)?\s*enum\s+(\w+)/g;
    while ((m = enumRe.exec(clean)) !== null) {
      if (!index.has(m[1])) index.set(m[1], { name: m[1], isEnum: true });
    }
  }
  return index;
}

function collectAttributes(before) {
  const attrs = [];
  const re = /\[([\w]+)(?:\(([^)]*)\))?\]/g;
  let m;
  while ((m = re.exec(before)) !== null) attrs.push({ name: m[1], args: m[2] ?? '' });
  return attrs;
}

function parseEntityClass(cls, classIndex) {
  const fullName = cls.namespace ? `${cls.namespace}.${cls.name}` : cls.name;
  const tableAttr = cls.attributes.find((a) => a.name === 'Table');
  const entity = {
    name: cls.name,
    fullName,
    table: tableAttr ? unq(tableAttr.args.split(',')[0]) : pluralize(cls.name),
    schema: tableAttr && /Schema\s*=\s*"([^"]+)"/.test(tableAttr.args) ? /Schema\s*=\s*"([^"]+)"/.exec(tableAttr.args)[1] : null,
    isView: false,
    columns: [],
    primaryKey: [],
    alternateKeys: [],
    indexes: [],
    discriminator: null,
    baseType: null,
    ownedTypes: [],
    seedCount: 0,
    annotations: {},
    _navs: [],
    _baseClass: cls.baseClass,
    _isOwnedClass: cls.attributes.some((a) => a.name === 'Owned'),
  };

  const propRe = /(\[[^\]]*\][\s\r\n]*)*public\s+(?:virtual\s+)?([\w.<>\[\]?,\s]+?)\s+(\w+)\s*\{[^}]*?(?:get|init)/g;
  let m;
  while ((m = propRe.exec(cls.body)) !== null) {
    const rawType = m[2].trim();
    const propName = m[3];
    if (rawType === 'class' || rawType === 'enum') continue;
    const attrs = collectAttributes(m[0]);
    if (attrs.some((a) => a.name === 'NotMapped')) continue;

    const nullable = rawType.endsWith('?');
    const coreType = rawType.replace(/\?$/, '');
    const collM = COLLECTION_RE.exec(coreType);

    if (collM) {
      const target = simpleName(collM[1]);
      if (!SCALAR_TYPES.has(target)) {
        entity._navs.push({ kind: 'collection', target, name: propName });
        continue;
      }
    }

    const targetSimple = simpleName(coreType);
    const targetCls = classIndex.get(targetSimple);
    if (!SCALAR_TYPES.has(targetSimple) && targetCls && !targetCls.isEnum) {
      entity._navs.push({ kind: 'reference', target: targetSimple, name: propName, nullable });
      continue;
    }

    // Scalar / enum column
    const isEnum = targetCls?.isEnum === true;
    const col = {
      name: propName,
      columnName: propName,
      clrType: isEnum ? `${targetSimple} (enum)` : coreType + (nullable ? '?' : ''),
      storeType: null,
      isRequired: !nullable && !(coreType === 'string' && !attrs.some((a) => a.name === 'Required')),
      maxLength: null,
      precision: null,
      scale: null,
      valueGenerated: null,
      isIdentity: false,
      isConcurrencyToken: false,
      defaultValue: undefined,
      defaultValueSql: null,
      computedSql: null,
      comment: null,
      isUnicode: null,
    };
    for (const a of attrs) {
      if (a.name === 'Required') col.isRequired = true;
      else if (a.name === 'Key') entity.primaryKey.push(propName);
      else if (a.name === 'MaxLength' || a.name === 'StringLength') col.maxLength = parseInt(a.args, 10) || null;
      else if (a.name === 'Timestamp') {
        col.isConcurrencyToken = true;
        col.valueGenerated = 'OnAddOrUpdate';
      } else if (a.name === 'ConcurrencyCheck') col.isConcurrencyToken = true;
      else if (a.name === 'Column') {
        const nameArg = /^"([^"]+)"/.exec(a.args);
        if (nameArg) col.columnName = nameArg[1];
        const typeArg = /TypeName\s*=\s*"([^"]+)"/.exec(a.args);
        if (typeArg) col.storeType = typeArg[1];
      } else if (a.name === 'DatabaseGenerated') {
        if (a.args.includes('Identity')) col.valueGenerated = 'OnAdd';
        else if (a.args.includes('Computed')) col.valueGenerated = 'OnAddOrUpdate';
        else if (a.args.includes('None')) col.valueGenerated = 'Never';
      } else if (a.name === 'ForeignKey') {
        col._fkNav = unq(a.args);
      }
    }
    entity.columns.push(col);
  }

  // Convention PK: Id or <ClassName>Id
  if (entity.primaryKey.length === 0) {
    const pk = entity.columns.find((c) => c.name === 'Id') ?? entity.columns.find((c) => c.name === `${cls.name}Id`);
    if (pk) {
      entity.primaryKey = [pk.name];
      if (/^(int|long|Guid)/.test(pk.clrType ?? '')) pk.valueGenerated = 'OnAdd';
    }
  }
  return entity;
}

function resolveNavigations(entity, included, model) {
  for (const nav of entity._navs) {
    const target = included.get(nav.target);
    if (!target || target._isOwnedClass) continue;

    if (nav.kind === 'reference') {
      // FK by convention: <NavName>Id or <TargetName>Id, or [ForeignKey] pointer.
      const fkCol =
        entity.columns.find((c) => c._fkNav === nav.name) ??
        entity.columns.find((c) => c.name === `${nav.name}Id`) ??
        entity.columns.find((c) => c.name === `${nav.target}Id`);
      const inverse = target._navs.find((n) => n.kind === 'collection' && n.target === entity.name);
      const inverseOne = target._navs.find((n) => n.kind === 'reference' && n.target === entity.name);
      if (!fkCol && inverseOne && !inverse) {
        // Reference on both sides with FK on the other side → let that side emit it.
        const otherHasFk = target.columns.some(
          (c) => c.name === `${inverseOne.name}Id` || c.name === `${entity.name}Id` || c._fkNav === inverseOne.name
        );
        if (otherHasFk) continue;
      }
      const already = model.relationships.some(
        (r) => r.dependent === entity.fullName && r.principal === target.fullName && r.navigation === nav.name
      );
      if (already) continue;
      model.relationships.push({
        dependent: entity.fullName,
        principal: target.fullName,
        navigation: nav.name,
        inverseNavigation: inverse?.name ?? inverseOne?.name ?? null,
        foreignKey: fkCol ? [fkCol.name] : [],
        principalKey: [],
        type: inverseOne && !inverse ? 'one-to-one' : 'many-to-one',
        onDelete: fkCol && fkCol.isRequired ? 'Cascade' : fkCol ? 'ClientSetNull' : null,
        isRequired: fkCol ? fkCol.isRequired : !nav.nullable,
        inferred: true,
      });
    } else if (nav.kind === 'collection') {
      // Collection on both sides with no explicit join entity → implicit many-to-many.
      const inverseColl = target._navs.find((n) => n.kind === 'collection' && n.target === entity.name);
      if (inverseColl && entity.name.localeCompare(target.name) < 0) {
        model.relationships.push({
          dependent: entity.fullName,
          principal: target.fullName,
          navigation: nav.name,
          inverseNavigation: inverseColl.name,
          foreignKey: [],
          principalKey: [],
          type: 'many-to-many',
          onDelete: null,
          isRequired: true,
          inferred: true,
        });
      }
      // one-to-many is emitted from the dependent (reference) side.
    }
  }
}

function foldOwnedTypes(entity, included, model, classIndex) {
  for (const nav of entity._navs) {
    if (nav.kind !== 'reference') continue;
    const targetCls = classIndex.get(nav.target);
    if (!targetCls || !targetCls.attributes?.some((a) => a.name === 'Owned')) continue;
    const target = included.get(nav.target);
    if (!target) continue;
    target._removed = true;
    const folded = [];
    for (const col of target.columns) {
      const clone = { ...col };
      clone.name = `${nav.name}.${col.name}`;
      clone.columnName = `${nav.name}_${col.columnName}`;
      clone.owned = true;
      folded.push(clone.columnName);
      entity.columns.push(clone);
    }
    entity.ownedTypes.push({ type: target.fullName, navigation: nav.name, kind: 'one', inline: true, columns: folded });
    // Drop any relationships that were resolved against the owned type.
    model.relationships = model.relationships.filter(
      (r) => r.dependent !== target.fullName && r.principal !== target.fullName
    );
  }
}

function cleanupScratch(e) {
  delete e._navs;
  delete e._baseClass;
  delete e._isOwnedClass;
  delete e._removed;
  for (const c of e.columns) delete c._fkNav;
}

function unq(s) {
  const m = /"([^"]*)"/.exec(s);
  return m ? m[1] : s.trim();
}

/** Naive English pluralizer, mirroring EF's default DbSet-style table naming. */
export function pluralize(name) {
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + 'es';
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  return name + 's';
}
