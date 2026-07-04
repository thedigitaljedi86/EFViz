using System.Text.RegularExpressions;
using static EFViz.CSharpLex;

namespace EFViz;

public sealed record MigrationMeta(string Id, string Name, string? Timestamp, string? ContextType);

/// <summary>
/// Parses EF Core generated model code: migration <c>*.Designer.cs</c> files
/// (BuildTargetModel) and <c>*ModelSnapshot.cs</c> files (BuildModel) into a
/// normalized <see cref="Model"/> — one exact snapshot per migration.
/// </summary>
public static class SnapshotParser
{
    public static Model ParseSnapshotModel(string code)
    {
        var clean = StripComments(code);
        var model = new Model();
        var byName = new Dictionary<string, Entity>();

        Entity GetEntity(string fqn)
        {
            if (!byName.TryGetValue(fqn, out var e))
            {
                e = new Entity { Name = SimpleName(fqn), FullName = fqn, Table = SimpleName(fqn) };
                byName[fqn] = e;
                model.Entities.Add(e);
            }
            return e;
        }

        // Top-level model annotations (before the first Entity block).
        var firstEntity = clean.IndexOf(".Entity(", StringComparison.Ordinal);
        foreach (Match m in Regex.Matches(clean, "\\.HasAnnotation\\(\\s*\"([^\"]+)\"\\s*,\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|[^)]+)\\)"))
        {
            if (firstEntity != -1 && m.Index < firstEntity)
            {
                var value = LiteralValue(m.Groups[2].Value);
                model.Annotations[m.Groups[1].Value] = value;
                if (m.Groups[1].Value == "ProductVersion") model.ProductVersion = value as string;
            }
        }

        // Walk every `modelBuilder.Entity("FQN", b => { ... })` block; blocks for
        // the same entity merge (properties, relationships, navigations).
        var re = new Regex(@"modelBuilder\s*\.\s*Entity\(");
        var pos = 0;
        while (true)
        {
            var m = re.Match(clean, pos);
            if (!m.Success) break;
            var openParen = clean.IndexOf('(', m.Index + m.Length - 1);
            var closeParen = FindMatching(clean, openParen);
            if (closeParen == -1) { pos = m.Index + m.Length; continue; }
            var argsRaw = clean[(openParen + 1)..closeParen];
            var args = SplitTopLevel(argsRaw, ',').Select(a => a.Trim()).ToList();
            pos = closeParen;
            if (args.Count < 2) continue;
            var fqn = Unquote(args[0]);
            var body = LambdaBody(string.Join(",", args.Skip(1)));
            if (body is null) continue;
            ParseEntityBody(model, GetEntity(fqn), body, GetEntity);
        }

        FinalizeModel(model);
        return model;
    }

    private static void ParseEntityBody(Model model, Entity entity, string body, Func<string, Entity> getEntity)
    {
        foreach (var stmt in SplitTopLevel(body, ';'))
        {
            var trimmed = stmt.Trim();
            if (trimmed.Length == 0) continue;

            // Wrapped provider calls, e.g. SqlServerPropertyBuilderExtensions.UseIdentityColumn(b.Property<int>("Id"))
            if (Regex.IsMatch(trimmed, @"^\w*PropertyBuilderExtensions\s*\.\s*Use\w*(?:IdentityColumn|IdentityAlwaysColumn|IdentityByDefaultColumn|SerialColumn|HiLo)\w*\s*\("))
            {
                var inner = Regex.Match(trimmed, "\\.Property<[^>]+>\\(\\s*\"([^\"]+)\"\\s*\\)");
                if (inner.Success)
                {
                    var col = entity.Columns.FirstOrDefault(c => c.Name == inner.Groups[1].Value);
                    if (col is not null) col.IsIdentity = true;
                }
                continue;
            }
            if (Regex.IsMatch(trimmed, @"^\w+ModelBuilderExtensions\s*\.")) continue;

            var chain = ParseChain(trimmed);
            if (chain is null || chain.Calls.Count == 0) continue;
            ApplyEntityChain(model, entity, chain, getEntity);
        }
    }

