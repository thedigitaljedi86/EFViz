namespace EFViz;

/// <summary>
/// Orchestration: scan a workspace and produce the complete diagram payload —
/// every DbContext, its model per migration, diffs between migrations, and a
/// current model (from the snapshot, the last migration, or source fallback).
/// </summary>
public static class DiagramBuilder
{
    public static DiagramData Build(string root, string? contextFilter = null)
    {
        var scan = Scanner.ScanWorkspace(root);
        var data = new DiagramData
        {
            GeneratedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
            Root = root,
        };

        var contextNames = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var c in scan.Contexts) contextNames.Add(c.Name);
        foreach (var n in scan.MigrationSets.Keys) contextNames.Add(n);
        foreach (var n in scan.Snapshots.Keys) contextNames.Add(n);

        foreach (var name in contextNames)
        {
            if (contextFilter is not null && name != contextFilter) continue;
            var source = scan.Contexts.FirstOrDefault(c => c.Name == name);
            var designerFiles = scan.MigrationSets.GetValueOrDefault(name) ?? new List<DesignerFile>();
            var hasSnapshot = scan.Snapshots.TryGetValue(name, out var snapshot);

            var ctx = new ContextResult
            {
                Name = name,
                Namespace = source?.Namespace,
                FilePath = source?.RelativePath,
                DbSetCount = source?.DbSets.Count,
            };

            Model? prevModel = null;
            foreach (var designer in designerFiles)
            {
                var meta = SnapshotParser.ParseMigrationMeta(designer.Code);
                if (meta is null) continue;
                Model model;
                try
                {
                    model = SnapshotParser.ParseSnapshotModel(designer.Code);
                }
                catch (Exception ex)
                {
                    data.Warnings.Add($"Failed to parse {Scanner.Rel(root, designer.FilePath)}: {ex.Message}");
                    continue;
                }
                ctx.Provider ??= SnapshotParser.DetectProvider(designer.Code);
                ctx.Migrations.Add(new Migration
                {
                    Id = meta.Id,
                    Name = meta.Name,
                    Timestamp = meta.Timestamp,
                    FilePath = Scanner.Rel(root, designer.FilePath),
                    Model = model,
                    Diff = Differ.DiffModels(prevModel, model),
                });
                prevModel = model;
            }

            if (hasSnapshot)
            {
                try
                {
                    var model = SnapshotParser.ParseSnapshotModel(snapshot.Code);
                    ctx.CurrentModel = model;
                    ctx.ModelSource = "snapshot";
                    ctx.Provider ??= SnapshotParser.DetectProvider(snapshot.Code);
                    if (prevModel is not null)
                    {
                        var pending = Differ.DiffModels(prevModel, model);
                        if (pending.ChangeCount > 0) ctx.PendingChanges = pending;
                    }
                }
                catch (Exception ex)
                {
                    data.Warnings.Add($"Failed to parse {Scanner.Rel(root, snapshot.FilePath)}: {ex.Message}");
                }
            }
            if (ctx.CurrentModel is null && ctx.Migrations.Count > 0)
            {
                ctx.CurrentModel = ctx.Migrations[^1].Model;
                ctx.ModelSource = "migrations";
            }
            if (ctx.CurrentModel is null && source is not null)
            {
                try
                {
                    var model = SourceParser.BuildModelFromSource(source, scan.CsFiles);
                    if (model.Entities.Count > 0)
                    {
                        ctx.CurrentModel = model;
                        ctx.ModelSource = "source";
                    }
                }
                catch (Exception ex)
                {
                    data.Warnings.Add($"Failed to build model from source for {name}: {ex.Message}");
                }
            }

            if (ctx.CurrentModel is null)
            {
                data.Warnings.Add($"Skipped context '{name}': no migrations, snapshot, or parsable entities found.");
                continue;
            }
            data.Contexts.Add(ctx);
        }

        return data;
    }
}
