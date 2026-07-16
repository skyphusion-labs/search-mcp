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
  dispatchWithCooldownRetry,
  isCooldownError,
  productionReindexDeps,
  REINDEX_INFLIGHT_TIMEOUT_MS,
  REINDEX_COOLDOWN_TIMEOUT_MS,
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

describe("production wiring", () => {
  // Regression guard. Every seam in sync-runner is injected, so the stubs in this file say
  // nothing about what main() actually constructs. Ripping out reindex-settle deleted the
  // module-scope listJobs while main still referenced it: tests green, `node --check` clean,
  // and the first real dispatch would have thrown ReferenceError. Building the dep object
  // here evaluates every binding, so that failure surfaces in CI instead of in production.
  it("builds main's reindex deps with no undefined symbols", () => {
    const deps = productionReindexDeps();
    expect(typeof deps.listJobs).toBe("function");
    expect(typeof deps.sleep).toBe("function");
  });

  it("wires a sleep that actually resolves", async () => {
    await expect(productionReindexDeps().sleep(1)).resolves.toBeUndefined();
  });
});

describe("isCooldownError", () => {
  // Shape taken verbatim from a real failed run (2026-07-16 21:19:21Z).
  const real = Object.assign(new Error("Command failed"), {
    stderr:
      "✘ [ERROR] A request to the Cloudflare API (/accounts/x/ai-search/namespaces/default/" +
      "instances/skyphusion-internal/jobs) failed.\n\n  sync_in_cooldown [code: 7020]\n",
  });

  it("recognizes the real wrangler cooldown failure", () => {
    expect(isCooldownError(real)).toBe(true);
  });

  it("matches on the bare code too", () => {
    expect(isCooldownError({ message: "code: 7020" })).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isCooldownError(new Error("ENOTFOUND api.cloudflare.com"))).toBe(false);
    expect(isCooldownError({ stderr: "authentication error [code: 10000]" })).toBe(false);
    expect(isCooldownError(undefined)).toBe(false);
  });
});

describe("dispatchWithCooldownRetry (#12)", () => {
  const quiet = () => {};
  const cooldown = () =>
    Object.assign(new Error("Command failed"), { stderr: "sync_in_cooldown [code: 7020]" });

  it("dispatches once when there is no cooldown", async () => {
    const runReindexOnce = vi.fn();
    const r = await dispatchWithCooldownRetry("search-alpha", {
      runReindexOnce,
      sleep: vi.fn(),
      log: quiet,
    });
    expect(runReindexOnce).toHaveBeenCalledExactlyOnceWith("search-alpha");
    expect(r.retried).toBe(false);
  });

  it("retries through cooldown and succeeds once it clears", async () => {
    let n = 0;
    const runReindexOnce = vi.fn(() => {
      if (++n <= 3) throw cooldown();
    });
    const r = await dispatchWithCooldownRetry("search-alpha", {
      runReindexOnce,
      sleep: async () => {},
      log: quiet,
    });
    expect(runReindexOnce).toHaveBeenCalledTimes(4);
    expect(r.retried).toBe(true);
  });

  it("rethrows a non-cooldown failure immediately without retrying", async () => {
    const runReindexOnce = vi.fn(() => {
      throw new Error("authentication error [code: 10000]");
    });
    await expect(
      dispatchWithCooldownRetry("search-alpha", {
        runReindexOnce,
        sleep: async () => {},
        log: quiet,
      }),
    ).rejects.toThrow(/authentication/);
    expect(runReindexOnce).toHaveBeenCalledOnce();
  });

  it("fails loud past the bound, and the message carries the blast radius", async () => {
    let clock = 0;
    await expect(
      dispatchWithCooldownRetry("skyphusion-internal", {
        runReindexOnce: () => {
          throw cooldown();
        },
        sleep: async () => {
          clock += 15_000;
        },
        now: () => clock,
        timeoutMs: 60_000,
        log: quiet,
      }),
    ).rejects.toThrow(/no data is lost[\s\S]*next sync or the daily backstop/);
  });
});

describe("reindex bound math", () => {
  // The trap: one shared deadline would fail loud on a HEALTHY path, because the two waits are
  // additive (wait out an in-flight reindex, then still owe a cooldown wait).
  //
  // WORST_INFLIGHT_MS is measured (internal reindex ran 4m01s / 5m05s / 5m44s on 2026-07-16).
  // COOLDOWN_MARGIN_MS is NOT a measurement: the observed cooldown is far shorter (rejected at
  // 10s after a job end, accepted at 32s). It is the margin we choose to design to, because the
  // observation is not a contract Cloudflare owes us and may move with corpus size or load.
  // Asserting against the margin rather than the observation is what keeps ordinary upstream
  // variance from turning into red builds.
  const WORST_INFLIGHT_MS = 6 * 60 * 1000;
  const COOLDOWN_MARGIN_MS = 7 * 60 * 1000;

  it("budgets each phase separately, not one shared deadline", () => {
    expect(REINDEX_INFLIGHT_TIMEOUT_MS).toBeGreaterThan(WORST_INFLIGHT_MS);
    expect(REINDEX_COOLDOWN_TIMEOUT_MS).toBeGreaterThan(COOLDOWN_MARGIN_MS);
  });

  it("a single shared bound would have been too small for the healthy worst case", () => {
    // Documents why this is two budgets: the sum exceeds either one alone.
    expect(WORST_INFLIGHT_MS + COOLDOWN_MARGIN_MS).toBeGreaterThan(REINDEX_INFLIGHT_TIMEOUT_MS);
    expect(REINDEX_INFLIGHT_TIMEOUT_MS + REINDEX_COOLDOWN_TIMEOUT_MS).toBeGreaterThan(
      WORST_INFLIGHT_MS + COOLDOWN_MARGIN_MS,
    );
  });
});

describe("reindex-only mode", () => {
  const quiet = () => {};

  it("skips clone and sync but still reindexes", async () => {
    const cloneTree = vi.fn();
    const runSync = vi.fn();
    const runReindex = vi.fn();
    const res = await run(
      { repos: ["a"], targets: ["alpha"], instances: ["search-alpha"], reindex: true, sync: false },
      { cloneTree, runSync, runReindex, log: quiet, error: quiet },
    );
    expect(cloneTree).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
    expect(runReindex).toHaveBeenCalledExactlyOnceWith("search-alpha");
    expect(res.exitCode).toBe(0);
  });

  it("parseArgs maps --reindex-only to sync:false, reindex:true", () => {
    const o = parseArgs(["--reindex-only"], ["alpha"]);
    expect(o.sync).toBe(false);
    expect(o.reindex).toBe(true);
  });

  it("parseArgs defaults to sync:true", () => {
    expect(parseArgs([], ["alpha"]).sync).toBe(true);
  });
});
