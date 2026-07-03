/**
 * Parses EF Core generated model code: migration `*.Designer.cs` files
 * (BuildTargetModel) and `*ModelSnapshot.cs` files (BuildModel).
 *
 * These files are machine-generated fluent builder code with a fixed shape,
 * which makes them a precise, compile-free source of truth for the entire
 * model — one full snapshot per migration.
 */

import {
  stripComments,
  findMatching,
  splitTopLevel,
  parseChain,
  lambdaBody,
  unquote,
  literalValue,
  simpleName,
} from './csharp.js';

/**
 * Parse the body of a BuildModel/BuildTargetModel method (or a whole designer
 * file) into a normalized model object.
 */
export function parseSnapshotModel(code) {
  const clean = stripComments(code);
  const model = {
    productVersion: null,
    annotations: {},
    entities: [],
    relationships: [],
  };
  const byName = new Map();

  const getEntity = (fqn) => {
    let e = byName.get(fqn);
    if (!e) {
      e = {
        name: simpleName(fqn),
        fullName: fqn,
        table: simpleName(fqn),
        schema: null,
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
      };
      byName.set(fqn, e);
      model.entities.push(e);
    }
    return e;
  };

  // Top-level model annotations: modelBuilder.HasAnnotation("ProductVersion", ...)
  for (const m of clean.matchAll(/\.HasAnnotation\(\s*"([^"]+)"\s*,\s*("(?:[^"\\]|\\.)*"|[^)]+)\)/g)) {
    // Only record the modelBuilder-level ones that appear before the first Entity( block.
    const firstEntity = clean.indexOf('.Entity(');
    if (firstEntity !== -1 && m.index < firstEntity) {
      const value = literalValue(m[2]);
      model.annotations[m[1]] = value;
      if (m[1] === 'ProductVersion') model.productVersion = value;
    }
  }

  // Walk every `modelBuilder.Entity("FQN", b => { ... })` block. Blocks may
  // appear multiple times for the same entity (properties, relationships,
  // navigations) — they all merge into one entity record.
  const re = /modelBuilder\s*\.\s*Entity\(/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const openParen = clean.indexOf('(', m.index + m[0].length - 1);
    const closeParen = findMatching(clean, openParen);
    if (closeParen === -1) continue;
    const argsRaw = clean.slice(openParen + 1, closeParen);
    const args = splitTopLevel(argsRaw, ',').map((a) => a.trim());
    if (args.length < 2) continue; // e.g. modelBuilder.Entity("X").HasNoKey() — rare, skip
    const fqn = unquote(args[0]);
    const body = lambdaBody(args.slice(1).join(','));
    if (body == null) continue;
    parseEntityBody(model, getEntity(fqn), body, getEntity);
    re.lastIndex = closeParen;
  }

  finalizeModel(model);
  return model;
}

function parseEntityBody(model, entity, body, getEntity, builderVar) {
  const statements = splitTopLevel(body, ';');
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    // Wrapped provider calls, e.g.
    //   SqlServerPropertyBuilderExtensions.UseIdentityColumn(b.Property<int>("Id"));
    //   NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(...)
    const wrap = /^\w*PropertyBuilderExtensions\s*\.\s*Use\w*(?:IdentityColumn|IdentityAlwaysColumn|IdentityByDefaultColumn|SerialColumn|HiLo)\w*\s*\(/.exec(trimmed);
    if (wrap) {
      const inner = /\.Property<[^>]+>\(\s*"([^"]+)"\s*\)/.exec(trimmed);
      if (inner) {
        const col = entity.columns.find((c) => c.name === inner[1]);
        if (col) col.isIdentity = true;
      }
      continue;
    }
    if (/^\w+ModelBuilderExtensions\s*\./.test(trimmed)) continue;

    const chain = parseChain(trimmed);
    if (!chain || chain.calls.length === 0) continue;
    applyEntityChain(model, entity, chain, getEntity);
  }
}

