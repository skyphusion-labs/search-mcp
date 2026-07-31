#!/usr/bin/env node
// Escrow the SKYPHUSION_TARGETS_JSON Actions secret as age ciphertext, and PROVE the
// escrow can be restored before anything is asked to depend on it.
//
// Why this exists: GitHub Actions secrets are write-only. The corpus configuration for
// every live AI Search instance lived in exactly one unreadable place, so it could
// neither be recovered nor edited additively (see search-mcp#63).
//
// THE HAZARD THIS SCRIPT IS BUILT AROUND
// GitHub log masking matches the literal secret string only; it does NOT follow the
// value through a transformation. Re-serialize the JSON, base64 it, jq it, diff it, or
// echo a substring and the masking silently stops applying. This repository is PUBLIC,
// so its job logs are world readable. Therefore:
//   - the plaintext only ever exists inside a 0700 temp dir, removed on exit;
//   - every assertion emits a boolean, a count, or a sha256, NEVER content;
//   - no target name, bucket name, instance name, or repo name is printed anywhere.
//
// WHAT THE PROOF DOES AND DOES NOT COVER
// An escrowed copy nobody has proven they can restore from is not a recovery copy. The
// job therefore round-trips the artifact rather than merely observing that encryption
// exited 0. No real recipient private key exists in CI (by design), so the in-job proof
// closes everything except the last inch:
//   proven here  -- the bytes handed to age are byte-identical to the secret; age
//                   encrypt/decrypt round-trips in this environment; the check is
//                   capable of FAILING (two negative controls); the shipped artifact
//                   carries exactly the intended number of recipient stanzas.
//   NOT proven here -- that a real recipient key opens the shipped file. That last inch
//                   is closed recipient-side by crew-secrets scripts/verify-escrow.sh,
//                   which decrypts with a real key and compares against the sha256 this
//                   script records. Recording that hash is what makes the recipient-side
//                   proof repeatable forever instead of a thing a human did once.
//
// Usage: node scripts/escrow-targets.mjs --out <dir> [--recipients <file>]
//
// Env:
//   SKYPHUSION_TARGETS_JSON  required -- the secret being escrowed
//   ESCROW_RECIPIENTS_FILE   age recipients, one per line (# comments ok); or --recipients
//   AGE_BIN / AGE_KEYGEN_BIN optional binary overrides (default: age / age-keygen)
//   ESCROW_EXPECT_RECIPIENTS optional -- pin the recipient count; refuse a short list
//   ESCROW_EXPECT_SHA256     optional -- drift check. When set, the job compares the
//                            live secret against this hash and reports in-sync or drifted
//                            without ever revealing either value.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILED = 2;

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Parse an age recipients file: one key per line, # comments and blanks ignored. */
export function parseRecipients(text) {
  const lines = String(text).split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith("age1")) {
      throw new Error(`recipient line ${out.length + 1} is not an age1 public key`);
    }
    out.push(line);
  }
  if (out.length === 0) throw new Error("recipients file lists no recipients");
  const unique = new Set(out);
  if (unique.size !== out.length) throw new Error("recipients file has duplicate keys");
  return out;
}

const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Locate the base64 body of an armored age file. Returns null for the binary format. */
export function armorBody(file) {
  const lines = String(file).split("\n");
  const start = lines.findIndex((line) => line.trim() === ARMOR_BEGIN);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.trim() === ARMOR_END);
  if (end === -1) return null;
  return { lines, start, end };
}

/**
 * Count recipient stanzas: the age header carries one `-> <type>` line per recipient.
 * Counting them is how the SHIPPED artifact, not just the probe, is checked to carry
 * every intended recipient.
 *
 * ARMOR IS BASE64 OVER THE ENTIRE FILE, header included, so those stanzas are NOT
 * plaintext lines in an armored file and have to be decoded first. Scanning the armor as
 * though it were the binary format returns 0 for every input, which cannot tell a
 * two-recipient artifact from a zero-recipient one; the assertion would have been
 * decorative. Caught by the tests below, which is what they are for.
 */
export function countRecipientStanzas(file) {
  const body = armorBody(file);
  let header;
  if (body) {
    const b64 = body.lines.slice(body.start + 1, body.end).join("");
    header = Buffer.from(b64, "base64").toString("latin1");
  } else {
    header = String(file);
  }
  let count = 0;
  for (const line of header.split("\n")) {
    if (line.startsWith("--- ")) break; // end of header (the MAC line)
    if (/^->\s+\S+/.test(line)) count += 1;
  }
  return count;
}

