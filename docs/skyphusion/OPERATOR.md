# Skyphusion production operator guide

This public repo is the **single source of truth** for Skyphusion AI Search. Production
topology (domains, repo lists, bucket names) lives in GitHub Actions secrets and is
materialized at deploy/sync time by `scripts/materialize-config.mjs`. Never commit
`wrangler.toml`, `wrangler.mcp.toml`, or `scripts/targets.json` (they are gitignored).

`skyphusion-labs/skyphusion-search` is retired after cutover.

## Instances

| Instance | Worker | Host | Corpus |
| --- | --- | --- | --- |
| `skyphusion-public` | `skyphusion-search` | `search.vivijure.com` | Public GitHub repos only |
| `skyphusion-internal` | `skyphusion-search-internal-mcp` | `search-internal.vivijure.com` | Public + internal repos (bearer-gated MCP) |

`rockenhaus-litigation` is excluded; it will get its own search-mcp deployment later.

## GitHub secrets (search-mcp repo)

Deploy/sync creds are escrowed in `crew-secrets` (`secrets-shared.env.age`, shared
infra tier) and copied into GitHub Actions secrets on `search-mcp`:

| GitHub secret | crew-secrets export | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` | CF account |
| `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_API_TOKEN` | Workers deploy + AI Search reindex (shared non-admin token) |
| `R2_ACCESS_KEY_ID` | `SEARCH_MCP_R2_ACCESS_KEY_ID` | Corpus bucket R/W (token id `skyphusion-search-corpus-sync-r2`) |
| `R2_SECRET_ACCESS_KEY` | `SEARCH_MCP_R2_SECRET_ACCESS_KEY` | S3 secret (sha256 of rolled R2 token value) |
| `CORPUS_READ_TOKEN` | `CORPUS_READ_TOKEN` | GitHub PAT: clone private repos + visibility guard |
| `SKYPHUSION_WRANGLER_TOML` | Public query Worker config (see below) |
| `SKYPHUSION_WRANGLER_MCP_TOML` | Internal MCP Worker config (see below) |
| `SKYPHUSION_TARGETS_JSON` | Corpus repo lists (see below) |

Wrangler runtime secrets (`MCP_TOKEN`, `TURNSTILE_SECRET`) stay on the Workers via
`wrangler secret put` and persist across deploys.

## Org secret (constellation repos)

| Secret | Purpose |
| --- | --- |
| `SEARCH_DISPATCH_TOKEN` | Fine-grained PAT: `repository_dispatch` write on **search-mcp** only |

Re-scope the existing org PAT from `skyphusion-search` to `search-mcp` after merge.

## Bootstrap: set config secrets

From a checkout with the three files present locally (or paste from this doc):

```sh
gh secret set SKYPHUSION_WRANGLER_TOML -R skyphusion-labs/search-mcp < wrangler.toml
gh secret set SKYPHUSION_WRANGLER_MCP_TOML -R skyphusion-labs/search-mcp < wrangler.mcp.toml
gh secret set SKYPHUSION_TARGETS_JSON -R skyphusion-labs/search-mcp < scripts/targets.json
```

Re-seed GitHub secrets from crew-secrets (decrypt on a crew box, pipe straight to
`gh secret set`, never echo values):

```sh
set -a
. <(age -d -i ~/.config/chezmoi/key.txt ~/.config/crew/secrets-shared.env.age)
set +a
gh secret set CLOUDFLARE_ACCOUNT_ID -R skyphusion-labs/search-mcp --body "$CLOUDFLARE_ACCOUNT_ID"
gh secret set CLOUDFLARE_API_TOKEN -R skyphusion-labs/search-mcp --body "$CLOUDFLARE_API_TOKEN"
gh secret set R2_ACCESS_KEY_ID -R skyphusion-labs/search-mcp --body "$SEARCH_MCP_R2_ACCESS_KEY_ID"
gh secret set R2_SECRET_ACCESS_KEY -R skyphusion-labs/search-mcp --body "$SEARCH_MCP_R2_SECRET_ACCESS_KEY"
gh secret set CORPUS_READ_TOKEN -R skyphusion-labs/search-mcp --body "$CORPUS_READ_TOKEN"
```

## SKYPHUSION_WRANGLER_TOML

```toml
# Public query Worker -- binds ONLY skyphusion-public.

