import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  reposForTargets,
  instancesForTargets,
  gitAuthArgs,
  scrubSecrets,
  describeExit,
  jobInFlight,
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
    const token = "fake-test-token-not-a-ghp-credential";
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

describe("jobInFlight", () => {
  it("is true when a job has not ended", () => {
    expect(jobInFlight([{ ended_at: null }])).toBe(true);
  });

  it("is false when every job has ended, and for an empty list", () => {
    expect(jobInFlight([{ ended_at: "2026-07-16 19:35:43" }])).toBe(false);
    expect(jobInFlight([])).toBe(false);
  });
});

describe("run reindex guard (#12)", () => {
  const plan = {
    repos: ["a"],
    targets: ["alpha"],
    instances: ["search-alpha"],
    reindex: true,
  };
  const quiet = () => {};

  it("dispatches when no job is in flight", () => {
    const runReindex = vi.fn();
    const res = run(plan, {
      cloneTree: () => "fetch",
      runSync: vi.fn(),
      runReindex,
      reindexInFlight: () => false,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).toHaveBeenCalledExactlyOnceWith("search-alpha");
    expect(res.exitCode).toBe(0);
  });

  it("skips dispatch when a job is in flight, so the running job is not superseded", () => {
    const runReindex = vi.fn();
    const res = run(plan, {
      cloneTree: () => "fetch",
      runSync: vi.fn(),
      runReindex,
      reindexInFlight: () => true,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).not.toHaveBeenCalled();
    // A skip is not a failure: the corpus is in R2 and reindex-settle fires the trailing pass.
    expect(res.exitCode).toBe(0);
    expect(res.synced).toBe(true);
  });

  it("still syncs the corpus when the reindex dispatch is skipped", () => {
    const runSync = vi.fn();
    run(plan, {
      cloneTree: () => "fetch",
      runSync,
      runReindex: vi.fn(),
      reindexInFlight: () => true,
      log: quiet,
      error: quiet,
    });
    expect(runSync).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("dispatches when no guard is injected, preserving prior behavior", () => {
    const runReindex = vi.fn();
    run(plan, {
      cloneTree: () => "fetch",
      runSync: vi.fn(),
      runReindex,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).toHaveBeenCalledExactlyOnceWith("search-alpha");
  });
});
