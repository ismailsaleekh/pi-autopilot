import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { protocolCapsules } from "../authority/protocol/aggregate.generated.js";
import {
  canonicalDecisionFactsDigest,
  decisionFactsMatchRoot,
  journalRecordCapsule,
} from "../authority/protocol/journal-record.capsule.js";
import {
  bytesEqual,
  canonicalEncodeUnknown,
  digestBytes,
} from "../authority/protocol/schema.js";
import type { DecodeResult, Digest } from "../authority/protocol/schema.js";
import { terminalOutcomeCapsule } from "../authority/protocol/terminal-outcome.capsule.js";
import { portContractCapsules } from "../ports/contracts/aggregate.generated.js";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const nextRoot = dirname(testsDirectory).endsWith("dist-tests")
  ? dirname(dirname(testsDirectory))
  : dirname(testsDirectory);

interface TestCapsule {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly decodeCanonical: (input: Uint8Array) => DecodeResult<unknown>;
  readonly encodeUnknown: (value: unknown) => DecodeResult<Uint8Array>;
  readonly digestUnknown: (value: unknown) => DecodeResult<Digest>;
  readonly arbitrary: {
    readonly valid: (seed: number) => unknown;
    readonly validForKind: (kind: string, seed: number) => unknown;
    readonly malformedValue: (seed: number) => unknown;
    readonly malformedBytes: (seed: number) => Uint8Array;
    readonly arbitraryBytes: (seed: number, length: number) => Uint8Array;
  };
}

const allCapsules: readonly TestCapsule[] = Object.freeze([
  ...protocolCapsules,
  ...portContractCapsules,
]);

function capsuleValue(capsule: TestCapsule, seed: number): unknown {
  return capsule.arbitrary.valid(seed);
}

function encoded(capsule: TestCapsule, value: unknown): Uint8Array {
  const result = capsule.encodeUnknown(value);
  assert.equal(result.kind, "ok");
  return result.kind === "ok" ? result.value : new Uint8Array();
}

function digested(capsule: TestCapsule, value: unknown): Digest {
  const result = capsule.digestUnknown(value);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    return result.value;
  }
  throw new Error("unreachable after assertion");
}

for (const capsule of allCapsules) {
  test(`${capsule.name}: valid arbitrary decodes and canonical round-trip is identity`, () => {
    for (const [kindIndex, kind] of capsule.kinds.entries()) {
      const variant = capsule.arbitrary.validForKind(kind, kindIndex + 9000);
      const variantEncoded = capsule.encodeUnknown(variant);
      assert.equal(variantEncoded.kind, "ok");
      if (variantEncoded.kind === "ok") {
        const variantDecoded = capsule.decodeCanonical(variantEncoded.value);
        assert.equal(variantDecoded.kind, "ok");
        if (
          variantDecoded.kind === "ok"
          && typeof variantDecoded.value === "object"
          && variantDecoded.value !== null
          && !Array.isArray(variantDecoded.value)
        ) {
          assert.equal(Object.entries(variantDecoded.value)
            .find(([field]) => field === "kind")?.[1], kind);
        }
      }
    }
    for (let seed = 0; seed < 64; seed += 1) {
      const value = capsuleValue(capsule, seed);
      const encodedValue = capsule.encodeUnknown(value);
      assert.equal(encodedValue.kind, "ok");
      const decodedValue = encodedValue.kind === "ok"
        ? capsule.decodeCanonical(encodedValue.value)
        : encodedValue;
      assert.equal(decodedValue.kind, "ok");
      const bytes = encoded(capsule, value);
      const decodedBytes = capsule.decodeCanonical(bytes);
      assert.equal(decodedBytes.kind, "ok");
      if (decodedBytes.kind === "ok") {
        assert.deepEqual(decodedBytes.value, value);
        assert.equal(bytesEqual(encoded(capsule, decodedBytes.value), bytes), true);
      }
      assert.equal(digested(capsule, value), digestBytes(bytes));
    }
  });

  test(`${capsule.name}: decoder is total over arbitrary unknown values and bytes`, () => {
    const hostileValues: readonly unknown[] = Object.freeze([
      undefined,
      Symbol("hostile"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Object.create(null),
      new Uint8Array([0xff]),
      () => 1,
    ]);
    for (const value of hostileValues) {
      assert.doesNotThrow(() => capsule.encodeUnknown(value));
      assert.equal(capsule.encodeUnknown(value).kind, "error");
    }
    for (let seed = 0; seed < 256; seed += 1) {
      const bytes = capsule.arbitrary.arbitraryBytes(seed, seed % 129);
      assert.doesNotThrow(() => capsule.decodeCanonical(bytes));
      const result = capsule.decodeCanonical(bytes);
      assert.equal(result.kind === "ok" || result.kind === "error", true);
    }
  });

  test(`${capsule.name}: malformed arbitraries and unknown fields are rejected`, () => {
    for (let seed = 0; seed < 64; seed += 1) {
      assert.equal(capsule.encodeUnknown(capsule.arbitrary.malformedValue(seed)).kind, "error");
      assert.equal(capsule.decodeCanonical(capsule.arbitrary.malformedBytes(seed)).kind, "error");
    }
  });

  test(`${capsule.name}: noncanonical serializations are rejected`, () => {
    const value = capsuleValue(capsule, 79);
    const canonical = encoded(capsule, value);
    const padded = new Uint8Array(canonical.length + 2);
    padded[0] = 32;
    padded.set(canonical, 1);
    padded[padded.length - 1] = 10;
    assert.equal(capsule.decodeCanonical(padded).kind, "error");
  });
}

test("DecisionCommitted canonical ordered facts bind to factDigest", () => {
  const candidate = journalRecordCapsule.arbitrary.validForKind("decision-committed", 31415);
  const decoded = journalRecordCapsule.decode(candidate);
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok" && decoded.value.kind === "decision-committed") {
    const matching = journalRecordCapsule.decode({
      ...decoded.value,
      factDigest: canonicalDecisionFactsDigest(decoded.value.facts),
    });
    assert.equal(matching.kind, "ok");
    if (matching.kind === "ok" && matching.value.kind === "decision-committed") {
      assert.equal(decisionFactsMatchRoot(matching.value), true);
      const mismatch = journalRecordCapsule.decode({
        ...matching.value,
        factDigest: `sha256:${"0".repeat(64)}`,
      });
      assert.equal(mismatch.kind, "ok");
      if (mismatch.kind === "ok" && mismatch.value.kind === "decision-committed") {
        assert.equal(decisionFactsMatchRoot(mismatch.value), false);
      }
    }
  }
});

