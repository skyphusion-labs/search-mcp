import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  diffAdditive,
  main,
} from "./guard-targets-additive.mjs";

const NAMES = ["inst-public-zzq", "bucket-public-zzq", "repo-a-zzq", "repo-b-zzq"];

const BASE = {
  includePaths: { "repo-a-zzq": ["docs/"] },
  excludePaths: { "repo-a-zzq": ["vendor/"] },
  restrictedRepos: ["repo-b-zzq"],
  targets: {
    public: {
      instance: "inst-public-zzq",
      bucket: "bucket-public-zzq",
      repos: ["repo-a-zzq"],
    },
    internal: {
      instance: "inst-internal-zzq",
      bucket: "bucket-internal-zzq",
      repos: ["repo-a-zzq", "repo-b-zzq"],
    },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("diffAdditive", () => {
  it("accepts an unchanged config", () => {
    const report = diffAdditive(BASE, clone(BASE));
    expect(report.additive).toBe(true);
    expect(report.targetsPreserved).toBe(2);
    expect(report.targetsAdded).toBe(0);
    expect(report.violations).toBe(0);
  });

  // The actual change this guard was built for.
  it("accepts adding a third target plus its allowlist", () => {
    const next = clone(BASE);
    next.targets.rockenhaus = {
      instance: "rockenhaus-public",
      bucket: "rockenhaus-search-public",
      repos: ["rockenhaus-litigation-public"],
    };
    next.includePaths["rockenhaus-litigation-public"] = ["_corpus/"];
    const report = diffAdditive(BASE, next);
    expect(report.additive).toBe(true);
    expect(report.targetsPreserved).toBe(2);
    expect(report.targetsAdded).toBe(1);
  });

  // The catastrophe: writing the secret blind drops the targets you could not read.
  // Sync mirror-prunes, so this refuses rather than quietly emptying two live buckets.
  it("REFUSES a config that drops a prior target", () => {
    const next = clone(BASE);
    delete (next.targets as Record<string, unknown>).internal;
    const report = diffAdditive(BASE, next);
    expect(report.additive).toBe(false);
    expect(report.targetsMissing).toBe(1);
    expect(report.targetsPreserved).toBe(1);
    // The vanished target takes its repos with it, so the blast radius reads as a number.
    expect(report.reposDropped).toBe(2);
  });

  it("REFUSES a config that drops one repo from a surviving target", () => {
    const next = clone(BASE);
    next.targets.internal.repos = ["repo-a-zzq"];
    const report = diffAdditive(BASE, next);
    expect(report.additive).toBe(false);
    expect(report.reposDropped).toBe(1);
    expect(report.targetsMissing).toBe(0);
  });

  it("REFUSES a retargeted bucket or instance", () => {
    const rebucket = clone(BASE);
    rebucket.targets.public.bucket = "somewhere-else";
    expect(diffAdditive(BASE, rebucket).bucketsChanged).toBe(1);
    expect(diffAdditive(BASE, rebucket).additive).toBe(false);

    const reinstance = clone(BASE);
    reinstance.targets.public.instance = "somewhere-else";
    expect(diffAdditive(BASE, reinstance).instancesChanged).toBe(1);
    expect(diffAdditive(BASE, reinstance).additive).toBe(false);
  });

  // A widened boundary is the other silent failure: it admits files the corpus
  // previously kept out, which no prune counter would ever notice.
  it("REFUSES dropping an includePaths allowlist entry", () => {
    const next = clone(BASE);
    delete (next.includePaths as Record<string, unknown>)["repo-a-zzq"];
    const report = diffAdditive(BASE, next);
    expect(report.additive).toBe(false);
    expect(report.includePathsReposDropped).toBe(1);
  });

  it("REFUSES dropping one prefix from a surviving allowlist", () => {
    const before = clone(BASE);
    before.includePaths["repo-a-zzq"] = ["docs/", "spec/"];
    const next = clone(before);
    next.includePaths["repo-a-zzq"] = ["docs/"];
    const report = diffAdditive(before, next);
    expect(report.additive).toBe(false);
    expect(report.prefixesDropped).toBe(1);
  });

  it("REFUSES dropping an excludePaths denylist entry", () => {
    const next = clone(BASE);
    delete (next.excludePaths as Record<string, unknown>)["repo-a-zzq"];
    expect(diffAdditive(BASE, next).excludePathsReposDropped).toBe(1);
    expect(diffAdditive(BASE, next).additive).toBe(false);
  });

  it("REFUSES dropping a restrictedRepos entry", () => {
    const next = clone(BASE);
    next.restrictedRepos = [];
    expect(diffAdditive(BASE, next).restrictedDropped).toBe(1);
    expect(diffAdditive(BASE, next).additive).toBe(false);
  });

  it("ignores the underscore documentation keys of the example file", () => {
    const before = {
      includePaths: { _comment: ["ignored"], "repo-a-zzq": ["docs/"] },
      targets: BASE.targets,
    };
    const next = clone(before);
    delete (next.includePaths as Record<string, unknown>)._comment;
    expect(diffAdditive(before, next).additive).toBe(true);
  });

  it("refuses to compare a config with no targets object", () => {
    expect(() => diffAdditive({}, BASE)).toThrow(/not a JSON object/);
  });
});

describe("guard main", () => {
  let dir: string;
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-"));
    logged = [];
    errored = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, value: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  }

  it("exits 0 on an additive edit", () => {
    const next = clone(BASE);
    next.targets.third = { instance: "i3", bucket: "b3", repos: [] };
    const code = main(["--old", write("old.json", BASE), "--new", write("new.json", next)]);
    expect(code).toBe(EXIT_OK);
    expect(logged).toContain("prior_targets_preserved=2/2");
    expect(logged).toContain("additive=true");
  });

  it("exits 2 and stays silent about names on a destructive edit", () => {
    const next = clone(BASE);
    delete (next.targets as Record<string, unknown>).public;
    const code = main(["--old", write("old.json", BASE), "--new", write("new.json", next)]);
    expect(code).toBe(EXIT_REFUSED);
    expect(logged).toContain("additive=false");

    const all = [...logged, ...errored].join("\n");
    for (const name of NAMES) {
      expect(all).not.toContain(name);
    }
    // Control: the capture is live, so the assertion above is not vacuous.
    expect(all).toContain("prior_targets_preserved=1/2");
  });

  it("exits 1 on a missing argument", () => {
    expect(main([])).toBe(EXIT_USAGE);
  });

  it("exits 1 when a file will not parse", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(main(["--old", bad, "--new", bad])).toBe(EXIT_USAGE);
  });
});
