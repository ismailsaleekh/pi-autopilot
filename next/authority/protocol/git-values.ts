import {
  artifactRefSchema,
  artifactRootSchema,
  gitCommitIdSchema,
  gitObjectIdSchema,
  gitTreeIdSchema,
} from "./identifiers.js";
import {
  arrayOf,
  literal,
  object,
  union,
} from "./schema.js";
import type { Infer } from "./schema.js";

export const gitObjectFormatSchema = union([literal("sha1"), literal("sha256")]);

export const expectedRefStateSchema = union([
  object({ kind: literal("unborn") }),
  object({ commit: gitCommitIdSchema, kind: literal("at") }),
]);

export const gitCaptureSchema = object({
  artifact: artifactRefSchema,
  objectIds: arrayOf(gitObjectIdSchema),
});

export const gitTreeCasAttestationSchema = object({
  artifactRoot: artifactRootSchema,
  attestation: artifactRefSchema,
  gitTree: gitTreeIdSchema,
});

export type GitObjectFormat = Infer<typeof gitObjectFormatSchema>;
export type ExpectedRefState = Infer<typeof expectedRefStateSchema>;
export type GitCapture = Infer<typeof gitCaptureSchema>;
export type GitTreeCasAttestation = Infer<typeof gitTreeCasAttestationSchema>;