function applyEntityChain(model, entity, chain, getEntity) {
  const [head, ...rest] = chain.calls;

  switch (head.name) {
    case 'Property': {
      const col = ensureColumn(entity, unquote(head.args[0] ?? ''), head.generic);
      applyPropertyModifiers(col, rest);
      return;
    }
    case 'PrimitiveCollection': {
      const col = ensureColumn(entity, unquote(head.args[0] ?? ''), head.generic);
      col.isCollection = true;
      applyPropertyModifiers(col, rest);
      return;
    }
    case 'HasKey': {
      entity.primaryKey = head.args.map(unquote);
      for (const k of entity.primaryKey) ensureColumn(entity, k, null);
      return;
    }
    case 'HasAlternateKey': {
      entity.alternateKeys.push(head.args.map(unquote));
      return;
    }
    case 'HasIndex': {
      const index = { columns: head.args.map(unquote).filter((a) => a !== ''), isUnique: false, name: null, filter: null };
      for (const c of rest) {
        if (c.name === 'IsUnique') index.isUnique = c.args.length === 0 || literalValue(c.args[0]) === true;
        else if (c.name === 'HasDatabaseName') index.name = unquote(c.args[0]);
        else if (c.name === 'HasFilter') index.filter = literalValue(c.args[0]);
        else if (c.name === 'IsDescending') index.descending = true;
      }
      entity.indexes.push(index);
      return;
    }
    case 'ToTable': {
      if (head.args.length > 0) {
        const t = literalValue(head.args[0]);
        if (typeof t === 'string') entity.table = t;
        else if (t === null) entity.table = null; // e.g. TPC abstract base / entity splitting
      }
      if (head.args.length > 1) {
        const s = literalValue(head.args[1]);
        if (typeof s === 'string') entity.schema = s;
      }
      return;
    }
    case 'ToView': {
      entity.isView = true;
      if (head.args.length > 0) {
        const v = literalValue(head.args[0]);
        if (typeof v === 'string') entity.table = v;
      }
      return;
    }
    case 'HasBaseType': {
      entity.baseType = unquote(head.args[0]);
      return;
    }
    case 'HasDiscriminator': {
      const disc = { column: head.args.length ? unquote(head.args[0]) : 'Discriminator', values: [] };
      for (const c of rest) {
        if (c.name === 'HasValue' && c.args.length) disc.values.push(literalValue(c.args[c.args.length - 1]));
      }
      entity.discriminator = disc;
      return;
    }
    case 'HasData': {
      entity.seedCount += head.args.length;
      return;
    }
    case 'HasAnnotation': {
      if (head.args.length >= 2) entity.annotations[unquote(head.args[0])] = literalValue(head.args[1]);
      return;
    }
    case 'HasOne': {
      const rel = parseHasOne(entity, head, rest);
      if (rel) model.relationships.push(rel);
      return;
    }
    case 'HasMany': {
      // Rare in generated code (relationship is normally declared from the
      // dependent side), but handle: b.HasMany("Dep","Nav").WithOne("Inv").HasForeignKey("Dep","Col")
      const rel = parseHasMany(entity, head, rest);
      if (rel) model.relationships.push(rel);
      return;
    }
    case 'OwnsOne':
    case 'OwnsMany': {
      parseOwned(model, entity, head, getEntity);
      return;
    }
    case 'Navigation':
    case 'HasQueryFilter':
    case 'UseTphMappingStrategy':
    case 'UseTptMappingStrategy':
    case 'UseTpcMappingStrategy':
      return;
    default:
      return; // Unknown builder call — ignore gracefully.
  }
}

