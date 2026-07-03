using Xunit;

namespace EFViz.Tests;

public class DifferTests
{
    private static Model Load(string file) =>
        SnapshotParser.ParseSnapshotModel(File.ReadAllText(TestPaths.Designer(file)));

    private static readonly Model M1 = Load("20250110093000_InitialCreate.Designer.cs");
    private static readonly Model M2 = Load("20250214141500_AddCustomerAddressAndCategoryTree.Designer.cs");
    private static readonly Model M3 = Load("20250401110200_AddProductTags.Designer.cs");
    private static readonly Model M4 = Load("20250620160800_AddReviewsAndAuditColumns.Designer.cs");

    [Fact]
    public void DiffAgainstNothing_MarksEverythingAdded()
    {
        var d = Differ.DiffModels(null, M1);
        Assert.Equal(5, d.AddedEntities.Count);
        Assert.Empty(d.RemovedEntities);
    }

    [Fact]
    public void OwnedTypeAndSelfReference_ShowAsColumnIndexAndRelationshipChanges()
    {
        var d = Differ.DiffModels(M1, M2);
        Assert.Empty(d.AddedEntities);
        var customer = d.ModifiedEntities.First(e => e.Name == "Customer");
        Assert.Contains("LoyaltyPoints", customer.AddedColumns);
        Assert.Contains("Address.Street", customer.AddedColumns);
        Assert.Contains(customer.AddedIndexes, i => i.Contains("unique") && i.Contains("Email"));
        var category = d.ModifiedEntities.First(e => e.Name == "Category");
        Assert.Equal(new[] { "ParentCategoryId" }, category.AddedColumns);
        Assert.Contains(d.AddedRelationships, r =>
            r.Dependent.EndsWith("Category") && r.Principal.EndsWith("Category"));
    }

    [Fact]
    public void NewJoinTable_ShowsAddedEntitiesAndManyToMany()
    {
        var d = Differ.DiffModels(M2, M3);
        Assert.Equal(new[] { "ProductTag", "Tag" }, d.AddedEntities.Select(e => e.Split('.')[^1]).OrderBy(n => n));
        Assert.Contains(d.AddedRelationships, r => r.Type == "many-to-many");
    }

    [Fact]
    public void ColumnRemovalTypeChangeAndAdditions_AllDetected()
    {
        var d = Differ.DiffModels(M3, M4);
        var product = d.ModifiedEntities.First(e => e.Name == "Product");
        Assert.Equal(new[] { "LegacyCode" }, product.RemovedColumns);
        Assert.Contains("RowVersion", product.AddedColumns);
        var price = product.ModifiedColumns.First(c => c.ColumnName == "Price");
        Assert.Contains(price.Changes, ch => ch.Field == "storeType" && (string?)ch.To == "decimal(18,2)");
        Assert.Contains(d.AddedEntities, e => e.EndsWith("Review"));
        Assert.True(d.ChangeCount > 0);
    }

    [Fact]
    public void IdenticalModels_ProduceEmptyDiff()
    {
        var d = Differ.DiffModels(M4, M4);
        Assert.Equal(0, d.ChangeCount);
        Assert.Empty(d.ModifiedEntities);
    }
}
