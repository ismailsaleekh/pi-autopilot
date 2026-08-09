import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { CoreToHostFrame, HostToCoreFrame } from "./generated/index.ts";
import { validateCoreToHostFrame } from "./generated/frame-validation.ts";
import { HOST_ENV_DENY } from "./generated/host-runtime-tables.ts";
import { boundedDiagnostic, redactedEnv } from "./host-runtime.ts";
import { resolveCoreBinary, resolveRunnerTransport } from "./resolve-core.ts";

export interface CoreTransportOptions { binaryPath?: string; packageJsonPath?: string; }
/** Host/Core-only broker facts; never include these in model-visible frames or diagnostics. */
export interface ChildControlBrokerLaunchFacts { readonly socketPath: string; readonly capability: string; }
interface PendingRequest { resolve: (frame: CoreToHostFrame) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; }
export class CoreUnavailableError extends Error { constructor(message: string) { super(message); this.name = "CoreUnavailableError"; } }
export class CoreTimeoutError extends Error { constructor(message: string) { super(message); this.name = "CoreTimeoutError"; } }
export class CoreChildControlContractError extends CoreUnavailableError { constructor() { super("autopilot-core does not implement the required Host child-control broker launch facts; Core must authenticate broker socket/capability facts, issue them into fresh V5 runner specs, and configure RpcSpawnConfig child-control environment forwarding before this broker can launch Core."); this.name = "CoreChildControlContractError"; } }

export class CoreTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private stdout = "";
  private readonly pending = new Map<number, PendingRequest>();
  private diagnostics: string[] = [];
  private readonly options: CoreTransportOptions;
  private childControlBroker: ChildControlBrokerLaunchFacts | undefined;

  constructor(options: CoreTransportOptions = {}) {
    this.options = options;
  }

  request<K extends HostToCoreFrame["kind"]>(kind: K, payload: Extract<HostToCoreFrame, { kind: K }>["payload"], timeoutMs?: number): Promise<CoreToHostFrame> {
    return this.send({ v: 1, id: this.nextId++, kind, payload } as Extract<HostToCoreFrame, { kind: K }>, timeoutMs);
  }

  send(frame: HostToCoreFrame, timeoutMs?: number): Promise<CoreToHostFrame> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.ensureChild(); } catch (error) { reject(new CoreUnavailableError(errorMessage(error))); return; }
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs !== undefined) pending.timer = setTimeout(() => { this.pending.delete(frame.id); reject(new CoreTimeoutError(`autopilot-core timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(frame.id, pending);
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) { this.pending.delete(frame.id); if (pending.timer !== undefined) clearTimeout(pending.timer); reject(new CoreUnavailableError(error.message)); }
      });
    });
  }

  /**
   * Called by activation before the first Core request. Current Core source at
   * this wave has no matching RunnerTransportFacts/RpcSpawnConfig handshake,
   * so ensureChild fails loud rather than exporting a secret Core ignores.
   */
  bindChildControlBroker(facts: ChildControlBrokerLaunchFacts): void {
    if (!facts.socketPath.startsWith("/tmp/.pi-ap/") || !/^[a-f0-9]{64}$/u.test(facts.capability)) {
      throw new CoreChildControlContractError();
    }
    if (this.hasLiveChild()) throw new CoreChildControlContractError();
    if (this.childControlBroker !== undefined && (this.childControlBroker.socketPath !== facts.socketPath || this.childControlBroker.capability !== facts.capability)) {
      throw new CoreChildControlContractError();
    }
    this.childControlBroker = facts;
  }

  lastDiagnostics(): string { return this.diagnostics.join("\n"); }
  hasLiveChild(): boolean { return this.child !== undefined && this.child.exitCode === null && !this.child.killed; }
  close(): void { if (this.child !== undefined) { this.child.kill(); this.child = undefined; } }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.hasLiveChild() && this.child !== undefined) return this.child;
    if (this.childControlBroker !== undefined) throw new CoreChildControlContractError();
    const runner = resolveRunnerTransport({ packageJsonPath: this.options.packageJsonPath });
    const child = spawn(this.options.binaryPath ?? resolveCoreBinary({ packageJsonPath: this.options.packageJsonPath }), [], {
      stdio: "pipe",
      env: redactedEnv(HOST_ENV_DENY, {
        AUTOPILOT_NODE_EXECUTABLE: runner.nodeExecutable,
        AUTOPILOT_AGENT_RUNNER_WRAPPER: runner.runnerWrapper,
        AUTOPILOT_CHILD_ADDON_PATH: runner.childAddon,
      }),
    });
    this.child = child;
    this.stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => this.noteDiagnostics(chunk));
    child.on("error", (error) => this.failPending(new CoreUnavailableError(error.message)));
    child.on("exit", (code, signal) => { this.child = undefined; this.failPending(new CoreUnavailableError(`autopilot-core exited code=${code ?? "null"} signal=${signal ?? "null"}; diagnostics=${this.lastDiagnostics()}`)); });
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

  private noteDiagnostics(chunk: string): void { this.diagnostics.push(boundedDiagnostic(chunk)); if (this.diagnostics.length > 20) this.diagnostics = this.diagnostics.slice(-20); }
  private failPending(error: Error): void { for (const [id, pending] of this.pending) { this.pending.delete(id); if (pending.timer !== undefined) clearTimeout(pending.timer); pending.reject(error); } }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
