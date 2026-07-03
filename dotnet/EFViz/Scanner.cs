using System.Text.RegularExpressions;

namespace EFViz;

public sealed record DbSetRef(string EntityType, string PropertyName);

public sealed class DiscoveredContext
{
    public required string Name { get; init; }
    public string? Namespace { get; init; }
    public required string FilePath { get; init; }
    public required string RelativePath { get; init; }
    public List<DbSetRef> DbSets { get; init; } = new();
    public required string Code { get; init; }
}

public sealed record DesignerFile(string Id, string FilePath, string Code);

public sealed class ScanResult
{
    public List<DiscoveredContext> Contexts { get; } = new();
    public Dictionary<string, List<DesignerFile>> MigrationSets { get; } = new();
    public Dictionary<string, (string FilePath, string Code)> Snapshots { get; } = new();
    public List<string> CsFiles { get; } = new();
}

/// <summary>
/// Workspace discovery: walks a directory tree and finds DbContext classes,
/// migration designer files, and model snapshot files.
/// </summary>
public static class Scanner
{
    private static readonly HashSet<string> SkipDirs = new(StringComparer.Ordinal)
    {
        "bin", "obj", "node_modules", ".git", ".vs", ".idea", ".vscode",
        "packages", "TestResults", "artifacts", ".svn", "dist", "out",
    };

    private static readonly Regex DbContextBases =
        new(@"(?:^|[\s,:(])(?:\w+\.)*((?:Identity)?DbContext|IdentityUserContext)\b");

    private static readonly Regex ClassRe = new(
        @"(?:public|internal|protected|private)?\s*(?:sealed\s+|abstract\s+|partial\s+)*class\s+(\w+)\s*(?:<[^>]*>)?\s*:\s*([^\n{]+)");

    private static readonly Regex DbSetRe = new(@"DbSet<([\w.<>?]+)>\s*(\w+)\s*(?:\{|=>)");

    public static List<string> FindCsFiles(string root)
    {
        var files = new List<string>();
        Walk(root, files);
        return files;
    }

    private static void Walk(string dir, List<string> files)
    {
        IEnumerable<string> entries;
        try
        {
            entries = Directory.EnumerateFileSystemEntries(dir);
        }
        catch
        {
            return;
        }
        foreach (var full in entries)
        {
            var name = Path.GetFileName(full);
            if (name.StartsWith('.') && name != ".") continue;
            if (Directory.Exists(full))
            {
                if (!SkipDirs.Contains(name)) Walk(full, files);
            }
            else if (name.EndsWith(".cs", StringComparison.Ordinal))
            {
                files.Add(full);
            }
        }
    }

    public static ScanResult ScanWorkspace(string root)
    {
        var result = new ScanResult();
        result.CsFiles.AddRange(FindCsFiles(root));

        foreach (var file in result.CsFiles)
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

            // Migration designer files
            if (file.EndsWith(".Designer.cs", StringComparison.Ordinal) &&
                code.Contains("[Migration(") && code.Contains("BuildTargetModel"))
            {
                var idMatch = Regex.Match(code, "\\[Migration\\(\\s*\"([^\"]+)\"\\s*\\)\\]");
                var ctxMatch = Regex.Match(code, @"\[DbContext\(typeof\(([\w.]+)\)\)\]");
                if (idMatch.Success)
                {
                    var ctxType = ctxMatch.Success ? ShortTypeName(ctxMatch.Groups[1].Value) : "?";
                    if (!result.MigrationSets.TryGetValue(ctxType, out var list))
                        result.MigrationSets[ctxType] = list = new List<DesignerFile>();
                    list.Add(new DesignerFile(idMatch.Groups[1].Value, file, code));
                }
                continue;
            }

            // Model snapshot files
            if (code.Contains("ModelSnapshot") && code.Contains("BuildModel") && code.Contains("[DbContext("))
            {
                var ctxMatch = Regex.Match(code, @"\[DbContext\(typeof\(([\w.]+)\)\)\]");
                if (ctxMatch.Success)
                {
                    result.Snapshots[ShortTypeName(ctxMatch.Groups[1].Value)] = (file, code);
                    continue;
                }
            }

            // DbContext classes (user code)
            foreach (Match m in ClassRe.Matches(code))
            {
                var bases = m.Groups[2].Value;
                if (!DbContextBases.IsMatch(bases)) continue;
                if (bases.Contains("Migration")) continue;
                var name = m.Groups[1].Value;
                if (name.EndsWith("ModelSnapshot", StringComparison.Ordinal)) continue;
                var nsMatch = Regex.Match(code, @"namespace\s+([\w.]+)");
                var dbSets = DbSetRe.Matches(code)
                    .Select(ds => new DbSetRef(ds.Groups[1].Value, ds.Groups[2].Value))
                    .ToList();
                result.Contexts.Add(new DiscoveredContext
                {
                    Name = name,
                    Namespace = nsMatch.Success ? nsMatch.Groups[1].Value : null,
                    FilePath = file,
                    RelativePath = Rel(root, file),
                    DbSets = dbSets,
                    Code = code,
                });
            }
        }

        foreach (var list in result.MigrationSets.Values)
            list.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));

        return result;
    }

    public static string Rel(string root, string path) =>
        Path.GetRelativePath(root, path).Replace('\\', '/');

    private static string ShortTypeName(string fqn) => fqn.Split('.')[^1];
}
