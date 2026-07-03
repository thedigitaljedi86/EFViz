using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using AutoEntityDiagram;

var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
    ?.InformationalVersion.Split('+')[0] ?? "1.0.0";

var help = $"""

    AutoEntityDiagram v{version}  (dotnet tool)
    Interactive ER diagrams for Entity Framework Core — straight from your code.

    Usage
      aed [path] [options]

      path                    Workspace root to scan (default: current directory)

    Options
      -o, --output <file>     Output HTML file           (default: entity-diagram.html)
      -c, --context <name>    Only include this DbContext (default: all found)
      -t, --title <text>      Title shown in the diagram header
          --json <file>       Also write the raw model + diff data as JSON
          --open              Open the generated diagram in your browser
      -q, --quiet             Suppress non-error output
      -v, --version           Print version
      -h, --help              Show this help

    Examples
      aed                                 Scan current directory
      aed ./src -o docs/db-diagram.html   Scan ./src, write to docs/
      aed --context OrdersContext --open  One context, open when done

    """;

string path = ".";
string output = "entity-diagram.html";
string? contextFilter = null;
string? title = null;
string? jsonOut = null;
var open = false;
var quiet = false;

var queue = new Queue<string>(args);
while (queue.Count > 0)
{
    var a = queue.Dequeue();
    switch (a)
    {
        case "-h" or "--help":
            Console.WriteLine(help);
            return 0;
        case "-v" or "--version":
            Console.WriteLine(version);
            return 0;
        case "-o" or "--output":
            output = Expect(queue, a);
            break;
        case "-c" or "--context":
            contextFilter = Expect(queue, a);
            break;
        case "-t" or "--title":
            title = Expect(queue, a);
            break;
        case "--json":
            jsonOut = Expect(queue, a);
            break;
        case "--open":
            open = true;
            break;
        case "-q" or "--quiet":
            quiet = true;
            break;
        default:
            if (a.StartsWith('-')) return Fail($"Unknown option: {a}\n{help}");
            path = a;
            break;
    }
}

var root = Path.GetFullPath(path);
if (!Directory.Exists(root)) return Fail($"Not a directory: {root}");

void Log(string message)
{
    if (!quiet) Console.WriteLine(message);
}

var started = Stopwatch.StartNew();
Log($"Scanning {root} …");

var data = DiagramBuilder.Build(root, contextFilter);

if (data.Contexts.Count == 0)
{
    return Fail(
        "No DbContext found.\n" +
        "Looked for classes deriving from DbContext, EF Core migration designer files, and model snapshots.\n" +
        (contextFilter is not null ? $"(filtered to context '{contextFilter}')" : ""));
}

foreach (var w in data.Warnings) Console.Error.WriteLine($"warning: {w}");

foreach (var c in data.Contexts)
{
    var m = c.CurrentModel!;
    var src = c.ModelSource switch
    {
        "source" => "from entity classes (no migrations found)",
        "snapshot" => "from model snapshot",
        _ => "from migrations",
    };
    Log($"  {c.Name}: {m.Entities.Count} entities, {m.Relationships.Count(r => r.Type != "inheritance")} relationships, " +
        $"{c.Migrations.Count} migration{(c.Migrations.Count == 1 ? "" : "s")} — {src}" +
        (c.Provider is not null ? $" ({c.Provider})" : ""));
    if (c.PendingChanges is not null)
        Log($"    note: model snapshot has {c.PendingChanges.ChangeCount} change(s) not yet in a migration");
}

var html = Emitter.EmitHtml(data, title);
var outPath = Path.GetFullPath(output);
File.WriteAllText(outPath, html);
Log($"\n✔ Diagram written to {outPath} ({html.Length / 1024} kB) in {started.ElapsedMilliseconds} ms");
Log("  Re-run this command after adding migrations to refresh the diagram.");

if (jsonOut is not null)
{
    File.WriteAllText(Path.GetFullPath(jsonOut), JsonSerializer.Serialize(data, Emitter.JsonIndentedOptions));
    Log($"✔ Model data written to {Path.GetFullPath(jsonOut)}");
}

if (open)
{
    try
    {
        if (OperatingSystem.IsWindows())
            Process.Start(new ProcessStartInfo(outPath) { UseShellExecute = true });
        else if (OperatingSystem.IsMacOS())
            Process.Start("open", outPath);
        else
            Process.Start("xdg-open", outPath);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"warning: could not open browser: {ex.Message}");
    }
}

return 0;

static string Expect(Queue<string> queue, string flag)
{
    if (queue.Count == 0)
    {
        Console.Error.WriteLine($"Missing value for {flag}");
        Environment.Exit(1);
    }
    return queue.Dequeue();
}

static int Fail(string message)
{
    Console.Error.WriteLine(message);
    return 1;
}
