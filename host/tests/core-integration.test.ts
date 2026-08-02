import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTOPILOT_COMMANDS, fixedServiceResolver, registerAutopilotCommands } from "../src/commands.ts";
import { CoreTransport } from "../src/transport.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORE_BINARY_NAME = process.platform === "win32" ? "autopilot-core.exe" : "autopilot-core";
const CORE_BINARY = join(PACKAGE_ROOT, "target", "release", CORE_BINARY_NAME);

const PLAN_ARGS = "main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md";

let activeEffects;

const VALID_COMMAND_ARGS = Object.freeze({
  "autopilot-plan": PLAN_ARGS,
  autopilot: "main",
  "autopilot-onboard": "make this task concrete",
  "autopilot-inject": "main",
  "autopilot-status": "",
  "autopilot-config": "show",
  "autopilot-handoff": "",
  "autopilot-close": "main",
  "autopilot-abort": "main",
});

test("registered Pi slash handlers reach the real compiled autopilot-core over stdio", { timeout: 30000 }, async () => {
  assertCoreBinaryPresent();

  const root = makeEvidenceRepo("autopilot-host-core-");
  const eventLog = join(root, "events.jsonl");
  const previousCwd = process.cwd();
  const previousEventLog = process.env.AUTOPILOT_CORE_EVENT_LOG;
  process.env.AUTOPILOT_CORE_EVENT_LOG = eventLog;
  process.chdir(root);

  const transport = new CoreTransport({ binaryPath: CORE_BINARY });
  const pi = registrationHarness();
  const backgroundTasks = fakeBackgroundTasks();
  registerAutopilotCommands(pi, fixedServiceResolver({ transport, backgroundTasks, operatorMessage: recordingOperatorMessage, statusEntry: recordingStatusEntry }));

  try {
    for (const command of AUTOPILOT_COMMANDS) {
      const effects = await dispatchRegistered(pi, command, VALID_COMMAND_ARGS[command]);
      assert.notEqual(effects.length, 0, `${command} produced no host effect`);
      assertNoUnknownCommand(command, effects);

      if (command === "autopilot-plan") {
        assertPlanningSpawn(effects, "autopilot-plan");
        assertPlanningManifestGrounded(root);
        assertAgentSpawnRecorded(eventLog, "planning-main-task-extractor-01");
      }
    }

    const rawArgs = "  keep  spacing --and-bytes=✓  ";
    const byteEffects = await dispatchRegistered(pi, "autopilot-status", rawArgs);
    const byteStatus = doneStatus(byteEffects, "autopilot-status byte identity");
    assert.match(byteStatus, /^rejection:seam\.operator-command\.v1:/u);
    assert.ok(
      byteStatus.includes(`actual=autopilot-status${rawArgs}`),
      `Core did not echo byte-identical raw command. status=${JSON.stringify(byteStatus)}`,
    );

    const invalid = await transport.request("command", commandPayload("not-a-real-autopilot-command main"), 5000);
    assert.equal(invalid.kind, "done");
    const invalidStatus = invalid.payload.status;
    assert.equal(typeof invalidStatus, "string");
    assert.match(invalidStatus, /^rejection:seam\.operator-command\.v1:/u);
    assert.match(invalidStatus, /unknown-command:not-a-real-autopilot-command/u);

    const afterInvalid = await dispatchRegistered(pi, "autopilot-status", "");
    assert.match(doneStatus(afterInvalid, "autopilot-status after invalid command"), /state:sequence=/u);
  } finally {
    transport.close();
    process.chdir(previousCwd);
    restoreEventLog(previousEventLog);
  }
});

