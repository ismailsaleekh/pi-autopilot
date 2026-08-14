import { decodeStoreCaptureCoordinates, encodeStorePageCapture, storeIntentCapsule, storeObservationCapsule } from "../../ports/contracts/store.capsule.js";
import type { ArtifactPath, ArtifactRef, ArtifactRoot, KindId, StoreIntent, StoreObservation, StorePageEntry } from "../../ports/contracts/store.capsule.js";
export interface StoreAdapterDiagnostic { readonly code: string; readonly message: string }
export type StoreAdapterExecution =
  | { readonly kind: "observation"; readonly observation: StoreObservation }
  | { readonly diagnostic: StoreAdapterDiagnostic; readonly kind: "rejected" };
export interface StoreAdapterBackend {
  readonly install: (request: Readonly<{ readonly bytes: Uint8Array; readonly codec: KindId; readonly codecVersion: KindId; readonly path: ArtifactPath }>) => Promise<Readonly<{ readonly kind: "installed"; readonly reference: ArtifactRef }> | Readonly<{ readonly kind: "error"; readonly code: string; readonly message: string }>>;
  readonly list: (root: ArtifactRoot, cursor: string | null, pageSize: number) => Promise<Readonly<{ readonly kind: "page"; readonly entries: readonly StorePageEntry[]; readonly nextCursor: string | null }> | Readonly<{ readonly kind: "error"; readonly code: string; readonly message: string }>>;
  readonly read: (reference: ArtifactRef, maxBytes: number) => Promise<Readonly<{ readonly kind: "read"; readonly bytes: Uint8Array }> | Readonly<{ readonly kind: "error"; readonly code: string; readonly message: string }>>;
}
export interface StoreAdapterOptions {
  readonly backend: StoreAdapterBackend;
  readonly maxReadBytes: number;
  readonly maxPageSize: number;
}
export type StoreAdapterCreateResult =
  | { readonly adapter: StoreAdapter; readonly kind: "created" }
  | { readonly diagnostic: StoreAdapterDiagnostic; readonly kind: "rejected" };

function diagnostic(code: string, message: string): StoreAdapterDiagnostic { return Object.freeze({ code, message }); }
function contractDiagnostic(code: string, message: string) { return Object.freeze({ code, message, related: Object.freeze([]) }); }
function safeIntent(input: unknown): StoreIntent | null {
  const encoded = storeIntentCapsule.encodeUnknown(input);
  if (encoded.kind !== "ok") return null;
  const decoded = storeIntentCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok" ? decoded.value : null;
}

/** Real CAS-backed implementation of the store intent port. */
export class StoreAdapter {
  private constructor(private readonly options: StoreAdapterOptions) {}

  public static create(options: StoreAdapterOptions): StoreAdapterCreateResult {
    if (typeof options !== "object" || options === null || typeof options.backend?.install !== "function" || typeof options.backend?.list !== "function" || typeof options.backend?.read !== "function" || !Number.isSafeInteger(options.maxReadBytes) || options.maxReadBytes < 1 || !Number.isSafeInteger(options.maxPageSize) || options.maxPageSize < 1 || options.maxPageSize > 4096) {
      return Object.freeze({ kind: "rejected", diagnostic: diagnostic("store.invalid-options", "store and positive read/page bounds are required") });
    }
    return Object.freeze({ kind: "created", adapter: new StoreAdapter(Object.freeze(options)) });
  }

  public async execute(input: unknown): Promise<StoreAdapterExecution> {
    const intent = safeIntent(input);
    if (intent === null) return Object.freeze({ kind: "rejected", diagnostic: diagnostic("store.invalid-intent", "store intent does not satisfy the frozen contract") });
    switch (intent.kind) {
      case "install-sealed-object": return this.install(intent);
      case "read-artifact-range": return this.readRange(intent);
      case "list-artifact-page": return this.listPage(intent);
      case "observe-object-presence": return this.observePresence(intent);
    }
  }

  private async install(intent: Extract<StoreIntent, { readonly kind: "install-sealed-object" }>): Promise<StoreAdapterExecution> {
    const bytes = intent.preconditions.expectedDigest === intent.inputs.artifact.digest ? await this.readReference(intent.inputs.artifact) : null;
    return bytes === null
      ? this.retry(intent, "sealed-object-installed", "store.object-unproven", "sealed object bytes are absent or differ from the declared reference")
      : this.observation(intent, "sealed-object-installed", Object.freeze({ kind: "ok", value: Object.freeze({ alreadyPresent: true, artifact: intent.inputs.artifact }) }));
  }

