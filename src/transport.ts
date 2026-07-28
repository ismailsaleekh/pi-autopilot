import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { CoreToHostFrame, HostToCoreFrame } from "./generated/index.ts";
import { validateCoreToHostFrame } from "./frame-validation.ts";
import { resolveCoreBinary } from "./resolve-core.ts";
import { resolveRunnerTransport } from "./resolve-runner.ts";

export interface CoreTransportOptions {
  binaryPath?: string;
  packageJsonPath?: string;
}

interface PendingRequest {
  resolve: (frame: CoreToHostFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class CoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

export class CoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreTimeoutError";
  }
}

export class CoreTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private stdout = "";
  private readonly pending = new Map<number, PendingRequest>();
  private diagnostics: string[] = [];
  private readonly options: CoreTransportOptions;

  constructor(options: CoreTransportOptions = {}) {
    this.options = options;
  }

  request<K extends HostToCoreFrame["kind"]>(
    kind: K,
    payload: Extract<HostToCoreFrame, { kind: K }>["payload"],
    timeoutMs?: number,
  ): Promise<CoreToHostFrame> {
    const id = this.nextId;
    this.nextId += 1;
    const frame = { v: 1, id, kind, payload } as Extract<HostToCoreFrame, { kind: K }>;
    return this.send(frame, timeoutMs);
  }

  send(frame: HostToCoreFrame, timeoutMs?: number): Promise<CoreToHostFrame> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensureChild();
      } catch (error) {
        reject(new CoreUnavailableError(errorMessage(error)));
        return;
      }
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(frame.id);
          reject(new CoreTimeoutError(`autopilot-core timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(frame.id, pending);
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) {
          this.pending.delete(frame.id);
          if (pending.timer !== undefined) {
            clearTimeout(pending.timer);
          }
          reject(new CoreUnavailableError(error.message));
        }
      });
    });
  }

  lastDiagnostics(): string {
    return this.diagnostics.join("\n");
  }

  hasLiveChild(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  close(): void {
    if (this.child !== undefined) {
      this.child.kill();
      this.child = undefined;
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.hasLiveChild() && this.child !== undefined) {
      return this.child;
    }
    const binary = this.options.binaryPath ?? resolveCoreBinary({ packageJsonPath: this.options.packageJsonPath });
    const runner = resolveRunnerTransport({ packageJsonPath: this.options.packageJsonPath });
    const child = spawn(binary, [], {
      stdio: "pipe",
      env: {
        ...process.env,
        AUTOPILOT_NODE_EXECUTABLE: runner.nodeExecutable,
        AUTOPILOT_AGENT_RUNNER_WRAPPER: runner.runnerWrapper,
      },
    });
    this.child = child;
    this.stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => this.noteDiagnostics(chunk));
    child.on("error", (error) => this.failPending(new CoreUnavailableError(error.message)));
    child.on("exit", (code, signal) => {
      const message = `autopilot-core exited code=${code ?? "null"} signal=${signal ?? "null"}; diagnostics=${this.lastDiagnostics()}`;
      this.child = undefined;
      this.failPending(new CoreUnavailableError(message));
    });
    return child;
  }

  private receive(chunk: string): void {
    this.stdout += chunk;
    while (true) {
      const index = this.stdout.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = this.stdout.slice(0, index);
      this.stdout = this.stdout.slice(index + 1);
      this.receiveLine(line);
    }
  }

  private receiveLine(line: string): void {
    let frame: CoreToHostFrame;
    try {
      frame = validateCoreToHostFrame(JSON.parse(line));
    } catch (error) {
      this.failPending(new CoreUnavailableError(`autopilot-core emitted malformed frame: ${errorMessage(error)}`));
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) {
      this.noteDiagnostics(`unmatched core frame id=${frame.id} kind=${frame.kind}`);
      return;
    }
    this.pending.delete(frame.id);
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    pending.resolve(frame);
  }

  private noteDiagnostics(chunk: string): void {
    this.diagnostics.push(chunk.trimEnd());
    if (this.diagnostics.length > 20) {
      this.diagnostics = this.diagnostics.slice(-20);
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
