# Security policy

## Supported versions

Rolling `main` branch; security fixes land on `main`. If you deploy from a tag or an older commit, upgrade to the latest `main` to pick them up.

## Reporting a vulnerability

Do not file a public GitHub issue for security problems. Report privately via the repository **Security** tab (**Report a vulnerability**), or email **security@skyphusion.org**.

Include:

- A description of the issue and its impact
- Steps to reproduce, with a minimal example if possible
- The affected version (commit SHA if known)
- Any suggestions for remediation

Target acknowledgment: 5 business days. Please allow up to 90 days for a coordinated fix before public disclosure.

## Scope

In scope for this repository:

- **MCP Worker** (`/mcp`): bearer authentication bypass, unauthorized corpus access, information disclosure via the `search` tool
- **Query Worker** (`/ask`): CORS bypass, Turnstile bypass, rate-limit bypass, prompt injection that leaks data across tenants (when misconfigured)
- **Corpus sync scripts**: credential leakage in logs, failure to scrub git auth material from error output, unsafe defaults that upload secrets to R2
- Injection issues in metadata or object keys surfaced to clients

Out of scope:

- Issues that require already-compromised `MCP_TOKEN`, R2 keys, or Cloudflare account credentials
- Denial-of-service via legitimate but expensive AI Search or Workers AI calls (rate-limit at the edge or Gateway)
- Bugs in upstream Cloudflare services (report those to Cloudflare)
- Deployments that leave `TURNSTILE_SECRET` unset on a public `/ask` endpoint (documented dev-only behavior)

## Deployer responsibility

This is a self-host template. You are responsible for secret rotation, CORS allowlists, Turnstile configuration, and scoping AI Search instances to the corpus you intend to expose.