  private async readRange(intent: Extract<StoreIntent, { readonly kind: "read-artifact-range" }>): Promise<StoreAdapterExecution> {
    if (intent.inputs.artifact.root !== intent.preconditions.expectedRoot) return this.retry(intent, "artifact-range-read", "store.root-mismatch", "requested range is not bound to expected root");
    const bytes = await this.readReference(intent.inputs.artifact);
    if (bytes === null) return this.retry(intent, "artifact-range-read", "store.range-unproven", "requested range is absent or exceeds its bound");
    const content = await this.installCapture(`store/range-${intent.actionId.slice(14)}.bin`, bytes, "codec:store-range");
    return content === null
      ? this.retry(intent, "artifact-range-read", "store.range-capture", "range capture could not be installed")
      : this.observation(intent, "artifact-range-read", Object.freeze({ kind: "ok", value: Object.freeze({ content, requested: intent.inputs.artifact }) }));
  }

  private async listPage(intent: Extract<StoreIntent, { readonly kind: "list-artifact-page" }>): Promise<StoreAdapterExecution> {
    if (intent.inputs.root !== intent.preconditions.expectedRoot || (intent.inputs.cursor === null) !== (intent.inputs.previousPageProof === null)) return this.retry(intent, "artifact-page-listed", "store.page-precondition", "page root, cursor, and predecessor proof are not mutually bound");
    const pageSize = Number(intent.inputs.pageSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.options.maxPageSize) return this.retry(intent, "artifact-page-listed", "store.page-bound", "page size exceeds the configured bound");
    const page = await this.options.backend.list(intent.inputs.root, intent.inputs.cursor, pageSize);
    if (page.kind !== "page") return this.retry(intent, "artifact-page-listed", page.code, page.message);
    const encodedPage = encodeStorePageCapture(page.entries, intent.inputs.root);
    const entries = encodedPage === null ? null : await this.installCapture(`store/page-${intent.actionId.slice(14)}.json`, encodedPage, intent.inputs.codec, intent.inputs.codecVersion);
    return entries === null
      ? this.retry(intent, "artifact-page-listed", "store.page-capture", "page proof could not be installed")
      : this.observation(intent, "artifact-page-listed", Object.freeze({ kind: "ok", value: Object.freeze({ entries, nextCursor: page.nextCursor, pageSize: intent.inputs.pageSize, previousPageProof: intent.inputs.previousPageProof, root: intent.inputs.root }) }));
  }

  private async observePresence(intent: Extract<StoreIntent, { readonly kind: "observe-object-presence" }>): Promise<StoreAdapterExecution> {
    const present = intent.preconditions.expectedDigest === intent.inputs.artifact.digest && await this.readReference(intent.inputs.artifact) !== null;
    return this.observation(intent, "object-presence-observed", Object.freeze({ kind: "ok", value: Object.freeze({ artifact: intent.inputs.artifact, present }) }));
  }

  private async readReference(reference: ArtifactRef): Promise<Uint8Array | null> {
    const length = reference.range === null ? Number(reference.byteLength) : Number(reference.range.length);
    if (!Number.isSafeInteger(length) || length < 0 || length > this.options.maxReadBytes) return null;
    const read = await this.options.backend.read(reference, this.options.maxReadBytes);
    return read.kind === "read" && read.bytes.byteLength === length ? read.bytes : null;
  }

  private async installCapture(path: string, bytes: Uint8Array, codec: string, codecVersion: string = "version:2"): Promise<ArtifactRef | null> {
    const coordinates = decodeStoreCaptureCoordinates(path, codec, codecVersion);
    if (coordinates === null) return null;
    const installed = await this.options.backend.install(Object.freeze({ bytes, ...coordinates }));
    return installed.kind === "installed" ? installed.reference : null;
  }

  private retry(intent: StoreIntent, kind: StoreObservation["kind"], code: string, message: string): StoreAdapterExecution {
    return this.observation(intent, kind, Object.freeze({ kind: "retry", diagnostic: contractDiagnostic(code, message) }));
  }
  private observation(intent: StoreIntent, kind: StoreObservation["kind"], result: unknown): StoreAdapterExecution {
    const encoded = storeObservationCapsule.encodeUnknown(Object.freeze({ actionId: intent.actionId, kind, result, runId: intent.runId }));
    if (encoded.kind !== "ok") return Object.freeze({ kind: "rejected", diagnostic: diagnostic("store.invalid-observation", encoded.error.diagnostic) });
    const decoded = storeObservationCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? Object.freeze({ kind: "observation", observation: decoded.value }) : Object.freeze({ kind: "rejected", diagnostic: diagnostic("store.invalid-observation", decoded.error.diagnostic) });
  }
}

export const storeIntentHandlers = Object.freeze({
  "install-sealed-object": true,
  "list-artifact-page": true,
  "observe-object-presence": true,
  "read-artifact-range": true,
}) satisfies Readonly<Record<StoreIntent["kind"], true>>;
