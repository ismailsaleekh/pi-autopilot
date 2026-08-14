import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as waitForDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { artifactPathSchema, artifactRefSchema, kindIdSchema } from "../../../authority/protocol/identifiers.js";
import type { ArtifactRef } from "../../../authority/protocol/identifiers.js";
import { canonicalEncodeUnknown, defineCapsule } from "../../../authority/protocol/schema.js";
import type { JsonValue } from "../../../authority/protocol/schema.js";
import { childIntentCapsule } from "../../../ports/contracts/child.capsule.js";
import type { LaunchChildSession, VerifyPiRoute } from "../../../ports/contracts/child.capsule.js";
import { workspaceIntentCapsule } from "../../../ports/contracts/workspace.capsule.js";
import type { LawDriver, LawFixture, LawFixtureResult, LawPortName } from "../../../ports/laws/contract-vector.js";
import { bindLawIntent } from "../../../ports/laws/contract-vector.js";
import { inertJsonFromUnknown } from "../../../runtime/boundary-codecs/index.js";
import { canonicalArtifactInstaller, openCas } from "../../../storage/cas/index.js";
import type { CanonicalArtifactInstaller } from "../../../storage/cas/index.js";
import { SystemClockAdapter } from "../../../adapters/clock/index.js";
import { ProcessAdapter } from "../../../adapters/process/index.js";
import type { ProcessHandle } from "../../../adapters/process/index.js";
import { SecretsAdapter } from "../../../adapters/secrets/index.js";
import { PI_ISOLATED_SETTINGS_TEXT, PiSessionAdapter, createPiCliSubscriptionRouteVerifier } from "../../../adapters/pi-session/index.js";
import type { PiSessionBindingResolver } from "../../../adapters/pi-session/index.js";
import { nodeFileCaptureSink, nodeProcessGraceWaiter, nodeProcessIdentityInspector } from "../process/node-process-capabilities.js";
import { NodeProbeDeadline } from "./node-probe-deadline.js";

const stubPiModule = fileURLToPath(new URL("./stub-pi.js", import.meta.url));
const STUB_EVENT_MILLISECONDS = 20;
const pathCapsule = defineCapsule("RealL7ArtifactPath", artifactPathSchema);
const kindCapsule = defineCapsule("RealL7ArtifactKind", kindIdSchema);
const referenceCapsule = defineCapsule("RealL7ArtifactReference", artifactRefSchema);

interface NamedTree {
  readonly firstFile: ArtifactRef;
  readonly manifest: ArtifactRef;
  readonly path: string;
  readonly root: string;
}
interface NamedWorkspace {
  readonly leaseId: string;
  readonly path: string;
  readonly root: string;
  readonly workspaceCapability: string;
  readonly workspaceId: string;
}
interface ChildScriptRecord {
  readonly configPath: string;
  readonly workItemId: string;
  readonly workspace: NamedWorkspace;
}
interface ActiveChild {
  readonly childEpoch: string;
  readonly childId: string;
  readonly processDescriptor: JsonValue;
  readonly runId: string;
}
interface ClockState { value: bigint }

function identifier(label: string): string {
  const normalized = label.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "fixture";
}
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) if (haystack[start + offset] !== needle[offset]) continue outer;
    return true;
  }
  return false;
}
async function filesBelow(directory: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(directory);
  return Object.freeze(output.sort());
}
function field(input: unknown, name: string): unknown {
  try { return typeof input === "object" && input !== null ? Reflect.get(input, name) : undefined; } catch { return undefined; }
}

/** Real child/clock/secrets driver using production adapters, OS processes, and canonical CAS. */
export class RealL7LawDriver implements LawDriver {
  public readonly rootDirectory: string;
  private readonly artifacts: CanonicalArtifactInstaller;
  private readonly processAdapter: ProcessAdapter;
  private readonly clock: SystemClockAdapter;
  private readonly clockState: ClockState;
  private piSession: PiSessionAdapter<ProcessHandle>;
  private readonly secrets: SecretsAdapter;
  private readonly defaultConfigPath: string;
  private readonly trees = new Map<string, NamedTree>();
  private readonly workspaces = new Map<string, NamedWorkspace>();
  private readonly scripts = new Map<string, ChildScriptRecord>();
  private readonly activeChildren = new Map<string, ActiveChild>();
  private readonly publicValues: unknown[] = [];
  private fixtureSequence = 0;