    private static void ApplyEntityChain(Model model, Entity entity, Chain chain, Func<string, Entity> getEntity)
    {
        var head = chain.Calls[0];
        var rest = chain.Calls.Skip(1).ToList();

        switch (head.Name)
        {
            case "Property":
            {
                var col = EnsureColumn(entity, Unquote(head.Args.ElementAtOrDefault(0) ?? ""), head.Generic);
                ApplyPropertyModifiers(col, rest);
                return;
            }
            case "PrimitiveCollection":
            {
                var col = EnsureColumn(entity, Unquote(head.Args.ElementAtOrDefault(0) ?? ""), head.Generic);
                col.IsCollection = true;
                ApplyPropertyModifiers(col, rest);
                return;
            }
            case "HasKey":
                entity.PrimaryKey = head.Args.Select(Unquote).ToList();
                foreach (var k in entity.PrimaryKey) EnsureColumn(entity, k, null);
                return;
            case "HasAlternateKey":
                entity.AlternateKeys.Add(head.Args.Select(Unquote).ToList());
                return;
            case "HasIndex":
            {
                var index = new Index { Columns = head.Args.Select(Unquote).Where(a => a.Length > 0).ToList() };
                foreach (var c in rest)
                {
                    if (c.Name == "IsUnique") index.IsUnique = c.Args.Count == 0 || Equals(LiteralValue(c.Args[0]), true);
                    else if (c.Name == "HasDatabaseName") index.Name = Unquote(c.Args[0]);
                    else if (c.Name == "HasFilter") index.Filter = LiteralValue(c.Args[0]);
                    else if (c.Name == "IsDescending") index.Descending = true;
                }
                entity.Indexes.Add(index);
                return;
            }
            case "ToTable":
            {
                if (head.Args.Count > 0)
                {
                    var t = LiteralValue(head.Args[0]);
                    if (t is string ts) entity.Table = ts;
                    else if (t is null) entity.Table = null;
                }
                if (head.Args.Count > 1 && LiteralValue(head.Args[1]) is string schema) entity.Schema = schema;
                return;
            }
            case "ToView":
                entity.IsView = true;
                if (head.Args.Count > 0 && LiteralValue(head.Args[0]) is string view) entity.Table = view;
                return;
            case "HasBaseType":
                entity.BaseType = Unquote(head.Args[0]);
                return;
            case "HasDiscriminator":
            {
                var disc = new Discriminator { Column = head.Args.Count > 0 ? Unquote(head.Args[0]) : "Discriminator" };
                foreach (var c in rest)
                {
                    if (c.Name == "HasValue" && c.Args.Count > 0) disc.Values.Add(LiteralValue(c.Args[^1]));
                }
                entity.Disc = disc;
                return;
            }
            case "HasData":
                entity.SeedCount += head.Args.Count;
                return;
            case "HasAnnotation":
                if (head.Args.Count >= 2) entity.Annotations[Unquote(head.Args[0])] = LiteralValue(head.Args[1]);
                return;
            case "HasOne":
            {
                var rel = ParseHasOne(entity, head, rest);
                if (rel is not null) model.Relationships.Add(rel);
                return;
            }
            case "HasMany":
            {
                var rel = ParseHasMany(entity, head, rest);
                if (rel is not null) model.Relationships.Add(rel);
                return;
            }
            case "OwnsOne":
            case "OwnsMany":
                ParseOwned(model, entity, head, getEntity);
                return;
            case "UseTphMappingStrategy":
                entity.MappingStrategy = "TPH";
                return;
            case "UseTptMappingStrategy":
                entity.MappingStrategy = "TPT";
                return;
            case "UseTpcMappingStrategy":
                entity.MappingStrategy = "TPC";
                return;
            default:
                return; // Navigation, HasQueryFilter, unknown calls — ignore gracefully.
        }
    }

