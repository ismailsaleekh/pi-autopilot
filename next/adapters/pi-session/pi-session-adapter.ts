import { opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  childIntentCapsule,
  childObservationCapsule,
} from "../../ports/contracts/child.capsule.js";
import type {
  ChildIntent,
  ChildObservation,
  LaunchChildSession,
} from "../../ports/contracts/child.capsule.js";
import type {
  PiCliCommand,
  PiProcessExecutor,
  PiProcessObservation,
  PiRouteGuardObservation,
  PiRouteVerificationRequest,
  PiRouteVerifier,
  PiSessionBindingResolver,
  PiSessionChildReference,
  PiSessionDiagnostic,
  PiSessionExecution,
  PiSessionLaunchBinding,
  PiSessionPhysicalObservation,
  PiSubscriptionRoute,
  PiThinkingLevel,
} from "./types.js";

const THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;
const MAX_SESSION_DIRECTORY_ENTRIES = 4_096;
const MAX_SESSION_FILES = 2;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
const TOOL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ARTIFACT_ROOT = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_CREDENTIAL_ENV = /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BEARER_TOKEN|BASE_URL|AUTH_FILE)$/;

interface SessionFilesObservation {
  readonly code: string | null;
  readonly file: string | null;
  readonly files: readonly string[];
}

interface ChildRecord<Handle> {
  readonly binding: PiSessionLaunchBinding;
  readonly childEpoch: string;
  readonly childId: string;
  fenced: boolean;
  readonly handle: Handle;
  readonly route: Extract<PiRouteGuardObservation, { readonly kind: "verified" }>;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

function diagnostic(code: string, message: string): PiSessionDiagnostic {
  return Object.freeze({ code, message });
}

function contractDiagnostic(code: string, message: string) {
  return Object.freeze({ code, message, related: Object.freeze([]) });
}

function systemCode(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "unknown";
  }
  try {
    const code = Reflect.get(input, "code");
    return typeof code === "string" && code.length > 0 ? code : "unknown";
  } catch {
    return "uninspectable";
  }
}

function safeIntent(input: unknown):
  | { readonly kind: "ok"; readonly value: ChildIntent }
  | { readonly diagnostic: PiSessionDiagnostic; readonly kind: "error" } {
  try {
    const encoded = childIntentCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.invalid-intent", "child intent does not satisfy the frozen contract"),
        kind: "error",
      });
    }
    const decoded = childIntentCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok"
      ? Object.freeze({ kind: "ok", value: decoded.value })
      : Object.freeze({
          diagnostic: diagnostic("pi-session.invalid-intent", "child intent is not canonically encoded"),
          kind: "error",
        });
  } catch {
    return Object.freeze({
      diagnostic: diagnostic("pi-session.uninspectable-intent", "child intent could not be inspected safely"),
      kind: "error",
    });
  }
}

function canonicalObservation(input: unknown): ChildObservation | null {
  try {
    const encoded = childObservationCapsule.encodeUnknown(input);
    if (encoded.kind === "error") {
      return null;
    }
    const decoded = childObservationCapsule.decodeCanonical(encoded.value);
    return decoded.kind === "ok" ? decoded.value : null;
  } catch {
    return null;
  }
}

function stringField(input: object, name: string): string | null {
  try {
    const value = Reflect.get(input, name);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function naturalField(input: object, name: string): number | null {
  try {
    const value = Reflect.get(input, name);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function stringArray(input: unknown, pathValues: boolean): readonly string[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const output: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.includes("\u0000") || (pathValues && !isAbsolute(value))) {
      return null;
    }
    output.push(value);
  }
  return Object.freeze(output);
}

function environmentObject(input: unknown): Readonly<Record<string, string>> | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const output: Record<string, string> = Object.create(null);
    for (const key of Object.keys(input).sort()) {
      const value = Reflect.get(input, key);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\u0000")) {
        return null;
      }
      output[key] = value;
    }
    return Object.freeze(output);
  } catch {
    return null;
  }
}

function commandObject(input: unknown): PiCliCommand | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const executable = stringField(input, "executable");
    const prefixArguments = stringArray(Reflect.get(input, "prefixArguments"), false);
    return executable !== null && isAbsolute(executable) && prefixArguments !== null
      ? Object.freeze({ executable, prefixArguments })
      : null;
  } catch {
    return null;
  }
}

