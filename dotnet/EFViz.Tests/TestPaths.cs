using System.Runtime.CompilerServices;

namespace EFViz.Tests;

/// <summary>Locates the repo's shared example projects from the test binary.</summary>
public static class TestPaths
{
    public static string RepoRoot { get; } = FindRepoRoot();

    public static string Examples => Path.Combine(RepoRoot, "examples");
    public static string WebShop => Path.Combine(Examples, "WebShop");
    public static string WebShopMigrations => Path.Combine(WebShop, "Migrations");
    public static string MinimalTodo => Path.Combine(Examples, "MinimalTodo");

    public static string Designer(string file) => Path.Combine(WebShopMigrations, file);

    private static string FindRepoRoot([CallerFilePath] string thisFile = "")
    {
        // …/dotnet/EFViz.Tests/TestPaths.cs → repo root is two levels up.
        var dir = Path.GetDirectoryName(thisFile)!;
        return Path.GetFullPath(Path.Combine(dir, "..", ".."));
    }
}