    private static Column EnsureColumn(Entity entity, string name, string? clrType)
    {
        var col = entity.Columns.FirstOrDefault(c => c.Name == name);
        if (col is null)
        {
            col = new Column
            {
                Name = name,
                ColumnName = name,
                ClrType = clrType?.Trim(),
                IsRequired = clrType is null || (!clrType.EndsWith('?') && !IsReferenceClr(clrType)),
            };
            entity.Columns.Add(col);
        }
        else if (clrType is not null && col.ClrType is null)
        {
            col.ClrType = clrType.Trim();
            col.IsRequired = !clrType.EndsWith('?') && !IsReferenceClr(clrType);
        }
        return col;
    }

    private static bool IsReferenceClr(string clrType)
    {
        var t = clrType.TrimEnd('?');
        return t is "string" or "byte[]" or "object";
    }

    /// <summary>Canonicalize an inheritance mapping strategy to TPH/TPT/TPC, else null.</summary>
    private static string? NormalizeStrategy(string? v)
    {
        if (v is null) return null;
        var s = v.Trim().ToUpperInvariant();
        return s is "TPH" or "TPT" or "TPC" ? s : null;
    }

    private static void ApplyPropertyModifiers(Column col, List<Call> calls)
    {
        foreach (var c in calls)
        {
            switch (c.Name)
            {
                case "IsRequired":
                    col.IsRequired = c.Args.Count == 0 || Equals(LiteralValue(c.Args[0]), true);
                    break;
                case "HasMaxLength":
                    col.MaxLength = LiteralValue(c.Args[0]) as double?;
                    break;
                case "HasPrecision":
                    col.Precision = LiteralValue(c.Args[0]) as double?;
                    if (c.Args.Count > 1) col.Scale = LiteralValue(c.Args[1]) as double?;
                    break;
                case "HasColumnType":
                    col.StoreType = Unquote(c.Args[0]);
                    break;
                case "HasColumnName":
                    col.ColumnName = Unquote(c.Args[0]);
                    break;
                case "ValueGeneratedOnAdd":
                    col.ValueGenerated = "OnAdd";
                    break;
                case "ValueGeneratedOnUpdate":
                    col.ValueGenerated = "OnUpdate";
                    break;
                case "ValueGeneratedOnAddOrUpdate":
                    col.ValueGenerated = "OnAddOrUpdate";
                    break;
                case "ValueGeneratedNever":
                    col.ValueGenerated = "Never";
                    break;
                case "HasDefaultValue":
                    col.DefaultValueSet = true;
                    col.DefaultValue = c.Args.Count > 0 ? LiteralValue(c.Args[0]) : null;
                    break;
                case "HasDefaultValueSql":
                    col.DefaultValueSql = c.Args.Count > 0 ? Unquote(c.Args[0]) : null;
                    break;
                case "HasComputedColumnSql":
                    col.ComputedSql = c.Args.Count > 0 ? Unquote(c.Args[0]) : null;
                    break;
                case "IsConcurrencyToken":
                    col.IsConcurrencyToken = true;
                    break;
                case "IsUnicode":
                    col.IsUnicode = c.Args.Count == 0 || Equals(LiteralValue(c.Args[0]), true);
                    break;
                case "HasComment":
                    col.Comment = Unquote(c.Args[0]);
                    break;
                case "IsRowVersion":
                    col.IsConcurrencyToken = true;
                    col.ValueGenerated = "OnAddOrUpdate";
                    break;
            }
        }
    }