/**
 * Flip one character of an age file body.
 *
 * Used as a negative control: the corrupted copy must NOT restore. The failure direction
 * is safe. If this ever no-ops, the "corrupted" copy decrypts cleanly, the control
 * reports NOT-satisfied, and the job fails loudly. A broken control can therefore never
 * masquerade as a passing one.
 */
export function corruptArmored(file) {
  const original = String(file);
  const body = armorBody(original);
  const lines = body ? body.lines : original.split("\n");
  const from = body ? body.start + 1 : 0;
  const to = body ? body.end : lines.length;

  const candidates = [];
  for (let i = from; i < to; i += 1) {
    if (lines[i].length >= 8) candidates.push(i);
  }
  // Start from the middle of the body: past the header stanzas, inside the payload.
  for (let n = 0; n < candidates.length; n += 1) {
    const target = candidates[(Math.floor(candidates.length / 2) + n) % candidates.length];
    const line = lines[target];
    const idx = Math.floor(line.length / 2);
    const current = line[idx];
    if (!B64.includes(current)) continue;
    lines[target] = line.slice(0, idx) + (current === "A" ? "B" : "A") + line.slice(idx + 1);
    const text = lines.join("\n");
    return { text, changed: text !== original };
  }
  return { text: original, changed: false };
}

/**
 * Shape facts about the config, as COUNTS ONLY.
 * Deliberately returns no name of any target, bucket, instance, or repo: this result is
 * safe to print in a public job log.
 */
export function inspectTargets(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config is not a JSON object");
  }
  const targets = parsed.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("config has no targets object");
  }
  const names = Object.keys(targets);
  if (names.length === 0) throw new Error("config declares zero targets");
  const repoCounts = [];
  for (const name of names) {
    const t = targets[name];
    if (!t || typeof t !== "object") throw new Error("a target is not an object");
    if (typeof t.instance !== "string" || !t.instance) {
      throw new Error("a target has no instance");
    }
    if (typeof t.bucket !== "string" || !t.bucket) {
      throw new Error("a target has no bucket");
    }
    if (!Array.isArray(t.repos)) throw new Error("a target has no repos array");
    repoCounts.push(t.repos.length);
  }
  repoCounts.sort((a, b) => a - b);
  return {
    targetCount: names.length,
    repoCounts,
    includePathsRepoCount: Object.keys(parsed.includePaths ?? {}).length,
    excludePathsRepoCount: Object.keys(parsed.excludePaths ?? {}).length,
    restrictedRepoCount: Array.isArray(parsed.restrictedRepos)
      ? parsed.restrictedRepos.length
      : 0,
  };
}

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.error) throw new Error(`${bin} failed to start: ${res.error.message}`);
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? Buffer.alloc(0),
    // stderr is intentionally NOT surfaced to the caller for display: age echoes nothing
    // sensitive today, but a future version printing context would leak through it.
    stderrLen: (res.stderr ?? Buffer.alloc(0)).length,
  };
}

function recipientArgs(recipients) {
  return recipients.flatMap((r) => ["-r", r]);
}

