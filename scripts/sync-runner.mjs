#!/usr/bin/env node
// Corpus sync runner: isolated clone root -> scripts/sync.mjs -> optional reindex.
//
// Usage:
//   node scripts/sync-runner.mjs                 # all targets in targets.json
//   node scripts/sync-runner.mjs corpus          # one target
//   node scripts/sync-runner.mjs --dry-run
//   node scripts/sync-runner.mjs --no-reindex
//   node scripts/sync-runner.mjs --no-github-verify
//
// Env:
//   CORPUS_ROOT, CORPUS_GIT_ORG (required for clone)
//   GITHUB_TOKEN | GH_TOKEN
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID | CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (reindex)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTargetsPath,
  targetsHelp,
} from "./config-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/** Parse argv into a normalized options object (pure). */
export function parseArgs(argv, allTargetNames = []) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const requested = positional[0];
  return {
    targets: requested ? [requested] : [...allTargetNames],
    dryRun: flags.has("--dry-run"),
    reindex: !flags.has("--no-reindex") && !flags.has("--dry-run"),
    passThrough: [...flags].filter((f) => f === "--dry-run" || f === "--no-github-verify"),
  };
}

export function reposForTargets(cfg, targets) {
  const seen = new Set();
  const repos = [];
  for (const t of targets) {
    const target = cfg?.targets?.[t];
    if (!target) throw new Error(`unknown target ${t}`);
    for (const r of target.repos || []) {
      if (!seen.has(r)) {
        seen.add(r);
        repos.push(r);
      }
    }
  }
  return repos;
}

export function instancesForTargets(cfg, targets) {
  return targets.map((t) => cfg.targets[t].instance);
}

export function gitAuthArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

export function scrubSecrets(s) {
  return String(s)
    .replace(/AUTHORIZATION:\s*basic\s+\S+/gi, "AUTHORIZATION: basic [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export function describeExit(err) {
  const status = err && (err.status ?? err.code);
  return scrubSecrets(`exit ${status ?? "unknown"}`);
}

function repoUrl(org, repo) {
  return `https://github.com/${org}/${repo}.git`;
}

function git(args, opts = {}) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "inherit"], ...opts })
    .toString()
    .trim();
}

function syncRepoTree(org, repo, root, authArgs) {
  const dir = join(root, repo);
  const url = repoUrl(org, repo);
  let mode = "fetch";
  if (!existsSync(join(dir, ".git"))) {
    git([...authArgs, "clone", "--quiet", url, dir]);
    mode = "clone";
  } else {
    git([...authArgs, "-C", dir, "remote", "set-url", "origin", url]);
    git([...authArgs, "-C", dir, "fetch", "--prune", "--quiet", "origin"]);
  }
  git([...authArgs, "-C", dir, "remote", "set-head", "origin", "--auto"]);
  let head;
  try {
    head = git(["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  } catch {
    head = "origin/main";
  }
  git(["-C", dir, "reset", "--hard", "--quiet", head]);
  git(["-C", dir, "clean", "-fdq"]);
  return mode;
}

function reindexInstance(instance) {
  execFileSync("npx", ["wrangler", "ai-search", "jobs", "create", instance, "--json"], {
    stdio: "inherit",
    cwd: REPO,
  });
}

/**
 * True when any reindex job for the instance is still running. AI Search reports an
 * unfinished job as `ended_at: null`.
 *
 * Firing a job while one is in flight does not queue it: Cloudflare ends the running job
 * with `end_reason: "new_job_has_started"` and starts over. On the biggest corpus the
 * reindex outlives the sync that triggers it, so an unguarded dispatch during a merge burst
 * restarts the index pass repeatedly and it never settles (#12).
 */
export function jobInFlight(jobs) {
  return (jobs || []).some((job) => !job.ended_at);
}

function listJobs(instance) {
  const out = execFileSync(
    "npx",
    ["wrangler", "ai-search", "jobs", "list", instance, "--json"],
    { cwd: REPO, encoding: "utf8" },
  );
  return JSON.parse(out);
}

function reindexInFlightForInstance(instance) {
  return jobInFlight(listJobs(instance));
}

export function run(plan, deps) {
  const { repos, targets, instances, reindex } = plan;
  const {
    cloneTree,
    runSync,
    runReindex,
    reindexInFlight,
    log = console.log,
    error = console.error,
  } = deps;

  log(`Refreshing ${repos.length} repo tree(s) ...`);
  const failedClones = [];
  for (const repo of repos) {
    try {
      const mode = cloneTree(repo);
      log(`  ok  ${repo} (${mode})`);
    } catch (err) {
      failedClones.push(repo);
      error(`  !!  ${repo}: git failed (${describeExit(err)})`);
    }
  }

  if (failedClones.length) {
    error(
      `BLOCKER: ${failedClones.length} clone/fetch failure(s) [${failedClones.join(", ")}]; ` +
        "aborting before sync so no repo corpus is pruned or synced stale.",
    );
    return { exitCode: 1, synced: false };
  }

  for (const target of targets) {
    log(`\n=== sync ${target} ===`);
    runSync(target);
  }

  const failedReindex = [];
  if (reindex) {
    for (const instance of instances) {
      log(`\n=== reindex ${instance} ===`);
      try {
        if (reindexInFlight && reindexInFlight(instance)) {
          log(
            `  reindex already in flight for ${instance}; skipping dispatch so the running ` +
              "job is not superseded. reindex-settle fires the trailing pass.",
          );
          continue;
        }
        runReindex(instance);
      } catch (err) {
        failedReindex.push(instance);
        error(`  !! reindex failed for ${instance} (${describeExit(err)})`);
      }
    }
  } else {
    log("\nReindex skipped; AI Search will pick up R2 changes on its next schedule.");
  }

  if (failedReindex.length) {
    error(`BLOCKER: ${failedReindex.length} reindex failure(s) [${failedReindex.join(", ")}].`);
    return { exitCode: 1, synced: true };
  }
  log("\nCorpus sync complete.");
  return { exitCode: 0, synced: true };
}

function loadConfig() {
  const path = resolveTargetsPath(HERE);
  if (!path) {
    console.error(targetsHelp(HERE));
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const cfg = loadConfig();
  const allTargets = Object.keys(cfg.targets || {});
  const opts = parseArgs(process.argv.slice(2), allTargets);
  const repos = reposForTargets(cfg, opts.targets);
  const instances = instancesForTargets(cfg, opts.targets);
  const root = process.env.CORPUS_ROOT || join(REPO, ".corpus");
  const org = process.env.CORPUS_GIT_ORG || "";
  if (!org) {
    console.error("Set CORPUS_GIT_ORG to the GitHub org that owns the repos in targets.json.");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const authArgs = gitAuthArgs(token);

  mkdirSync(root, { recursive: true });
  console.log(`Corpus root: ${root}`);
  console.log(`Org: ${org}`);

  const result = run(
    { repos, targets: opts.targets, instances, reindex: opts.reindex },
    {
      cloneTree: (repo) => syncRepoTree(org, repo, root, authArgs),
      runSync: (target) =>
        execFileSync("node", [join(HERE, "sync.mjs"), target, ...opts.passThrough], {
          stdio: "inherit",
          cwd: REPO,
          env: { ...process.env, SYNC_REPO_ROOT: root },
        }),
      runReindex: reindexInstance,
      reindexInFlight: reindexInFlightForInstance,
    },
  );
  process.exit(result.exitCode);
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
