#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ATTEMPT_ENV = 'AUTOPILOT_COORDINATOR_STARTUP_ATTEMPT_ID';
const ENTRYPOINT_ENV = 'AUTOPILOT_COORDINATOR_COMPILED_ENTRYPOINT';
const REPORT_SCHEMA = 'autopilot.coordinator_startup_report.v1';
const PACKAGE_VERSION = '1.2.0';
const MAX_ERROR_CODE_POINTS = 4_096;
const MAX_REPORT_BYTES = 32 * 1024;

interface BootstrapReport {
  readonly schema_version: typeof REPORT_SCHEMA;
  readonly attempt_id: string;
  readonly spawned_pid: number;
  readonly outcome: 'running' | 'failed';
  readonly phase: 'bootstrap/import';
  readonly selected_compiled_entrypoint: string;
  readonly exact_competing_lifecycle_owner_observed: false;
  readonly lifecycle: null;
  readonly error: string | null;
  readonly failure_code: null;
  readonly failure_class: null;
  readonly diagnostics_truncated: boolean;
  readonly omitted_code_points: number;
  readonly updated_at: string;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

function assertPhysicalPackageFile(packageRoot: string, target: string): void {
  if (!isContained(packageRoot, target)) throw new Error(`compiled coordinator entrypoint escapes package root: ${target}`);
  let cursor = packageRoot;
  const rootInfo = lstatSync(cursor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`coordinator package root is not physical: ${packageRoot}`);
  for (const segment of relative(packageRoot, target).split(/[\\/]/u)) {
    cursor = join(cursor, segment);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`compiled coordinator entrypoint contains a symbolic link: ${cursor}`);
  }
  if (!lstatSync(target).isFile()) throw new Error(`compiled coordinator entrypoint is not a regular file: ${target}`);
  const realRoot = realpathSync(packageRoot);
  const realTarget = realpathSync(target);
  if (realTarget !== join(realRoot, relative(packageRoot, target)) || !isContained(realRoot, realTarget)) throw new Error(`compiled coordinator entrypoint real path drifted: ${target}`);
}

function redact(value: string): string {
  const labels = 'session_token|capability|handoff_token|child_token|lock_token|freeze_token|lease_capability|fence_token|token';
  return value
    .replace(new RegExp(`\\b(${labels})(\\s*[=:]\\s*)[^\\s,;]+`, 'giu'), '$1$2<redacted>')
    .replace(new RegExp(`(\"(?:${labels})\"\\s*:\\s*\")[^\"]*(\")`, 'giu'), '$1<redacted>$2')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\uFFFD');
}

function boundedCause(error: unknown): { readonly text: string; readonly truncated: boolean; readonly omitted: number } {
  const raw = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
  const sanitized = redact(raw);
  const points = [...sanitized];
  if (points.length <= MAX_ERROR_CODE_POINTS) return { text: sanitized, truncated: false, omitted: 0 };
  const suffix = '…[truncated]';
  const retained = MAX_ERROR_CODE_POINTS - [...suffix].length;
  return { text: `${points.slice(0, retained).join('')}${suffix}`, truncated: true, omitted: points.length - retained };
}

function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`startup diagnostic directory is not physical: ${path}`);
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally { if (descriptor !== null) closeSync(descriptor); }
}

function writeReport(reportPath: string, report: BootstrapReport): void {
  const reportRoot = dirname(reportPath);
  const coordinatorRoot = dirname(reportRoot);
  const stateRoot = dirname(coordinatorRoot);
  assertPrivateDirectory(stateRoot);
  assertPrivateDirectory(coordinatorRoot);
  const realStateRoot = realpathSync(stateRoot);
  if (realpathSync(coordinatorRoot) !== join(realStateRoot, 'coordinator')) throw new Error('startup diagnostic coordinator root real path drifted');
  assertPrivateDirectory(reportRoot);
  if (realpathSync(reportRoot) !== join(realStateRoot, 'coordinator', 'startup-reports')) throw new Error('startup diagnostic report root real path drifted');
  const text = `${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) throw new Error('bootstrap startup report exceeded its package bound');
  try {
    const finalInfo = lstatSync(reportPath);
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) throw new Error(`startup diagnostic path is not a physical file: ${reportPath}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = join(reportRoot, `.${report.attempt_id}.json.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`);
  const descriptor = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error('bootstrap startup report temporary is not a regular file');
  } finally { closeSync(descriptor); }
  renameSync(temporary, reportPath);
  syncDirectory(reportRoot);
}

function bootstrapInputs(): { readonly coordinatorPath: string; readonly reportPath: string; readonly attemptId: string } {
  const attemptId = process.env[ATTEMPT_ENV];
  if (attemptId === undefined || !/^startup-[a-f0-9]{24,64}$/u.test(attemptId)) throw new Error('compiled coordinator bootstrap requires a valid startup attempt identity');
  const stateRootValue = process.env['AUTOPILOT_STATE_ROOT'];
  if (stateRootValue === undefined || !isAbsolute(stateRootValue)) throw new Error('compiled coordinator bootstrap requires an absolute state root');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const coordinatorPath = join(packageRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js');
  const selected = process.env[ENTRYPOINT_ENV];
  if (selected !== coordinatorPath) throw new Error(`compiled coordinator selection drifted: ${String(selected)}`);
  assertPhysicalPackageFile(packageRoot, fileURLToPath(import.meta.url));
  assertPhysicalPackageFile(packageRoot, coordinatorPath);
  const manifestPath = join(packageRoot, 'package.json');
  assertPhysicalPackageFile(packageRoot, manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Readonly<Record<string, unknown>>;
  if (manifest['name'] !== 'pi-autopilot' || manifest['version'] !== PACKAGE_VERSION) throw new Error('compiled coordinator bootstrap package identity drifted');
  return {
    coordinatorPath,
    reportPath: join(resolve(stateRootValue), 'coordinator', 'startup-reports', `${attemptId}.json`),
    attemptId,
  };
}

let inputs: ReturnType<typeof bootstrapInputs> | null = null;
try {
  inputs = bootstrapInputs();
  writeReport(inputs.reportPath, {
    schema_version: REPORT_SCHEMA,
    attempt_id: inputs.attemptId,
    spawned_pid: process.pid,
    outcome: 'running',
    phase: 'bootstrap/import',
    selected_compiled_entrypoint: inputs.coordinatorPath,
    exact_competing_lifecycle_owner_observed: false,
    lifecycle: null,
    error: null,
    failure_code: null,
    failure_class: null,
    diagnostics_truncated: false,
    omitted_code_points: 0,
    updated_at: new Date().toISOString(),
  });
  await import(pathToFileURL(inputs.coordinatorPath).href);
} catch (error) {
  if (inputs !== null) {
    const cause = boundedCause(error);
    try {
      writeReport(inputs.reportPath, {
        schema_version: REPORT_SCHEMA,
        attempt_id: inputs.attemptId,
        spawned_pid: process.pid,
        outcome: 'failed',
        phase: 'bootstrap/import',
        selected_compiled_entrypoint: inputs.coordinatorPath,
        exact_competing_lifecycle_owner_observed: false,
        lifecycle: null,
        error: cause.text,
        failure_code: null,
        failure_class: null,
        diagnostics_truncated: cause.truncated,
        omitted_code_points: cause.omitted,
        updated_at: new Date().toISOString(),
      });
    } catch { /* The parent still has the exact selected path from pre-spawn resolution. */ }
  }
  process.exitCode = 1;
}
