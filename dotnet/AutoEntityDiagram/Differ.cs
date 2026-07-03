using System.Text.Json;

namespace AutoEntityDiagram;

/// <summary>
/// Computes structural differences between two model snapshots — the data
/// behind the timeline's highlights and change list.
/// </summary>
public static class Differ
{
    private static readonly (string Field, Func<Column, object?> Get)[] ColumnFields =
    {
        ("columnName", c => c.ColumnName),
        ("clrType", c => c.ClrType),
        ("storeType", c => c.StoreType),
        ("isRequired", c => c.IsRequired),
        ("maxLength", c => c.MaxLength),
        ("precision", c => c.Precision),
        ("scale", c => c.Scale),
        ("valueGenerated", c => c.ValueGenerated),
        ("isIdentity", c => c.IsIdentity),
        ("isConcurrencyToken", c => c.IsConcurrencyToken),
        ("defaultValue", c => c.DefaultValue),
        ("defaultValueSql", c => c.DefaultValueSql),
        ("computedSql", c => c.ComputedSql),
        ("isPrimaryKey", c => c.IsPrimaryKey),
        ("isForeignKey", c => c.IsForeignKey),
    };

    public static Diff DiffModels(Model? before, Model? after)
    {
        var diff = new Diff();
        var beforeMap = (before?.Entities ?? new List<Entity>()).ToDictionary(e => e.FullName);
        var afterMap = (after?.Entities ?? new List<Entity>()).ToDictionary(e => e.FullName);

        foreach (var (name, _) in afterMap)
            if (!beforeMap.ContainsKey(name)) diff.AddedEntities.Add(name);
        foreach (var (name, _) in beforeMap)
            if (!afterMap.ContainsKey(name)) diff.RemovedEntities.Add(name);

        foreach (var (name, afterE) in afterMap)
        {
            if (!beforeMap.TryGetValue(name, out var beforeE)) continue;
            var entityDiff = DiffEntity(beforeE, afterE);
            if (entityDiff is not null) diff.ModifiedEntities.Add(entityDiff);
        }

        static string RelKey(Relationship r) =>
            $"{r.Type}|{r.Dependent}|{r.Principal}|{string.Join(",", r.ForeignKey)}|{r.Via ?? ""}";

        var beforeRels = new Dictionary<string, Relationship>();
        foreach (var r in before?.Relationships ?? new List<Relationship>()) beforeRels[RelKey(r)] = r;
        var afterRels = new Dictionary<string, Relationship>();
        foreach (var r in after?.Relationships ?? new List<Relationship>()) afterRels[RelKey(r)] = r;

        foreach (var (key, r) in afterRels)
            if (!beforeRels.ContainsKey(key)) diff.AddedRelationships.Add(DescribeRel(r));
        foreach (var (key, r) in beforeRels)
            if (!afterRels.ContainsKey(key)) diff.RemovedRelationships.Add(DescribeRel(r));

        diff.ChangeCount =
            diff.AddedEntities.Count +
            diff.RemovedEntities.Count +
            diff.AddedRelationships.Count +
            diff.RemovedRelationships.Count +
            diff.ModifiedEntities.Sum(e =>
                e.AddedColumns.Count + e.RemovedColumns.Count + e.ModifiedColumns.Count +
                e.AddedIndexes.Count + e.RemovedIndexes.Count + (e.TableChanged is not null ? 1 : 0));
        return diff;
    }

    private static ModifiedEntity? DiffEntity(Entity before, Entity after)
    {
        var result = new ModifiedEntity { EntityFullName = after.FullName, Name = after.Name };

        var beforeCols = before.Columns.ToDictionary(c => c.Name);
        var afterCols = after.Columns.ToDictionary(c => c.Name);

        foreach (var (name, _) in afterCols)
            if (!beforeCols.ContainsKey(name)) result.AddedColumns.Add(name);
        foreach (var (name, _) in beforeCols)
            if (!afterCols.ContainsKey(name)) result.RemovedColumns.Add(name);

        foreach (var (name, afterC) in afterCols)
        {
            if (!beforeCols.TryGetValue(name, out var beforeC)) continue;
            var changes = new List<ColumnChange>();
            foreach (var (field, get) in ColumnFields)
            {
                if (Normalize(get(afterC)) != Normalize(get(beforeC)))
                    changes.Add(new ColumnChange { Field = field, From = get(beforeC), To = get(afterC) });
            }
            if (changes.Count > 0) result.ModifiedColumns.Add(new ModifiedColumn { ColumnName = name, Changes = changes });
        }

        static string IdxKey(Index i) => $"{string.Join(",", i.Columns)}|{(i.IsUnique ? "u" : "")}|{i.Filter ?? ""}";
        var beforeIdx = new Dictionary<string, Index>();
        foreach (var i in before.Indexes) beforeIdx[IdxKey(i)] = i;
        var afterIdx = new Dictionary<string, Index>();
        foreach (var i in after.Indexes) afterIdx[IdxKey(i)] = i;

        foreach (var (key, i) in afterIdx)
            if (!beforeIdx.ContainsKey(key)) result.AddedIndexes.Add(DescribeIndex(i));
        foreach (var (key, i) in beforeIdx)
            if (!afterIdx.ContainsKey(key)) result.RemovedIndexes.Add(DescribeIndex(i));

        if (before.Table != after.Table || before.Schema != after.Schema)
            result.TableChanged = new TableChange { From = Qualified(before), To = Qualified(after) };

        var empty =
            result.AddedColumns.Count == 0 &&
            result.RemovedColumns.Count == 0 &&
            result.ModifiedColumns.Count == 0 &&
            result.AddedIndexes.Count == 0 &&
            result.RemovedIndexes.Count == 0 &&
            result.TableChanged is null;
        return empty ? null : result;
    }

    private static string Normalize(object? v) => v is null ? "null" : JsonSerializer.Serialize(v);

    private static string? Qualified(Entity e) => e.Schema is not null ? $"{e.Schema}.{e.Table}" : e.Table;

    private static string DescribeIndex(Index i) =>
        $"{(i.IsUnique ? "unique " : "")}({string.Join(", ", i.Columns)}){(i.Filter is not null ? $" where {i.Filter}" : "")}";

    private static RelationshipRef DescribeRel(Relationship r) => new()
    {
        Type = r.Type,
        Dependent = r.Dependent,
        Principal = r.Principal,
        ForeignKey = r.ForeignKey.ToList(),
        Via = r.Via,
        OnDelete = r.OnDelete,
    };
}
