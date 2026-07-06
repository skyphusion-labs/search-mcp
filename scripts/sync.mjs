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
  isExcludedPath,
} from "./sync-ingest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SYNC_REPO_ROOT || join(HERE, "..", "..");
const MAX_BYTES = 4 * 1024 * 1024;

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SKIP_GITHUB = args.includes("--no-github-verify") || process.env.SYNC_SKIP_GITHUB_VERIFY === "1";
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
  const path = join(HERE, "targets.json");
  if (!existsSync(path)) {
    console.error(
      "Missing scripts/targets.json. Copy scripts/targets.json.example and edit it.",
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function planRepo(repo, excludePrefixes = []) {
  const repoDir = join(REPO_ROOT, repo);
  if (!existsSync(repoDir)) {
    console.warn(`  ! skip ${repo}: not cloned at ${repoDir}`);
    return [];
  }
  const items = [];
  for (const rel of trackedFiles(repoDir)) {
    if (shouldSkip(rel)) continue;
    if (isExcludedPath(rel, excludePrefixes)) continue;
    const abs = join(repoDir, rel);
    let size;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) {
      console.warn(`  ! skip ${repo}/${rel}: ${(size / 1048576).toFixed(1)} MB over 4 MB`);
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
  return items;
}

async function main() {
  if (!targetName) {
    console.error("usage: node scripts/sync.mjs <target> [--dry-run] [--no-github-verify]");
    process.exit(2);
  }
  const cfg = loadConfig();
  const target = cfg.targets[targetName];
  if (!target) {
    console.error(`unknown target '${targetName}'. known: ${Object.keys(cfg.targets).join(", ")}`);
    process.exit(2);
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

  const plan = [];
  for (const repo of target.repos) {
    const items = planRepo(repo, cfg.excludePaths?.[repo]);
    if (items.length) console.log(`  + ${repo}: ${items.length} files`);
    plan.push(...items);
  }
  console.log(`Planned ${plan.length} objects for ${target.bucket}.`);

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
  console.error(err);
  process.exit(1);
});
