import {
  artifactRefSchema,
  diagnosticCodeSchema,
  digestSchema,
} from "../../authority/protocol/identifiers.js";
import type {
  ActionId,
  ArtifactRef,
  ArtifactRoot,
  CandidateId,
  Diagnostic,
  Digest,
  RevisionId,
} from "../../authority/protocol/identifiers.js";
import type {
  BuildIntegratedCandidate,
  Command,
  ExecuteEvidence,
  ExecuteValidationRule,
  InspectChild,
  LaunchChild,
  PrepareWorkspace,
  PublishCompareAndSwap,
} from "../../authority/protocol/command.capsule.js";
import {
  defineCapsule,
  literal,
  object,
} from "../../authority/protocol/schema.js";
import type { JsonValue } from "../../authority/protocol/schema.js";
import type { Stimulus } from "../../authority/protocol/stimulus.capsule.js";
import type { ChildIntent } from "../../ports/contracts/child.capsule.js";
import type { ClockIntent } from "../../ports/contracts/clock.capsule.js";
import type { GitIntent } from "../../ports/contracts/git.capsule.js";
import type { SecretsIntent } from "../../ports/contracts/secrets.capsule.js";
import type { StoreIntent } from "../../ports/contracts/store.capsule.js";
import type { WorkspaceIntent } from "../../ports/contracts/workspace.capsule.js";
import {
  normalizeArtifact,
} from "../artifact-normalization/index.js";
import type {
  ArtifactNormalizationKind,
  NormalizedArtifact,
} from "../artifact-normalization/index.js";
import {
  decodeArtifactReference,
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
  runMechanicalValidation,
} from "../validation-runner/index.js";
import type { MechanicalRuleExecutor } from "../validation-runner/index.js";
import {
  inspectChildIntent,
  inspectWorkspaceIntent,
  integrateCandidateIntent,
  isolateWorkspaceIntent,
  launchChildIntent,
  prepareWorkspaceIntent,
  publishCandidateIntent,
} from "./intent-construction.js";
import { makeEvidenceEnvelope } from "./evidence.js";

export type RuntimePortIntent =
  | WorkspaceIntent
  | GitIntent
  | ChildIntent
  | StoreIntent
  | ClockIntent
  | SecretsIntent;

export interface RuntimePortExecutor {
  readonly dispatch: (
    port: RuntimePortName,
    intent: RuntimePortIntent,
  ) => unknown | Promise<unknown>;
}

export interface RuntimeArtifactRecorder {
  readonly record: (
    artifact: NormalizedArtifact,
    expectedDigest: Digest,
  ) => unknown | Promise<unknown>;
}

export interface EvidenceCommandExecutor {
  readonly execute: (command: ExecuteEvidence) => unknown | Promise<unknown>;
}

export interface CandidateManifestResolver {
  readonly resolve: (
    candidateId: CandidateId,
    candidateTree: ArtifactRoot,
  ) => unknown | Promise<unknown>;
}

export interface DispatcherDependencies {
  readonly ports: RuntimePortExecutor;
  readonly artifacts: RuntimeArtifactRecorder;
  readonly repositoryBase: RevisionId;
  readonly repositoryIdentity: ArtifactRoot;
  readonly evidenceExecutor: EvidenceCommandExecutor | null;
  readonly validationExecutor: MechanicalRuleExecutor | null;
  readonly candidateManifest: CandidateManifestResolver | null;
}

export interface CommandObservationSink {
  readonly submit: (stimulus: Stimulus) => unknown | Promise<unknown>;
}

export type CommandDispatchReport =
  | {
      readonly kind: "observation-submitted";
      readonly commandId: Command["commandId"];
      readonly actionId: ActionId;
      readonly observation: ArtifactRef;
    }
  | {
      readonly kind: "feedback";
      readonly commandId: Command["commandId"];
      readonly feedback: BoundaryFeedback;
    };

export type DispatcherResult =
  | { readonly kind: "dispatched"; readonly reports: readonly CommandDispatchReport[] }
  | BoundaryFeedback;

