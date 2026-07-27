import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTOPILOT_COMMANDS, registerAutopilotCommands } from "../src/commands.ts";
import { CoreTransport } from "../src/transport.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORE_BINARY_NAME = process.platform === "win32" ? "autopilot-core.exe" : "autopilot-core";
const CORE_BINARY = join(PACKAGE_ROOT, "target", "release", CORE_BINARY_NAME);

const VALID_COMMAND_ARGS = Object.freeze({
  "autopilot-plan": "main TASK.md",
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
  registerAutopilotCommands(pi, { transport });

  try {
    for (const command of AUTOPILOT_COMMANDS) {
      const effects = await dispatchRegistered(pi, command, VALID_COMMAND_ARGS[command]);
      assert.notEqual(effects.length, 0, `${command} produced no host effect`);
      assertNoUnknownCommand(command, effects);

      if (command === "autopilot-plan") {
        assertPlanningSpawn(effects, "autopilot-plan");
        assertPlanningManifestGrounded(root);
        assertAgentSpawnRecorded(eventLog, "planning-main-extractor-01");
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

    const invalid = await transport.request("command", { raw: "not-a-real-autopilot-command main" }, 5000);
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
  writeFileSync(join(root, "TASK.md"), "Mission\nDefinition of Done\n", "utf8");

  const eventLog = join(root, "events.jsonl");
  const previousCwd = process.cwd();
  const previousEventLog = process.env.AUTOPILOT_CORE_EVENT_LOG;
  process.env.AUTOPILOT_CORE_EVENT_LOG = eventLog;
  process.chdir(root);

  const transport = new CoreTransport({ binaryPath: CORE_BINARY });
  const pi = registrationHarness();
  registerAutopilotCommands(pi, { transport });

  try {
    const effects = await dispatchRegistered(pi, "autopilot-plan", "main TASK.md");
    assert.equal(doneStatus(effects, "autopilot-plan bare directory"), 'rejection:driver-error:CONTEXT_GAP:planning:git ["rev-parse", "--verify", "HEAD"] failed');
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
  registerAutopilotCommands(pi, { transport });

  try {
    assertPlanningSpawn(await dispatchRegistered(pi, "autopilot-plan", "main TASK.md"), "autopilot-plan");
    assertAgentSpawnRecorded(eventLog, "planning-main-extractor-01");

    const workMap = transcript("planning.work-map.v1");
    const accepted = await transport.request("agent-result", {
      assignment_id: "planning-main-compiler-01",
      carrier: { workstream: "main", boundary_id: "planning.work-map.v1", raw_output: workMap },
    }, 5000);
    assert.equal(accepted.kind, "spawn");

    const review = transcript("planning.plan-review.v1");
    const ready = await transport.request("agent-result", {
      assignment_id: "planning-main-reviewer-01",
      carrier: { workstream: "main", boundary_id: "planning.plan-review.v1", raw_output: review },
    }, 5000);
    assert.equal(ready.kind, "done");
    assert.match(ready.payload.status, /ready-to-execute:workstream=main/u);

    const runEffects = await dispatchRegistered(pi, "autopilot", "main");
    const runSpawn = spawnAction(runEffects, "autopilot run");
    assert.equal(runSpawn.display_name, "autopilot-agent-run");
    assert.equal(runSpawn.isAgent, true);
    assert.match(runSpawn.command_bytes, /autopilot-agent-run --assignment assignment-main-L1/u);
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

function makeEvidenceRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "TASK.md"), "Mission\nImplement the autopilot fixture from real repository evidence.\nDefinition of Done\n", "utf8");
  writeFileSync(join(root, "src", "fixture.ts"), "export function autopilotFixture() { return 'real repository evidence'; }\n", "utf8");
  git(root, ["init"]);
  git(root, ["config", "user.email", "autopilot-test@example.invalid"]);
  git(root, ["config", "user.name", "Autopilot Test"]);
  git(root, ["add", "TASK.md", "src/fixture.ts"]);
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
  await registration.handler(rawArgs, recordingContext(effects));
  return effects;
}

function recordingContext(effects) {
  return {
    bg_run(action) {
      effects.push({ kind: "spawn", action });
    },
    done(status) {
      effects.push({ kind: "done", status });
    },
    ui: {
      text(content) {
        effects.push({ kind: "ui", ui_kind: "text", content });
      },
    },
  };
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
  const effect = effects.find((item) => item.kind === "done");
  assert.ok(effect, `${label} did not produce a done effect: ${JSON.stringify(effects)}`);
  assert.equal(typeof effect.status, "string");
  return effect.status;
}

function spawnAction(effects, label) {
  const effect = effects.find((item) => item.kind === "spawn");
  assert.ok(effect, `${label} did not produce a spawn effect: ${JSON.stringify(effects)}`);
  assert.equal(typeof effect.action, "object");
  assert.notEqual(effect.action, null);
  return effect.action;
}

function assertPlanningSpawn(effects, label) {
  const action = spawnAction(effects, label);
  assert.equal(action.display_name, "autopilot-agent-run");
  assert.equal(action.isAgent, true);
  assert.equal(action.assignment_id, "planning-main-extractor-01");
  assert.match(action.command_bytes, /autopilot-agent-run --assignment planning-main-extractor-01/u);
  assert.match(action.command_bytes, /--role extractor/u);
  assert.match(action.command_bytes, /--mode planning-extract/u);
  assert.match(action.command_bytes, /--boundary planning\.task-atoms\.v1/u);
}

function assertPlanningManifestGrounded(root) {
  const manifest = JSON.parse(readFileSync(join(root, ".pi", "autopilot", "main", "planning-manifest.json"), "utf8"));
  const head = gitHead(root);
  assert.equal(manifest.workstream, "main");
  assert.equal(manifest.atoms, 1);
  assert.equal(manifest.assignments.length, 25, "D72 P1-P6 assignment plan should be complete, not stubbed");
  assert.ok(
    manifest.verified_facts.some((fact) => fact === `repo-file:src/fixture.ts:head=${head}:line=export function autopilotFixture() { return 'real repository evidence'; }`),
    `manifest did not include source evidence from git HEAD: ${JSON.stringify(manifest.verified_facts)}`,
  );
}

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function assertAgentSpawnRecorded(eventLog, assignmentId) {
  const events = readEventsIfPresent(eventLog);
  assert.ok(
    events.some((event) => event.kind === "agent:spawn" && event.artifact_refs.includes(assignmentId)),
    `event log did not record agent:spawn for ${assignmentId}: ${JSON.stringify(events)}`,
  );
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
