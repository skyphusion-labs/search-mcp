# search-mcp

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Typecheck](https://github.com/skyphusion-labs/search-mcp/actions/workflows/typecheck.yml/badge.svg)](https://github.com/skyphusion-labs/search-mcp/actions/workflows/typecheck.yml)
[![CI](https://github.com/skyphusion-labs/search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/skyphusion-labs/search-mcp/actions/workflows/ci.yml)

Open-source toolkit for [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/):

1. **MCP Worker** (`src/mcp.ts`) -- bearer-gated Streamable-HTTP MCP with a `search` tool for agents.
2. **Query Worker** (`src/index.ts`) -- CORS + Turnstile + rate-limited `POST /ask` that streams answers for a browser widget.
3. **Corpus sync** (`scripts/sync.mjs`, `scripts/sync-runner.mjs`) -- git-tracked sources to R2, with extension remapping so TypeScript, Dockerfiles, and other text AI Search would otherwise skip get indexed.

```
git repos  ->  sync.mjs  ->  R2 bucket  ->  AI Search instance  ->  /ask + /mcp
```

## Install (npm)

The corpus sync CLIs and ask-widget assets ship on npm as **`@skyphusion/search-mcp`** (the unscoped name `search-mcp` is taken by another project).

```sh
npm install @skyphusion/search-mcp
# or run without installing:
npx --package=@skyphusion/search-mcp search-mcp-sync corpus --dry-run
```

| Command | Role |
| --- | --- |
| `search-mcp-sync` | Upload git-tracked corpus files to R2 for one target |
| `search-mcp-sync-run` | Clone/fetch repos, sync all targets, optional reindex |

Put `targets.json` in your project root (copy from `node_modules/@skyphusion/search-mcp/scripts/targets.json.example`) or set `SEARCH_MCP_TARGETS`. Clone roots default to the current working directory; override with `SYNC_REPO_ROOT`.

Widget assets after install:

```sh
cp node_modules/@skyphusion/search-mcp/public/ask-widget.{js,css} ./docs/
```

Workers (`src/`) deploy from a git clone; see [docs/DEPLOY.md](docs/DEPLOY.md).

## Quick start (from source)

```sh
npm install
cp wrangler.toml.example wrangler.toml
cp wrangler.mcp.toml.example wrangler.mcp.toml
cp scripts/targets.json.example scripts/targets.json
# edit the three files for your account, instance, bucket, and repos

npm run typecheck
npm test
```

Provision R2 + AI Search, sync your corpus, deploy both Workers. Step-by-step: [docs/DEPLOY.md](docs/DEPLOY.md).

## Skyphusion production

This repo is the production home for Skyphusion AI Search (`search.vivijure.com`,
`search-internal.vivijure.com`). Config is materialized from GitHub Actions secrets at deploy/sync
time; do not commit `wrangler.toml`, `wrangler.mcp.toml`, or `scripts/targets.json`.

- [Operator runbook](docs/skyphusion/OPERATOR.md) -- secrets, topology, bootstrap
- [Cutover record (2026-07-08)](docs/skyphusion/CUTOVER.md) -- migration history, failure log, archive steps

## Workers

| Worker | Entry | Endpoint | Auth |
| --- | --- | --- | --- |
| Query | `wrangler.toml` | `POST /ask`, `GET /health` | Turnstile (optional) + CORS allowlist |
| MCP | `wrangler.mcp.toml` | `POST /mcp`, `GET /health` | `Authorization: Bearer` (fail closed) |

Deploy separately so browser traffic and agent traffic can bind different AI Search instances if you want.

```sh
npm run deploy       # query Worker
npm run deploy:mcp   # MCP Worker
wrangler secret put MCP_TOKEN -c wrangler.mcp.toml
wrangler secret put TURNSTILE_SECRET   # optional; skips verification when unset
```

### MCP client wiring

```json
{
  "mcpServers": {
    "search-mcp": {
      "type": "http",
      "url": "https://YOUR_MCP_HOST/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

`MCP_TOKEN` accepts a single token or comma-separated `name=token` pairs for per-consumer attribution in logs.

## Corpus sync

```sh
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... CLOUDFLARE_ACCOUNT_ID=...
export CORPUS_GIT_ORG=your-org GITHUB_TOKEN=...   # for sync-runner clone auth

npm run sync:dry     # plan upload for the default `corpus` target
npm run sync         # upload + prune
npm run sync:run     # isolated clone root, sync all targets, optional reindex
```

The sync remaps non-native extensions (`.ts`, `.tsx`, extensionless `Dockerfile`, `.service`, etc.) to `.txt` keys so AI Search indexes them. See `scripts/sync-ingest.mjs`.

### Reindex dispatch

AI Search rejects a new reindex job for two distinct reasons, and `sync-runner` clears both
before dispatching:

1. **A job is in flight.** Firing anyway does not queue behind it; Cloudflare ends the running
   job with `end_reason: "new_job_has_started"` and restarts. So we wait for `ended_at`.
2. **The post-job cooldown.** Even once a job ends, a new one is refused for a cooldown window
   with `sync_in_cooldown [code: 7020]`. Waiting for the job to end is necessary but not
   sufficient, so we retry until it clears.

Waiting (rather than skipping) means the job we start always lands strictly after our own
upload, so it sees every object this run wrote. Merge bursts still coalesce: a waiting run holds
the workflow concurrency group, and GitHub keeps only the newest queued run, so the runs behind
it collapse instead of each firing their own reindex.

Each wait has its own budget (10 min in-flight, 10 min cooldown) rather than one shared
deadline, since the two are additive on a perfectly healthy path: a run can wait minutes for an
in-flight reindex and then still owe a cooldown wait.

The measured cooldown is short (rejected at 10s after a job ends, accepted at 32s), so the
budgets are far larger than they need to be today. That is deliberate. The measurement is an
observation, not a contract, and a budget sized to it would turn ordinary upstream variance into
red builds. If a budget is exhausted the run fails loudly and says what it means: the R2 corpus
uploaded fine, nothing is lost, the index lags until the next sync or the daily backstop.

## Ask widget

Copy `public/ask-widget.js` and `public/ask-widget.css` to your docs site:

```html
<div id="docs-ask"></div>
<script defer src="/ask-widget.js"
        data-endpoint="https://search.example.com/ask"
        data-target="#docs-ask"
        data-label="Ask the docs"
        data-sitekey="YOUR_TURNSTILE_SITEKEY"></script>
```

## Who this is for

Operators building documentation search, agent tooling, or internal knowledge bases on [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) with MCP and a browser widget.

## Links

- **Deploy guide:** [docs/DEPLOY.md](docs/DEPLOY.md)
- **Skyphusion Labs:** https://skyphusion.org · **Org:** https://github.com/skyphusion-labs
- **Related:** [vivijure](https://github.com/skyphusion-labs/vivijure), [postern](https://github.com/skyphusion-labs/postern)

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

## Community

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
