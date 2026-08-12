import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { CoreToHostFrame, HostToCoreFrame } from "./generated/index.ts";
import { validateCoreToHostFrame } from "./generated/frame-validation.ts";
import { HOST_ENV_DENY } from "./generated/host-runtime-tables.ts";
import { redactedEnv } from "./host-runtime.ts";
import { resolveCoreBinary, resolveRunnerTransport, type RunnerResolution } from "./resolve-core.ts";

export interface CoreTransportOptions {
  binaryPath?: string;
  packageJsonPath?: string;
  /** Test-only inherited environment seam; production uses process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}
/** Host/Core-only broker facts; never include these in model-visible frames or diagnostics. */
export interface ChildControlBrokerLaunchFacts { readonly socketPath: string; readonly capability: string; }
interface PendingRequest { resolve: (frame: CoreToHostFrame) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; }
type CoreTransportState = "active" | "graceful-shutdown" | "closed";
export class CoreUnavailableError extends Error { constructor(message: string) { super(message); this.name = "CoreUnavailableError"; } }
export class CoreTimeoutError extends Error { constructor(message: string) { super(message); this.name = "CoreTimeoutError"; } }

const CHILD_CONTROL_SOCKET_PATH = /^\/tmp\/\.pi-ap\/[a-f0-9]{10}\/s$/u;
const LOWER_HEX_256 = /^[a-f0-9]{64}$/u;

/** Builds the only permitted Core child environment without exposing a capability to diagnostics. */
export function coreLaunchEnvironment(
  runner: RunnerResolution,
  broker: ChildControlBrokerLaunchFacts,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return redactedEnv(HOST_ENV_DENY, {
    AUTOPILOT_NODE_EXECUTABLE: runner.nodeExecutable,
    AUTOPILOT_AGENT_RUNNER_WRAPPER: runner.runnerWrapper,
    AUTOPILOT_CHILD_ADDON_PATH: runner.childAddon,
    AUTOPILOT_CHILD_CONTROL_SOCKET_PATH: broker.socketPath,
    AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY: broker.capability,
  }, base);
}

export class CoreTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private stdout = "";
  private readonly pending = new Map<number, PendingRequest>();
  private diagnostics: string[] = [];
  private readonly options: CoreTransportOptions;
  private childControlBroker: ChildControlBrokerLaunchFacts | undefined;
  private state: CoreTransportState = "active";

  constructor(options: CoreTransportOptions = {}) {
    this.options = options;
  }

  request<K extends HostToCoreFrame["kind"]>(kind: K, payload: Extract<HostToCoreFrame, { kind: K }>["payload"], timeoutMs?: number): Promise<CoreToHostFrame> {
    return this.send({ v: 1, id: this.nextId++, kind, payload } as Extract<HostToCoreFrame, { kind: K }>, timeoutMs);
  }

