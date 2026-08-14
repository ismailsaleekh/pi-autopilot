import type { ArtifactPath, ArtifactRoot, KindId } from "../../authority/protocol/identifiers.js";
import {
  actionIdSchema,
  artifactPathSchema,
  artifactRefSchema,
  artifactRootSchema,
  decimalNaturalSchema,
  digestSchema,
  kindIdSchema,
  pageCursorSchema,
  runIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  arrayOf,
  booleanValue,
  defineCapsule,
  jsonValue,
  literal,
  nullable,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer, JsonValue } from "../../authority/protocol/schema.js";
export type { ArtifactPath, ArtifactRef, ArtifactRoot, KindId } from "../../authority/protocol/identifiers.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const installSealedObjectSchema = object({
  actionId: actionIdSchema,
  inputs: object({ artifact: artifactRefSchema }),
  kind: literal("install-sealed-object"),
  preconditions: object({
    expectedDigest: digestSchema,
    objectFirst: literal(true),
  }),
  runId: runIdSchema,
});

export const readArtifactRangeSchema = object({
  actionId: actionIdSchema,
  inputs: object({ artifact: artifactRefSchema }),
  kind: literal("read-artifact-range"),
  preconditions: object({ expectedRoot: artifactRootSchema }),
  runId: runIdSchema,
});

export const listArtifactPageSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    codec: kindIdSchema,
    codecVersion: kindIdSchema,
    cursor: nullable(pageCursorSchema),
    directory: artifactPathSchema,
    pageSize: decimalNaturalSchema,
    previousPageProof: nullable(artifactRefSchema),
    root: artifactRootSchema,
  }),
  kind: literal("list-artifact-page"),
  preconditions: object({ expectedRoot: artifactRootSchema }),
  runId: runIdSchema,
});

export const observeObjectPresenceSchema = object({
  actionId: actionIdSchema,
  inputs: object({ artifact: artifactRefSchema }),
  kind: literal("observe-object-presence"),
  preconditions: object({ expectedDigest: digestSchema }),
  runId: runIdSchema,
});

export const storeIntentSchema = union([
  installSealedObjectSchema,
  readArtifactRangeSchema,
  listArtifactPageSchema,
  observeObjectPresenceSchema,
]);

const installedObjectResultSchema = object({
  alreadyPresent: booleanValue(),
  artifact: artifactRefSchema,
});
const readRangeResultSchema = object({
  content: artifactRefSchema,
  requested: artifactRefSchema,
});
const listedPageResultSchema = object({
  entries: artifactRefSchema,
  nextCursor: nullable(pageCursorSchema),
  pageSize: decimalNaturalSchema,
  previousPageProof: nullable(artifactRefSchema),
  root: artifactRootSchema,
});
const objectPresenceResultSchema = object({
  artifact: artifactRefSchema,
  present: booleanValue(),
});

export const sealedObjectInstalledSchema = object({
  actionId: actionIdSchema,
  kind: literal("sealed-object-installed"),
  result: toolResultSchemaFor(installedObjectResultSchema),
  runId: runIdSchema,
});
export const artifactRangeReadSchema = object({
  actionId: actionIdSchema,
  kind: literal("artifact-range-read"),
  result: toolResultSchemaFor(readRangeResultSchema),
  runId: runIdSchema,
});
export const artifactPageListedSchema = object({
  actionId: actionIdSchema,
  kind: literal("artifact-page-listed"),
  result: toolResultSchemaFor(listedPageResultSchema),
  runId: runIdSchema,
});
export const objectPresenceObservedSchema = object({
  actionId: actionIdSchema,
  kind: literal("object-presence-observed"),
  result: toolResultSchemaFor(objectPresenceResultSchema),
  runId: runIdSchema,
});

export const storeObservationSchema = union([
  sealedObjectInstalledSchema,
  artifactRangeReadSchema,
  artifactPageListedSchema,
  objectPresenceObservedSchema,
]);

export type InstallSealedObject = Infer<typeof installSealedObjectSchema>;
export type ReadArtifactRange = Infer<typeof readArtifactRangeSchema>;
export type ListArtifactPage = Infer<typeof listArtifactPageSchema>;
export type ObserveObjectPresence = Infer<typeof observeObjectPresenceSchema>;
export type StoreIntent = Infer<typeof storeIntentSchema>;
export type SealedObjectInstalled = Infer<typeof sealedObjectInstalledSchema>;
export type ArtifactRangeRead = Infer<typeof artifactRangeReadSchema>;
export type ArtifactPageListed = Infer<typeof artifactPageListedSchema>;
export type ObjectPresenceObserved = Infer<typeof objectPresenceObservedSchema>;
export type StoreObservation = Infer<typeof storeObservationSchema>;

export const storeIntentCapsule = defineIntentCapsule("StoreIntent", "store", storeIntentSchema);
export const storeObservationCapsule = defineCapsule("StoreObservation", storeObservationSchema);

export type StorePageEntry = JsonValue;
const storeCaptureCoordinatesCapsule = defineCapsule("StoreCaptureCoordinates", object({
  codec: kindIdSchema,
  codecVersion: kindIdSchema,
  path: artifactPathSchema,
}));
const storePageCaptureCapsule = defineCapsule("StorePageCapture", object({
  entries: arrayOf(jsonValue()),
  root: artifactRootSchema,
}));

/** Own-contract coordinate decoding keeps the adapter leaf typed without authority imports. */
export function decodeStoreCaptureCoordinates(path: string, codec: string, codecVersion: string): Readonly<{ readonly codec: KindId; readonly codecVersion: KindId; readonly path: ArtifactPath }> | null {
  const decoded = storeCaptureCoordinatesCapsule.decode(Object.freeze({ codec, codecVersion, path }));
  return decoded.kind === "ok" ? decoded.value : null;
}

/** Own-contract canonical page encoding keeps the adapter leaf free of authority imports. */
export function encodeStorePageCapture(entries: readonly StorePageEntry[], root: ArtifactRoot): Uint8Array | null {
  const encoded = storePageCaptureCapsule.encodeUnknown(Object.freeze({ entries: Object.freeze(entries.slice()), root }));
  return encoded.kind === "ok" ? encoded.value : null;
}

export const storeIntentExhaustive = Object.freeze({
  "install-sealed-object": true,
  "list-artifact-page": true,
  "observe-object-presence": true,
  "read-artifact-range": true,
}) satisfies Readonly<Record<StoreIntent["kind"], true>>;

export const storeObservationExhaustive = Object.freeze({
  "artifact-page-listed": true,
  "artifact-range-read": true,
  "object-presence-observed": true,
  "sealed-object-installed": true,
}) satisfies Readonly<Record<StoreObservation["kind"], true>>;