function thinkingLevel(input: unknown): PiThinkingLevel | null {
  if (typeof input !== "string") {
    return null;
  }
  switch (input) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return THINKING_LEVELS.has(input) ? input : null;
    default:
      return null;
  }
}

function routeObject(input: unknown): PiSubscriptionRoute | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const channel = Reflect.get(input, "channel");
    const provider = stringField(input, "provider");
    const model = stringField(input, "model");
    const thinking = thinkingLevel(Reflect.get(input, "thinking"));
    if (
      channel !== "subscription"
      || provider === null
      || model === null
      || !IDENTIFIER.test(provider)
      || !IDENTIFIER.test(model)
      || thinking === null
    ) {
      return null;
    }
    const allowed = (provider === "openai-codex" && model.startsWith("gpt-"))
      || (provider === "anthropic" && model.startsWith("claude-"));
    return allowed ? Object.freeze({ channel, model, provider, thinking }) : null;
  } catch {
    return null;
  }
}

function decodeBinding(input: unknown, intent: LaunchChildSession):
  | { readonly kind: "ok"; readonly value: PiSessionLaunchBinding }
  | { readonly diagnostic: PiSessionDiagnostic; readonly kind: "error" } {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.binding-missing", "Pi launch binding is unavailable"),
        kind: "error",
      });
    }
    const captureDirectory = stringField(input, "captureDirectory");
    const extensionPaths = stringArray(Reflect.get(input, "extensionPaths"), true);
    const maxStderrBytes = naturalField(input, "maxStderrBytes");
    const maxStdoutBytes = naturalField(input, "maxStdoutBytes");
    const piCommand = commandObject(Reflect.get(input, "piCommand"));
    const promptArtifactPath = stringField(input, "promptArtifactPath");
    const promptArtifactRoot = stringField(input, "promptArtifactRoot");
    const promptFilePath = stringField(input, "promptFilePath");
    const route = routeObject(Reflect.get(input, "route"));
    const runtimeRoot = stringField(input, "runtimeRoot");
    const sessionDirectory = stringField(input, "sessionDirectory");
    const toolNames = stringArray(Reflect.get(input, "toolNames"), false);
    const workspaceId = stringField(input, "workspaceId");
    const workspacePath = stringField(input, "workspacePath");
    const workspaceRoot = stringField(input, "workspaceRoot");
    const environment = environmentObject(Reflect.get(input, "environment"));
    if (
      captureDirectory === null
      || extensionPaths === null
      || maxStderrBytes === null
      || maxStdoutBytes === null
      || piCommand === null
      || promptArtifactPath === null
      || promptArtifactRoot === null
      || promptFilePath === null
      || route === null
      || runtimeRoot === null
      || sessionDirectory === null
      || toolNames === null
      || workspaceId === null
      || workspacePath === null
      || workspaceRoot === null
      || environment === null
      || !isAbsolute(captureDirectory)
      || !isAbsolute(promptFilePath)
      || !isAbsolute(sessionDirectory)
      || !isAbsolute(workspacePath)
      || maxStderrBytes < 1
      || maxStdoutBytes < 1
      || maxStderrBytes > MAX_CAPTURE_BYTES
      || maxStdoutBytes > MAX_CAPTURE_BYTES
      || toolNames.some((name) => !TOOL_NAME.test(name))
    ) {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.binding-invalid", "Pi launch binding has an invalid physical field"),
        kind: "error",
      });
    }
    if (
      workspaceId !== intent.inputs.workspaceId
      || workspaceRoot !== intent.preconditions.expectedWorkspaceRoot
      || runtimeRoot !== intent.inputs.runtimeRoot
      || runtimeRoot !== intent.preconditions.runtimeDigest
      || promptArtifactRoot !== intent.inputs.prompt.root
      || promptArtifactPath !== intent.inputs.prompt.path
    ) {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.binding-drift", "Pi launch binding does not match the child intent roots and identities"),
        kind: "error",
      });
    }
    if (extensionPaths.length !== 0) {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.route-extension", "Pi route extensions cannot be verified by the frozen launch contract"),
        kind: "error",
      });
    }
    if (Object.keys(environment).some((key) => {
      const normalized = key.toUpperCase();
      return FORBIDDEN_CREDENTIAL_ENV.test(normalized) || normalized.startsWith("OPENROUTER_");
    })) {
      return Object.freeze({
        diagnostic: diagnostic("pi-session.credential-environment", "Pi child environment contains a forbidden credential or endpoint variable"),
        kind: "error",
      });
    }
    return Object.freeze({
      kind: "ok",
      value: Object.freeze({
        captureDirectory,
        environment,
        extensionPaths,
        maxStderrBytes,
        maxStdoutBytes,
        piCommand,
        promptArtifactPath,
        promptArtifactRoot,
        promptFilePath,
        route,
        runtimeRoot,
        sessionDirectory,
        toolNames,
        workspaceId,
        workspacePath,
        workspaceRoot,
      }),
    });
  } catch {
    return Object.freeze({
      diagnostic: diagnostic("pi-session.binding-uninspectable", "Pi launch binding could not be inspected safely"),
      kind: "error",
    });
  }
}

