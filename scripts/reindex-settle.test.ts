import { describe, it, expect, vi } from "vitest";
import {
  parseCfTimestamp,
  jobInFlight,
  newestJobStart,
  shouldReindex,
  instancesFromConfig,
  settle,
} from "./reindex-settle.mjs";

const T = (s: string) => Date.parse(s);

describe("parseCfTimestamp", () => {
  it("reads the AI Search space-separated shape as UTC, not local", () => {
    expect(parseCfTimestamp("2026-07-16 19:29:59")).toBe(T("2026-07-16T19:29:59Z"));
  });

  it("accepts an already-ISO value", () => {
    expect(parseCfTimestamp("2026-07-16T19:29:59Z")).toBe(T("2026-07-16T19:29:59Z"));
  });

  it("returns null for missing or unparseable input", () => {
    expect(parseCfTimestamp(null)).toBeNull();
    expect(parseCfTimestamp("")).toBeNull();
    expect(parseCfTimestamp("not a date")).toBeNull();
  });
});

describe("jobInFlight", () => {
  it("is true when any job has no ended_at", () => {
    expect(jobInFlight([{ ended_at: "2026-07-16 19:00:00" }, { ended_at: null }])).toBe(true);
  });

  it("is false when every job has ended", () => {
    expect(jobInFlight([{ ended_at: "2026-07-16 19:00:00" }])).toBe(false);
  });

  it("is false for an empty or missing list", () => {
    expect(jobInFlight([])).toBe(false);
    expect(jobInFlight(undefined)).toBe(false);
  });
});

describe("newestJobStart", () => {
  it("returns the latest start regardless of list order", () => {
    const jobs = [
      { started_at: "2026-07-16 19:01:32", ended_at: "2026-07-16 19:05:53" },
      { started_at: "2026-07-16 19:29:59", ended_at: "2026-07-16 19:35:43" },
      { started_at: "2026-07-16 19:14:09", ended_at: "2026-07-16 19:16:28" },
    ];
    expect(newestJobStart(jobs)).toBe(T("2026-07-16T19:29:59Z"));
  });

  it("returns null when the instance has never been indexed", () => {
    expect(newestJobStart([])).toBeNull();
  });
});

describe("shouldReindex", () => {
  const ended = [{ started_at: "2026-07-16 19:00:00", ended_at: "2026-07-16 19:06:00" }];

  it("never fires into a running job (this is the #12 regression guard)", () => {
    const jobs = [{ started_at: "2026-07-16 19:29:59", ended_at: null }];
    const d = shouldReindex({ jobs, lastSyncCompletedAt: T("2026-07-16T19:40:00Z") });
    expect(d.reindex).toBe(false);
    expect(d.reason).toMatch(/in flight/);
  });

  it("fires when a sync completed after the last reindex started", () => {
    const d = shouldReindex({ jobs: ended, lastSyncCompletedAt: T("2026-07-16T19:20:00Z") });
    expect(d.reindex).toBe(true);
  });

  it("does not fire when the index is current with the last sync", () => {
    const d = shouldReindex({ jobs: ended, lastSyncCompletedAt: T("2026-07-16T18:50:00Z") });
    expect(d.reindex).toBe(false);
    expect(d.reason).toMatch(/current/);
  });

  it("compares against started_at, so a sync mid-job still earns a trailing pass", () => {
    // Job ran 19:00 to 19:06; the sync finished 19:03, i.e. objects landed after the job
    // began scanning and this job cannot be trusted to have seen them.
    const d = shouldReindex({ jobs: ended, lastSyncCompletedAt: T("2026-07-16T19:03:00Z") });
    expect(d.reindex).toBe(true);
  });

  it("fires for an instance that has never been indexed", () => {
    const d = shouldReindex({ jobs: [], lastSyncCompletedAt: T("2026-07-16T19:00:00Z") });
    expect(d.reindex).toBe(true);
  });

  it("does not fire when sync history is unavailable", () => {
    expect(shouldReindex({ jobs: ended, lastSyncCompletedAt: null }).reindex).toBe(false);
  });
});

describe("instancesFromConfig", () => {
  it("de-duplicates instances across targets", () => {
    const cfg = {
      targets: {
        a: { instance: "search-x" },
        b: { instance: "search-y" },
        c: { instance: "search-x" },
      },
    };
    expect(instancesFromConfig(cfg)).toEqual(["search-x", "search-y"]);
  });
});

describe("settle", () => {
  const owed = [{ started_at: "2026-07-16 19:00:00", ended_at: "2026-07-16 19:06:00" }];
  const inFlight = [{ started_at: "2026-07-16 19:29:59", ended_at: null }];
  const quiet = () => {};

  it("fires only for instances that are owed a pass", async () => {
    const runReindex = vi.fn();
    const r = await settle(["search-internal", "search-public"], {
      getJobs: (i: string) => (i === "search-internal" ? owed : inFlight),
      getLastSyncCompletedAt: async () => T("2026-07-16T19:20:00Z"),
      runReindex,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).toHaveBeenCalledExactlyOnceWith("search-internal");
    expect(r.fired).toEqual(["search-internal"]);
    expect(r.exitCode).toBe(0);
  });

  it("dispatches nothing in dry-run", async () => {
    const runReindex = vi.fn();
    const r = await settle(["search-internal"], {
      getJobs: () => owed,
      getLastSyncCompletedAt: async () => T("2026-07-16T19:20:00Z"),
      runReindex,
      dryRun: true,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).not.toHaveBeenCalled();
    expect(r.fired).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("fails closed when sync history cannot be read, rather than reindexing blind", async () => {
    const runReindex = vi.fn();
    const r = await settle(["search-internal"], {
      getJobs: () => owed,
      getLastSyncCompletedAt: async () => {
        throw new Error("HTTP 503");
      },
      runReindex,
      log: quiet,
      error: quiet,
    });
    expect(runReindex).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(1);
  });

  it("reports a non-zero exit when a dispatch fails", async () => {
    const r = await settle(["search-internal"], {
      getJobs: () => owed,
      getLastSyncCompletedAt: async () => T("2026-07-16T19:20:00Z"),
      runReindex: () => {
        throw new Error("wrangler exploded");
      },
      log: quiet,
      error: quiet,
    });
    expect(r.exitCode).toBe(1);
    expect(r.fired).toEqual([]);
  });
});
