# Publishing EFViz

EFViz ships as **two packages built from one codebase**:

- a **.NET global tool** on [nuget.org](https://www.nuget.org) — `dotnet tool install -g EFViz`
- an **npm CLI** on [npmjs.com](https://www.npmjs.com) — `npm install -g efviz`

Both expose the `efviz-scan` command and produce byte-identical diagrams.

Publishing is **fully automated**: every pull request that merges into `main` publishes a
new stable version to both registries. There are also manual escape hatches if you need
them.

---

## How versioning works

The published version is `MAJOR.MINOR.<run-number>`:

- `MAJOR.MINOR` is read from `<Version>` in `dotnet/EFViz/EFViz.csproj` (e.g. `1.0`).
- the patch is the GitHub Actions run number, so every run gets a unique, increasing
  version — no collisions, nothing to bump by hand for routine releases.

To start a new minor/major line, bump `<Version>` in the csproj (and `version` in
`package.json` to match) in a PR; the next merge publishes `1.1.x`, etc.

---

## One-time setup: API keys → repository secrets

Add both under **GitHub repo → Settings → Secrets and variables → Actions → New repository
secret**. Each publish step is skipped automatically until its secret exists, so the
workflow is safe to run before they are in place.

| Secret | Where to get it |
| --- | --- |
| `NUGET_API_KEY` | nuget.org → **Account → API Keys → Create**, scope **Push**, glob `EFViz` |
| `NPM_API_KEY` | npmjs.com → **Access Tokens → Generate New Token → Automation** |

> **Name claiming:** the first successful publish to each registry claims `EFViz` /
> `efviz` for your account. If a name is taken, change `<PackageId>` in the csproj or
> `name` in `package.json` and update the install commands.

---

## Continuous delivery (default) — merge a PR

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on every push to
`main`. It:

1. runs the full .NET + Node test suites (including the cross-runtime parity check),
2. packs and pushes the `EFViz` tool to NuGet,
3. sets the version and publishes `efviz` to npm.

So the normal release flow is simply:

```text
open PR  →  CI green  →  merge to main  →  new version live on NuGet + npm
```

Watch it under the repo's **Actions → Publish** tab. `dotnet nuget push` uses
`--skip-duplicate`, so re-runs are harmless.

---

## Manual alternatives

### Tag a specific version (NuGet)

[`.github/workflows/release.yml`](.github/workflows/release.yml) publishes an exact version
and cuts a GitHub Release when you push a `v*` tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

### From your machine

```bash
# NuGet (.NET 8 SDK)
dotnet pack dotnet/EFViz/EFViz.csproj -c Release -p:ContinuousIntegrationBuild=true -o artifacts
dotnet nuget push "artifacts/EFViz.*.nupkg" --api-key YOUR_NUGET_KEY \
  --source https://api.nuget.org/v3/index.json --skip-duplicate

# npm
npm publish --access public   # after `npm login`
```

---

## Verify a published release

```bash
# .NET tool
dotnet tool install -g EFViz    # or: dotnet tool update -g EFViz
efviz-scan --version

# npm CLI
npm install -g efviz            # or: npm update -g efviz
efviz-scan --version
```

Both take a few minutes to index after publishing before they are installable.
