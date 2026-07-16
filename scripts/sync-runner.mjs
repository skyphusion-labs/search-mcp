#!/usr/bin/env node
// Corpus sync runner: isolated clone root -> scripts/sync.mjs -> optional reindex.
//
// Usage:
//   node scripts/sync-runner.mjs                 # all targets in targets.json
//   node scripts/sync-runner.mjs corpus          # one target
//   node scripts/sync-runner.mjs --dry-run
//   node scripts/sync-runner.mjs --no-reindex
//   node scripts/sync-runner.mjs --reindex-only     # skip clone+sync, dispatch reindex only
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
  const reindexOnly = flags.has("--reindex-only");
  return {
    targets: requested ? [requested] : [...allTargetNames],
    dryRun: flags.has("--dry-run"),
    sync: !reindexOnly,
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

/**
 * One dispatch attempt. stderr is PIPED rather than inherited: wrangler reports
 * `sync_in_cooldown [code: 7020]` on stderr, and with stdio "inherit" that text never reaches
 * the thrown error, so the retry logic could not tell a cooldown from a real failure. We echo
 * the captured output so the run log is unchanged.
 */
function reindexOnce(instance) {
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "ai-search", "jobs", "create", instance, "--json"],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (out) process.stdout.write(out);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
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

// Two independent budgets, deliberately NOT one shared deadline: the phases are additive on a
// healthy path (wait out an in-flight reindex, ~6 min on the biggest corpus, and THEN still owe
// a cooldown wait), so one shared bound would fail a run that did nothing wrong.
//
// Both budgets are far larger than the measured cooldown (rejected 10s after a job ends,
// accepted at 32s; 2026-07-16). That is intentional. The measurement is an observation, not a
// contract Cloudflare owes us, and it may move with corpus size or load. Sizing to today's
// number would convert ordinary upstream variance into red builds; sizing in minutes costs
// nothing when the cooldown is short, because the retry clears and the run moves on.
export const REINDEX_INFLIGHT_TIMEOUT_MS = 10 * 60 * 1000;
export const REINDEX_COOLDOWN_TIMEOUT_MS = 10 * 60 * 1000;
export const REINDEX_POLL_MS = 15 * 1000;

/**
 * AI Search refuses a new job for a cooldown window after the previous one ENDS, distinct from
 * the job being in flight. Measured 2026-07-16: rejected 10s after a job ended, accepted at
 * 32s. Waiting for `ended_at` alone is necessary but not sufficient.
 */
export function isCooldownError(err) {
  const text = `${err?.stdout || ""}${err?.stderr || ""}${err?.message || ""}`;
  return /sync_in_cooldown|code:\s*7020/.test(text);
}

/**
 * Block until no reindex job is in flight for the instance, so our dispatch lands strictly
 * after the running job finishes instead of superseding it.
 *
 * On timeout we dispatch ANYWAY and say so loudly. A job still running past the bound (well
 * over the ~6 min a full internal reindex takes) is itself anomalous, and superseding it is
 * the correct recovery: the replacement job sees every object currently in R2. The failure
 * mode we want is "one supersession in a pathological case", never "the corpus quietly goes
 * unindexed", which is the class of bug that a trailing-pass design introduced.
 */
export async function awaitReindexSlot(instance, deps) {
  const {
    listJobs,
    sleep,
    now = () => Date.now(),
    timeoutMs = REINDEX_INFLIGHT_TIMEOUT_MS,
    pollMs = REINDEX_POLL_MS,
    log = console.log,
  } = deps;
  const deadline = now() + timeoutMs;
  let waited = false;
  while (jobInFlight(listJobs(instance))) {
    if (now() >= deadline) {
      log(
        `  !! reindex for ${instance} still in flight after ${Math.round(timeoutMs / 1000)}s; ` +
          "dispatching anyway and superseding it. A job running this long is anomalous; " +
          "the replacement job reindexes the full corpus, so this is safe but worth a look.",
      );
      return { waited, timedOut: true };
    }
    if (!waited) {
      log(`  reindex in flight for ${instance}; waiting for it to finish before dispatching.`);
    }
    waited = true;
    await sleep(pollMs);
  }
  return { waited, timedOut: false };
}

/**
 * Dispatch a reindex, retrying while AI Search reports its post-job cooldown.
 *
 * Cooldown is transient and short (measured well under the budget), so the routine burst case
 * clears here and never goes red. Exhausting the budget therefore means something genuinely
 * anomalous upstream, and we fail loud rather than exit green: a green run while indexing is
 * actually stalled is the work-blind failure mode this whole issue exists to remove. The
 * message carries the honest blast radius so the red is actionable, not alarming.
 */
export async function dispatchWithCooldownRetry(instance, deps) {
  const {
    runReindexOnce,
    sleep,
    now = () => Date.now(),
    timeoutMs = REINDEX_COOLDOWN_TIMEOUT_MS,
    pollMs = REINDEX_POLL_MS,
    log = console.log,
  } = deps;
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      runReindexOnce(instance);
      return { retried: announced };
    } catch (err) {
      if (!isCooldownError(err)) throw err;
      if (now() >= deadline) {
        throw new Error(
          `reindex for ${instance} blocked by AI Search cooldown for longer than ` +
            `${Math.round(timeoutMs / 1000)}s. The R2 corpus uploaded OK and no data is lost; ` +
            "the index lags until the next sync or the daily backstop. A cooldown this " +
            "persistent is upstream and anomalous, so this run fails loudly on purpose.",
        );
      }
      if (!announced) {
        log(`  ${instance} is in AI Search cooldown; retrying until it clears.`);
        announced = true;
      }
      await sleep(pollMs);
    }
  }
}

