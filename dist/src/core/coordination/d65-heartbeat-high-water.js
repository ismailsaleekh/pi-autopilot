import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJson } from "./canonical-json.js";
import { D65_HEARTBEAT_HIGH_WATER_SCHEMA, parseD65HeartbeatHighWater, } from "./d65-launch-policy.js";
import { CoordinationRuntimeError } from "./failures.js";
export const D65_HEARTBEAT_HIGH_WATER_DIRECTORY = 'program-heartbeat-high-water';
export function d65HeartbeatHighWaterPath(programEvidenceRoot, workstreamRun) {
    return join(programEvidenceRoot, D65_HEARTBEAT_HIGH_WATER_DIRECTORY, `${workstreamRun}.json`);
}
function fail(issue, evidence = []) {
    throw new CoordinationRuntimeError('invalid-state', `D65 heartbeat high-water cache invalid: ${issue}`, [...evidence]);
}
function canonicalBytes(value) {
    return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}
function equalBytes(left, right) {
    if (left.byteLength !== right.byteLength)
        return false;
    for (let index = 0; index < left.byteLength; index += 1)
        if (left[index] !== right[index])
            return false;
    return true;
}
function assertPrivateDirectory(path, label) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1 || (stat.mode & 0o777) !== 0o700)
        fail(`${label} must be a no-follow directory with exact mode 0700`, [path]);
}
function assertCachePath(programEvidenceRoot, allowMissingDirectory) {
    assertPrivateDirectory(programEvidenceRoot, 'program evidence root');
    const directory = join(programEvidenceRoot, D65_HEARTBEAT_HIGH_WATER_DIRECTORY);
    try {
        assertPrivateDirectory(directory, 'cache directory');
    }
    catch (error) {
        if (allowMissingDirectory && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
            return;
        throw error;
    }
}
function parseBytes(bytes, path) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (error) {
        fail('cache is not valid UTF-8', [path, error instanceof Error ? error.message : String(error)]);
    }
    if (!text.endsWith('\n') || text.endsWith('\n\n'))
        fail('cache is not canonical JSON plus exactly one LF', [path]);
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        fail('cache is not valid JSON', [path, error instanceof Error ? error.message : String(error)]);
    }
    const parsed = parseD65HeartbeatHighWater(value);
    if (!equalBytes(bytes, canonicalBytes(parsed)))
        fail('cache bytes are not RFC-8785 canonical JSON plus LF', [path]);
    return parsed;
}
/** Stable no-follow, one-link, mode-0600 cache read. Missing is explicit null. */
export function readD65HeartbeatHighWater(programEvidenceRoot, workstreamRun) {
    assertCachePath(programEvidenceRoot, true);
    const path = d65HeartbeatHighWaterPath(programEvidenceRoot, workstreamRun);
    let before;
    try {
        before = lstatSync(path);
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600)
        fail('cache must be one-link, no-follow, regular mode 0600', [path]);
    let descriptor = null;
    try {
        descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size > 1_048_576)
            fail('cache descriptor identity or size is invalid', [path]);
        const bytes = readFileSync(descriptor);
        const afterDescriptor = fstatSync(descriptor);
        const afterPath = lstatSync(path);
        if (afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.nlink !== 1)
            fail('cache changed during stable read', [path]);
        return parseBytes(bytes, path);
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
    }
}
function cacheFromHead(head) {
    return Object.freeze({ schema_version: D65_HEARTBEAT_HIGH_WATER_SCHEMA, program_id: head.program_id, repo_id: head.repo_id, workstream_run: head.workstream_run, sequence: head.sequence, heartbeat_sha256: head.heartbeat_sha256, issued_at: head.issued_at, valid_until: head.valid_until, updated_at: head.coordinator_time });
}
function fsyncDirectory(path) {
    if (platform() === 'win32')
        return;
    const descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function writeAtomic(path, bytes) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    assertPrivateDirectory(dirname(path), 'cache directory');
    const temp = `${path}.tmp-${String(process.pid)}-${randomBytes(12).toString('hex')}`;
    let descriptor = null;
    try {
        descriptor = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        let offset = 0;
        while (offset < bytes.byteLength)
            offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
        fsyncSync(descriptor);
        const written = fstatSync(descriptor);
        if (!written.isFile() || written.nlink !== 1 || (written.mode & 0o777) !== 0o600 || written.size !== bytes.byteLength)
            fail('temporary cache descriptor postcondition failed', [temp]);
        closeSync(descriptor);
        descriptor = null;
        renameSync(temp, path);
        fsyncDirectory(path);
        const final = readD65HeartbeatHighWater(dirname(dirname(path)), path.slice(dirname(path).length + 1, -'.json'.length));
        if (final === null || !equalBytes(canonicalBytes(final), bytes))
            fail('renamed cache postcondition failed', [path]);
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
        try {
            unlinkSync(temp);
        }
        catch (error) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
    }
}
/**
 * Reconstruct/repair from the durable coordinator head only. `verifyExternal`
 * must reopen and authenticate the exact accepted external record; cache bytes
 * never lower or grant authority. A newer/divergent cache is terminal.
 */
export function reconcileD65HeartbeatHighWater(input) {
    input.verifyExternal(input.head);
    const desired = cacheFromHead(input.head);
    const path = d65HeartbeatHighWaterPath(input.programEvidenceRoot, input.head.workstream_run);
    const existing = readD65HeartbeatHighWater(input.programEvidenceRoot, input.head.workstream_run);
    if (existing !== null) {
        if (existing.program_id !== desired.program_id || existing.repo_id !== desired.repo_id || existing.workstream_run !== desired.workstream_run)
            fail('cache identity differs from durable coordinator head', [path]);
        if (existing.sequence > desired.sequence)
            fail('cache is newer than durable coordinator authority (coordinator rollback)', [String(existing.sequence), String(desired.sequence)]);
        if (existing.sequence === desired.sequence && canonicalJson(existing) !== canonicalJson(desired))
            fail('cache at durable sequence diverges from the exact coordinator head', [path]);
        if (existing.sequence === desired.sequence)
            return existing;
    }
    writeAtomic(path, canonicalBytes(desired));
    const repaired = readD65HeartbeatHighWater(input.programEvidenceRoot, input.head.workstream_run);
    if (repaired === null || canonicalJson(repaired) !== canonicalJson(desired))
        fail('cache repair did not produce the durable coordinator head', [path]);
    return repaired;
}
