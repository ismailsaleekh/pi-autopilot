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
try {
  included = readFileSync(join(root, 'data/seam_real_producers.rs'), 'utf8');
} catch (error) {
  included = '';
}
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
for (const [needle, label] of forbidden) {
  if (productionSource.includes(needle)) failures.push(label);
}

function functionBody(name) {
  const start = seam.indexOf(`fn ${name}(`);
  if (start < 0) {
    failures.push(`missing production route ${name}`);
    return '';
  }
  const open = seam.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < seam.length; index += 1) {
    const ch = seam[index];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return seam.slice(open + 1, index);
    }
  }
  failures.push(`unclosed production route ${name}`);
  return '';
}

for (const route of ['route_plan', 'route_run']) {
  const body = functionBody(route);
  if (!body.includes('append_runner_invocation(')) failures.push(`${route} has no recorded runner invocation before success`);
  if (!body.includes('spawn(')) failures.push(`${route} does not return through the spawn/bg_run seam`);
}

const plan = functionBody('route_plan');
if (!plan.includes('RepoGrounding') || !plan.includes('p2_ground')) failures.push('route_plan does not ground through repository evidence');
if (!plan.includes('planning_assignments') || !plan.includes('planning_bg_action')) failures.push('route_plan does not dispatch the D72 assignment plan');
const run = functionBody('route_run');
if (!run.includes('read_approved_plan') || !run.includes('host_resource_facts') || !run.includes('lane_readiness_from_events')) failures.push('route_run does not use persisted plan, event readiness, and host resources');

if (failures.length > 0) {
  console.error('real-producers: rejected production fixture theater:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('real-producers: ok');
