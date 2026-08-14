import { lstat, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  PiProbeDeadline,
  PiProbeDeadlineResult,
  PiProcessExecutor,
  PiProcessObserveResult,
  PiRouteGuardObservation,
  PiRouteVerifier,
  PiRouteVerificationRequest,
  PiSubscriptionRoute,
} from "./types.js";

const MAX_AGENT_DIRECTORY_ENTRIES = 4;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_PROBE_BYTES = 8 * 1024;
const DEFAULT_PROBE_TIMEOUT_MILLISECONDS = 15_000;
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "PI_CACHE_RETENTION",
  "PI_CODING_AGENT_DIR",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

export const PI_ISOLATED_SETTINGS_TEXT = `{
  "compaction": {
    "enabled": false
  },
  "defaultProjectTrust": "never",
  "enableInstallTelemetry": false,
  "retry": {
    "enabled": false,
    "provider": {
      "maxRetries": 0
    }
  }
}\n`;

function refused(route: PiSubscriptionRoute, code: string): PiRouteGuardObservation {
  return Object.freeze({ code, kind: "refused", model: route.model, provider: route.provider });
}

function exactReadyBytes(provider: string): readonly Buffer[] {
  const expected = Buffer.from(`{"status":"ready","provider":"${provider}","authType":"oauth"}`, "utf8");
  return Object.freeze([
    expected,
    Buffer.concat([expected, Buffer.from("\n")]),
    Buffer.concat([expected, Buffer.from("\r\n")]),
  ]);
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

function safeCapturePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
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

function validEnvironment(environment: Readonly<Record<string, string>>): string | null {
  const normalized = new Set<string>();
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (normalized.has(upper) || !ALLOWED_ENVIRONMENT_KEYS.has(upper)) {
      return "pi-route.environment-key";
    }
    normalized.add(upper);
  }
  const agentDirectory = environment["PI_CODING_AGENT_DIR"];
  if (agentDirectory === undefined || !isAbsolute(agentDirectory)) {
    return "pi-route.agent-directory";
  }
  if (environment["PI_SKIP_VERSION_CHECK"] !== "1" || environment["PI_TELEMETRY"] !== "0") {
    return "pi-route.startup-network-policy";
  }
  return null;
}

async function validateAgentDirectory(
  route: PiSubscriptionRoute,
  environment: Readonly<Record<string, string>>,
): Promise<PiRouteGuardObservation | null> {
  const directory = environment["PI_CODING_AGENT_DIR"];
  if (directory === undefined) {
    return refused(route, "pi-route.agent-directory");
  }
  const names: string[] = [];
  try {
    const directoryMetadata = await lstat(directory);
    if (
      !directoryMetadata.isDirectory()
      || directoryMetadata.isSymbolicLink()
      || (process.platform !== "win32" && (directoryMetadata.mode & 0o077) !== 0)
    ) {
      return refused(route, "pi-route.agent-directory-permissions");
    }
    const entries = await opendir(directory);
    for await (const entry of entries) {
      names.push(entry.name);
      if (names.length > MAX_AGENT_DIRECTORY_ENTRIES) {
        return refused(route, "pi-route.agent-directory-bound");
      }
    }
    names.sort();
    if (names.length !== 2 || names[0] !== "auth.json" || names[1] !== "settings.json") {
      return refused(route, "pi-route.agent-directory-shape");
    }
    const authPath = join(directory, "auth.json");
    const settingsPath = join(directory, "settings.json");
    const [authMetadata, settingsMetadata] = await Promise.all([
      lstat(authPath),
      lstat(settingsPath),
    ]);
    if (
      !authMetadata.isFile()
      || authMetadata.isSymbolicLink()
      || authMetadata.size < 1
      || authMetadata.size > MAX_AUTH_FILE_BYTES
      || !settingsMetadata.isFile()
      || settingsMetadata.isSymbolicLink()
      || settingsMetadata.size !== Buffer.byteLength(PI_ISOLATED_SETTINGS_TEXT)
    ) {
      return refused(route, "pi-route.agent-directory-content");
    }
    if (
      process.platform !== "win32"
      && ((authMetadata.mode & 0o077) !== 0 || (settingsMetadata.mode & 0o077) !== 0)
    ) {
      return refused(route, "pi-route.agent-directory-permissions");
    }
    const settingsBytes = await readFile(settingsPath);
    if (!settingsBytes.equals(Buffer.from(PI_ISOLATED_SETTINGS_TEXT, "utf8"))) {
      return refused(route, "pi-route.agent-directory-content");
    }
    return null;
  } catch (error: unknown) {
    return refused(route, `pi-route.agent-directory-${systemCode(error)}`);
  }
}

