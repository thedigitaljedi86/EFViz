using Xunit;

namespace AutoEntityDiagram.Tests;

public class SnapshotParserTests
{
    private static readonly string FinalDesigner =
        File.ReadAllText(TestPaths.Designer("20250620160800_AddReviewsAndAuditColumns.Designer.cs"));
    private static readonly string InitialDesigner =
        File.ReadAllText(TestPaths.Designer("20250110093000_InitialCreate.Designer.cs"));

    [Fact]
    public void ParsesMigrationMetadata()
    {
        var meta = SnapshotParser.ParseMigrationMeta(FinalDesigner);
        Assert.NotNull(meta);
        Assert.Equal("20250620160800_AddReviewsAndAuditColumns", meta!.Id);
        Assert.Equal("AddReviewsAndAuditColumns", meta.Name);
        Assert.Equal("2025-06-20T16:08:00", meta.Timestamp);
        Assert.Equal("ShopContext", meta.ContextType);
    }

    [Fact]
    public void DetectsProvider()
    {
        Assert.Equal("SQL Server", SnapshotParser.DetectProvider(FinalDesigner));
    }

    [Fact]
    public void ParsesAllEntities()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        Assert.Equal(
            new[] { "Category", "Customer", "Order", "OrderItem", "Product", "ProductTag", "Review", "Tag" },
            model.Entities.Select(e => e.Name).OrderBy(n => n));
        Assert.Equal("8.0.6", model.ProductVersion);
    }

    [Fact]
    public void ParsesColumnFacets()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var product = model.Entities.First(e => e.Name == "Product");

        var id = product.Columns.First(c => c.Name == "Id");
        Assert.True(id.IsIdentity);
        Assert.True(id.IsPrimaryKey);
        Assert.Equal("OnAdd", id.ValueGenerated);

        var name = product.Columns.First(c => c.Name == "Name");
        Assert.True(name.IsRequired);
        Assert.Equal(200d, name.MaxLength);
        Assert.Equal("nvarchar(200)", name.StoreType);

        var disc = product.Columns.First(c => c.Name == "IsDiscontinued");
        Assert.Equal(false, disc.DefaultValue);

        var rv = product.Columns.First(c => c.Name == "RowVersion");
        Assert.True(rv.IsConcurrencyToken);
        Assert.Equal("OnAddOrUpdate", rv.ValueGenerated);

        var desc = product.Columns.First(c => c.Name == "Description");
        Assert.False(desc.IsRequired);
    }

    [Fact]
    public void ParsesKeysAndIndexes()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var customer = model.Entities.First(e => e.Name == "Customer");
        Assert.Equal(new[] { "Id" }, customer.PrimaryKey);
        var emailIdx = customer.Indexes.First(i => string.Join(",", i.Columns) == "Email");
        Assert.True(emailIdx.IsUnique);
    }

    [Fact]
    public void FoldsOwnedTypeIntoOwner()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var customer = model.Entities.First(e => e.Name == "Customer");
        var street = customer.Columns.First(c => c.ColumnName == "Address_Street");
        Assert.True(street.Owned);
        Assert.Equal(200d, street.MaxLength);
        Assert.Single(customer.OwnedTypes);
        Assert.Equal("Address", customer.OwnedTypes[0].Navigation);
        Assert.DoesNotContain(model.Entities, e => e.Name == "Address");
    }

    [Fact]
    public void ParsesRelationshipsWithDeleteBehavior()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var orderCustomer = model.Relationships.First(r =>
            r.Dependent.EndsWith("Order") && r.Principal.EndsWith("Customer"));
        Assert.Equal("many-to-one", orderCustomer.Type);
        Assert.Equal("Restrict", orderCustomer.OnDelete);
        Assert.True(orderCustomer.IsRequired);
        Assert.Equal(new[] { "CustomerId" }, orderCustomer.ForeignKey);

        var reviewCustomer = model.Relationships.First(r =>
            r.Dependent.EndsWith("Review") && r.Principal.EndsWith("Customer"));
        Assert.Equal("SetNull", reviewCustomer.OnDelete);
        Assert.False(reviewCustomer.IsRequired);
    }

    [Fact]
    public void DetectsManyToManyJoinEntity()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var join = model.Entities.First(e => e.Name == "ProductTag");
        Assert.True(join.IsJoinTable);
        var m2m = model.Relationships.First(r => r.Type == "many-to-many");
        Assert.Equal("ProductTag", m2m.Via);
    }

    [Fact]
    public void PreservesSelfReference()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        var selfRef = model.Relationships.First(r =>
            r.Dependent == r.Principal && r.Dependent.EndsWith("Category"));
        Assert.Equal(new[] { "ParentCategoryId" }, selfRef.ForeignKey);
    }

    [Fact]
    public void CountsSeedData()
    {
        var model = SnapshotParser.ParseSnapshotModel(FinalDesigner);
        Assert.Equal(2, model.Entities.First(e => e.Name == "Tag").SeedCount);
    }

    [Fact]
    public void InitialDesignerHasLegacyColumnAndOldPrecision()
    {
        var model = SnapshotParser.ParseSnapshotModel(InitialDesigner);
        Assert.Equal(5, model.Entities.Count);
        var product = model.Entities.First(e => e.Name == "Product");
        Assert.Contains(product.Columns, c => c.Name == "LegacyCode");
        Assert.Equal("decimal(10,2)", product.Columns.First(c => c.Name == "Price").StoreType);
    }
}
