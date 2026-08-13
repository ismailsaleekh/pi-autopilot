import { createHash } from "node:crypto";
import {
  secretsIntentCapsule,
  secretsObservationCapsule,
} from "../../ports/contracts/secrets.capsule.js";
import type {
  SecretsIntent,
  SecretsObservation,
} from "../../ports/contracts/secrets.capsule.js";

export interface SecretsDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type SecretsExecution =
  | { readonly kind: "observation"; readonly observation: SecretsObservation }
  | { readonly diagnostic: SecretsDiagnostic; readonly kind: "rejected" };

export type SecretRegistration =
  | { readonly handle: string; readonly kind: "registered" }
  | { readonly diagnostic: SecretsDiagnostic; readonly kind: "rejected" };

export type SecretLeaseUseResult =
  | { readonly kind: "used"; readonly leaseId: string; readonly secretHandle: string }
  | { readonly diagnostic: SecretsDiagnostic; readonly kind: "rejected" };

export interface SecretChildLookup {
  readonly isActive: (childId: string, childEpoch: string) => boolean;
}

interface LeaseRecord {
  readonly childEpoch: string;
  readonly childId: string;
  readonly leaseId: string;
  readonly secretHandle: string;
  revoked: boolean;
}

function diagnostic(code: string, message: string): SecretsDiagnostic {
  return Object.freeze({ code, message });
}

function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}

function identifier(input: unknown): string | null {
  return typeof input === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(input)
    ? input
    : null;
}

function cloneSecret(input: unknown): Uint8Array | null {
  try {
    return input instanceof Uint8Array && input.byteLength > 0 ? Uint8Array.from(input) : null;
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function leaseId(intent: Extract<SecretsIntent, { readonly kind: "authorize-secret-use" }>): string {
  const digest = createHash("sha256")
    .update("pi-autopilot.secret-lease.v1\u0000")
    .update(intent.actionId)
    .update("\u0000")
    .update(intent.inputs.childId)
    .update("\u0000")
    .update(intent.inputs.purposeId)
    .update("\u0000")
    .update(intent.inputs.secretHandle)
    .digest("hex");
  return `lease-${digest}`;
}

function safeIntent(input: unknown):
  | { readonly kind: "ok"; readonly value: SecretsIntent }
  | { readonly diagnostic: SecretsDiagnostic; readonly kind: "error" } {
  try {
    const encoded = secretsIntentCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        diagnostic: diagnostic("secrets.invalid-intent", "secrets intent does not satisfy the frozen contract"),
        kind: "error",
      });
    }
    const decoded = secretsIntentCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value })
      : Object.freeze({
          diagnostic: diagnostic("secrets.invalid-intent", "secrets intent is not canonically encoded"),
          kind: "error",
        });
  } catch {
    return Object.freeze({
      diagnostic: diagnostic("secrets.uninspectable-intent", "secrets intent could not be inspected safely"),
      kind: "error",
    });
  }
}

