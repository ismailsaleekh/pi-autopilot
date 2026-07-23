import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { readImmutableFileBytes } from './immutable-file.ts';
import { type S2RetentionPolicy, type S2RetentionTerminalKind } from './s2-retention-policy.ts';

export interface S2TerminalProofPublicationInput {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly terminalEventSeq: number;
  readonly terminalKind: S2RetentionTerminalKind;
  readonly terminalProof: Readonly<Record<string, unknown>>;
  readonly archiveRoot: string;
  readonly hotRoot: string;
  readonly policy: S2RetentionPolicy;
  readonly nowIso: string;
}

export interface S2ColdTerminalProof {
  readonly schema_version: 'autopilot.s2_retention.cold_terminal_proof.v1';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly terminal_event_seq: number;
  readonly terminal_kind: S2RetentionTerminalKind;
  readonly terminal_proof_sha256: string;
  readonly proof: Readonly<Record<string, unknown>>;
  readonly policy_id: string;
  readonly published_at: string;
}

export interface S2HotTerminalProofSummary {
  readonly schema_version: 'autopilot.s2_retention.hot_terminal_summary.v1';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly terminal_event_seq: number;
  readonly terminal_kind: S2RetentionTerminalKind;
  readonly terminal_proof_sha256: string;
  readonly cold_archive_sha256: string;
  readonly cold_archive_relpath: string;
  readonly policy_id: string;
  readonly verified_at: string;
}

export interface S2TerminalProofPublication {
  readonly coldArchivePath: string;
  readonly hotSummaryPath: string;
  readonly coldArchiveSha256: string;
  readonly coldArchiveRelpath: string;
  readonly terminalProofSha256: string;
  readonly hotSummaryBytes: number;
  readonly coldArchiveVerified: boolean;
  readonly hotEligible: boolean;
}

export interface S2ColdTerminalProofExpectedIdentity {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly terminalEventSeq: number;
  readonly terminalKind: S2RetentionTerminalKind;
}

export interface S2ColdTerminalProofVerification {
  readonly archivePath: string;
  readonly coldArchiveSha256: string;
  readonly terminalProofSha256: string;
  readonly proof: S2ColdTerminalProof;
}

function sha256HexUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256HexBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeSeq(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('terminal_event_seq must be a non-negative safe integer');
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requiredSeq(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative safe integer`);
  return value;
}

function assertExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) throw new Error(`${label} fields are not the exact closed contract`);
}

function assertSha256Hex(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase sha256 hex digest`);
}

function parseTerminalKind(value: string): S2RetentionTerminalKind {
  if (value === 'closed' || value === 'aborted' || value === 'failed') return value;
  throw new Error('terminal_kind is invalid');
}

function parseColdTerminalProof(bytes: Uint8Array): S2ColdTerminalProof {
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isJsonRecord(parsed)) throw new Error('cold terminal proof must be a JSON object');
  assertExactKeys(parsed, ['policy_id', 'proof', 'published_at', 'repo_id', 'schema_version', 'terminal_event_seq', 'terminal_kind', 'terminal_proof_sha256', 'workstream_run'], 'cold terminal proof');
  const proof = parsed['proof'];
  if (!isJsonRecord(proof)) throw new Error('cold terminal proof payload must be a JSON object');
  const terminalProofSha256 = requiredString(parsed, 'terminal_proof_sha256');
  assertSha256Hex(terminalProofSha256, 'terminal_proof_sha256');
  return {
    schema_version: requiredString(parsed, 'schema_version') === 'autopilot.s2_retention.cold_terminal_proof.v1' ? 'autopilot.s2_retention.cold_terminal_proof.v1' : (() => { throw new Error('cold terminal proof schema_version is invalid'); })(),
    repo_id: requiredString(parsed, 'repo_id'),
    workstream_run: requiredString(parsed, 'workstream_run'),
    terminal_event_seq: requiredSeq(parsed, 'terminal_event_seq'),
    terminal_kind: parseTerminalKind(requiredString(parsed, 'terminal_kind')),
    terminal_proof_sha256: terminalProofSha256,
    proof,
    policy_id: requiredString(parsed, 'policy_id'),
    published_at: requiredString(parsed, 'published_at'),
  };
}

