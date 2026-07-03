using System.Text.RegularExpressions;
using static AutoEntityDiagram.CSharpLex;

namespace AutoEntityDiagram;

/// <summary>
/// Fallback model builder for projects WITHOUT migrations: reconstructs a
/// best-effort model from entity POCOs referenced by a DbContext's DbSet&lt;&gt;
/// properties, using EF Core conventions and data annotations.
/// </summary>
public static class SourceParser
{
    private static readonly HashSet<string> ScalarTypes = new(StringComparer.Ordinal)
    {
        "int", "long", "short", "byte", "uint", "ulong", "ushort", "sbyte",
        "bool", "string", "decimal", "double", "float", "char", "object",
        "Guid", "DateTime", "DateTimeOffset", "DateOnly", "TimeOnly", "TimeSpan",
        "byte[]", "Int32", "Int64", "Boolean", "String", "Decimal", "Double", "Single",
    };

    private static readonly Regex CollectionRe = new(
        @"^(?:System\.Collections\.Generic\.)?(?:ICollection|IList|List|IEnumerable|HashSet|ISet|IReadOnlyCollection|IReadOnlyList|ObservableCollection)<(.+)>$");

    private static readonly Regex ClassRe = new(
        @"(\[[^\]]*\]\s*)*(?:public|internal)?\s*(?:sealed\s+|abstract\s+|partial\s+)*(class|record)\s+(\w+)(?:\s*:\s*([^{\n]+))?\s*\{");

    private static readonly Regex EnumRe = new(@"(?:public|internal)?\s*enum\s+(\w+)");

    private static readonly Regex PropRe = new(
        @"(\[[^\]]*\][\s\r\n]*)*public\s+(?:virtual\s+)?([\w.<>\[\]?,\s]+?)\s+(\w+)\s*\{[^}]*?(?:get|init)");

    private static readonly Regex AttrRe = new(@"\[([\w]+)(?:\(([^)]*)\))?\]");

    public sealed record Attr(string Name, string Args);

    public sealed class ClassInfo
    {
        public required string Name { get; init; }
        public string? Namespace { get; init; }
        public string Body { get; init; } = "";
        public List<Attr> Attributes { get; init; } = new();
        public string? BaseClass { get; init; }
        public bool IsEnum { get; init; }
    }

    private sealed record Nav(string Kind, string Target, string Name, bool Nullable);

    private sealed class WorkEntity
    {
        public required Entity Entity { get; init; }
        public List<Nav> Navs { get; } = new();
        public string? BaseClass { get; set; }
        public bool IsOwnedClass { get; set; }
        public bool Removed { get; set; }
        public Dictionary<string, string> FkNavByColumn { get; } = new();
    }

    public static Model BuildModelFromSource(DiscoveredContext context, IReadOnlyList<string> csFiles)
    {
        var classIndex = IndexClasses(csFiles);
        var model = new Model();
        var included = new Dictionary<string, WorkEntity?>();
        var work = new List<WorkEntity>();
        var queue = new Queue<string>();

        foreach (var ds in context.DbSets)
        {
            var t = SimpleName(ds.EntityType);
            if (!included.ContainsKey(t))
            {
                queue.Enqueue(t);
                included[t] = null;
            }
        }

        var dbSetNames = new Dictionary<string, string>();
        foreach (var ds in context.DbSets) dbSetNames.TryAdd(SimpleName(ds.EntityType), ds.PropertyName);

        while (queue.Count > 0)
        {
            var typeName = queue.Dequeue();
            if (!classIndex.TryGetValue(typeName, out var cls) || cls.IsEnum)
            {
                included.Remove(typeName);
                continue;
            }
            var we = ParseEntityClass(cls, classIndex);
            if (dbSetNames.TryGetValue(typeName, out var setName) && !cls.Attributes.Any(a => a.Name == "Table"))
                we.Entity.Table = setName;
            included[typeName] = we;
            work.Add(we);
            model.Entities.Add(we.Entity);

            foreach (var nav in we.Navs)
            {
                if (!included.ContainsKey(nav.Target) && classIndex.ContainsKey(nav.Target))
                {
                    included[nav.Target] = null;
                    queue.Enqueue(nav.Target);
                }
            }
            if (we.BaseClass is not null && classIndex.ContainsKey(we.BaseClass) && !included.ContainsKey(we.BaseClass))
            {
                included[we.BaseClass] = null;
                queue.Enqueue(we.BaseClass);
            }
        }

        foreach (var we in work) ResolveNavigations(we, included, model);
        foreach (var we in work.ToList()) FoldOwnedTypes(we, included, model, classIndex);
        model.Entities = model.Entities.Where(e => !work.First(w => w.Entity == e).Removed).ToList();

        foreach (var we in work)
        {
            if (we.Removed) continue;
            if (we.BaseClass is not null && included.TryGetValue(we.BaseClass, out var baseWe) && baseWe is not null && !baseWe.Removed)
                we.Entity.BaseType = baseWe.Entity.FullName;
        }

        SnapshotParser.FinalizeModel(model);
        return model;
    }

