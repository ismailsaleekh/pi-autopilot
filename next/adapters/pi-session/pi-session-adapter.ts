import { opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  childIntentCapsule,
  childObservationCapsule,
  decodeDurableChildDescriptor,
  durableChildDescriptorCodec,
  durableChildDescriptorPath,
  durableChildDescriptorVersion,
  encodeDurableChildDescriptor,
} from "../../ports/contracts/child.capsule.js";
import type { ChildArtifactReference, ChildIntent, ChildObservation, LaunchChildSession, VerifyPiRoute } from "../../ports/contracts/child.capsule.js";
import type {
  PiDurableChildDescriptor,
  PiProcessExecutor,
  PiProcessObservation,
  PiRouteGuardObservation,
  PiRouteVerifier,
  PiSessionArtifactStore,
  PiSessionBindingResolver,
  PiSessionDiagnostic,
  PiSessionExecution,
  PiSessionLaunchBinding,
  PiSessionPhysicalObservation,
} from "./types.js";

const FORBIDDEN_ENV = /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BEARER_TOKEN|BASE_URL|AUTH_FILE)$/;
const MAX_SESSION_ENTRIES = 4096;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

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
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
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
  public constructor(
    private readonly processes: PiProcessExecutor<Handle>,
    private readonly bindings: PiSessionBindingResolver,
    private readonly artifacts: PiSessionArtifactStore,
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
  private async verify(intent: VerifyPiRoute): Promise<PiSessionExecution> {
    let resolved: unknown;
    try { resolved = await this.bindings.resolveLaunch(intent); } catch { resolved = null; }
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
    const described = this.processes.describe(started.handle);
    if (described.kind !== "described" || described.descriptor.pid !== started.observation.pid || described.descriptor.groupId !== started.observation.processGroup.processGroupId) {
      await this.processes.terminate(started.handle, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
      return retry(intent, "child-session-launched", "pi-session.descriptor-identity", "launched process lacked a matching durable identity descriptor");
    }
    const descriptorBytes = encodeDurableChildDescriptor(Object.freeze({ childEpoch: intent.preconditions.childEpoch, childId: id, process: described.descriptor, runId: intent.runId, sessionDirectory: bound.sessionDirectory, sessionId: id, workspaceId: intent.inputs.workspaceId }));
    const codec = durableChildDescriptorCodec();
    const codecVersion = durableChildDescriptorVersion();
    const path = durableChildDescriptorPath();
    if (descriptorBytes === null || descriptorBytes.byteLength > MAX_DESCRIPTOR_BYTES || codec === null || codecVersion === null || path === null) {
      await this.processes.terminateDescriptor(described.descriptor, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
      return retry(intent, "child-session-launched", "pi-session.descriptor", "process descriptor could not be canonically encoded; launched group was fenced");
    }
    let installed;
    try { installed = await this.artifacts.install(Object.freeze({ bytes: descriptorBytes, codec, codecVersion, path })); } catch { installed = Object.freeze({ kind: "error" as const }); }
    if (installed.kind !== "installed") {
      await this.processes.terminateDescriptor(described.descriptor, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
      return retry(intent, "child-session-launched", "pi-session.descriptor", "process descriptor could not be CAS-installed; launched group was fenced");
    }
    const readback = await this.artifacts.read(installed.reference, descriptorBytes.byteLength);
    if (readback.kind !== "read" || !sameBytes(readback.bytes, descriptorBytes)) {
      await this.processes.terminateDescriptor(described.descriptor, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
      return retry(intent, "child-session-launched", "pi-session.descriptor-readback", "installed descriptor failed exact readback; launched group was fenced");
    }
    const descriptor = installed.reference;
    const process = processWire(started.observation, intent);
    const session = Object.freeze({ process, sessionFile: null, sessionId: id, sessionFiles: Object.freeze([]) });
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-launched", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: intent.preconditions.childEpoch, childId: id, process, processDescriptor: descriptor, session, workspaceId: intent.inputs.workspaceId }) }), runId: intent.runId }), Object.freeze({ ...physical(intent.preconditions.childEpoch, id), process: started.observation, sessionDirectory: bound.sessionDirectory, sessionId: id }));
  }
  private async descriptorFromReference(reference: ChildArtifactReference): Promise<PiDurableChildDescriptor | null> {
    const codec = durableChildDescriptorCodec();
    const codecVersion = durableChildDescriptorVersion();
    const path = durableChildDescriptorPath();
    if (codec === null || codecVersion === null || path === null || reference.codec !== codec || reference.codecVersion !== codecVersion || reference.path !== path || String(reference.digest) !== String(reference.blob) || Number(reference.byteLength) > MAX_DESCRIPTOR_BYTES) return null;
    let loaded;
    try { loaded = await this.artifacts.read(reference, MAX_DESCRIPTOR_BYTES); } catch { loaded = Object.freeze({ kind: "error" as const }); }
    return loaded.kind === "read" ? decodeDurableChildDescriptor(loaded.bytes) : null;
  }
  public async isActive(reference: ChildArtifactReference, childIdInput: string, childEpochInput: string, runIdInput: string): Promise<boolean> {
    const descriptor = await this.descriptorFromReference(reference);
    if (descriptor === null || descriptor.childId !== childIdInput || descriptor.childEpoch !== childEpochInput || descriptor.runId !== runIdInput) return false;
    const observed = this.processes.observeDescriptor(descriptor.process);
    return observed.kind === "running";
  }
  private async loadDescriptor(intent: Extract<ChildIntent, { kind: "inspect-child-session" | "fence-child-session" }>): Promise<PiDurableChildDescriptor | null> {
    const descriptor = await this.descriptorFromReference(intent.inputs.processDescriptor);
    return descriptor !== null
      && descriptor.childId === intent.inputs.childId
      && descriptor.childEpoch === intent.preconditions.childEpoch
      && descriptor.runId === intent.runId
      ? descriptor
      : null;
  }
  private async inspect(intent: Extract<ChildIntent, { kind: "inspect-child-session" }>): Promise<PiSessionExecution> {
    const child = await this.loadDescriptor(intent);
    if (child === null) return retry(intent, "child-session-inspected", "pi-session.descriptor-unavailable", "durable descriptor does not bind the requested child, run, and epoch");
    const observed = this.processes.observeDescriptor(child.process);
    if (observed.kind === "rejected") return retry(intent, "child-session-inspected", observed.diagnostic.code, observed.diagnostic.message);
    const files = await sessionFiles(child.sessionDirectory, child.sessionId);
    const state = observed.kind === "running" ? "running" : "absent";
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-inspected", result: Object.freeze({ kind: "ok", value: Object.freeze({ childEpoch: child.childEpoch, childId: child.childId, sealedRoot: null, session: Object.freeze({ process: null, sessionFile: null, sessionId: child.sessionId, sessionFiles: Object.freeze([]) }), state }) }), runId: intent.runId }), Object.freeze({ ...physical(child.childEpoch, child.childId), sessionDirectory: child.sessionDirectory, sessionFile: files.file, sessionFiles: files.files, sessionId: child.sessionId, sessionScanCode: files.code }));
  }
  private async fence(intent: Extract<ChildIntent, { kind: "fence-child-session" }>): Promise<PiSessionExecution> {
    if (BigInt(intent.preconditions.replacementEpoch) <= BigInt(intent.preconditions.childEpoch)) return retry(intent, "child-session-fenced", "pi-session.nonmonotonic-fence", "replacement epoch must be greater than the fenced epoch");
    const child = await this.loadDescriptor(intent);
    if (child === null) return retry(intent, "child-session-fenced", "pi-session.descriptor-unavailable", "durable descriptor does not bind the requested child, run, and epoch");
    const terminated = await this.processes.terminateDescriptor(child.process, Object.freeze({ graceMilliseconds: this.terminationGraceMilliseconds }));
    if (terminated.kind !== "terminated") return retry(intent, "child-session-fenced", terminated.diagnostic.code, terminated.diagnostic.message);
    return execution(Object.freeze({ actionId: intent.actionId, kind: "child-session-fenced", result: Object.freeze({ kind: "ok", value: Object.freeze({ childId: child.childId, observedEpoch: child.childEpoch, processGroupId: `process-group:${terminated.groupId}`, processId: `process:${terminated.pid}`, state: terminated.state }) }), runId: intent.runId }), Object.freeze({ ...physical(child.childEpoch, child.childId), termination: Object.freeze({ escalated: terminated.escalated }) }));
  }
}
