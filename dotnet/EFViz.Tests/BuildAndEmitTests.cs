using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace EFViz.Tests;

public class BuildAndEmitTests
{
    [Fact]
    public void BuildsCompleteDataForWebShop()
    {
        var data = DiagramBuilder.Build(TestPaths.WebShop);
        var ctx = Assert.Single(data.Contexts);
        Assert.Equal("ShopContext", ctx.Name);
        Assert.Equal("SQL Server", ctx.Provider);
        Assert.Equal(4, ctx.Migrations.Count);
        Assert.Equal("snapshot", ctx.ModelSource);
        Assert.Equal(8, ctx.CurrentModel!.Entities.Count);
        var ids = ctx.Migrations.Select(m => m.Id).ToList();
        Assert.Equal(ids.OrderBy(x => x, StringComparer.Ordinal), ids);
        Assert.All(ctx.Migrations, m => Assert.NotNull(m.Diff));
        Assert.Null(ctx.PendingChanges);
    }

    [Fact]
    public void ScanningExamplesFolderFindsBothContexts()
    {
        var data = DiagramBuilder.Build(TestPaths.Examples);
        Assert.Equal(new[] { "ShopContext", "TodoContext" },
            data.Contexts.Select(c => c.Name).OrderBy(n => n));
        var todo = data.Contexts.First(c => c.Name == "TodoContext");
        Assert.Equal("source", todo.ModelSource);
        Assert.Empty(todo.Migrations);
    }

    [Fact]
    public void ContextFilterNarrowsOutput()
    {
        var data = DiagramBuilder.Build(TestPaths.Examples, "TodoContext");
        var ctx = Assert.Single(data.Contexts);
        Assert.Equal("TodoContext", ctx.Name);
    }

    [Fact]
    public void EmitHtml_IsSelfContainedWithEmbeddedData()
    {
        var data = DiagramBuilder.Build(TestPaths.WebShop);
        var html = Emitter.EmitHtml(data, "Test & Title");
        Assert.StartsWith("<!DOCTYPE html>", html);
        Assert.Contains("Test &amp; Title", html);
        Assert.DoesNotContain("__DATA__", html);
        Assert.DoesNotContain("__STYLES__", html);
        Assert.DoesNotContain("__APP__", html);

        var m = Regex.Match(html,
            "<script id=\"efviz-data\" type=\"application/json\">\\s*([\\s\\S]*?)\\s*</script>");
        Assert.True(m.Success);
        using var doc = JsonDocument.Parse(m.Groups[1].Value.Replace("\\u003c", "<"));
        Assert.Equal("ShopContext",
            doc.RootElement.GetProperty("contexts")[0].GetProperty("name").GetString());

        Assert.DoesNotContain("src=\"http", html);
        Assert.DoesNotContain("href=\"http", html);
    }

    /// <summary>
    /// The C# tool must produce the exact same JSON as the npm CLI so both feed
    /// one shared viewer. This regenerates the model and compares it, field for
    /// field, against a reference produced by the Node implementation.
    /// </summary>
    [Fact]
    public void JsonMatchesNodeReference()
    {
        var refPath = Path.Combine(TestPaths.RepoRoot, "dotnet", "EFViz.Tests", "fixtures", "webshop.node.json");
        Assert.True(File.Exists(refPath),
            "Reference fixture missing — regenerate with: node bin/efviz.js examples/WebShop --json <path>");

        var expected = Normalize(File.ReadAllText(refPath));
        var data = DiagramBuilder.Build(TestPaths.WebShop);
        var actual = Normalize(JsonSerializer.Serialize(data, Emitter.JsonOptions));

        Assert.Equal(expected, actual);
    }

    private static string Normalize(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var dict = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
        // generatedAt and root are environment-specific; ignore them.
        var stable = new SortedDictionary<string, object?>();
        foreach (var (k, v) in dict)
        {
            if (k is "generatedAt" or "root") continue;
            stable[k] = v;
        }
        return JsonSerializer.Serialize(stable);
    }
}