test("planning rejects a bare directory with typed CONTEXT_GAP instead of fabricated evidence", { timeout: 30000 }, async () => {
  assertCoreBinaryPresent();

  const root = mkdtempSync(join(tmpdir(), "autopilot-host-core-bare-"));
  writeTaskPack(root, "set-host-bare");
  execFileSync("rm", ["-f", join(root, "CONTEXT.md")]);
  mkdirSync(join(root, "CONTEXT.md"));

  const eventLog = join(root, "events.jsonl");
  const previousCwd = process.cwd();
  const previousEventLog = process.env.AUTOPILOT_CORE_EVENT_LOG;
  process.env.AUTOPILOT_CORE_EVENT_LOG = eventLog;
  process.chdir(root);

  const transport = new CoreTransport({ binaryPath: CORE_BINARY });
  const pi = registrationHarness();
  const backgroundTasks = fakeBackgroundTasks();
  registerAutopilotCommands(pi, fixedServiceResolver({ transport, backgroundTasks, operatorMessage: recordingOperatorMessage, statusEntry: recordingStatusEntry }));

  try {
    const effects = await dispatchRegistered(pi, "autopilot-plan", PLAN_ARGS);
    assert.equal(doneStatus(effects, "autopilot-plan bare directory"), 'rejection:driver-error:planning:TaskPath("not-regular-file:CONTEXT.md")');
    assert.equal(effects.some((effect) => effect.kind === "spawn"), false, "bare directory must not synthesize an agent launch");
    assert.deepEqual(readEventsIfPresent(eventLog), [], "bare directory must not append agent:spawn evidence");
  } finally {
    transport.close();
    process.chdir(previousCwd);
    restoreEventLog(previousEventLog);
  }
});

test("successful run route uses recorded model transcripts and records agent spawn", { timeout: 30000 }, async () => {
  assertCoreBinaryPresent();

  const root = makeEvidenceRepo("autopilot-host-core-run-");
  const eventLog = join(root, "events.jsonl");
  const previousCwd = process.cwd();
  const previousEventLog = process.env.AUTOPILOT_CORE_EVENT_LOG;
  process.env.AUTOPILOT_CORE_EVENT_LOG = eventLog;
  process.chdir(root);

  const transport = new CoreTransport({ binaryPath: CORE_BINARY });
  const pi = registrationHarness();
  const backgroundTasks = fakeBackgroundTasks();
  registerAutopilotCommands(pi, fixedServiceResolver({ transport, backgroundTasks, operatorMessage: recordingOperatorMessage, statusEntry: recordingStatusEntry }));

  try {
    const planEffects = await dispatchRegistered(pi, "autopilot-plan", PLAN_ARGS);
    assertPlanningSpawn(planEffects, "autopilot-plan");
    assertAgentSpawnRecorded(eventLog, "planning-main-task-extractor-01");
    await completePlanningFromSpawn(transport, spawnActions(planEffects, "autopilot-plan"));

    const runEffects = await dispatchRegistered(pi, "autopilot", "main");
    const runSpawn = spawnAction(runEffects, "autopilot run");
    assert.equal(runSpawn.bg_run.isAgent, true);
    assert.match(runSpawn.bg_run.command, / --spec /u);
    assertAgentSpawnRecorded(eventLog, "assignment-main-L1");
  } finally {
    transport.close();
    process.chdir(previousCwd);
    restoreEventLog(previousEventLog);
  }
});

function assertCoreBinaryPresent() {
  try {
    accessSync(CORE_BINARY, constants.X_OK);
  } catch (error) {
    assert.fail(
      `Missing executable real Core binary at ${CORE_BINARY}. Build it before host integration tests: cargo build --release --workspace. ${errorMessage(error)}`,
    );
  }
}

function writeTaskPack(root, authoritySetId) {
  const entries = [
    ["TASK-A.md", "[authority]", "Implement authority A\n"],
    ["TASK-B.md", "[authority]", "Implement authority B\n"],
    ["TASK-C.md", "[authority]", "Implement authority C\n"],
    ["CONTEXT.md", "[context/non-authority]", "context sentinel should not become work\n"],
  ];
  for (const [name, marker, body] of entries) {
    writeFileSync(join(root, name), `${marker}\nauthority_set_id: ${authoritySetId}\n\n${body}`, "utf8");
  }
}

function makeEvidenceRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "src"));
  writeTaskPack(root, "set-host-core");
  writeFileSync(join(root, "src", "fixture.ts"), "export function autopilotFixture() { return 'real repository evidence'; }\n", "utf8");
  git(root, ["init"]);
  git(root, ["config", "user.email", "autopilot-test@example.invalid"]);
  git(root, ["config", "user.name", "Autopilot Test"]);
  git(root, ["add", "TASK-A.md", "TASK-B.md", "TASK-C.md", "CONTEXT.md", "src/fixture.ts"]);
  git(root, ["commit", "-m", "seed real repository evidence"]);
  return root;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function dispatchRegistered(pi, command, rawArgs) {
  const registration = pi.registrations.get(command);
  assert.ok(registration, `${command} was not registered`);
  const effects = [];
  activeEffects = effects;
  try {
    await registration.handler(rawArgs, recordingContext(effects));
  } finally {
    activeEffects = undefined;
  }
  return effects;
}

function recordingContext(effects) {
  return {
    hasUI: false,
    mode: "json",
    ui: {
      notify(message, level) {
        effects.push({ kind: "notify", level, message });
      },
    },
  };
}

async function recordingOperatorMessage(message, level) {
  activeEffects?.push({ kind: "operator-message", level, message });
}

async function recordingStatusEntry(status) {
  activeEffects?.push({ kind: "status-entry", status });
}

function fakeBackgroundTasks() {
  return {
    async capabilities() { return completeCapabilities(); },
    async run(descriptor) {
      // Derive the real assignment id from the launch name so batched waves keep
      // each member distinct instead of collapsing onto a hardcoded id.
      const launched = descriptor.name.startsWith("autopilot-agent-run ")
        ? descriptor.name.slice("autopilot-agent-run ".length).trim()
        : "assignment-main-L1";
      activeEffects?.push({ kind: "spawn", action: { bg_run: descriptor, assignment_id: launched } });
      return { id: `task-${Date.now()}`, command: descriptor.command, status: "running", outputPath: join(tmpdir(), "autopilot-bg.out") };
    },
  };
}

function completeCapabilities() {
  return { api_version: 1, run: true, run_is_agent: true, run_completion_trigger: true, status: true, logs: true, logs_bounded: true, kill: true };
}

function commandPayload(raw) {
  return { raw, background_capabilities: completeCapabilities() };
}

function registrationHarness() {
  const registrations = new Map();
  return {
    registrations,
    registerCommand(name, definition) {
      registrations.set(name, definition);
    },
  };
}

function doneStatus(effects, label) {
  const effect = effects.find((item) => item.kind === "operator-message" && item.message.startsWith("Autopilot done: "));
  assert.ok(effect, `${label} did not produce an operator-visible done effect: ${JSON.stringify(effects)}`);
  assert.equal(typeof effect.message, "string");
  return effect.message.slice("Autopilot done: ".length);
}

function spawnActions(effects, label) {
  // The fake background client records one effect per launched task, so a batched
  // planning wave appears as several spawn effects. Collect every one of them.
  const actions = effects
    .filter((item) => item.kind === "spawn")
    .flatMap((item) => (item.launched ?? (item.action === undefined ? [] : [{ action: item.action }])))
    .map((item) => item.action);
  assert.ok(actions.length > 0, `${label} launched nothing: ${JSON.stringify(effects)}`);
  return actions;
}

function spawnAction(effects, label) {
  return spawnActions(effects, label)[0];
}

function assertPlanningSpawn(effects, label) {
  const action = spawnAction(effects, label);
  assert.equal(action.bg_run.isAgent, true);
  assert.equal(action.assignment_id, "planning-main-task-extractor-01");
  assert.match(action.bg_run.command, / --spec /u);
  assert.doesNotMatch(action.bg_run.command, /autopilot-agent-run --assignment/u);
}

function assertPlanningManifestGrounded(root) {
  const manifest = JSON.parse(readFileSync(join(root, ".pi", "autopilot", "main", "planning-manifest.json"), "utf8"));
  const head = gitHead(root);
  assert.equal(manifest.workstream, "main");
  assert.equal(manifest.atoms, 3);
  assert.equal(
    manifest.assignments.length,
    expectedPlanningAssignmentCount(),
    "D72 P1-P6 assignment plan should match data/planning.kdl assignment_role counts, not be stubbed",
  );
  assert.ok(
    manifest.verified_facts.some((fact) => fact === `repo-file:src/fixture.ts:head=${head}:line=export function autopilotFixture() { return 'real repository evidence'; }`),
    `manifest did not include source evidence from git HEAD: ${JSON.stringify(manifest.verified_facts)}`,
  );
}

