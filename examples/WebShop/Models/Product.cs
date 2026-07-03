using System.ComponentModel.DataAnnotations;

namespace WebShop.Models;

public class Product
{
    public int Id { get; set; }

    [Required]
    [MaxLength(200)]
    public string Name { get; set; } = null!;

    [Required]
    [MaxLength(32)]
    public string Sku { get; set; } = null!;

    public decimal Price { get; set; }

    public string? Description { get; set; }

    public int Stock { get; set; }

    public bool IsDiscontinued { get; set; }

    public int CategoryId { get; set; }
    public Category Category { get; set; } = null!;

    public ICollection<Tag> Tags { get; set; } = new List<Tag>();
    public ICollection<Review> Reviews { get; set; } = new List<Review>();

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = null!;
}
