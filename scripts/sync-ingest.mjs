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
 * One prefix rule, shared by the allowlist and the denylist so the two can
 * never drift. An entry is a repo-relative path: with a trailing "/" it means
 * the subtree, without one it means that exact file or the subtree rooted at
 * that name (so "docs" matches "docs" and "docs/a.md" but never "docsite/a.md").
 */
export function matchesPathPrefix(relPath, prefix) {
  if (typeof prefix !== "string" || prefix === "") return false;
  if (prefix.endsWith("/")) return relPath.startsWith(prefix);
  return relPath === prefix || relPath.startsWith(prefix + "/");
}

/**
 * Per-repo corpus exclusion (targets.json `excludePaths`). Denylist, applied on
 * top of the allowlist. Absent or empty means "exclude nothing".
 */
export function isExcludedPath(relPath, prefixes) {
  for (const p of prefixes || []) {
    if (matchesPathPrefix(relPath, p)) return true;
  }
  return false;
}

/**
 * Per-repo corpus ALLOWLIST (targets.json `includePaths`). When a repo has an
 * entry, ONLY paths under one of its prefixes are eligible for the corpus;
 * everything else is refused. When a repo has NO entry (undefined/null) every
 * path is eligible and `excludePaths` alone applies, so a config that never
 * mentions includePaths behaves exactly as it did before.
 *
 * Why both exist. A denylist is fail-OPEN: add a new top-level file to a repo
 * and it silently joins the corpus. That is fine for a docs site and wrong for
 * a corpus whose boundary matters -- a court-record mirror, anything with a
 * privileged directory, anything where "we forgot to exclude it" is an incident
 * rather than noise. An allowlist is fail-CLOSED: a new path is ineligible
 * until someone says otherwise.
 *
 * An entry that is PRESENT but empty (or malformed) matches nothing rather than
 * everything. "The operator wrote an allowlist" and "the operator wrote no
 * allowlist" are different states and must not collapse into the permissive
 * one; the config validation below turns that state into a hard error before a
 * sync ever reaches this matcher.
 */
export function isIncludedPath(relPath, prefixes) {
  if (prefixes === undefined || prefixes === null) return true;
  if (!Array.isArray(prefixes)) return false;
  for (const p of prefixes) {
    if (matchesPathPrefix(relPath, p)) return true;
  }
  return false;
}

/**
 * Thrown for every includePaths refusal. `code` names the specific state so a
 * test can prove a failure happened for the stated reason and not by accident.
 */
export class IncludePathsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IncludePathsError";
    this.code = code;
  }
}

function describeType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function q(v) {
  return typeof v === "string" ? JSON.stringify(v) : describeType(v) + " " + JSON.stringify(v);
}

/** Every repo named by any target. An includePaths key outside this set reaches nothing. */
export function knownTargetRepos(cfg) {
  const repos = new Set();
  for (const target of Object.values(cfg?.targets || {})) {
    for (const repo of target?.repos || []) repos.add(repo);
  }
  return repos;
}

/**
 * Resolve include/exclude path maps for ONE target (search-mcp#62).
 *
 * Precedence: per-target maps win per-repo over top-level maps. Top-level alone
 * keeps the pre-#62 shape (the same rule for every target that lists the repo).
 * A repo listed only under another target's nested map is not visible here.
 *
 * Why both layers: the original top-level key was fine while every exclusion
 * applied to exactly one target; the moment a repo is deliberately indexed at
 * two granularities (public vs internal), a single map cannot express it.
 */
export function pathMapsForTarget(cfg, targetName) {
  const target = cfg?.targets?.[targetName] || {};
  const topInclude =
    cfg?.includePaths && typeof cfg.includePaths === "object" && !Array.isArray(cfg.includePaths)
      ? cfg.includePaths
      : {};
  const topExclude =
    cfg?.excludePaths && typeof cfg.excludePaths === "object" && !Array.isArray(cfg.excludePaths)
      ? cfg.excludePaths
      : {};
  const tInclude =
    target.includePaths && typeof target.includePaths === "object" && !Array.isArray(target.includePaths)
      ? target.includePaths
      : {};
  const tExclude =
    target.excludePaths && typeof target.excludePaths === "object" && !Array.isArray(target.excludePaths)
      ? target.excludePaths
      : {};
  return {
    includePaths: { ...topInclude, ...tInclude },
    excludePaths: { ...topExclude, ...tExclude },
  };
}

