import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Resolve targets.json for repo dev or npm-installed CLI usage. */
export function resolveTargetsPath(scriptsDir) {
  if (process.env.SEARCH_MCP_TARGETS) {
    return process.env.SEARCH_MCP_TARGETS;
  }
  const candidates = [
    join(process.cwd(), "targets.json"),
    join(scriptsDir, "targets.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Default git clone root for corpus sync. */
export function defaultRepoRoot(scriptsDir, targetsPath) {
  if (process.env.SYNC_REPO_ROOT) {
    return process.env.SYNC_REPO_ROOT;
  }
  if (!targetsPath) {
    return join(scriptsDir, "..", "..");
  }
  const dir = dirname(targetsPath);
  if (dir === scriptsDir) {
    return join(scriptsDir, "..", "..");
  }
  return dir;
}

export function targetsHelp(scriptsDir) {
  const example = join(scriptsDir, "targets.json.example");
  return [
    "Missing targets.json.",
    `Copy ${example} to ./targets.json (or set SEARCH_MCP_TARGETS).`,
  ].join(" ");
}