interface PortObservationResult {
  readonly kind: "observed";
  readonly observation: RuntimePortObservation;
}

interface ObjectJson {
  readonly [field: string]: JsonValue;
}

interface HandlerContext {
  readonly dependencies: DispatcherDependencies;
  readonly sink: CommandObservationSink;
}

type HandlerMap = {
  readonly [Kind in Command["kind"]]: (
    command: Extract<Command, { readonly kind: Kind }>,
    context: HandlerContext,
  ) => Promise<CommandDispatchReport>;
};

const diagnosticCodeCapsule = defineCapsule("RuntimeDispatcherDiagnosticCode", diagnosticCodeSchema);
const artifactRecordingReceiptCapsule = defineCapsule(
  "RuntimeArtifactRecordingReceipt",
  object({
    digest: digestSchema,
    kind: literal("recorded"),
    reference: artifactRefSchema,
  }),
);

const observationKindByIntent = Object.freeze({
  "allocate-attempt-directory": "attempt-directory-allocated",
  "apply-attempt-isolation": "attempt-isolation-applied",
  "authorize-secret-use": "secret-use-authorized",
  "compare-roots": "roots-compared",
  "dispose-attempt-directory": "attempt-directory-disposed",
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
  "publish-if-expected-head": "head-publication-observed",
  "read-artifact-range": "artifact-range-read",
  "revoke-secret-use": "secret-use-revoked",
  "seal-workspace": "workspace-sealed",
}) satisfies Readonly<Record<RuntimePortIntent["kind"], RuntimePortObservation["kind"]>>;

const normalizationKindByPort = Object.freeze({
  child: "child-observation",
  clock: "clock-observation",
  git: "git-observation",
  secrets: "secrets-observation",
  store: "store-observation",
  workspace: "workspace-observation",
}) satisfies Readonly<Record<RuntimePortName, ArtifactNormalizationKind>>;

