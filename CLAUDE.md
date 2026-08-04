# CLAUDE.md -- search-mcp

Corpus / search MCP and public query Workers for skyphusion-labs. See `README.md` for product
overview and local setup.

## Conventions

- `npm run typecheck` is the CI gate (`tsc --noEmit`); run it before pushing.
- Conventional Commits. SemVer in root `package.json` (`0.MINOR.PATCH` while pre-1.0; current line
  may already be past a minor -- trust `package.json` + tags).
- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs.

## Release / tagging

**TAG-GATED deploy.** `.github/workflows/ci.yml`:

- Push/PR to `main`: CI only (typecheck/tests). **Does not** deploy production.
- Pushed **`v*`** tag: after CI, deploy job runs (public query Worker + internal MCP Worker).

Tag **must** match root `package.json` version (`vX.Y.Z` == version `X.Y.Z`). Workflow refuses a
mismatch (fc#864). Tag must be an ancestor of `origin/main`.

npm package publish (if used): **GitHub Release published** via `publish-npm.yml`, not the deploy
tag alone.

### Cut a release

1. **Release PR on `main`:** bump `package.json` version, update `CHANGELOG.md` when you keep one,
   land the PR.
2. **Tag:**

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

3. Confirm the tag CI run's deploy job green. Verify live Workers, not only a green check.
4. Optional npm: `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes` to fire
   `publish-npm.yml`.

Merge alone never ships.

## Crew identity

Conrad laptop: commits as `Conrad Rockenhaus <conrad@skyphusion.org>`. Branch + PR; never push to
`main` unless Conrad says so.
