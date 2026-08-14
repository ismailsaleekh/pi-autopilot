import {
  actionIdSchema,
  artifactRefSchema,
  childEpochSchema,
  childIdSchema,
  digestSchema,
  kindIdSchema,
  leaseIdSchema,
  runIdSchema,
  secretHandleSchema,
} from "../../authority/protocol/identifiers.js";
import {
  defineCapsule,
  literal,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const secretDestinationSchema = union([
  object({ kind: literal("process-environment"), variable: kindIdSchema }),
  object({ kind: literal("process-stdin") }),
]);

export const authorizeSecretUseSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    childId: childIdSchema,
    destination: secretDestinationSchema,
    purposeId: kindIdSchema,
    secretHandle: secretHandleSchema,
  }),
  kind: literal("authorize-secret-use"),
  preconditions: object({
    childEpoch: childEpochSchema,
    policyDigest: digestSchema,
    processDescriptor: artifactRefSchema,
  }),
  runId: runIdSchema,
});

export const revokeSecretUseSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    leaseId: leaseIdSchema,
    secretHandle: secretHandleSchema,
  }),
  kind: literal("revoke-secret-use"),
  preconditions: object({ childEpoch: childEpochSchema, processDescriptor: artifactRefSchema }),
  runId: runIdSchema,
});

export const secretsIntentSchema = union([authorizeSecretUseSchema, revokeSecretUseSchema]);

const authorizedSecretResultSchema = object({
  destination: secretDestinationSchema,
  leaseId: leaseIdSchema,
  purposeId: kindIdSchema,
  secretHandle: secretHandleSchema,
});
const revokedSecretResultSchema = object({
  leaseId: leaseIdSchema,
  secretHandle: secretHandleSchema,
  state: union([literal("revoked"), literal("already-revoked")]),
});

export const secretUseAuthorizedSchema = object({
  actionId: actionIdSchema,
  kind: literal("secret-use-authorized"),
  result: toolResultSchemaFor(authorizedSecretResultSchema),
  runId: runIdSchema,
});
export const secretUseRevokedSchema = object({
  actionId: actionIdSchema,
  kind: literal("secret-use-revoked"),
  result: toolResultSchemaFor(revokedSecretResultSchema),
  runId: runIdSchema,
});

export const secretsObservationSchema = union([secretUseAuthorizedSchema, secretUseRevokedSchema]);

export type SecretDestination = Infer<typeof secretDestinationSchema>;
export type AuthorizeSecretUse = Infer<typeof authorizeSecretUseSchema>;
export type RevokeSecretUse = Infer<typeof revokeSecretUseSchema>;
export type SecretsIntent = Infer<typeof secretsIntentSchema>;
export type SecretUseAuthorized = Infer<typeof secretUseAuthorizedSchema>;
export type SecretUseRevoked = Infer<typeof secretUseRevokedSchema>;
export type SecretsObservation = Infer<typeof secretsObservationSchema>;

export const secretsIntentCapsule = defineIntentCapsule("SecretsIntent", "secrets", secretsIntentSchema);
export const secretsObservationCapsule = defineCapsule("SecretsObservation", secretsObservationSchema);

export const secretsIntentExhaustive = Object.freeze({
  "authorize-secret-use": true,
  "revoke-secret-use": true,
}) satisfies Readonly<Record<SecretsIntent["kind"], true>>;

export const secretsObservationExhaustive = Object.freeze({
  "secret-use-authorized": true,
  "secret-use-revoked": true,
}) satisfies Readonly<Record<SecretsObservation["kind"], true>>;
