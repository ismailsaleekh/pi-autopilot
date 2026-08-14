import type { Command } from "../../authority/protocol/command.capsule.js";
import type {
  ActionId,
  ArtifactRef,
  CommandId,
  Digest,
} from "../../authority/protocol/identifiers.js";
import type {
  CommandObservationPayload,
  Stimulus,
} from "../../authority/protocol/stimulus.capsule.js";
import type { ChildIntent } from "../../ports/contracts/child.capsule.js";
import type { ClockIntent } from "../../ports/contracts/clock.capsule.js";
import type { GitIntent } from "../../ports/contracts/git.capsule.js";
import type { SecretsIntent } from "../../ports/contracts/secrets.capsule.js";
import type { StoreIntent } from "../../ports/contracts/store.capsule.js";
import type { WorkspaceIntent } from "../../ports/contracts/workspace.capsule.js";
import { normalizeArtifact } from "../artifact-normalization/index.js";
import type { ArtifactNormalizationKind, NormalizedArtifact } from "../artifact-normalization/index.js";
import {
  decodeBoundaryValue,
  decodeCommandBatch,
  decodePortObservation,
  decodeStimulus,
  inertJsonFromUnknown,
} from "../boundary-codecs/index.js";
import type {
  BoundaryFeedback,
  RuntimePortName,
  RuntimePortObservation,
} from "../boundary-codecs/index.js";
import {
  applyWorkspaceIsolationIntent,
  evidenceIntent,
  inspectChildIntent,
  installArtifactIntent,
  integrateCandidateIntent,
  launchChildIntent,
  materializeWorkspaceIntent,
  observeClockIntent,
  prepareWorkspaceIntent,
  publishCandidateIntent,
  validationIntent,
  verifyChildRouteIntent,
} from "./intent-construction.js";
import { defineCapsule, literal, object } from "../../authority/protocol/schema.js";
import { artifactRefSchema, diagnosticCode, digestSchema } from "../../authority/protocol/identifiers.js";

export type RuntimePortIntent = WorkspaceIntent | GitIntent | ChildIntent | StoreIntent | ClockIntent | SecretsIntent;

export interface RuntimePortExecutor {
  readonly dispatch: (port: RuntimePortName, intent: RuntimePortIntent) => unknown | Promise<unknown>;
}

export interface RuntimeArtifactRecorder {
  readonly record: (artifact: NormalizedArtifact, expectedDigest: Digest) => unknown | Promise<unknown>;
  /** Reads exact installed bytes so runtime can reject a fabricated recorder reference. */
  readonly read: (reference: ArtifactRef, maxBytes: number) => unknown | Promise<unknown>;
}

export interface DispatcherDependencies {
  readonly ports: RuntimePortExecutor;
  readonly artifacts: RuntimeArtifactRecorder;
}

export interface CommandObservationSink {
  readonly submit: (stimulus: Stimulus) => unknown | Promise<unknown>;
}

export type CommandDispatchReport =
  | {
      readonly kind: "observation-submitted";
      readonly commandId: CommandId;
      readonly actionId: ActionId;
      readonly observation: ArtifactRef;
    }
  | { readonly kind: "feedback"; readonly commandId: CommandId; readonly feedback: BoundaryFeedback };

export type DispatcherResult =
  | { readonly kind: "dispatched"; readonly reports: readonly CommandDispatchReport[] }
  | BoundaryFeedback;

interface PortBinding {
  readonly port: RuntimePortName;
  readonly intent: RuntimePortIntent;
}

const receiptCapsule = defineCapsule("RuntimeArtifactRecordingReceipt", object({
  digest: digestSchema,
  kind: literal("recorded"),
  reference: artifactRefSchema,
}));

