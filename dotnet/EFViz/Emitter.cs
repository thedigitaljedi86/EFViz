using System.Reflection;
using System.Text.Json;

namespace EFViz;

/// <summary>
/// Emits the final self-contained HTML file. Template, styles and the viewer
/// app are embedded resources shared verbatim with the npm CLI, so both tools
/// produce the identical viewer.
/// </summary>
public static class Emitter
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
    };

    public static readonly JsonSerializerOptions JsonIndentedOptions = new()
    {
        WriteIndented = true,
    };

    public static string EmitHtml(DiagramData data, string? title = null)
    {
        var template = ReadResource("viewer.template.html");
        var styles = ReadResource("viewer.styles.css");
        var app = ReadResource("viewer.app.js");
        var version = typeof(Emitter).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0] ?? "1.0.0";

        title ??= DefaultTitle(data);
        // </script> inside the JSON payload would terminate the script block early.
        var json = JsonSerializer.Serialize(data, JsonOptions).Replace("<", "\\u003c");

        return template
            .Replace("__TITLE__", EscapeHtml(title))
            .Replace("__VERSION__", version)
            .Replace("__STYLES__", styles)
            .Replace("__DATA__", json)
            .Replace("__APP__", app);
    }

    private static string ReadResource(string logicalName)
    {
        using var stream = typeof(Emitter).Assembly.GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"Missing embedded resource: {logicalName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static string DefaultTitle(DiagramData data) =>
        data.Contexts.Count == 1 ? $"{data.Contexts[0].Name} — Entity Diagram" : "Entity Diagram";

    private static string EscapeHtml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