function childId(intent: LaunchChildSession): string {
  return `child-${intent.actionId.slice("action:sha256:".length)}`;
}

function routeKey(route: PiSubscriptionRoute): string {
  return `${route.channel}\u0000${route.provider}\u0000${route.model}\u0000${route.thinking}`;
}

const failClosedRouteVerifier: PiRouteVerifier = Object.freeze({
  verify: async (request: PiRouteVerificationRequest) => Object.freeze({
    code: "pi-route.verifier-unavailable",
    kind: "refused",
    model: request.route.model,
    provider: request.route.provider,
  }),
});

function launchArguments(binding: PiSessionLaunchBinding, id: string): readonly string[] {
  const tools = binding.toolNames.length === 0
    ? ["--no-tools"]
    : ["--tools", binding.toolNames.join(",")];
  return Object.freeze([
    ...binding.piCommand.prefixArguments,
    "--mode",
    "json",
    "--provider",
    binding.route.provider,
    "--model",
    binding.route.model,
    "--thinking",
    binding.route.thinking,
    "--session-id",
    id,
    "--session-dir",
    binding.sessionDirectory,
    "--name",
    id,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    ...tools,
    `@${binding.promptFilePath}`,
  ]);
}

async function sessionFiles(directory: string, sessionId: string): Promise<SessionFilesObservation> {
  try {
    const suffix = `_${sessionId}.jsonl`;
    const files: string[] = [];
    let observedEntries = 0;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      observedEntries += 1;
      if (observedEntries > MAX_SESSION_DIRECTORY_ENTRIES) {
        return Object.freeze({
          code: "session-directory-bound",
          file: null,
          files: Object.freeze(files.sort()),
        });
      }
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(join(directory, entry.name));
        if (files.length >= MAX_SESSION_FILES) {
          return Object.freeze({
            code: "multiple-session-files",
            file: null,
            files: Object.freeze(files.sort()),
          });
        }
      }
    }
    files.sort();
    return Object.freeze({
      code: null,
      file: files.length === 1 ? files[0] ?? null : null,
      files: Object.freeze(files),
    });
  } catch (error: unknown) {
    const code = systemCode(error);
    return Object.freeze({
      code: code === "ENOENT" ? null : `session-scan-${code}`,
      file: null,
      files: Object.freeze([]),
    });
  }
}

function emptyPhysical(child: Readonly<{ childEpoch: string; childId: string }>): PiSessionPhysicalObservation {
  return Object.freeze({
    childEpoch: child.childEpoch,
    childId: child.childId,
    process: null,
    route: Object.freeze({ kind: "not-checked" }),
    sealedRoot: null,
    sessionDirectory: null,
    sessionFile: null,
    sessionFiles: Object.freeze([]),
    sessionId: null,
    sessionScanCode: null,
    termination: null,
  });
}

function makeExecution(
  candidate: unknown,
  physical: PiSessionPhysicalObservation,
): PiSessionExecution {
  const observation = canonicalObservation(candidate);
  return observation === null
    ? Object.freeze({
        diagnostic: diagnostic("pi-session.observation-invariant", "Pi session observation did not satisfy the frozen child contract"),
        kind: "rejected",
      })
    : Object.freeze({ kind: "observation", observation, physical });
}

function retryCandidate(intent: ChildIntent, observationKind: ChildObservation["kind"], code: string, message: string): unknown {
  return Object.freeze({
    actionId: intent.actionId,
    kind: observationKind,
    result: Object.freeze({
      diagnostic: contractDiagnostic(code, message),
      kind: "retry",
    }),
    runId: intent.runId,
  });
}

function referenceFor<Handle>(record: ChildRecord<Handle>): PiSessionChildReference {
  return Object.freeze({
    childEpoch: record.childEpoch,
    childId: record.childId,
    runId: record.runId,
    sessionDirectory: record.binding.sessionDirectory,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    workspacePath: record.binding.workspacePath,
  });
}

