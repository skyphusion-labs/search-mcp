# Skyphusion AI Search cutover record (2026-07-08)

Production AI Search moved from the private repo **`skyphusion-labs/skyphusion-search`**
to the public repo **`skyphusion-labs/search-mcp`**. This document is the durable handoff for
Cursor (laptop) and the Claude crew (dischord/jello). **Trust this file and merged code on
`main`;** session chat is not the bus.

## Outcome (2026-07-08)

| Check | Status |
| --- | --- |
| PR #4 + #5 merged to `search-mcp` `main` | Done |
| crew-secrets PR #85 merged (`SEARCH_MCP_*` escrow) | Done |
| Deploy (public + internal Workers) | Green |
| `https://search.vivijure.com/health` | OK (`search-mcp-query`) |
| `https://search-internal.vivijure.com/health` | OK (`search-mcp`) |
| MCP `tools/list` + `tools/call` search | OK |
| `corpus-sync` workflow | Green ([run 28966994684](https://github.com/skyphusion-labs/search-mcp/actions/runs/28966994684)) |
| Constellation `corpus-notify` retargets | **Pending merge** (local branches only) |
| crew-secrets R2 escrow re-seed (new token id) | **Pending** (GitHub secrets live; age file stale) |
| Archive `skyphusion-search` | **Blocked** until notify retargets merge + Actions disabled |

## What moved where

| Asset | Before | After |
| --- | --- | --- |
| Source + CI | `skyphusion-labs/skyphusion-search` (private) | `skyphusion-labs/search-mcp` (public) |
| Production config | Committed wrangler + targets (private repo) | GitHub secrets → `scripts/materialize-config.mjs` at CI time |
| Deploy runner | `[self-hosted, fleet]` (rejected for public repo) | `ubuntu-latest` (PR #5) |
| Corpus sync runner | `[self-hosted, fleet]` | `ubuntu-latest` (PR #5) |
| Merge-driven reindex | `repository_dispatch` → `skyphusion-search` | `repository_dispatch` → `search-mcp` |
| Org dispatch PAT | Scoped to `skyphusion-search` | Re-scoped to `search-mcp` (`SEARCH_DISPATCH_TOKEN`) |

**Unchanged in Cloudflare:** Worker names (`skyphusion-search`, `skyphusion-search-internal-mcp`),
custom domains (`search.vivijure.com`, `search-internal.vivijure.com`), R2 bucket names
(`skyphusion-search-public`, `skyphusion-search-internal`), AI Search instance names
(`skyphusion-public`, `skyphusion-internal`).

## Merged PRs

### search-mcp

- **#4** `feat(ci): consolidate Skyphusion production into search-mcp` — materialize-config,
  deploy + corpus-sync workflows, operator docs, targets lists.
- **#5** `fix(ci): ubuntu-latest for deploy and corpus-sync` — public repo cannot use org
  fleet runners; deploy and corpus-sync were stuck queued indefinitely.

### crew-secrets

- **#85** `feat(shared): escrow search-mcp CI creds` — `CLOUDFLARE_ACCOUNT_ID`,
  `SEARCH_MCP_CF_API_TOKEN`, `SEARCH_MCP_R2_*`, `CORPUS_READ_TOKEN` in
  `secrets-shared.env.age`.

## GitHub secrets (search-mcp repo)

All eight secrets are set on `skyphusion-labs/search-mcp`:

| Secret | Source / notes |
| --- | --- |
| `SKYPHUSION_WRANGLER_TOML` | Public query Worker config (from old repo; not committed) |
| `SKYPHUSION_WRANGLER_MCP_TOML` | Internal MCP Worker config; **`binding = "SEARCH"`** (not `SEARCH_INTERNAL`) |
| `SKYPHUSION_TARGETS_JSON` | Public + internal repo lists; internal = `crew-bus`, `crew-secrets`, `fleet-chezmoi`, `ops` only |
| `CLOUDFLARE_ACCOUNT_ID` | Account `fabcb25d9c7eb087110ec474a03e50d2` |
| `CLOUDFLARE_API_TOKEN` | Rolled account token **`skyphusion-search-ci`** (id `dc0b377872e3832b0aa421e44b194071`); escrowed as `SEARCH_MCP_CF_API_TOKEN` |
| `CORPUS_READ_TOKEN` | Conrad operator PAT from `~conrad/github.env` on dischord (`GITHUB_PERSONAL_ACCESS_TOKEN`) |
| `R2_ACCESS_KEY_ID` | CF token id for **`skyphusion-search-corpus-sync-r2`** (see R2 section) |
| `R2_SECRET_ACCESS_KEY` | SHA-256 hex of token value (`jq -j`, no trailing newline) |

Org secret **`SEARCH_DISPATCH_TOKEN`**: updated to Conrad's PAT with `repository_dispatch`
write on **`search-mcp`** only (old PAT was scoped to `skyphusion-search` → 403).

Wrangler runtime secrets (`MCP_TOKEN`, `TURNSTILE_SECRET`) remain on the Workers via
`wrangler secret put` and survive deploys.

## Workflow failures encountered and fixes

### 1. Deploy / corpus-sync stuck queued

**Symptom:** Jobs never started on `[self-hosted, fleet]`.
**Cause:** Org fleet pool rejects public-repo workflows.
**Fix:** PR #5 → `runs-on: ubuntu-latest` for deploy and corpus-sync.

### 2. corpus-notify 403

**Symptom:** Constellation repos could not dispatch corpus-sync.
**Cause:** `SEARCH_DISPATCH_TOKEN` still scoped to `skyphusion-search`.
**Fix:** Org secret updated to PAT with dispatch on `search-mcp`.

### 3. Deploy invalid CF token

**Symptom:** `wrangler deploy` auth failure.
**Cause:** Malformed / empty `CLOUDFLARE_API_TOKEN` in GitHub.
**Fix:** Rolled `skyphusion-search-ci`, set GitHub secret + crew-secrets escrow.

### 4. MCP search binding mismatch

**Symptom:** MCP `tools/call` search failed at runtime.
**Cause:** `SKYPHUSION_WRANGLER_MCP_TOML` secret had `binding = "SEARCH_INTERNAL"`; code uses `env.SEARCH`.
**Fix:** Secret updated to `binding = "SEARCH"`, redeployed.

### 5. corpus-sync R2 SignatureDoesNotMatch

**Symptom:** Upload phase failed after planning 1676 objects.
**Cause:** Multiple token rolls left `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` out of sync;
  bucket-scoped `Workers R2 Storage Bucket Item Read/Write` tokens did not authenticate via S3
  during debugging (SignatureDoesNotMatch on every roll).
**Fix:**
  1. Deleted probe tokens and re-minted **`skyphusion-search-corpus-sync-r2`** with account-scoped
     **`Workers R2 Storage Write`** (see [[cloudflare-tokens-account-scoped]] in fleet memory).
  2. Single roll only (do not roll in a retry loop; each roll invalidates the prior value).
  3. Derive secret: `python3 -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path("raw").read_bytes()).hexdigest())'`
     where `raw` is the token value from `jq -j '.result'` (create or roll response).
  4. Wait ~15s after mint/roll before S3 probe (propagation).
  5. Verify list + put locally, then `gh secret set` from files (never echo values).

**Current R2 token:** name `skyphusion-search-corpus-sync-r2`, id **`143953b0147a67dca0236ccec4c450f9`**
(replaces `2eea4aa0dd1cfd0336357f815c81e3b9`, revoked during cutover).

**Collateral (2026-07-08):** `vivijure-bake-ci-read` was rolled during R2 debugging.
`vivijure-backend` GitHub `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` were re-seeded the same
day (token id unchanged: `1414e61f52f48f737c4cd85c21e24145`).

## Constellation corpus-notify retarget (pending)

Nine repos have **local** edits retargeting `corpus-notify.yml` from
`skyphusion-labs/skyphusion-search` → `skyphusion-labs/search-mcp`. **Remote `main` on these
repos still dispatches the old repo** (verified on `vivijure` 2026-07-08).

Repos with local retarget (not yet pushed/merged):

- `vivijure`
- `vivijure-backend`
- `vivijure-com`
- `vivijure-audio-upscale`
- `vivijure-local-12gb`
- `vivijure-local-16gb`
- `vivijure-musetalk`
- `vivijure-upscale`
- `slate`

Change pattern: dispatch URL → `https://api.github.com/repos/skyphusion-labs/search-mcp/dispatches`,
comments reference `search-mcp`. Snippet reference: `docs/notify-corpus-sync.snippet.yml` in
this repo.

**Backstop until merged:** `corpus-sync` runs daily at `17 7 * * *` UTC on `search-mcp` plus
manual `workflow_dispatch`.

## Archive procedure for skyphusion-search

**Safe to archive when:**

1. All constellation `corpus-notify` retargets are merged to `main`.
2. One merge to a constellation repo successfully dispatches `search-mcp` corpus-sync (HTTP 204).
3. crew-secrets `secrets-shared.env.age` re-seeded with current `SEARCH_MCP_R2_*` (token id
   `143953b0…`) and README citation updated.

**Steps:**

1. **Disable Actions** on `skyphusion-labs/skyphusion-search` (Settings → Actions → Disable).
   Prevents accidental deploy/sync from stale workflows.
2. **Archive** the repo (Settings → Archive). Do not delete; history may be useful.
3. **Revoke** unused CF tokens tied only to the old repo CI if any remain (`skyphusion-search-actions`, etc.).
4. Update fleet memory pointers (see below).

## crew-secrets re-escrow (operator)

GitHub secrets are live; the age escrow may still cite the old R2 token id. On a crew box:

```sh
# Mint path: privileged token at ~conrad/cloudflare-mcp.env ONLY for create/roll/delete.
# After roll + local S3 verify:
gh secret set R2_ACCESS_KEY_ID -R skyphusion-labs/search-mcp --body "$TOKEN_ID"
gh secret set R2_SECRET_ACCESS_KEY -R skyphusion-labs/search-mcp < secret.hex

# Re-encrypt into secrets-shared.env.age (Python/heredoc; never shell-interpolate raw token):
# SEARCH_MCP_R2_ACCESS_KEY_ID=<token id>
# SEARCH_MCP_R2_SECRET_ACCESS_KEY=<sha256 hex>
```

See `crew-secrets/README.md` named-token citation for `skyphusion-search-corpus-sync-r2`.

## Fleet memory updates

Replace stale pointers:

| File | Action |
| --- | --- |
| `fleet-chezmoi/claude-memory/projects/-home-conrad/memory/skyphusion-search-mcp.md` | Point repo at `search-mcp`, note cutover date |
| `fleet-chezmoi/claude-memory/projects/-home-conrad-dev-vivijure/memory/skyphusion-search-and-studio-mcp.md` | Update ownership/repo name |
| `CLAUDE.md` / project CLAUDE files | Already reference search-mcp where updated |

## Related docs

- [OPERATOR.md](./OPERATOR.md) — live topology, secret mapping, bootstrap commands
- [../DEPLOY.md](../DEPLOY.md) — generic deploy + MCP wiring
- [../notify-corpus-sync.snippet.yml](../notify-corpus-sync.snippet.yml) — constellation notify snippet
