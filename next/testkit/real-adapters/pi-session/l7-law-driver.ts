import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProcessAdapter } from "../../../adapters/process/index.js";
import type { ProcessHandle } from "../../../adapters/process/index.js";
import {
  PI_ISOLATED_SETTINGS_TEXT,
  PiSessionAdapter,
  createPiCliSubscriptionRouteVerifier,
} from "../../../adapters/pi-session/index.js";
import type {
  PiSessionBindingResolver,
  PiSessionChildReference,
} from "../../../adapters/pi-session/index.js";
import { SystemClockAdapter } from "../../../adapters/clock/index.js";
import { SecretsAdapter } from "../../../adapters/secrets/index.js";
import type {
  LawDriver,
  LawFixture,
  LawFixtureResult,
  LawPortName,
} from "../../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import type { JsonValue } from "../../../authority/protocol/schema.js";
import type { LaunchChildSession } from "../../../ports/contracts/child.capsule.js";
import {
  nodeFileCaptureSink,
  nodeProcessGraceWaiter,
} from "../process/node-process-capabilities.js";
import { nodeClockWaiter } from "./node-clock-waiter.js";
import { NodeProbeDeadline } from "./node-probe-deadline.js";

const stubPiModule = fileURLToPath(new URL("./stub-pi.js", import.meta.url));
const REAL_TICK_MILLISECONDS = 250;
const STUB_EVENT_MILLISECONDS = 20;

interface NamedTree {
  readonly firstPath: string;
  readonly path: string;
  readonly root: string;
}

interface NamedWorkspace {
  readonly path: string;
  readonly root: string;
  readonly workspaceId: string;
}

interface ChildScriptRecord {
  readonly configPath: string;
  readonly markerPath: string;
  readonly sealedRoot: string | null;
  readonly workItemId: string;
  readonly workspace: NamedWorkspace;
}

interface ActiveChild {
  readonly childEpoch: string;
  readonly childId: string;
  readonly runId: string;
}

function hashText(domain: string, value: string): string {
  return `sha256:${createHash("sha256").update(domain).update("\u0000").update(value).digest("hex")}`;
}

function identifier(label: string): string {
  const normalized = label.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "fixture";
}

function jsonArtifactRef(root: string, path: string): JsonValue {
  return Object.freeze({ path, range: null, root });
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) {
    return false;
  }
  outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  };
  await visit(directory);
  return Object.freeze(output.sort());
}

function unknownField(input: unknown, name: string): unknown {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  try {
    return Reflect.get(input, name);
  } catch {
    return undefined;
  }
}

function textField(input: unknown, name: string): string | null {
  const value = unknownField(input, name);
  return typeof value === "string" ? value : null;
}

export class RealL7LawDriver implements LawDriver {
  readonly rootDirectory: string;
  private readonly processAdapter = new ProcessAdapter(
    nodeFileCaptureSink,
    nodeProcessGraceWaiter,
  );
  private readonly clock: SystemClockAdapter;
  private readonly piSession: PiSessionAdapter<ProcessHandle>;
  private readonly secrets: SecretsAdapter;
  private readonly trees = new Map<string, NamedTree>();
  private readonly workspaces = new Map<string, NamedWorkspace>();
  private readonly scripts = new Map<string, ChildScriptRecord>();
  private readonly scriptsByWorkspace = new Map<string, ChildScriptRecord>();
  private readonly publicValues: unknown[] = [];
  private readonly activeChildren = new Map<string, ActiveChild>();
  private readonly observedSessionFiles = new Set<string>();
  private readonly observedVerifiedRoutes = new Set<string>();
  private lawTick = 0;

  private constructor(rootDirectory: string, clock: SystemClockAdapter) {
    this.rootDirectory = rootDirectory;
    this.clock = clock;
    const resolver: PiSessionBindingResolver = Object.freeze({
      resolveLaunch: (intent: LaunchChildSession) => this.resolveLaunch(intent),
      observeSealedRoot: (child: PiSessionChildReference) => this.observeSealedRoot(child),
    });
    this.piSession = new PiSessionAdapter(this.processAdapter, resolver, {
      allowedRoutes: Object.freeze([Object.freeze({
        channel: "subscription",
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        thinking: "low",
      })]),
      routeVerifier: createPiCliSubscriptionRouteVerifier(
        this.processAdapter,
        new NodeProbeDeadline(),
      ),
      terminationGraceMilliseconds: 25,
    });
    this.secrets = new SecretsAdapter(Object.freeze({
      isActive: (childId: string, childEpoch: string) => this.piSession.isActive(childId, childEpoch),
    }));
  }