const observationKindByIntent = Object.freeze({
  "allocate-attempt-directory": "attempt-directory-allocated",
  "apply-attempt-isolation": "attempt-isolation-applied",
  "authorize-secret-use": "secret-use-authorized",
  "compare-roots": "roots-compared",
  "dispose-attempt-directory": "attempt-directory-disposed",
  "execute-evidence-command": "evidence-command-executed",
  "execute-validation-command": "validation-command-executed",
  "fence-child-session": "child-session-fenced",
  "inspect-attempt-directory": "attempt-directory-inspected",
  "inspect-child-session": "child-session-inspected",
  "install-sealed-object": "sealed-object-installed",
  "integrate-candidate": "candidate-integrated",
  "launch-child-session": "child-session-launched",
  "list-artifact-page": "artifact-page-listed",
  "materialize-workspace": "workspace-materialized",
  "observe-clock": "clock-observed",
  "observe-object-presence": "object-presence-observed",
  "observe-repository-ref": "repository-ref-observed",
  "publish-if-expected-head": "head-publication-observed",
  "read-artifact-range": "artifact-range-read",
  "revoke-secret-use": "secret-use-revoked",
  "seal-workspace": "workspace-sealed",
  "verify-pi-route": "pi-route-verified",
}) satisfies Readonly<Record<RuntimePortIntent["kind"], RuntimePortObservation["kind"]>>;

const normalizationKindByPort = Object.freeze({
  child: "child-observation",
  clock: "clock-observation",
  git: "git-observation",
  secrets: "secrets-observation",
  store: "store-observation",
  workspace: "workspace-observation",
}) satisfies Readonly<Record<RuntimePortName, ArtifactNormalizationKind>>;

function feedback(path: string, diagnostic: string): BoundaryFeedback {
  return Object.freeze({ kind: "feedback", code: "boundary-schema", path, diagnostic });
}

function binding(command: Command): PortBinding | BoundaryFeedback {
  let constructed;
  switch (command.kind) {
    case "prepare-workspace":
      constructed = prepareWorkspaceIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "workspace", intent: constructed.value }) : constructed;
    case "apply-workspace-isolation":
      constructed = applyWorkspaceIsolationIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "workspace", intent: constructed.value }) : constructed;
    case "materialize-workspace":
      constructed = materializeWorkspaceIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "git", intent: constructed.value }) : constructed;
    case "verify-child-route":
      constructed = verifyChildRouteIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "child", intent: constructed.value }) : constructed;
    case "launch-child":
      constructed = launchChildIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "child", intent: constructed.value }) : constructed;
    case "inspect-child":
      constructed = inspectChildIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "child", intent: constructed.value }) : constructed;
    case "execute-evidence":
      constructed = evidenceIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "child", intent: constructed.value }) : constructed;
    case "execute-validation-rule":
      constructed = validationIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "child", intent: constructed.value }) : constructed;
    case "build-integrated-candidate":
      constructed = integrateCandidateIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "git", intent: constructed.value }) : constructed;
    case "publish-compare-and-swap":
      constructed = publishCandidateIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "git", intent: constructed.value }) : constructed;
    case "observe-clock":
      constructed = observeClockIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "clock", intent: constructed.value }) : constructed;
    case "install-artifact":
      constructed = installArtifactIntent(command);
      return constructed.kind === "ok" ? Object.freeze({ port: "store", intent: constructed.value }) : constructed;
  }
}

async function callPort(dependencies: DispatcherDependencies, bindingValue: PortBinding): Promise<RuntimePortObservation | BoundaryFeedback> {
  let raw: unknown;
  try {
    raw = await dependencies.ports.dispatch(bindingValue.port, bindingValue.intent);
  } catch {
    return feedback("$.port", "port invocation threw before a normalized observation");
  }
  const inert = inertJsonFromUnknown(raw);
  if (inert.kind !== "ok") {
    return inert;
  }
  const wrapper = typeof inert.value === "object" && inert.value !== null && !Array.isArray(inert.value)
    ? inert.value as { readonly [field: string]: import("../../authority/protocol/schema.js").JsonValue }
    : null;
  const candidate = wrapper?.["kind"] === "observation" ? wrapper["observation"] : inert.value;
  if (candidate === undefined) {
    return feedback("$.observation", "port wrapper omitted observation");
  }
  const decoded = decodePortObservation(candidate, bindingValue.port);
  if (decoded.kind !== "ok") {
    return decoded;
  }
  if (
    decoded.value.actionId !== bindingValue.intent.actionId
    || decoded.value.runId !== bindingValue.intent.runId
    || decoded.value.kind !== observationKindByIntent[bindingValue.intent.kind]
  ) {
    return feedback("$.observation", "port observation does not bind exact intent action/run/kind");
  }
  return decoded.value;
}

