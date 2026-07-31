import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  corruptArmored,
  countRecipientStanzas,
  inspectTargets,
  main,
  parseRecipients,
  proofPassed,
  proveRoundTrip,
  sha256Hex,
} from "./escrow-targets.mjs";

function ageAvailable(): boolean {
  const res = spawnSync("age", ["--version"]);
  return res.status === 0;
}

const HAS_AGE = ageAvailable();

// The age-dependent suites below skip when the binary is absent, which is a local-dev
// convenience only. CI sets ESCROW_REQUIRE_AGE=1 so that the skip path is provably not
// taken there: a suite that silently skips in CI is indistinguishable from one that
// passes, which is the exact failure this whole change exists to prevent.
describe("test-environment control", () => {
  it("has age available when CI requires it", () => {
    if (process.env.ESCROW_REQUIRE_AGE === "1") {
      expect(HAS_AGE).toBe(true);
    } else {
      expect(typeof HAS_AGE).toBe("boolean");
    }
  });
});

// A realistic-shaped config with DISTINCTIVE names, so a leak test can look for them.
const SECRET_NAMES = [
  "alpha-instance-zzq",
  "alpha-bucket-zzq",
  "repo-one-zzq",
  "repo-two-zzq",
  "beta-instance-zzq",
  "beta-bucket-zzq",
  "repo-three-zzq",
];

const SAMPLE = {
  includePaths: { "repo-three-zzq": ["_corpus/"] },
  excludePaths: { "repo-one-zzq": ["vendor/"] },
  restrictedRepos: ["repo-three-zzq"],
  targets: {
    alpha: {
      instance: "alpha-instance-zzq",
      bucket: "alpha-bucket-zzq",
      repos: ["repo-one-zzq", "repo-two-zzq"],
    },
    beta: {
      instance: "beta-instance-zzq",
      bucket: "beta-bucket-zzq",
      repos: ["repo-three-zzq"],
    },
  },
};

const SAMPLE_JSON = `${JSON.stringify(SAMPLE, null, 2)}\n`;

function keygen(dir: string, name: string): { identity: string; pub: string } {
  const identity = join(dir, name);
  const res = spawnSync("age-keygen", ["-o", identity]);
  if (res.status !== 0) throw new Error("age-keygen failed");
  const text = readFileSync(identity, "utf8");
  const pub = text.match(/^#\s*public key:\s*(age1\S+)\s*$/im)?.[1];
  if (!pub) throw new Error("no public key in identity file");
  return { identity, pub };
}

function encrypt(recipients: string[], src: string, out: string): void {
  const args = ["-a", ...recipients.flatMap((r) => ["-r", r]), "-o", out, src];
  const res = spawnSync("age", args);
  if (res.status !== 0) throw new Error("age encrypt failed");
}

describe("parseRecipients", () => {
  it("reads keys and ignores comments and blank lines", () => {
    const text = "# mackaye\nage1aaa\n\n  age1bbb  \n# trailing\n";
    expect(parseRecipients(text)).toEqual(["age1aaa", "age1bbb"]);
  });

  it("refuses a line that is not an age public key", () => {
    expect(() => parseRecipients("age1aaa\nssh-ed25519 AAAA\n")).toThrow(/age1 public key/);
  });

  it("refuses duplicates", () => {
    expect(() => parseRecipients("age1aaa\nage1aaa\n")).toThrow(/duplicate/);
  });

  it("refuses an empty recipient list", () => {
    expect(() => parseRecipients("# only comments\n")).toThrow(/no recipients/);
  });
});

describe("inspectTargets", () => {
  it("reports counts", () => {
    const shape = inspectTargets(SAMPLE);
    expect(shape.targetCount).toBe(2);
    expect(shape.repoCounts).toEqual([1, 2]);
    expect(shape.includePathsRepoCount).toBe(1);
    expect(shape.excludePathsRepoCount).toBe(1);
    expect(shape.restrictedRepoCount).toBe(1);
  });

  // The shape report is printed in a PUBLIC job log. It must carry no topology.
  it("leaks no target, bucket, instance, or repo name", () => {
    const serialized = JSON.stringify(inspectTargets(SAMPLE));
    for (const name of SECRET_NAMES) {
      expect(serialized).not.toContain(name);
    }
    // Control: the assertion above can fail. Prove the matcher sees a name when present.
    expect(JSON.stringify({ leak: SECRET_NAMES[0] })).toContain(SECRET_NAMES[0]);
  });

  it("refuses a config with no targets", () => {
    expect(() => inspectTargets({ targets: {} })).toThrow(/zero targets/);
  });

  it("refuses a target missing its bucket", () => {
    expect(() =>
      inspectTargets({ targets: { a: { instance: "i", repos: [] } } }),
    ).toThrow(/bucket/);
  });

  it("refuses a non-object config", () => {
    expect(() => inspectTargets([])).toThrow(/not a JSON object/);
  });
});

describe.skipIf(!HAS_AGE)("countRecipientStanzas", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stanza-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("counts one stanza per recipient", () => {
    const src = join(dir, "plain.txt");
    writeFileSync(src, SAMPLE_JSON);
    const a = keygen(dir, "a.txt");
    const b = keygen(dir, "b.txt");
    const c = keygen(dir, "c.txt");

    const one = join(dir, "one.age");
    encrypt([a.pub], src, one);
    expect(countRecipientStanzas(readFileSync(one, "utf8"))).toBe(1);

    const three = join(dir, "three.age");
    encrypt([a.pub, b.pub, c.pub], src, three);
    expect(countRecipientStanzas(readFileSync(three, "utf8"))).toBe(3);
  });
});