function canonicalObservation(input: unknown): SecretsObservation | null {
  try {
    const encoded = secretsObservationCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = secretsObservationCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

/**
 * Opaque in-process broker. Secret bytes remain only in the private byte map
 * and in the synchronous/async consumer callback of useLease(). Public return
 * values, observations, and diagnostics contain handles and lease ids only.
 */
export class SecretsAdapter {
  readonly #childLookup: SecretChildLookup;
  readonly #secrets = new Map<string, Uint8Array>();
  readonly #leases = new Map<string, LeaseRecord>();

  public constructor(childLookup: SecretChildLookup) {
    this.#childLookup = childLookup;
  }

  public register(handleInput: unknown, bytesInput: unknown): SecretRegistration {
    const handle = identifier(handleInput);
    const bytes = cloneSecret(bytesInput);
    if (handle === null || bytes === null) {
      return Object.freeze({
        diagnostic: diagnostic("secrets.invalid-registration", "secret registration requires an opaque identifier and non-empty bytes"),
        kind: "rejected",
      });
    }
    const prior = this.#secrets.get(handle);
    if (prior !== undefined && !sameBytes(prior, bytes)) {
      return Object.freeze({
        diagnostic: diagnostic("secrets.handle-collision", "opaque secret handle is already bound"),
        kind: "rejected",
      });
    }
    if (prior === undefined) {
      this.#secrets.set(handle, bytes);
    }
    return Object.freeze({ handle, kind: "registered" });
  }

  public execute(input: unknown): SecretsExecution {
    const decoded = safeIntent(input);
    if (decoded.kind === "error") {
      return Object.freeze({ diagnostic: decoded.diagnostic, kind: "rejected" });
    }
    const candidate = this.#apply(decoded.value);
    const observation = canonicalObservation(candidate);
    return observation === null
      ? Object.freeze({
          diagnostic: diagnostic("secrets.observation-invariant", "secrets physical observation did not satisfy the frozen contract"),
          kind: "rejected",
        })
      : Object.freeze({ kind: "observation", observation });
  }

  public async useLease(
    leaseIdInput: unknown,
    consumerInput: unknown,
  ): Promise<SecretLeaseUseResult> {
    const id = identifier(leaseIdInput);
    if (id === null || typeof consumerInput !== "function") {
      return Object.freeze({
        diagnostic: diagnostic("secrets.invalid-lease-use", "secret lease use requires an opaque lease id and a private consumer"),
        kind: "rejected",
      });
    }
    const lease = this.#leases.get(id);
    const secret = lease === undefined ? undefined : this.#secrets.get(lease.secretHandle);
    let active = false;
    if (lease !== undefined) {
      try {
        active = this.#childLookup.isActive(lease.childId, lease.childEpoch);
      } catch {
        active = false;
      }
    }
    if (lease === undefined || lease.revoked || secret === undefined || !active) {
      return Object.freeze({
        diagnostic: diagnostic("secrets.lease-unavailable", "secret lease is absent or revoked"),
        kind: "rejected",
      });
    }
    try {
      await Reflect.apply(consumerInput, undefined, [Uint8Array.from(secret)]);
    } catch {
      return Object.freeze({
        diagnostic: diagnostic("secrets.consumer-rejected", "private secret consumer did not accept the leased bytes"),
        kind: "rejected",
      });
    }
    return Object.freeze({ kind: "used", leaseId: lease.leaseId, secretHandle: lease.secretHandle });
  }

  #apply(intent: SecretsIntent): unknown {
    switch (intent.kind) {
      case "authorize-secret-use": {
        let active = false;
        try {
          active = this.#childLookup.isActive(intent.inputs.childId, intent.preconditions.childEpoch);
        } catch {
          active = false;
        }
        if (!this.#secrets.has(intent.inputs.secretHandle) || !active) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "secret-use-authorized",
            result: Object.freeze({
              diagnostic: contractDiagnostic("secrets.authorization-rejected", "secret handle or active child epoch is unavailable"),
              kind: "retry",
            }),
            runId: intent.runId,
          });
        }
        const id = leaseId(intent);
        const prior = this.#leases.get(id);
        if (prior === undefined) {
          this.#leases.set(id, {
            childEpoch: intent.preconditions.childEpoch,
            childId: intent.inputs.childId,
            leaseId: id,
            revoked: false,
            secretHandle: intent.inputs.secretHandle,
          });
        }
        return Object.freeze({
          actionId: intent.actionId,
          kind: "secret-use-authorized",
          result: Object.freeze({
            kind: "ok",
            value: Object.freeze({
              leaseId: id,
              policyDigest: intent.preconditions.policyDigest,
              secretHandle: intent.inputs.secretHandle,
            }),
          }),
          runId: intent.runId,
        });
      }
      case "revoke-secret-use": {
        const prior = this.#leases.get(intent.inputs.leaseId);
        if (
          prior !== undefined
          && (prior.secretHandle !== intent.inputs.secretHandle
            || prior.childEpoch !== intent.preconditions.childEpoch)
        ) {
          return Object.freeze({
            actionId: intent.actionId,
            kind: "secret-use-revoked",
            result: Object.freeze({
              diagnostic: contractDiagnostic("secrets.stale-lease", "secret lease does not match the handle and child epoch"),
              kind: "retry",
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
