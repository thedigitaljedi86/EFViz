using Xunit;

namespace AutoEntityDiagram.Tests;

public class SourceParserTests
{
    private static Model Build()
    {
        var scan = Scanner.ScanWorkspace(TestPaths.MinimalTodo);
        var context = scan.Contexts.First(c => c.Name == "TodoContext");
        return SourceParser.BuildModelFromSource(context, scan.CsFiles);
    }

    [Fact]
    public void DiscoversDbContextAndDbSets()
    {
        var scan = Scanner.ScanWorkspace(TestPaths.MinimalTodo);
        var context = scan.Contexts.Single();
        Assert.Equal("TodoContext", context.Name);
        Assert.Equal(new[] { "Person", "TodoItem", "TodoList" },
            context.DbSets.Select(d => d.EntityType).OrderBy(n => n));
    }

    [Fact]
    public void BuildsEntitiesWithConventionPrimaryKeys()
    {
        var model = Build();
        Assert.Equal(new[] { "Person", "TodoItem", "TodoList" },
            model.Entities.Select(e => e.Name).OrderBy(n => n));
        Assert.All(model.Entities, e => Assert.Equal(new[] { "Id" }, e.PrimaryKey));
    }

    [Fact]
    public void TableNames_FromAttributeOrDbSetProperty()
    {
        var model = Build();
        Assert.Equal("People", model.Entities.First(e => e.Name == "Person").Table);
        Assert.Equal("Lists", model.Entities.First(e => e.Name == "TodoList").Table);
        Assert.Equal("Items", model.Entities.First(e => e.Name == "TodoItem").Table);
    }

    [Fact]
    public void AnnotationsMapToColumnFacets()
    {
        var model = Build();
        var item = model.Entities.First(e => e.Name == "TodoItem");
        var text = item.Columns.First(c => c.Name == "Text");
        Assert.True(text.IsRequired);
        Assert.Equal(200d, text.MaxLength);
        Assert.False(item.Columns.First(c => c.Name == "DueAt").IsRequired);
    }

    [Fact]
    public void InfersRelationshipsWithFkConventionsAndOptionality()
    {
        var model = Build();
        var itemList = model.Relationships.First(r =>
            r.Dependent.EndsWith("TodoItem") && r.Principal.EndsWith("TodoList"));
        Assert.Equal(new[] { "TodoListId" }, itemList.ForeignKey);
        Assert.True(itemList.IsRequired);

        var assignee = model.Relationships.First(r =>
            r.Dependent.EndsWith("TodoItem") && r.Principal.EndsWith("Person") && r.Navigation == "Assignee");
        Assert.Equal(new[] { "AssigneeId" }, assignee.ForeignKey);
        Assert.False(assignee.IsRequired);

        var fkCol = model.Entities.First(e => e.Name == "TodoItem").Columns.First(c => c.Name == "TodoListId");
        Assert.True(fkCol.IsForeignKey);
    }

    [Theory]
    [InlineData("Product", "Products")]
    [InlineData("Category", "Categories")]
    [InlineData("Address", "Addresses")]
    [InlineData("Box", "Boxes")]
    public void Pluralize_CoversCommonForms(string input, string expected)
    {
        Assert.Equal(expected, SourceParser.Pluralize(input));
    }
}
