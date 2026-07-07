# EFViz.MSBuild

**Build-pipeline ER diagrams for Entity Framework Core — no tool install required.**

`EFViz.MSBuild` is a build-only NuGet package. Add it to your EF Core project and
every `dotnet build` regenerates a self-contained, interactive HTML ER diagram
(entities, relationships and a scrubable migration timeline) straight from your
`DbContext`s and migrations.

Unlike the [`EFViz`](https://www.nuget.org/packages/EFViz) global tool, nothing is
installed on the machine: the scanner binaries ship inside this package and are
run via `dotnet exec`. All a build agent needs is the **.NET 8 runtime**, which is
already there if it can build the project. That makes it a drop-in fit for CI /
build pipelines.

## Install

```bash
dotnet add package EFViz.MSBuild
```

This adds a build-only reference (it never flows to your package's consumers and
ships nothing into your output):

```xml
<PackageReference Include="EFViz.MSBuild" Version="1.0.*" PrivateAssets="all" />
```

Then just build — the diagram appears next to your project:

```bash
dotnet build
# → entity-diagram.html
```

In a pipeline there is no extra step: your existing `dotnet build` produces the
diagram. Publish it as a build artifact, commit it to docs, etc.

## Configuration

Set any of these MSBuild properties in your `.csproj` or on the command line
(`dotnet build -p:EFVizOutput=docs/db.html`):

| Property | Default | Description |
| --- | --- | --- |
| `EFVizEnabled` | `true` | Master switch; `false` disables everything. |
| `EFVizRunOnBuild` | `true` | Run automatically after `Build`. |
| `EFVizScanPath` | project dir | Directory to scan for `DbContext`s and migrations. |
| `EFVizOutput` | `entity-diagram.html` | Output HTML file. |
| `EFVizContext` | *(all)* | Restrict to a single `DbContext` by name. |
| `EFVizTitle` | *(none)* | Title shown in the diagram header. |
| `EFVizJson` | *(none)* | Also write the raw model + diff data as JSON. |
| `EFVizContinueOnError` | `false` | Warn instead of failing the build on error. |

Example — write into `docs/`, only the orders context, don't fail the build:

```xml
<PropertyGroup>
  <EFVizOutput>$(MSBuildProjectDirectory)/docs/db-diagram.html</EFVizOutput>
  <EFVizContext>OrdersContext</EFVizContext>
  <EFVizContinueOnError>true</EFVizContinueOnError>
</PropertyGroup>
```

### Run on demand instead of every build

Set `EFVizRunOnBuild` to `false` and invoke the target explicitly:

```bash
dotnet build -t:EFVizGenerateDiagram
```

## Prefer an explicit command? Use the .NET local tool instead

If you'd rather have an explicit pipeline step than build integration, the same
scanner is available as a [local tool](https://learn.microsoft.com/dotnet/core/tools/local-tools)
— also with no global install:

```bash
dotnet new tool-manifest          # once, creates .config/dotnet-tools.json
dotnet tool install EFViz         # adds it to the manifest (commit the file)

# in the pipeline:
dotnet tool restore
dotnet efviz-scan ./src -o docs/db-diagram.html
```

---

Part of [EFViz](https://github.com/thedigitaljedi86/EFViz). MIT licensed.
