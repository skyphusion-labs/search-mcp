#!/usr/bin/env node
// Refuse a targets.json edit that is not purely ADDITIVE.
//
// Why: sync mirror-prunes. A target quietly dropped from the config does not fail; it
// prunes that target bucket down to whatever the new config describes, with every status
// light green. Adding a third target therefore has to prove the existing ones survived
// the edit, and proving it by reading the diff is exactly the human step that this class
// of change keeps getting wrong (search-mcp#63).
//
// Direction of the guard: NEW must be a superset of OLD. Additions pass. Any removal,
// rename, retarget, or narrowing refuses.
//
// A widened boundary refuses too. Dropping an excludePaths prefix or a restrictedRepos
// entry admits files that were previously kept out of the corpus, which is a different
// failure from pruning but the same class of silent one.
//
// Output is COUNTS AND BOOLEANS ONLY -- no target, bucket, instance, or repo name -- so
// it is safe to run in the public job log of this repository. On a refusal the operator
// holds both plaintexts locally and can diff them there.
//
// Usage: node scripts/guard-targets-additive.mjs --old <path> --new <path>
// Exit:  0 additive, 2 refused, 1 usage/parse error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_REFUSED = 2;

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value;
}

function prefixMap(cfg, key) {
  const raw = cfg[key];
  if (raw === undefined) return {};
  return asObject(raw, key);
}

function missingFrom(oldList, newList) {
  const have = new Set(Array.isArray(newList) ? newList : []);
  let missing = 0;
  for (const item of Array.isArray(oldList) ? oldList : []) {
    if (!have.has(item)) missing += 1;
  }
  return missing;
}

/**
 * Compare two configs. Returns a report of counts; the caller decides the exit code.
 * Every field is a number or a boolean by construction.
 */
export function diffAdditive(oldCfg, newCfg) {
  const oldTargets = asObject(asObject(oldCfg, "old config").targets, "old targets");
  const newTargets = asObject(asObject(newCfg, "new config").targets, "new targets");

  const oldNames = Object.keys(oldTargets);
  let targetsPreserved = 0;
  let targetsMissing = 0;
  let instancesChanged = 0;
  let bucketsChanged = 0;
  let reposDropped = 0;

  for (const name of oldNames) {
    const before = oldTargets[name];
    const after = newTargets[name];
    if (!after || typeof after !== "object") {
      targetsMissing += 1;
      // Every repo of a vanished target is a dropped repo; count it so the blast radius
      // shows up as a number rather than as a single missing-target tick.
      reposDropped += Array.isArray(before?.repos) ? before.repos.length : 0;
      continue;
    }
    targetsPreserved += 1;
    if (before.instance !== after.instance) instancesChanged += 1;
    if (before.bucket !== after.bucket) bucketsChanged += 1;
    reposDropped += missingFrom(before.repos, after.repos);
  }

  const boundary = { includePaths: 0, excludePaths: 0, prefixes: 0 };

  // Flatten top-level + per-target path maps into one comparable surface so a
  // dropped nested allowlist/denylist is the same class of silent boundary
  // widening as dropping a top-level entry (search-mcp#62).
  function flattenPathMaps(cfg, key) {
    const out = {};
    const top = prefixMap(cfg, key);
    for (const [repo, prefixes] of Object.entries(top)) {
      if (repo.startsWith("_")) continue;
      out[`/:${repo}`] = prefixes;
    }
    for (const [tName, target] of Object.entries(asObject(cfg.targets || {}, "targets"))) {
      if (!target || typeof target !== "object") continue;
      const nested = target[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      for (const [repo, prefixes] of Object.entries(nested)) {
        if (repo.startsWith("_")) continue;
        out[`${tName}:${repo}`] = prefixes;
      }
    }
    return out;
  }

  for (const key of ["includePaths", "excludePaths"]) {
    const before = flattenPathMaps(oldCfg, key);
    const after = flattenPathMaps(newCfg, key);
    for (const slot of Object.keys(before)) {
      if (!(slot in after)) {
        boundary[key] += 1;
        continue;
      }
      boundary.prefixes += missingFrom(before[slot], after[slot]);
    }
  }

  const restrictedDropped = missingFrom(oldCfg.restrictedRepos, newCfg.restrictedRepos);

  const violations =
    targetsMissing +
    instancesChanged +
    bucketsChanged +
    reposDropped +
    boundary.includePaths +
    boundary.excludePaths +
    boundary.prefixes +
    restrictedDropped;

  return {
    priorTargets: oldNames.length,
    targetsPreserved,
    targetsMissing,
    instancesChanged,
    bucketsChanged,
    reposDropped,
    includePathsReposDropped: boundary.includePaths,
    excludePathsReposDropped: boundary.excludePaths,
    prefixesDropped: boundary.prefixes,
    restrictedDropped,
    targetsAdded: Object.keys(newTargets).length - targetsPreserved,
    violations,
    additive: violations === 0,
  };
}

function parseArgs(argv) {
  const out = { oldPath: null, newPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old") out.oldPath = argv[++i];
    else if (argv[i] === "--new") out.newPath = argv[++i];
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const { oldPath, newPath } = parseArgs(argv);
  if (!oldPath || !newPath) {
    console.error("usage: guard-targets-additive.mjs --old <path> --new <path>");
    return EXIT_USAGE;
  }

  let report;
  try {
    report = diffAdditive(
      JSON.parse(readFileSync(oldPath, "utf8")),
      JSON.parse(readFileSync(newPath, "utf8")),
    );
  } catch (err) {
    console.error(`::error::could not compare configs: ${err.message}`);
    return EXIT_USAGE;
  }

  console.log(`prior_targets_preserved=${report.targetsPreserved}/${report.priorTargets}`);
  console.log(`targets_added=${report.targetsAdded}`);
  console.log(`targets_missing=${report.targetsMissing}`);
  console.log(`instances_changed=${report.instancesChanged}`);
  console.log(`buckets_changed=${report.bucketsChanged}`);
  console.log(`repos_dropped=${report.reposDropped}`);
  console.log(`include_paths_repos_dropped=${report.includePathsReposDropped}`);
  console.log(`exclude_paths_repos_dropped=${report.excludePathsReposDropped}`);
  console.log(`prefixes_dropped=${report.prefixesDropped}`);
  console.log(`restricted_dropped=${report.restrictedDropped}`);
  console.log(`additive=${report.additive}`);

  if (!report.additive) {
    console.error(
      `::error::edit is not additive (${report.violations} violation(s)); refusing. ` +
        "Diff the two plaintexts locally to see which.",
    );
    return EXIT_REFUSED;
  }
  return EXIT_OK;
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
