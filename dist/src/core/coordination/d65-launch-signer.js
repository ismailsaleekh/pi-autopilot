import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CoordinationRuntimeError } from "./failures.js";
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
export const D65_LAUNCH_SIGNER_KIND_POLICY = 'launch-policy';
export const D65_LAUNCH_SIGNER_KIND_HEARTBEAT = 'program-heartbeat';
function bytesSha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Read a signer result file safely (no-follow, one-link, bounded, mode-checked). */
function readSignerCandidate(absolutePath, label) {
    if (!isAbsolute(absolutePath))
        throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate path must be absolute`, [absolutePath]);
    let before;
    try {
        before = lstatSync(absolutePath);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate is missing`, [absolutePath, error instanceof Error ? error.message : String(error)]);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1_048_576)
        throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate must be a one-link no-follow regular file <=1 MiB`, [absolutePath]);
    const descriptor = openSync(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new CoordinationRuntimeError('invalid-state', `${label} signer candidate descriptor identity changed while opening`, [absolutePath]);
        return readFileSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
/**
 * The production signer: spawns the external `autopilot-launch-signer` CLI. The
 * CLI is configured OUT OF BAND (via its own `--key` argument that names the
 * operator-held PKCS#8 file); the runtime passes only the signing request as
 * JSON on argv and reads the CLI's single JSON result line. The runtime never
 * sees the key path.
 */
export class SpawnedD65LaunchSigner {
    #command;
    #baseArgs;
    #env;
    #timeoutMs;
    constructor(input) {
        this.#command = input.command;
        this.#baseArgs = Object.freeze([...(input.baseArgs ?? [])]);
        this.#env = input.env ?? process.env;
        this.#timeoutMs = input.timeoutMs ?? 120_000;
    }
    async signLaunchPolicy(request) {
        return await this.#invoke(request);
    }
    async signProgramHeartbeat(request) {
        return await this.#invoke(request);
    }
    async #invoke(request) {
        const requestJson = JSON.stringify(request);
        const result = await new Promise((resolveInvoke, rejectInvoke) => {
            // The signer must never inherit model/provider/network credentials.
            const child = spawn(this.#command, [...this.#baseArgs, '--request', requestJson], { env: { ...this.#env }, stdio: ['ignore', 'pipe', 'pipe'] });
            const stdoutChunks = [];
            const stderrChunks = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;
            const timer = setTimeout(() => { if (!settled) {
                settled = true;
                child.kill('SIGKILL');
                rejectInvoke(new CoordinationRuntimeError('coordinator-contention', 'external launch signer timed out'));
            } }, this.#timeoutMs);
            child.stdout.on('data', (chunk) => { if (stdoutBytes < 1_048_576) {
                stdoutChunks.push(new Uint8Array(chunk));
                stdoutBytes += chunk.length;
            } });
            child.stderr.on('data', (chunk) => { if (stderrBytes < 262_144) {
                stderrChunks.push(new Uint8Array(chunk));
                stderrBytes += chunk.length;
            } });
            child.on('error', (error) => { if (!settled) {
                settled = true;
                clearTimeout(timer);
                rejectInvoke(new CoordinationRuntimeError('invalid-state', 'external launch signer could not be spawned', [error instanceof Error ? error.message : String(error)]));
            } });
            child.on('close', (code, signal) => { if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolveInvoke({ stdout: Buffer.from(Buffer.concat(stdoutChunks)).toString('utf8'), stderr: Buffer.from(Buffer.concat(stderrChunks)).toString('utf8'), code, signal });
            } });
        });
        if (result.code !== 0 || result.signal !== null)
            throw new CoordinationRuntimeError('invalid-state', 'external launch signer failed', [`code=${String(result.code)}`, `signal=${String(result.signal)}`, result.stderr.slice(0, 4096)]);
        const parsed = parseSignerResultLine(result.stdout);
        // Independently verify the signer wrote exactly the bytes it reports.
        const candidateBytes = readSignerCandidate(parsed.absolute_path, 'launch signer');
        if (candidateBytes.byteLength !== parsed.byte_count)
            throw new CoordinationRuntimeError('invalid-state', 'launch signer byte count differs from the written candidate', [String(candidateBytes.byteLength), String(parsed.byte_count)]);
        if (bytesSha256(candidateBytes) !== parsed.sha256)
            throw new CoordinationRuntimeError('invalid-state', 'launch signer digest differs from the written candidate');
        return Object.freeze({ ref: parsed.ref, absolute_path: parsed.absolute_path, sha256: parsed.sha256, byte_count: parsed.byte_count });
    }
}
/** Parse and validate the signer CLI's single JSON result line. */
export function parseSignerResultLine(stdout) {
    const trimmed = stdout.trim();
    if (trimmed.length === 0 || trimmed.length > 8192)
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer produced no bounded result');
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result is not JSON', [error instanceof Error ? error.message : String(error)]);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result is not an object');
    const record = value;
    const expected = ['schema_version', 'ref', 'absolute_path', 'sha256', 'byte_count'];
    const keys = Object.keys(record).sort();
    if (keys.length !== expected.length || expected.slice().sort().some((field, index) => keys[index] !== field))
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result has unexpected fields', keys);
    if (record['schema_version'] !== 'autopilot.launch_signer_result.v1')
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result schema is wrong');
    const ref = record['ref'];
    const absolute = record['absolute_path'];
    const sha = record['sha256'];
    const byteCount = record['byte_count'];
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512)
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result ref is invalid');
    if (typeof absolute !== 'string' || !isAbsolute(absolute))
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result absolute_path is invalid');
    if (typeof sha !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(sha))
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result sha256 is invalid');
    if (typeof byteCount !== 'number' || !Number.isSafeInteger(byteCount) || byteCount < 1)
        throw new CoordinationRuntimeError('invalid-state', 'external launch signer result byte_count is invalid');
    return Object.freeze({ ref, absolute_path: absolute, sha256: sha, byte_count: byteCount });
}