  public static async create(): Promise<RealL7LawDriver> {
    const rootDirectory = await mkdtemp(join(tmpdir(), "autopilot-l7-laws-"));
    await Promise.all([
      mkdir(join(rootDirectory, "agent"), { mode: 0o700, recursive: true }),
      mkdir(join(rootDirectory, "captures"), { recursive: true }),
      mkdir(join(rootDirectory, "configs"), { recursive: true }),
      mkdir(join(rootDirectory, "prompts"), { recursive: true }),
      mkdir(join(rootDirectory, "sessions"), { recursive: true }),
      mkdir(join(rootDirectory, "trees"), { recursive: true }),
      mkdir(join(rootDirectory, "workspaces"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(rootDirectory, "agent", "auth.json"), "{}\n", { mode: 0o600 }),
      writeFile(
        join(rootDirectory, "agent", "settings.json"),
        PI_ISOLATED_SETTINGS_TEXT,
        { mode: 0o600 },
      ),
    ]);
    const created = SystemClockAdapter.create({
      sourceId: "node-hrtime-real-law",
      tickMilliseconds: REAL_TICK_MILLISECONDS,
      waiter: nodeClockWaiter,
    });
    if (created.kind === "rejected") {
      await rm(rootDirectory, { force: true, recursive: true });
      throw new Error(created.diagnostic.code);
    }
    return new RealL7LawDriver(rootDirectory, created.clock);
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    if (request.kind === "tree") {
      if (request.files.length === 0) {
        return Object.freeze({ kind: "invalid", diagnostic: "tree fixture is empty" });
      }
      const directory = join(this.rootDirectory, "trees", identifier(request.name));
      await mkdir(directory, { recursive: true });
      const digestInput: string[] = [];
      for (const file of request.files) {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
        digestInput.push(`${file.path}:${Buffer.from(file.bytes).toString("hex")}`);
      }
      const root = hashText("real-law-tree", digestInput.sort().join("\n"));
      const firstPath = request.files[0]?.path;
      if (firstPath === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "tree fixture lacks a first path" });
      }
      this.trees.set(request.name, Object.freeze({ firstPath, path: directory, root }));
      const result: LawFixtureResult = Object.freeze({
        firstFile: jsonArtifactRef(root, firstPath),
        kind: "tree",
        manifest: jsonArtifactRef(root, firstPath),
        name: request.name,
        root,
      });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "workspace") {
      const tree = this.trees.get(request.treeName);
      if (tree === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "workspace tree fixture is absent" });
      }
      const workspaceId = `workspace-${identifier(request.name)}`;
      const path = join(this.rootDirectory, "workspaces", identifier(request.name));
      await cp(tree.path, path, { force: false, recursive: true });
      const workspace = Object.freeze({ path, root: tree.root, workspaceId });
      this.workspaces.set(request.name, workspace);
      const result: LawFixtureResult = Object.freeze({
        kind: "workspace",
        leaseId: `lease-${identifier(request.name)}`,
        name: request.name,
        root: tree.root,
        workspaceId,
      });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "child-script") {
      const workspace = this.workspaces.get(request.workspaceName);
      if (workspace === undefined) {
        return Object.freeze({ kind: "invalid", diagnostic: "child workspace fixture is absent" });
      }
      const name = identifier(request.name);
      const configPath = join(this.rootDirectory, "configs", `${name}.json`);
      const markerPath = join(workspace.path, ".autopilot-test", `${name}.sealed-root`);
      const sealedRoot = request.sealTick === null
        ? null
        : hashText("real-law-sealed-root", `${request.workItemId}:${request.workspaceName}`);
      const config = Object.freeze({
        writes: Object.freeze(request.writes.map((write) => Object.freeze({
          atMilliseconds: write.tick * STUB_EVENT_MILLISECONDS,
          bytesBase64: Buffer.from(write.bytes).toString("base64"),
          path: join(workspace.path, write.path),
        }))),
        seal: request.sealTick === null || sealedRoot === null
          ? null
          : Object.freeze({
              atMilliseconds: request.sealTick * STUB_EVENT_MILLISECONDS,
              markerPath,
              root: sealedRoot,
            }),
        terminal: Object.freeze({
          atMilliseconds: request.terminalTick * STUB_EVENT_MILLISECONDS,
          code: 0,
          kind: request.terminal,
        }),
      });
      await writeFile(configPath, `${JSON.stringify(config)}\n`);
      const record = Object.freeze({
        configPath,
        markerPath,
        sealedRoot,
        workItemId: request.workItemId,
        workspace,
      });
      this.scripts.set(request.workItemId, record);
      this.scriptsByWorkspace.set(workspace.workspaceId, record);
      const result: LawFixtureResult = Object.freeze({ kind: "child-script", name: request.name });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "secret") {
      const registered = this.secrets.register(request.handle, request.bytes);
      if (registered.kind === "rejected") {
        return Object.freeze({ kind: "invalid", diagnostic: registered.diagnostic.message });
      }
      const result: LawFixtureResult = Object.freeze({
        handle: registered.handle,
        kind: "secret",
        name: request.name,
      });
      this.publicValues.push(result);
      return result;
    }
    return Object.freeze({ kind: "invalid", diagnostic: `${request.kind} fixture is outside L7` });
  }

  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> {
    let result: unknown;
    if (port === "child") {
      result = await this.piSession.execute(intent);
      const physical = unknownField(result, "physical");
      const sessionFile = textField(physical, "sessionFile");
      if (sessionFile !== null) {
        this.observedSessionFiles.add(sessionFile);
      }
      const route = unknownField(physical, "route");
      if (textField(route, "kind") === "verified") {
        const provider = textField(route, "provider");
        const model = textField(route, "model");
        if (provider !== null && model !== null) {
          this.observedVerifiedRoutes.add(`${provider}/${model}`);
        }
      }
      const observation = unknownField(result, "observation");
      if (textField(observation, "kind") === "child-session-launched") {
        const value = unknownField(unknownField(observation, "result"), "value");
        const childId = textField(value, "childId");
        const childEpoch = textField(value, "childEpoch");
        const runId = textField(observation, "runId");
        if (childId !== null && childEpoch !== null && runId !== null) {
          this.activeChildren.set(childId, Object.freeze({ childEpoch, childId, runId }));
        }
      }
    } else if (port === "clock") {
      result = this.clock.execute(intent);
    } else if (port === "secrets") {
      result = this.secrets.execute(intent);
    } else {
      result = Object.freeze({ kind: "rejected", diagnostic: Object.freeze({
        code: "real-l7.unsupported-port",
        message: "port is outside the L7 real driver",
      }) });
    }
    this.publicValues.push(result);
    return result;
  }

  public async advance(ticks: number): Promise<void> {
    this.lawTick += ticks;
    const waited = await this.clock.waitUntil(this.lawTick);
    if (waited.kind === "retry") {
      throw new Error(waited.diagnostic.code);
    }
  }

  public async readArtifact(_reference: JsonValue): Promise<Uint8Array | null> {
    return null;
  }

  public async containsSecretBytes(bytes: Uint8Array): Promise<boolean> {
    if (bytes.byteLength === 0) {
      return false;
    }
    const serialized = Buffer.from(JSON.stringify(this.publicValues), "utf8");
    if (bytesContain(serialized, bytes)) {
      return true;
    }
    for (const path of await filesBelow(this.rootDirectory)) {
      const fileBytes = await readFile(path);
      if (bytesContain(fileBytes, bytes)) {
        return true;
      }
    }
    return false;
  }

  public sessionFileObservations(): readonly string[] {
    return Object.freeze([...this.observedSessionFiles].sort());
  }

  public verifiedRouteObservations(): readonly string[] {
    return Object.freeze([...this.observedVerifiedRoutes].sort());
  }

  public async dispose(): Promise<void> {
    for (const child of this.activeChildren.values()) {
      const fence = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId: child.childId }),
        kind: "fence-child-session",
        preconditions: Object.freeze({
          childEpoch: child.childEpoch,
          replacementEpoch: `${child.childEpoch}-disposed`,
        }),
        runId: child.runId,
      }));
      if (fence !== null) {
        await this.piSession.execute(fence);
      }
    }
    await waitForDelay(25);
    await rm(this.rootDirectory, { force: true, recursive: true });
  }

  private async resolveLaunch(intent: LaunchChildSession): Promise<unknown> {
    const script = this.scripts.get(intent.inputs.workItemId);
    if (script === undefined) {
      return null;
    }
    const promptFilePath = join(
      this.rootDirectory,
      "prompts",
      `${intent.actionId.slice("action:sha256:".length)}.md`,
    );
    await writeFile(promptFilePath, "Follow the bound test script and leave physical observations only.\n");
    return Object.freeze({
      captureDirectory: join(this.rootDirectory, "captures"),
      environment: Object.freeze({
        PI_CODING_AGENT_DIR: join(this.rootDirectory, "agent"),
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      }),
      extensionPaths: Object.freeze([]),
      maxStderrBytes: 64 * 1024,
      maxStdoutBytes: 64 * 1024,
      piCommand: Object.freeze({
        executable: process.execPath,
        prefixArguments: Object.freeze([stubPiModule, "--stub-config", script.configPath]),
      }),
      promptArtifactPath: intent.inputs.prompt.path,
      promptArtifactRoot: intent.inputs.prompt.root,
      promptFilePath,
      route: Object.freeze({
        channel: "subscription",
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        thinking: "low",
      }),
      runtimeRoot: intent.inputs.runtimeRoot,
      sessionDirectory: join(this.rootDirectory, "sessions"),
      toolNames: Object.freeze([]),
      workspaceId: intent.inputs.workspaceId,
      workspacePath: script.workspace.path,
      workspaceRoot: script.workspace.root,
    });
  }

  private async observeSealedRoot(child: PiSessionChildReference): Promise<unknown> {
    const script = this.scriptsByWorkspace.get(child.workspaceId);
    if (script === undefined || script.sealedRoot === null) {
      return null;
    }
    try {
      const value = (await readFile(script.markerPath, "utf8")).trim();
      return value === script.sealedRoot ? value : null;
    } catch {
      return null;
    }
  }
}
