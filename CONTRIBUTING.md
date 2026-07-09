# Contributing

Thanks for helping improve search-mcp.

## Before you open a PR

1. Run `npm run typecheck` and `npm test`.
2. Keep changes focused; match existing style (TypeScript strict, vanilla JS for the widget, no build step).
3. No em-dashes or en-dashes in prose (use commas, semicolons, or parentheses).
4. No secrets in the diff (tokens, real `wrangler.toml`, R2 keys).

## What fits

- Fixes and tests for the MCP Worker, query Worker, or sync pipeline
- Ingest remapping for additional text-like extensions AI Search skips
- Documentation and deploy ergonomics
- Dependency updates that keep `npm ci` green (watch wrangler / workers-types peer alignment)

## What is unlikely to merge

- Framework migrations or a frontend build step for the ask widget
- Replacement of Cloudflare AI Search / R2 / Workers with non-Cloudflare alternatives
- Features that expand scope without a clear, general-purpose use case

## Maintainers: npm release

1. Bump `version` in `package.json` (semver).
2. Create a GitHub Release whose tag matches (`v0.1.0` for package version `0.1.0`).
3. The [Publish npm package](.github/workflows/publish-npm.yml) workflow runs on release publish (needs org secret `NPM_TOKEN` with publish access to `@skyphusion`).

## Pull requests

See the PR template checklist. Maintainers cut releases; do not bump version or CHANGELOG unless asked.

## Sign your work

Sign off commits with `git commit -s` ([Developer Certificate of Origin](https://developercertificate.org/)).

## License

Contributions are licensed under AGPL-3.0-only, same as the project.
