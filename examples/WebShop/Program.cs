using Microsoft.EntityFrameworkCore;
using WebShop.Data;

var options = new DbContextOptionsBuilder<ShopContext>()
    .UseSqlServer("Server=localhost;Database=WebShop;Trusted_Connection=True;TrustServerCertificate=True")
    .Options;

using var db = new ShopContext(options);
Console.WriteLine($"WebShop sample for EFViz — {db.Model.GetEntityTypes().Count()} entity types in the model.");
