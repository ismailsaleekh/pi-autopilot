import { journalRecordCapsule, recordSemanticRootsMatch } from "./journal-record.capsule.js";
import type {
  CommandSettled,
  DecisionCommitted,
  JournalRecord,
  OutcomeCommitted,
  RunResumed,
  RunSuspended,
} from "./journal-record.capsule.js";
import type { DecodeError } from "./schema.js";

const preparedCommitCapability: unique symbol = Symbol();

export type PreparedCommitKind =
  | "prepared-decision"
  | "prepared-command-settlement"
  | "prepared-suspension"
  | "prepared-resumption"
  | "prepared-outcome";

export type PreparedCommit =
  | {
      readonly kind: "prepared-decision";
      readonly record: DecisionCommitted;
      readonly [preparedCommitCapability]: true;
    }
  | {
      readonly kind: "prepared-command-settlement";
      readonly record: CommandSettled;
      readonly [preparedCommitCapability]: true;
    }
  | {
      readonly kind: "prepared-suspension";
      readonly record: RunSuspended;
      readonly [preparedCommitCapability]: true;
    }
  | {
      readonly kind: "prepared-resumption";
      readonly record: RunResumed;
      readonly [preparedCommitCapability]: true;
    }
  | {
      readonly kind: "prepared-outcome";
      readonly record: OutcomeCommitted;
      readonly [preparedCommitCapability]: true;
    };

export type PreparedCommitFields =
  | { readonly kind: "prepared-decision"; readonly record: DecisionCommitted }
  | { readonly kind: "prepared-command-settlement"; readonly record: CommandSettled }
  | { readonly kind: "prepared-suspension"; readonly record: RunSuspended }
  | { readonly kind: "prepared-resumption"; readonly record: RunResumed }
  | { readonly kind: "prepared-outcome"; readonly record: OutcomeCommitted };

export type PreparedCommitMintResult =
  | { readonly kind: "minted"; readonly commit: PreparedCommit }
  | { readonly kind: "invalid"; readonly error: DecodeError };

function semanticMismatch(path: string, diagnostic: string): DecodeError {
  return Object.freeze({ code: "schema-mismatch", path, diagnostic });
}

function expectedRecordKind(kind: PreparedCommitKind): JournalRecord["kind"] {
  switch (kind) {
    case "prepared-decision":
      return "decision-committed";
    case "prepared-command-settlement":
      return "command-settled";
    case "prepared-suspension":
      return "run-suspended";
    case "prepared-resumption":
      return "run-resumed";
    case "prepared-outcome":
      return "outcome-committed";
  }
}

/** Sole opaque mint edge; architecture policy permits calls only from facade. */
export function mintPreparedCommit(fields: PreparedCommitFields): PreparedCommitMintResult {
  const encoded = journalRecordCapsule.encodeUnknown(fields.record);
  if (encoded.kind === "error") {
    return Object.freeze({ kind: "invalid", error: encoded.error });
  }
  const decoded = journalRecordCapsule.decodeCanonical(encoded.value);
  if (decoded.kind === "error") {
    return Object.freeze({ kind: "invalid", error: decoded.error });
  }
  if (decoded.value.kind !== expectedRecordKind(fields.kind)) {
    return Object.freeze({
      kind: "invalid",
      error: semanticMismatch("$.record.kind", "prepared commit kind must select the exact journal record family"),
    });
  }
  if (
    (decoded.value.kind === "decision-committed"
      || decoded.value.kind === "command-settled"
      || decoded.value.kind === "outcome-committed")
    && !recordSemanticRootsMatch(decoded.value)
  ) {
    return Object.freeze({
      kind: "invalid",
      error: semanticMismatch("$.record", "facts, commands, artifact reference, and canonical digests must match"),
    });
  }
  let commit: PreparedCommit;
  if (fields.kind === "prepared-decision" && decoded.value.kind === "decision-committed") {
    commit = { kind: fields.kind, record: decoded.value, [preparedCommitCapability]: true };
  } else if (fields.kind === "prepared-command-settlement" && decoded.value.kind === "command-settled") {
    commit = { kind: fields.kind, record: decoded.value, [preparedCommitCapability]: true };
  } else if (fields.kind === "prepared-suspension" && decoded.value.kind === "run-suspended") {
    commit = { kind: fields.kind, record: decoded.value, [preparedCommitCapability]: true };
  } else if (fields.kind === "prepared-resumption" && decoded.value.kind === "run-resumed") {
    commit = { kind: fields.kind, record: decoded.value, [preparedCommitCapability]: true };
  } else if (fields.kind === "prepared-outcome" && decoded.value.kind === "outcome-committed") {
    commit = { kind: fields.kind, record: decoded.value, [preparedCommitCapability]: true };
  } else {
    return Object.freeze({
      kind: "invalid",
      error: semanticMismatch("$.record.kind", "prepared commit and decoded record kinds diverged"),
    });
  }
  Object.defineProperty(commit, preparedCommitCapability, Object.freeze({
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }));
  return Object.freeze({ kind: "minted", commit: Object.freeze(commit) });
}
