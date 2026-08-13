import { leaseIdSchema } from "../../authority/protocol/identifiers.js";
import type { ChildEpoch, LeaseId } from "../../authority/protocol/identifiers.js";
import { defineCapsule } from "../../authority/protocol/schema.js";
import { childEpochFor } from "./values.js";

interface LockRecord {
  readonly resource: string;
  readonly owner: string;
  readonly leaseId: LeaseId;
  readonly generation: number;
  readonly epoch: ChildEpoch;
}

export interface LockEpochImage {
  readonly resource: string;
  readonly generation: number;
}

export interface LockManagerImage {
  readonly epochs: readonly LockEpochImage[];
}

export interface LockTakeoverSink {
  readonly lockTakeover: (
    stage: "before" | "after",
    resource: string,
    priorOwner: string,
    nextOwner: string,
    generation: number,
  ) => void;
}

export type LockResult =
  | {
      readonly kind: "acquired";
      readonly resource: string;
      readonly owner: string;
      readonly leaseId: LeaseId;
      readonly generation: number;
      readonly epoch: ChildEpoch;
      readonly reentrant: boolean;
    }
  | {
      readonly kind: "busy";
      readonly resource: string;
      readonly owner: string;
      readonly generation: number;
      readonly epoch: ChildEpoch;
    }
  | { readonly kind: "released"; readonly resource: string; readonly generation: number }
  | { readonly kind: "stale"; readonly resource: string; readonly generation: number }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const leaseCapsule = defineCapsule("SimulationLockLease", leaseIdSchema);

function text(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null;
}

function lease(input: unknown): LeaseId | null {
  try {
    const encoded = leaseCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = leaseCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

/** Exclusive locks with durable generations and stale-epoch rejection. */
export class SimLockManager {
  private readonly sink: LockTakeoverSink;
  private readonly active = new Map<string, LockRecord>();
  private readonly generations = new Map<string, number>();

  public constructor(sink: LockTakeoverSink, image?: unknown) {
    this.sink = sink;
    const decoded = decodeImage(image);
    for (const entry of decoded.epochs) {
      this.generations.set(entry.resource, entry.generation);
    }
  }

  public acquire(resourceInput: unknown, ownerInput: unknown, leaseInput: unknown): LockResult {
    const resource = text(resourceInput);
    const owner = text(ownerInput);
    const leaseId = lease(leaseInput);
    if (resource === null || owner === null || leaseId === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "lock acquisition requires resource, owner, and valid lease ID" });
    }
    const prior = this.active.get(resource);
    if (prior !== undefined) {
      if (prior.owner === owner && prior.leaseId === leaseId) {
        return Object.freeze({
          kind: "acquired",
          resource,
          owner,
          leaseId,
          generation: prior.generation,
          epoch: prior.epoch,
          reentrant: true,
        });
      }
      return Object.freeze({
        kind: "busy",
        resource,
        owner: prior.owner,
        generation: prior.generation,
        epoch: prior.epoch,
      });
    }
    const generation = (this.generations.get(resource) ?? 0) + 1;
    this.generations.set(resource, generation);
    const epoch = childEpochFor(Object.freeze({ generation, resource }));
    const record: LockRecord = { resource, owner, leaseId, generation, epoch };
    this.active.set(resource, record);
    return Object.freeze({
      kind: "acquired",
      resource,
      owner,
      leaseId,
      generation,
      epoch,
      reentrant: false,
    });
  }

  public takeover(resourceInput: unknown, ownerInput: unknown, leaseInput: unknown): LockResult {
    const resource = text(resourceInput);
    const owner = text(ownerInput);
    const leaseId = lease(leaseInput);
    if (resource === null || owner === null || leaseId === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "lock takeover requires resource, owner, and valid lease ID" });
    }
    const prior = this.active.get(resource);
    if (prior === undefined) {
      return this.acquire(resource, owner, leaseId);
    }
    if (prior.owner === owner && prior.leaseId === leaseId) {
      return this.acquire(resource, owner, leaseId);
    }
    const generation = (this.generations.get(resource) ?? prior.generation) + 1;
    this.sink.lockTakeover("before", resource, prior.owner, owner, generation);
    this.generations.set(resource, generation);
    const epoch = childEpochFor(Object.freeze({ generation, resource }));
    this.active.set(resource, { resource, owner, leaseId, generation, epoch });
    this.sink.lockTakeover("after", resource, prior.owner, owner, generation);
    return Object.freeze({
      kind: "acquired",
      resource,
      owner,
      leaseId,
      generation,
      epoch,
      reentrant: false,
    });
  }

  public release(resourceInput: unknown, leaseInput: unknown, epochInput: unknown): LockResult {
    const resource = text(resourceInput);
    const leaseId = lease(leaseInput);
    const epoch = typeof epochInput === "string" ? epochInput : null;
    if (resource === null || leaseId === null || epoch === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "lock release requires resource, lease, and epoch" });
    }
    const prior = this.active.get(resource);
    const generation = this.generations.get(resource) ?? 0;
    if (prior === undefined || prior.leaseId !== leaseId || prior.epoch !== epoch) {
      return Object.freeze({ kind: "stale", resource, generation });
    }
    this.active.delete(resource);
    return Object.freeze({ kind: "released", resource, generation });
  }

  public releaseOwner(resourceInput: unknown, ownerInput: unknown): LockResult {
    const resource = text(resourceInput);
    const owner = text(ownerInput);
    if (resource === null || owner === null) {
      return Object.freeze({ kind: "invalid", diagnostic: "owner release requires resource and owner" });
    }
    const prior = this.active.get(resource);
    const generation = this.generations.get(resource) ?? 0;
    if (prior === undefined || prior.owner !== owner) {
      return Object.freeze({ kind: "stale", resource, generation });
    }
    this.active.delete(resource);
    return Object.freeze({ kind: "released", resource, generation });
  }

  public validates(resourceInput: unknown, leaseInput: unknown, epochInput?: unknown): boolean {
    const resource = text(resourceInput);
    const leaseId = lease(leaseInput);
    if (resource === null || leaseId === null) {
      return false;
    }
    const active = this.active.get(resource);
    return active !== undefined
      && active.leaseId === leaseId
      && (epochInput === undefined || active.epoch === epochInput);
  }

  public crashRecover(): void {
    this.active.clear();
  }

  public image(): LockManagerImage {
    const epochs = [...this.generations.entries()]
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
      .map(([resource, generation]) => Object.freeze({ resource, generation }));
    return Object.freeze({ epochs: Object.freeze(epochs) });
  }
}

function decodeImage(input: unknown): LockManagerImage {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({ epochs: Object.freeze([]) });
    }
    const entries = Reflect.get(input, "epochs");
    if (!Array.isArray(entries)) {
      return Object.freeze({ epochs: Object.freeze([]) });
    }
    const epochs: LockEpochImage[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return Object.freeze({ epochs: Object.freeze([]) });
      }
      const resource = text(Reflect.get(entry, "resource"));
      const generation = Reflect.get(entry, "generation");
      if (resource === null || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
        return Object.freeze({ epochs: Object.freeze([]) });
      }
      epochs.push(Object.freeze({ resource, generation }));
    }
    return Object.freeze({ epochs: Object.freeze(epochs) });
  } catch {
    return Object.freeze({ epochs: Object.freeze([]) });
  }
}