  private constructor(rootDirectory: string, artifacts: CanonicalArtifactInstaller, clock: SystemClockAdapter, clockState: ClockState, defaultConfigPath: string) {
    this.rootDirectory = rootDirectory;
    this.artifacts = artifacts;
    this.clock = clock;
    this.clockState = clockState;
    this.defaultConfigPath = defaultConfigPath;
    this.processAdapter = new ProcessAdapter(nodeFileCaptureSink, nodeProcessGraceWaiter, nodeProcessIdentityInspector);
    this.piSession = this.createPiSessionAdapter();
    this.secrets = new SecretsAdapter(Object.freeze({
      isActive: (childId: string, childEpoch: string, processDescriptor: ArtifactRef, runId: string) => this.piSession.isActive(processDescriptor, childId, childEpoch, runId),
    }));
  }

  public static async create(): Promise<RealL7LawDriver> {
    const root = await mkdtemp(join(tmpdir(), "autopilot-l7-laws-"));
    const directories = ["agent", "captures", "configs", "prompts", "probe", "sessions", "trees", "workspaces"];
    await Promise.all(directories.map((name) => mkdir(join(root, name), { mode: 0o700, recursive: true })));
    await Promise.all([
      writeFile(join(root, "agent", "auth.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(root, "agent", "settings.json"), PI_ISOLATED_SETTINGS_TEXT, { mode: 0o600 }),
    ]);
    const defaultConfigPath = join(root, "configs", "default.json");
    await writeFile(defaultConfigPath, canonicalEncodeUnknown(Object.freeze({ seal: null, terminal: Object.freeze({ atMilliseconds: 0, code: 0, kind: "exit" }), writes: Object.freeze([]) })));
    const opened = await openCas(join(root, "cas"));
    if (opened.kind !== "opened") {
      await rm(root, { force: true, recursive: true });
      throw new Error(opened.error.message);
    }
    const state: ClockState = { value: 0n };
    const created = SystemClockAdapter.create(Object.freeze({
      monotonicNow: () => state.value,
      sourceId: "real-l7-law-clock",
      tickNanoseconds: 1n,
      waiter: null,
      maxWaitSliceMilliseconds: 10,
    }));
    if (created.kind !== "created") {
      await rm(root, { force: true, recursive: true });
      throw new Error(created.diagnostic.message);
    }
    return new RealL7LawDriver(root, canonicalArtifactInstaller(opened.store), created.clock, state, defaultConfigPath);
  }

  public async fixture(request: LawFixture): Promise<LawFixtureResult> {
    this.fixtureSequence += 1;
    if (request.kind === "tree") {
      if (request.files.length === 0) return Object.freeze({ kind: "invalid", diagnostic: "tree fixture is empty" });
      const directory = join(this.rootDirectory, "trees", `${identifier(request.name)}-${String(this.fixtureSequence)}`);
      await mkdir(directory, { recursive: true });
      for (const file of request.files) {
        const path = join(directory, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      const installedTree = await this.artifacts.installTree(Object.freeze(request.files.map((file) => Object.freeze({ bytes: file.bytes, kind: "file", mode: 0o644, path: file.path }))));
      const manifest = await this.installArtifact(`law/l7-manifest-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ files: request.files.map((file) => file.path) })));
      const first = request.files[0];
      const firstFile = first === undefined ? null : await this.installArtifact(`law/l7-first-${String(this.fixtureSequence)}.bin`, first.bytes);
      if (installedTree.kind !== "installed" || manifest === null || firstFile === null) return Object.freeze({ kind: "invalid", diagnostic: "tree fixture CAS installation failed" });
      const tree: NamedTree = Object.freeze({ firstFile, manifest, path: directory, root: installedTree.root });
      this.trees.set(request.name, tree);
      const result: LawFixtureResult = Object.freeze({ kind: "tree", name: request.name, root: tree.root, manifest, firstFile });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "workspace") {
      const tree = this.trees.get(request.treeName);
      const template = workspaceIntentCapsule.arbitrary.validForKind("allocate-attempt-directory", 1000 + this.fixtureSequence);
      if (tree === undefined || template.kind !== "allocate-attempt-directory") return Object.freeze({ kind: "invalid", diagnostic: "workspace tree fixture is absent" });
      const path = join(this.rootDirectory, "workspaces", `${identifier(request.name)}-${String(this.fixtureSequence)}`);
      await cp(tree.path, path, { force: false, recursive: true });
      const workspace: NamedWorkspace = Object.freeze({
        leaseId: template.preconditions.leaseId,
        path,
        root: tree.root,
        workspaceCapability: template.inputs.workspaceCapability,
        workspaceId: template.inputs.workspaceId,
      });
      this.workspaces.set(request.name, workspace);
      const result: LawFixtureResult = Object.freeze({ kind: "workspace", name: request.name, workspaceId: workspace.workspaceId, workspaceCapability: workspace.workspaceCapability, root: workspace.root, leaseId: workspace.leaseId });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "child-script") {
      const workspace = this.workspaces.get(request.workspaceName);
      if (workspace === undefined) return Object.freeze({ kind: "invalid", diagnostic: "child workspace fixture is absent" });
      const configPath = join(this.rootDirectory, "configs", `${identifier(request.name)}-${String(this.fixtureSequence)}.json`);
      const writes = request.writes.map((write) => Object.freeze({ atMilliseconds: Number(BigInt(write.tick)) * STUB_EVENT_MILLISECONDS, bytesBase64: Buffer.from(write.bytes).toString("base64"), path: join(workspace.path, ...write.path.split("/")) }));
      const terminalTick = Number(BigInt(request.terminalTick));
      const config = Object.freeze({ seal: null, terminal: Object.freeze({ atMilliseconds: terminalTick * STUB_EVENT_MILLISECONDS, code: 0, kind: request.terminal }), writes: Object.freeze(writes) });
      await writeFile(configPath, canonicalEncodeUnknown(config));
      this.scripts.set(request.workItemId, Object.freeze({ configPath, workItemId: request.workItemId, workspace }));
      const result: LawFixtureResult = Object.freeze({ kind: "child-script", name: request.name });
      this.publicValues.push(result);
      return result;
    }
    if (request.kind === "secret") {
      const registered = this.secrets.register(request.handle, request.bytes);
      return registered.kind === "registered" ? Object.freeze({ kind: "secret", name: request.name, handle: registered.handle }) : Object.freeze({ kind: "invalid", diagnostic: registered.diagnostic.message });
    }
    if (request.kind === "clock") return Object.freeze({ kind: "clock", name: request.name, sourceDigest: this.clock.sourceDigest });
    if (request.kind === "active-child") return this.createActiveChild(request.name);
    if (request.kind === "root-list") {
      const reference = await this.installArtifact(`law/l7-root-list-${String(this.fixtureSequence)}.json`, canonicalEncodeUnknown(Object.freeze({ treeNames: request.treeNames })));
      return reference === null ? Object.freeze({ kind: "invalid", diagnostic: "root-list installation failed" }) : Object.freeze({ kind: "root-list", name: request.name, reference });
    }
    return Object.freeze({ kind: "invalid", diagnostic: `${request.kind} fixture is outside real L7` });
  }

  public async dispatch(port: LawPortName, intent: JsonValue): Promise<unknown> {
    let result: unknown;
    if (port === "child") {
      result = await this.piSession.execute(intent);
      const observation = field(result, "observation");
      if (field(observation, "kind") === "child-session-launched") {
        const value = field(field(observation, "result"), "value");
        const childId = field(value, "childId");
        const childEpoch = field(value, "childEpoch");
        const processDescriptor = field(value, "processDescriptor");
        const runId = field(observation, "runId");
        if (typeof childId === "string" && typeof childEpoch === "string" && typeof runId === "string" && processDescriptor !== null && processDescriptor !== undefined) {
          const normalized = inertJsonFromUnknown(processDescriptor);
          if (normalized.kind === "ok") this.activeChildren.set(childId, Object.freeze({ childEpoch, childId, processDescriptor: normalized.value, runId }));
        }
      }
    } else if (port === "clock") result = this.clock.execute(intent);
    else if (port === "secrets") result = await this.secrets.execute(intent);
    else result = Object.freeze({ kind: "rejected", diagnostic: Object.freeze({ code: "real-l7.unsupported-port", message: "port is outside real L7" }) });
    this.publicValues.push(result);
    return result;
  }

  public async advance(ticks: string): Promise<void> {
    if (!/^(0|[1-9][0-9]*)$/.test(ticks)) return;
    const value = BigInt(ticks);
    this.clockState.value += value;
    if (value > 0n && value <= 100n) await waitForDelay(Number(value) * STUB_EVENT_MILLISECONDS + 10);
  }

  public async readArtifact(reference: JsonValue): Promise<Uint8Array | null> {
    const decoded = referenceCapsule.decode(reference);
    if (decoded.kind !== "ok") return null;
    const length = Number(decoded.value.byteLength);
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const read = await this.artifacts.read(decoded.value, length);
    return read.kind === "read" ? read.bytes : null;
  }

  public async containsSecretBytes(bytes: Uint8Array): Promise<boolean> {
    if (bytes.byteLength === 0) return false;
    for (const value of this.publicValues) {
      const normalized = inertJsonFromUnknown(value);
      if (normalized.kind === "ok" && bytesContain(normalized.canonicalBytes, bytes)) return true;
    }
    for (const path of await filesBelow(this.rootDirectory)) if (bytesContain(await readFile(path), bytes)) return true;
    return false;
  }

  public restartChildAdapter(): void {
    this.piSession = this.createPiSessionAdapter();
  }

  public async dispose(): Promise<void> {
    for (const child of this.activeChildren.values()) {
      const fence = bindLawIntent("child", Object.freeze({
        inputs: Object.freeze({ childId: child.childId, processDescriptor: child.processDescriptor }),
        kind: "fence-child-session",
        preconditions: Object.freeze({ childEpoch: child.childEpoch, replacementEpoch: String(BigInt(child.childEpoch) + 1n) }),
        runId: child.runId,
      }));
      if (fence !== null) await this.piSession.execute(fence);
    }
    await waitForDelay(25);
    await rm(this.rootDirectory, { force: true, recursive: true });
  }

  private createPiSessionAdapter(): PiSessionAdapter<ProcessHandle> {
    const resolver: PiSessionBindingResolver = Object.freeze({ resolveLaunch: (intent: LaunchChildSession | VerifyPiRoute) => this.resolveLaunch(intent) });
    return new PiSessionAdapter(
      this.processAdapter,
      resolver,
      this.artifacts,
      createPiCliSubscriptionRouteVerifier(this.processAdapter, new NodeProbeDeadline()),
      25,
    );
  }

  private async createActiveChild(name: string): Promise<LawFixtureResult> {
    const tree = await this.fixture(Object.freeze({ kind: "tree", name: `${name}-tree`, files: Object.freeze([Object.freeze({ path: "prompt.md", bytes: Buffer.from("active child\n") })]) }));
    if (tree.kind !== "tree") return tree;
    const workspace = await this.fixture(Object.freeze({ kind: "workspace", name: `${name}-workspace`, treeName: tree.name }));
    if (workspace.kind !== "workspace") return workspace;
    const launchTemplate = childIntentCapsule.arbitrary.validForKind("launch-child-session", 2000 + this.fixtureSequence);
    const routeTemplate = childIntentCapsule.arbitrary.validForKind("verify-pi-route", 2100 + this.fixtureSequence);
    if (launchTemplate.kind !== "launch-child-session" || routeTemplate.kind !== "verify-pi-route") return Object.freeze({ kind: "invalid", diagnostic: "active child templates failed" });
    await this.fixture(Object.freeze({ kind: "child-script", name: `${name}-script`, workItemId: launchTemplate.inputs.workItemId, workspaceName: workspace.name, writes: Object.freeze([]), sealTick: null, terminal: "hang", terminalTick: "1" }));
    const route = Object.freeze({ ...routeTemplate.inputs.route, toolBundleAttestation: null });
    const verify = bindLawIntent("child", Object.freeze({ inputs: Object.freeze({ captureId: routeTemplate.inputs.captureId, route }), kind: "verify-pi-route", preconditions: routeTemplate.preconditions, runId: launchTemplate.runId }));
    const verified = await this.piSession.execute(verify);
    if (verified.kind !== "observation" || verified.observation.kind !== "pi-route-verified" || verified.observation.result.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "active child route verification failed" });
    const launch = bindLawIntent("child", Object.freeze({
      inputs: Object.freeze({ ...launchTemplate.inputs, memorySeed: Object.freeze({ initialPrompt: tree.manifest, kind: "initial" }), policyRoot: tree.root, route, runtimeRoot: tree.root, workspaceCapability: workspace.workspaceCapability, workspaceId: workspace.workspaceId }),
      kind: "launch-child-session",
      preconditions: Object.freeze({ ...launchTemplate.preconditions, expectedWorkspaceRoot: workspace.root, maxStderrBytes: "65536", maxStdoutBytes: "65536", routeObservation: tree.firstFile, routeObservationId: verified.observation.result.value.observationId }),
      runId: launchTemplate.runId,
    }));
    const launched = await this.piSession.execute(launch);
    if (launched.kind !== "observation" || launched.observation.kind !== "child-session-launched" || launched.observation.result.kind !== "ok") return Object.freeze({ kind: "invalid", diagnostic: "active child launch failed" });
    const value = launched.observation.result.value;
    const result: LawFixtureResult = Object.freeze({ kind: "active-child", name, childId: value.childId, childEpoch: value.childEpoch, runId: launched.observation.runId, processDescriptor: value.processDescriptor });
    this.activeChildren.set(value.childId, Object.freeze({ childEpoch: value.childEpoch, childId: value.childId, processDescriptor: value.processDescriptor, runId: launched.observation.runId }));
    return result;
  }

  private async resolveLaunch(intent: LaunchChildSession | VerifyPiRoute): Promise<unknown> {
    const script = intent.kind === "launch-child-session" ? this.scripts.get(intent.inputs.workItemId) : undefined;
    if (intent.kind === "launch-child-session" && script === undefined) return null;
    const promptFilePath = join(this.rootDirectory, "prompts", `${intent.actionId.slice(14)}.md`);
    if (intent.kind === "launch-child-session") {
      const prompt = intent.inputs.memorySeed.kind === "initial" ? intent.inputs.memorySeed.initialPrompt : intent.inputs.memorySeed.continuationPrompt;
      const length = Number(prompt.byteLength);
      const read = Number.isSafeInteger(length) && length >= 0 ? await this.artifacts.read(prompt, length) : Object.freeze({ kind: "error" });
      if (read.kind !== "read") return null;
      await writeFile(promptFilePath, read.bytes);
    } else {
      await writeFile(promptFilePath, new Uint8Array());
    }
    return Object.freeze({
      captureDirectory: join(this.rootDirectory, "captures"),
      environment: Object.freeze({
        HOME: this.rootDirectory,
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        PI_CODING_AGENT_DIR: join(this.rootDirectory, "agent"),
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      }),
      piCommand: Object.freeze({ executable: process.execPath, prefixArguments: Object.freeze([stubPiModule, "--stub-config", script?.configPath ?? this.defaultConfigPath]) }),
      promptFilePath,
      sessionDirectory: join(this.rootDirectory, "sessions"),
      workspacePath: script?.workspace.path ?? join(this.rootDirectory, "probe"),
    });
  }

  private async installArtifact(pathText: string, bytes: Uint8Array): Promise<ArtifactRef | null> {
    const path = pathCapsule.decode(pathText);
    const codec = kindCapsule.decode("codec:real-l7-artifact");
    const version = kindCapsule.decode("version:2");
    if (path.kind !== "ok" || codec.kind !== "ok" || version.kind !== "ok") return null;
    const installed = await this.artifacts.install(Object.freeze({ bytes, codec: codec.value, codecVersion: version.value, path: path.value }));
    return installed.kind === "installed" ? installed.reference : null;
  }
}