    private static Relationship? ParseHasOne(Entity dependent, Call head, List<Call> rest)
    {
        var principal = Unquote(head.Args.ElementAtOrDefault(0) ?? "");
        if (principal.Length == 0) return null;
        var navArg = head.Args.ElementAtOrDefault(1);
        var rel = new Relationship
        {
            Dependent = dependent.FullName,
            Principal = principal,
            Navigation = navArg is not null && navArg.Trim() != "null" ? Unquote(navArg) : null,
        };
        foreach (var c in rest)
        {
            switch (c.Name)
            {
                case "WithMany":
                    rel.Type = "many-to-one";
                    if (c.Args.Count > 0 && c.Args[0].Trim() != "null") rel.InverseNavigation = Unquote(c.Args[0]);
                    break;
                case "WithOne":
                    rel.Type = "one-to-one";
                    if (c.Args.Count > 0 && c.Args[0].Trim() != "null") rel.InverseNavigation = Unquote(c.Args[0]);
                    break;
                case "HasForeignKey":
                    // one-to-one form: HasForeignKey("DependentFQN", "Col", ...)
                    if (rel.Type == "one-to-one" && c.Args.Count > 1 &&
                        Regex.IsMatch(c.Args[0].Trim(), "^\"[\\w.+]+\"$") && Unquote(c.Args[0]).Contains('.'))
                    {
                        var owner = Unquote(c.Args[0]);
                        rel.ForeignKey = c.Args.Skip(1).Select(Unquote).ToList();
                        if (owner != rel.Dependent)
                        {
                            (rel.Principal, rel.Dependent) = (rel.Dependent, rel.Principal);
                            (rel.Navigation, rel.InverseNavigation) = (rel.InverseNavigation, rel.Navigation);
                        }
                    }
                    else
                    {
                        rel.ForeignKey = c.Args.Select(Unquote).ToList();
                    }
                    break;
                case "HasPrincipalKey":
                    rel.PrincipalKey = c.Args.Select(Unquote).Where(a => !a.Contains('.')).ToList();
                    break;
                case "OnDelete":
                {
                    var del = (c.Args.ElementAtOrDefault(0) ?? "").Replace("DeleteBehavior.", "").Trim();
                    rel.OnDelete = del.Length > 0 ? del : null;
                    break;
                }
                case "IsRequired":
                    rel.IsRequired = c.Args.Count == 0 || Equals(LiteralValue(c.Args[0]), true);
                    break;
            }
        }
        return rel;
    }

    private static Relationship? ParseHasMany(Entity principalEntity, Call head, List<Call> rest)
    {
        var dependent = Unquote(head.Args.ElementAtOrDefault(0) ?? "");
        if (dependent.Length == 0) return null;
        var invArg = head.Args.ElementAtOrDefault(1);
        var rel = new Relationship
        {
            Dependent = dependent,
            Principal = principalEntity.FullName,
            InverseNavigation = invArg is not null && invArg.Trim() != "null" ? Unquote(invArg) : null,
        };
        foreach (var c in rest)
        {
            if (c.Name == "WithOne" && c.Args.Count > 0 && c.Args[0].Trim() != "null") rel.Navigation = Unquote(c.Args[0]);
            else if (c.Name == "HasForeignKey") rel.ForeignKey = c.Args.Select(Unquote).Where(a => !a.Contains('.')).ToList();
            else if (c.Name == "OnDelete")
            {
                var del = (c.Args.ElementAtOrDefault(0) ?? "").Replace("DeleteBehavior.", "").Trim();
                rel.OnDelete = del.Length > 0 ? del : null;
            }
            else if (c.Name == "IsRequired") rel.IsRequired = c.Args.Count == 0 || Equals(LiteralValue(c.Args[0]), true);
        }
        return rel;
    }

