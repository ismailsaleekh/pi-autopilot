import type { ArtifactRoot, Digest, RunId } from "./identifiers.js";

declare const acceptedBatchCapability: unique symbol;

export interface AcceptedBatch {
  readonly runId: RunId;
  readonly factRoot: ArtifactRoot;
  readonly commandRoot: ArtifactRoot;
  readonly stateDigest: Digest;
  readonly [acceptedBatchCapability]: true;
}