async function observeS2RetentionBoundary(boundary: string): Promise<void> {
  if (process.env['AUTOPILOT_S2_RETENTION_TEST_BOUNDARY'] !== boundary) return;
  const marker = process.env['AUTOPILOT_S2_RETENTION_TEST_MARKER'];
  if (marker !== undefined && marker.length > 0) await writeFile(marker, `${boundary}\n`, { flag: 'w', mode: 0o600 });
  await new Promise<never>(() => undefined);
}

async function atomicWriteUtf8(path: string, contents: string, label: 'cold-archive' | 'hot-summary'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const parentStat = await lstat(dirname(path));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('publication parent must be a non-symbolic directory');
  const temporary = join(dirname(path), `.${basename(path)}.${sha256HexUtf8(`${path}:${contents}`).slice(0, 16)}.tmp`);
  await rm(temporary, { force: true });
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await observeS2RetentionBoundary(`s2-${label}-after-write`);
  const handle = await open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await observeS2RetentionBoundary(`s2-${label}-after-fsync`);
  await rename(temporary, path);
  await observeS2RetentionBoundary(`s2-${label}-after-rename`);
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function containedRelpath(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.length === 0 || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || rel.split(/[\\/]/u).includes('..')) throw new Error('archive path escaped its root');
  return rel;
}

function deterministicArchiveStamp(input: S2TerminalProofPublicationInput): string {
  return `deterministic:${sha256HexUtf8(canonicalJson({ repo_id: input.repoId, workstream_run: input.workstreamRun, terminal_event_seq: input.terminalEventSeq, terminal_kind: input.terminalKind, policy_id: input.policy.policy_id, terminal_proof_sha256: sha256HexUtf8(canonicalJson(input.terminalProof)) }))}`;
}

function assertExpectedIdentity(proof: S2ColdTerminalProof, expected: S2ColdTerminalProofExpectedIdentity, policy: S2RetentionPolicy): void {
  if (proof.repo_id !== expected.repoId) throw new Error('cold archive repo_id mismatch');
  if (proof.workstream_run !== expected.workstreamRun) throw new Error('cold archive workstream_run mismatch');
  if (proof.terminal_event_seq !== expected.terminalEventSeq) throw new Error('cold archive terminal_event_seq mismatch');
  if (proof.terminal_kind !== expected.terminalKind) throw new Error('cold archive terminal_kind mismatch');
  if (proof.policy_id !== policy.policy_id) throw new Error('cold archive policy_id mismatch');
}

function archivePathFor(input: S2TerminalProofPublicationInput, archiveSha256: string): string {
  const runKey = sha256HexUtf8(canonicalJson({ repo_id: input.repoId, workstream_run: input.workstreamRun }));
  return join(input.archiveRoot, 'terminal-proofs', runKey, `${archiveSha256}.json`);
}

function hotSummaryPathFor(input: S2TerminalProofPublicationInput): string {
  const runKey = sha256HexUtf8(canonicalJson({ repo_id: input.repoId, workstream_run: input.workstreamRun }));
  return join(input.hotRoot, 'terminal-proofs', `${runKey}.summary.json`);
}

export function buildS2ColdTerminalProof(input: S2TerminalProofPublicationInput): S2ColdTerminalProof {
  assertSafeSeq(input.terminalEventSeq);
  return {
    schema_version: 'autopilot.s2_retention.cold_terminal_proof.v1',
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    terminal_event_seq: input.terminalEventSeq,
    terminal_kind: input.terminalKind,
    terminal_proof_sha256: sha256HexUtf8(canonicalJson(input.terminalProof)),
    proof: input.terminalProof,
    policy_id: input.policy.policy_id,
    published_at: deterministicArchiveStamp(input),
  };
}

