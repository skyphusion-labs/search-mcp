# search-mcp

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Typecheck](https://github.com/skyphusion-labs/search-mcp/actions/workflows/typecheck.yml/badge.svg)](https://github.com/skyphusion-labs/search-mcp/actions/workflows/typecheck.yml)
[![CI](https://github.com/skyphusion-labs/search-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/skyphusion-labs/search-mcp/actions/workflows/ci.yml)

Open-source toolkit for [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/):

1. **MCP Worker** (`src/mcp.ts`) -- bearer-gated Streamable-HTTP MCP for agents:
   `search`, `list_repos`, `get_file`, `ask`, `corpus_status`, plus `corpus://` resources.
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

npm run typecheck   # src + index.test.ts (Workers types) AND scripts/**/*.test.ts (Node types)
npm test
```

Provision R2 + AI Search, sync your corpus, deploy both Workers. Step-by-step: [docs/DEPLOY.md](docs/DEPLOY.md).

## Skyphusion production

This repo is the production home for three AI Search surfaces:

| Surface | Host | Worker config |
| --- | --- | --- |
| Public docs / marketing | `search.vivijure.com` | secret `SKYPHUSION_WRANGLER_TOML` → `wrangler.toml` at CI |
| Internal MCP | `search-internal.vivijure.com` | secret `SKYPHUSION_WRANGLER_MCP_TOML` |
| Rockenhaus court records | `search.rockenhaus.net` | committed `wrangler.rockenhaus.toml` |

Do not commit `wrangler.toml`, `wrangler.mcp.toml`, or `scripts/targets.json` (gitignored).
Rockenhaus is the exception: its wrangler file is public and tracked.

- [Operator runbook](docs/skyphusion/OPERATOR.md) -- secrets, topology shape, escrow, reindex
- [Cutover record (2026-07-08)](docs/skyphusion/CUTOVER.md) -- migration history (historical)

## Workers

| Worker | Entry | Endpoint | Auth |
| --- | --- | --- | --- |
| Query (public) | `wrangler.toml` | `POST /ask`, `GET /health` | Turnstile (optional) + CORS allowlist |
| MCP (internal) | `wrangler.mcp.toml` | `POST /mcp`, `GET /health` | `Authorization: Bearer` (fail closed) |
| Query (rockenhaus) | `wrangler.rockenhaus.toml` | `POST /ask`, `GET /health` | CORS allowlist (court-record origins) |

Deploy separately so browser traffic and agent traffic can bind different AI Search instances.

```sh
npm run deploy              # public query Worker
npm run deploy:mcp          # MCP Worker
npm run deploy:rockenhaus   # rockenhaus query Worker (uses committed wrangler file)
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

### MCP tools (agents)

| Tool | Role |
| --- | --- |
| `list_repos` | Exact repo names for filters (`CORPUS_REPOS` or R2 prefixes) |
| `search` | Hybrid/keyword/vector chunks; optional `repos`, `path_prefix`, `min_score`, `rewrite` |
| `get_file` | Capped R2 read by `repo` + `path` (needs `CORPUS` binding) |
| `ask` | One grounded answer via chatCompletions + source list |
| `corpus_status` | Last sync metadata (`_meta/corpus-status.json` from `sync.mjs`) |

Resources: `corpus://catalog`, `corpus://skill`. Prefer **list_repos → search → get_file**; use **ask** when you want prose rather than raw chunks.

Bind the same R2 bucket the sync uploads to as `CORPUS` on the MCP Worker so `get_file` and status work. Optional `CORPUS_REPOS` JSON pins the catalog without listing R2.

## Corpus sync

```sh
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... CLOUDFLARE_ACCOUNT_ID=...
export CORPUS_GIT_ORG=your-org GITHUB_TOKEN=...   # for sync-runner clone auth

npm run sync:dry          # plan upload for the default `corpus` target
npm run sync              # upload + prune
npm run sync:public       # skyphusion public target (when targets.json has it)
npm run sync:internal     # skyphusion internal target
npm run sync:rockenhaus   # rockenhaus target
npm run sync:run          # isolated clone root, sync all targets, optional reindex
```

Useful npm scripts (also `npx` CLIs for the first two after install):

| Script | Role |
| --- | --- |
| `search-mcp-sync` / `npm run sync` | One-target R2 sync |
| `search-mcp-sync-run` / `npm run sync:run` | Clone/fetch + multi-target + reindex |
| `npm run guard:targets` | Additive-only targets.json check |
| `npm run escrow` | Age-escrow + restore proof for targets secret |
| `npm run materialize-config` | CI: write wrangler + targets from env secrets |

The sync remaps non-native extensions (`.ts`, `.tsx`, extensionless `Dockerfile`, `.service`, etc.) to `.txt` keys so AI Search indexes them. See `scripts/sync-ingest.mjs`.

### Bounding a corpus: `includePaths` vs `excludePaths`

`excludePaths` is a denylist and is **fail-open**: add a new top-level file to a
repo and it silently joins the corpus. That is fine for a docs site. It is wrong
whenever the corpus boundary actually matters, because "we forgot to exclude it"
becomes a real incident.

`includePaths` / `excludePaths` may sit at the **top level** (same rule for every
target that lists the repo) or **nested under a target** (search-mcp#62). When
both set the same repo, the per-target map wins for that target only -- so a
repo can be full-tree on internal and `_corpus/`-only on a public court surface.

`includePaths` is an allowlist and is **fail-closed**: when a repo has an entry,
only paths under those prefixes are eligible and everything else is refused.

```json
{
  "includePaths": { "my-repo": ["docs/", "_corpus/"] },
  "excludePaths": { "my-repo": ["docs/internal/"] }
}
```

The two compose subtractively: `includePaths` decides what is eligible, then
`excludePaths` subtracts from that. A denylist entry can never add a path back.

Omit a repo from `includePaths` to keep the previous behaviour. An entry that is
present but **empty** (`[]`) is a configuration error, not a way to say "index
nothing": those are different states and collapsing them into the permissive one
is how a whole repo joins a corpus by accident.

#### A present allowlist must earn its keep

An allowlist that quietly matches nothing is worse than no allowlist. The sync
plans zero objects, the mirror prune deletes the corpus that was there, the
reindex succeeds over nothing, and the answer surface returns a confident nothing
with every status light green. So each of these refuses the run (exit 2) before
anything uploads or is pruned:

| Refusal | Meaning |
| --- | --- |
| `include_paths_no_match` | An entry matched zero git-tracked files (a typo, or a directory that moved) |
| `include_paths_entry_empty` | The entry is `[]` |
| `include_paths_entry_invalid` | An entry cannot match a git path (absolute, `..`, backslash, non-string) |
| `include_paths_entry_not_array` / `include_paths_not_object` | Wrong config shape |
| `include_paths_unknown_repo` | The entry names a repo no target lists, so nothing reads it |
| `include_paths_repo_not_cloned` | An allowlisted repo is missing from the clone root |
| `include_paths_all_excluded` | `excludePaths` removed everything the allowlist selected |
| `include_paths_all_filtered` | Nothing the allowlist selected survived the ingest filters |

Shape and repo-name checks run for **every** target on every sync, not just the
one being synced, so a rule that has rotted is caught by the next run of any
target. A stale `excludePaths` repo name warns rather than refuses: denylist rot
grows a corpus, allowlist rot empties one.

Verify what a target will actually upload before you trust it:

```sh
node scripts/sync.mjs my-target --dry-run
```

### Size cap

Objects over `SYNC_MAX_BYTES` (default 4 MB) are skipped. Skips are summarised at
the end of the run, not only warned inline, because a file silently missing from
the corpus looks exactly like a file the corpus does not contain -- the worst
failure mode for something that answers questions. Pass `--fail-on-skip` to turn
an incomplete corpus into a failed run.

```sh
SYNC_MAX_BYTES=$((16 * 1024 * 1024)) node scripts/sync.mjs corpus --fail-on-skip
```

### Corpus manifest (optional)

A corpus producer can publish a `manifest.json` next to its objects so the widget
renders citations instead of raw R2 keys. Entries need a `key`; `title`, `url`,
`page`, and `total_pages` are used when present:

```json
{ "pages": [
  { "key": "my-doc/p003.txt", "title": "Deploy guide", "url": "/docs/deploy/", "page": 3, "total_pages": 12 }
] }
```

Keys are matched exactly first, then by **suffix**, because the sync namespaces
every object under its repo name (`<repo>/<path>`) while a producer naturally
writes its manifest in terms of its own paths.

### Reindex dispatch

AI Search rejects a new reindex job for two distinct reasons, and `sync-runner` clears both
before dispatching:

1. **A job is in flight.** Firing anyway does not queue behind it; Cloudflare ends the running
   job with `end_reason: "new_job_has_started"` and restarts. So we wait for `ended_at`.
2. **The post-job cooldown.** Even once a job ends, a new one is refused for a cooldown window
   with `sync_in_cooldown [code: 7020]`. Waiting for the job to end is necessary but not
   sufficient, so we retry until it clears.
3. **Transient connect failures.** `unable_to_connect_to_ai_search [code: 7017]` on jobs create
   is retried under the same budget as cooldown (search-mcp#73). Treating it as terminal made
   the whole sync red while R2 already had the new objects.

Waiting (rather than skipping) means the job we start always lands strictly after our own
upload, so it sees every object this run wrote. Merge bursts still coalesce: a waiting run holds
the workflow concurrency group, and GitHub keeps only the newest queued run, so the runs behind
it collapse instead of each firing their own reindex.

Each wait has its own budget (10 min in-flight, 10 min cooldown/connect) rather than one shared
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
        data-manifest="/corpus-manifest.json"
        data-empty-text="Nothing in the indexed corpus addresses that."
        data-sitekey="YOUR_TURNSTILE_SITEKEY"></script>
```

`data-manifest` is optional; without it sources render as raw object keys. A
missing or malformed manifest degrades to raw keys rather than breaking answers.

`data-empty-text` is shown when a query returns no retrieved sources, so an
unsourced answer is never left on screen looking authoritative.

### Per-site system prompts

One deployment can serve several sites. `ORIGIN_PROFILES` is a JSON object in
`[vars]` mapping an exact request `Origin` to that site's system prompt:

```toml
ORIGIN_PROFILES = '{"https://docs.example.com":"You are the docs assistant...","https://other.example":"You are..."}'
```

Precedence is `ORIGIN_PROFILES`, then the legacy blog special-case, then
`ASSISTANT_SYSTEM_PROMPT`. A malformed value is logged and ignored so a bad var
cannot take `/ask` down.

## Who this is for

Operators building documentation search, agent tooling, or internal knowledge bases on [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) with MCP and a browser widget.

## Links

- **Deploy guide:** [docs/DEPLOY.md](docs/DEPLOY.md)
- **Live ask UIs:** [skyphusion.net/search](https://skyphusion.net/search/) · [vivijure.com](https://vivijure.com) (ask widget)
- **Skyphusion Labs:** https://skyphusion.org · **Blog:** https://skyphusion.net · **Org:** https://github.com/skyphusion-labs
- **Related:** [vivijure](https://github.com/skyphusion-labs/vivijure), [postern](https://github.com/skyphusion-labs/postern), [security-audit](https://github.com/skyphusion-labs/security-audit), [prism](https://github.com/skyphusion-labs/prism)

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

## Community

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
