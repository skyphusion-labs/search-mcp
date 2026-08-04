#!/usr/bin/env node
// Git-to-R2 sync for Cloudflare AI Search.
//
// Walks git-tracked files for each repo in a target, filters binaries / secrets /
// build noise, remaps source AI Search cannot natively index to .txt, attaches
// metadata, uploads to the target R2 bucket, and prunes stale objects (mirror).
//
// Usage:
//   node scripts/sync.mjs corpus
//   node scripts/sync.mjs corpus --dry-run
//   node scripts/sync.mjs public --no-github-verify
//
// Env:
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (required unless --dry-run)
//   R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID   (to build the S3 endpoint)
//   R2_S3_ENDPOINT                            (optional override)
//   SEARCH_MCP_TARGETS                       (optional path to targets.json)
//   SYNC_REPO_ROOT                            (optional clone root)
//   GITHUB_TOKEN or GH_TOKEN                  (optional; live visibility check for public target)
//   CORPUS_GIT_ORG                            (required for GitHub visibility check)
//   SYNC_SKIP_GITHUB_VERIFY=1                 (optional)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicCorpusBoundary,
  assertPublicGithubVisibility,
} from "./corpus-boundary.mjs";
import {
  isIngestible,
  shouldRemapToTxt,
  isNativeIngestPath,
  ingestObjectKey,
  ingestContentType,
  ingestKind,
  fileExt,
  selectRepoPaths,
  assertIncludePathsConfig,
  unknownExcludePathsRepos,
  pathMapsForTarget,
  IncludePathsError,
} from "./sync-ingest.mjs";
import {
  resolveTargetsPath,
  defaultRepoRoot,
  targetsHelp,
} from "./config-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGETS_PATH = resolveTargetsPath(HERE);
const REPO_ROOT = defaultRepoRoot(HERE, TARGETS_PATH);
// Objects larger than this are skipped. Configurable because the right value
// depends on the corpus: 4 MB is fine for a source tree and wrong for scanned
// PDFs, where the single largest document is often the one that matters most.
// Skips are also summarised at the end of the run, not only warned inline: a
// warning in a long CI log is a silent omission in practice.
const MAX_BYTES = Number(process.env.SYNC_MAX_BYTES || 4 * 1024 * 1024);

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SKIP_GITHUB = args.includes("--no-github-verify") || process.env.SYNC_SKIP_GITHUB_VERIFY === "1";
// Opt-in strictness: turn an incomplete corpus into a failed run.
const FAIL_ON_SKIP = args.includes("--fail-on-skip");
const targetName = args.find((a) => !a.startsWith("--"));

const SKIP_EXT = new Set([
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".ico", ".icns",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".psd",
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".mp3", ".wav", ".flac", ".ogg",
  ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".bin", ".exe", ".dll", ".so", ".dylib", ".wasm", ".o", ".a",
  ".pt", ".pth", ".safetensors", ".onnx", ".gguf", ".ckpt", ".npy", ".npz", ".parquet",
  ".age", ".gpg", ".enc", ".pem", ".crt", ".p12", ".pfx", ".jks",
  ".map", ".lock",
]);

const SKIP_BASENAME = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "poetry.lock", "Cargo.lock", "uv.lock", "bun.lockb",
]);

const SKIP_DIR_SEGMENT = new Set([
  "node_modules", "dist", "build", ".wrangler", "coverage", ".git",
  "vendor", ".venv", "venv", "target", "__pycache__", ".next", ".turbo", ".cache",
]);

function isEnvSecret(base) {
  if (!/^\.env($|\.)/.test(base) && !/\.env$/.test(base)) return false;
  return !/(example|sample|template)/i.test(base);
}

function shouldSkip(relPath) {
  const segs = relPath.split("/");
  if (segs.some((s) => SKIP_DIR_SEGMENT.has(s))) return true;
  const base = basename(relPath);
  if (SKIP_BASENAME.has(base)) return true;
  if (isEnvSecret(base)) return true;
  const ext = fileExt(relPath);
  if (SKIP_EXT.has(ext)) return true;
  if (base.endsWith(".min.js")) return true;
  return false;
}