function expectedPlanningAssignmentCount() {
  const planning = readFileSync(join(PACKAGE_ROOT, "data", "planning.kdl"), "utf8");
  let total = 0;
  let roles = 0;
  for (const line of planning.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("assignment_role ")) continue;
    const countToken = trimmed.split(/\s+/u).find((token) => token.startsWith("count="));
    assert.equal(typeof countToken, "string", `assignment_role missing count: ${trimmed}`);
    const count = Number(countToken.slice("count=".length));
    assert.ok(Number.isInteger(count) && count > 0, `assignment_role has invalid count: ${trimmed}`);
    total += count;
    roles += 1;
  }
  assert.notEqual(roles, 0, "data/planning.kdl must declare assignment_role rows");
  return total;
}

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function assertAgentSpawnRecorded(eventLog, assignmentId) {
  const events = readEventsIfPresent(eventLog);
  assert.ok(
    events.some((event) => event.kind === "agent:spawn" && event.artifact_refs.includes(assignmentId)),
    `event log did not record agent:spawn for ${assignmentId}: ${JSON.stringify(events)}`,
  );
}

function spawnedActions(frame) {
  if (frame.kind === "spawn-wave") return [...frame.payload.actions];
  if (frame.kind === "spawn") return [frame.payload.action];
  return [];
}

async function completePlanningFromSpawn(transport, firstActions) {
  // Planning launches whole waves, so drain every launched assignment before expecting terminal.
  const pending = Array.isArray(firstActions) ? [...firstActions] : [firstActions];
  // Key on assignment id: a re-issued binding for an already-consumed assignment would be
  // ambiguous at the seam, so each assignment must be completed exactly once.
  const seen = new Set(pending.map((action) => action.assignment_id));
  const consumed = new Set();
  for (let index = 0; index < 200; index += 1) {
    const action = pending.shift();
    assert.ok(action !== undefined, "planning ran out of assignments before ready-to-execute");
    if (consumed.has(action.assignment_id)) continue;
    consumed.add(action.assignment_id);
    const frame = await transport.request("agent-result", {
      assignment_id: action.assignment_id,
      carrier: planningCarrierForAction(action),
    }, 5000);
    for (const next of spawnedActions(frame)) {
      // A later wave may re-announce an assignment that is already queued or consumed;
      // completing it twice would be an ambiguous binding at the seam.
      if (seen.has(next.assignment_id) || consumed.has(next.assignment_id)) continue;
      seen.add(next.assignment_id);
      pending.push(next);
    }
    if (frame.kind === "spawn" || frame.kind === "spawn-wave") continue;
    assert.equal(frame.kind, "done");
    // Accepting a non-final member of a wave returns `done: agent-result:accepted...`.
    // Only the wave's last acceptance advances planning, so keep draining until the
    // queue is empty and then require the terminal status.
    if (pending.length > 0) {
      // A non-final wave member is either a plain acceptance, or a typed waiting-on-in-flight
      // status naming the siblings Core is still waiting for. Both are non-terminal progress;
      // neither may be a silent stop.
      assert.match(
        frame.payload.status,
        /agent-result:accepted|planning:waiting-on-in-flight:wave=/u,
      );
      continue;
    }
    assert.match(frame.payload.status, /ready-to-execute:workstream=main/u);
    return;
  }
  assert.fail("planning did not reach ready-to-execute within 200 carrier acceptances");
}

