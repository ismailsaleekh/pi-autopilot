#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let root = process.cwd();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    root = args[index + 1];
    index += 1;
  } else {
    console.error(`real-producers: unknown argument ${args[index]}`);
    process.exit(2);
  }
}

function read(rel) {
  const path = join(root, rel);
  try {
    if (!statSync(path).isFile()) throw new Error('not file');
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`real-producers: cannot read ${rel}: ${error.message}`);
    process.exit(2);
  }
}

const seam = read('drivers/src/seam/mod.rs');
let included = '';
try { included = readFileSync(join(root, 'data/seam_real_producers.rs'), 'utf8'); } catch {}
const productionSource = `${seam}\n${included}`;
const failures = [];
const forbidden = [
  ['struct Facts', 'stub RepositoryEvidence named Facts'],
  ['format!("verified:{}", atom.id)', 'repository grounding that echoes atom ids'],
  ['fn units() -> Vec<ApprovedUnit>', 'fixed approved-unit producer'],
  ['fn ready(name: &str) -> LaneReadiness', 'fixed lane readiness producer'],
  ['fn resources() -> ResourceFacts', 'fixed host resource producer'],
  ['base_commit: Sha("0000000000000000000000000000000000000000"', 'invented zero base commit in production assignment'],
];
for (const [needle, label] of forbidden) if (productionSource.includes(needle)) failures.push(label);

function functionBody(name) {
  const re = new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?fn\\s+${name}\\s*\\(`, 'u');
  const match = re.exec(seam);
  if (match === null) { failures.push(`missing production function ${name}`); return ''; }
  const open = seam.indexOf('{', match.index);
  if (open < 0) { failures.push(`production function ${name} has no body`); return ''; }
  let depth = 0;
  for (let index = open; index < seam.length; index += 1) {
    const ch = seam[index];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return seam.slice(open + 1, index);
    }
  }
  failures.push(`unclosed production function ${name}`);
  return '';
}

function functionNames(prefix) {
  const names = [];
  const re = new RegExp(`(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?fn\\s+(${prefix}[A-Za-z0-9_]*)\\s*\\(`, 'gu');
  for (const match of seam.matchAll(re)) names.push(match[1]);
  return [...new Set(names)].sort();
}
function routeCallsIn(body) { return [...body.matchAll(/\b(route_[A-Za-z0-9_]+)\s*\(/gu)].map((match) => match[1]); }

const productionRoutes = functionNames('route_');
if (productionRoutes.length === 0) failures.push('no production route functions found');
const reachableRoutes = new Set();
for (const entrypoint of ['dispatch', 'command']) for (const route of routeCallsIn(functionBody(entrypoint))) reachableRoutes.add(route);
for (const route of productionRoutes) if (!reachableRoutes.has(route)) failures.push(`${route} is not reachable from dispatch/command entrypoints`);

function appendBeforeEverySpawn(name, body) {
  const appendPositions = [...body.matchAll(/\bappend_(?:runner|agent)_invocation\s*\(/gu)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  const spawnPositions = [...body.matchAll(/\bspawn\s*\(/gu)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  for (const spawnIndex of spawnPositions) {
    const precedingAppend = appendPositions.filter((index) => index < spawnIndex).pop();
    if (precedingAppend === undefined) {
      failures.push(`${name} reaches spawn/bg_run without a prior recorded runner invocation`);
      continue;
    }
    if (/\breturn\b/u.test(body.slice(precedingAppend, spawnIndex))) failures.push(`${name} records invocation only before an unreachable spawn path`);
  }
}
for (const name of [...productionRoutes, 'accept_planning_carrier']) {
  if (!new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'u').test(seam)) continue;
  appendBeforeEverySpawn(name, functionBody(name));
}

const plan = functionBody('route_plan');
if (!plan.includes('RepoGrounding') || !plan.includes('p2_ground')) failures.push('route_plan does not ground through repository evidence');
if (!plan.includes('planning_assignments') || !plan.includes('planning_bg_action')) failures.push('route_plan does not dispatch the D72 assignment plan');
const run = functionBody('route_run');
if (!run.includes('read_approved_plan') || !run.includes('host_resource_facts') || !run.includes('lane_readiness_from_events')) failures.push('route_run does not use persisted plan, event readiness, and host resources');
const agentResult = functionBody('route_agent_result');
if (!agentResult.includes('accept_planning_carrier')) failures.push('route_agent_result does not route through carrier acceptance');
const taskCompleted = functionBody('route_task_completed');
if (!taskCompleted.includes('binding_for') || !taskCompleted.includes('append_terminal_event')) failures.push('route_task_completed does not use recorded task bindings and terminal events');

if (failures.length > 0) {
  console.error('real-producers: rejected production fixture theater:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('real-producers: ok');
