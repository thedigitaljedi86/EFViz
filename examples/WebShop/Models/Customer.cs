using System.ComponentModel.DataAnnotations;

namespace WebShop.Models;

public class Customer
{
    public int Id { get; set; }

    [Required]
    [MaxLength(256)]
    public string Email { get; set; } = null!;

    [MaxLength(150)]
    public string? FullName { get; set; }

    public int LoyaltyPoints { get; set; }

    public Address? Address { get; set; }

    public DateTime CreatedAt { get; set; }

    public ICollection<Order> Orders { get; set; } = new List<Order>();
}
