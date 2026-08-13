import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BoundedCapture } from "./bounded-capture.js";
import type {
  CaptureObservation,
  PhysicalDiagnostic,
  ProcessCaptureAcquireResult,
  ProcessCaptureSink,
  ProcessGraceWaiter,
  ProcessGroupObservation,
  ProcessObservation,
  ProcessObserveResult,
  ProcessOutputObservation,
  ProcessOutputReadRequest,
  ProcessOutputReadResult,
  ProcessSignal,
  ProcessSignalResult,
  ProcessStartRequest,
  ProcessStartResult,
  ProcessTerminationResult,
  SignalDeliveryObservation,
} from "./types.js";

const MAX_ARGUMENT_COUNT = 4_096;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 512;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_READ_BYTES = 16 * 1024 * 1024;
const CAPTURE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIGNALS = new Set<ProcessSignal>(["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL"]);

interface DecodedStart {
  readonly value: ProcessStartRequest;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentKeys: readonly string[];
}

function diagnostic(code: string, message: string): PhysicalDiagnostic {
  return Object.freeze({ code, message });
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

function ownString(input: object, key: string): string | null {
  try {
    const value = Reflect.get(input, key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function ownNatural(input: object, key: string): number | null {
  try {
    const value = Reflect.get(input, key);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function decodeStart(input: unknown): DecodedStart | PhysicalDiagnostic {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return diagnostic("process.invalid-start", "process start request must be an object");
    }
    const executable = ownString(input, "executable");
    const cwd = ownString(input, "cwd");
    const captureDirectory = ownString(input, "captureDirectory");
    const captureId = ownString(input, "captureId");
    const maxStdoutBytes = ownNatural(input, "maxStdoutBytes");
    const maxStderrBytes = ownNatural(input, "maxStderrBytes");
    const argumentInput = Reflect.get(input, "arguments");
    const environmentInput = Reflect.get(input, "environment");
    if (
      executable === null
      || cwd === null
      || captureDirectory === null
      || captureId === null
      || maxStdoutBytes === null
      || maxStderrBytes === null
      || !Array.isArray(argumentInput)
      || typeof environmentInput !== "object"
      || environmentInput === null
      || Array.isArray(environmentInput)
    ) {
      return diagnostic("process.invalid-start", "process start request has a missing or invalid field");
    }
    if (!isAbsolute(executable) || !isAbsolute(cwd) || !isAbsolute(captureDirectory)) {
      return diagnostic("process.relative-path", "process executable, cwd, and capture directory must be absolute");
    }
    if (!CAPTURE_ID.test(captureId) || captureId.length > 160) {
      return diagnostic("process.invalid-capture-id", "process capture identity is not a bounded path-safe identifier");
    }
    if (
      maxStdoutBytes < 1
      || maxStderrBytes < 1
      || maxStdoutBytes > MAX_CAPTURE_BYTES
      || maxStderrBytes > MAX_CAPTURE_BYTES
    ) {
      return diagnostic("process.invalid-capture-bound", "process capture bounds must be within 1 byte and 1 GiB");
    }
    if (argumentInput.length > MAX_ARGUMENT_COUNT) {
      return diagnostic("process.argument-count", "process argument count exceeds the physical launch envelope");
    }
    const argumentsOutput: string[] = [];
    let argumentBytes = 0;
    for (const value of argumentInput) {
      if (typeof value !== "string" || value.includes("\u0000")) {
        return diagnostic("process.invalid-argument", "process arguments must be NUL-free strings");
      }
      argumentBytes += Buffer.byteLength(value);
      if (argumentBytes > MAX_ARGUMENT_BYTES) {
        return diagnostic("process.argument-bytes", "process arguments exceed the physical launch envelope");
      }
      argumentsOutput.push(value);
    }
    const environmentKeys = Object.keys(environmentInput).sort();
    if (environmentKeys.length > MAX_ENVIRONMENT_ENTRIES) {
      return diagnostic("process.environment-count", "explicit process environment contains too many entries");
    }
    const environment: Record<string, string> = Object.create(null);
    let environmentBytes = 0;
    for (const key of environmentKeys) {
      const value = Reflect.get(environmentInput, key);
      if (!ENVIRONMENT_KEY.test(key) || typeof value !== "string" || value.includes("\u0000")) {
        return diagnostic("process.invalid-environment", "explicit process environment contains an invalid key or value");
      }
      environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (environmentBytes > MAX_ENVIRONMENT_BYTES) {
        return diagnostic("process.environment-bytes", "explicit process environment exceeds the physical launch envelope");
      }
      environment[key] = value;
    }
    return Object.freeze({
      value: Object.freeze({
        arguments: Object.freeze(argumentsOutput),
        captureDirectory,
        captureId,
        cwd,
        environment: Object.freeze({ ...environment }),
        executable,
        maxStderrBytes,
        maxStdoutBytes,
      }),
      environment,
      environmentKeys: Object.freeze(environmentKeys),
    });
  } catch {
    return diagnostic("process.uninspectable-start", "process start request could not be inspected safely");
  }
}

function decodeReadRequest(input: unknown): ProcessOutputReadRequest | PhysicalDiagnostic {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return diagnostic("process.invalid-output-read", "process output read request must be an object");
    }
    const direction = Reflect.get(input, "direction");
    const stream = Reflect.get(input, "stream");
    const maxBytes = Reflect.get(input, "maxBytes");
    if (
      (direction !== "head" && direction !== "tail")
      || (stream !== "stdout" && stream !== "stderr")
      || typeof maxBytes !== "number"
      || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > MAX_OUTPUT_READ_BYTES
    ) {
      return diagnostic("process.invalid-output-read", "process output read request has an invalid stream, direction, or bound");
    }
    return Object.freeze({ direction, maxBytes, stream });
  } catch {
    return diagnostic("process.uninspectable-output-read", "process output read request could not be inspected safely");
  }
}

function spawnObservation(child: ChildProcessWithoutNullStreams): "spawned" | PhysicalDiagnostic {
  if (child.pid !== undefined) {
    return "spawned";
  }
  return diagnostic("process.spawn-no-pid", "process spawn produced no process identifier");
}

async function awaitSpawn(child: ChildProcessWithoutNullStreams): Promise<"spawned" | PhysicalDiagnostic> {
  const immediate = spawnObservation(child);
  if (immediate === "spawned") {
    return immediate;
  }
  return new Promise((resolveSpawn) => {
    const onSpawn = (): void => {
      cleanup();
      resolveSpawn("spawned");
    };
    const onError = (error: unknown): void => {
      cleanup();
      resolveSpawn(diagnostic(`process.spawn-${systemCode(error)}`, "contained process could not be spawned"));
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

interface ProcessHandleState {
  readonly child: ChildProcessWithoutNullStreams;
  readonly environmentKeys: readonly string[];
  groupKnownAbsent: boolean;
  readonly pid: number;
  readonly stderrCapture: BoundedCapture;
  readonly stdoutCapture: BoundedCapture;
}

const PROCESS_HANDLE_STATES = new WeakMap<ProcessHandle, ProcessHandleState>();

/** Opaque process capability. All signal-bearing facts remain module-private. */
export class ProcessHandle {
  public constructor() {
    Object.freeze(this);
  }

  public async capturesSettled(): Promise<void> {
    const state = PROCESS_HANDLE_STATES.get(this);
    if (state !== undefined) {
      await Promise.all([state.stdoutCapture.settled(), state.stderrCapture.settled()]);
    }
  }
}

function createProcessHandle(
  child: ChildProcessWithoutNullStreams,
  environmentKeys: readonly string[],
  stdoutCapture: BoundedCapture,
  stderrCapture: BoundedCapture,
): ProcessHandle {
  const handle = new ProcessHandle();
  PROCESS_HANDLE_STATES.set(handle, {
    child,
    environmentKeys: Object.freeze([...environmentKeys]),
    groupKnownAbsent: false,
    pid: child.pid ?? -1,
    stderrCapture,
    stdoutCapture,
  });
  return handle;
}

function processHandleState(input: unknown): ProcessHandleState | null {
  return input instanceof ProcessHandle ? PROCESS_HANDLE_STATES.get(input) ?? null : null;
}

function groupObservation(state: ProcessHandleState): ProcessGroupObservation {
  if (state.groupKnownAbsent) {
    return Object.freeze({ kind: "absent", processGroupId: state.pid });
  }
  if (state.pid < 1) {
    return Object.freeze({ code: "invalid-pid", kind: "unobservable", processGroupId: state.pid });
  }
  if (process.platform === "win32") {
    const alive = state.child.exitCode === null && state.child.signalCode === null;
    if (!alive) {
      state.groupKnownAbsent = true;
    }
    return Object.freeze({
      code: "win32-root-only",
      kind: alive ? "unobservable" : "absent",
      processGroupId: state.pid,
    });
  }
  try {
    process.kill(-state.pid, 0);
    return Object.freeze({ kind: "alive", processGroupId: state.pid });
  } catch (error: unknown) {
    const code = systemCode(error);
    if (code === "ESRCH") {
      state.groupKnownAbsent = true;
      return Object.freeze({ kind: "absent", processGroupId: state.pid });
    }
    if (code === "EPERM") {
      return Object.freeze({ kind: "alive", processGroupId: state.pid });
    }
    return Object.freeze({ code, kind: "unobservable", processGroupId: state.pid });
  }
}

function lifecycleObservation(state: ProcessHandleState): ProcessObservation["lifecycle"] {
  if (state.child.signalCode !== null) {
    return Object.freeze({ kind: "signalled", signal: state.child.signalCode });
  }
  if (state.child.exitCode !== null) {
    return Object.freeze({ code: state.child.exitCode, kind: "exited" });
  }
  if (state.pid < 1) {
    return Object.freeze({ kind: "unavailable" });
  }
  return Object.freeze({ kind: "running" });
}

function observation(state: ProcessHandleState): ProcessObservation {
  return Object.freeze({
    environmentKeys: state.environmentKeys,
    lifecycle: lifecycleObservation(state),
    pid: state.pid,
    platform: process.platform,
    processGroup: groupObservation(state),
    stderr: state.stderrCapture.observation(),
    stdout: state.stdoutCapture.observation(),
  });
}

function signalValue(input: unknown): ProcessSignal | null {
  if (typeof input !== "string") {
    return null;
  }
  switch (input) {
    case "SIGHUP":
    case "SIGINT":
    case "SIGTERM":
    case "SIGKILL":
      return SIGNALS.has(input) ? input : null;
    default:
      return null;
  }
}

function sendSignal(
  handleState: ProcessHandleState,
  requestedSignal: ProcessSignal,
): SignalDeliveryObservation {
  const before = observation(handleState);
  if (before.processGroup.kind === "absent") {
    return Object.freeze({
      after: before,
      before,
      requestedSignal,
      state: "already-absent",
    });
  }
  if (handleState.pid < 1) {
    return Object.freeze({
      after: before,
      before,
      requestedSignal,
      state: "not-delivered",
    });
  }
  try {
    const delivered = process.platform === "win32"
      ? handleState.child.kill(requestedSignal)
      : (process.kill(-handleState.pid, requestedSignal), true);
    return Object.freeze({
      after: observation(handleState),
      before,
      requestedSignal,
      state: delivered ? "delivered" : "not-delivered",
    });
  } catch (error: unknown) {
    const state = systemCode(error) === "ESRCH" ? "already-absent" : "not-delivered";
    if (state === "already-absent") {
      handleState.groupKnownAbsent = true;
    }
    return Object.freeze({
      after: observation(handleState),
      before,
      requestedSignal,
      state,
    });
  }
}

async function waitForRootExitAfterKill(state: ProcessHandleState): Promise<void> {
  if (state.child.exitCode !== null || state.child.signalCode !== null) {
    return;
  }
  try {
    await once(state.child, "exit");
  } catch {
    // The following observation remains the sole reported fact.
  }
}

async function readBoundedFile(
  path: string,
  request: ProcessOutputReadRequest,
  capture: CaptureObservation,
): Promise<ProcessOutputReadResult> {
  try {
    const metadata = await stat(path);
    const fileBytes = metadata.size;
    if (!Number.isSafeInteger(fileBytes) || fileBytes < 0) {
      return Object.freeze({
        diagnostic: diagnostic("process.output-size", "process output file size is not a safe observable integer"),
        kind: "rejected",
      });
    }
    const length = Math.min(fileBytes, request.maxBytes);
    if (length === 0) {
      const empty: ProcessOutputObservation = Object.freeze({
        bytes: new Uint8Array(),
        direction: request.direction,
        fileBytes: String(fileBytes),
        path,
        sourceTruncated: capture.truncated,
        stream: request.stream,
        truncated: capture.truncated,
      });
      return Object.freeze({ kind: "collected", observation: empty });
    }
    const start = request.direction === "tail" ? fileBytes - length : 0;
    const end = start + length - 1;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of createReadStream(path, { start, end })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > request.maxBytes) {
        return Object.freeze({
          diagnostic: diagnostic("process.output-bound", "process output reader exceeded its declared bound"),
          kind: "rejected",
        });
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, total);
    return Object.freeze({
      kind: "collected",
      observation: Object.freeze({
        bytes: Uint8Array.from(bytes),
        direction: request.direction,
        fileBytes: String(fileBytes),
        path,
        sourceTruncated: capture.truncated,
        stream: request.stream,
        truncated: capture.truncated || fileBytes > request.maxBytes,
      }),
    });
  } catch (error: unknown) {
    return Object.freeze({
      diagnostic: diagnostic(`process.output-read-${systemCode(error)}`, "bounded process output could not be read"),
      kind: "rejected",
    });
  }
}

/**
 * One request creates one detached process group. The adapter has no queue,
 * restart, watchdog, or completion policy; every method reports physical facts.
 */
export class ProcessAdapter {
  private readonly captureSink: ProcessCaptureSink;
  private readonly graceWaiter: ProcessGraceWaiter;

  public constructor(captureSink: ProcessCaptureSink, graceWaiter: ProcessGraceWaiter) {
    this.captureSink = captureSink;
    this.graceWaiter = graceWaiter;
  }

  public async start(input: unknown): Promise<ProcessStartResult<ProcessHandle>> {
    const decoded = decodeStart(input);
    if ("code" in decoded) {
      return Object.freeze({ diagnostic: decoded, kind: "rejected" });
    }
    let acquired: ProcessCaptureAcquireResult;
    try {
      acquired = await this.captureSink.acquire(Object.freeze({
        captureDirectory: decoded.value.captureDirectory,
        captureId: decoded.value.captureId,
      }));
    } catch {
      return Object.freeze({
        diagnostic: diagnostic("process.capture-sink-unavailable", "process capture sink was unavailable"),
        kind: "rejected",
      });
    }
    if (acquired.kind === "rejected") {
      return Object.freeze({ diagnostic: acquired.diagnostic, kind: "rejected" });
    }
    const stdoutPath = join(decoded.value.captureDirectory, `${decoded.value.captureId}.stdout`);
    const stderrPath = join(decoded.value.captureDirectory, `${decoded.value.captureId}.stderr`);
    const stdoutCapture = new BoundedCapture(
      acquired.stdout.path,
      decoded.value.maxStdoutBytes,
      acquired.stdout.stream,
    );
    const stderrCapture = new BoundedCapture(
      acquired.stderr.path,
      decoded.value.maxStderrBytes,
      acquired.stderr.stream,
    );
    if (acquired.stdout.path !== stdoutPath || acquired.stderr.path !== stderrPath) {
      stdoutCapture.closeWithoutInput();
      stderrCapture.closeWithoutInput();
      await Promise.all([stdoutCapture.settled(), stderrCapture.settled()]);
      return Object.freeze({
        diagnostic: diagnostic("process.capture-path-drift", "process capture sink returned an unexpected path"),
        kind: "rejected",
      });
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(decoded.value.executable, decoded.value.arguments, {
        cwd: decoded.value.cwd,
        detached: process.platform !== "win32",
        env: decoded.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error: unknown) {
      stdoutCapture.closeWithoutInput();
      stderrCapture.closeWithoutInput();
      await Promise.all([stdoutCapture.settled(), stderrCapture.settled()]);
      return Object.freeze({
        diagnostic: diagnostic(`process.spawn-${systemCode(error)}`, "contained process spawn threw before launch"),
        kind: "rejected",
      });
    }
    child.stdin.end();
    const spawned = await awaitSpawn(child);
    if (spawned !== "spawned") {
      stdoutCapture.closeWithoutInput();
      stderrCapture.closeWithoutInput();
      await Promise.all([stdoutCapture.settled(), stderrCapture.settled()]);
      return Object.freeze({ diagnostic: spawned, kind: "rejected" });
    }
    child.on("error", () => {
      // Spawn/runtime errors are observed through lifecycle and capture facts.
    });
    stdoutCapture.attach(child.stdout);
    stderrCapture.attach(child.stderr);
    const handle = createProcessHandle(
      child,
      decoded.environmentKeys,
      stdoutCapture,
      stderrCapture,
    );
    const state = processHandleState(handle);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.handle-invariant", "process handle state was not installed"),
        kind: "rejected",
      });
    }
    return Object.freeze({ handle, kind: "started", observation: observation(state) });
  }

  public observe(input: unknown): ProcessObserveResult {
    const state = processHandleState(input);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.unknown-handle", "process observation requires a handle created by this adapter surface"),
        kind: "rejected",
      });
    }
    return Object.freeze({ kind: "observed", observation: observation(state) });
  }

  public signal(input: unknown, signalInput: unknown): ProcessSignalResult {
    const state = processHandleState(input);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.unknown-handle", "process signalling requires a handle created by this adapter surface"),
        kind: "rejected",
      });
    }
    const requestedSignal = signalValue(signalInput);
    if (requestedSignal === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.invalid-signal", "process signal is not in the physical adapter signal set"),
        kind: "rejected",
      });
    }
    return Object.freeze({ kind: "signalled", observation: sendSignal(state, requestedSignal) });
  }

  public async terminate(
    input: unknown,
    optionsInput: unknown,
  ): Promise<ProcessTerminationResult> {
    const state = processHandleState(input);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.unknown-handle", "process termination requires a handle created by this adapter surface"),
        kind: "rejected",
      });
    }
    let graceMilliseconds: number | null = null;
    try {
      graceMilliseconds = typeof optionsInput === "object" && optionsInput !== null
        ? ownNatural(optionsInput, "graceMilliseconds")
        : null;
    } catch {
      graceMilliseconds = null;
    }
    if (graceMilliseconds === null || graceMilliseconds > 60_000) {
      return Object.freeze({
        diagnostic: diagnostic("process.invalid-grace", "process termination grace must be an integer from 0 through 60000 milliseconds"),
        kind: "rejected",
      });
    }
    const before = observation(state);
    const gracefulSignal = sendSignal(state, "SIGTERM");
    if (gracefulSignal.state === "delivered" && graceMilliseconds > 0) {
      try {
        await this.graceWaiter.waitForGrace(graceMilliseconds);
      } catch {
        const emergencySignal = sendSignal(state, "SIGKILL");
        if (emergencySignal.state === "delivered") {
          await waitForRootExitAfterKill(state);
        }
        return Object.freeze({
          diagnostic: diagnostic("process.grace-wait-unavailable", "process termination grace wait was unavailable"),
          kind: "rejected",
        });
      }
    }
    const afterGrace = observation(state);
    const killSignal = afterGrace.processGroup.kind === "alive"
      || (afterGrace.processGroup.kind === "unobservable" && afterGrace.lifecycle.kind === "running")
      ? sendSignal(state, "SIGKILL")
      : null;
    if (killSignal?.state === "delivered") {
      await waitForRootExitAfterKill(state);
    }
    return Object.freeze({
      kind: "terminated",
      observation: Object.freeze({
        after: observation(state),
        before,
        escalated: killSignal?.state === "delivered",
        graceMilliseconds,
        gracefulSignal,
        killSignal,
      }),
    });
  }

  public async waitForExit(input: unknown): Promise<ProcessObserveResult> {
    const state = processHandleState(input);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.unknown-handle", "process exit wait requires a handle created by this adapter surface"),
        kind: "rejected",
      });
    }
    if (state.child.exitCode === null && state.child.signalCode === null) {
      try {
        await once(state.child, "close");
      } catch {
        // The normalized lifecycle observation below remains authoritative.
      }
    }
    await Promise.all([state.stdoutCapture.settled(), state.stderrCapture.settled()]);
    return Object.freeze({ kind: "observed", observation: observation(state) });
  }

  public async collectOutput(input: unknown, requestInput: unknown): Promise<ProcessOutputReadResult> {
    const state = processHandleState(input);
    if (state === null) {
      return Object.freeze({
        diagnostic: diagnostic("process.unknown-handle", "process output collection requires a handle created by this adapter surface"),
        kind: "rejected",
      });
    }
    const request = decodeReadRequest(requestInput);
    if ("code" in request) {
      return Object.freeze({ diagnostic: request, kind: "rejected" });
    }
    const capture = request.stream === "stdout"
      ? state.stdoutCapture.observation()
      : state.stderrCapture.observation();
    return readBoundedFile(capture.path, request, capture);
  }
}