export function verifyS2ColdTerminalProof(input: {
  readonly archivePath: string;
  readonly expectedColdArchiveSha256: string;
  readonly policy: S2RetentionPolicy;
  readonly expected: S2ColdTerminalProofExpectedIdentity;
}): S2ColdTerminalProofVerification {
  const bytes = readImmutableFileBytes({ path: input.archivePath, maximumBytes: input.policy.cold_terminal_proof_max_bytes, label: 's2 cold terminal proof' });
  const actualArchiveSha256 = sha256HexBytes(bytes);
  if (actualArchiveSha256 !== input.expectedColdArchiveSha256) throw new Error('cold archive sha256 mismatch');
  const parsed = parseColdTerminalProof(bytes);
  assertExpectedIdentity(parsed, input.expected, input.policy);
  const proofSha256 = sha256HexUtf8(canonicalJson(parsed.proof));
  if (proofSha256 !== parsed.terminal_proof_sha256) throw new Error('terminal proof sha256 mismatch');
  const canonicalArchiveSha256 = sha256HexUtf8(canonicalJson(parsed));
  if (canonicalArchiveSha256 !== input.expectedColdArchiveSha256) throw new Error('cold archive canonical sha256 mismatch');
  return { archivePath: input.archivePath, coldArchiveSha256: actualArchiveSha256, terminalProofSha256: proofSha256, proof: parsed };
}

export async function publishS2ColdTerminalProof(input: S2TerminalProofPublicationInput): Promise<S2TerminalProofPublication> {
  const proof = buildS2ColdTerminalProof(input);
  const archiveBytes = canonicalJson(proof);
  const archiveSha256 = sha256HexUtf8(archiveBytes);
  if (Buffer.byteLength(archiveBytes, 'utf8') > input.policy.cold_terminal_proof_max_bytes) throw new Error('cold terminal proof exceeds policy byte limit');
  const archivePath = archivePathFor(input, archiveSha256);
  await mkdir(dirname(archivePath), { recursive: true });
  try {
    await stat(archivePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') await atomicWriteUtf8(archivePath, archiveBytes, 'cold-archive');
    else throw error;
  }
  const verified = verifyS2ColdTerminalProof({ archivePath, expectedColdArchiveSha256: archiveSha256, policy: input.policy, expected: { repoId: input.repoId, workstreamRun: input.workstreamRun, terminalEventSeq: input.terminalEventSeq, terminalKind: input.terminalKind } });
  const summary: S2HotTerminalProofSummary = {
    schema_version: 'autopilot.s2_retention.hot_terminal_summary.v1',
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    terminal_event_seq: input.terminalEventSeq,
    terminal_kind: input.terminalKind,
    terminal_proof_sha256: verified.terminalProofSha256,
    cold_archive_sha256: verified.coldArchiveSha256,
    cold_archive_relpath: containedRelpath(input.archiveRoot, archivePath),
    policy_id: input.policy.policy_id,
    verified_at: deterministicArchiveStamp(input),
  };
  const summaryBytes = canonicalJson(summary);
  const hotBytes = Buffer.byteLength(summaryBytes, 'utf8');
  if (hotBytes > input.policy.hot_terminal_summary_max_bytes) throw new Error('hot terminal summary exceeds policy byte limit');
  const summaryPath = hotSummaryPathFor(input);
  let summaryExists = false;
  try {
    await stat(summaryPath);
    readImmutableFileBytes({ path: summaryPath, maximumBytes: input.policy.hot_terminal_summary_max_bytes, label: 's2 hot terminal summary' });
    summaryExists = true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') summaryExists = false;
    else throw error;
  }
  if (summaryExists) {
    const existing = new TextDecoder().decode(readImmutableFileBytes({ path: summaryPath, maximumBytes: input.policy.hot_terminal_summary_max_bytes, label: 's2 hot terminal summary' }));
    if (existing !== summaryBytes) throw new Error('hot terminal summary already binds a different verified cold archive');
  } else await atomicWriteUtf8(summaryPath, summaryBytes, 'hot-summary');
  return { coldArchivePath: archivePath, hotSummaryPath: summaryPath, coldArchiveSha256: archiveSha256, coldArchiveRelpath: containedRelpath(input.archiveRoot, archivePath), terminalProofSha256: verified.terminalProofSha256, hotSummaryBytes: hotBytes, coldArchiveVerified: true, hotEligible: true };
}

export async function recoverS2ColdTerminalProofPublication(input: S2TerminalProofPublicationInput): Promise<S2TerminalProofPublication> {
  return publishS2ColdTerminalProof(input);
}

export async function discardInterruptedS2ColdArchiveTemps(root: string): Promise<readonly string[]> {
  const removed: string[] = [];
  async function visit(directory: string): Promise<void> {
    try {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('cold archive temp cleanup root must stay a non-symbolic directory');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('cold archive temp cleanup refuses symlink entries');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await rm(path, { force: true });
        removed.push(path);
      }
    }
  }
  await visit(root);
  return removed;
}

