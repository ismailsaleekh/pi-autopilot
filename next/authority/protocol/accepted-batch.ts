import { commandCapsule } from "./command.capsule.js";
import type { Command } from "./command.capsule.js";
import { domainFactCapsule } from "./domain-fact.capsule.js";
import type { DomainFact } from "./domain-fact.capsule.js";
import type { ArtifactRoot, Digest, RunId } from "./identifiers.js";
import { canonicalDecisionFactsDigest } from "./journal-record.capsule.js";
import type { DecodeError } from "./schema.js";
import { terminalOutcomeCapsule } from "./terminal-outcome.capsule.js";
import type { TerminalOutcome } from "./terminal-outcome.capsule.js";

const acceptedBatchCapability: unique symbol = Symbol();

/** An authority decision whose semantic payload is canonically owned. */
export interface AcceptedBatch {
  readonly runId: RunId;
  readonly facts: readonly DomainFact[];
  readonly commands: readonly Command[];
  readonly outcome: TerminalOutcome | null;
  readonly factRoot: ArtifactRoot;
  readonly commandRoot: ArtifactRoot;
  readonly stateDigest: Digest;
  readonly [acceptedBatchCapability]: true;
}

export interface AcceptedBatchFields {
  readonly runId: RunId;
  readonly facts: readonly DomainFact[];
  readonly commands: readonly Command[];
  readonly outcome: TerminalOutcome | null;
  readonly factRoot: ArtifactRoot;
  readonly commandRoot: ArtifactRoot;
  readonly stateDigest: Digest;
}

export type AcceptedBatchMember = "fact" | "factRoot" | "command" | "outcome";

export type AcceptedBatchMintResult =
  | { readonly kind: "minted"; readonly batch: AcceptedBatch }
  | {
      readonly kind: "invalid";
      readonly member: AcceptedBatchMember;
      readonly index: number | null;
      readonly error: DecodeError;
    };

function invalidMember(
  member: AcceptedBatchMember,
  index: number | null,
  error: DecodeError,
): AcceptedBatchMintResult {
  return Object.freeze({ kind: "invalid", member, index, error });
}

function semanticMismatch(path: string, diagnostic: string): DecodeError {
  return Object.freeze({ code: "schema-mismatch", path, diagnostic });
}

/**
 * Sole mint edge. Protected architecture policy permits value import and use
 * only from authority/facade. Canonical round-trips remove caller aliases, and
 * the ordered fact batch must bind to factRoot before an AcceptedBatch exists.
 */
export function mintAcceptedBatch(fields: AcceptedBatchFields): AcceptedBatchMintResult {
  const facts: DomainFact[] = [];
  for (let index = 0; index < fields.facts.length; index += 1) {
    const encoded = domainFactCapsule.encodeUnknown(fields.facts[index]);
    if (encoded.kind === "error") {
      return invalidMember("fact", index, encoded.error);
    }
    const decoded = domainFactCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      return invalidMember("fact", index, decoded.error);
    }
    if (decoded.value.runId !== fields.runId) {
      return invalidMember(
        "fact",
        index,
        semanticMismatch(`$.facts[${String(index)}].runId`, "fact runId must equal accepted batch runId"),
      );
    }
    facts.push(decoded.value);
  }
  if (String(canonicalDecisionFactsDigest(facts)) !== String(fields.factRoot)) {
    return invalidMember(
      "factRoot",
      null,
      semanticMismatch("$.factRoot", "canonical ordered facts do not hash to factRoot"),
    );
  }

  const commands: Command[] = [];
  for (let index = 0; index < fields.commands.length; index += 1) {
    const encoded = commandCapsule.encodeUnknown(fields.commands[index]);
    if (encoded.kind === "error") {
      return invalidMember("command", index, encoded.error);
    }
    const decoded = commandCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      return invalidMember("command", index, decoded.error);
    }
    if (decoded.value.runId !== fields.runId) {
      return invalidMember(
        "command",
        index,
        semanticMismatch(`$.commands[${String(index)}].runId`, "command runId must equal accepted batch runId"),
      );
    }
    commands.push(decoded.value);
  }

  let outcome: TerminalOutcome | null = null;
  if (fields.outcome !== null) {
    const encoded = terminalOutcomeCapsule.encodeUnknown(fields.outcome);
    if (encoded.kind === "error") {
      return invalidMember("outcome", null, encoded.error);
    }
    const decoded = terminalOutcomeCapsule.decodeCanonical(encoded.value);
    if (decoded.kind === "error") {
      return invalidMember("outcome", null, decoded.error);
    }
    outcome = decoded.value;
  }

  const batch: AcceptedBatch = {
    runId: fields.runId,
    facts: Object.freeze(facts),
    commands: Object.freeze(commands),
    outcome,
    factRoot: fields.factRoot,
    commandRoot: fields.commandRoot,
    stateDigest: fields.stateDigest,
    [acceptedBatchCapability]: true,
  };
  Object.defineProperty(batch, acceptedBatchCapability, Object.freeze({
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }));
  const accepted: AcceptedBatch = Object.freeze(batch);
  return Object.freeze({
    kind: "minted",
    batch: accepted,
  });
}