  send(frame: HostToCoreFrame, timeoutMs?: number): Promise<CoreToHostFrame> {
    return new Promise((resolve, reject) => {
      if (this.state === "closed") { reject(new CoreUnavailableError("autopilot-core transport is closed")); return; }
      if (this.state === "graceful-shutdown") { reject(new CoreUnavailableError("autopilot-core shutdown is already in progress")); return; }
      let child: ChildProcessWithoutNullStreams;
      try { child = this.ensureChild(); } catch (error) {
        reject(new CoreUnavailableError(errorMessage(error)));
        return;
      }
      if (frame.kind === "shutdown") this.state = "graceful-shutdown";
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs !== undefined) pending.timer = setTimeout(() => {
        this.rejectPending(frame.id, pending, new CoreTimeoutError(`autopilot-core timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(frame.id, pending);
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error !== null && error !== undefined && !this.containsOwnedShutdownPipeError(child, error)) {
          this.rejectPending(frame.id, pending, new CoreUnavailableError(error.message));
        }
      });
    });
  }

  /**
   * Activation binds exactly one private broker before Core can start. The fact
   * survives a Core child-process restart and is never included in diagnostics.
   */
  bindChildControlBroker(facts: ChildControlBrokerLaunchFacts): void {
    if (!isExactChildControlBrokerFacts(facts)) {
      throw new CoreUnavailableError("autopilot-core requires exact private child-control broker launch facts");
    }
    if (this.hasLiveChild()) {
      throw new CoreUnavailableError("autopilot-core broker launch facts must bind before the first Core spawn");
    }
    if (this.childControlBroker !== undefined && (this.childControlBroker.socketPath !== facts.socketPath || this.childControlBroker.capability !== facts.capability)) {
      throw new CoreUnavailableError("autopilot-core broker launch facts cannot change during an active Host lifecycle");
    }
    this.childControlBroker = facts;
  }

  lastDiagnostics(): string { return this.diagnostics.join("\n"); }
  hasLiveChild(): boolean { return this.child !== undefined && this.child.exitCode === null && !this.child.killed; }
  close(): void {
    this.state = "closed";
    if (this.child !== undefined) {
      this.child.stdin.destroy();
      this.child.kill();
      this.child = undefined;
    }
    this.failPending(new CoreUnavailableError("autopilot-core transport closed"));
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.hasLiveChild() && this.child !== undefined) return this.child;
    const broker = this.childControlBroker;
    if (broker === undefined) {
      throw new CoreUnavailableError("autopilot-core cannot start before activation binds private child-control broker facts");
    }
    const runner = resolveRunnerTransport({ packageJsonPath: this.options.packageJsonPath });
    const child = spawn(this.options.binaryPath ?? resolveCoreBinary({ packageJsonPath: this.options.packageJsonPath }), [], {
      stdio: "pipe",
      env: coreLaunchEnvironment(runner, broker, this.options.baseEnv),
    });
    this.child = child;
    this.stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => this.noteDiagnostics(chunk));
    child.stdin.on("error", (error) => {
      if (this.containsOwnedShutdownPipeError(child, error)) return;
      if (this.child === child) this.failPending(new CoreUnavailableError(error.message));
    });
    child.on("error", (error) => {
      if (this.child === child) this.failPending(new CoreUnavailableError(error.message));
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.state === "graceful-shutdown") this.state = "closed";
      this.failPending(new CoreUnavailableError(`autopilot-core exited code=${code ?? "null"} signal=${signal ?? "null"}; diagnostics=${this.lastDiagnostics()}`));
    });
    return child;
  }

  private receive(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const index = this.stdout.indexOf("\n");
      if (index < 0) return;
      this.receiveLine(this.stdout.slice(0, index));
      this.stdout = this.stdout.slice(index + 1);
    }
  }

  private receiveLine(line: string): void {
    let frame: CoreToHostFrame;
    try { frame = validateCoreToHostFrame(JSON.parse(line)); } catch (error) { this.failPending(new CoreUnavailableError(`autopilot-core emitted malformed frame: ${errorMessage(error)}`)); return; }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) { this.noteDiagnostics(`unmatched core frame id=${frame.id} kind=${frame.kind}`); return; }
    this.pending.delete(frame.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private noteDiagnostics(_chunk: string): void {
    // Core stderr can contain arbitrary child-process diagnostics. Keep a
    // bounded machine code instead of retaining text that could include the
    // Host/Core-only capability (including across arbitrary stream chunks).
    this.diagnostics.push("core-stderr");
    if (this.diagnostics.length > 20) this.diagnostics = this.diagnostics.slice(-20);
  }

  private containsOwnedShutdownPipeError(child: ChildProcessWithoutNullStreams, error: Error): boolean {
    if (this.state !== "graceful-shutdown" && this.state !== "closed") return false;
    if (this.child !== child && this.state !== "closed") return false;
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
  }

  private rejectPending(id: number, pending: PendingRequest, error: Error): void {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failPending(error: Error): void { for (const [id, pending] of this.pending) { this.pending.delete(id); if (pending.timer !== undefined) clearTimeout(pending.timer); pending.reject(error); } }
}

function isExactChildControlBrokerFacts(facts: ChildControlBrokerLaunchFacts): boolean {
  return CHILD_CONTROL_SOCKET_PATH.test(facts.socketPath) && LOWER_HEX_256.test(facts.capability);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
