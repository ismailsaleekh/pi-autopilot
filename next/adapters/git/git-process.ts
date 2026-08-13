import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export interface GitProcessOptions {
  readonly cwd: string;
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

export type GitProcessResult =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: Uint8Array;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
    }
  | { readonly kind: "unavailable" };

export const DEFAULT_GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

function appendBounded(
  chunks: Buffer[],
  used: number,
  incoming: Buffer,
  limit: number,
): { readonly used: number; readonly truncated: boolean } {
  if (used >= limit) {
    return Object.freeze({ used, truncated: incoming.byteLength > 0 });
  }
  const remaining = limit - used;
  const selected = incoming.byteLength <= remaining ? incoming : incoming.subarray(0, remaining);
  if (selected.byteLength > 0) {
    chunks.push(Buffer.from(selected));
  }
  return Object.freeze({
    used: used + selected.byteLength,
    truncated: selected.byteLength !== incoming.byteLength,
  });
}

function cleanEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ALLOW_PROTOCOL: "file",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    XDG_CONFIG_HOME: "/dev/null",
  };
  const temporaryDirectory = process.env["TMPDIR"];
  if (temporaryDirectory !== undefined) {
    environment["TMPDIR"] = temporaryDirectory;
  }
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) {
      environment[name] = value;
    }
  }
  return environment;
}

/** Runs an exact git argv without a shell and never exposes vendor stderr. */
export function runGit(
  arguments_: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  return new Promise((resolveResult) => {
    const limit = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT;
    let child;
    try {
      child = spawn("git", [
        "-c", "core.hooksPath=/dev/null",
        "-c", "credential.helper=",
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "protocol.file.allow=always",
        ...arguments_,
      ], {
        cwd: options.cwd,
        env: cleanEnvironment(options.extraEnvironment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolveResult(Object.freeze({ kind: "unavailable" }));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdoutChunks, stdoutBytes, chunk, limit);
      stdoutBytes = appended.used;
      stdoutTruncated = stdoutTruncated || appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const counted = Math.min(chunk.byteLength, Math.max(0, limit - stderrBytes));
      stderrBytes += counted;
      stderrTruncated = stderrTruncated || counted !== chunk.byteLength;
    });
    child.once("error", () => {
      resolveResult(Object.freeze({ kind: "unavailable" }));
    });
    child.once("close", (code, signal) => {
      resolveResult(Object.freeze({
        kind: "exited",
        code,
        signal,
        stdout: Uint8Array.from(Buffer.concat(stdoutChunks)),
        stdoutTruncated,
        stderrTruncated,
      }));
    });
  });
}
