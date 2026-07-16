#!/usr/bin/env node
// Trailing reindex pass ("settle") for the AI Search corpus.
//
// Why this exists (#12): corpus-sync fires a reindex per run, but a reindex on the biggest
// corpus (skyphusion-internal, ~6 min) outlives the sync that triggered it (~2-3 min). During a
// merge burst each new dispatch superseded the running job (`end_reason: "new_job_has_started"`)
// and the index never settled. sync-runner now SKIPS dispatch when a job is in flight, which
// removes the churn but leaves a gap: the last merge of a burst could go unindexed until the
// daily backstop. This job closes that gap.
//
// It is deliberately state-aware rather than clock-aware, so a single merge still reindexes
// immediately via sync-runner and only bursts are coalesced. Nothing is persisted; the decision
// derives entirely from the AI Search job list plus GitHub run history.
//
// Usage:
//   node scripts/reindex-settle.mjs            # decide + fire for every instance in targets.json
//   node scripts/reindex-settle.mjs --dry-run  # decide + report, never dispatch
//
// Env:
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   (wrangler)
//   GITHUB_TOKEN                                  (read Actions run history)
//   GITHUB_REPOSITORY                             (owner/repo; defaults to the search-mcp repo)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargetsPath, targetsHelp } from "./config-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SYNC_WORKFLOW = "corpus-sync.yml";

/**
 * AI Search reports timestamps as "2026-07-16 19:29:59" (UTC, no zone marker). Date.parse
 * treats that shape as LOCAL time, which silently skews every comparison by the runner's
 * offset, so normalize to explicit UTC before parsing.
 */
export function parseCfTimestamp(value) {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when any job for the instance is still running (`ended_at: null`). */
export function jobInFlight(jobs) {
  return (jobs || []).some((job) => !job.ended_at);
}

/** Most recent job start, in epoch ms, or null when the instance has never been indexed. */
export function newestJobStart(jobs) {
  const times = (jobs || [])
    .map((job) => parseCfTimestamp(job.started_at))
    .filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * Decide whether a trailing reindex is owed.
 *
 * Fire iff nothing is in flight AND the corpus changed since the last index pass began. A sync
 * that completed after the newest job STARTED may have uploaded objects that job never saw, so
 * `started_at` (not `ended_at`) is the correct comparison point; using ended_at would miss
 * objects uploaded while the job was mid-run.
 */
export function shouldReindex({ jobs, lastSyncCompletedAt }) {
  if (jobInFlight(jobs)) {
    return { reindex: false, reason: "a reindex job is already in flight" };
  }
  if (lastSyncCompletedAt == null) {
    return { reindex: false, reason: "no successful corpus-sync run found" };
  }
  const newest = newestJobStart(jobs);
  if (newest === null) {
    return { reindex: true, reason: "instance has no prior reindex job" };
  }
  if (newest < lastSyncCompletedAt) {
    return { reindex: true, reason: "corpus synced after the last reindex started" };
  }
  return { reindex: false, reason: "index is current with the last sync" };
}

export function instancesFromConfig(cfg) {
  const seen = new Set();
  for (const target of Object.values(cfg?.targets || {})) {
    if (target?.instance) seen.add(target.instance);
  }
  return [...seen];
}

function listJobs(instance) {
  const out = execFileSync(
    "npx",
    ["wrangler", "ai-search", "jobs", "list", instance, "--json"],
    { cwd: REPO, encoding: "utf8" },
  );
  return JSON.parse(out);
}

function reindexInstance(instance) {
  execFileSync("npx", ["wrangler", "ai-search", "jobs", "create", instance, "--json"], {
    stdio: "inherit",
    cwd: REPO,
  });
}

async function lastSuccessfulSyncCompletedAt() {
  const repo = process.env.GITHUB_REPOSITORY || "skyphusion-labs/search-mcp";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${SYNC_WORKFLOW}` +
    "/runs?status=success&per_page=1";
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub run history query failed (HTTP ${res.status})`);
  const body = await res.json();
  const run = body?.workflow_runs?.[0];
  return run?.updated_at ? Date.parse(run.updated_at) : null;
}

/** Orchestration with every side effect injected, so the decision path is testable. */
export async function settle(instances, deps) {
  const {
    getJobs,
    getLastSyncCompletedAt,
    runReindex,
    dryRun = false,
    log = console.log,
    error = console.error,
  } = deps;

  let lastSyncCompletedAt;
  try {
    lastSyncCompletedAt = await getLastSyncCompletedAt();
  } catch (err) {
    error(`BLOCKER: could not read corpus-sync history (${err.message}).`);
    return { exitCode: 1, fired: [] };
  }

  const fired = [];
  const failed = [];
  for (const instance of instances) {
    let decision;
    try {
      decision = shouldReindex({ jobs: getJobs(instance), lastSyncCompletedAt });
    } catch (err) {
      error(`  !! ${instance}: could not read job list (${err.message})`);
      failed.push(instance);
      continue;
    }
    if (!decision.reindex) {
      log(`  skip  ${instance}: ${decision.reason}`);
      continue;
    }
    if (dryRun) {
      log(`  would reindex  ${instance}: ${decision.reason}`);
      continue;
    }
    log(`  reindex  ${instance}: ${decision.reason}`);
    try {
      runReindex(instance);
      fired.push(instance);
    } catch (err) {
      error(`  !! ${instance}: reindex dispatch failed (${err.message})`);
      failed.push(instance);
    }
  }

  if (failed.length) {
    error(`BLOCKER: ${failed.length} instance(s) failed [${failed.join(", ")}].`);
    return { exitCode: 1, fired };
  }
  log(fired.length ? `Settled ${fired.length} instance(s).` : "Nothing to settle.");
  return { exitCode: 0, fired };
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
  const dryRun = process.argv.includes("--dry-run");
  const instances = instancesFromConfig(loadConfig());
  if (!instances.length) {
    console.error("No instances in targets.json.");
    process.exit(2);
  }
  console.log(`Settling ${instances.length} instance(s): ${instances.join(", ")}`);
  const result = await settle(instances, {
    getJobs: listJobs,
    getLastSyncCompletedAt: lastSuccessfulSyncCompletedAt,
    runReindex: reindexInstance,
    dryRun,
  });
  process.exit(result.exitCode);
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