name = "skyphusion-search"
main = "src/index.ts"
compatibility_date = "2026-03-27"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[ai_search]]
binding = "SEARCH"
instance_name = "skyphusion-public"

[[ratelimits]]
name = "ASK_LIMITER"
namespace_id = "1"

  [ratelimits.simple]
  limit = 20
  period = 60

[vars]
ALLOWED_ORIGINS = "https://vivijure.com,https://www.vivijure.com"
GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

[[routes]]
pattern = "search.vivijure.com"
custom_domain = true
```

## SKYPHUSION_WRANGLER_MCP_TOML

```toml
# Internal MCP Worker -- ONLY Worker that binds skyphusion-internal.

name = "skyphusion-search-internal-mcp"
main = "src/mcp.ts"
compatibility_date = "2026-03-27"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[ai_search]]
binding = "SEARCH"
instance_name = "skyphusion-internal"

[[routes]]
pattern = "search-internal.vivijure.com"
custom_domain = true
```

## SKYPHUSION_TARGETS_JSON

Internal repos (indexed only in the internal target): `crew-bus`, `crew-secrets`,
`fleet-chezmoi`, `ops`. Everything else in the org that is public (or soon public) is in
the public target. `rockenhaus-litigation`, `skyphusion-search`, `infra`, and `swarm-iac`
are excluded.

```json
{
  "excludePaths": {
    "fleet-chezmoi": [
      "claude-memory/projects/-home-conrad/",
      "claude-memory/CLAUDE.md"
    ]
  },
  "restrictedRepos": [
    "crew-bus",
    "crew-secrets",
    "fleet-chezmoi",
    "ops"
  ],
  "targets": {
    "public": {
      "instance": "skyphusion-public",
      "bucket": "skyphusion-search-public",
      "repos": [
        ".github",
        "common-thread",
        "hollow-grid-go",
        "mud-bots",
        "postern",
        "prism",
        "search-mcp",
        "SidVicious_exe",
        "skyphusion-monitor",
        "skyphusion-net",
        "skyphusion-org",
        "slate",
        "the-hollow-grid",
        "vivijure",
        "vivijure-audio-upscale",
        "vivijure-backend",
        "vivijure-com",
        "vivijure-local-12gb",
        "vivijure-local-16gb",
        "vivijure-musetalk",
        "vivijure-upscale"
      ]
    },
    "internal": {
      "instance": "skyphusion-internal",
      "bucket": "skyphusion-search-internal",
      "repos": [
        ".github",
        "common-thread",
        "crew-bus",
        "crew-secrets",
        "fleet-chezmoi",
        "hollow-grid-go",
        "mud-bots",
        "ops",
        "postern",
        "prism",
        "search-mcp",
        "SidVicious_exe",
        "skyphusion-monitor",
        "skyphusion-net",
        "skyphusion-org",
        "slate",
        "the-hollow-grid",
        "vivijure",
        "vivijure-audio-upscale",
        "vivijure-backend",
        "vivijure-com",
        "vivijure-local-12gb",
        "vivijure-local-16gb",
        "vivijure-musetalk",
        "vivijure-upscale"
      ]
    }
  }
}
```

## Cutover checklist

1. Merge the search-mcp consolidation PR.
2. Set all eight repo secrets on `search-mcp` (three config blobs + five creds).
3. Re-scope `SEARCH_DISPATCH_TOKEN` org PAT to `search-mcp`.
4. Merge constellation `corpus-notify` retarget PRs (or batch update).
5. Run `corpus-sync` workflow manually once; confirm green.
6. Verify `https://search.vivijure.com/health` and MCP `tools/list` on internal host.
7. Archive `skyphusion-labs/skyphusion-search` (disable Actions first).

## MCP client wiring

Per-consumer tokens live in `MCP_TOKEN` (`name=token` list). See the public
[DEPLOY.md](../DEPLOY.md) MCP section; production host is `search-internal.vivijure.com`.
