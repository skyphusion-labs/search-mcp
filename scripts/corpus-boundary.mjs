// Optional safety checks for scripts/sync.mjs when a target is named `public`.
//
// (1) targets.json overlap: assert targets.public.repos ∩ restrictedRepos === ∅.
//     restrictedRepos only drives optional per-file metadata; it does NOT exclude a
//     repo from the public bucket.
// (2) optional live GitHub visibility: refuse any non-public repo before upload.

/** Pure: repos listed in BOTH the public target and restrictedRepos. */
export function publicRestrictedOverlap(publicRepos, restrictedRepos) {
  const restricted = new Set(restrictedRepos || []);
  return (publicRepos || []).filter((r) => restricted.has(r));
}

/** Fail-closed when target is public and restrictedRepos overlaps the public list. */
export function assertPublicCorpusBoundary(cfg, targetName) {
  if (targetName !== "public") return;
  const overlap = publicRestrictedOverlap(
    cfg?.targets?.public?.repos,
    cfg?.restrictedRepos,
  );
  if (!overlap.length) return;
  throw new Error(
    "public corpus boundary violation: " +
      overlap.join(", ") +
      " listed in BOTH targets.public.repos and restrictedRepos. " +
      "restrictedRepos only sets metadata; it does NOT exclude a repo from the public bucket. " +
      "Remove each repo from one list before syncing public.",
  );
}

function githubTokenFromEnv(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || "";
}

// GitHub repo/org slug charset; rejects path segments and other URL metacharacters
// before repo names from targets.json reach the GitHub API fetch.
const GITHUB_SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function assertGithubSlug(slug, kind) {
  if (typeof slug !== "string" || !GITHUB_SLUG_RE.test(slug)) {
    throw new Error(`invalid GitHub ${kind} for API request: ${String(slug)}`);
  }
  return slug;
}

const GITHUB_API_HEADERS = (token) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "search-mcp-corpus-boundary",
});

/** Paginated org repo list; URL uses only the org slug (env), never targets.json repo names. */
async function fetchPublicRepoNames(org, token, fetchImpl) {
  const names = new Set();
  let page = 1;
  while (true) {
    const url = new URL(`/orgs/${org}/repos`, "https://api.github.com");
    url.searchParams.set("type", "public");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await fetchImpl(url.toString(), { headers: GITHUB_API_HEADERS(token) });
    if (res.status === 404) {
      throw new Error(`GitHub org not found: ${org}`);
    }
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      throw new Error(`GitHub API ${res.status} listing public repos for ${org}: ${snippet}`);
    }
    const body = await res.json();
    if (!Array.isArray(body) || !body.length) break;
    for (const entry of body) {
      if (entry && typeof entry.name === "string") names.add(entry.name);
    }
    if (body.length < 100) break;
    page += 1;
  }
  return names;
}

/** Live check: each repo must be visibility=public on GitHub. */
export async function verifyGithubRepoVisibility(repos, opts = {}) {
  const {
    org = "",
    token = "",
    fetchImpl = globalThis.fetch,
  } = opts;
  if (!org) {
    throw new Error("org is required for GitHub visibility verification");
  }
  assertGithubSlug(org, "org");
  if (!token) {
    return { skipped: true, reason: "no_github_token", checked: [], nonPublic: [] };
  }
  if (!fetchImpl) {
    throw new Error("fetch is not available for GitHub visibility verification");
  }

  const nonPublic = [];
  const checked = [];
  const publicNames = await fetchPublicRepoNames(org, token, fetchImpl);
  for (const repo of repos || []) {
    assertGithubSlug(repo, "repo");
    checked.push(repo);
    if (!publicNames.has(repo)) {
      nonPublic.push({
        repo,
        visibility: "not_public_or_missing",
      });
    }
  }
  return { skipped: false, checked, nonPublic };
}

/** Fail-closed when any public-target repo is not public on GitHub. Skips when no token. */
export async function assertPublicGithubVisibility(cfg, opts = {}) {
  const repos = cfg?.targets?.public?.repos || [];
  const org = opts.org ?? process.env.CORPUS_GIT_ORG ?? "";
  const token = opts.token ?? githubTokenFromEnv(opts.env);
  const result = await verifyGithubRepoVisibility(repos, { ...opts, org, token });
  if (result.skipped) return result;
  if (!result.nonPublic.length) return result;
  const detail = result.nonPublic
    .map((x) => `${x.repo} (${x.visibility}${x.reason ? ": " + x.reason : ""})`)
    .join(", ");
  throw new Error(
    "public corpus boundary violation: non-public repos on GitHub would sync to the public bucket: " +
      detail +
      ". Flip public on GitHub, remove from targets.public.repos, or sync under a non-public target.",
  );
}