function isObjectJson(input: JsonValue): input is ObjectJson {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function boundaryFeedback(path: string, diagnostic: string): BoundaryFeedback {
  return Object.freeze({
    kind: "feedback",
    code: "boundary-schema",
    path,
    diagnostic,
  });
}

function diagnostic(code: string, message: string): Diagnostic {
  const decoded = diagnosticCodeCapsule.decode(code);
  const diagnosticCode = decoded.kind === "ok"
    ? decoded.value
    : diagnosticCodeCapsule.arbitrary.valid(1);
  return Object.freeze({
    code: diagnosticCode,
    message,
    related: Object.freeze([]),
  });
}

function syntheticRetry(
  port: RuntimePortName,
  intent: RuntimePortIntent,
  message: string,
): PortObservationResult | BoundaryFeedback {
  const candidate = Object.freeze({
    actionId: intent.actionId,
    kind: observationKindByIntent[intent.kind],
    result: Object.freeze({
      diagnostic: diagnostic("dispatcher.port-unavailable", message),
      kind: "retry",
    }),
    runId: intent.runId,
  });
  const decoded = decodePortObservation(candidate, port);
  return decoded.kind === "ok"
    ? Object.freeze({ kind: "observed", observation: decoded.value })
    : decoded;
}

async function callPort(
  dependencies: DispatcherDependencies,
  port: RuntimePortName,
  intent: RuntimePortIntent,
): Promise<PortObservationResult | BoundaryFeedback> {
  let raw: unknown;
  try {
    raw = await dependencies.ports.dispatch(port, intent);
  } catch {
    return syntheticRetry(port, intent, "port invocation threw; authority may reschedule the same effect identity");
  }
  const inert = inertJsonFromUnknown(raw);
  if (inert.kind !== "ok") {
    return syntheticRetry(port, intent, "port returned a hostile or non-JSON value");
  }
  const wrapper = isObjectJson(inert.value) ? inert.value : null;
  let candidate: JsonValue = inert.value;
  if (wrapper !== null && wrapper["kind"] === "observation") {
    const observation = wrapper["observation"];
    if (observation === undefined) {
      return syntheticRetry(port, intent, "port observation wrapper omitted its observation");
    }
    candidate = observation;
  } else if (
    wrapper !== null
    && (wrapper["kind"] === "rejected" || wrapper["kind"] === "crashed")
  ) {
    return syntheticRetry(port, intent, "port was unavailable or interrupted before a normalized observation");
  }
  const decoded = decodePortObservation(candidate, port);
  if (
    decoded.kind !== "ok"
    || decoded.value.actionId !== intent.actionId
    || decoded.value.kind !== observationKindByIntent[intent.kind]
    || decoded.value.runId !== intent.runId
  ) {
    return syntheticRetry(port, intent, "port observation failed contract or action-identity verification");
  }
  return Object.freeze({ kind: "observed", observation: decoded.value });
}

async function recordAndSubmit(
  command: Command,
  actionId: ActionId,
  normalizationKind: ArtifactNormalizationKind,
  observation: unknown,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const normalized = normalizeArtifact(observation, normalizationKind);
  if (normalized.kind !== "normalized") {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: normalized });
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = await context.dependencies.artifacts.record(
      normalized.artifact,
      normalized.artifact.digest,
    );
  } catch {
    return Object.freeze({
      kind: "feedback",
      commandId: command.commandId,
      feedback: boundaryFeedback("$.observation", "artifact recorder was unavailable; no settlement was claimed"),
    });
  }
  const receipt = decodeBoundaryValue(rawReceipt, artifactRecordingReceiptCapsule);
  if (receipt.kind !== "ok") {
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: receipt });
  }
  if (receipt.value.digest !== normalized.artifact.digest) {
    return Object.freeze({
      kind: "feedback",
      commandId: command.commandId,
      feedback: boundaryFeedback(
        "$.observationDigest",
        "artifact recorder receipt is not bound to the exact normalized bytes",
      ),
    });
  }
  const stimulus = decodeStimulus(Object.freeze({
    actionId,
    commandId: command.commandId,
    kind: "command-observation-received",
    observation: receipt.value.reference,
    observationDigest: normalized.artifact.digest,
    runId: command.runId,
  }));
  if (stimulus.kind !== "ok" || stimulus.value.kind !== "command-observation-received") {
    const failure = stimulus.kind === "ok"
      ? boundaryFeedback("$.kind", "dispatcher built the wrong stimulus variant")
      : stimulus;
    return Object.freeze({ kind: "feedback", commandId: command.commandId, feedback: failure });
  }
  let sinkResult: unknown;
  try {
    sinkResult = await context.sink.submit(stimulus.value);
  } catch {
    return Object.freeze({
      kind: "feedback",
      commandId: command.commandId,
      feedback: boundaryFeedback("$.observation", "observation sink was interrupted; the same action identity is replayable"),
    });
  }
  if (sinkResult !== undefined) {
    const inertSinkResult = inertJsonFromUnknown(sinkResult);
    if (inertSinkResult.kind !== "ok") {
      return Object.freeze({
        kind: "feedback",
        commandId: command.commandId,
        feedback: boundaryFeedback("$.observation", "observation sink returned a hostile result"),
      });
    }
    const sinkObject = isObjectJson(inertSinkResult.value) ? inertSinkResult.value : null;
    const sinkKind = sinkObject?.["kind"];
    if (sinkKind === "feedback" || sinkKind === "resume" || sinkKind === "fatal") {
      const sinkDiagnostic = sinkObject?.["diagnostic"];
      return Object.freeze({
        kind: "feedback",
        commandId: command.commandId,
        feedback: boundaryFeedback(
          "$.observation",
          typeof sinkDiagnostic === "string"
            ? sinkDiagnostic
            : `observation sink returned ${sinkKind}`,
        ),
      });
    }
  }
  return Object.freeze({
    kind: "observation-submitted",
    commandId: command.commandId,
    actionId,
    observation: receipt.value.reference,
  });
}