function trackedFiles(repoDir) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoDir,
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.toString("utf8").split("\0").filter(Boolean);
}

const TEXT_SAMPLE_BYTES = 8192;

function readTextSample(abs, size) {
  const len = Math.min(TEXT_SAMPLE_BYTES, size);
  if (len === 0) return Buffer.alloc(0);
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function loadConfig() {
  if (!TARGETS_PATH) {
    console.error(targetsHelp(HERE));
    process.exit(2);
  }
  return JSON.parse(readFileSync(TARGETS_PATH, "utf8"));
}

function planRepo(repo, excludePrefixes, includePrefixes, skipped = []) {
  const repoDir = join(REPO_ROOT, repo);
  const hasAllowlist = includePrefixes !== undefined && includePrefixes !== null;
  if (!existsSync(repoDir)) {
    // A repo with an allowlist has been described exactly: it contributes these
    // paths and nothing else. A missing clone contributes nothing, which is the
    // same empty-corpus-with-green-lights failure the allowlist exists to stop.
    if (hasAllowlist) {
      throw new IncludePathsError(
        "include_paths_repo_not_cloned",
        `includePaths for repo "${repo}" cannot be enforced: not cloned at ${repoDir}. ` +
          `A repo with an allowlist is expected to contribute exactly those paths, so a ` +
          `missing clone refuses the sync instead of quietly syncing nothing for it.`,
      );
    }
    console.warn(`  ! skip ${repo}: not cloned at ${repoDir}`);
    return [];
  }
  // Allowlist first, then denylist on top; both refusals happen here, before a
  // single object is uploaded or pruned.
  const candidates = selectRepoPaths(repo, trackedFiles(repoDir), {
    includePrefixes,
    excludePrefixes,
  });
  const items = [];
  for (const rel of candidates) {
    if (shouldSkip(rel)) continue;
    const abs = join(repoDir, rel);
    let size;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) {
      const mb = (size / 1048576).toFixed(1);
      const capMb = (MAX_BYTES / 1048576).toFixed(1);
      console.warn(`  ! skip ${repo}/${rel}: ${mb} MB over the ${capMb} MB cap`);
      skipped.push({ repo, path: rel, mb });
      continue;
    }
    const sample = readTextSample(abs, size);
    if (!isIngestible(rel, sample)) continue;
    const remapped = !isNativeIngestPath(rel) && shouldRemapToTxt(rel, sample);
    const origExt = fileExt(rel);
    const key = ingestObjectKey(repo, rel, remapped);
    items.push({
      abs,
      key,
      contentType: ingestContentType(rel, remapped),
      metadata: {
        repo,
        path: rel.slice(0, 500),
        lang: (origExt.replace(".", "") || "text").slice(0, 60),
        kind: ingestKind(rel),
      },
    });
  }
  if (hasAllowlist && items.length === 0) {
    throw new IncludePathsError(
      "include_paths_all_filtered",
      `includePaths for repo "${repo}" selected ${candidates.length} file(s) and none of them ` +
        `survived the ingest filters (build/vendor directories, lockfiles, .env, binaries, the ` +
        `size cap, or the text sniff). Nothing would upload for this repo, so the sync refuses ` +
        `rather than publish an empty corpus.`,
    );
  }
  return items;
}