/**
 * The real dependencies main() hands to awaitReindexSlot.
 *
 * Exported and built here on purpose. Every other seam in this file is injected, so a unit
 * suite full of stubs proves nothing about the production wiring: an undefined symbol here
 * rides a green suite and a clean `node --check` all the way to prod, then throws
 * ReferenceError on the first real dispatch. Constructing this object evaluates each binding,
 * so the wiring test fails loudly if one of them stops existing.
 */
export function productionReindexDeps() {
  return {
    listJobs,
    runReindexOnce: reindexOnce,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function run(plan, deps) {
  const { repos, targets, instances, reindex, sync = true } = plan;
  const {
    cloneTree,
    runSync,
    runReindex,
    awaitSlot,
    log = console.log,
    error = console.error,
  } = deps;

  if (sync) {
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
  } else {
    log("Reindex-only: skipping clone and sync.");
  }

  const failedReindex = [];
  if (reindex) {
    for (const instance of instances) {
      log(`\n=== reindex ${instance} ===`);
      try {
        if (awaitSlot) await awaitSlot(instance);
        await runReindex(instance);
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
    return { exitCode: 1, synced: sync };
  }
  log("\nCorpus sync complete.");
  return { exitCode: 0, synced: sync };
}

function loadConfig() {
  const path = resolveTargetsPath(HERE);
  if (!path) {
    console.error(targetsHelp(HERE));
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
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

  const result = await run(
    { repos, targets: opts.targets, instances, reindex: opts.reindex, sync: opts.sync },
    {
      cloneTree: (repo) => syncRepoTree(org, repo, root, authArgs),
      runSync: (target) =>
        execFileSync("node", [join(HERE, "sync.mjs"), target, ...opts.passThrough], {
          stdio: "inherit",
          cwd: REPO,
          env: { ...process.env, SYNC_REPO_ROOT: root },
        }),
      awaitSlot: (instance) => awaitReindexSlot(instance, productionReindexDeps()),
      runReindex: (instance) => dispatchWithCooldownRetry(instance, productionReindexDeps()),
    },
  );
  process.exit(result.exitCode);
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
