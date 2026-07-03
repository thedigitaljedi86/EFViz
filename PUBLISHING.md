# Publishing EFViz to NuGet

EFViz ships as a **.NET global tool**. Publishing it to [nuget.org](https://www.nuget.org)
lets anyone install it with:

```bash
dotnet tool install -g EFViz
scan path/to/your/solution --open
```

There are two ways to publish: an automated GitHub Actions release (recommended) and a
manual one-off push. Both produce the exact same package.

---

## One-time setup: NuGet API key

1. Sign in at <https://www.nuget.org> (a Microsoft/GitHub login works).
2. Go to **Account → API Keys → Create**.
3. Give it:
   - **Key Name:** `EFViz release`
   - **Package Owner:** your account
   - **Scopes:** `Push` → `Push new packages and package versions`
   - **Glob Pattern:** `EFViz` (so the key can only touch this package)
4. Copy the key — it is shown only once.

> The package id `EFViz` must be free on nuget.org. The **first** push claims the id and
> ties it to your account; nobody else can publish under it afterwards. If the name is
> already taken, pick another `PackageId` in `dotnet/EFViz/EFViz.csproj` (e.g. `EFViz.Tool`
> or a prefix you own) and update the install command accordingly.

---

## Option A — Automated release (recommended)

A workflow at [`.github/workflows/release.yml`](.github/workflows/release.yml) runs the
tests, packs the tool, pushes it to NuGet, and creates a GitHub Release — all triggered by
pushing a version tag.

**Set the secret once:**

- GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `NUGET_API_KEY`
- Value: the key from above

**Then release any version by tagging:**

```bash
# bump the version in dotnet/EFViz/EFViz.csproj first (e.g. <Version>1.0.0</Version>)
git tag v1.0.0
git push origin v1.0.0
```

The tag's version (`v1.0.0` → `1.0.0`) is passed to `dotnet pack`, so the tag is the single
source of truth for the published version. Watch it run under the repo's **Actions** tab.

---

## Option B — Manual push from your machine

Requires the .NET 8 SDK.

```bash
# from the repo root
dotnet pack dotnet/EFViz/EFViz.csproj -c Release -p:ContinuousIntegrationBuild=true -o artifacts

# push the package (and its symbols) to nuget.org
dotnet nuget push "artifacts/EFViz.*.nupkg" \
  --api-key YOUR_NUGET_API_KEY \
  --source https://api.nuget.org/v3/index.json \
  --skip-duplicate
```

It usually takes a few minutes for nuget.org to index and validate the package before it is
installable.

---

## Verify the published tool

```bash
dotnet tool install -g EFViz
scan --version
scan path/to/a/solution -o diagram.html
```

To update later, bump `<Version>` (or push a new tag) and republish; users upgrade with:

```bash
dotnet tool update -g EFViz
```

---

## Releasing the npm CLI too (optional)

The identical tool is also an npm package (`efviz`). If you want to publish that as well:

```bash
npm login
npm publish        # publishes the `efviz` package with the `scan` / `efviz` commands
```

Both front ends share the same viewer and produce byte-identical output, so users can pick
whichever runtime they already have.