function isPathMapObject(v) {
  return v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate one path-map object against a known-repo set. Returns error objects. */
function validateIncludePathsMap(includePaths, known, label) {
  const errors = [];
  if (includePaths === undefined || includePaths === null) return errors;
  if (!isPathMapObject(includePaths)) {
    errors.push({
      code: "include_paths_not_object",
      message:
        `${label} must be an object keyed by repo, got ${describeType(includePaths)}. ` +
        `Shape: "includePaths": { "my-repo": ["_corpus/"] }.`,
    });
    return errors;
  }
  for (const [repo, prefixes] of Object.entries(includePaths)) {
    if (repo.startsWith("_")) continue; // documentation keys in the example file
    if (!known.has(repo)) {
      errors.push({
        code: "include_paths_unknown_repo",
        message:
          `${label} names repo ${q(repo)}, which is not in the applicable target repo list. ` +
          `Nothing reads that rule, and a rule nothing reads is indistinguishable from a rule ` +
          `that works. Add the repo to the target or delete the entry. Applicable repos: ` +
          `${[...known].join(", ") || "(none)"}.`,
      });
    }
    errors.push(...validateIncludePathsEntry(repo, prefixes));
  }
  return errors;
}

/** Shape check for one repo entry. Returns {code, message} objects, never throws. */
export function validateIncludePathsEntry(repo, prefixes) {
  const errors = [];
  if (!Array.isArray(prefixes)) {
    errors.push({
      code: "include_paths_entry_not_array",
      message:
        `includePaths for repo ${q(repo)} must be an array of repo-relative path prefixes, ` +
        `got ${describeType(prefixes)}. Shape: "includePaths": { "my-repo": ["_corpus/"] }.`,
    });
    return errors;
  }
  if (prefixes.length === 0) {
    errors.push({
      code: "include_paths_entry_empty",
      message:
        `includePaths for repo ${q(repo)} is an empty array, which is a configuration error, ` +
        `not an instruction to index nothing. Remove the repo entry to index all of it, or ` +
        `list the prefixes to index.`,
    });
    return errors;
  }
  for (const p of prefixes) {
    if (typeof p !== "string" || p.trim() === "") {
      errors.push({
        code: "include_paths_entry_invalid",
        message:
          `includePaths for repo ${q(repo)} has entry ${q(p)}: entries must be non-empty strings.`,
      });
    } else if (p.startsWith("/")) {
      errors.push({
        code: "include_paths_entry_invalid",
        message:
          `includePaths for repo ${q(repo)} has entry ${q(p)}: entries are repo-relative and ` +
          `must not start with "/". A git path never does, so this would match nothing.`,
      });
    } else if (p.split("/").includes("..")) {
      errors.push({
        code: "include_paths_entry_invalid",
        message:
          `includePaths for repo ${q(repo)} has entry ${q(p)}: ".." is not something a git path ` +
          `can start with, so this would match nothing.`,
      });
    } else if (p.includes("\\")) {
      errors.push({
        code: "include_paths_entry_invalid",
        message:
          `includePaths for repo ${q(repo)} has entry ${q(p)}: git paths use "/" as the ` +
          `separator, so a backslash would match nothing.`,
      });
    }
  }
  return errors;
}

/**
 * Whole-config check for targets.json `includePaths` (top-level AND per-target,
 * search-mcp#62). Returns {code, message} objects, never throws, so a caller can
 * report all of them at once.
 *
 * Rejects an entry naming a repo no applicable target lists: a rule nothing
 * reads is indistinguishable from a rule that works, which is how an allowlist
 * rots. Per-target maps are checked against that target's repos only.
 */
export function validateIncludePathsConfig(cfg) {
  const errors = [];
  const knownAll = knownTargetRepos(cfg);
  errors.push(...validateIncludePathsMap(cfg?.includePaths, knownAll, "targets.json includePaths"));
  for (const [name, target] of Object.entries(cfg?.targets || {})) {
    if (!target || typeof target !== "object") continue;
    const known = new Set(Array.isArray(target.repos) ? target.repos : []);
    errors.push(
      ...validateIncludePathsMap(target.includePaths, known, `targets.${name}.includePaths`),
    );
  }
  return errors;
}

/** Fail-closed wrapper: throws IncludePathsError carrying the first code and every message. */
export function assertIncludePathsConfig(cfg) {
  const errors = validateIncludePathsConfig(cfg);
  if (!errors.length) return;
  throw new IncludePathsError(errors[0].code, errors.map((e) => e.message).join(" "));
}

/**
 * excludePaths keys (top-level OR nested under a target) naming a repo no
 * applicable target lists. Denylist rot is quieter than allowlist rot (the
 * corpus grows rather than empties), so this is a warning at the call site,
 * not a refusal. Returns unique repo names.
 */
export function unknownExcludePathsRepos(cfg) {
  const out = new Set();
  const knownAll = knownTargetRepos(cfg);
  const top = cfg?.excludePaths;
  if (isPathMapObject(top)) {
    for (const repo of Object.keys(top)) {
      if (!repo.startsWith("_") && !knownAll.has(repo)) out.add(repo);
    }
  }
  for (const target of Object.values(cfg?.targets || {})) {
    if (!target || typeof target !== "object") continue;
    const nested = target.excludePaths;
    if (!isPathMapObject(nested)) continue;
    const known = new Set(Array.isArray(target.repos) ? target.repos : []);
    for (const repo of Object.keys(nested)) {
      if (!repo.startsWith("_") && !known.has(repo)) out.add(repo);
    }
  }
  return [...out];
}

/**
 * Pure path selection for one repo: allowlist first, then denylist on top, so
 * the two compose as defense in depth rather than one replacing the other.
 *
 * `relPaths` is the repo git-tracked file list. Refuses, loudly:
 *
 *   include_paths_entry_*       the entry is malformed or empty
 *   include_paths_no_match      an entry matched ZERO tracked files
 *   include_paths_all_excluded  the allowlist matched, excludePaths took it all
 *
 * The zero-match refusal is the point of the whole mechanism. A prefix that
 * matches nothing (a rename, a misspelling, a directory that moved) otherwise
 * plans an empty corpus, the mirror prune deletes what was there, the reindex
 * succeeds over nothing, and the answer surface returns a confident nothing with
 * every status light green. Coverage is measured against the tracked list before
 * exclusion, so "this prefix names nothing in the repo" stays a distinct
 * diagnostic from "everything it named was excluded".
 */
export function selectRepoPaths(repo, relPaths, opts = {}) {
  const { includePrefixes, excludePrefixes } = opts;
  const paths = relPaths || [];
  if (includePrefixes === undefined || includePrefixes === null) {
    return paths.filter((rel) => !isExcludedPath(rel, excludePrefixes));
  }

  const shapeErrors = validateIncludePathsEntry(repo, includePrefixes);
  if (shapeErrors.length) {
    throw new IncludePathsError(shapeErrors[0].code, shapeErrors.map((e) => e.message).join(" "));
  }

  const unmatched = includePrefixes.filter((p) => !paths.some((rel) => matchesPathPrefix(rel, p)));
  if (unmatched.length) {
    throw new IncludePathsError(
      "include_paths_no_match",
      `includePaths for repo ${q(repo)} matched 0 git-tracked files: ` +
        `${unmatched.map(q).join(", ")} (the repo has ${paths.length} tracked file(s)). ` +
        `An allowlist entry that matches nothing would sync an empty corpus over a healthy one ` +
        `and report success, so the sync refuses instead. Fix the prefix in targets.json ` +
        `(repo-relative, trailing slash for a subtree), or drop the entry if the path is gone. ` +
        `Only the prefixes named above matched nothing.`,
    );
  }

  const included = paths.filter((rel) => isIncludedPath(rel, includePrefixes));
  const kept = included.filter((rel) => !isExcludedPath(rel, excludePrefixes));
  if (kept.length === 0) {
    throw new IncludePathsError(
      "include_paths_all_excluded",
      `includePaths for repo ${q(repo)} selected ${included.length} file(s) and excludePaths ` +
        `removed every one of them. That leaves nothing to sync for this repo, which is an ` +
        `empty corpus dressed as a successful run. Widen includePaths or narrow excludePaths.`,
    );
  }
  return kept;
}
