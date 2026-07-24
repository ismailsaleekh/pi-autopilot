import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { CoordinationRuntimeError } from './failures.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';

// D65 external operator signing boundary (freeze §9.3; fresh plan §2.2/§3.2).
//
// Production runtime NEVER possesses or reads the private signing key and NEVER
// self-signs policy, heartbeat, continuation, or capacity authority. This module
// defines the bounded, authenticated, fail-closed handoff between the runtime
// consumer (the launcher) and a real external operator/control-plane signer:
//
//   - the signer holds the mode-0600 PKCS#8 key OUTSIDE every clone/state/
//     session/evidence root and never invokes a model or paid API;
//   - the launcher asks the signer for a signed launch-policy candidate and,
//     later, for signed program-heartbeat candidates (initial + renewals) by
//     naming exactly which sealed identity and coordinator boundary to bind;
//   - the signer reads the LIVE coordinator status/doctor/policy/roster/status/
//     doctor identity itself, builds the canonical unsigned bytes, signs them
//     with the operator key, and writes the signed candidate to the exact
//     evidence path the runtime will consume;
//   - the runtime only VERIFIES and CONSUMES signed bytes.
//
// The signer is a distinct executable (`autopilot-launch-signer`), never a test
// helper and never an ordinary runtime module: the launcher spawns it and the
// signer's key access is completely separate from runtime authority. The
// interface below lets tests inject a signer double whose sign step is still
// performed by the same external CLI/producer contract, never by runtime code.

export const D65_LAUNCH_SIGNER_KIND_POLICY = 'launch-policy' as const;
export const D65_LAUNCH_SIGNER_KIND_HEARTBEAT = 'program-heartbeat' as const;

export interface D65LaunchSignerPolicyRequest {
  readonly kind: typeof D65_LAUNCH_SIGNER_KIND_POLICY;
  /** Absolute canonical roots of the isolated coordinator and Pi session. */
  readonly state_root: string;
  readonly session_root: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  /** The sealed policy id/path the launcher will register. */
  readonly policy_id: string;
  readonly policy_ref: string;
  /** The expected policy digest sealed in the launch manifest. */
  readonly expected_policy_sha256: `sha256:${string}`;
}

export interface D65LaunchSignerHeartbeatRequest {
  readonly kind: typeof D65_LAUNCH_SIGNER_KIND_HEARTBEAT;
  readonly state_root: string;
  readonly session_root: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  /** The graph sequence/digest this heartbeat must govern. */
  readonly graph_sequence: number;
  readonly graph_sha256: `sha256:${string}`;
  /** The exact next heartbeat sequence the signer must produce. */
  readonly heartbeat_sequence: number;
}

export type D65LaunchSignerRequest = D65LaunchSignerPolicyRequest | D65LaunchSignerHeartbeatRequest;

export interface D65LaunchSignerResult {
  /** The evidence-relative or worktree-relative ref the signer wrote. */
  readonly ref: string;
  /** The exact absolute path the signer wrote the signed candidate to. */
  readonly absolute_path: string;
  /** SHA-256 of the exact signed bytes the signer wrote. */
  readonly sha256: `sha256:${string}`;
  /** The exact byte count written. */
  readonly byte_count: number;
}

/**
 * The runtime-side handle to the external signer. Every method returns the exact
 * signed-candidate identity the runtime then verifies and consumes; it never
 * receives the private key or unsigned bytes to sign.
 */
export interface D65LaunchSigner {
  signLaunchPolicy(request: D65LaunchSignerPolicyRequest): Promise<D65LaunchSignerResult>;
  signProgramHeartbeat(request: D65LaunchSignerHeartbeatRequest): Promise<D65LaunchSignerResult>;
}

function bytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * A minimal, credential-free environment for the external signer subprocess. It
 * carries only the process-launch essentials (PATH/HOME/TMP) and the AUTOPILOT
 * state root the signer needs to reach the local coordinator; every provider
 * API key, OAuth token, and unrelated variable is stripped so the signer cannot
 * inherit paid/provider credentials or network authority.
 */
function minimalSignerEnv(env: ProcessEnvLike): Record<string, string> {
  const allow = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'AUTOPILOT_STATE_ROOT'];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/** Read a signer result file safely (no-follow, one-link, bounded, mode-checked). */
function readSignerCandidate(absolutePath: string, label: string): Uint8Array {
  if (!isAbsolute(absolutePath)) throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate path must be absolute`, [absolutePath]);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(absolutePath); }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate is missing`, [absolutePath, error instanceof Error ? error.message : String(error)]); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1_048_576) throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate must be a one-link no-follow regular file <=1 MiB`, [absolutePath]);
  const descriptor = openSync(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate descriptor identity changed while opening`, [absolutePath]);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

/**
 * The production signer: spawns the external `autopilot-launch-signer` CLI. The
 * CLI is configured OUT OF BAND (via its own `--key` argument that names the
 * operator-held PKCS#8 file); the runtime passes only the signing request as
 * JSON on argv and reads the CLI's single JSON result line. The runtime never
 * sees the key path.
 */
