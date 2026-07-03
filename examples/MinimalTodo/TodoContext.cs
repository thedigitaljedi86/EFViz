using Microsoft.EntityFrameworkCore;

namespace MinimalTodo;

public class TodoContext : DbContext
{
    public DbSet<TodoList> Lists { get; set; } = null!;
    public DbSet<TodoItem> Items { get; set; } = null!;
    public DbSet<Person> People { get; set; } = null!;
}