    /// <summary>
    /// Owned types: table splitting (default OwnsOne) folds the owned properties
    /// into the owner as prefixed columns; a separate table becomes a standalone
    /// entity with an ownership relationship.
    /// </summary>
    private static void ParseOwned(Model model, Entity owner, Call head, Func<string, Entity> getEntity)
    {
        var typeFqn = Unquote(head.Args.ElementAtOrDefault(0) ?? "");
        string? nav = head.Args.Count > 2
            ? Unquote(head.Args[1])
            : head.Args.ElementAtOrDefault(1)?.Contains("=>") == true ? null : Unquote(head.Args.ElementAtOrDefault(1) ?? "");
        var lambdaArg = head.Args.FirstOrDefault(a => a.Contains("=>"));
        if (lambdaArg is null) return;
        var body = LambdaBody(lambdaArg);
        if (body is null) return;

        var scratch = new Entity { Name = SimpleName(typeFqn), FullName = typeFqn, Table = null };
        var scratchModel = new Model();
        ParseEntityBody(scratchModel, scratch, body, getEntity);

        var isMany = head.Name == "OwnsMany";
        var sharesTable = !isMany && (scratch.Table is null || scratch.Table == owner.Table);

        if (sharesTable)
        {
            var fkCols = scratch.PrimaryKey.ToHashSet();
            var folded = new List<string>();
            foreach (var col in scratch.Columns)
            {
                if (fkCols.Contains(col.Name) && owner.PrimaryKey.Count > 0) continue;
                var clone = col.Clone();
                var prefix = nav ?? scratch.Name;
                clone.Name = $"{prefix}.{col.Name}";
                if (clone.ColumnName == col.Name) clone.ColumnName = $"{prefix}_{col.Name}";
                clone.Owned = true;
                folded.Add(clone.ColumnName);
                owner.Columns.Add(clone);
            }
            owner.OwnedTypes.Add(new OwnedType { Type = typeFqn, Navigation = nav, Kind = "one", Inline = true, Columns = folded });
        }
        else
        {
            var e = getEntity(typeFqn);
            e.Name = SimpleName(typeFqn);
            e.FullName = typeFqn;
            e.Table = scratch.Table ?? SimpleName(typeFqn);
            e.Schema = scratch.Schema;
            e.Columns = scratch.Columns;
            e.PrimaryKey = scratch.PrimaryKey;
            e.AlternateKeys = scratch.AlternateKeys;
            e.Indexes = scratch.Indexes;
            e.SeedCount = scratch.SeedCount;
            e.Annotations = scratch.Annotations;
            e.IsOwned = true;
            owner.OwnedTypes.Add(new OwnedType { Type = typeFqn, Navigation = nav, Kind = isMany ? "many" : "one", Inline = false });
            model.Relationships.Add(new Relationship
            {
                Dependent = typeFqn,
                Principal = owner.FullName,
                ForeignKey = scratch.PrimaryKey.Take(1).ToList(),
                Type = isMany ? "many-to-one" : "one-to-one",
                OnDelete = "Cascade",
                IsRequired = true,
                IsOwnership = true,
            });
            foreach (var r in scratchModel.Relationships) model.Relationships.Add(r);
        }
    }

