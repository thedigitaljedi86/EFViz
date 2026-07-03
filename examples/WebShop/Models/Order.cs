using System.ComponentModel.DataAnnotations;

namespace WebShop.Models;

public enum OrderStatus
{
    Pending = 0,
    Paid = 1,
    Shipped = 2,
    Completed = 3,
    Cancelled = 4
}

public class Order
{
    public int Id { get; set; }

    [Required]
    [MaxLength(20)]
    public string OrderNumber { get; set; } = null!;

    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;

    public OrderStatus Status { get; set; }

    public DateTime PlacedAt { get; set; }

    public decimal Total { get; set; }

    public ICollection<OrderItem> Items { get; set; } = new List<OrderItem>();
}
