import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  reposForTargets,
  instancesForTargets,
  gitAuthArgs,
  scrubSecrets,
  describeExit,
  jobInFlight,
  awaitReindexSlot,
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

  it("clone failure aborts before sync", async () => {
    const runSync = vi.fn();
    const res = await run(plan, {
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

describe("awaitReindexSlot (#12)", () => {
  const quiet = () => {};
  const running = [{ ended_at: null }];
  const done = [{ ended_at: "2026-07-16 19:35:43" }];

  it("dispatches without waiting when nothing is in flight", async () => {
    const sleep = vi.fn();
    const r = await awaitReindexSlot("search-alpha", {
      listJobs: () => done,
      sleep,
      log: quiet,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(r).toEqual({ waited: false, timedOut: false });
  });

  it("waits while a job is in flight, then returns once it finishes", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const r = await awaitReindexSlot("search-alpha", {
      // in flight for the first two polls, finished on the third
      listJobs: () => (++calls <= 2 ? running : done),
      sleep,
      log: quiet,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ waited: true, timedOut: false });
  });

  it("gives up at the bound and dispatches anyway rather than leaving the corpus unindexed", async () => {
    let clock = 0;
    const r = await awaitReindexSlot("search-alpha", {
      listJobs: () => running, // never finishes
      sleep: async () => {
        clock += 15_000;
      },
      now: () => clock,
      timeoutMs: 60_000,
      pollMs: 15_000,
      log: quiet,
    });
    expect(r.timedOut).toBe(true);
    expect(r.waited).toBe(true);
  });

  it("says so loudly when it supersedes on timeout", async () => {
    let clock = 0;
    const log = vi.fn();
    await awaitReindexSlot("search-internal", {
      listJobs: () => running,
      sleep: async () => {
        clock += 15_000;
      },
      now: () => clock,
      timeoutMs: 30_000,
      log,
    });
    const said = log.mock.calls.flat().join(" ");
    expect(said).toMatch(/still in flight/);
    expect(said).toMatch(/superseding/);
  });
});

describe("run reindex ordering (#12)", () => {
  const plan = {
    repos: ["a"],
    targets: ["alpha"],
    instances: ["search-alpha"],
    reindex: true,
  };
  const quiet = () => {};

  it("waits for the slot before dispatching, and dispatches exactly once", async () => {
    const order: string[] = [];
    const res = await run(plan, {
      cloneTree: () => "fetch",
      runSync: () => order.push("sync"),
      awaitSlot: async () => order.push("wait"),
      runReindex: () => order.push("reindex"),
      log: quiet,
      error: quiet,
    });
    // The upload must be complete before we wait, and the wait before we dispatch, so the
    // job we start always sees the objects this run uploaded.
    expect(order).toEqual(["sync", "wait", "reindex"]);
    expect(res.exitCode).toBe(0);
  });

  it("never reindexes when the sync itself failed", async () => {
    const runReindex = vi.fn();
    await expect(
      run(plan, {
        cloneTree: () => "fetch",
        runSync: () => {
          throw new Error("sync blew up");
        },
        awaitSlot: async () => {},
        runReindex,
        log: quiet,
        error: quiet,
      }),
    ).rejects.toThrow(/sync blew up/);
    expect(runReindex).not.toHaveBeenCalled();
  });

  it("dispatches when no waiter is injected, preserving prior behavior", async () => {
    const runReindex = vi.fn();
    await run(plan, {
      cloneTree: () => "fetch",
      runSync: vi.fn(),
      runReindex,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).toHaveBeenCalledExactlyOnceWith("search-alpha");
  });
});