function planningCarrierForAction(action) {
  const specPath = specPathFromCommand(action.bg_run.command);
  const specBytes = readFileSync(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const carrier = {
    schema: "autopilot.planning_carrier.v1",
    action_id: spec.action_id,
    assignment_id: spec.assignment_id,
    run_revision: spec.run_revision,
    workstream: spec.workstream,
    role_id: spec.role_id,
    mode: spec.mode,
    boundary_id: spec.boundary_id,
    result_contract: spec.result_contract,
    prompt_path: spec.prompt_path,
    prompt_digest: spec.prompt_digest,
    spec_digest: sha256(specBytes),
    spec_path: specPath,
    carrier_path: spec.carrier_path,
    raw_output: replayOutputForSpec(spec, specPath),
  };
  for (const key of ["boundary_digest", "result_contract_digest", "settings_digest", "context_digest", "skills_digest", "subscription_digest"]) {
    if (typeof spec[key] === "string") carrier[key] = spec[key];
  }
  mkdirSync(dirname(spec.carrier_path), { recursive: true });
  writeFileSync(spec.carrier_path, JSON.stringify(carrier), "utf8");
  return carrier;
}

function replayOutputForSpec(spec, specPath) {
  const raw = transcript(spec.boundary_id);
  if (spec.boundary_id === "planning.task-atoms.v1") {
    return namespaceLegacyTaskAtoms(raw, spec);
  }
  if (spec.boundary_id === "planning.work-map.v1") {
    return namespaceLegacyWorkMapLinks(raw, spec, specPath);
  }
  return raw;
}

function namespaceLegacyTaskAtoms(raw, spec) {
  const prefix = requireString(spec.atom_id_prefix, "task atom replay spec atom_id_prefix");
  const value = JSON.parse(raw);
  const sourceMap = legacyTaskSourceMap(value, spec);
  assert.ok(Array.isArray(value.atoms), "task atoms replay records must expose atoms[]");
  for (const atom of value.atoms) {
    const id = requireString(atom.id, "task atoms replay id");
    assert.notEqual(id, "", "task atoms replay id must be non-empty");
    atom.id = id.startsWith(prefix) ? id : `${prefix}${id}`;

    assert.ok(Array.isArray(atom.sources), "task atoms replay sources must be arrays");
    atom.sources = atom.sources.map((rawSource) => {
      const source = requireString(rawSource, "task atoms replay source");
      const selector = taskSourceDocumentSelector(source);
      const mapped = sourceMap.get(selector);
      assert.notEqual(mapped, undefined, `task atom replay source ${source} was not present in source map`);
      return mapped;
    });
  }
  return JSON.stringify(value);
}

function legacyTaskSourceMap(value, spec) {
  assert.ok(Array.isArray(value.atoms), "task atoms replay records must expose atoms[]");
  const recordedSelectors = [];
  for (const atom of value.atoms) {
    assert.ok(Array.isArray(atom.sources), "task atoms replay sources must be arrays");
    for (const rawSource of atom.sources) {
      const source = requireString(rawSource, "task atoms replay source");
      const selector = taskSourceDocumentSelector(source);
      if (!recordedSelectors.includes(selector)) recordedSelectors.push(selector);
    }
  }

  assert.ok(Array.isArray(spec.authority_documents), "task atom replay spec must carry authority_documents[]");
  assert.ok(
    recordedSelectors.length <= spec.authority_documents.length,
    `task atom replay cites ${recordedSelectors.length} task documents but spec binds only ${spec.authority_documents.length} authority documents`,
  );
  return new Map(recordedSelectors.map((selector, index) => {
    const document = spec.authority_documents[index];
    const digest = requireString(document.digest, "task atom replay authority document digest");
    const path = requireString(document.path, "task atom replay authority document path");
    assert.notEqual(digest, "", "task atom replay authority digest is empty");
    assert.notEqual(path, "", "task atom replay authority path is empty");
    return [selector, `task://${digest}/${path}#whole-file`];
  }));
}

function taskSourceDocumentSelector(source) {
  const withoutScheme = source.startsWith("task://") ? source.slice("task://".length) : source;
  const hashIndex = withoutScheme.indexOf("#");
  const sectionIndex = withoutScheme.indexOf(" §");
  let document = withoutScheme;
  if (hashIndex !== -1 && (sectionIndex === -1 || hashIndex < sectionIndex)) {
    document = withoutScheme.slice(0, hashIndex);
  } else if (sectionIndex !== -1) {
    document = withoutScheme.slice(0, sectionIndex);
  }
  assert.notEqual(document, "", "task atom replay source document is empty");
  return document;
}

function namespaceLegacyWorkMapLinks(raw, spec, specPath) {
  const localToFull = atomLocalToFullIds(spec, specPath);
  const fullIds = new Set(localToFull.values());
  const value = JSON.parse(raw);
  assert.ok(Array.isArray(value.units), "work-map replay records must expose units[]");
  for (const unit of value.units) {
    assert.ok(Array.isArray(unit.links), "work-map replay links must be arrays");
    unit.links = unit.links.map((rawLink) => {
      const link = requireString(rawLink, "work-map replay link");
      const full = localToFull.get(link);
      if (full !== undefined) return full;
      assert.ok(fullIds.has(link), `work-map replay link ${link} is not present in the bound atom registry`);
      return link;
    });
  }
  return JSON.stringify(value);
}

function atomLocalToFullIds(spec, specPath) {
  const registryPath = requireString(spec.atom_registry_path, "work-map replay spec atom_registry_path");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.ok(Array.isArray(registry.atoms), "work-map replay registry must expose atoms[]");
  const specsDir = dirname(specPath);
  const prefixByAssignment = new Map();
  const localToFull = new Map();
  const localFingerprints = new Map();
  for (const atom of registry.atoms) {
    const fullId = requireString(atom.id, "work-map replay registry atom id");
    const producerAssignmentId = requireString(atom.producer_assignment_id, "work-map replay registry producer_assignment_id");
    let prefix = prefixByAssignment.get(producerAssignmentId);
    if (prefix === undefined) {
      const producerSpecPath = join(specsDir, `${producerAssignmentId}.json`);
      const producerSpec = JSON.parse(readFileSync(producerSpecPath, "utf8"));
      prefix = requireString(producerSpec.atom_id_prefix, "producer atom spec atom_id_prefix");
      prefixByAssignment.set(producerAssignmentId, prefix);
    }
    assert.ok(fullId.startsWith(prefix), `registry atom id ${fullId} does not match producer prefix ${prefix}`);
    const localId = fullId.slice(prefix.length);
    assert.notEqual(localId, "", "registry atom id must retain local suffix");
    const fingerprint = JSON.stringify({ kind: atom.kind, text: atom.text, sources: atom.sources });
    const previousFingerprint = localFingerprints.get(localId);
    if (previousFingerprint !== undefined) {
      assert.equal(
        previousFingerprint,
        fingerprint,
        `legacy replay atom id ${localId} is ambiguous between non-equivalent registry atoms`,
      );
      continue;
    }
    localFingerprints.set(localId, fingerprint);
    localToFull.set(localId, fullId);
  }
  return localToFull;
}

function requireString(value, label) {
  assert.equal(typeof value, "string", label);
  return value;
}

function specPathFromCommand(command) {
  const match = command.match(/ --spec ('(?:'\\''|[^'])*'|\S+)$/u);
  assert.ok(match, `runner command did not contain terminal --spec path: ${command}`);
  const token = match[1];
  return token.startsWith("'") ? token.slice(1, -1).replace(/'\\''/gu, "'") : token;
}

function readEventsIfPresent(eventLog) {
  try {
    const text = readFileSync(eventLog, "utf8").trim();
    if (text.length === 0) {
      return [];
    }
    return text.split("\n").map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function transcript(boundaryId) {
  const path = join(PACKAGE_ROOT, "tests", "transcripts", boundaryId, "transcripts.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  const raw = value.records[0].raw_output;
  assert.equal(typeof raw, "string");
  return raw;
}

function assertNoUnknownCommand(command, effects) {
  assert.doesNotMatch(JSON.stringify(effects), /unknown-command/u, `${command} was rejected before route admission`);
}

function restoreEventLog(previousEventLog) {
  if (previousEventLog === undefined) {
    delete process.env.AUTOPILOT_CORE_EVENT_LOG;
  } else {
    process.env.AUTOPILOT_CORE_EVENT_LOG = previousEventLog;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