function validSealedRoot(input: unknown): string | null {
  return typeof input === "string" && ARTIFACT_ROOT.test(input) ? input : null;
}

/**
 * Child port adapter over one direct headless Pi CLI process per launch. Pi
 * stdout is never parsed for workflow meaning; process and session-file facts
 * remain physical observations.
 */
export class PiSessionAdapter<Handle> {
  private readonly bindings: PiSessionBindingResolver;
  private readonly processes: PiProcessExecutor<Handle>;
  private readonly routeVerifier: PiRouteVerifier;
  private readonly allowedRoutes: ReadonlySet<string>;
  private readonly terminationGraceMilliseconds: number;
  private readonly children = new Map<string, ChildRecord<Handle>>();

  public constructor(
    processes: PiProcessExecutor<Handle>,
    bindings: PiSessionBindingResolver,
    options?: Readonly<{
      readonly allowedRoutes?: readonly PiSubscriptionRoute[];
      readonly routeVerifier?: PiRouteVerifier;
      readonly terminationGraceMilliseconds?: number;
    }>,
  ) {
    this.processes = processes;
    this.bindings = bindings;
    this.routeVerifier = options?.routeVerifier ?? failClosedRouteVerifier;
    this.allowedRoutes = new Set((options?.allowedRoutes ?? []).map(routeKey));
    this.terminationGraceMilliseconds = options?.terminationGraceMilliseconds ?? 500;
  }

  public async execute(input: unknown): Promise<PiSessionExecution> {
    const decoded = safeIntent(input);
    if (decoded.kind === "error") {
      return Object.freeze({ diagnostic: decoded.diagnostic, kind: "rejected" });
    }
    switch (decoded.value.kind) {
      case "launch-child-session":
        return this.launch(decoded.value);
      case "inspect-child-session":
        return this.inspect(decoded.value);
      case "fence-child-session":
        return this.fence(decoded.value);
    }
  }

  public isActive(childIdInput: unknown, childEpochInput: unknown): boolean {
    if (typeof childIdInput !== "string" || typeof childEpochInput !== "string") {
      return false;
    }
    const record = this.children.get(childIdInput);
    if (record === undefined || record.childEpoch !== childEpochInput || record.fenced) {
      return false;
    }
    const observed = this.processes.observe(record.handle);
    if (observed.kind !== "observed") {
      return false;
    }
    return observed.observation.lifecycle.kind === "running"
      || observed.observation.processGroup.kind !== "absent";
  }

