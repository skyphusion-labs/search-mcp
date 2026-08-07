# Changelog

## v0.5.0

MINOR: agent-facing MCP surface. Retrieval stays structured; agents can map the
corpus, filter paths, open files, ask grounded questions, and read sync status.

### Features (MCP Worker)

- **Tools:** `search` (expanded), `list_repos`, `get_file`, `ask`, `corpus_status`.
- **search knobs:** `path_prefix`, `retrieval_type` (hybrid/keyword/vector),
  `rewrite`, `min_score`, `rerank`; richer tool description for agent routing.
- **get_file:** optional `CORPUS` R2 binding; size-capped reads; tries bare key and
  `.txt` remapped keys.
- **ask:** non-stream `chatCompletions` with source list from returned chunks.
- **corpus_status:** reads `_meta/corpus-status.json` written by `scripts/sync.mjs`.
- **MCP resources:** `corpus://catalog`, `corpus://skill` (`resources/list` +
  `resources/read`).
- **list_repos:** `CORPUS_REPOS` var (JSON/CSV) or R2 prefix scan when `CORPUS` bound.

### Sync

- After upload+prune, write `_meta/corpus-status.json` and never prune `_meta/*`.

### Config

- `wrangler.mcp.toml.example`: optional `CORPUS` R2 + `CORPUS_REPOS` / generation vars.

## v0.4.0

MINOR: per-target path maps, dual typecheck gate, rockenhaus deployment surface, reindex
connect retry, operator escrow relocate, docs brought to parity with the tree.

### Features

- **Per-target `includePaths` / `excludePaths`** (search-mcp#62). Nested maps under a
  target win per-repo over top-level maps so the same repo can be indexed at different
  granularities across targets. `pathMapsForTarget`, validation, and the additive guard
  all understand both layers.
- **Rockenhaus court-record deployment** (search-mcp#58). Committed
  `wrangler.rockenhaus.toml`, npm scripts `deploy:rockenhaus` / `sync:rockenhaus`, third
  product target (`search.rockenhaus.net` / `rockenhaus-public` / fail-closed `_corpus/`).
  Tag deploy ships all three Workers.
- **Scripts typecheck gate** (search-mcp#61). `npm run typecheck` is
  `tsc --noEmit` (Workers: `src` + `index.test.ts`) **and**
  `tsc --noEmit -p tsconfig.scripts.json` (Node: `scripts/**/*.test.ts`).

### Fixes

- **Reindex `unable_to_connect_to_ai_search` [7017]** (search-mcp#73). Treated as
  transient alongside cooldown 7020 so a green R2 upload is not followed by a red
  reindex on a temporary AI Search blip.

### Ops / custody

- **Rockenhaus tag deploy:** `skyphusion-search-ci` granted Zone Read + Workers Routes Write
  on rockenhaus.net (2026-08-05); tag deploy ships all three Workers. Token id unchanged;
  GitHub secret value unchanged.

- **Escrow steady state** (search-mcp#65). Org secret `SKYPHUSION_TARGETS_JSON`; preferred
  re-escrow is the private crew-secrets workflow `escrow-search-mcp-targets`. Public
  search-mcp `escrow-targets` publish defaults off; `CREW_SECRETS_ESCROW_TOKEN` retired.
- **OPERATOR.md**: topology is shape-only (no full repo lists); hybrid_search beta gap
  documented; rockenhaus is a first-class instance row.

### Docs

- README, DEPLOY, CLAUDE, OPERATOR, and this CHANGELOG aligned with scripts, workflows,
  three-worker deploy, dual typecheck, reindex retries, and escrow path.

## v0.3.0

MINOR: package.json already at 0.3.0 on main; this release documents the cut and ships
tag-gated deploy of public query + internal MCP Workers (deps + features since v0.2.1).

## v0.2.1

Release sync bump (2026-07-21). No functional changes in this tag.
