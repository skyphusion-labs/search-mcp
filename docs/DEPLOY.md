# Deploy guide

End-to-end setup for search-mcp on Cloudflare. Replace every `example.com` / `my-*` placeholder with your values.

## 1. Prerequisites

- Cloudflare account with Workers, R2, and AI Search enabled
- `wrangler` logged in (`npx wrangler login`)
- Git repos you want indexed, cloned locally or reachable via `sync-runner.mjs`

## 2. R2 bucket

```sh
npx wrangler r2 bucket create my-search-corpus
```

Create a scoped R2 API token (Object Read & Write on this bucket only). Export:

```sh
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

## 3. AI Search instance

```sh
npx wrangler ai-search create my-ai-search-instance --type r2 --source my-search-corpus
```

Note the instance name; it goes in both wrangler configs and `scripts/targets.json`.

## 4. Corpus config

```sh
cp scripts/targets.json.example scripts/targets.json
# npm install: copy targets.json.example to ./targets.json in your project root
```

Edit `repos` (directory names under `SYNC_REPO_ROOT`), `bucket`, and `instance`. Default clone root is the parent of this repo when `targets.json` lives under `scripts/`; with the npm CLIs it is the current working directory.

### Manual sync (local clones)

Clone repos as siblings of this project (or set `SYNC_REPO_ROOT`):

```sh
npm run sync:dry
npm run sync
npx wrangler ai-search jobs create my-ai-search-instance
```

### Automated sync (CI or cron)

`scripts/sync-runner.mjs` uses an isolated `CORPUS_ROOT`, clone-or-fetch per repo, sync, then reindex:

```sh
export CORPUS_GIT_ORG=your-github-org
export GITHUB_TOKEN=...    # Contents read on source repos
npm run sync:run
```

Optional: copy `docs/notify-corpus-sync.snippet.yml` into a source repo's CI to fire a `repository_dispatch` on merge (see snippet comments).

## 5. Query Worker

```sh
cp wrangler.toml.example wrangler.toml
```

Set `instance_name`, `ALLOWED_ORIGINS`, and optional `ASSISTANT_SYSTEM_PROMPT`. Add a `[[routes]]` block or use the `*.workers.dev` URL.

```sh
npm run deploy
curl "https://YOUR_QUERY_HOST/health"
```

Turnstile (recommended for public `/ask`):

1. Create a widget for your docs domain in the Cloudflare dashboard.
2. `wrangler secret put TURNSTILE_SECRET`
3. Load the Turnstile script on pages that embed the ask widget.

## 6. MCP Worker

```sh
cp wrangler.mcp.toml.example wrangler.mcp.toml
umask 077 && openssl rand -hex 32 > /tmp/mcp-token
wrangler secret put MCP_TOKEN -c wrangler.mcp.toml < /tmp/mcp-token
rm /tmp/mcp-token
npm run deploy:mcp
```

Test:

```sh
curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "https://YOUR_MCP_HOST/mcp"
```

## 7. Separate instances (optional)

Run the query Worker and MCP Worker against different AI Search instances when you want browser Q&A and agent retrieval on different corpora. Use two R2 buckets, two instances, and different `instance_name` values in each wrangler file.

### Third query surface (rockenhaus pattern)

A second public query Worker can share `src/index.ts` with its own wrangler file, AI Search
instance, and R2 bucket. This repo ships that pattern as `wrangler.rockenhaus.toml` +
`npm run deploy:rockenhaus` / `npm run sync:rockenhaus`. For your own product:

1. Create bucket + AI Search instance.
2. Add a target in `targets.json` (optionally with nested `includePaths` for a fail-closed
   allowlist -- search-mcp#62).
3. Copy `wrangler.rockenhaus.toml` as a template, set `instance_name`, origins, route.
4. Deploy with `wrangler deploy -c your.toml`.

### Path bounds in `targets.json`

- **Top-level** `includePaths` / `excludePaths`: same rule for every target that lists the repo.
- **Nested under a target**: only that target; wins per-repo when both layers set the same key.
- An empty allowlist entry (`[]`) is an error. An entry that matches zero tracked files refuses
  the sync (exit 2) so a rename cannot silently empty a live corpus.

See README "Bounding a corpus" and `scripts/targets.json.example`.

## 8. CI and release

This repo is **public**. GitHub-hosted `ubuntu-latest` runners only (the org fleet pool does
not accept public-repo jobs).

| Trigger | What runs |
| --- | --- |
| PR / push to `main` | `typecheck` (Workers + scripts projects) + `vitest` (+ coverage / CodeQL as configured) |
| Tag `v*` on `main` | After CI: materialize config from secrets, deploy public query + internal MCP Workers |
| Manual | `npm run deploy:rockenhaus` with a token that can manage routes on rockenhaus.net |
| GitHub Release published | `publish-npm.yml` publishes `@skyphusion/search-mcp` |

Tag must match `package.json` version. Merge alone never deploys. Skyphusion operators:
[docs/skyphusion/OPERATOR.md](docs/skyphusion/OPERATOR.md).

### Workflows in `.github/workflows/`

| Workflow | Role |
| --- | --- |
| `ci.yml` | PR/main typecheck + tests; tag `v*` deploy (three Workers) |
| `typecheck.yml` | Standalone typecheck (badge) |
| `code-coverage.yml` | Coverage report on PRs |
| `adversarial-audit.yml` | LLM red-team advisory (not a merge gate) |
| `corpus-sync.yml` | Merge-driven + daily R2 sync and reindex |
| `corpus-notify.yml` | Template/reference for constellation repos (also `docs/corpus-notify.workflow.yml`) |
| `escrow-targets.yml` | Prove-only targets escrow on this public repo (publish default off; prefer crew-secrets) |
| `publish-npm.yml` | Publish `@skyphusion/search-mcp` on GitHub Release |

## 9. Operator tooling (git clone, not npm)

These live under `scripts/` for people who hold production secrets; they are not required for a
simple self-host from the npm package:

| Script | Role |
| --- | --- |
| `materialize-config.mjs` | Write wrangler + targets from CI env secrets |
| `guard-targets-additive.mjs` | Refuse non-additive `targets.json` edits (mirror-prune safety) |
| `escrow-targets.mjs` | Age-escrow + restore proof for `SKYPHUSION_TARGETS_JSON` |
| `corpus-boundary.mjs` | Public-target visibility / restrictedRepos checks (used by sync) |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Empty search results | R2 objects present? `npx wrangler ai-search stats INSTANCE` |
| Sync exits 2 with `include_paths_*` | An `includePaths` allowlist matched nothing, named an unknown repo, or was emptied by `excludePaths`. The message names the repo and the prefix; fix `targets.json` and re-run |
| TypeScript not indexed | Sync remaps to `.txt`; re-run sync + reindex job |
| Reindex red after green R2 upload | Cooldown `7020` or connect `7017` -- `sync-runner` retries both; wait or re-run reindex-only |
| MCP 401 | `MCP_TOKEN` set? Bearer header exact match? |
| `/ask` 403 origin | `ALLOWED_ORIGINS` includes the page origin |
| `/ask` 403 turnstile | `TURNSTILE_SECRET` set and widget sitekey matches |
| `hybrid_search` still null after update | Open-beta gap: flag accepted, not persisted (see OPERATOR.md) |
