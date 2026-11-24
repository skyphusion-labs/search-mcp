# search-mcp

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

search-mcp is an open-source toolkit for Cloudflare AI Search. The npm name is `@skyphusion/search-mcp`. Read [README.md](README.md). Self-host steps are in [docs/DEPLOY.md](docs/DEPLOY.md).

Skyphusion Labs no longer runs hosted corpus Workers (retired 2026-11-24, #156). Do not expect live workers at `search.vivijure.com` or `search-internal.vivijure.com`. Do not add corpus-notify workflows back to other repos. The product docs site at https://search-mcp.dev stays live.

The version is in `package.json`. See the latest `v*` tag.

## Commands

```bash
npm ci
npm run typecheck
npm test
```

`npm run typecheck` runs both TypeScript projects. One project is the Workers code. The other is `tsconfig.scripts.json`. Run both before you push. CI on a pull request runs typecheck and `npm test`. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Where code lives

| Path | Role |
| --- | --- |
| `src/index.ts` | Public `/ask` Worker |
| `src/mcp.ts` | Bearer-gated MCP Worker |
| `scripts/sync.mjs` | Sync one target into R2 |
| `scripts/sync-runner.mjs` | Clone, sync, and reindex |
| `scripts/sync-ingest.mjs` | Extension remap and path filters |
| `scripts/guard-targets-additive.mjs` | Refuse a non-additive targets edit |
| `scripts/corpus-boundary.mjs` | Check public-target visibility |
| `wrangler.toml.example` | Query Worker template |
| `wrangler.mcp.toml.example` | MCP Worker template |
| `wrangler.rockenhaus.toml` | Court-record Worker |
| `docs/DEPLOY.md` | Self-host deploy |

`includePaths` and `excludePaths` can apply to every target. They can also apply to one target. The court-record sync stays on the public mirror paths. Private litigation trees are never a sync source.

Do not commit a live targets file. Do not commit a token.

## Release

A version moves only in a release pull request. Feature work does not bump `package.json`. Fix work does not bump `package.json`. The tag `vX.Y.Z` must match the version in `package.json`. Push a tag only when that commit is on `main`.

Publishing a GitHub Release runs [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml). A `v*` tag no longer deploys Workers. Hosted Skyphusion Workers were retired (#156).

## Docs

Write Simplified Technical English. Use short sentences. Use one idea per sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

## Safety

Do not put a secret in a tracked file, a log, a chat transcript, or an issue. Template configs stay as examples. Fill secrets at deploy time.

## Commits

Use Conventional Commits. The body says why.
