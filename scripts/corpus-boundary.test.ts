import { describe, it, expect, vi } from "vitest";
import {
  publicRestrictedOverlap,
  assertPublicCorpusBoundary,
  verifyGithubRepoVisibility,
  assertPublicGithubVisibility,
  assertGithubSlug,
} from "./corpus-boundary.mjs";

describe("publicRestrictedOverlap", () => {
  it("returns repos in both lists", () => {
    expect(publicRestrictedOverlap(["a", "b", "c"], ["b", "d"])).toEqual(["b"]);
  });
});

describe("assertPublicCorpusBoundary", () => {
  it("no-ops for non-public targets", () => {
    expect(() =>
      assertPublicCorpusBoundary(
        { restrictedRepos: ["x"], targets: { public: { repos: ["x"] } } },
        "corpus",
      ),
    ).not.toThrow();
  });

  it("throws when public target overlaps restrictedRepos", () => {
    expect(() =>
      assertPublicCorpusBoundary(
        {
          restrictedRepos: ["secret-repo"],
          targets: { public: { repos: ["secret-repo", "open-repo"] } },
        },
        "public",
      ),
    ).toThrow(/public corpus boundary violation/);
  });
});

describe("assertGithubSlug", () => {
  it("accepts valid slugs", () => {
    expect(assertGithubSlug("open-repo", "repo")).toBe("open-repo");
    expect(assertGithubSlug("skyphusion-labs", "org")).toBe("skyphusion-labs");
  });

  it("rejects path metacharacters", () => {
    expect(() => assertGithubSlug("../evil", "repo")).toThrow(/invalid GitHub repo/);
    expect(() => assertGithubSlug("foo/bar", "repo")).toThrow(/invalid GitHub repo/);
  });
});

describe("verifyGithubRepoVisibility", () => {
  it("skips when no token", async () => {
    const r = await verifyGithubRepoVisibility(["open-repo"], { org: "acme", token: "" });
    expect(r.skipped).toBe(true);
  });

  it("flags repos not in the org public list", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/orgs/acme/repos");
      expect(url).not.toContain("secret-repo");
      return new Response(
        JSON.stringify([{ name: "open-repo" }, { name: "other-public" }]),
        { status: 200 },
      );
    });
    const r = await verifyGithubRepoVisibility(["open-repo", "secret-repo"], {
      org: "acme",
      token: "test-token",
      fetchImpl,
    });
    expect(r.nonPublic.map((x) => x.repo)).toEqual(["secret-repo"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