export async function readS2HotTerminalProofSummary(input: { readonly path: string; readonly policy: S2RetentionPolicy }): Promise<S2HotTerminalProofSummary> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(readImmutableFileBytes({ path: input.path, maximumBytes: input.policy.hot_terminal_summary_max_bytes, label: 's2 hot terminal summary' })));
  if (!isJsonRecord(parsed)) throw new Error('hot terminal summary must be a JSON object');
  assertExactKeys(parsed, ['cold_archive_relpath', 'cold_archive_sha256', 'policy_id', 'repo_id', 'schema_version', 'terminal_event_seq', 'terminal_kind', 'terminal_proof_sha256', 'verified_at', 'workstream_run'], 'hot terminal summary');
  const terminalProofSha256 = requiredString(parsed, 'terminal_proof_sha256');
  const coldArchiveSha256 = requiredString(parsed, 'cold_archive_sha256');
  assertSha256Hex(terminalProofSha256, 'terminal_proof_sha256');
  assertSha256Hex(coldArchiveSha256, 'cold_archive_sha256');
  return {
    schema_version: requiredString(parsed, 'schema_version') === 'autopilot.s2_retention.hot_terminal_summary.v1' ? 'autopilot.s2_retention.hot_terminal_summary.v1' : (() => { throw new Error('hot terminal summary schema_version is invalid'); })(),
    repo_id: requiredString(parsed, 'repo_id'),
    workstream_run: requiredString(parsed, 'workstream_run'),
    terminal_event_seq: requiredSeq(parsed, 'terminal_event_seq'),
    terminal_kind: parseTerminalKind(requiredString(parsed, 'terminal_kind')),
    terminal_proof_sha256: terminalProofSha256,
    cold_archive_sha256: coldArchiveSha256,
    cold_archive_relpath: requiredString(parsed, 'cold_archive_relpath'),
    policy_id: requiredString(parsed, 'policy_id'),
    verified_at: requiredString(parsed, 'verified_at'),
  };
}

export async function verifyS2HotTerminalProofSummary(input: {
  readonly summaryPath: string;
  readonly archiveRoot: string;
  readonly policy: S2RetentionPolicy;
  readonly expected: S2ColdTerminalProofExpectedIdentity;
}): Promise<S2HotTerminalProofSummary> {
  const summary = await readS2HotTerminalProofSummary({ path: input.summaryPath, policy: input.policy });
  if (summary.repo_id !== input.expected.repoId) throw new Error('hot summary repo_id mismatch');
  if (summary.workstream_run !== input.expected.workstreamRun) throw new Error('hot summary workstream_run mismatch');
  if (summary.terminal_event_seq !== input.expected.terminalEventSeq) throw new Error('hot summary terminal_event_seq mismatch');
  if (summary.terminal_kind !== input.expected.terminalKind) throw new Error('hot summary terminal_kind mismatch');
  if (summary.policy_id !== input.policy.policy_id) throw new Error('hot summary policy_id mismatch');
  const archivePath = resolve(input.archiveRoot, summary.cold_archive_relpath);
  const rel = containedRelpath(input.archiveRoot, archivePath);
  if (rel !== summary.cold_archive_relpath) throw new Error('hot summary cold archive relpath is not canonical');
  const verified = verifyS2ColdTerminalProof({ archivePath, expectedColdArchiveSha256: summary.cold_archive_sha256, policy: input.policy, expected: input.expected });
  if (verified.terminalProofSha256 !== summary.terminal_proof_sha256) throw new Error('hot summary terminal proof sha256 mismatch');
  return summary;
}