async function reportCommandFeedback(
  command: Command,
  diagnosticValue: BoundaryFeedback,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const observation = Object.freeze({
    actionId: command.actionId,
    commandId: command.commandId,
    commandKind: command.kind,
    diagnostic: diagnostic("dispatcher.command-feedback", diagnosticValue.diagnostic),
    kind: "command-execution-feedback",
    runId: command.runId,
  });
  return recordAndSubmit(
    command,
    command.actionId,
    "command-execution-feedback",
    observation,
    context,
  );
}

async function submitPortObservation(
  command: Command,
  port: RuntimePortName,
  intent: RuntimePortIntent,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const observed = await callPort(context.dependencies, port, intent);
  return observed.kind === "observed"
    ? recordAndSubmit(
        command,
        intent.actionId,
        normalizationKindByPort[port],
        observed.observation,
        context,
      )
    : reportCommandFeedback(command, observed, context);
}

async function handlePrepareWorkspace(
  command: PrepareWorkspace,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const intent = prepareWorkspaceIntent(command);
  return intent.kind === "ok"
    ? submitPortObservation(command, "workspace", intent.value, context)
    : reportCommandFeedback(command, intent, context);
}

async function handleLaunchChild(
  command: LaunchChild,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const inspectionIntent = inspectWorkspaceIntent(command);
  if (inspectionIntent.kind !== "ok") {
    return reportCommandFeedback(command, inspectionIntent, context);
  }
  const inspected = await callPort(context.dependencies, "workspace", inspectionIntent.value);
  if (
    inspected.kind !== "observed"
    || inspected.observation.kind !== "attempt-directory-inspected"
    || inspected.observation.result.kind !== "ok"
    || inspected.observation.result.value.observedRoot === null
  ) {
    return inspected.kind === "observed"
      ? recordAndSubmit(command, inspectionIntent.value.actionId, "workspace-observation", inspected.observation, context)
      : reportCommandFeedback(command, inspected, context);
  }
  const root = inspected.observation.result.value.observedRoot;
  const isolationIntent = isolateWorkspaceIntent(command, root);
  if (isolationIntent.kind !== "ok") {
    return reportCommandFeedback(command, isolationIntent, context);
  }
  const isolated = await callPort(context.dependencies, "workspace", isolationIntent.value);
  if (
    isolated.kind !== "observed"
    || isolated.observation.kind !== "attempt-isolation-applied"
    || isolated.observation.result.kind !== "ok"
  ) {
    return isolated.kind === "observed"
      ? recordAndSubmit(command, isolationIntent.value.actionId, "workspace-observation", isolated.observation, context)
      : reportCommandFeedback(command, isolated, context);
  }
  const launchIntent = launchChildIntent(command, root);
  return launchIntent.kind === "ok"
    ? submitPortObservation(command, "child", launchIntent.value, context)
    : reportCommandFeedback(command, launchIntent, context);
}

async function handleInspectChild(
  command: InspectChild,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const intent = inspectChildIntent(command);
  return intent.kind === "ok"
    ? submitPortObservation(command, "child", intent.value, context)
    : reportCommandFeedback(command, intent, context);
}

async function handleEvidence(
  command: ExecuteEvidence,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const executor = context.dependencies.evidenceExecutor;
  if (executor === null) {
    return reportCommandFeedback(
      command,
      boundaryFeedback("$.commandSpec", "frozen ports expose no process/evidence intent; executor binding is unavailable"),
      context,
    );
  }
  let raw: unknown;
  try {
    raw = await executor.execute(command);
  } catch {
    return reportCommandFeedback(command, boundaryFeedback("$.commandSpec", "evidence execution was interrupted"), context);
  }
  const minted = makeEvidenceEnvelope(command, raw);
  if (minted.kind !== "minted") {
    return reportCommandFeedback(command, minted, context);
  }
  return recordAndSubmit(command, command.actionId, "evidence-envelope", minted.envelope, context);
}

