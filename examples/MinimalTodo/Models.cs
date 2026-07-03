using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace MinimalTodo;

public class TodoList
{
    public int Id { get; set; }

    [Required]
    [MaxLength(80)]
    public string Title { get; set; } = null!;

    public int OwnerId { get; set; }
    public Person Owner { get; set; } = null!;

    public ICollection<TodoItem> Items { get; set; } = new List<TodoItem>();
}

public class TodoItem
{
    public int Id { get; set; }

    [Required]
    [MaxLength(200)]
    public string Text { get; set; } = null!;

    public bool IsDone { get; set; }

    public DateTime? DueAt { get; set; }

    public int TodoListId { get; set; }
    public TodoList TodoList { get; set; } = null!;

    public int? AssigneeId { get; set; }
    public Person? Assignee { get; set; }
}

[Table("People")]
public class Person
{
    public int Id { get; set; }

    [Required]
    [MaxLength(120)]
    public string Name { get; set; } = null!;

    [MaxLength(256)]
    public string? Email { get; set; }

    public ICollection<TodoList> Lists { get; set; } = new List<TodoList>();
}