function ensureColumn(entity, name, clrType) {
  let col = entity.columns.find((c) => c.name === name);
  if (!col) {
    col = {
      name,
      columnName: name,
      clrType: clrType ? normalizeClrType(clrType) : null,
      storeType: null,
      isRequired: clrType ? !clrType.endsWith('?') && !isReferenceClr(clrType) : true,
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
    entity.columns.push(col);
  } else if (clrType && !col.clrType) {
    col.clrType = normalizeClrType(clrType);
    col.isRequired = !clrType.endsWith('?') && !isReferenceClr(clrType);
  }
  return col;
}

function isReferenceClr(clrType) {
  const t = clrType.replace(/\?$/, '');
  return t === 'string' || t === 'byte[]' || t === 'object';
}

function normalizeClrType(t) {
  return t.trim();
}

function applyPropertyModifiers(col, calls) {
  for (const c of calls) {
    switch (c.name) {
      case 'IsRequired':
        col.isRequired = c.args.length === 0 || literalValue(c.args[0]) === true;
        break;
      case 'HasMaxLength':
        col.maxLength = literalValue(c.args[0]);
        break;
      case 'HasPrecision':
        col.precision = literalValue(c.args[0]);
        if (c.args.length > 1) col.scale = literalValue(c.args[1]);
        break;
      case 'HasColumnType':
        col.storeType = unquote(c.args[0]);
        break;
      case 'HasColumnName':
        col.columnName = unquote(c.args[0]);
        break;
      case 'ValueGeneratedOnAdd':
        col.valueGenerated = 'OnAdd';
        break;
      case 'ValueGeneratedOnUpdate':
        col.valueGenerated = 'OnUpdate';
        break;
      case 'ValueGeneratedOnAddOrUpdate':
        col.valueGenerated = 'OnAddOrUpdate';
        break;
      case 'ValueGeneratedNever':
        col.valueGenerated = 'Never';
        break;
      case 'HasDefaultValue':
        col.defaultValue = c.args.length ? literalValue(c.args[0]) : null;
        break;
      case 'HasDefaultValueSql':
        col.defaultValueSql = c.args.length ? unquote(c.args[0]) : null;
        break;
      case 'HasComputedColumnSql':
        col.computedSql = c.args.length ? unquote(c.args[0]) : null;
        break;
      case 'IsConcurrencyToken':
        col.isConcurrencyToken = true;
        break;
      case 'IsUnicode':
        col.isUnicode = c.args.length === 0 || literalValue(c.args[0]) === true;
        break;
      case 'HasComment':
        col.comment = unquote(c.args[0]);
        break;
      case 'IsRowVersion':
        col.isConcurrencyToken = true;
        col.valueGenerated = 'OnAddOrUpdate';
        break;
      case 'HasAnnotation':
        break;
      default:
        break;
    }
  }
}

function parseHasOne(dependent, head, rest) {
  const principal = unquote(head.args[0] ?? '');
  if (!principal) return null;
  const navArg = head.args[1];
  const rel = {
    dependent: dependent.fullName,
    principal,
    navigation: navArg && navArg.trim() !== 'null' ? unquote(navArg) : null,
    inverseNavigation: null,
    foreignKey: [],
    principalKey: [],
    type: 'many-to-one',
    onDelete: null,
    isRequired: false,
  };
  for (const c of rest) {
    switch (c.name) {
      case 'WithMany':
        rel.type = 'many-to-one';
        if (c.args.length && c.args[0].trim() !== 'null') rel.inverseNavigation = unquote(c.args[0]);
        break;
      case 'WithOne':
        rel.type = 'one-to-one';
        if (c.args.length && c.args[0].trim() !== 'null') rel.inverseNavigation = unquote(c.args[0]);
        break;
      case 'HasForeignKey':
        // one-to-one form: HasForeignKey("DependentFQN", "Col", ...)
        if (rel.type === 'one-to-one' && c.args.length > 1 && /^"[\w.+]+"$/.test(c.args[0].trim()) && unquote(c.args[0]).includes('.')) {
          const owner = unquote(c.args[0]);
          rel.foreignKey = c.args.slice(1).map(unquote);
          if (owner !== rel.dependent) {
            // FK actually lives on the "principal" side — swap.
            const dep = rel.principal;
            rel.principal = rel.dependent;
            rel.dependent = dep;
            const nav = rel.navigation;
            rel.navigation = rel.inverseNavigation;
            rel.inverseNavigation = nav;
          }
        } else {
          rel.foreignKey = c.args.map(unquote);
        }
        break;
      case 'HasPrincipalKey':
        rel.principalKey = c.args.map(unquote).filter((a) => a.includes('.') === false);
        break;
      case 'OnDelete':
        rel.onDelete = (c.args[0] ?? '').replace(/^DeleteBehavior\./, '').trim() || null;
        break;
      case 'IsRequired':
        rel.isRequired = c.args.length === 0 || literalValue(c.args[0]) === true;
        break;
      default:
        break;
    }
  }
  return rel;
}

function parseHasMany(principalEntity, head, rest) {
  const dependent = unquote(head.args[0] ?? '');
  if (!dependent) return null;
  const rel = {
    dependent,
    principal: principalEntity.fullName,
    navigation: null,
    inverseNavigation: head.args[1] && head.args[1].trim() !== 'null' ? unquote(head.args[1]) : null,
    foreignKey: [],
    principalKey: [],
    type: 'many-to-one',
    onDelete: null,
    isRequired: false,
  };
  for (const c of rest) {
    if (c.name === 'WithOne' && c.args.length && c.args[0].trim() !== 'null') rel.navigation = unquote(c.args[0]);
    else if (c.name === 'HasForeignKey') rel.foreignKey = c.args.map(unquote).filter((a) => !a.includes('.'));
    else if (c.name === 'OnDelete') rel.onDelete = (c.args[0] ?? '').replace(/^DeleteBehavior\./, '').trim() || null;
    else if (c.name === 'IsRequired') rel.isRequired = c.args.length === 0 || literalValue(c.args[0]) === true;
  }
  return rel;
}

/**
 * Owned types (OwnsOne/OwnsMany). When the owned type maps to the owner's
 * table (table splitting — the default for OwnsOne) its properties are folded
 * into the owner as prefixed columns. When it maps to its own table
 * (OwnsMany, or explicit ToTable) it becomes a standalone entity with an
 * ownership relationship.
 */
function parseOwned(model, owner, head, getEntity) {
  const typeFqn = unquote(head.args[0] ?? '');
  const nav = head.args.length > 2 ? unquote(head.args[1]) : (head.args[1] && head.args[1].includes('=>') ? null : unquote(head.args[1] ?? ''));
  const lambdaArg = head.args.find((a) => a.includes('=>'));
  if (!lambdaArg) return;
  const body = lambdaBody(lambdaArg);
  if (body == null) return;

  // Parse the owned block into a scratch entity.
  const scratch = {
    name: simpleName(typeFqn),
    fullName: typeFqn,
    table: null,
    schema: null,
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
  };
  const scratchModel = { relationships: [], entities: [] };
  parseEntityBody(scratchModel, scratch, body, getEntity);

  const isMany = head.name === 'OwnsMany';
  const sharesTable = !isMany && (scratch.table === null || scratch.table === owner.table);

  if (sharesTable) {
    // Table splitting: fold owned columns into the owner, skipping the shadow FK
    // that mirrors the owner's PK.
    const fkCols = new Set(scratch.primaryKey);
    const folded = [];
    for (const col of scratch.columns) {
      if (fkCols.has(col.name) && owner.primaryKey.length) continue;
      const clone = { ...col };
      clone.name = `${nav || scratch.name}.${col.name}`;
      if (clone.columnName === col.name) clone.columnName = `${nav || scratch.name}_${col.name}`;
      clone.owned = true;
      // Owned reference on an existing row is optional at the DB level.
      folded.push(clone);
      owner.columns.push(clone);
    }
    owner.ownedTypes.push({ type: typeFqn, navigation: nav, kind: 'one', inline: true, columns: folded.map((c) => c.columnName) });
  } else {
    const e = getEntity(typeFqn);
    Object.assign(e, scratch, { fullName: typeFqn, name: simpleName(typeFqn) });
    if (!e.table) e.table = simpleName(typeFqn);
    e.isOwned = true;
    owner.ownedTypes.push({ type: typeFqn, navigation: nav, kind: isMany ? 'many' : 'one', inline: false });
    model.relationships.push({
      dependent: typeFqn,
      principal: owner.fullName,
      navigation: null,
      inverseNavigation: nav,
      foreignKey: scratch.primaryKey.slice(0, 1),
      principalKey: [],
      type: isMany ? 'many-to-one' : 'one-to-one',
      onDelete: 'Cascade',
      isRequired: true,
      isOwnership: true,
    });
    // Nested relationships found inside the owned block.
    for (const r of scratchModel.relationships) model.relationships.push(r);
  }
}

/**
 * Post-processing: mark FK columns, detect implicit many-to-many join
 * entities, and derive synthesized many-to-many relationships.
 */
export function finalizeModel(model) {
  const byName = new Map(model.entities.map((e) => [e.fullName, e]));

  for (const rel of model.relationships) {
    const dep = byName.get(rel.dependent);
    if (dep) {
      for (const fk of rel.foreignKey) {
        const col = dep.columns.find((c) => c.name === fk);
        if (col) col.isForeignKey = true;
      }
    }
  }

  // Join-entity detection: EF's implicit many-to-many creates a shared-type
  // entity whose PK is exactly its two FKs and which has no other columns.
  for (const e of model.entities) {
    const rels = model.relationships.filter((r) => r.dependent === e.fullName && !r.isOwnership);
    const fkCols = new Set(rels.flatMap((r) => r.foreignKey));
    const isJoin =
      rels.length === 2 &&
      e.primaryKey.length === 2 &&
      e.primaryKey.every((k) => fkCols.has(k)) &&
      e.columns.every((c) => fkCols.has(c.name)) &&
      !e.baseType;
    if (isJoin) {
      e.isJoinTable = true;
      model.relationships.push({
        dependent: rels[0].principal,
        principal: rels[1].principal,
        navigation: null,
        inverseNavigation: null,
        foreignKey: [],
        principalKey: [],
        type: 'many-to-many',
        onDelete: rels[0].onDelete,
        isRequired: true,
        via: e.fullName,
      });
    }
  }

  // Inheritance edges (TPH/TPT/TPC).
  for (const e of model.entities) {
    if (e.baseType && byName.has(e.baseType)) {
      model.relationships.push({
        dependent: e.fullName,
        principal: e.baseType,
        type: 'inheritance',
        foreignKey: [],
        principalKey: [],
        navigation: null,
        inverseNavigation: null,
        onDelete: null,
        isRequired: true,
      });
    }
  }

  // Stable ordering: entities alphabetically, PK columns first (in key order),
  // then the rest in declaration order.
  model.entities.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of model.entities) {
    const pkIndex = (c) => {
      const i = e.primaryKey.indexOf(c.name);
      return i === -1 ? Infinity : i;
    };
    e.columns.sort((a, b) => pkIndex(a) - pkIndex(b));
    for (const c of e.columns) {
      if (e.primaryKey.includes(c.name)) c.isPrimaryKey = true;
    }
  }
  return model;
}