describe.skipIf(!HAS_AGE)("corruptArmored", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "corrupt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("actually mutates the payload, and the mutated file no longer decrypts", () => {
    const src = join(dir, "plain.txt");
    writeFileSync(src, SAMPLE_JSON);
    const a = keygen(dir, "a.txt");
    const ct = join(dir, "x.age");
    encrypt([a.pub], src, ct);
    const armored = readFileSync(ct, "utf8");

    const { text, changed } = corruptArmored(armored);
    expect(changed).toBe(true);
    expect(text).not.toBe(armored);
    expect(text.length).toBe(armored.length);

    // Control: the pristine file DOES decrypt, so "fails to decrypt" means something.
    const good = spawnSync("age", ["-d", "-i", a.identity, ct]);
    expect(good.status).toBe(0);
    expect(good.stdout.toString("utf8")).toBe(SAMPLE_JSON);

    const badPath = join(dir, "bad.age");
    writeFileSync(badPath, text);
    const bad = spawnSync("age", ["-d", "-i", a.identity, badPath]);
    expect(bad.status).not.toBe(0);
  });

  // If the corruption ever no-ops, it must SAY so rather than report a clean refusal:
  // proveRoundTrip requires changed === true, so a broken control fails the job loudly
  // instead of passing vacuously.
  it("reports changed=false when there is no payload to corrupt", () => {
    const headerOnly = "-----BEGIN AGE ENCRYPTED FILE-----\n-----END AGE ENCRYPTED FILE-----\n";
    const result = corruptArmored(headerOnly);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(headerOnly);
  });
});