  private async launch(intent: LaunchChildSession): Promise<PiSessionExecution> {
    const id = childId(intent);
    const prior = this.children.get(id);
    if (prior !== undefined) {
      const physical = await this.physical(prior, null);
      return makeExecution(Object.freeze({
        actionId: intent.actionId,
        kind: "child-session-launched",
        result: Object.freeze({
          kind: "ok",
          value: Object.freeze({
            childEpoch: prior.childEpoch,
            childId: prior.childId,
            workspaceId: prior.workspaceId,
          }),
        }),
        runId: intent.runId,
      }), physical);
    }

    let bindingInput: unknown;
    try {
      bindingInput = await this.bindings.resolveLaunch(intent);
    } catch {
      const physical = emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: id });
      return makeExecution(
        retryCandidate(intent, "child-session-launched", "pi-session.binding-unavailable", "Pi launch binding resolver was unavailable"),
        physical,
      );
    }
    const binding = decodeBinding(bindingInput, intent);
    if (binding.kind === "error") {
      const physical = emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: id });
      return makeExecution(
        retryCandidate(intent, "child-session-launched", binding.diagnostic.code, binding.diagnostic.message),
        physical,
      );
    }

    if (!this.allowedRoutes.has(routeKey(binding.value.route))) {
      const physical = emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: id });
      return makeExecution(
        retryCandidate(intent, "child-session-launched", "pi-route.not-pinned", "Pi route is not an exact pinned subscription tuple"),
        physical,
      );
    }

    let route: PiRouteGuardObservation;
    try {
      route = await this.routeVerifier.verify(Object.freeze({
        captureDirectory: binding.value.captureDirectory,
        captureId: `pi-${intent.actionId.slice("action:sha256:".length)}`,
        command: binding.value.piCommand,
        cwd: binding.value.workspacePath,
        environment: binding.value.environment,
        route: binding.value.route,
      }));
    } catch {
      route = Object.freeze({
        code: "pi-route.probe-unavailable",
        kind: "refused",
        model: binding.value.route.model,
        provider: binding.value.route.provider,
      });
    }
    if (
      route.kind === "verified"
      && (route.provider !== binding.value.route.provider || route.model !== binding.value.route.model)
    ) {
      route = Object.freeze({
        code: "pi-route.verification-drift",
        kind: "refused",
        model: binding.value.route.model,
        provider: binding.value.route.provider,
      });
    }
    if (route.kind === "refused") {
      const files = await sessionFiles(binding.value.sessionDirectory, id);
      const physical: PiSessionPhysicalObservation = Object.freeze({
        childEpoch: intent.preconditions.childEpoch,
        childId: id,
        process: null,
        route,
        sealedRoot: null,
        sessionDirectory: binding.value.sessionDirectory,
        sessionFile: files.file,
        sessionFiles: files.files,
        sessionId: id,
        sessionScanCode: files.code,
        termination: null,
      });
      return makeExecution(
        retryCandidate(intent, "child-session-launched", route.code, "subscription-backed Pi route was not verified"),
        physical,
      );
    }

    const started = await this.processes.start(Object.freeze({
      arguments: launchArguments(binding.value, id),
      captureDirectory: binding.value.captureDirectory,
      captureId: `pi-${intent.actionId.slice("action:sha256:".length)}`,
      cwd: binding.value.workspacePath,
      environment: binding.value.environment,
      executable: binding.value.piCommand.executable,
      maxStderrBytes: binding.value.maxStderrBytes,
      maxStdoutBytes: binding.value.maxStdoutBytes,
    }));
    if (started.kind === "rejected") {
      const files = await sessionFiles(binding.value.sessionDirectory, id);
      const physical: PiSessionPhysicalObservation = Object.freeze({
        childEpoch: intent.preconditions.childEpoch,
        childId: id,
        process: null,
        route,
        sealedRoot: null,
        sessionDirectory: binding.value.sessionDirectory,
        sessionFile: files.file,
        sessionFiles: files.files,
        sessionId: id,
        sessionScanCode: files.code,
        termination: null,
      });
      return makeExecution(
        retryCandidate(intent, "child-session-launched", "pi-session.process-not-started", "headless Pi process was not started"),
        physical,
      );
    }
    const record: ChildRecord<Handle> = {
      binding: binding.value,
      childEpoch: intent.preconditions.childEpoch,
      childId: id,
      fenced: false,
      handle: started.handle,
      route,
      runId: intent.runId,
      sessionId: id,
      workspaceId: intent.inputs.workspaceId,
    };
    this.children.set(id, record);
    const physical = await this.physical(record, started.observation);
    return makeExecution(Object.freeze({
      actionId: intent.actionId,
      kind: "child-session-launched",
      result: Object.freeze({
        kind: "ok",
        value: Object.freeze({
          childEpoch: record.childEpoch,
          childId: record.childId,
          workspaceId: record.workspaceId,
        }),
      }),
      runId: intent.runId,
    }), physical);
  }

  private async inspect(intent: Extract<ChildIntent, { readonly kind: "inspect-child-session" }>): Promise<PiSessionExecution> {
    const record = this.children.get(intent.inputs.childId);
    if (record !== undefined && record.childEpoch !== intent.preconditions.childEpoch) {
      return makeExecution(
        retryCandidate(intent, "child-session-inspected", "pi-session.stale-epoch", "child inspection epoch is stale"),
        await this.physical(record, null),
      );
    }
    if (record === undefined) {
      return makeExecution(Object.freeze({
        actionId: intent.actionId,
        kind: "child-session-inspected",
        result: Object.freeze({
          kind: "ok",
          value: Object.freeze({
            childEpoch: intent.preconditions.childEpoch,
            childId: intent.inputs.childId,
            sealedRoot: null,
            state: "absent",
          }),
        }),
        runId: intent.runId,
      }), emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: intent.inputs.childId }));
    }
    const observed = this.processes.observe(record.handle);
    if (observed.kind === "rejected") {
      return makeExecution(
        retryCandidate(intent, "child-session-inspected", "pi-session.process-unobservable", "headless Pi process could not be observed"),
        await this.physical(record, null),
      );
    }
    let sealedRoot: string | null = null;
    try {
      sealedRoot = validSealedRoot(await this.bindings.observeSealedRoot(referenceFor(record)));
    } catch {
      sealedRoot = null;
    }
    const state = record.fenced
      ? "absent"
      : observed.observation.lifecycle.kind !== "running"
        && observed.observation.processGroup.kind === "absent"
        ? "quiescent"
        : "running";
    const physical = await this.physical(record, observed.observation, sealedRoot);
    return makeExecution(Object.freeze({
      actionId: intent.actionId,
      kind: "child-session-inspected",
      result: Object.freeze({
        kind: "ok",
        value: Object.freeze({
          childEpoch: record.childEpoch,
          childId: record.childId,
          sealedRoot,
          state,
        }),
      }),
      runId: intent.runId,
    }), physical);
  }

  private async fence(intent: Extract<ChildIntent, { readonly kind: "fence-child-session" }>): Promise<PiSessionExecution> {
    const record = this.children.get(intent.inputs.childId);
    if (intent.preconditions.childEpoch === intent.preconditions.replacementEpoch) {
      return makeExecution(
        retryCandidate(intent, "child-session-fenced", "pi-session.replacement-epoch", "replacement epoch must differ from the fenced epoch"),
        record === undefined
          ? emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: intent.inputs.childId })
          : await this.physical(record, null),
      );
    }
    if (record !== undefined && record.childEpoch !== intent.preconditions.childEpoch) {
      return makeExecution(
        retryCandidate(intent, "child-session-fenced", "pi-session.stale-epoch", "stale epoch cannot fence the active child"),
        await this.physical(record, null),
      );
    }
    if (record === undefined) {
      return makeExecution(Object.freeze({
        actionId: intent.actionId,
        kind: "child-session-fenced",
        result: Object.freeze({
          kind: "ok",
          value: Object.freeze({
            childId: intent.inputs.childId,
            observedEpoch: intent.preconditions.childEpoch,
            state: "already-absent",
          }),
        }),
        runId: intent.runId,
      }), emptyPhysical({ childEpoch: intent.preconditions.childEpoch, childId: intent.inputs.childId }));
    }
    if (record.fenced) {
      return makeExecution(Object.freeze({
        actionId: intent.actionId,
        kind: "child-session-fenced",
        result: Object.freeze({
          kind: "ok",
          value: Object.freeze({
            childId: record.childId,
            observedEpoch: record.childEpoch,
            state: "already-absent",
          }),
        }),
        runId: intent.runId,
      }), await this.physical(record, null));
    }
    const terminated = await this.processes.terminate(record.handle, {
      graceMilliseconds: this.terminationGraceMilliseconds,
    });
    if (terminated.kind === "rejected") {
      return makeExecution(
        retryCandidate(intent, "child-session-fenced", "pi-session.fence-not-delivered", "process-group termination could not be delivered"),
        await this.physical(record, null),
      );
    }
    const physical = await this.physical(
      record,
      terminated.observation.after,
      undefined,
      terminated.observation.escalated,
    );
    if (terminated.observation.after.processGroup.kind !== "absent") {
      return makeExecution(
        retryCandidate(intent, "child-session-fenced", "pi-session.group-still-present", "process group remains present after termination signals"),
        physical,
      );
    }
    record.fenced = true;
    return makeExecution(Object.freeze({
      actionId: intent.actionId,
      kind: "child-session-fenced",
      result: Object.freeze({
        kind: "ok",
        value: Object.freeze({
          childId: record.childId,
          observedEpoch: record.childEpoch,
          state: "fenced",
        }),
      }),
      runId: intent.runId,
    }), physical);
  }

  private async physical(
    record: ChildRecord<Handle>,
    processInput: PiProcessObservation | null,
    sealedInput?: string | null,
    terminationEscalated?: boolean,
  ): Promise<PiSessionPhysicalObservation> {
    const processObservation = processInput ?? (() => {
      const observed = this.processes.observe(record.handle);
      return observed.kind === "observed" ? observed.observation : null;
    })();
    const files = await sessionFiles(record.binding.sessionDirectory, record.sessionId);
    return Object.freeze({
      childEpoch: record.childEpoch,
      childId: record.childId,
      process: processObservation,
      route: record.route,
      sealedRoot: sealedInput ?? null,
      sessionDirectory: record.binding.sessionDirectory,
      sessionFile: files.file,
      sessionFiles: files.files,
      sessionId: record.sessionId,
      sessionScanCode: files.code,
      termination: terminationEscalated === undefined
        ? null
        : Object.freeze({ escalated: terminationEscalated }),
    });
  }
}
