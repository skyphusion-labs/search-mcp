// AI Search ingest planning: which git paths need a .txt suffix on the R2 key.
//
// Cloudflare AI Search keys off the object name extension. Source we already remap
// (.ts, .jsx, ...) plus extensionless text (Dockerfile) and text files whose
// extension is not in the supported list (.service, .example, ...) upload as
// <path>.txt so the indexer treats them as plain text.

import { extname, basename } from "node:path";

/** Extensions AI Search ingests natively (plain + rich). See CF data-source docs. */
export const AI_SEARCH_NATIVE_EXT = new Set([
  ".txt", ".rst",
  ".log",
  ".ini", ".conf", ".properties", ".toml",
  ".markdown", ".md", ".mdx", ".mdoc",
  ".tex", ".latex",
  ".sh", ".bat", ".ps1",
  ".sgml",
  ".json",
  ".sql",
  ".yaml", ".yml",
  ".css",
  ".js",
  ".php",
  ".py",
  ".rb",
  ".java",
  ".c", ".cpp", ".cxx", ".h", ".hpp",
  ".go",
  ".rs",
  ".swift",
  ".dart",
  ".el",
  ".pdf",
  ".html", ".htm",
  ".xml",
  ".xlsx", ".xlsm", ".xlsb", ".xls", ".et", ".docx",
  ".ods", ".odt",
  ".csv",
  ".numbers",
]);

/** Basenames with no extname() that AI Search lists as native config types. */
export const AI_SEARCH_NATIVE_BASENAMES = new Set([
  ".gitignore",
  ".editorconfig",
  ".dockerignore",
  ".env",
]);

/** Always append .txt regardless of content sniff (TS/JSX + common infra/config suffixes). */
export const REMAP_TO_TXT_EXPLICIT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".jsx", ".astro", ".vue", ".svelte",
  ".mjs", ".cjs",
  ".jsonc",
  ".example", ".sample", ".template", ".tmpl", ".local",
  ".webmanifest", ".manifest",
  ".service", ".socket", ".timer", ".mount", ".path", ".target", ".slice", ".automount",
  ".v4", ".v6",
]);

export const DOC_EXT = new Set([".md", ".markdown", ".mdx", ".mdoc", ".rst", ".txt", ".pdf"]);

export const CONTENT_TYPE = {
  ".txt": "text/plain", ".rst": "text/plain",
  ".md": "text/markdown", ".markdown": "text/markdown", ".mdx": "text/markdown",
  ".json": "application/json", ".yaml": "application/x-yaml", ".yml": "application/x-yaml",
  ".py": "text/x-python", ".go": "text/x-go", ".rs": "text/rust",
  ".js": "application/javascript", ".mjs": "application/javascript", ".cjs": "application/javascript",
  ".sh": "application/x-sh", ".bash": "application/x-sh",
  ".sql": "application/sql", ".toml": "text/plain", ".ini": "text/plain", ".conf": "text/plain",
  ".html": "text/html", ".htm": "text/html", ".xml": "application/xml",
  ".css": "text/css", ".csv": "text/csv", ".pdf": "application/pdf",
};

export function fileExt(relPath) {
  return extname(basename(relPath)).toLowerCase();
}

/** True when the first bytes look like text (no NUL, mostly valid UTF-8). */
export function isLikelyText(buf) {
  if (!buf || buf.length === 0) return true;
  if (buf.includes(0)) return false;
  const s = buf.toString("utf8");
  const bad = (s.match(/\uFFFD/g) || []).length;
  return bad <= Math.max(1, Math.floor(buf.length * 0.02));
}

export function isNativeIngestPath(relPath) {
  const base = basename(relPath);
  const ext = fileExt(relPath);
  return AI_SEARCH_NATIVE_EXT.has(ext) || AI_SEARCH_NATIVE_BASENAMES.has(base);
}

/**
 * Should the R2 object key get a trailing .txt?
 * Native paths: false. Explicit remap extensions: true. Otherwise: true when sample is text.
 */
export function shouldRemapToTxt(relPath, sample) {
  if (isNativeIngestPath(relPath)) return false;
  const ext = fileExt(relPath);
  if (REMAP_TO_TXT_EXPLICIT.has(ext)) return true;
  return isLikelyText(sample);
}

/** True when the file should be uploaded (native as-is, or remapped text). */
export function isIngestible(relPath, sample) {
  if (isNativeIngestPath(relPath)) return true;
  return shouldRemapToTxt(relPath, sample);
}

export function ingestObjectKey(repo, relPath, remapped) {
  return `${repo}/${relPath}${remapped ? ".txt" : ""}`;
}

export function ingestContentType(relPath, remapped) {
  const ext = remapped ? ".txt" : fileExt(relPath);
  return CONTENT_TYPE[ext] || "text/plain";
}

export function ingestKind(relPath) {
  const ext = fileExt(relPath);
  return DOC_EXT.has(ext) || basename(relPath).startsWith("README") ? "doc" : "code";
}

/**
 * Per-repo corpus exclusion (targets.json `excludePaths`). An entry is a repo-relative
 * path: with a trailing "/" it excludes the whole subtree; without, it excludes that
 * exact file or the subtree rooted at that name.
 */
export function isExcludedPath(relPath, prefixes) {
  for (const p of prefixes || []) {
    if (!p) continue;
    if (p.endsWith("/")) {
      if (relPath.startsWith(p)) return true;
    } else if (relPath === p || relPath.startsWith(p + "/")) {
      return true;
    }
  }
  return false;
}
