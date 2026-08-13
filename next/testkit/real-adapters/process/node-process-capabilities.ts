import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import type {
  PhysicalDiagnostic,
  ProcessCaptureAcquireResult,
  ProcessCaptureSink,
  ProcessGraceWaiter,
} from "../../../adapters/process/index.js";

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

async function closeHandle(handle: FileHandle | null): Promise<void> {
  if (handle === null) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Acquisition already failed; no raw close error crosses the capability.
  }
}

const activeCaptureIdentities = new Set<string>();

async function acquireFileCaptures(
  request: Readonly<{ readonly captureDirectory: string; readonly captureId: string }>,
): Promise<ProcessCaptureAcquireResult> {
  const identity = `${request.captureDirectory}\u0000${request.captureId}`;
  if (activeCaptureIdentities.has(identity)) {
    return Object.freeze({
      diagnostic: diagnostic("capture-acquire-in-use", "process capture identity already has an active owner"),
      kind: "rejected",
    });
  }
  activeCaptureIdentities.add(identity);
  const stdoutPath = join(request.captureDirectory, `${request.captureId}.stdout`);
  const stderrPath = join(request.captureDirectory, `${request.captureId}.stderr`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = constants.O_CREAT | constants.O_WRONLY | noFollow;
  let stdoutHandle: FileHandle | null = null;
  let stderrHandle: FileHandle | null = null;
  try {
    stdoutHandle = await open(stdoutPath, flags, 0o600);
    stderrHandle = await open(stderrPath, flags, 0o600);
    const [stdoutMetadata, stderrMetadata] = await Promise.all([
      stdoutHandle.stat(),
      stderrHandle.stat(),
    ]);
    if (!stdoutMetadata.isFile() || !stderrMetadata.isFile()) {
      throw new Error("capture targets must be regular files");
    }
    await Promise.all([
      stdoutHandle.truncate(0),
      stderrHandle.truncate(0),
      stdoutHandle.chmod(0o600),
      stderrHandle.chmod(0o600),
    ]);
    const stdout = stdoutHandle.createWriteStream({ autoClose: true });
    const stderr = stderrHandle.createWriteStream({ autoClose: true });
    stdoutHandle = null;
    stderrHandle = null;
    void Promise.allSettled([finished(stdout), finished(stderr)]).then(() => {
      activeCaptureIdentities.delete(identity);
    });
    return Object.freeze({
      kind: "acquired",
      stderr: Object.freeze({ path: stderrPath, stream: stderr }),
      stdout: Object.freeze({ path: stdoutPath, stream: stdout }),
    });
  } catch (error: unknown) {
    activeCaptureIdentities.delete(identity);
    await Promise.all([closeHandle(stdoutHandle), closeHandle(stderrHandle)]);
    return Object.freeze({
      diagnostic: diagnostic(
        `capture-acquire-${systemCode(error)}`,
        "bounded process output captures could not be acquired",
      ),
      kind: "rejected",
    });
  }
}

export const nodeFileCaptureSink: ProcessCaptureSink = Object.freeze({
  acquire: acquireFileCaptures,
});

export const nodeProcessGraceWaiter: ProcessGraceWaiter = Object.freeze({
  waitForGrace: async (milliseconds: number): Promise<void> => {
    await waitForDelay(milliseconds);
  },
});
