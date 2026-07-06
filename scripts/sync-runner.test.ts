import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  reposForTargets,
  instancesForTargets,
  gitAuthArgs,
  scrubSecrets,
  describeExit,
  run,
} from "./sync-runner.mjs";

const cfg = {
  targets: {
    alpha: { instance: "search-alpha", bucket: "b1", repos: ["a", "b"] },
    beta: { instance: "search-beta", bucket: "b2", repos: ["a", "b", "c"] },
  },
};

describe("parseArgs", () => {
  it("defaults to all targets, reindex on", () => {
    const o = parseArgs([], ["alpha", "beta"]);
    expect(o.targets).toEqual(["alpha", "beta"]);
    expect(o.reindex).toBe(true);
    expect(o.dryRun).toBe(false);
  });

  it("selects a single target", () => {
    expect(parseArgs(["alpha"], ["alpha", "beta"]).targets).toEqual(["alpha"]);
  });

  it("dry-run disables reindex and passes through", () => {
    const o = parseArgs(["alpha", "--dry-run"], ["alpha", "beta"]);
    expect(o.dryRun).toBe(true);
    expect(o.reindex).toBe(false);
    expect(o.passThrough).toContain("--dry-run");
  });
});

describe("reposForTargets", () => {
  it("de-duplicates the union across targets in order", () => {
    expect(reposForTargets(cfg, ["alpha", "beta"])).toEqual(["a", "b", "c"]);
  });
});

describe("gitAuthArgs", () => {
  it("never echoes the raw token in serialized args", () => {
    const token = "ghp_supersecretvalue123";
    const args = gitAuthArgs(token);
    expect(JSON.stringify(args)).not.toContain(token);
  });
});

describe("run", () => {
  const plan = {
    repos: ["a", "b"],
    targets: ["alpha"],
    instances: ["search-alpha"],
    reindex: true,
  };

  it("clone failure aborts before sync", () => {
    const runSync = vi.fn();
    const res = run(plan, {
      cloneTree: (repo) => {
        if (repo === "b") {
          const e: any = new Error("git failed");
          e.status = 128;
          throw e;
        }
      },
      runSync,
      runReindex: vi.fn(),
      log: () => {},
      error: () => {},
    });
    expect(res.exitCode).toBe(1);
    expect(runSync).not.toHaveBeenCalled();
  });
});