    public static Dictionary<string, ClassInfo> IndexClasses(IReadOnlyList<string> csFiles)
    {
        var index = new Dictionary<string, ClassInfo>(StringComparer.Ordinal);
        foreach (var file in csFiles)
        {
            string code;
            try
            {
                code = File.ReadAllText(file);
            }
            catch
            {
                continue;
            }
            if (!Regex.IsMatch(code, @"\b(class|record)\s+\w+")) continue;
            var clean = StripComments(code);
            var nsMatch = Regex.Match(clean, @"namespace\s+([\w.]+)");

            foreach (Match m in ClassRe.Matches(clean))
            {
                var name = m.Groups[3].Value;
                if (index.ContainsKey(name)) continue; // first declaration wins
                var bodyStart = clean.IndexOf('{', m.Index + m.Length - 1);
                var bodyEnd = FindMatching(clean, bodyStart);
                if (bodyEnd == -1) continue;
                var attrs = CollectAttributes(m.Value);
                var bases = m.Groups[4].Value.Split(',')
                    .Select(s => s.Trim())
                    .Where(s => s.Length > 0)
                    .ToList();
                var baseClass = bases.FirstOrDefault(b => !b.StartsWith('I') || Regex.IsMatch(b, "^[A-Z][a-z]"));
                if (baseClass is not null)
                {
                    baseClass = SimpleName(baseClass.Split('<')[0]);
                    if (ScalarTypes.Contains(baseClass)) baseClass = null;
                }
                index[name] = new ClassInfo
                {
                    Name = name,
                    Namespace = nsMatch.Success ? nsMatch.Groups[1].Value : null,
                    Body = clean[(bodyStart + 1)..bodyEnd],
                    Attributes = attrs,
                    BaseClass = baseClass,
                };
            }
            foreach (Match m in EnumRe.Matches(clean))
            {
                index.TryAdd(m.Groups[1].Value, new ClassInfo { Name = m.Groups[1].Value, IsEnum = true });
            }
        }
        return index;
    }

    private static List<Attr> CollectAttributes(string text) =>
        AttrRe.Matches(text).Select(m => new Attr(m.Groups[1].Value, m.Groups[2].Value)).ToList();

