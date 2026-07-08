#!/usr/bin/env node
// Write production wrangler + targets config from CI secrets (never committed).
//
// Env (all required when invoked):
//   SKYPHUSION_WRANGLER_TOML
//   SKYPHUSION_WRANGLER_MCP_TOML
//   SKYPHUSION_TARGETS_JSON

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ["SKYPHUSION_WRANGLER_TOML", "wrangler.toml"],
  ["SKYPHUSION_WRANGLER_MCP_TOML", "wrangler.mcp.toml"],
  ["SKYPHUSION_TARGETS_JSON", join("scripts", "targets.json")],
];

function main() {
  let missing = false;
  for (const [envVar, relPath] of FILES) {
    const val = process.env[envVar];
    if (!val) {
      console.error(`::error::Missing required secret/env ${envVar}`);
      missing = true;
      continue;
    }
    const path = join(REPO, relPath);
    writeFileSync(path, val, "utf8");
    console.log(`Materialized ${relPath}`);
  }
  if (missing) process.exit(2);
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
