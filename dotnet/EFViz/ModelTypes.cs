using System.Text.Json.Serialization;

namespace EFViz;

/// <summary>
/// The diagram data model. Serializes to the exact JSON schema produced by the
/// npm CLI, so both front ends feed the same embedded viewer. Optional flags
/// (isPrimaryKey, owned, …) are nullable and omitted when unset, mirroring the
/// JavaScript objects where those keys are simply absent.
/// </summary>
public sealed class Column
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("columnName")] public string ColumnName { get; set; } = "";
    [JsonPropertyName("clrType")] public string? ClrType { get; set; }
    [JsonPropertyName("storeType")] public string? StoreType { get; set; }
    [JsonPropertyName("isRequired")] public bool IsRequired { get; set; } = true;
    [JsonPropertyName("maxLength")] public double? MaxLength { get; set; }
    [JsonPropertyName("precision")] public double? Precision { get; set; }
    [JsonPropertyName("scale")] public double? Scale { get; set; }
    [JsonPropertyName("valueGenerated")] public string? ValueGenerated { get; set; }
    [JsonPropertyName("isIdentity")] public bool IsIdentity { get; set; }
    [JsonPropertyName("isConcurrencyToken")] public bool IsConcurrencyToken { get; set; }

    [JsonIgnore] public bool DefaultValueSet { get; set; }
    [JsonPropertyName("defaultValue")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? DefaultValue { get; set; }

    [JsonPropertyName("defaultValueSql")] public string? DefaultValueSql { get; set; }
    [JsonPropertyName("computedSql")] public string? ComputedSql { get; set; }
    [JsonPropertyName("comment")] public string? Comment { get; set; }
    [JsonPropertyName("isUnicode")] public bool? IsUnicode { get; set; }

    // Declared FK-before-PK to match the npm CLI's key insertion order (its
    // finalize pass marks foreign keys before primary keys), so both tools
    // emit byte-identical JSON.
    [JsonPropertyName("isForeignKey")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsForeignKey { get; set; }

    [JsonPropertyName("isPrimaryKey")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsPrimaryKey { get; set; }

    [JsonPropertyName("owned")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Owned { get; set; }

    [JsonPropertyName("isCollection")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsCollection { get; set; }

    public Column Clone() => (Column)MemberwiseClone();
}

public sealed class Index
{
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("isUnique")] public bool IsUnique { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("filter")] public object? Filter { get; set; }

    [JsonPropertyName("descending")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Descending { get; set; }
}

public sealed class Discriminator
{
    [JsonPropertyName("column")] public string Column { get; set; } = "Discriminator";
    [JsonPropertyName("values")] public List<object?> Values { get; set; } = new();
}

public sealed class OwnedType
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("navigation")] public string? Navigation { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; } = "one";
    [JsonPropertyName("inline")] public bool Inline { get; set; }

    [JsonPropertyName("columns")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Columns { get; set; }
}

public sealed class Entity
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("fullName")] public string FullName { get; set; } = "";
    [JsonPropertyName("table")] public string? Table { get; set; }
    [JsonPropertyName("schema")] public string? Schema { get; set; }
    [JsonPropertyName("isView")] public bool IsView { get; set; }
    [JsonPropertyName("columns")] public List<Column> Columns { get; set; } = new();
    [JsonPropertyName("primaryKey")] public List<string> PrimaryKey { get; set; } = new();
    [JsonPropertyName("alternateKeys")] public List<List<string>> AlternateKeys { get; set; } = new();
    [JsonPropertyName("indexes")] public List<Index> Indexes { get; set; } = new();
    [JsonPropertyName("discriminator")] public Discriminator? Disc { get; set; }
    [JsonPropertyName("baseType")] public string? BaseType { get; set; }
    [JsonPropertyName("mappingStrategy")] public string? MappingStrategy { get; set; }
    [JsonPropertyName("ownedTypes")] public List<OwnedType> OwnedTypes { get; set; } = new();
    [JsonPropertyName("seedCount")] public int SeedCount { get; set; }
    [JsonPropertyName("annotations")] public Dictionary<string, object?> Annotations { get; set; } = new();

    [JsonPropertyName("isJoinTable")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsJoinTable { get; set; }

    [JsonPropertyName("isOwned")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsOwned { get; set; }
}

public sealed class Relationship
{
    [JsonPropertyName("dependent")] public string Dependent { get; set; } = "";
    [JsonPropertyName("principal")] public string Principal { get; set; } = "";
    [JsonPropertyName("navigation")] public string? Navigation { get; set; }
    [JsonPropertyName("inverseNavigation")] public string? InverseNavigation { get; set; }
    [JsonPropertyName("foreignKey")] public List<string> ForeignKey { get; set; } = new();
    [JsonPropertyName("principalKey")] public List<string> PrincipalKey { get; set; } = new();
    [JsonPropertyName("type")] public string Type { get; set; } = "many-to-one";
    [JsonPropertyName("onDelete")] public string? OnDelete { get; set; }
    [JsonPropertyName("isRequired")] public bool IsRequired { get; set; }

    [JsonPropertyName("isOwnership")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsOwnership { get; set; }

    [JsonPropertyName("via")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Via { get; set; }

    [JsonPropertyName("inferred")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Inferred { get; set; }
}

public sealed class Model
{
    [JsonPropertyName("productVersion")] public string? ProductVersion { get; set; }
    [JsonPropertyName("annotations")] public Dictionary<string, object?> Annotations { get; set; } = new();
    [JsonPropertyName("entities")] public List<Entity> Entities { get; set; } = new();
    [JsonPropertyName("relationships")] public List<Relationship> Relationships { get; set; } = new();
}

public sealed class ColumnChange
{
    [JsonPropertyName("field")] public string Field { get; set; } = "";
    [JsonPropertyName("from")] public object? From { get; set; }
    [JsonPropertyName("to")] public object? To { get; set; }
}

public sealed class ModifiedColumn
{
    [JsonPropertyName("column")] public string ColumnName { get; set; } = "";
    [JsonPropertyName("changes")] public List<ColumnChange> Changes { get; set; } = new();
}

public sealed class TableChange
{
    [JsonPropertyName("from")] public string? From { get; set; }
    [JsonPropertyName("to")] public string? To { get; set; }
}

public sealed class ModifiedEntity
{
    [JsonPropertyName("entity")] public string EntityFullName { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("addedColumns")] public List<string> AddedColumns { get; set; } = new();
    [JsonPropertyName("removedColumns")] public List<string> RemovedColumns { get; set; } = new();
    [JsonPropertyName("modifiedColumns")] public List<ModifiedColumn> ModifiedColumns { get; set; } = new();
    [JsonPropertyName("addedIndexes")] public List<string> AddedIndexes { get; set; } = new();
    [JsonPropertyName("removedIndexes")] public List<string> RemovedIndexes { get; set; } = new();
    [JsonPropertyName("tableChanged")] public TableChange? TableChanged { get; set; }
}

public sealed class RelationshipRef
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("dependent")] public string Dependent { get; set; } = "";
    [JsonPropertyName("principal")] public string Principal { get; set; } = "";
    [JsonPropertyName("foreignKey")] public List<string> ForeignKey { get; set; } = new();
    [JsonPropertyName("via")] public string? Via { get; set; }
    [JsonPropertyName("onDelete")] public string? OnDelete { get; set; }
}

public sealed class Diff
{
    [JsonPropertyName("addedEntities")] public List<string> AddedEntities { get; set; } = new();
    [JsonPropertyName("removedEntities")] public List<string> RemovedEntities { get; set; } = new();
    [JsonPropertyName("modifiedEntities")] public List<ModifiedEntity> ModifiedEntities { get; set; } = new();
    [JsonPropertyName("addedRelationships")] public List<RelationshipRef> AddedRelationships { get; set; } = new();
    [JsonPropertyName("removedRelationships")] public List<RelationshipRef> RemovedRelationships { get; set; } = new();
    [JsonPropertyName("changeCount")] public int ChangeCount { get; set; }
}

public sealed class Migration
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("timestamp")] public string? Timestamp { get; set; }
    [JsonPropertyName("filePath")] public string FilePath { get; set; } = "";
    [JsonPropertyName("model")] public Model Model { get; set; } = new();
    [JsonPropertyName("diff")] public Diff Diff { get; set; } = new();
}

public sealed class ContextResult
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("namespace")] public string? Namespace { get; set; }
    [JsonPropertyName("filePath")] public string? FilePath { get; set; }
    [JsonPropertyName("provider")] public string? Provider { get; set; }
    [JsonPropertyName("dbSetCount")] public int? DbSetCount { get; set; }
    [JsonPropertyName("modelSource")] public string? ModelSource { get; set; }
    [JsonPropertyName("migrations")] public List<Migration> Migrations { get; set; } = new();
    [JsonPropertyName("currentModel")] public Model? CurrentModel { get; set; }

    [JsonPropertyName("pendingChanges")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Diff? PendingChanges { get; set; }
}

public sealed class DiagramData
{
    [JsonPropertyName("tool")] public string Tool { get; set; } = "EFViz";
    [JsonPropertyName("generatedAt")] public string GeneratedAt { get; set; } = "";
    [JsonPropertyName("root")] public string Root { get; set; } = "";
    [JsonPropertyName("contexts")] public List<ContextResult> Contexts { get; set; } = new();
    [JsonPropertyName("warnings")] public List<string> Warnings { get; set; } = new();
}
