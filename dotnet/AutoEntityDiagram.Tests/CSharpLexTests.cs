using Xunit;
using static AutoEntityDiagram.CSharpLex;

namespace AutoEntityDiagram.Tests;

public class CSharpLexTests
{
    [Fact]
    public void StripComments_RemovesCommentsButKeepsStrings()
    {
        var code = "var a = \"http://x\"; // trailing\n/* block */ var b = 2;";
        var outp = StripComments(code);
        Assert.Contains("\"http://x\"", outp);
        Assert.DoesNotContain("trailing", outp);
        Assert.DoesNotContain("block", outp);
        Assert.Contains("var b = 2;", outp);
    }

    [Fact]
    public void FindMatching_BalancesNestedAndIgnoresStrings()
    {
        var code = "f(a, \"cl)ose\", (b + c))";
        Assert.Equal(code.Length - 1, FindMatching(code, 1));
    }

    [Fact]
    public void SplitTopLevel_SplitsOnlyAtDepthZero()
    {
        var parts = SplitTopLevel("a, f(b, c), \"x,y\", d", ',').Select(p => p.Trim()).ToList();
        Assert.Equal(new[] { "a", "f(b, c)", "\"x,y\"", "d" }, parts);
    }

    [Fact]
    public void Unquote_HandlesEscapedAndVerbatim()
    {
        Assert.Equal("nvarchar(200)", Unquote("\"nvarchar(200)\""));
        Assert.Equal("C:\\temp", Unquote("@\"C:\\temp\""));
        Assert.Equal("say \"hi\"", Unquote("\"say \\\"hi\\\"\""));
    }

    [Fact]
    public void LiteralValue_ConvertsLiterals()
    {
        Assert.Equal(true, LiteralValue("true"));
        Assert.Equal(false, LiteralValue("false"));
        Assert.Null(LiteralValue("null"));
        Assert.Equal(18d, LiteralValue("18"));
        Assert.Equal(2.5d, LiteralValue("2.5m"));
        Assert.Equal("x", LiteralValue("\"x\""));
    }

    [Fact]
    public void ParseChain_ParsesFluentPropertyChain()
    {
        var chain = ParseChain("b.Property<string>(\"Name\").IsRequired().HasMaxLength(200)");
        Assert.NotNull(chain);
        Assert.Equal("b", chain!.Root);
        Assert.Equal(new[] { "Property", "IsRequired", "HasMaxLength" }, chain.Calls.Select(c => c.Name));
        Assert.Equal("string", chain.Calls[0].Generic);
        Assert.Equal(new[] { "\"Name\"" }, chain.Calls[0].Args);
        Assert.Equal(new[] { "200" }, chain.Calls[2].Args);
    }

    [Fact]
    public void ParseChain_HandlesLambdaArguments()
    {
        var chain = ParseChain("b.OwnsOne(\"Ns.Address\", \"Address\", b1 => { b1.HasKey(\"Id\"); })");
        Assert.NotNull(chain);
        Assert.Equal("OwnsOne", chain!.Calls[0].Name);
        Assert.Equal(3, chain.Calls[0].Args.Count);
        Assert.Contains("=>", chain.Calls[0].Args[2]);
    }

    [Fact]
    public void LambdaBody_ExtractsBlockBody()
    {
        Assert.Equal("x; y;", LambdaBody("b1 => { x; y; }")!.Trim());
        Assert.Null(LambdaBody("not a lambda"));
    }

    [Fact]
    public void SimpleName_ShortensQualifiedAndNested()
    {
        Assert.Equal("Product", SimpleName("WebShop.Models.Product"));
        Assert.Equal("Inner", SimpleName("Ns.Outer+Inner"));
        Assert.Equal("Plain", SimpleName("Plain"));
    }
}
