import { describe, it, expect } from "vitest";
import {
  shouldRemapToTxt,
  isIngestible,
  ingestObjectKey,
  isExcludedPath,
  isIncludedPath,
  selectRepoPaths,
  validateIncludePathsConfig,
  assertIncludePathsConfig,
  unknownExcludePathsRepos,
  knownTargetRepos,
  pathMapsForTarget,
  IncludePathsError,
} from "./sync-ingest.mjs";

const text = Buffer.from("#!/bin/bash\necho hello\n");
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]);

/**
 * Prove a refusal happened for the STATED reason. A harness that accepts any
 * throw passes when the code throws for an unrelated reason, which is worse
 * than no test: it reports the guard as working when the guard is not the
 * thing that fired.
 */
function expectRefusal(fn: () => unknown, code: string, ...mustSay: string[]) {
  let caught: unknown;
  let returned: unknown;
  let threw = false;
  try {
    returned = fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  expect(threw, `expected a refusal, got a return value: ${JSON.stringify(returned)}`).toBe(true);
  expect(caught).toBeInstanceOf(IncludePathsError);
  const err = caught as InstanceType<typeof IncludePathsError>;
  expect(err.code, `refused with the wrong code: ${err.message}`).toBe(code);
  for (const phrase of mustSay) expect(err.message).toContain(phrase);
}

describe("shouldRemapToTxt", () => {
  it("remaps TS and extensionless infra text", () => {
    expect(shouldRemapToTxt("src/index.ts", text)).toBe(true);
    expect(shouldRemapToTxt("Dockerfile", text)).toBe(true);
  });

  it("leaves native extensions alone", () => {
    expect(shouldRemapToTxt("README.md", text)).toBe(false);
  });

  it("does not remap unknown binary", () => {
    expect(isIngestible("image.dat", binary)).toBe(false);
  });
});

describe("ingestObjectKey", () => {
  it("appends .txt when remapped", () => {
    expect(ingestObjectKey("my-repo", "Dockerfile", true)).toBe("my-repo/Dockerfile.txt");
  });
});

describe("isExcludedPath", () => {
  it("excludes configured prefixes", () => {
    const prefixes = ["notes/private/", "README.secret"];
    expect(isExcludedPath("notes/private/foo.md", prefixes)).toBe(true);
    expect(isExcludedPath("notes/public/foo.md", prefixes)).toBe(false);
  });
});

describe("isIncludedPath (corpus allowlist)", () => {
  // POSITIVE CONTROL. An allowlist that rejects everything would make every
  // negative assertion below pass for free.
  it("admits a path inside an allowed subtree", () => {
    expect(isIncludedPath("_corpus/doc/p001.txt", ["_corpus/"])).toBe(true);
  });

  it("refuses a path outside every allowed prefix", () => {
    expect(isIncludedPath("_data/faq.json", ["_corpus/"])).toBe(false);
    expect(isIncludedPath("index.html", ["_corpus/"])).toBe(false);
  });

  it("is fail-closed for a NEW top-level file", () => {
    // This is the whole reason the allowlist exists. A denylist would admit
    // this file silently; an allowlist refuses it until someone opts it in.
    expect(isIncludedPath("brand-new-accidental-file.json", ["_corpus/"])).toBe(false);
  });

  it("treats a bare name as that file or its subtree", () => {
    expect(isIncludedPath("docs", ["docs"])).toBe(true);
    expect(isIncludedPath("docs/guide.md", ["docs"])).toBe(true);
    expect(isIncludedPath("docsite/guide.md", ["docs"])).toBe(false);
  });

  it("admits everything only when NO allowlist is configured", () => {
    expect(isIncludedPath("anything/at/all.md", undefined)).toBe(true);
    expect(isIncludedPath("anything/at/all.md", null)).toBe(true);
  });

  it("treats a present-but-empty or malformed allowlist as matching nothing", () => {
    // "The operator wrote an allowlist" and "the operator wrote no allowlist"
    // are different states. Collapsing them into the permissive one is how an
    // empty entry would silently index a whole repo.
    expect(isIncludedPath("anything/at/all.md", [])).toBe(false);
    expect(isIncludedPath("anything/at/all.md", "_corpus/" as unknown as string[])).toBe(false);
  });

  it("supports several allowed prefixes", () => {
    const allow = ["_corpus/", "docs/"];
    expect(isIncludedPath("docs/a.md", allow)).toBe(true);
    expect(isIncludedPath("_corpus/a.txt", allow)).toBe(true);
    expect(isIncludedPath("src/a.ts", allow)).toBe(false);
  });
});

// A repo shaped like the court-record mirror: a Jekyll site plus an evidence
// system, with the only indexable material under _corpus/.
const MIRROR_TREE = [
  "_config.yml",
  "_layouts/default.html",
  "_data/faq.json",
  "index.html",
  "evidence/src/pages/index.astro",
  "_corpus/2024-01-01-motion.pdf",
  "_corpus/2024-02-02-order.pdf",
  "_corpus/index.md",
];

describe("selectRepoPaths: no allowlist (backwards compatible)", () => {
  it("returns every tracked path when neither list is configured", () => {
    expect(selectRepoPaths("r", MIRROR_TREE, {})).toEqual(MIRROR_TREE);
  });

  it("applies excludePaths alone, exactly as before", () => {
    const kept = selectRepoPaths("r", MIRROR_TREE, { excludePrefixes: ["_data/"] });
    expect(kept).not.toContain("_data/faq.json");
    // POSITIVE CONTROL: the rest of the tree is untouched.
    expect(kept).toContain("index.html");
    expect(kept).toHaveLength(MIRROR_TREE.length - 1);
  });
});

describe("selectRepoPaths: allowlist", () => {
  it("keeps only paths under an allowed prefix", () => {
    expect(selectRepoPaths("r", MIRROR_TREE, { includePrefixes: ["_corpus/"] })).toEqual([
      "_corpus/2024-01-01-motion.pdf",
      "_corpus/2024-02-02-order.pdf",
      "_corpus/index.md",
    ]);
  });

  it("composes with excludePaths subtractively (defense in depth)", () => {
    const kept = selectRepoPaths("r", MIRROR_TREE, {
      includePrefixes: ["_corpus/"],
      excludePrefixes: ["_corpus/index.md"],
    });
    expect(kept).toEqual(["_corpus/2024-01-01-motion.pdf", "_corpus/2024-02-02-order.pdf"]);
    // The denylist subtracts from the allowlist; it never adds back.
    expect(kept).not.toContain("index.html");
  });

  it("supports several prefixes, each of which must pull its weight", () => {
    const kept = selectRepoPaths("r", MIRROR_TREE, { includePrefixes: ["_corpus/", "_data/"] });
    expect(kept).toContain("_corpus/index.md");
    expect(kept).toContain("_data/faq.json");
    expect(kept).not.toContain("index.html");
  });
});

describe("selectRepoPaths: zero-match is a hard error", () => {
  // THE regression test. Before this refusal existed, a prefix that matched
  // nothing planned zero objects, the mirror prune deleted the corpus that was
  // there, the reindex succeeded over nothing, and every status light stayed
  // green while the answer surface went silently empty.
  it("refuses when a prefix matches no tracked file", () => {
    // POSITIVE CONTROL first: the same tree with the right prefix succeeds, so
    // the refusal below is about the prefix and not about the fixture.
    expect(selectRepoPaths("mirror", MIRROR_TREE, { includePrefixes: ["_corpus/"] })).toHaveLength(3);

    expectRefusal(
      () => selectRepoPaths("mirror", MIRROR_TREE, { includePrefixes: ["corpus/"] }),
      "include_paths_no_match",
      "matched 0 git-tracked files",
      '"corpus/"',
      "mirror",
    );
  });

  it("refuses after the allowed directory is renamed out from under it", () => {
    // Joan restructures the repo: _corpus/ becomes corpus/. The allowlist now
    // names a directory that does not exist.
    const restructured = MIRROR_TREE.map((p) => p.replace(/^_corpus\//, "corpus/"));
    expectRefusal(
      () => selectRepoPaths("mirror", restructured, { includePrefixes: ["_corpus/"] }),
      "include_paths_no_match",
      "matched 0 git-tracked files",
      '"_corpus/"',
    );
    // And the fixed config works, so the refusal is not a dead end.
    expect(selectRepoPaths("mirror", restructured, { includePrefixes: ["corpus/"] })).toHaveLength(3);
  });

  it("names only the prefixes that matched nothing, not the ones that worked", () => {
    let message = "";
    try {
      selectRepoPaths("mirror", MIRROR_TREE, { includePrefixes: ["_corpus/", "transcripts/"] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"transcripts/"');
    expect(message).not.toContain('"_corpus/"');
  });

  it("refuses an empty allowlist rather than reading it as index-nothing", () => {
    expectRefusal(
      () => selectRepoPaths("mirror", MIRROR_TREE, { includePrefixes: [] }),
      "include_paths_entry_empty",
      "empty array",
    );
  });

  it("refuses entries that could never match a git path", () => {
    for (const bad of ["/_corpus/", "../_corpus/", "_corpus\\docs", "", 42]) {
      expectRefusal(
        () => selectRepoPaths("mirror", MIRROR_TREE, { includePrefixes: [bad] as string[] }),
        "include_paths_entry_invalid",
        JSON.stringify(bad),
      );
    }
  });

  it("refuses when excludePaths removes everything the allowlist selected", () => {
    expectRefusal(
      () =>
        selectRepoPaths("mirror", MIRROR_TREE, {
          includePrefixes: ["_corpus/"],
          excludePrefixes: ["_corpus/"],
        }),
      "include_paths_all_excluded",
      "excludePaths removed every one",
    );
  });
});

const CFG = {
  includePaths: { "rockenhaus-litigation-public": ["_corpus/"] },
  excludePaths: { "fleet-chezmoi": ["claude-memory/"] },
  targets: {
    public: { repos: ["search-mcp", "postern"] },
    internal: { repos: ["search-mcp", "fleet-chezmoi"] },
    litigation: { repos: ["rockenhaus-litigation-public"] },
  },
};

describe("includePaths config validation", () => {
  it("accepts a config with no includePaths at all", () => {
    expect(validateIncludePathsConfig({ targets: CFG.targets })).toEqual([]);
  });

  it("accepts an entry whose repo is in any target, not just the one being synced", () => {
    // POSITIVE CONTROL for every negative below: this config must be clean.
    expect(validateIncludePathsConfig(CFG)).toEqual([]);
    expect(() => assertIncludePathsConfig(CFG)).not.toThrow();
  });

  it("collects every repo across every target", () => {
    expect([...knownTargetRepos(CFG)].sort()).toEqual([
      "fleet-chezmoi",
      "postern",
      "rockenhaus-litigation-public",
      "search-mcp",
    ]);
  });

  it("rejects an entry naming a repo no target lists", () => {
    const cfg = { ...CFG, includePaths: { "rockenhaus-litigation-pubic": ["_corpus/"] } };
    const errors = validateIncludePathsConfig(cfg);
    expect(errors.map((e: { code: string }) => e.code)).toContain("include_paths_unknown_repo");
    expect(errors[0].message).toContain("rockenhaus-litigation-pubic");
    expect(errors[0].message).toContain("not in the applicable target repo list");
    expectRefusal(
      () => assertIncludePathsConfig(cfg),
      "include_paths_unknown_repo",
      "rockenhaus-litigation-pubic",
    );
  });

  it("rejects a non-object includePaths", () => {
    expectRefusal(
      () => assertIncludePathsConfig({ ...CFG, includePaths: ["_corpus/"] }),
      "include_paths_not_object",
      "keyed by repo",
    );
  });

  it("rejects a repo entry that is not an array", () => {
    expectRefusal(
      () =>
        assertIncludePathsConfig({
          ...CFG,
          includePaths: { "rockenhaus-litigation-public": "_corpus/" },
        }),
      "include_paths_entry_not_array",
      "must be an array",
    );
  });

  it("rejects an empty repo entry", () => {
    expectRefusal(
      () =>
        assertIncludePathsConfig({ ...CFG, includePaths: { "rockenhaus-litigation-public": [] } }),
      "include_paths_entry_empty",
      "empty array",
    );
  });

  it("reports every problem at once, not just the first", () => {
    const cfg = {
      ...CFG,
      includePaths: { "not-a-repo": [], "rockenhaus-litigation-public": ["/_corpus/"] },
    };
    const errors = validateIncludePathsConfig(cfg);
    expect(errors.map((e: { code: string }) => e.code).sort()).toEqual([
      "include_paths_entry_empty",
      "include_paths_entry_invalid",
      "include_paths_unknown_repo",
    ]);
  });
});

describe("unknownExcludePathsRepos", () => {
  it("is quiet when every excludePaths repo is in a target", () => {
    expect(unknownExcludePathsRepos(CFG)).toEqual([]);
  });

  it("names an excludePaths repo no target lists", () => {
    expect(unknownExcludePathsRepos({ ...CFG, excludePaths: { ops: ["docs/"] } })).toEqual(["ops"]);
  });

  it("names a nested excludePaths repo missing from that target (search-mcp#62)", () => {
    const cfg = {
      targets: {
        public: {
          instance: "i",
          bucket: "b",
          repos: ["a"],
          excludePaths: { "ghost-repo": ["x/"] },
        },
      },
    };
    expect(unknownExcludePathsRepos(cfg)).toEqual(["ghost-repo"]);
  });
});

describe("pathMapsForTarget (search-mcp#62)", () => {
  const cfg = {
    includePaths: { shared: ["docs/"], "only-top": ["top/"] },
    excludePaths: { shared: ["vendor/"] },
    targets: {
      public: {
        instance: "pub",
        bucket: "bp",
        repos: ["shared", "only-top", "public-only"],
        includePaths: { shared: ["_corpus/"], "public-only": ["src/"] },
        excludePaths: { shared: ["secret/"] },
      },
      internal: {
        instance: "int",
        bucket: "bi",
        repos: ["shared", "only-top"],
      },
    },
  };

  it("merges top-level with per-target, target winning per repo", () => {
    const maps = pathMapsForTarget(cfg, "public");
    expect(maps.includePaths.shared).toEqual(["_corpus/"]);
    expect(maps.includePaths["only-top"]).toEqual(["top/"]);
    expect(maps.includePaths["public-only"]).toEqual(["src/"]);
    expect(maps.excludePaths.shared).toEqual(["secret/"]);
  });

  it("falls back to top-level alone when the target has no nested maps", () => {
    const maps = pathMapsForTarget(cfg, "internal");
    expect(maps.includePaths.shared).toEqual(["docs/"]);
    expect(maps.excludePaths.shared).toEqual(["vendor/"]);
    expect(maps.includePaths["public-only"]).toBeUndefined();
  });

  it("accepts a per-target allowlist for a repo only that target lists", () => {
    const nested = {
      targets: {
        rockenhaus: {
          instance: "rockenhaus-public",
          bucket: "rockenhaus-search-public",
          repos: ["rockenhaus-litigation-public"],
          includePaths: { "rockenhaus-litigation-public": ["_corpus/"] },
        },
      },
    };
    expect(validateIncludePathsConfig(nested)).toEqual([]);
  });

  it("refuses a nested allowlist naming a repo not in that target", () => {
    const nested = {
      targets: {
        rockenhaus: {
          instance: "rockenhaus-public",
          bucket: "rockenhaus-search-public",
          repos: ["rockenhaus-litigation-public"],
          includePaths: { "someone-else": ["_corpus/"] },
        },
      },
    };
    expectRefusal(
      () => assertIncludePathsConfig(nested),
      "include_paths_unknown_repo",
      "targets.rockenhaus.includePaths",
      "someone-else",
    );
  });
});
