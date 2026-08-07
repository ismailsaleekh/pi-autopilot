#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStatusFrameLaunch } from './check-launch-entrypoint.mjs';

const sourceRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const GLOBAL_PI_ROOT = realpathSync('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent');
const GLOBAL_TYPEBOX_ROOT = realpathSync(join(GLOBAL_PI_ROOT, 'node_modules', 'typebox'));
const CANONICAL_TMP_ROOT = realpathSync(tmpdir());
const EXPECTED_COMMANDS = Object.freeze(['autopilot-plan', 'autopilot', 'autopilot-onboard', 'autopilot-inject', 'autopilot-status', 'autopilot-config', 'autopilot-handoff', 'autopilot-close', 'autopilot-abort', 'autopilot-answer']);
const DELIVERY_POLICY_VERSION = 'autopilot.delivery_tool_policy.v3';
const DELIVERY_ENV_KEYS = Object.freeze([
  'AUTOPILOT_DELIVERY_ASSIGNMENT_PATH', 'AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST',
  'AUTOPILOT_DELIVERY_WORKTREE', 'AUTOPILOT_DELIVERY_CWD', 'AUTOPILOT_DELIVERY_ASSIGNMENT_ID',
  'AUTOPILOT_DELIVERY_WORKSTREAM', 'AUTOPILOT_DELIVERY_LANE_ID', 'AUTOPILOT_DELIVERY_ATTEMPT',
  'AUTOPILOT_DELIVERY_BASE_COMMIT', 'AUTOPILOT_DELIVERY_POLICY_DIGEST',
]);
const EXPECTED_CHILD_PROFILE_BINDINGS = Object.freeze({
  'delivery-status.v2': { tool: 'autopilot_emit_status', boundary: 'autopilot.delivery_submission.v2', result: 'autopilot.delivery_result.v2', tools: ['autopilot_run_approved_command', 'edit', 'write', 'autopilot_emit_status'] },
  'planning.plan-review.v1:autopilot_submit_review': { tool: 'autopilot_submit_review', boundary: 'planning.plan-review.v1' },
  'planning.questions.v1:autopilot_submit_resolution': { tool: 'autopilot_submit_resolution', boundary: 'planning.questions.v1' },
  'planning.scout-dossier.v1:autopilot_submit_context': { tool: 'autopilot_submit_context', boundary: 'planning.scout-dossier.v1' },
  'planning.scout-dossier.v1:autopilot_submit_scout_report': { tool: 'autopilot_submit_scout_report', boundary: 'planning.scout-dossier.v1' },
  'planning.task-atoms.v1:autopilot_submit_atoms': { tool: 'autopilot_submit_atoms', boundary: 'planning.task-atoms.v1' },
  'planning.work-map.v1:autopilot_submit_plan_cluster': { tool: 'autopilot_submit_plan_cluster', boundary: 'planning.work-map.v1' },
  'planning.work-map.v1:autopilot_submit_synthesis': { tool: 'autopilot_submit_synthesis', boundary: 'planning.work-map.v1' },
  'recovery-work-map.v1': { tool: 'autopilot_emit_status', boundary: 'planning.work-map.v1' },
  'validation-status.v2': { tool: 'autopilot_emit_status', boundary: 'autopilot.validation_submission.v2', result: 'autopilot.validation_result.v2' },
  'validation-status.v3': { tool: 'autopilot_emit_status', boundary: 'autopilot.validation_submission.v3', result: 'autopilot.validation_result.v3', tools: ['read', 'autopilot_emit_status'] },
});
const EXPECTED_CHILD_PROFILES = Object.freeze(Object.keys(EXPECTED_CHILD_PROFILE_BINDINGS));
function fail(message) { throw new Error(`packed-consumer-invalid: ${message}`); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function under(parent, candidate) { const rel = relative(parent, candidate); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
function checkedRun(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) fail(`${command} ${args.join(' ')} failed status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? '<none>'}\n${result.stderr}`);
  return result.stdout;
}
function packageJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.name !== 'string' || typeof value.version !== 'string') fail(`package manifest is malformed: ${path}`);
  return value;
}
function walkManifest(root) {
  const entries = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name); const rel = relative(root, path).replace(/\\/gu, '/'); const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) visit(path);
      else if (info.isFile() && !info.isSymbolicLink()) entries.set(rel, { kind: 'file', byte_count: info.size, sha256: sha256(readFileSync(path)), mode: info.mode & 0o777 });
      else if (info.isSymbolicLink()) entries.set(rel, { kind: 'symlink', target: readlinkSync(path) });
      else fail(`package tree contains a non-regular entry: ${path}`);
    }
  };
  visit(root); return entries;
}
function assertInstalledManifest(expectedRoot, installedRoot, packFiles) {
  const expected = walkManifest(expectedRoot); const installed = walkManifest(installedRoot);
  const declared = packFiles.map((entry) => entry.path).sort(); const expectedNames = [...expected.keys()].sort(); const installedNames = [...installed.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expectedNames)) fail('extracted tarball manifest differs from npm pack --json manifest');
  if (JSON.stringify(expectedNames) !== JSON.stringify(installedNames)) fail('installed package manifest differs from the exact tarball manifest');
  for (const path of expectedNames) if (JSON.stringify(expected.get(path)) !== JSON.stringify(installed.get(path))) fail(`installed package bytes/mode differ at ${path}`);
  return { file_count: expectedNames.length, manifest_sha256: sha256(Buffer.from(JSON.stringify(expectedNames.map((path) => [path, expected.get(path)])))) };
}
function assertPublicAliasVersions() {
  const pi = packageJson(join(GLOBAL_PI_ROOT, 'package.json'));
  const typebox = packageJson(join(GLOBAL_TYPEBOX_ROOT, 'package.json'));
  if (pi.name !== '@earendil-works/pi-coding-agent' || pi.version !== '0.84.0') fail(`global Pi public alias must be 0.84.0, got ${pi.name}@${pi.version}`);
  if (typebox.name !== 'typebox' || typebox.version !== '1.3.7') fail(`global TypeBox public alias must be 1.3.7, got ${typebox.name}@${typebox.version}`);
  return { pi, typebox };
}
function assertNoPrivateRuntimeCopies(installedRoot) {
  for (const rel of [join('node_modules', 'typebox'), join('node_modules', '@earendil-works', 'pi-coding-agent')]) {
    if (existsSync(join(installedRoot, rel))) fail(`packed runtime contains private peer copy: ${rel}`);
  }
}
function validPayload(boundary) {
  const samples = {
    'planning.task-atoms.v1': { atoms: [{ id: 'atom-1', kind: 'work', text: 'implement', sources: ['TASK.md'] }] },
    'planning.scout-dossier.v1': { findings: [{ path: 'src/extension.ts', observation: 'loaded', evidence_ref: 'packed#1' }] },
    'planning.questions.v1': { questions: [{ class: 'dod-hole', evidence: 'criterion', consequence: 'blocked' }] },
    'planning.work-map.v1': { units: [{ id: 'unit-1', objective: 'prove aliases', criteria: ['green'], links: ['atom-1'] }] },
    'planning.plan-review.v1': { verdicts: [{ criterion_id: 'criterion-1', verdict: 'pass', finding: 'covered' }] },
    'autopilot.delivery_submission.v2': { actual_changed_paths: ['package.json'], execution_audit_ref: 'report.md', focused_evidence_refs: ['packed'], terminal_status: 'PASS', hard_boundary_violations: [] },
    'autopilot.validation_submission.v2': { schema: 'autopilot.validation_submission.v2', validation_id: 'validation-1', assignment_id: 'assignment-1', scope: 'final', exact_commit: 'HEAD', exact_tree: 'tree', outcome: 'PASS', criterion_results: [{ criterion_id: 'criterion-1', verdict: 'PASS', evidence_refs: ['packed'], finding_ids: [], covered_paths: ['package.json'], semantic_surface_ids: [], forward_edge_ids: [] }], findings: [] },
    'autopilot.validation_submission.v3': { schema: 'autopilot.validation_submission.v3', criterion_results: [{ criterion_id: 'criterion-1', verdict: 'PASS', citation_refs: ['validation-source:packed'], finding_ids: [] }], findings: [] },
  };
  const sample = samples[boundary];
  if (sample === undefined) fail(`no valid payload sample for boundary ${boundary}`);
  return JSON.parse(JSON.stringify(sample));
}
async function loadRegisterInvokeMain(factory, stateRoot) {
  const commands = []; const commandDefs = new Map(); const tools = []; const hooks = new Map(); let providerCalls = 0;
  const host = {
    registerCommand: (name, definition) => { commands.push(name); commandDefs.set(name, definition); },
    registerTool: (tool) => { tools.push(tool); },
    sendUserMessage: async () => {}, sendMessage: async () => {}, appendEntry: () => {},
    on: (name, handler) => { hooks.set(name, handler); },
    setModel: async () => { providerCalls += 1; throw new Error('provider canary invoked'); },
    events: { backgroundTasks: { capabilities: async () => ({ available: true }), run: async () => { throw new Error('registration must not run tasks'); }, onTerminal: () => () => {} } },
  };
  const transport = { calls: [], async request(kind, payload, timeoutMs) { this.calls.push(timeoutMs === undefined ? { kind, payload } : { kind, payload, timeoutMs }); return { v: 1, id: this.calls.length, kind: 'done', payload: { status: 'ok' } }; }, close() {} };
  const backgroundTasks = { async capabilities() { return { api_version: 1, run: true, run_is_agent: true, run_completion_trigger: true, status: true, logs: true, logs_bounded: true, kill: true }; }, async run() { throw new Error('main alias proof must not launch background tasks'); }, onTerminal() { return () => {}; }, close() {} };
  await factory(host, { stateRoot, processIdentity: 'pid:packed-public-alias:1', transport, backgroundTasks });
  if (providerCalls !== 0) fail('extension invoked a provider during registration');
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_COMMANDS)) fail(`extension commands are not exact: ${commands.join(',')}`);
  await hooks.get('session_start')?.({ reason: 'startup' }, { hasUI: false, mode: 'json', sessionManager: { getSessionId: () => '019faf00-0000-7000-8000-000000000083' } });
  const activating = commandDefs.get('autopilot-plan');
  if (activating === undefined || typeof activating.handler !== 'function') fail('autopilot-plan activating command was not registered');
  await activating.handler('main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md', { hasUI: false, mode: 'json', sessionManager: { getSessionId: () => '019faf00-0000-7000-8000-000000000083' } });
  if (tools.length !== 7) fail(`main extension registered ${tools.length} planning submit tools after activation, expected 7`);
  for (const tool of tools) {
    const result = await tool.execute('packed-main-tool-call', validPayload(tool.details?.boundary_id ?? tool.parameters?.boundary_id ?? inferBoundaryFromToolName(tool.name)));
    if (result?.terminate !== true) fail(`main planning tool ${tool.name} did not terminate`);
  }
  return { command_count: commands.length, planning_tool_count: tools.length, command_frame_count: transport.calls.length };
}
function inferBoundaryFromToolName(name) {
  const map = {
    autopilot_submit_atoms: 'planning.task-atoms.v1',
    autopilot_submit_context: 'planning.scout-dossier.v1',
    autopilot_submit_scout_report: 'planning.scout-dossier.v1',
    autopilot_submit_resolution: 'planning.questions.v1',
    autopilot_submit_plan_cluster: 'planning.work-map.v1',
    autopilot_submit_synthesis: 'planning.work-map.v1',
    autopilot_submit_review: 'planning.plan-review.v1',
  };
  const boundary = map[name]; if (boundary === undefined) fail(`unknown planning tool ${name}`); return boundary;
}
async function loadRegisterInvokeChildren(factory) {
  const previousProfile = process.env.AUTOPILOT_TERMINAL_PROFILE;
  const previousBinding = process.env.AUTOPILOT_CARRIER_BINDING;
  const validationKeys = ['AUTOPILOT_VALIDATION_CONTEXT_PATH', 'AUTOPILOT_VALIDATION_CONTEXT_DIGEST', 'AUTOPILOT_VALIDATION_CWD'];
  const policyKeys = [...DELIVERY_ENV_KEYS, ...validationKeys];
  const previousPolicy = Object.fromEntries(policyKeys.map((key) => [key, process.env[key]]));
  const roots = []; const results = [];
  try {
    for (const profile of EXPECTED_CHILD_PROFILES) {
      process.env.AUTOPILOT_TERMINAL_PROFILE = profile;
      process.env.AUTOPILOT_CARRIER_BINDING = 'packed-public-alias-binding';
      for (const key of policyKeys) delete process.env[key];
      if (profile === 'delivery-status.v2') {
        const root = mkdtempSync(join(CANONICAL_TMP_ROOT, 'pi-autopilot-packed-delivery-policy-')); roots.push(root);
        const assignmentPath = join(root, 'assignment.v3.json'); const worktree = process.cwd(); const command = 'true';
        mkdirSync(join(worktree, 'packed-proof'));
        writeFileSync(join(worktree, 'packed-proof/policy.txt'), 'initial\n');
        const assignment = { schema: 'autopilot.delivery_assignment.v3', workstream: 'packed', assignment_id: 'assignment-packed-L1', lane_id: 'L1', attempt: 1, base_commit: '0123456789abcdef0123456789abcdef01234567', worktree, ordered_units: [{ id: 'U1', kind: 'implementation', files: ['packed-proof/policy.txt'], commands: [{ command, expected: 'Command exits successfully.' }], package_checks: [{ check_id: 'PKG-U1-TIP', kind: 'clean-exact-package-tip', criterion_ordinals: [1], expected: 'Core proves the exact clean package tip.' }] }], approved_commands: [{ command_id: 'CMD-U1-1', unit_id: 'U1', command_ordinal: 1, command_digest: createHash('sha256').update(`autopilot.approved_command.v1\0U1\0${1}\0${command}`).digest('hex') }] };
        const assignmentBytes = Buffer.from(JSON.stringify(assignment, null, 2)); writeFileSync(assignmentPath, assignmentBytes); const assignmentDigest = createHash('sha256').update(assignmentBytes).digest('hex');
        const policyDigest = createHash('sha256').update(`${DELIVERY_POLICY_VERSION}\0${assignmentPath}\0${assignmentDigest}\0${worktree}\0${worktree}`).digest('hex');
        Object.assign(process.env, { AUTOPILOT_DELIVERY_ASSIGNMENT_PATH: assignmentPath, AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST: assignmentDigest, AUTOPILOT_DELIVERY_WORKTREE: worktree, AUTOPILOT_DELIVERY_CWD: worktree, AUTOPILOT_DELIVERY_ASSIGNMENT_ID: assignment.assignment_id, AUTOPILOT_DELIVERY_WORKSTREAM: assignment.workstream, AUTOPILOT_DELIVERY_LANE_ID: assignment.lane_id, AUTOPILOT_DELIVERY_ATTEMPT: String(assignment.attempt), AUTOPILOT_DELIVERY_BASE_COMMIT: assignment.base_commit, AUTOPILOT_DELIVERY_POLICY_DIGEST: policyDigest });
      }
      if (profile === 'validation-status.v3') {
        const root = mkdtempSync(join(CANONICAL_TMP_ROOT, 'pi-autopilot-packed-v3-policy-')); roots.push(root);
        const diffPath = join(root, 'candidate.v3.diff'); const contextPath = join(root, 'context.v3.json');
        writeFileSync(diffPath, 'packed diff\n');
        const context = { schema: 'autopilot.validation_context.v3', validation_id: 'validation-packed', assignment_id: 'assignment-packed', authority_digest: '0'.repeat(64), criteria: [], citation_records: [{ evidence_ref: 'validation-source:packed', kind: 'source-snapshot', source_path: 'package.json', blob_digest: createHash('sha256').update(readFileSync('package.json')).digest('hex'), line_count: 1 }, { evidence_ref: 'validation-diff:packed', kind: 'candidate-diff', diff_digest: createHash('sha256').update(readFileSync(diffPath)).digest('hex'), diff_path: diffPath }] };
        const bytes = Buffer.from(JSON.stringify(context, null, 2)); writeFileSync(contextPath, bytes);
        process.env.AUTOPILOT_VALIDATION_CONTEXT_PATH = contextPath;
        process.env.AUTOPILOT_VALIDATION_CONTEXT_DIGEST = createHash('sha256').update(bytes).digest('hex');
        process.env.AUTOPILOT_VALIDATION_CWD = process.cwd();
      }
      const tools = []; const hooks = new Map(); const entries = [];
      const host = { registerTool: (tool) => { tools.push(tool); }, on: (name, handler) => { hooks.set(name, handler); }, appendEntry: (type, data) => { entries.push({ type, data }); }, getActiveTools: () => [...new Set(['read', ...tools.map((tool) => tool.name)])] };
      await factory(host);
      const expected = EXPECTED_CHILD_PROFILE_BINDINGS[profile];
      if (expected === undefined) fail(`child profile ${profile} has no independent expected binding`);
      const expectedTools = expected.tools ?? [expected.tool];
      const actualTools = tools.map((tool) => tool.name);
      if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) fail(`child profile ${profile} registered ${actualTools.join(',')}, expected ${expectedTools.join(',')}`);
      await hooks.get('session_start')?.();
      if (entries.length !== 1) fail(`child profile ${profile} did not append exactly one session_start receipt`);
      const receipt = entries[0].data;
      const expectedResult = expected.result ?? expected.boundary;
      if (receipt.profile_id !== profile || receipt.tool_name !== expected.tool || receipt.boundary_id !== expected.boundary || receipt.result_contract !== expectedResult) fail(`child profile ${profile} receipt identity drift`);
      const terminal = tools.find((tool) => tool.name === expected.tool);
      if (terminal === undefined) fail(`child profile ${profile} omitted exact terminal ${expected.tool}`);
      if (profile === 'delivery-status.v2') {
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        await byName.get('write').execute('packed-delivery-write', { path: 'packed-proof/policy.txt', content: 'written\n' });
        await byName.get('edit').execute('packed-delivery-edit', { path: 'packed-proof/policy.txt', edits: [{ oldText: 'written', newText: 'edited' }] });
        await byName.get('autopilot_run_approved_command').execute('packed-delivery-command', { command_id: 'CMD-U1-1' });
        if (readFileSync('packed-proof/policy.txt', 'utf8') !== 'edited\n') fail('delivery policy tools did not effect the exact approved consumer path');
      }
      const raw = validPayload(expected.boundary); const prepared = terminal.prepareArguments?.(raw) ?? raw;
      const result = await terminal.execute('packed-child-tool-call', prepared);
      if (result?.terminate !== true || result.details?.boundary_id !== expected.boundary) fail(`child profile ${profile} did not return terminating boundary ${expected.boundary}`);
      if (profile === 'validation-status.v3' && JSON.stringify(result.details?.payload) !== JSON.stringify(raw)) fail('v3 raw transport changed the model payload');
      results.push({ profile, tool: terminal.name, boundary: expected.boundary });
    }
  } finally {
    if (previousProfile === undefined) delete process.env.AUTOPILOT_TERMINAL_PROFILE; else process.env.AUTOPILOT_TERMINAL_PROFILE = previousProfile;
    if (previousBinding === undefined) delete process.env.AUTOPILOT_CARRIER_BINDING; else process.env.AUTOPILOT_CARRIER_BINDING = previousBinding;
    for (const key of policyKeys) { const value = previousPolicy[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  return results;
}
function installNetworkCanary(marker) {
  const require = createRequire(import.meta.url); const originals = [];
  const deny = (label) => { writeFileSync(marker, `${label}\n`, { flag: 'a' }); throw new Error(`network canary invoked: ${label}`); };
  for (const [moduleName, names] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:dgram', ['createSocket']]]) {
    const mod = require(moduleName); for (const name of names) { const original = mod[name]; originals.push(() => { mod[name] = original; }); mod[name] = () => deny(`${moduleName}.${name}`); }
  }
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => deny('global.fetch'); syncBuiltinESMExports();
  return () => { for (const restore of originals.reverse()) restore(); globalThis.fetch = originalFetch; syncBuiltinESMExports(); };
}
function enterOsNetworkSandbox() {
  const sentinel = 'AUTOPILOT_PACKED_NETWORK_SANDBOX';
  if (process.env[sentinel] === 'darwin-deny-network') {
    const probe = spawnSync(process.execPath, ['-e', `const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:9});socket.on('error',(error)=>process.exit(error.code==='EPERM'||error.code==='EACCES'?0:2));setTimeout(()=>process.exit(3),1000);`], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
    if (probe.error !== undefined || probe.signal !== null || probe.status !== 0) fail(`OS network-denial probe failed status=${String(probe.status)} signal=${String(probe.signal)} error=${probe.error?.message ?? '<none>'}`);
    return false;
  }
  if (process.platform !== 'darwin') fail(`packed zero-network witness requires an OS network-denial launcher, unsupported platform=${process.platform}`);
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath, ...process.argv.slice(1)], { env: { ...process.env, [sentinel]: 'darwin-deny-network' }, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) fail(`OS-network-sandboxed verifier failed status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? '<none>'}\n${result.stderr ?? ''}`);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return true;
}

async function main() {
  const tarballArg = process.argv[2];
  if (tarballArg === undefined || process.argv.length !== 3 || !isAbsolute(tarballArg)) fail('usage: node scripts/verify-packed-consumer.mjs <absolute-candidate-tarball>');
  const publicAliases = assertPublicAliasVersions();
  const tarInfo = lstatSync(tarballArg); if (!tarInfo.isFile() || tarInfo.isSymbolicLink()) fail('candidate tarball must be one regular non-symlink file');
  const tarball = realpathSync(tarballArg); if (under(sourceRoot, tarball)) fail('candidate tarball must be outside the source clone');
  const root = mkdtempSync(join(tmpdir(), 'pi-autopilot-packed-consumer-')); chmodSync(root, 0o700);
  const networkMarker = join(root, 'network-canary-invoked'); const networkPreload = join(root, 'deny-network.cjs');
  writeFileSync(networkPreload, `'use strict';\nconst fs=require('node:fs');const marker=${JSON.stringify(networkMarker)};const deny=(label)=>{fs.writeFileSync(marker,label+'\\n',{flag:'a'});throw new Error('network canary invoked: '+label)};for(const [n,fsx] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']]]){const m=require(n);for(const f of fsx)m[f]=()=>deny(n+'.'+f)}globalThis.fetch=async()=>deny('global.fetch');\n`);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'home', '.npmrc'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1', AUTOPILOT_STATE_ROOT: join(root, 'state'), NODE_OPTIONS: `--require=${networkPreload}` };
  for (const p of [env.HOME, env.TMPDIR, env.npm_config_cache, env.AUTOPILOT_STATE_ROOT]) mkdirSync(p, { recursive: true, mode: 0o700 });
  let summary;
  try {
    const project = join(root, 'project'); mkdirSync(project, { recursive: true, mode: 0o700 });
    checkedRun('npm', ['init', '-y'], project, env); checkedRun('npm', ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', tarball], project, env);
    const projectNodeModules = join(project, 'node_modules'); mkdirSync(join(projectNodeModules, '@earendil-works'), { recursive: true });
    symlinkSync(GLOBAL_PI_ROOT, join(projectNodeModules, '@earendil-works', 'pi-coding-agent'), 'dir'); symlinkSync(GLOBAL_TYPEBOX_ROOT, join(projectNodeModules, 'typebox'), 'dir');
    const installedRoot = realpathSync(join(project, 'node_modules', 'pi-autopilot')); assertNoPrivateRuntimeCopies(installedRoot);
    const manifestValue = JSON.parse(checkedRun('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], sourceRoot, env));
    if (!Array.isArray(manifestValue) || manifestValue.length !== 1 || !Array.isArray(manifestValue[0]?.files)) fail('candidate npm pack manifest is malformed');
    const extracted = join(root, 'extracted'); mkdirSync(extracted, { mode: 0o700 }); checkedRun('tar', ['-xzf', tarball, '-C', extracted], root, env);
    const installedManifest = assertInstalledManifest(join(extracted, 'package'), installedRoot, manifestValue[0].files);
    const restore = installNetworkCanary(networkMarker); const previousCwd = process.cwd();
    let mainProof; let childProof; let coreStatusProbe;
    try {
      process.chdir(project);
      const peerRequire = createRequire(join(projectNodeModules, '@earendil-works', 'pi-coding-agent', 'package.json'));
      const { createJiti } = peerRequire('jiti'); const jiti = createJiti(import.meta.url, { moduleCache: false });
      mainProof = await loadRegisterInvokeMain(await jiti.import(join(installedRoot, 'extensions', 'autopilot.ts'), { default: true }), join(root, 'main-state'));
      childProof = await loadRegisterInvokeChildren(await jiti.import(join(installedRoot, 'src', 'generated', 'child-extension.ts'), { default: true }));
      coreStatusProbe = runStatusFrameLaunch({ command: join(project, 'node_modules', '.bin', 'autopilot-core'), cwd: project, env, requestId: 1, timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
      const agentUsage = spawnSync(join(project, 'node_modules', '.bin', 'autopilot-agent-run'), ['--help'], { cwd: project, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (agentUsage.error !== undefined || agentUsage.signal !== null || agentUsage.status !== 1 || !/usage: autopilot-core agent-run --spec <absolute-spec\.json>/u.test(agentUsage.stderr)) fail(`installed autopilot-agent-run usage probe did not reach contained core status=${String(agentUsage.status)} signal=${String(agentUsage.signal)} error=${agentUsage.error?.message ?? '<none>'}\n${agentUsage.stderr}`);
      if (existsSync(networkMarker)) fail(`packed witness attempted network access: ${readFileSync(networkMarker, 'utf8').trim()}`);
    } finally {
      process.chdir(previousCwd);
      restore();
    }
    summary = { schema_version: 'autopilot.packed_consumer_witness.v3', candidate_tarball: { path: tarball, byte_count: tarInfo.size, sha256: sha256(readFileSync(tarball)) }, pi_peer: { source: 'global-public-alias', name: publicAliases.pi.name, version: publicAliases.pi.version, package_json_sha256: sha256(readFileSync(join(GLOBAL_PI_ROOT, 'package.json'))) }, typebox_peer: { source: 'global-pi-public-alias', name: publicAliases.typebox.name, version: publicAliases.typebox.version, package_json_sha256: sha256(readFileSync(join(GLOBAL_TYPEBOX_ROOT, 'package.json'))) }, installed_manifest: installedManifest, runtime_private_peer_copies: 0, commands: EXPECTED_COMMANDS, main_public_alias_proof: mainProof, child_public_alias_profiles: childProof, core_status_probe: coreStatusProbe, agent_run_usage: true, network_enforcement: 'darwin-sandbox-exec-deny-network', network_calls: 0, passed: true };
  } finally { rmSync(root, { recursive: true, force: false }); }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
if (!enterOsNetworkSandbox()) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