describe.skipIf(!HAS_AGE)("proveRoundTrip", () => {
  let dir: string;
  let src: string;
  let sourceSha: string;
  let recipients: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proof-"));
    src = join(dir, "plain.txt");
    writeFileSync(src, SAMPLE_JSON);
    sourceSha = createHash("sha256").update(SAMPLE_JSON).digest("hex");
    recipients = [keygen(dir, "r1.txt").pub, keygen(dir, "r2.txt").pub];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a genuine artifact", () => {
    const shipped = join(dir, "shipped.age");
    encrypt(recipients, src, shipped);
    const report = proveRoundTrip({
      plaintextPath: src,
      sourceSha256: sourceSha,
      recipients,
      shippedArmored: readFileSync(shipped, "utf8"),
      workDir: dir,
    });
    expect(report.restoresToSource).toBe(true);
    expect(report.corruptRefused).toBe(true);
    expect(report.corruptMutatedTheFile).toBe(true);
    expect(report.strangerRefused).toBe(true);
    expect(report.stanzaCountsMatch).toBe(true);
    expect(report.shippedStanzas).toBe(2);
    expect(report.probeStanzas).toBe(3);
    expect(proofPassed(report)).toBe(true);
  });

  // THE headline case: the escrow is writing garbage. The ciphertext is well formed and
  // age exits 0, but the bytes inside are not the secret. Byte-fidelity, not exit status,
  // is what catches it.
  it("FAILS when the escrowed bytes are not the source bytes", () => {
    const shipped = join(dir, "shipped.age");
    encrypt(recipients, src, shipped);
    const report = proveRoundTrip({
      plaintextPath: src,
      // The source hash of a DIFFERENT value: what a truncated, re-serialized, or
      // wrong-variable materialization would produce.
      sourceSha256: createHash("sha256").update("{}\n").digest("hex"),
      recipients,
      shippedArmored: readFileSync(shipped, "utf8"),
      workDir: dir,
    });
    expect(report.restoresToSource).toBe(false);
    expect(proofPassed(report)).toBe(false);
  });

  it("FAILS when the shipped artifact drops a recipient", () => {
    const shipped = join(dir, "shipped.age");
    encrypt([recipients[0]], src, shipped); // only one of the two intended recipients
    const report = proveRoundTrip({
      plaintextPath: src,
      sourceSha256: sourceSha,
      recipients,
      shippedArmored: readFileSync(shipped, "utf8"),
      workDir: dir,
    });
    expect(report.restoresToSource).toBe(true);
    expect(report.stanzaCountsMatch).toBe(false);
    expect(proofPassed(report)).toBe(false);
  });

  it("FAILS when the shipped artifact carries an unintended extra recipient", () => {
    const extra = keygen(dir, "extra.txt").pub;
    const shipped = join(dir, "shipped.age");
    encrypt([...recipients, extra], src, shipped);
    const report = proveRoundTrip({
      plaintextPath: src,
      sourceSha256: sourceSha,
      recipients,
      shippedArmored: readFileSync(shipped, "utf8"),
      workDir: dir,
    });
    expect(report.stanzaCountsMatch).toBe(false);
    expect(proofPassed(report)).toBe(false);
  });
});