async function main() {
  if (!targetName) {
    console.error(
      "usage: node scripts/sync.mjs <target> [--dry-run] [--no-github-verify] [--fail-on-skip]",
    );
    process.exit(2);
  }
  const cfg = loadConfig();
  const target = cfg.targets[targetName];
  if (!target) {
    console.error(`unknown target '${targetName}'. known: ${Object.keys(cfg.targets).join(", ")}`);
    process.exit(2);
  }

  // Config-level allowlist checks run for every target, not just the one being
  // synced: a rule that names a repo no target lists is rot, and rot found only
  // when someone syncs that one target is rot found late.
  assertIncludePathsConfig(cfg);
  for (const repo of unknownExcludePathsRepos(cfg)) {
    console.warn(
      `  ! excludePaths names repo '${repo}', which no target lists in its repos. ` +
        "That rule is inert; delete it or add the repo to a target.",
    );
  }

  assertPublicCorpusBoundary(cfg, targetName);
  if (targetName === "public" && !SKIP_GITHUB) {
    const gh = await assertPublicGithubVisibility(cfg);
    if (gh.skipped) {
      console.warn(
        "  ! GITHUB_TOKEN / GH_TOKEN unset: skipping live GitHub visibility check " +
          "(overlap check passed). Set a token or pass --no-github-verify to silence.",
      );
    } else {
      console.log(`  GitHub visibility ok for ${gh.checked.length} public-target repos.`);
    }
  } else if (targetName === "public" && SKIP_GITHUB) {
    console.warn("  ! --no-github-verify: live GitHub visibility check skipped.");
  }

  console.log(`Target '${targetName}' -> bucket ${target.bucket} (instance ${target.instance})`);
  console.log(`Repo root: ${REPO_ROOT}${DRY ? "  [DRY RUN]" : ""}`);

  // #62: per-target path maps win over top-level for this target.
  const pathMaps = pathMapsForTarget(cfg, targetName);

  const plan = [];
  const skipped = [];
  for (const repo of target.repos) {
    const items = planRepo(
      repo,
      pathMaps.excludePaths?.[repo],
      pathMaps.includePaths?.[repo],
      skipped,
    );
    if (items.length) console.log(`  + ${repo}: ${items.length} files`);
    plan.push(...items);
  }
  console.log(`Planned ${plan.length} objects for ${target.bucket}.`);

  // Summarise oversize skips. A file silently missing from the corpus looks
  // exactly like a file the corpus does not contain, which is the worst
  // possible failure mode for something that answers questions.
  if (skipped.length) {
    console.warn(`\n  ! ${skipped.length} file(s) skipped for exceeding the size cap:`);
    for (const s of skipped) console.warn(`      ${s.repo}/${s.path} (${s.mb} MB)`);
    console.warn(
      "    These are NOT in the corpus. Raise SYNC_MAX_BYTES, extract their text into\n" +
        "    a smaller form, or accept that nothing can answer from them.",
    );
    if (FAIL_ON_SKIP) {
      console.error("--fail-on-skip: refusing to continue with an incomplete corpus.");
      process.exit(1);
    }
  }

  if (DRY) {
    for (const it of plan.slice(0, 25)) console.log(`    ${it.key}`);
    if (plan.length > 25) console.log(`    ... and ${plan.length - 25} more`);
    console.log("Dry run: no uploads, no prune.");
    return;
  }

  const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } =
    await import("@aws-sdk/client-s3");

  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const endpoint =
    process.env.R2_S3_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint) {
    console.error("Set R2_S3_ENDPOINT or R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID.");
    process.exit(2);
  }
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error("Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.");
    process.exit(2);
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = target.bucket;

  const seen = new Set();
  let up = 0;
  let idx = 0;
  const concurrency = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY || 12));
  async function uploadWorker() {
    while (idx < plan.length) {
      const it = plan[idx++];
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: it.key,
          Body: readFileSync(it.abs),
          ContentType: it.contentType,
          Metadata: it.metadata,
        }),
      );
      seen.add(it.key);
      if (++up % 200 === 0) console.log(`  uploaded ${up}/${plan.length}`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, plan.length) }, uploadWorker),
  );
  console.log(`Uploaded ${up} objects.`);

  const stale = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket, ContinuationToken }),
    );
    for (const obj of res.Contents || []) {
      if (obj.Key && !seen.has(obj.Key)) stale.push({ Key: obj.Key });
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);

  for (let i = 0; i < stale.length; i += 1000) {
    const batch = stale.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch } }),
    );
  }
  console.log(`Pruned ${stale.length} stale objects.`);
  console.log("Done. AI Search will re-index on its next sync.");
}

main().catch((err) => {
  // A config refusal is an operator error, not a crash: print the diagnostic
  // without a stack, and exit 2 like the other targets.json failures.
  if (err instanceof IncludePathsError) {
    console.error(`\n${err.message}\n  [${err.code}]`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