    private static WorkEntity ParseEntityClass(ClassInfo cls, Dictionary<string, ClassInfo> classIndex)
    {
        var fullName = cls.Namespace is not null ? $"{cls.Namespace}.{cls.Name}" : cls.Name;
        var tableAttr = cls.Attributes.FirstOrDefault(a => a.Name == "Table");
        var schemaMatch = tableAttr is not null ? Regex.Match(tableAttr.Args, "Schema\\s*=\\s*\"([^\"]+)\"") : null;
        var entity = new Entity
        {
            Name = cls.Name,
            FullName = fullName,
            Table = tableAttr is not null ? UnqAttr(tableAttr.Args.Split(',')[0]) : Pluralize(cls.Name),
            Schema = schemaMatch is { Success: true } ? schemaMatch.Groups[1].Value : null,
        };
        var we = new WorkEntity
        {
            Entity = entity,
            BaseClass = cls.BaseClass,
            IsOwnedClass = cls.Attributes.Any(a => a.Name == "Owned"),
        };

        foreach (Match m in PropRe.Matches(cls.Body))
        {
            var rawType = m.Groups[2].Value.Trim();
            var propName = m.Groups[3].Value;
            if (rawType is "class" or "enum") continue;
            var attrs = CollectAttributes(m.Value);
            if (attrs.Any(a => a.Name == "NotMapped")) continue;

            var nullable = rawType.EndsWith('?');
            var coreType = rawType.TrimEnd('?');
            var collM = CollectionRe.Match(coreType);

            if (collM.Success)
            {
                var target = SimpleName(collM.Groups[1].Value);
                if (!ScalarTypes.Contains(target))
                {
                    we.Navs.Add(new Nav("collection", target, propName, nullable));
                    continue;
                }
            }

            var targetSimple = SimpleName(coreType);
            classIndex.TryGetValue(targetSimple, out var targetCls);
            if (!ScalarTypes.Contains(targetSimple) && targetCls is not null && !targetCls.IsEnum)
            {
                we.Navs.Add(new Nav("reference", targetSimple, propName, nullable));
                continue;
            }

            var isEnum = targetCls?.IsEnum == true;
            var col = new Column
            {
                Name = propName,
                ColumnName = propName,
                ClrType = isEnum ? $"{targetSimple} (enum)" : coreType + (nullable ? "?" : ""),
                IsRequired = !nullable && !(coreType == "string" && !attrs.Any(a => a.Name == "Required")),
            };
            foreach (var a in attrs)
            {
                switch (a.Name)
                {
                    case "Required":
                        col.IsRequired = true;
                        break;
                    case "Key":
                        entity.PrimaryKey.Add(propName);
                        break;
                    case "MaxLength":
                    case "StringLength":
                        col.MaxLength = int.TryParse(Regex.Match(a.Args, @"\d+").Value, out var len) ? len : null;
                        break;
                    case "Timestamp":
                        col.IsConcurrencyToken = true;
                        col.ValueGenerated = "OnAddOrUpdate";
                        break;
                    case "ConcurrencyCheck":
                        col.IsConcurrencyToken = true;
                        break;
                    case "Column":
                    {
                        var nameArg = Regex.Match(a.Args, "^\"([^\"]+)\"");
                        if (nameArg.Success) col.ColumnName = nameArg.Groups[1].Value;
                        var typeArg = Regex.Match(a.Args, "TypeName\\s*=\\s*\"([^\"]+)\"");
                        if (typeArg.Success) col.StoreType = typeArg.Groups[1].Value;
                        break;
                    }
                    case "DatabaseGenerated":
                        if (a.Args.Contains("Identity")) col.ValueGenerated = "OnAdd";
                        else if (a.Args.Contains("Computed")) col.ValueGenerated = "OnAddOrUpdate";
                        else if (a.Args.Contains("None")) col.ValueGenerated = "Never";
                        break;
                    case "ForeignKey":
                        we.FkNavByColumn[propName] = UnqAttr(a.Args);
                        break;
                }
            }
            entity.Columns.Add(col);
        }

        // Convention PK: Id or <ClassName>Id
        if (entity.PrimaryKey.Count == 0)
        {
            var pk = entity.Columns.FirstOrDefault(c => c.Name == "Id")
                     ?? entity.Columns.FirstOrDefault(c => c.Name == $"{cls.Name}Id");
            if (pk is not null)
            {
                entity.PrimaryKey.Add(pk.Name);
                if (Regex.IsMatch(pk.ClrType ?? "", "^(int|long|Guid)")) pk.ValueGenerated = "OnAdd";
            }
        }
        return we;
    }

