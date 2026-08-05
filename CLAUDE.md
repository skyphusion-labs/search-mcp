# CLAUDE.md -- search-mcp

Corpus / search MCP and public query Workers for skyphusion-labs. See `README.md` for product
overview and local setup.

## Conventions

- `npm run typecheck` is the CI gate: **both**
  `tsc --noEmit` (Workers: `src` + `index.test.ts`) **and**
  `tsc --noEmit -p tsconfig.scripts.json` (Node: `scripts/**/*.test.ts`). Run it before pushing.
- Conventional Commits. SemVer in root `package.json` (`0.MINOR.PATCH` while pre-1.0; trust
  `package.json` + tags).
- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs.

## What lives where

| Path | Role |
| --- | --- |
| `src/index.ts` | Public `/ask` query Worker (CORS, Turnstile, rate limit, origin profiles) |
| `src/mcp.ts` | Bearer-gated MCP Worker (`search` tool) |
| `scripts/sync.mjs` | One-target git → R2 sync + prune |
| `scripts/sync-runner.mjs` | Clone/fetch, multi-target sync, reindex (cooldown 7020 + connect 7017 retry) |
| `scripts/sync-ingest.mjs` | Extension remap, `includePaths`/`excludePaths` (top-level + per-target) |
| `scripts/guard-targets-additive.mjs` | Refuse non-additive targets.json edits (mirror-prune safety) |
| `scripts/escrow-targets.mjs` | Age-escrow + restore proof for `SKYPHUSION_TARGETS_JSON` |
| `scripts/materialize-config.mjs` | CI: write wrangler + targets from secrets |
| `scripts/corpus-boundary.mjs` | Public-target visibility / restrictedRepos checks |
| `wrangler.toml.example` / `wrangler.mcp.toml.example` | Template configs (prod skyphusion configs are secrets) |
| `wrangler.rockenhaus.toml` | **Committed** rockenhaus Worker (public court-record surface) |
| `docs/DEPLOY.md` | Generic self-host deploy |
| `docs/skyphusion/OPERATOR.md` | Skyphusion production operator guide |
| `docs/skyphusion/CUTOVER.md` | 2026-07-08 migration record (historical) |

## Release / tagging

**TAG-GATED deploy.** `.github/workflows/ci.yml`:

- Push/PR to `main`: CI only (typecheck + tests). **Does not** deploy production.
- Pushed **`v*`** tag: after CI, deploy job runs **three** Workers: public query, internal MCP,
  rockenhaus query.

Tag **must** match root `package.json` version (`vX.Y.Z` == version `X.Y.Z`). Workflow refuses a
mismatch (fc#864). Tag must be an ancestor of `origin/main`.

npm package publish: **GitHub Release published** via `publish-npm.yml` (not the deploy tag alone).

### Cut a release

1. **Release PR on `main`:** bump `package.json` version, update `CHANGELOG.md`, land the PR.
2. **Tag:**

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

3. Confirm the tag CI run's deploy job green. Verify live Workers (`/health` on all three hosts).
4. **GitHub Release:** `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md`
   (or `--generate-notes`). Publishing the Release fires `publish-npm.yml`.

Merge alone never ships.

## Crew + identity

Crew members work as their own Unix + gh identity (`sudo -u <member> bash -lc '...'`). Crew commits
use `skyphusion-<member>` identity, never Conrad's. Conrad devs only on his laptop
(`Conrad Rockenhaus <conrad@skyphusion.org>`).