export class SpawnedD65LaunchSigner implements D65LaunchSigner {
  readonly #command: string;
  readonly #baseArgs: readonly string[];
  readonly #env: ProcessEnvLike;
  readonly #timeoutMs: number;

  constructor(input: { readonly command: string; readonly baseArgs?: readonly string[]; readonly env?: ProcessEnvLike; readonly timeoutMs?: number }) {
    this.#command = input.command;
    this.#baseArgs = Object.freeze([...(input.baseArgs ?? [])]);
    this.#env = input.env ?? process.env;
    this.#timeoutMs = input.timeoutMs ?? 120_000;
  }

  async signLaunchPolicy(request: D65LaunchSignerPolicyRequest): Promise<D65LaunchSignerResult> {
    return await this.#invoke(request);
  }

  async signProgramHeartbeat(request: D65LaunchSignerHeartbeatRequest): Promise<D65LaunchSignerResult> {
    return await this.#invoke(request);
  }

  async #invoke(request: D65LaunchSignerRequest): Promise<D65LaunchSignerResult> {
    const requestJson = JSON.stringify(request);
    const result = await new Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null; readonly signal: string | null }>((resolveInvoke, rejectInvoke) => {
      // The signer must never inherit model/provider/network credentials. It is
      // spawned with a MINIMAL, credential-free environment: only PATH/HOME/TMP
      // and the AUTOPILOT state root it needs to reach the local coordinator. No
      // provider API keys, tokens, or arbitrary environment leak into it.
      const child = spawn(this.#command, [...this.#baseArgs, '--request', requestJson], { env: minimalSignerEnv(this.#env), stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); rejectInvoke(new CoordinationRuntimeError('coordinator-contention', 'external launch signer timed out')); } }, this.#timeoutMs);
      child.stdout.on('data', (chunk) => { if (stdoutBytes < 1_048_576) { stdoutChunks.push(new Uint8Array(chunk)); stdoutBytes += chunk.length; } });
      child.stderr.on('data', (chunk) => { if (stderrBytes < 262_144) { stderrChunks.push(new Uint8Array(chunk)); stderrBytes += chunk.length; } });
      child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectInvoke(new CoordinationRuntimeError('invalid-state', 'external launch signer could not be spawned', [error instanceof Error ? error.message : String(error)])); } });
      child.on('close', (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolveInvoke({ stdout: Buffer.from(Buffer.concat(stdoutChunks)).toString('utf8'), stderr: Buffer.from(Buffer.concat(stderrChunks)).toString('utf8'), code, signal }); } });
    });
    if (result.code !== 0 || result.signal !== null) throw new CoordinationRuntimeError('invalid-state', 'external launch signer failed', [`code=${String(result.code)}`, `signal=${String(result.signal)}`, result.stderr.slice(0, 4096)]);
    const parsed = parseSignerResultLine(result.stdout);
    // Independently verify the signer wrote exactly the bytes it reports.
    const candidateBytes = readSignerCandidate(parsed.absolute_path, 'launch signer');
    if (candidateBytes.byteLength !== parsed.byte_count) throw new CoordinationRuntimeError('invalid-state', 'launch signer byte count differs from the written candidate', [String(candidateBytes.byteLength), String(parsed.byte_count)]);
    if (bytesSha256(candidateBytes) !== parsed.sha256) throw new CoordinationRuntimeError('invalid-state', 'launch signer digest differs from the written candidate');
    return Object.freeze({ ref: parsed.ref, absolute_path: parsed.absolute_path, sha256: parsed.sha256, byte_count: parsed.byte_count });
  }
}

interface SignerResultLine {
  readonly ref: string;
  readonly absolute_path: string;
  readonly sha256: `sha256:${string}`;
  readonly byte_count: number;
}

/** Parse and validate the signer CLI's single JSON result line. */
export function parseSignerResultLine(stdout: string): SignerResultLine {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.length > 8192) throw new CoordinationRuntimeError('invalid-state', 'external launch signer produced no bounded result');
  let value: unknown;
  try { value = JSON.parse(trimmed) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', 'external launch signer result is not JSON', [error instanceof Error ? error.message : String(error)]); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result is not an object');
  const record = value as Record<string, unknown>;
  const expected = ['schema_version', 'ref', 'absolute_path', 'sha256', 'byte_count'];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || expected.slice().sort().some((field, index) => keys[index] !== field)) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result has unexpected fields', keys);
  if (record['schema_version'] !== 'autopilot.launch_signer_result.v1') throw new CoordinationRuntimeError('invalid-state', 'external launch signer result schema is wrong');
  const ref = record['ref'];
  const absolute = record['absolute_path'];
  const sha = record['sha256'];
  const byteCount = record['byte_count'];
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result ref is invalid');
  if (typeof absolute !== 'string' || !isAbsolute(absolute)) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result absolute_path is invalid');
  if (typeof sha !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(sha)) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result sha256 is invalid');
  if (typeof byteCount !== 'number' || !Number.isSafeInteger(byteCount) || byteCount < 1) throw new CoordinationRuntimeError('invalid-state', 'external launch signer result byte_count is invalid');
  return Object.freeze({ ref, absolute_path: absolute, sha256: sha as `sha256:${string}`, byte_count: byteCount });
}