const recordedObservationCode = diagnosticCode("runtime.observation-recorded");

function observationPayload(command: Command, observation: RuntimePortObservation): CommandObservationPayload | null {
  if (observation.result.kind !== "ok") {
    return Object.freeze({ kind: "command-retry-v2", diagnostic: observation.result.diagnostic });
  }
  switch (observation.kind) {
    case "attempt-directory-allocated": {
      const value = observation.result.value;
      return Object.freeze({
        kind: "workspace-reserved-v2",
        leaseId: value.leaseId,
        workspaceCapability: value.workspaceCapability,
        workspaceId: value.workspaceId,
      });
    }
    case "workspace-materialized": {
      const value = observation.result.value;
      return Object.freeze({
        gitTree: value.baseTree,
        kind: "workspace-materialized-v2",
        workspaceCapability: command.kind === "materialize-workspace" ? command.workspaceCapability : commandCapsuleFailure(),
        workspaceId: value.workspaceId,
      });
    }
    case "pi-route-verified":
      return Object.freeze({ kind: "route-verified-v2", route: observation.result.value });
    case "child-session-launched": {
      const value = observation.result.value;
      return Object.freeze({ childEpoch: value.childEpoch, childId: value.childId, kind: "child-observed-v2", sealedRoot: null, session: value.session });
    }
    case "child-session-inspected": {
      const value = observation.result.value;
      return Object.freeze({ childEpoch: value.childEpoch, childId: value.childId, kind: "child-observed-v2", sealedRoot: value.sealedRoot, session: value.session });
    }
    case "candidate-integrated": {
      const value = observation.result.value;
      if (command.kind !== "build-integrated-candidate") return null;
      return value.kind === "conflict"
        ? Object.freeze({
            conflict: value.conflict.artifact,
            integrationOwnerWorkItemId: command.workItemId,
            kind: "integration-conflict-v2",
            planRootId: command.planRootId,
            subjectRoot: command.candidateRoot,
          })
        : Object.freeze({
              candidateId: value.candidateId,
              gitRevision: value.commit,
              gitTree: value.tree,
              gitTreeCasAttestation: value.treeAttestation,
              kind: "candidate-integrated-v2",
              manifest: value.manifest.artifact,
              planRootId: command.planRootId,
              reviewedDiff: value.diff.artifact,
              tree: value.treeAttestation.artifactRoot,
            });
    }
    case "head-publication-observed": {
      const value = observation.result.value;
      return command.kind === "publish-compare-and-swap"
        ? Object.freeze({
            gitTree: value.gitTree,
            kind: "publication-observed-v2",
            observedHead: value.observedHead,
            publicationId: value.publicationId,
            publicationTreeAttestation: command.verifiedAttestation,
            status: value.status,
            tree: command.verifiedAttestation.artifactRoot,
          })
        : null;
    }
    case "clock-observed":
      return Object.freeze({ kind: "clock-observed-v2", tick: observation.result.value.tick });
    case "sealed-object-installed":
      return Object.freeze({ artifact: observation.result.value.artifact, kind: "artifact-installed-v2" });
    case "evidence-command-executed":
    case "validation-command-executed":
    case "attempt-isolation-applied":
    case "attempt-directory-disposed":
    case "attempt-directory-inspected":
    case "repository-ref-observed":
    case "workspace-sealed":
    case "roots-compared":
    case "child-session-fenced":
    case "artifact-range-read":
    case "artifact-page-listed":
    case "object-presence-observed":
    case "secret-use-authorized":
    case "secret-use-revoked":
      return recordedObservationCode === null ? null : Object.freeze({ kind: "command-retry-v2", diagnostic: Object.freeze({
        code: recordedObservationCode,
        message: "physical observation has no direct semantic consequence",
        related: Object.freeze([]),
      }) });
  }
}

