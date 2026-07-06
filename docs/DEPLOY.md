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
```

Edit `repos` (directory names under your clone root), `bucket`, and `instance`.

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

## 8. CI

`.github/workflows/ci.yml` runs `typecheck` + `vitest` on GitHub-hosted runners. Deploy is intentionally manual (or wire your own deploy job with `CLOUDFLARE_API_TOKEN`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Empty search results | R2 objects present? `npx wrangler ai-search stats INSTANCE` |
| TypeScript not indexed | Sync remaps to `.txt`; re-run sync + reindex job |
| MCP 401 | `MCP_TOKEN` set? Bearer header exact match? |
| `/ask` 403 origin | `ALLOWED_ORIGINS` includes the page origin |
| `/ask` 403 turnstile | `TURNSTILE_SECRET` set and widget sitekey matches |