function readPublicKey(identityPath) {
  const text = readFileSync(identityPath, "utf8");
  const match = text.match(/^#\s*public key:\s*(age1\S+)\s*$/im);
  if (!match) throw new Error("age-keygen output carried no public key comment");
  return match[1];
}

/**
 * The restore proof. Returns a report of booleans; the caller decides the exit code.
 *
 * Structure: one positive result plus two negative controls, so a pass distinguishes
 * two states rather than merely observing the reassuring one.
 *   restoresToSource   -- probe ciphertext decrypts to bytes hashing to the source sha
 *   corruptRefused     -- a one-character-corrupted copy does NOT restore
 *   strangerRefused    -- a non-recipient identity does NOT restore
 *   stanzaCountsMatch  -- shipped artifact has N stanzas and the probe has N+1, which
 *                         also proves the counter can tell the two apart
 */
export function proveRoundTrip({
  plaintextPath,
  sourceSha256,
  recipients,
  shippedArmored,
  workDir,
  ageBin = "age",
  ageKeygenBin = "age-keygen",
}) {
  const identityPath = join(workDir, "probe-identity.txt");
  const keygen = run(ageKeygenBin, ["-o", identityPath]);
  if (!keygen.ok) throw new Error("age-keygen failed for the probe identity");
  chmodSync(identityPath, 0o600);
  const probePub = readPublicKey(identityPath);

  const strangerPath = join(workDir, "stranger-identity.txt");
  const strangerGen = run(ageKeygenBin, ["-o", strangerPath]);
  if (!strangerGen.ok) throw new Error("age-keygen failed for the stranger identity");
  chmodSync(strangerPath, 0o600);

  // Probe copy: the real recipients PLUS a throwaway key we hold, so the round trip can
  // be closed in-job without ever putting a real recipient private key in CI.
  const probePath = join(workDir, "probe.age");
  const enc = run(ageBin, [
    "-a",
    ...recipientArgs([...recipients, probePub]),
    "-o",
    probePath,
    plaintextPath,
  ]);
  if (!enc.ok) throw new Error("age failed to encrypt the probe copy");

  const restored = run(ageBin, ["-d", "-i", identityPath, probePath]);
  const restoresToSource = restored.ok && sha256Hex(restored.stdout) === sourceSha256;

  const probeArmored = readFileSync(probePath, "utf8");
  const corrupt = corruptArmored(probeArmored);
  const corruptPath = join(workDir, "probe-corrupt.age");
  writeFileSync(corruptPath, corrupt.text, "utf8");
  const corruptAttempt = run(ageBin, ["-d", "-i", identityPath, corruptPath]);
  const corruptRestored =
    corruptAttempt.ok && sha256Hex(corruptAttempt.stdout) === sourceSha256;
  const corruptRefused = corrupt.changed && !corruptRestored;

  const strangerAttempt = run(ageBin, ["-d", "-i", strangerPath, probePath]);
  const strangerRestored =
    strangerAttempt.ok && sha256Hex(strangerAttempt.stdout) === sourceSha256;
  const strangerRefused = !strangerRestored;

  const shippedStanzas = countRecipientStanzas(shippedArmored);
  const probeStanzas = countRecipientStanzas(probeArmored);
  const stanzaCountsMatch =
    shippedStanzas === recipients.length && probeStanzas === recipients.length + 1;

  return {
    restoresToSource,
    corruptRefused,
    corruptMutatedTheFile: corrupt.changed,
    strangerRefused,
    stanzaCountsMatch,
    shippedStanzas,
    probeStanzas,
    expectedShippedStanzas: recipients.length,
  };
}

export function proofPassed(report) {
  return Boolean(
    report.restoresToSource &&
      report.corruptRefused &&
      report.strangerRefused &&
      report.stanzaCountsMatch,
  );
}

function parseArgs(argv) {
  const out = { outDir: null, recipientsFile: process.env.ESCROW_RECIPIENTS_FILE ?? null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--recipients") out.recipientsFile = argv[++i];
  }
  return out;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args.outDir) {
    console.error("usage: escrow-targets.mjs --out <dir> [--recipients <file>]");
    return EXIT_USAGE;
  }
  if (!args.recipientsFile) {
    console.error("::error::No recipients file (--recipients or ESCROW_RECIPIENTS_FILE)");
    return EXIT_USAGE;
  }
  // Presence only. Never any :- form, which would print the value in exactly the case
  // being tested.
  if (!env.SKYPHUSION_TARGETS_JSON) {
    console.error("::error::SKYPHUSION_TARGETS_JSON is not set");
    return EXIT_USAGE;
  }

  const recipients = parseRecipients(readFileSync(args.recipientsFile, "utf8"));

  // A recipients list that silently lost a line still encrypts and still round-trips;
  // it just quietly locks somebody out of the recovery copy. Pin the count so a
  // truncated list refuses instead of shipping a narrower escrow than intended.
  if (env.ESCROW_EXPECT_RECIPIENTS) {
    const expected = Number(env.ESCROW_EXPECT_RECIPIENTS);
    if (!Number.isInteger(expected) || expected < 1) {
      console.error("::error::ESCROW_EXPECT_RECIPIENTS is not a positive integer");
      return EXIT_USAGE;
    }
    if (recipients.length !== expected) {
      console.error(
        `::error::recipients list has ${recipients.length}, expected ${expected}; refusing`,
      );
      return EXIT_FAILED;
    }
  }
  const workDir = mkdtempSync(join(tmpdir(), "escrow-"));
  chmodSync(workDir, 0o700);

  try {
    const plaintext = Buffer.from(env.SKYPHUSION_TARGETS_JSON, "utf8");
    const sourceSha256 = sha256Hex(plaintext);
    const plaintextPath = join(workDir, "targets.json");
    writeFileSync(plaintextPath, plaintext, { mode: 0o600 });

    let shape;
    try {
      shape = inspectTargets(JSON.parse(plaintext.toString("utf8")));
    } catch (err) {
      // Report the class of malformation, never the content that was malformed.
      console.error(`::error::secret did not validate as a targets config: ${err.message}`);
      return EXIT_FAILED;
    }

    // Fingerprint only. This repository is PUBLIC, so stdout is world readable; a full
    // plaintext digest is a confirmation oracle for a guessed file and the log needs no
    // more than enough characters for a human to compare. The full hash goes into
    // escrow-meta.json, which travels to the internal escrow, never to the log.
    console.log(`source_sha256_fp=${sourceSha256.slice(0, 12)}`);
    console.log(`target_count=${shape.targetCount}`);
    console.log(`repo_counts=${shape.repoCounts.join(",")}`);
    console.log(`include_paths_repos=${shape.includePathsRepoCount}`);
    console.log(`exclude_paths_repos=${shape.excludePathsRepoCount}`);
    console.log(`recipient_count=${recipients.length}`);

    if (env.ESCROW_EXPECT_SHA256) {
      const inSync = env.ESCROW_EXPECT_SHA256 === sourceSha256;
      console.log(`escrow_in_sync=${inSync}`);
      if (!inSync) {
        console.log(
          "::notice::live secret differs from the escrowed copy; this run refreshes it",
        );
      }
    }

    const ageBin = env.AGE_BIN || "age";
    const ageKeygenBin = env.AGE_KEYGEN_BIN || "age-keygen";

    mkdirSync(args.outDir, { recursive: true });
    const shippedPath = join(args.outDir, "targets.json.age");
    const enc = run(ageBin, [
      "-a",
      ...recipientArgs(recipients),
      "-o",
      shippedPath,
      plaintextPath,
    ]);
    if (!enc.ok) {
      console.error("::error::age failed to encrypt the escrow artifact");
      return EXIT_FAILED;
    }
    const shippedArmored = readFileSync(shippedPath, "utf8");

    const report = proveRoundTrip({
      plaintextPath,
      sourceSha256,
      recipients,
      shippedArmored,
      workDir,
      ageBin,
      ageKeygenBin,
    });

    console.log(`proof_restores_to_source=${report.restoresToSource}`);
    console.log(`proof_corrupt_refused=${report.corruptRefused}`);
    console.log(`proof_stranger_refused=${report.strangerRefused}`);
    console.log(`proof_stanza_counts_match=${report.stanzaCountsMatch}`);
    console.log(
      `proof_stanzas_shipped=${report.shippedStanzas} expected=${report.expectedShippedStanzas} probe=${report.probeStanzas}`,
    );

    if (!proofPassed(report)) {
      console.error("::error::escrow restore proof FAILED; refusing to publish artifact");
      rmSync(shippedPath, { force: true });
      return EXIT_FAILED;
    }

    writeFileSync(
      join(args.outDir, "escrow-meta.json"),
      `${JSON.stringify(
        {
          artifact: "targets.json.age",
          sourceSha256,
          recipientCount: recipients.length,
          shippedRecipientStanzas: report.shippedStanzas,
          targetCount: shape.targetCount,
          repoCounts: shape.repoCounts,
          includePathsRepoCount: shape.includePathsRepoCount,
          excludePathsRepoCount: shape.excludePathsRepoCount,
          restrictedRepoCount: shape.restrictedRepoCount,
          proof: {
            restoresToSource: report.restoresToSource,
            corruptRefused: report.corruptRefused,
            strangerRefused: report.strangerRefused,
            stanzaCountsMatch: report.stanzaCountsMatch,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    console.log("escrow_ok=true");
    return EXIT_OK;
  } finally {
    // The plaintext never outlives the job.
    rmSync(workDir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
