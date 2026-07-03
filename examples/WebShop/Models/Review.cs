using System.ComponentModel.DataAnnotations;

namespace WebShop.Models;

public class Review
{
    public int Id { get; set; }

    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;

    public int? CustomerId { get; set; }
    public Customer? Customer { get; set; }

    [Range(1, 5)]
    public int Rating { get; set; }

    [MaxLength(2000)]
    public string? Body { get; set; }

    public DateTime CreatedAt { get; set; }
}