function commandCapsuleFailure(): never {
  throw new Error("closed command/observation kind mismatch");
}

async function recordObservation(
  command: Command,
  bindingValue: PortBinding,
  observation: RuntimePortObservation,
  dependencies: DispatcherDependencies,
  sink: CommandObservationSink,
): Promise<CommandDispatchReport> {
  const payload = observationPayload(command, observation);
  if (payload === null) {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.observation", "observation requires an explicit authority consequence codec") });
  }
  const normalized = normalizeArtifact(observation, normalizationKindByPort[bindingValue.port]);
  if (normalized.kind !== "normalized") {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: normalized });
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = await dependencies.artifacts.record(normalized.artifact, normalized.artifact.digest);
  } catch {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.observation", "artifact recorder interrupted") });
  }
  const receipt = decodeBoundaryValue(rawReceipt, receiptCapsule);
  if (
    receipt.kind !== "ok"
    || receipt.value.digest !== normalized.artifact.digest
    || receipt.value.reference.digest !== normalized.artifact.digest
    || String(receipt.value.reference.blob) !== String(normalized.artifact.digest)
    || receipt.value.reference.byteLength !== String(normalized.artifact.canonicalBytes.byteLength)
    || receipt.value.reference.path !== normalized.artifact.path
  ) {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: receipt.kind === "ok" ? feedback("$.reference", "recorder reference does not bind exact canonical observation bytes") : receipt });
  }
  let installedBytes: unknown;
  try { installedBytes = await dependencies.artifacts.read(receipt.value.reference, normalized.artifact.canonicalBytes.byteLength); } catch {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.reference", "installed observation could not be read back") });
  }
  if (!(installedBytes instanceof Uint8Array) || installedBytes.byteLength !== normalized.artifact.canonicalBytes.byteLength) {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.reference", "installed observation readback has the wrong bounded byte shape") });
  }
  let differs = 0;
  for (let index = 0; index < installedBytes.byteLength; index += 1) differs |= (installedBytes[index] ?? 0) ^ (normalized.artifact.canonicalBytes[index] ?? 0);
  if (differs !== 0) return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.reference", "installed observation bytes differ from canonical observation") });
  const stimulus = decodeStimulus(Object.freeze({
    actionId: command.actionId,
    commandId: command.commandId,
    kind: "command-observation-received",
    observation: receipt.value.reference,
    observationDigest: normalized.artifact.digest,
    observationPayload: payload,
    pages: Object.freeze([]),
    runId: command.runId,
  }));
  if (stimulus.kind !== "ok" || stimulus.value.kind !== "command-observation-received") {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: stimulus.kind === "ok" ? feedback("$.kind", "wrong stimulus") : stimulus });
  }
  try {
    await sink.submit(stimulus.value);
  } catch {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: feedback("$.observation", "observation sink interrupted") });
  }
  return Object.freeze({
    kind: "observation-submitted",
    commandId: command.commandId,
    actionId: command.actionId,
    observation: receipt.value.reference,
  });
}

async function dispatchOne(command: Command, dependencies: DispatcherDependencies, sink: CommandObservationSink): Promise<CommandDispatchReport> {
  const selected = binding(command);
  if ("code" in selected) {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: selected });
  }
  const observation = await callPort(dependencies, selected);
  return "code" in observation
    ? Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: observation })
    : recordObservation(command, selected, observation, dependencies, sink);
}

/** Runtime performs no semantic selection: each command maps to one port intent and one call. */
export async function dispatchCommittedCommands(
  input: unknown,
  dependencies: DispatcherDependencies,
  sink: CommandObservationSink,
): Promise<DispatcherResult> {
  const decoded = decodeCommandBatch(input);
  if (decoded.kind !== "ok") {
    return decoded;
  }
  const reports: CommandDispatchReport[] = [];
  for (const command of decoded.value) {
    reports.push(await dispatchOne(command, dependencies, sink));
  }
  return Object.freeze({ kind: "dispatched", reports: Object.freeze(reports) });
}