export function createPiCliSubscriptionRouteVerifier<Handle>(
  processes: PiProcessExecutor<Handle>,
  deadline: PiProbeDeadline,
  options?: Readonly<{ readonly probeTimeoutMilliseconds?: number }>,
): PiRouteVerifier {
  const configuredTimeout = options?.probeTimeoutMilliseconds ?? DEFAULT_PROBE_TIMEOUT_MILLISECONDS;
  const probeTimeoutMilliseconds = Number.isSafeInteger(configuredTimeout)
    && configuredTimeout >= 1
    && configuredTimeout <= 60_000
    ? configuredTimeout
    : DEFAULT_PROBE_TIMEOUT_MILLISECONDS;

  return Object.freeze({
    async verify(request: PiRouteVerificationRequest): Promise<PiRouteGuardObservation> {
      const environmentFault = validEnvironment(request.environment);
      if (environmentFault !== null) {
        return refused(request.route, environmentFault);
      }
      const directoryFault = await validateAgentDirectory(request.route, request.environment);
      if (directoryFault !== null) {
        return directoryFault;
      }
      const started = await processes.start(Object.freeze({
        arguments: Object.freeze([
          ...request.command.prefixArguments,
          "auth",
          "check",
          "--provider",
          request.route.provider,
          "--model",
          request.route.model,
          "--json",
          "--no-refresh",
        ]),
        captureDirectory: request.captureDirectory,
        captureId: `${safeCapturePart(request.captureId)}-${safeCapturePart(request.route.provider)}-${safeCapturePart(request.route.model)}-auth`,
        cwd: request.cwd,
        environment: request.environment,
        executable: request.command.executable,
        maxStderrBytes: MAX_PROBE_BYTES,
        maxStdoutBytes: MAX_PROBE_BYTES,
      }));
      if (started.kind === "rejected") {
        return refused(request.route, "pi-route.probe-spawn");
      }

      let completion: PiProbeDeadlineResult<PiProcessObserveResult>;
      try {
        completion = await deadline.race(
          processes.waitForExit(started.handle),
          probeTimeoutMilliseconds,
        );
      } catch {
        await processes.terminate(started.handle, { graceMilliseconds: 0 });
        return refused(request.route, "pi-route.probe-deadline-unavailable");
      }
      if (completion.kind === "time-bound") {
        await processes.terminate(started.handle, { graceMilliseconds: 0 });
        return refused(request.route, "pi-route.probe-time-bound");
      }
      const completed: PiProcessObserveResult = completion.value;
      if (completed.kind === "observed" && completed.observation.processGroup.kind !== "absent") {
        await processes.terminate(started.handle, { graceMilliseconds: 0 });
        return refused(request.route, "pi-route.probe-group-present");
      }
      if (
        completed.kind === "rejected"
        || completed.observation.lifecycle.kind !== "exited"
        || completed.observation.lifecycle.code !== 0
        || completed.observation.stdout.truncated
        || completed.observation.stderr.truncated
      ) {
        return refused(request.route, "pi-route.auth-not-ready");
      }
      const output = await processes.collectOutput(started.handle, Object.freeze({
        direction: "head",
        maxBytes: MAX_PROBE_BYTES,
        stream: "stdout",
      }));
      if (output.kind === "rejected" || output.observation.truncated) {
        return refused(request.route, "pi-route.probe-output-bound");
      }
      const actual = Buffer.from(output.observation.bytes);
      if (!exactReadyBytes(request.route.provider).some((candidate) => equalBytes(candidate, actual))) {
        return refused(request.route, "pi-route.auth-not-oauth");
      }
      const postProbeDirectoryFault = await validateAgentDirectory(request.route, request.environment);
      if (postProbeDirectoryFault !== null) {
        return refused(request.route, "pi-route.agent-directory-drift");
      }
      return Object.freeze({
        authType: "oauth",
        kind: "verified",
        model: request.route.model,
        provider: request.route.provider,
      });
    },
  });
}
