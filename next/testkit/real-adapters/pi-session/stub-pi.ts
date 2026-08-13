import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

interface StubWrite {
  readonly atMilliseconds: number;
  readonly bytesBase64: string;
  readonly path: string;
}

interface StubSeal {
  readonly atMilliseconds: number;
  readonly markerPath: string;
  readonly root: string;
}

interface StubTerminal {
  readonly atMilliseconds: number;
  readonly code: number;
  readonly kind: "exit" | "hang" | "kill";
}

interface StubConfig {
  readonly seal: StubSeal | null;
  readonly terminal: StubTerminal;
  readonly writes: readonly StubWrite[];
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function forever(): Promise<void> {
  return new Promise(() => {
    const keepAlive = setInterval(() => {
      // Intentional test child hang.
    }, 10_000);
    process.once("exit", () => clearInterval(keepAlive));
  });
}

function parseConfig(input: string): StubConfig {
  const value: unknown = JSON.parse(input);
  if (typeof value !== "object" || value === null) {
    throw new Error("stub config is not an object");
  }
  return value as StubConfig;
}

async function authCheck(): Promise<void> {
  const provider = argument("--provider") ?? "unknown";
  const authType = argument("--stub-auth-type") ?? "oauth";
  process.stdout.write(`${JSON.stringify({ status: "ready", provider, authType })}\n`);
}

async function sessionRun(): Promise<void> {
  const sessionId = argument("--session-id");
  const sessionDirectory = argument("--session-dir");
  const configPath = argument("--stub-config");
  if (sessionId === null || sessionDirectory === null || configPath === null) {
    process.exitCode = 91;
    return;
  }
  const promptArgument = process.argv.find((value) => value.startsWith("@"));
  const prompt = promptArgument === undefined
    ? ""
    : await readFile(promptArgument.slice(1), "utf8");
  await mkdir(sessionDirectory, { recursive: true });
  const file = join(sessionDirectory, `2000-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2000-01-01T00:00:00.000Z",
    cwd: process.cwd(),
  })}\n${JSON.stringify({
    type: "message",
    id: "00000001",
    parentId: null,
    timestamp: "2000-01-01T00:00:00.001Z",
    message: { role: "user", content: prompt, timestamp: 946684800001 },
  })}\n`);

  const config = parseConfig(await readFile(configPath, "utf8"));
  const events: Array<
    | { readonly atMilliseconds: number; readonly kind: "write"; readonly value: StubWrite }
    | { readonly atMilliseconds: number; readonly kind: "seal"; readonly value: StubSeal }
  > = config.writes.map((value) => Object.freeze({
    atMilliseconds: value.atMilliseconds,
    kind: "write",
    value,
  }));
  if (config.seal !== null) {
    events.push(Object.freeze({
      atMilliseconds: config.seal.atMilliseconds,
      kind: "seal",
      value: config.seal,
    }));
  }
  events.sort((left, right) => left.atMilliseconds - right.atMilliseconds);
  let elapsed = 0;
  for (const event of events) {
    const delay = Math.max(0, event.atMilliseconds - elapsed);
    if (delay > 0) {
      await waitForDelay(delay);
    }
    elapsed = event.atMilliseconds;
    if (event.kind === "write") {
      await mkdir(dirname(event.value.path), { recursive: true });
      await writeFile(event.value.path, Buffer.from(event.value.bytesBase64, "base64"));
    } else {
      await mkdir(dirname(event.value.markerPath), { recursive: true });
      await writeFile(event.value.markerPath, `${event.value.root}\n`);
    }
  }
  const terminalDelay = Math.max(0, config.terminal.atMilliseconds - elapsed);
  if (terminalDelay > 0) {
    await waitForDelay(terminalDelay);
  }
  if (config.terminal.kind === "hang") {
    await forever();
  } else if (config.terminal.kind === "kill") {
    process.kill(process.pid, "SIGKILL");
    await forever();
  } else {
    process.exitCode = config.terminal.code;
  }
}

async function main(): Promise<void> {
  const authIndex = process.argv.indexOf("auth");
  if (authIndex >= 0 && process.argv[authIndex + 1] === "check") {
    await authCheck();
  } else {
    await sessionRun();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
