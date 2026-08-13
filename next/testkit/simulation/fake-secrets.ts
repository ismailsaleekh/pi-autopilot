import {
  secretsIntentCapsule,
} from "../../ports/contracts/secrets.capsule.js";
import type {
  SecretsIntent,
  SecretsObservation,
} from "../../ports/contracts/secrets.capsule.js";
import { secretHandleSchema } from "../../authority/protocol/identifiers.js";
import type {
  ChildEpoch,
  ChildId,
  LeaseId,
  SecretHandle,
} from "../../authority/protocol/identifiers.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import type { PortTraceSink, SimPortExecution } from "./port-types.js";
import { diagnostic, safeDecode } from "./port-types.js";
import { cloneBytes, digestForBytes, leaseIdFor } from "./values.js";

interface SecretLease {
  readonly leaseId: LeaseId;
  readonly secretHandle: SecretHandle;
  readonly childId: ChildId;
  readonly childEpoch: ChildEpoch;
  revoked: boolean;
}

export interface SecretImageEntry {
  readonly handle: SecretHandle;
  readonly bytes: Uint8Array;
}

export interface SecretsImage {
  readonly secrets: readonly SecretImageEntry[];
}

export interface SecretChildLookup {
  readonly isChildActive: (childId: ChildId, epoch: ChildEpoch) => boolean;
}

export type RegisterSecretResult =
  | { readonly kind: "registered"; readonly handle: SecretHandle }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const secretHandleCapsule = defineCapsule("SimulationSecretHandle", secretHandleSchema);

function decodeSecretHandle(input: unknown): SecretHandle | null {
  try {
    const encoded = secretHandleCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = secretHandleCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

/**
 * Models handle existence, child/epoch authorization, opaque leases, and
 * revocation. Secret bytes never enter observations or traces. It does not
 * model a real credential broker, process environment leakage, or OS keyrings.
 */
export class SimSecretsPort {
  private readonly childLookup: SecretChildLookup;
  private readonly trace: PortTraceSink;
  private readonly secrets = new Map<SecretHandle, Uint8Array>();
  private readonly leases = new Map<LeaseId, SecretLease>();
  private readonly observations = new Map<string, SecretsObservation>();

  public constructor(childLookup: SecretChildLookup, trace: PortTraceSink, image?: SecretsImage) {
    this.childLookup = childLookup;
    this.trace = trace;
    if (image !== undefined) {
      for (const entry of image.secrets) {
        this.secrets.set(entry.handle, entry.bytes.slice());
      }
    }
  }

  public register(handleInput: unknown, bytesInput: unknown): RegisterSecretResult {
    const handle = decodeSecretHandle(handleInput);
    const bytes = cloneBytes(bytesInput);
    if (handle === null || bytes === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "secret registration requires a valid opaque handle and Uint8Array bytes" });
    }
    const prior = this.secrets.get(handle);
    if (prior !== undefined && digestForBytes(prior) !== digestForBytes(bytes)) {
      return Object.freeze({ kind: "invalid", diagnostic: "opaque secret handle is already bound to different bytes" });
    }
    this.secrets.set(handle, bytes);
    return Object.freeze({ kind: "registered", handle });
  }

  public execute(input: unknown): SimPortExecution<SecretsObservation> {
    const decoded = safeDecode(secretsIntentCapsule, input);
    if (decoded.kind === "error") {
      return Object.freeze({ kind: "rejected", diagnostic: decoded.diagnostic });
    }
    const cached = this.observations.get(decoded.value.actionId);
    if (cached !== undefined) {
      this.trace.recordContract("secrets", decoded.value.actionId, cached);
      return Object.freeze({ kind: "observation", observation: cached });
    }
    const observation = this.apply(decoded.value);
    if (observation.result.kind === "ok") {
      this.observations.set(decoded.value.actionId, observation);
    }
    this.trace.recordContract("secrets", decoded.value.actionId, observation);
    return Object.freeze({ kind: "observation", observation });
  }

  public image(): SecretsImage {
    const secrets = [...this.secrets.entries()]
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      .map(([handle, bytes]) => Object.freeze({ handle, bytes: bytes.slice() }));
    return Object.freeze({ secrets: Object.freeze(secrets) });
  }

  private apply(intent: SecretsIntent): SecretsObservation {
    switch (intent.kind) {
      case "authorize-secret-use": {
        if (
          !this.secrets.has(intent.inputs.secretHandle)
          || !this.childLookup.isChildActive(intent.inputs.childId, intent.preconditions.childEpoch)
        ) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "secret-use-authorized",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("secrets.authorization-rejected", "secret handle or active child epoch is unavailable"),
            }),
            runId: intent.runId,
          });
        }
        const leaseId = leaseIdFor(Object.freeze({
          actionId: intent.actionId,
          childId: intent.inputs.childId,
          purposeId: intent.inputs.purposeId,
          secretHandle: intent.inputs.secretHandle,
        }));
        this.leases.set(leaseId, {
          leaseId,
          secretHandle: intent.inputs.secretHandle,
          childId: intent.inputs.childId,
          childEpoch: intent.preconditions.childEpoch,
          revoked: false,
        });
        return Object.freeze({
          actionId: intent.actionId,
          kind: "secret-use-authorized",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              leaseId,
              policyDigest: intent.preconditions.policyDigest,
              secretHandle: intent.inputs.secretHandle,
            }),
          }),
          runId: intent.runId,
        });
      }
      case "revoke-secret-use": {
        const prior = this.leases.get(intent.inputs.leaseId);
        if (
          prior !== undefined
          && (prior.secretHandle !== intent.inputs.secretHandle || prior.childEpoch !== intent.preconditions.childEpoch)
        ) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "secret-use-revoked",
            result: Object.freeze({
              kind: "retry",
              diagnostic: diagnostic("secrets.stale-lease", "secret lease does not match the handle and child epoch"),
            }),
            runId: intent.runId,
          });
        }
        const alreadyRevoked = prior === undefined || prior.revoked;
        if (prior !== undefined) {
          prior.revoked = true;
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "secret-use-revoked",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              leaseId: intent.inputs.leaseId,
              secretHandle: intent.inputs.secretHandle,
              state: alreadyRevoked ? "already-revoked" : "revoked",
            }),
          }),
          runId: intent.runId,
        });
      }
    }
  }
}
