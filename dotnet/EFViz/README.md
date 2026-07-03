# EFViz

Zero-config interactive ER diagrams for Entity Framework Core — straight from your code.

```bash
dotnet tool install -g EFViz
scan path/to/your/solution --open
```

Scans the workspace for `DbContext` classes and migrations, reads a complete model snapshot
per migration, and generates a single self-contained HTML file: an interactive
entity-relationship diagram with pan/zoom, entity details, themes + dark mode, and a
migration timeline you can scrub back and forth to see how the schema evolved.

Run the same command again whenever new migrations land to refresh the diagram.
No build and no database connection required — parsing is purely static.

Documentation, screenshots and source: https://github.com/thedigitaljedi86/AutoEntityDiagram
