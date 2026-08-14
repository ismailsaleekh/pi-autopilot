import { opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { childIntentCapsule, childObservationCapsule } from "../../ports/contracts/child.capsule.js";
import type { ChildIntent, ChildObservation, LaunchChildSession, VerifyPiRoute } from "../../ports/contracts/child.capsule.js";
import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import type {
  PiProcessExecutor,
  PiProcessObservation,
  PiRouteGuardObservation,
  PiRouteVerifier,
  PiSessionBindingResolver,
  PiSessionDiagnostic,
  PiSessionExecution,
  PiSessionLaunchBinding,
  PiSessionPhysicalObservation,
} from "./types.js";

const FORBIDDEN_ENV = /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BEARER_TOKEN|BASE_URL|AUTH_FILE)$/;
const MAX_SESSION_ENTRIES = 4096;

interface LiveChild<Handle> {
  readonly childId: string;
  readonly childEpoch: string;
  readonly handle: Handle;
  readonly descriptor: ArtifactRef;
  readonly binding: PiSessionLaunchBinding;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

function diagnostic(code: string, message: string): PiSessionDiagnostic { return Object.freeze({ code, message }); }
function contractDiagnostic(code: string, message: string) { return Object.freeze({ code, message, related: Object.freeze([]) }); }
function childId(intent: LaunchChildSession): string { return `child-${intent.actionId.slice(14)}`; }
function canonicalObservation(input: unknown): ChildObservation | null {
  const encoded = childObservationCapsule.encodeUnknown(input);
  if (encoded.kind === "error") return null;
  const decoded = childObservationCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok" ? decoded.value : null;
}
function safeIntent(input: unknown): ChildIntent | null {
  const encoded = childIntentCapsule.encodeUnknown(input);
  if (encoded.kind === "error") return null;
  const decoded = childIntentCapsule.decodeCanonical(encoded.value);
  return decoded.kind === "ok" ? decoded.value : null;
}
function physical(childEpoch: string, id: string, route: PiRouteGuardObservation | { kind: "not-checked" } = Object.freeze({ kind: "not-checked" })): PiSessionPhysicalObservation {
  return Object.freeze({ childEpoch, childId: id, process: null, route, sessionDirectory: null, sessionFile: null, sessionFiles: Object.freeze([]), sessionId: null, sessionScanCode: null, sealedRoot: null, termination: null });
}
function execution(candidate: unknown, facts: PiSessionPhysicalObservation): PiSessionExecution {
  const observation = canonicalObservation(candidate);
  return observation === null
    ? Object.freeze({ kind: "rejected", diagnostic: diagnostic("pi-session.observation-invariant", "child observation is invalid") })
    : Object.freeze({ kind: "observation", observation, physical: facts });
}
function retry(intent: ChildIntent, kind: ChildObservation["kind"], code: string, message: string): PiSessionExecution {
  return execution(Object.freeze({ actionId: intent.actionId, kind, result: Object.freeze({ kind: "retry", diagnostic: contractDiagnostic(code, message) }), runId: intent.runId }), physical("0", `child-${intent.actionId.slice(14)}`));
}
function decimalBound(value: string): number | null {
  try { const parsed = BigInt(value); return parsed > 0n && parsed <= 1_073_741_824n ? Number(parsed) : null; } catch { return null; }
}
function binding(input: unknown): PiSessionLaunchBinding | null {
  try {
    if (typeof input !== "object" || input === null) return null;
    const captureDirectory = Reflect.get(input, "captureDirectory");
    const environment = Reflect.get(input, "environment");
    const piCommand = Reflect.get(input, "piCommand");
    const promptFilePath = Reflect.get(input, "promptFilePath");
    const sessionDirectory = Reflect.get(input, "sessionDirectory");
    const workspacePath = Reflect.get(input, "workspacePath");
    if (![captureDirectory, promptFilePath, sessionDirectory, workspacePath].every((value) => typeof value === "string" && isAbsolute(value)) || typeof environment !== "object" || environment === null || typeof piCommand !== "object" || piCommand === null) return null;
    const executable = Reflect.get(piCommand, "executable");
    const prefixArguments = Reflect.get(piCommand, "prefixArguments");
    if (typeof executable !== "string" || !isAbsolute(executable) || !Array.isArray(prefixArguments) || !prefixArguments.every((value) => typeof value === "string")) return null;
    const env: Record<string, string> = Object.create(null);
    for (const key of Object.keys(environment)) {
      const value = Reflect.get(environment, key);
      if (typeof value !== "string" || FORBIDDEN_ENV.test(key.toUpperCase()) || key.toUpperCase().startsWith("OPENROUTER_")) return null;
      env[key] = value;
    }
    return Object.freeze({ captureDirectory, environment: Object.freeze(env), piCommand: Object.freeze({ executable, prefixArguments: Object.freeze(prefixArguments) }), promptFilePath, sessionDirectory, workspacePath });
  } catch { return null; }
}
function processWire(observation: PiProcessObservation, intent: LaunchChildSession) {
  const lifecycle = observation.lifecycle.kind === "running"
    ? Object.freeze({ kind: "running" })
    : observation.lifecycle.kind === "exited"
      ? Object.freeze({ kind: "exited", code: String(Math.max(0, observation.lifecycle.code)) })
      : observation.lifecycle.kind === "signalled"
        ? Object.freeze({ kind: "signalled", signal: observation.lifecycle.signal })
        : Object.freeze({ kind: "absent" });
  return Object.freeze({
    captureId: intent.inputs.captureId,
    childEpoch: intent.preconditions.childEpoch,
    lifecycle,
    processGroupId: `process-group:${Math.max(0, observation.processGroup.processGroupId)}`,
    processId: `process:${Math.max(0, observation.pid)}`,
    stderr: "captures/stderr.log",
    stderrTruncated: observation.stderr.truncated,
    stdout: "captures/stdout.log",
    stdoutTruncated: observation.stdout.truncated,
    workspaceId: intent.inputs.workspaceId,
  });
}
async function sessionFiles(directory: string, id: string) {
  const files: string[] = [];
  try {
    let count = 0;
    for await (const entry of await opendir(directory)) {
      count += 1;
      if (count > MAX_SESSION_ENTRIES) return Object.freeze({ file: null, files: Object.freeze(files), code: "session-bound" });
      if (entry.isFile() && entry.name.endsWith(`_${id}.jsonl`)) files.push(join(directory, entry.name));
    }
  } catch { return Object.freeze({ file: null, files: Object.freeze([]), code: "session-unavailable" }); }
  return Object.freeze({ file: files.length === 1 ? files[0] ?? null : null, files: Object.freeze(files), code: null });
}

/** Direct shell-free worker-owned Pi launcher. Route verification is a separate intent. */
export class PiSessionAdapter<Handle> {
  private readonly live = new Map<string, LiveChild<Handle>>();
  public constructor(
    private readonly processes: PiProcessExecutor<Handle>,
    private readonly bindings: PiSessionBindingResolver,
    private readonly routeVerifier: PiRouteVerifier,
    private readonly terminationGraceMilliseconds: number,
  ) {}
  public async execute(input: unknown): Promise<PiSessionExecution> {
    const intent = safeIntent(input);
    if (intent === null) return Object.freeze({ kind: "rejected", diagnostic: diagnostic("pi-session.invalid-intent", "invalid child intent") });
    switch (intent.kind) {
      case "verify-pi-route": return this.verify(intent);
      case "launch-child-session": return this.launch(intent);
      case "inspect-child-session": return this.inspect(intent);
      case "fence-child-session": return this.fence(intent);
      case "execute-evidence-command": return retry(intent, "evidence-command-executed", "pi-session.command-owner-unavailable", "dedicated evidence process executor unavailable");
      case "execute-validation-command": return retry(intent, "validation-command-executed", "pi-session.command-owner-unavailable", "dedicated validation process executor unavailable");
    }
  }
  public isActive(childIdInput: unknown, childEpochInput: unknown): boolean {
    if (typeof childIdInput !== "string" || typeof childEpochInput !== "string") return false;
    const child = this.live.get(childIdInput);
    const observed = child === undefined || child.childEpoch !== childEpochInput ? null : this.processes.observe(child.handle);
    return observed?.kind === "observed" && observed.observation.lifecycle.kind === "running";
  }
  private async verify(intent: VerifyPiRoute): Promise<PiSessionExecution> {
    let resolved: unknown;
    try { resolved = await this.bindings.resolveLaunch(intent as never); } catch { resolved = null; }
    const bound = binding(resolved);
    if (bound === null) return retry(intent, "pi-route-verified", "pi-route.binding", "route capability could not resolve Pi executable");
    let guarded: PiRouteGuardObservation;
    try { guarded = await this.routeVerifier.verify(Object.freeze({ captureDirectory: bound.captureDirectory, captureId: intent.inputs.captureId, command: bound.piCommand, cwd: bound.workspacePath, environment: bound.environment, route: intent.inputs.route })); } catch { guarded = Object.freeze({ kind: "refused", code: "pi-route.unavailable", provider: intent.inputs.route.provider, model: intent.inputs.route.model }); }
    if (guarded.kind !== "verified" || guarded.provider !== intent.inputs.route.provider || guarded.model !== intent.inputs.route.model) return retry(intent, "pi-route-verified", "pi-route.refused", "OAuth subscription route was not verified");
    const observationId = `route-observation:${intent.actionId.slice(14)}`;
    return execution(Object.freeze({ actionId: intent.actionId, kind: "pi-route-verified", result: Object.freeze({ kind: "ok", value: Object.freeze({ observationId, route: intent.inputs.route, verified: true }) }), runId: intent.runId }), physical("0", `route-${intent.actionId.slice(14)}`, guarded));
  }
  private async launch(intent: LaunchChildSession): Promise<PiSessionExecution> {
    if (String(intent.preconditions.routeObservation.digest) !== String(intent.preconditions.routeObservation.blob) || intent.preconditions.routeObservationId.length === 0) return retry(intent, "child-session-launched", "pi-route.unbound", "launch lacks installed route observation");
    const stdout = decimalBound(intent.preconditions.maxStdoutBytes);
    const stderr = decimalBound(intent.preconditions.maxStderrBytes);
    if (stdout === null || stderr === null) return retry(intent, "child-session-launched", "pi-session.capture-bound", "capture bounds exceed physical envelope");
    let resolved: unknown;
    try { resolved = await this.bindings.resolveLaunch(intent); } catch { resolved = null; }
    const bound = binding(resolved);
    if (bound === null) return retry(intent, "child-session-launched", "pi-session.binding", "physical launch binding unavailable");
    const id = childId(intent);
    const tools = intent.inputs.route.toolBundleAttestation === null ? ["--no-tools"] : ["--tools", "attested"];
    const args = Object.freeze([...bound.piCommand.prefixArguments, "--mode", "json", "--provider", intent.inputs.route.provider, "--model", intent.inputs.route.model, "--thinking", intent.inputs.route.thinking, "--session-id", id, "--session-dir", bound.sessionDirectory, "--name", id, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", ...tools, `@${bound.promptFilePath}`]);
    const started = await this.processes.start(Object.freeze({ arguments: args, captureDirectory: bound.captureDirectory, captureId: intent.inputs.captureId, cwd: bound.workspacePath, environment: bound.environment, executable: bound.piCommand.executable, maxStderrBytes: stderr, maxStdoutBytes: stdout }));
    if (started.kind !== "started") return retry(intent, "child-session-launched", started.diagnostic.code, started.diagnostic.message);
    const descriptorDocument = Object.freeze({ childEpoch: intent.preconditions.childEpoch, childId: id, processGroupId: started.observation.processGroup.processGroupId, processId: started.observation.pid, runId: intent.runId, workspaceId: intent.inputs.workspaceId });
    let descriptor: ArtifactRef;
    try { descriptor = await this.bindings.persistProcessDescriptor(descriptorDocument); } catch { return retry(intent, "child-session-launched", "pi-session.descriptor", "process descriptor could not be persisted"); }
    const record = Object.freeze({ childId: id, childEpoch: intent.preconditions.childEpoch, handle: started.handle, descriptor, binding: bound, runId: intent.runId, sessionId: id, workspaceId: intent.inputs.workspaceId });
    this.live.set(id, record);
    const process = processWire(started.observation, intent);
    const session = Object.freeze({ process, sessionFile: null, sessionId: id, sessionFiles: Object.freeze([]) });
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-launched", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: intent.preconditions.childEpoch, childId: id, process, processDescriptor: descriptor, session, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }), Object.freeze({ ...physical(intent.preconditions.childEpoch, id), process: started.observation, sessionDirectory: bound.sessionDirectory, sessionId: id }));
  }
  private async inspect(intent: Extract<ChildIntent, { kind: "inspect-child-session" }>): Promise<PiSessionExecution> {
    let loaded: unknown;
    try { loaded = await this.bindings.loadProcessDescriptor(intent.inputs.processDescriptor); } catch { loaded = null; }
    const child = this.live.get(intent.inputs.childId);
    if (loaded === null || child === undefined || child.childEpoch !== intent.preconditions.childEpoch) return retry(intent, "child-session-inspected", "pi-session.descriptor-unavailable", "descriptor cannot be bound to a live physical handle");
    const observed = this.processes.observe(child.handle);
    if (observed.kind !== "observed") return retry(intent, "child-session-inspected", observed.diagnostic.code, observed.diagnostic.message);
    const files = await sessionFiles(child.binding.sessionDirectory, child.sessionId);
    const fakeLaunch = { inputs: { captureId: "capture:inspect", workspaceId: child.workspaceId }, preconditions: { childEpoch: child.childEpoch } } as LaunchChildSession;
    const process = processWire(observed.observation, fakeLaunch);
    const session = Object.freeze({ process, sessionFile: null, sessionId: child.sessionId, sessionFiles: Object.freeze([]) });
    const state = observed.observation.lifecycle.kind === "running" ? "running" : "quiescent";
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-inspected", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: child.childEpoch, childId: child.childId, sealedRoot: null, session, state }) }), runId: intent.runId }), Object.freeze({ ...physical(child.childEpoch, child.childId), process: observed.observation, sessionDirectory: child.binding.sessionDirectory, sessionFile: files.file, sessionFiles: files.files, sessionId: child.sessionId, sessionScanCode: files.code }));
  }
  private async fence(intent: Extract<ChildIntent, { kind: "fence-child-session" }>): Promise<PiSessionExecution> {
    const child = this.live.get(intent.inputs.childId);
    if (child === undefined) return retry(intent, "child-session-fenced", "pi-session.descriptor-unavailable", "no verified live handle for descriptor");
    const terminated = await this.processes.terminate(child.handle, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
    if (terminated.kind !== "terminated") return retry(intent, "child-session-fenced", terminated.diagnostic.code, terminated.diagnostic.message);
    this.live.delete(child.childId);
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-fenced", result: Object.freeze({ kind: "ok", value: Object.freeze({ childId: child.childId, observedEpoch: child.childEpoch, processGroupId: `process-group:${Math.max(0, terminated.observation.after.processGroup.processGroupId)}`, processId: `process:${Math.max(0, terminated.observation.after.pid)}`, state: "fenced" }) }), runId: intent.runId }), Object.freeze({ ...physical(child.childEpoch, child.childId), process: terminated.observation.after, termination: Object.freeze({ escalated: terminated.observation.escalated }) }));
  }
}