    private static void ResolveNavigations(WorkEntity we, Dictionary<string, WorkEntity?> included, Model model)
    {
        var entity = we.Entity;
        foreach (var nav in we.Navs)
        {
            if (!included.TryGetValue(nav.Target, out var targetWe) || targetWe is null || targetWe.IsOwnedClass) continue;
            var target = targetWe.Entity;

            if (nav.Kind == "reference")
            {
                var fkCol =
                    entity.Columns.FirstOrDefault(c => we.FkNavByColumn.TryGetValue(c.Name, out var n) && n == nav.Name) ??
                    entity.Columns.FirstOrDefault(c => c.Name == $"{nav.Name}Id") ??
                    entity.Columns.FirstOrDefault(c => c.Name == $"{nav.Target}Id");
                var inverse = targetWe.Navs.FirstOrDefault(n => n.Kind == "collection" && n.Target == entity.Name);
                var inverseOne = targetWe.Navs.FirstOrDefault(n => n.Kind == "reference" && n.Target == entity.Name);
                if (fkCol is null && inverseOne is not null && inverse is null)
                {
                    var otherHasFk = target.Columns.Any(c =>
                        c.Name == $"{inverseOne.Name}Id" || c.Name == $"{entity.Name}Id" ||
                        (targetWe.FkNavByColumn.TryGetValue(c.Name, out var n) && n == inverseOne.Name));
                    if (otherHasFk) continue;
                }
                if (model.Relationships.Any(r =>
                        r.Dependent == entity.FullName && r.Principal == target.FullName && r.Navigation == nav.Name))
                    continue;
                model.Relationships.Add(new Relationship
                {
                    Dependent = entity.FullName,
                    Principal = target.FullName,
                    Navigation = nav.Name,
                    InverseNavigation = inverse?.Name ?? inverseOne?.Name,
                    ForeignKey = fkCol is not null ? new List<string> { fkCol.Name } : new List<string>(),
                    Type = inverseOne is not null && inverse is null ? "one-to-one" : "many-to-one",
                    OnDelete = fkCol is not null ? (fkCol.IsRequired ? "Cascade" : "ClientSetNull") : null,
                    IsRequired = fkCol?.IsRequired ?? !nav.Nullable,
                    Inferred = true,
                });
            }
            else if (nav.Kind == "collection")
            {
                var inverseColl = targetWe.Navs.FirstOrDefault(n => n.Kind == "collection" && n.Target == entity.Name);
                if (inverseColl is not null && string.CompareOrdinal(entity.Name, target.Name) < 0)
                {
                    model.Relationships.Add(new Relationship
                    {
                        Dependent = entity.FullName,
                        Principal = target.FullName,
                        Navigation = nav.Name,
                        InverseNavigation = inverseColl.Name,
                        Type = "many-to-many",
                        IsRequired = true,
                        Inferred = true,
                    });
                }
            }
        }
    }

    private static void FoldOwnedTypes(
        WorkEntity we, Dictionary<string, WorkEntity?> included, Model model, Dictionary<string, ClassInfo> classIndex)
    {
        foreach (var nav in we.Navs)
        {
            if (nav.Kind != "reference") continue;
            if (!classIndex.TryGetValue(nav.Target, out var targetCls) ||
                !targetCls.Attributes.Any(a => a.Name == "Owned")) continue;
            if (!included.TryGetValue(nav.Target, out var targetWe) || targetWe is null) continue;

            targetWe.Removed = true;
            var folded = new List<string>();
            foreach (var col in targetWe.Entity.Columns)
            {
                var clone = col.Clone();
                clone.Name = $"{nav.Name}.{col.Name}";
                clone.ColumnName = $"{nav.Name}_{col.ColumnName}";
                clone.Owned = true;
                folded.Add(clone.ColumnName);
                we.Entity.Columns.Add(clone);
            }
            we.Entity.OwnedTypes.Add(new OwnedType
            {
                Type = targetWe.Entity.FullName,
                Navigation = nav.Name,
                Kind = "one",
                Inline = true,
                Columns = folded,
            });
            model.Relationships.RemoveAll(r =>
                r.Dependent == targetWe.Entity.FullName || r.Principal == targetWe.Entity.FullName);
        }
    }

    private static string UnqAttr(string s)
    {
        var m = Regex.Match(s, "\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : s.Trim();
    }

    /// <summary>Naive English pluralizer, mirroring EF's default DbSet-style table naming.</summary>
    public static string Pluralize(string name)
    {
        if (Regex.IsMatch(name, "(s|x|z|ch|sh)$", RegexOptions.IgnoreCase)) return name + "es";
        if (Regex.IsMatch(name, "[^aeiou]y$", RegexOptions.IgnoreCase)) return name[..^1] + "ies";
        return name + "s";
    }
}
