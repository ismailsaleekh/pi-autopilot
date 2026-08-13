import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAggregates } from "./generate-aggregates.js";
import { runPolicy } from "./run-policy.js";
import {
  readSuiteManifest,
  registeredSuiteCommands,
} from "./suite-manifest-checker.js";

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;
const packageRoot = dirname(nextRoot);
const tsc = join(packageRoot, "node_modules", ".bin", "tsc");

interface CommandSpec {
  readonly name: string;
  readonly command: string;
  readonly arguments: readonly string[];
}

function run(spec: CommandSpec): boolean {
  process.stdout.write(`\n[w0] ${spec.name}\n`);
  const child = spawnSync(spec.command, spec.arguments, {
    cwd: nextRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (child.error !== undefined) {
    process.stderr.write(`${child.error.message}\n`);
    return false;
  }
  if (child.status !== 0) {
    process.stderr.write(`[w0] ${spec.name} failed with status ${String(child.status)}\n`);
    return false;
  }
  return true;
}

function runRegisteredSuite(id: string, command: string): boolean {
  process.stdout.write(`\n[w0] registered suite ${id}\n[w0] command: ${command}\n`);
  const child = spawnSync(command, {
    cwd: nextRoot,
    encoding: "utf8",
    shell: true,
    stdio: "inherit",
  });
  if (child.error !== undefined) {
    process.stderr.write(`${child.error.message}\n`);
    return false;
  }
  if (child.status !== 0) {
    process.stderr.write(`[w0] registered suite ${id} failed with status ${String(child.status)}\n`);
    return false;
  }
  return true;
}

let green = true;
for (const outputDirectory of ["dist", "dist-policy", "dist-testkit", "dist-tests"]) {
  const absolute = join(nextRoot, outputDirectory);
  if (existsSync(absolute)) {
    rmSync(absolute, { recursive: true, force: true });
  }
}
process.stdout.write("[w0] clean output trees\n");
green = run(Object.freeze({
  name: "compile protected gate bootstrap",
  command: tsc,
  arguments: Object.freeze(["-p", "tsconfig.policy.json", "--pretty", "false"]),
})) && green;

process.stdout.write("[w0] generated aggregate freshness\n");
generateAggregates(true);
if (process.exitCode !== undefined && process.exitCode !== 0) {
  green = false;
  process.exitCode = undefined;
}

green = run(Object.freeze({
  name: "strict project typecheck and emit",
  command: tsc,
  arguments: Object.freeze(["-b", "--pretty", "false", "--force"]),
})) && green;

green = run(Object.freeze({
  name: "link testkit project dependencies",
  command: process.execPath,
  arguments: Object.freeze(["dist-policy/policy-root/link-testkit-dependencies.js"]),
})) && green;

if (green) {
  process.stdout.write("\n[w0] policy-root architecture checks\n");
  const summary = runPolicy(nextRoot);
  const findingCount = Object.values(summary).reduce((sum, count) => sum + count, 0);
  process.stdout.write(`[w0] policy findings: ${String(findingCount)}\n`);
  green = findingCount === 0 && green;
}

green = run(Object.freeze({
  name: "poisoned-runtime authority purity test",
  command: process.execPath,
  arguments: Object.freeze(["--test", "dist-policy/policy-root/purity-poison.test.js"]),
})) && green;

green = run(Object.freeze({
  name: "gate self-tests",
  command: process.execPath,
  arguments: Object.freeze(["--test", "dist-policy/policy-root/gate-self-tests.js"]),
})) && green;

green = run(Object.freeze({
  name: "spine unit and fuzz smoke tests",
  command: process.execPath,
  arguments: Object.freeze(["--test", "dist-tests/tests/spine.test.js"]),
})) && green;

const suiteManifest = readSuiteManifest(join(nextRoot, "policy-root", "required-suites.json"));
if (suiteManifest === null) {
  process.stderr.write("[w0] required suite manifest is unreadable; no registered command may be skipped\n");
  green = false;
} else {
  for (const suite of registeredSuiteCommands(suiteManifest)) {
    green = runRegisteredSuite(suite.id, suite.command) && green;
  }
}

if (!green) {
  process.stderr.write("\n[w0] GATE RED\n");
  process.exitCode = 1;
} else {
  process.stdout.write("\n[w0] GATE GREEN\n");
}