/** Extract the [Migration("...")] id and class name from a designer file. */
export function parseMigrationMeta(code) {
  const idMatch = /\[Migration\(\s*"([^"]+)"\s*\)\]/.exec(code);
  const ctxMatch = /\[DbContext\(typeof\(([\w.]+)\)\)\]/.exec(code);
  if (!idMatch) return null;
  const id = idMatch[1];
  const underscore = id.indexOf('_');
  const timestampRaw = underscore > 0 ? id.slice(0, underscore) : null;
  return {
    id,
    name: underscore > 0 ? id.slice(underscore + 1) : id,
    timestamp: timestampRaw && /^\d{14}$/.test(timestampRaw) ? formatTimestamp(timestampRaw) : null,
    contextType: ctxMatch ? ctxMatch[1] : null,
  };
}

/** Extract the [DbContext(typeof(X))] context type from a snapshot file. */
export function parseSnapshotMeta(code) {
  const ctxMatch = /\[DbContext\(typeof\(([\w.]+)\)\)\]/.exec(code);
  return { contextType: ctxMatch ? ctxMatch[1] : null };
}

function formatTimestamp(ts) {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
}

/** Guess the database provider from designer file contents. */
export function detectProvider(code) {
  if (code.includes('SqlServer')) return 'SQL Server';
  if (code.includes('Npgsql')) return 'PostgreSQL';
  if (code.includes('Sqlite')) return 'SQLite';
  if (code.includes('MySql') || code.includes('Pomelo')) return 'MySQL';
  if (code.includes('Oracle')) return 'Oracle';
  if (code.includes('Cosmos')) return 'Cosmos DB';
  if (code.includes('InMemory')) return 'InMemory';
  return null;
}
