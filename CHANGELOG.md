# Changelog

## v0.6.0

MINOR: `public/ask-widget.js` now reports an upstream failure as an error instead of the empty-corpus message. Anyone who copies that file into a site (skyphusion-net, vivijure-com, rockenhaus-litigation-public carry copies) behaves differently on upstream errors after taking this version, which is why this is a MINOR and not a PATCH. Also two MCP tool error-reporting fixes, a dependency security pin, and the dependency and CI updates on main since v0.5.1.

### Ask widget (`public/ask-widget.js`, #118)

- **An upstream error is shown as an error.** An `event: error` block, or a payload carrying `error`, now shows "Sorry, something went wrong (...)". Before, it rendered "Nothing in the indexed corpus addresses that.", a confident false negative that said the corpus had been searched and found empty when the search never completed. The error text is `error` (string), else `error.message`, else `message`, else "stream error"; an unparseable error payload shows the generic "stream error", never raw upstream text.
- **The end of an answer is no longer truncated.** The decoder tail is flushed and a final event with no trailing blank line is handled. Before, a stream that ended mid-buffer lost its last bytes (a test rendered "Hel" for "Hello"); a truncated sentence still reads like a sentence, so nobody would have noticed.
- **Multi-line SSE events are parsed.** Several `data:` lines in one event are joined with a newline, per the SSE spec. Before, only the text up to the first `data:` line was read and the rest of the event was silently dropped.
- **Unchanged on purpose:** a stream that completes cleanly with no content and no sources still shows the empty-text message (`data-empty-text`).

### MCP tools (`src/mcp.ts`)

- **`search`:** a `path_prefix` array containing a non-string element is now an argument error (`isError: true`). Before, it silently applied no filter and returned unfiltered results (#114).
- **`list_repos`:** a failed `CORPUS` R2 listing is now a tool error. Before, it returned "No repos configured" with `isError: false` (#115). `corpus_status` and the `corpus://catalog` resource are unchanged.

### Dependencies and security

- **Pin `sharp` to 0.35.4** (exact, via `overrides`) to clear GHSA-rgj7-g3m4-5g8c, which Dependabot could not reach because the vulnerable version was only pinned through `overrides` (#111).
- Toolchain bumps: `wrangler` 4.120.0 to 4.125.0, `@cloudflare/workers-types` 5.20260804.1 to 5.20260821.1 (#98); `vitest` and `@vitest/coverage-istanbul` 4.1.10 to 4.1.11 (#101); `@aws-sdk/client-s3` 3.1105.0 to 3.1120.0 and `@types/node` 26.2.0 to 26.4.0 (#102); `browserslist` 4.28.5 to 4.29.1 (#108); `baseline-browser-mapping` 2.10.42 to 2.11.26 (#109).

### CI and docs

- `actions/checkout` and `actions/setup-node` 4 to 7 (#97).
- CI: paid scanners retired (CodeQL and adversarial-audit workflows dropped, #94, #100); the free `coverage` check restored (#96).
- Docs: retired dead fleet doctrine from `CLAUDE.md` (#106); operator docs no longer tell operators to set `CORPUS_ROOT=/opt/corpus` (#107).

### Version pin

- `SERVER_INFO` (the `/health` version) moves with `package.json` so the tag cannot lie.

## v0.5.1

PATCH: production default for the MCP `ask` generation model (#87), plus Cloudflare toolchain, aws-sdk s3, @types/node, and nanoid on main since v0.5.0.


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