    /// <summary>
    /// Post-processing shared by both parsers: FK flags, implicit many-to-many
    /// join detection, inheritance edges, stable ordering, PK flags.
    /// </summary>
    public static void FinalizeModel(Model model)
    {
        var byName = model.Entities.ToDictionary(e => e.FullName);

        foreach (var rel in model.Relationships)
        {
            if (byName.TryGetValue(rel.Dependent, out var dep))
            {
                foreach (var fk in rel.ForeignKey)
                {
                    var col = dep.Columns.FirstOrDefault(c => c.Name == fk);
                    if (col is not null) col.IsForeignKey = true;
                }
            }
        }

        foreach (var e in model.Entities)
        {
            var rels = model.Relationships.Where(r => r.Dependent == e.FullName && r.IsOwnership != true).ToList();
            var fkCols = rels.SelectMany(r => r.ForeignKey).ToHashSet();
            var isJoin =
                rels.Count == 2 &&
                e.PrimaryKey.Count == 2 &&
                e.PrimaryKey.All(fkCols.Contains) &&
                e.Columns.All(c => fkCols.Contains(c.Name)) &&
                e.BaseType is null;
            if (isJoin)
            {
                e.IsJoinTable = true;
                model.Relationships.Add(new Relationship
                {
                    Dependent = rels[0].Principal,
                    Principal = rels[1].Principal,
                    Type = "many-to-many",
                    OnDelete = rels[0].OnDelete,
                    IsRequired = true,
                    Via = e.FullName,
                });
            }
        }

        // Resolve the inheritance mapping strategy (TPH default / TPT / TPC) for
        // every entity in a hierarchy. It is declared once on the root entity and
        // applies to the whole hierarchy, so propagate it down to derived types.
        static string? ExplicitStrategy(Entity e)
        {
            var s = NormalizeStrategy(e.MappingStrategy);
            if (s is not null) return s;
            return e.Annotations.TryGetValue("Relational:MappingStrategy", out var v)
                ? NormalizeStrategy(v as string)
                : null;
        }
        var baseTypes = model.Entities.Where(e => e.BaseType is not null).Select(e => e.BaseType!).ToHashSet();
        foreach (var e in model.Entities)
        {
            var isDerived = e.BaseType is not null && byName.ContainsKey(e.BaseType);
            if (!isDerived && !baseTypes.Contains(e.FullName)) continue;
            string? strategy = null;
            var cur = e;
            for (var guard = 0; cur is not null && guard < 100; guard++)
            {
                var s = ExplicitStrategy(cur);
                if (s is not null) strategy = s;
                cur = cur.BaseType is not null && byName.TryGetValue(cur.BaseType, out var parent) ? parent : null;
            }
            e.MappingStrategy = strategy ?? "TPH";
        }

        foreach (var e in model.Entities)
        {
            if (e.BaseType is not null && byName.ContainsKey(e.BaseType))
            {
                model.Relationships.Add(new Relationship
                {
                    Dependent = e.FullName,
                    Principal = e.BaseType,
                    Type = "inheritance",
                    IsRequired = true,
                });
            }
        }

        model.Entities.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        foreach (var e in model.Entities)
        {
            int PkIndex(Column c)
            {
                var i = e.PrimaryKey.IndexOf(c.Name);
                return i == -1 ? int.MaxValue : i;
            }
            e.Columns = e.Columns.OrderBy(PkIndex).ToList();
            foreach (var c in e.Columns)
            {
                if (e.PrimaryKey.Contains(c.Name)) c.IsPrimaryKey = true;
            }
        }
    }

    /// <summary>Extract the [Migration("…")] id, name, timestamp and context type from a designer file.</summary>
    public static MigrationMeta? ParseMigrationMeta(string code)
    {
        var idMatch = Regex.Match(code, "\\[Migration\\(\\s*\"([^\"]+)\"\\s*\\)\\]");
        if (!idMatch.Success) return null;
        var ctxMatch = Regex.Match(code, @"\[DbContext\(typeof\(([\w.]+)\)\)\]");
        var id = idMatch.Groups[1].Value;
        var underscore = id.IndexOf('_');
        var timestampRaw = underscore > 0 ? id[..underscore] : null;
        return new MigrationMeta(
            id,
            underscore > 0 ? id[(underscore + 1)..] : id,
            timestampRaw is not null && Regex.IsMatch(timestampRaw, @"^\d{14}$") ? FormatTimestamp(timestampRaw) : null,
            ctxMatch.Success ? ctxMatch.Groups[1].Value : null);
    }

    private static string FormatTimestamp(string ts) =>
        $"{ts[..4]}-{ts[4..6]}-{ts[6..8]}T{ts[8..10]}:{ts[10..12]}:{ts[12..14]}";

    /// <summary>Guess the database provider from designer file contents.</summary>
    public static string? DetectProvider(string code)
    {
        if (code.Contains("SqlServer")) return "SQL Server";
        if (code.Contains("Npgsql")) return "PostgreSQL";
        if (code.Contains("Sqlite")) return "SQLite";
        if (code.Contains("MySql") || code.Contains("Pomelo")) return "MySQL";
        if (code.Contains("Oracle")) return "Oracle";
        if (code.Contains("Cosmos")) return "Cosmos DB";
        if (code.Contains("InMemory")) return "InMemory";
        return null;
    }
}