describe.skipIf(!HAS_AGE)("main", () => {
  let dir: string;
  let outDir: string;
  let recipientsFile: string;
  let recipient: { identity: string; pub: string };
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "main-"));
    outDir = join(dir, "out");
    recipient = keygen(dir, "recipient.txt");
    const second = keygen(dir, "second.txt");
    recipientsFile = join(dir, "recipients.txt");
    writeFileSync(recipientsFile, `# crew\n${recipient.pub}\n${second.pub}\n`);

    logged = [];
    errored = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function runMain(env: Record<string, string | undefined>) {
    return main(["--out", outDir, "--recipients", recipientsFile], env as NodeJS.ProcessEnv);
  }

  it("escrows, proves the round trip, and the artifact opens with a REAL recipient key", () => {
    const code = runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON });
    expect(code).toBe(EXIT_OK);
    expect(logged).toContain("escrow_ok=true");
    expect(logged).toContain("proof_restores_to_source=true");
    expect(logged).toContain("proof_corrupt_refused=true");
    expect(logged).toContain("proof_stranger_refused=true");
    expect(logged).toContain("proof_stanza_counts_match=true");

    // The inch CI cannot cover: decrypt the SHIPPED artifact with an actual recipient
    // private key and compare byte for byte against the source.
    const artifact = join(outDir, "targets.json.age");
    const restored = spawnSync("age", ["-d", "-i", recipient.identity, artifact]);
    expect(restored.status).toBe(0);
    expect(restored.stdout.toString("utf8")).toBe(SAMPLE_JSON);

    const meta = JSON.parse(readFileSync(join(outDir, "escrow-meta.json"), "utf8"));
    expect(meta.sourceSha256).toBe(sha256Hex(Buffer.from(SAMPLE_JSON, "utf8")));
    expect(meta.recipientCount).toBe(2);
    expect(meta.shippedRecipientStanzas).toBe(2);
    expect(meta.targetCount).toBe(2);
  });

  // Recording-proxy assertion: prove the value was never PASSED to console, not merely
  // that the final log text looks clean.
  it("never passes plaintext or any topology name to stdout or stderr", () => {
    runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON });
    const all = [...logged, ...errored].join("\n");
    expect(all).not.toContain(SAMPLE_JSON.trim());
    for (const name of SECRET_NAMES) {
      expect(all).not.toContain(name);
    }
    // Control: the proxy records. Without this, an empty capture would pass vacuously.
    expect(all).toContain("escrow_ok=true");
    expect(logged.length).toBeGreaterThan(5);
  });

  it("writes no plaintext into the output directory", () => {
    runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON });
    const files = readdirSync(outDir);
    expect(files.sort()).toEqual(["escrow-meta.json", "targets.json.age"]);
    for (const file of files) {
      const body = readFileSync(join(outDir, file), "utf8");
      for (const name of SECRET_NAMES) {
        expect(body).not.toContain(name);
      }
    }
  });

  it("refuses a recipients list shorter than the pinned count", () => {
    const code = runMain({
      SKYPHUSION_TARGETS_JSON: SAMPLE_JSON,
      ESCROW_EXPECT_RECIPIENTS: "3",
    });
    expect(code).toBe(EXIT_FAILED);
    expect(errored.join("\n")).toContain("expected 3");
  });

  it("accepts a recipients list matching the pinned count", () => {
    const code = runMain({
      SKYPHUSION_TARGETS_JSON: SAMPLE_JSON,
      ESCROW_EXPECT_RECIPIENTS: "2",
    });
    expect(code).toBe(EXIT_OK);
  });

  it("refuses when the secret is absent", () => {
    expect(runMain({})).toBe(EXIT_USAGE);
    expect(errored.join("\n")).toContain("SKYPHUSION_TARGETS_JSON is not set");
  });

  it("refuses a secret that is not a targets config, without echoing it", () => {
    const junk = "not json at all zzq-marker";
    const code = runMain({ SKYPHUSION_TARGETS_JSON: junk });
    expect(code).toBe(EXIT_FAILED);
    expect([...logged, ...errored].join("\n")).not.toContain("zzq-marker");
  });

  it("refuses a well-formed JSON blob that declares no targets", () => {
    expect(runMain({ SKYPHUSION_TARGETS_JSON: `{"targets":{}}` })).toBe(EXIT_FAILED);
  });

  it("prints only a fingerprint of the source hash, never the full digest", () => {
    runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON });
    const full = sha256Hex(Buffer.from(SAMPLE_JSON, "utf8"));
    const all = [...logged, ...errored].join("\n");
    expect(all).not.toContain(full);
    expect(all).toContain(`source_sha256_fp=${full.slice(0, 12)}`);
    // The full digest still reaches the escrow metadata, which never enters the log.
    const meta = JSON.parse(readFileSync(join(outDir, "escrow-meta.json"), "utf8"));
    expect(meta.sourceSha256).toBe(full);
  });

  it("reports drift against an expected hash without revealing either value", () => {
    const sha = sha256Hex(Buffer.from(SAMPLE_JSON, "utf8"));
    runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON, ESCROW_EXPECT_SHA256: sha });
    expect(logged).toContain("escrow_in_sync=true");

    logged.length = 0;
    runMain({ SKYPHUSION_TARGETS_JSON: SAMPLE_JSON, ESCROW_EXPECT_SHA256: "0".repeat(64) });
    expect(logged).toContain("escrow_in_sync=false");
  });
});