async function handleValidation(
  command: ExecuteValidationRule,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const result = await runMechanicalValidation(command, context.dependencies.validationExecutor);
  if (result.kind !== "completed") {
    return reportCommandFeedback(command, result, context);
  }
  if (
    result.report.actionId !== command.actionId
    || result.report.commandId !== command.commandId
    || result.report.ruleId !== command.ruleId
    || result.report.runId !== command.runId
    || result.report.subjectRoot !== command.candidateTree
    || result.report.workItemId !== command.workItemId
  ) {
    return reportCommandFeedback(command, boundaryFeedback("$", "validation report is not bound to the committed command"), context);
  }
  return recordAndSubmit(
    command,
    command.actionId,
    "mechanical-validation-report",
    result.report,
    context,
  );
}

async function handleIntegration(
  command: BuildIntegratedCandidate,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const intent = integrateCandidateIntent(command, Object.freeze({
    repositoryBase: context.dependencies.repositoryBase,
    repositoryIdentity: context.dependencies.repositoryIdentity,
  }));
  return intent.kind === "ok"
    ? submitPortObservation(command, "git", intent.value, context)
    : reportCommandFeedback(command, intent, context);
}

async function handlePublication(
  command: PublishCompareAndSwap,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  const resolver = context.dependencies.candidateManifest;
  if (resolver === null) {
    return reportCommandFeedback(command, boundaryFeedback("$.candidateId", "candidate manifest resolver is unavailable"), context);
  }
  let rawManifest: unknown;
  try {
    rawManifest = await resolver.resolve(command.candidateId, command.candidateTree);
  } catch {
    return reportCommandFeedback(command, boundaryFeedback("$.candidateId", "candidate manifest lookup was interrupted"), context);
  }
  const manifest = decodeArtifactReference(rawManifest);
  if (manifest.kind !== "ok") {
    return reportCommandFeedback(command, manifest, context);
  }
  const intent = publishCandidateIntent(command, manifest.value);
  return intent.kind === "ok"
    ? submitPortObservation(command, "git", intent.value, context)
    : reportCommandFeedback(command, intent, context);
}

const commandHandlers = Object.freeze({
  "build-integrated-candidate": handleIntegration,
  "execute-evidence": handleEvidence,
  "execute-validation-rule": handleValidation,
  "inspect-child": handleInspectChild,
  "launch-child": handleLaunchChild,
  "prepare-workspace": handlePrepareWorkspace,
  "publish-compare-and-swap": handlePublication,
}) satisfies HandlerMap;

async function dispatchOne(
  command: Command,
  context: HandlerContext,
): Promise<CommandDispatchReport> {
  switch (command.kind) {
    case "prepare-workspace":
      return commandHandlers["prepare-workspace"](command, context);
    case "launch-child":
      return commandHandlers["launch-child"](command, context);
    case "inspect-child":
      return commandHandlers["inspect-child"](command, context);
    case "execute-evidence":
      return commandHandlers["execute-evidence"](command, context);
    case "execute-validation-rule":
      return commandHandlers["execute-validation-rule"](command, context);
    case "build-integrated-candidate":
      return commandHandlers["build-integrated-candidate"](command, context);
    case "publish-compare-and-swap":
      return commandHandlers["publish-compare-and-swap"](command, context);
  }
}

/** Executes each committed command once; authority alone decides any retry. */
export async function dispatchCommittedCommands(
  input: unknown,
  dependencies: DispatcherDependencies,
  sink: CommandObservationSink,
): Promise<DispatcherResult> {
  try {
    const decoded = decodeCommandBatch(input);
    if (decoded.kind !== "ok") {
      return decoded;
    }
    const context: HandlerContext = Object.freeze({ dependencies, sink });
    const reports: CommandDispatchReport[] = [];
    for (const command of decoded.value) {
      reports.push(await dispatchOne(command, context));
    }
    return Object.freeze({ kind: "dispatched", reports: Object.freeze(reports) });
  } catch {
    return Object.freeze({
      kind: "feedback",
      code: "boundary-hostile",
      path: "$",
      diagnostic: "dispatcher exception was contained; committed commands remain replayable",
    });
  }
}