test("port intent actionId is deterministic and enforced", () => {
  for (const capsule of portContractCapsules.filter((candidate) => candidate.name.endsWith("Intent"))) {
    const value = capsule.arbitrary.valid(41);
    const encodedValue = capsule.encodeUnknown(value);
    if (encodedValue.kind === "error") {
      assert.fail(encodedValue.error.diagnostic);
    }
    const decoded = capsule.decodeCanonical(encodedValue.value);
    if (decoded.kind === "error") {
      assert.fail(decoded.error.diagnostic);
    }
    assert.equal(typeof decoded.value, "object");
    if (typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) {
      continue;
    }
    const changed = Object.freeze({ ...decoded.value, actionId: `action:sha256:${"0".repeat(64)}` });
    assert.equal(capsule.encodeUnknown(changed).kind, "error");
    assert.deepEqual(capsule.arbitrary.valid(41), value);
  }
});

test("canonical encoder sorts keys recursively without JSON.stringify", () => {
  const left = canonicalEncodeUnknown({ z: 1, a: { y: true, b: null } });
  const right = canonicalEncodeUnknown({ a: { b: null, y: true }, z: 1 });
  assert.equal(bytesEqual(left, right), true);
  assert.equal(Buffer.from(left).toString("utf8"), "{\"a\":{\"b\":null,\"y\":true},\"z\":1}");
});

test("canonical encoder has stable negative-zero and malformed-key behavior", () => {
  assert.equal(Buffer.from(canonicalEncodeUnknown(-0)).toString("utf8"), "0");
  const malformedKey = String.fromCharCode(0xd800);
  const replacementKey = String.fromCharCode(0xfffd);
  assert.equal(
    bytesEqual(
      canonicalEncodeUnknown({ [malformedKey]: true }),
      canonicalEncodeUnknown({ [replacementKey]: true }),
    ),
    true,
  );
});

test("SHA-256 implementation matches standard vectors", () => {
  assert.equal(digestBytes(new Uint8Array()), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(digestBytes(Uint8Array.from([97, 98, 99])), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("TerminalOutcome is exactly t1 and t2", () => {
  assert.deepEqual(terminalOutcomeCapsule.kinds, ["t1", "t2"]);
  assert.equal(terminalOutcomeCapsule.encodeUnknown({ kind: "blocked" }).kind, "error");
  assert.equal(terminalOutcomeCapsule.encodeUnknown({ kind: "failed" }).kind, "error");
  assert.equal(terminalOutcomeCapsule.encodeUnknown({ kind: "timeout" }).kind, "error");
});

test("digest is stable in a fresh process", () => {
  const capsule = protocolCapsules.find((candidate) => candidate.name === "JournalRecord");
  assert.notEqual(capsule, undefined);
  if (capsule === undefined) {
    return;
  }
  const expectedResult = capsule.digestUnknown(capsule.arbitrary.valid(123));
  assert.equal(expectedResult.kind, "ok");
  const expected = expectedResult.kind === "ok" ? expectedResult.value : "";
  const script = [
    "import { protocolCapsules } from './dist-tests/authority/protocol/aggregate.generated.js';",
    "const capsule = protocolCapsules.find((value) => value.name === 'JournalRecord');",
    "if (capsule === undefined) process.exit(7);",
    "const result = capsule.digestUnknown(capsule.arbitrary.valid(123));",
    "if (result.kind === 'error') process.exit(8);",
    "process.stdout.write(result.value);"
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: nextRoot,
    encoding: "utf8",
    env: { ...process.env, LANG: "tr_TR.UTF-8", TZ: "Pacific/Kiritimati" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, expected);
});

test("aggregate capsule names are sorted and unique", () => {
  const names = allCapsules.map((capsule) => capsule.name);
  const protocolNames = protocolCapsules.map((capsule) => capsule.name);
  const portNames = portContractCapsules.map((capsule) => capsule.name);
  assert.deepEqual(protocolNames, protocolNames.slice().sort());
  assert.deepEqual(portNames, portNames.slice().sort());
  assert.equal(new Set(names).size, names.length);
  assert.equal(protocolCapsules.length, 13);
  assert.equal(portContractCapsules.length, 12);
});
