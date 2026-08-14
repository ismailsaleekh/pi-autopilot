import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { arrayOf, canonicalEncodeUnknown, defineCapsule, literal, natural, nullable, object, text, union } from "../../../authority/protocol/schema.js";
import type { Infer } from "../../../authority/protocol/schema.js";

const stubConfigSchema = object({
  seal: nullable(object({ atMilliseconds: natural(), markerPath: text("non-empty"), root: text("non-empty") })),
  terminal: object({ atMilliseconds: natural(), code: natural(), kind: union([literal("exit"), literal("hang"), literal("kill")]) }),
  writes: arrayOf(object({ atMilliseconds: natural(), bytesBase64: text("plain"), path: text("non-empty") })),
});
const stubConfigCapsule = defineCapsule("RealPiStubConfig", stubConfigSchema);
type StubConfig = Infer<typeof stubConfigSchema>;
type StubWrite = StubConfig["writes"][number];
type StubSeal = Exclude<StubConfig["seal"], null>;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function forever(): Promise<void> {
  return new Promise(() => {
    const keepAlive = setInterval(() => undefined, 10_000);
    process.once("exit", () => clearInterval(keepAlive));
  });
}

function parseConfig(input: Uint8Array): StubConfig {
  const decoded = stubConfigCapsule.decodeCanonical(input);
  if (decoded.kind !== "ok") throw new Error(decoded.error.diagnostic);
  return decoded.value;
}

async function authCheck(): Promise<void> {
  const provider = argument("--provider") ?? "unknown";
  const authType = argument("--stub-auth-type") ?? "oauth";
  process.stdout.write(`{"status":"ready","provider":"${provider}","authType":"${authType}"}\n`);
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
  const prompt = promptArgument === undefined ? "" : await readFile(promptArgument.slice(1), "utf8");
  await mkdir(sessionDirectory, { recursive: true });
  const file = join(sessionDirectory, `2000-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const session = canonicalEncodeUnknown(Object.freeze({ cwd: process.cwd(), id: sessionId, timestamp: "2000-01-01T00:00:00.000Z", type: "session", version: 3 }));
  const message = canonicalEncodeUnknown(Object.freeze({ id: "00000001", message: Object.freeze({ content: prompt, role: "user", timestamp: 946684800001 }), parentId: null, timestamp: "2000-01-01T00:00:00.001Z", type: "message" }));
  await writeFile(file, Buffer.concat([Buffer.from(session), Buffer.from("\n"), Buffer.from(message), Buffer.from("\n")]));

  const config = parseConfig(await readFile(configPath));
  const events: Array<
    | { readonly atMilliseconds: number; readonly kind: "write"; readonly value: StubWrite }
    | { readonly atMilliseconds: number; readonly kind: "seal"; readonly value: StubSeal }
  > = config.writes.map((value) => Object.freeze({ atMilliseconds: value.atMilliseconds, kind: "write", value }));
  if (config.seal !== null) events.push(Object.freeze({ atMilliseconds: config.seal.atMilliseconds, kind: "seal", value: config.seal }));
  events.sort((left, right) => left.atMilliseconds - right.atMilliseconds);
  let elapsed = 0;
  for (const event of events) {
    const delay = Math.max(0, event.atMilliseconds - elapsed);
    if (delay > 0) await waitForDelay(delay);
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
  if (terminalDelay > 0) await waitForDelay(terminalDelay);
  if (config.terminal.kind === "hang") await forever();
  else if (config.terminal.kind === "kill") {
    process.kill(process.pid, "SIGKILL");
    await forever();
  } else process.exitCode = config.terminal.code;
}

async function main(): Promise<void> {
  const authIndex = process.argv.indexOf("auth");
  if (authIndex >= 0 && process.argv[authIndex + 1] === "check") await authCheck();
  else await sessionRun();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
