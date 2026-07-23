import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { canonicalJson } from "./canonical-json.js";
import { readImmutableFileBytes } from "./immutable-file.js";
import { assertS2RetentionNoSymlinkComponents, verifyS2ColdTerminalProof } from "./s2-retention-archive.js";
import { isS2RetentionCandidateId, S2_RETENTION_ACTIVE_MARKER, S2_RETENTION_DIRTY_MARKER, S2_RETENTION_INFLIGHT_DIR, S2_RETENTION_LEDGER_FILE, S2_RETENTION_OWNER_MARKER, S2_RETENTION_QUARANTINE_MARKER, S2_RETENTION_SOLE_COPY_PIN, S2_RETENTION_TRANSITION_BACKUP_DIR, S2_RETENTION_TRASH_DIR, defineS2RetentionPolicy, } from "./s2-retention-policy.js";
function sha256HexUtf8(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function isErrorWithCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function isJsonRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        throw new Error(`${key} must be a non-empty string`);
    return value;
}
function requiredBoolean(record, key) {
    const value = record[key];
    if (typeof value !== 'boolean')
        throw new Error(`${key} must be a boolean`);
    return value;
}
function requiredSeq(record, key) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`${key} must be a non-negative safe integer`);
    return value;
}
function assertExactKeys(record, expected, label) {
    const actual = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index]))
        throw new Error(`${label} fields are not the exact closed contract`);
}
const S2_RETENTION_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const POSIX_O_APPEND = 0x0008;
function assertSha256Hex(value, label) {
    if (!/^[a-f0-9]{64}$/u.test(value))
        throw new Error(`${label} must be a lowercase sha256 hex digest`);
}
function parseTerminalKind(value) {
    if (value === 'closed' || value === 'aborted' || value === 'failed')
        return value;
    throw new Error('terminal_kind is invalid');
}
function parseKind(value) {
    if (value === 'trash' || value === 'transition-backup')
        return value;
    throw new Error('gc marker kind is invalid');
}
function parseRefusalReason(value) {
    if (value === 'active-run' || value === 'ambiguous-owner' || value === 'cold-archive-unverified' || value === 'dirty-path' || value === 'foreign-owner' || value === 'hardlink-detected' || value === 'invalid-candidate-id' || value === 'malformed-owned-marker' || value === 'missing-owned-marker' || value === 'missing-without-ledger' || value === 'path-escape' || value === 'path-not-owned-directory' || value === 'policy-mismatch' || value === 'quarantined-path' || value === 'sole-copy-pin' || value === 'symlink-detected' || value === 'unexpected-kind')
        return value;
    throw new Error('retention refusal reason is invalid');
}
function parseOwnedGcMarker(bytes) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!isJsonRecord(parsed))
        throw new Error('owned gc marker must be a JSON object');
    assertExactKeys(parsed, ['active', 'candidate_id', 'cold_archive_relpath', 'cold_archive_sha256', 'cold_archive_verified', 'created_by', 'dirty', 'kind', 'owner_run', 'policy_id', 'quarantined', 'repo_id', 'schema_version', 'sole_copy_pin', 'terminal_event_seq', 'terminal_kind'], 'owned gc marker');
    const coldArchiveSha256 = requiredString(parsed, 'cold_archive_sha256');
    assertSha256Hex(coldArchiveSha256, 'cold_archive_sha256');
    return {
        schema_version: requiredString(parsed, 'schema_version') === 'autopilot.s2_retention.owner.v1' ? 'autopilot.s2_retention.owner.v1' : (() => { throw new Error('owned gc marker schema_version is invalid'); })(),
        created_by: requiredString(parsed, 'created_by') === 'autopilot-s2-retention' ? 'autopilot-s2-retention' : (() => { throw new Error('owned gc marker created_by is invalid'); })(),
        repo_id: requiredString(parsed, 'repo_id'),
        owner_run: requiredString(parsed, 'owner_run'),
        candidate_id: requiredString(parsed, 'candidate_id'),
        kind: parseKind(requiredString(parsed, 'kind')),
        policy_id: requiredString(parsed, 'policy_id'),
        terminal_event_seq: requiredSeq(parsed, 'terminal_event_seq'),
        terminal_kind: parseTerminalKind(requiredString(parsed, 'terminal_kind')),
        cold_archive_sha256: coldArchiveSha256,
        cold_archive_relpath: requiredString(parsed, 'cold_archive_relpath'),
        cold_archive_verified: requiredBoolean(parsed, 'cold_archive_verified'),
        active: requiredBoolean(parsed, 'active'),
        dirty: requiredBoolean(parsed, 'dirty'),
        quarantined: requiredBoolean(parsed, 'quarantined'),
        sole_copy_pin: requiredBoolean(parsed, 'sole_copy_pin'),
    };
}
function assertContained(root, target) {
    const rootAbs = resolve(root);
    const targetAbs = resolve(target);
    const rel = relative(rootAbs, targetAbs);
    if (rel.length === 0 || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || rel.split(/[\\/]/u).includes('..'))
        throw new OwnedGcRefusal('path-escape');
}
function linkCount(path) {
    return lstatSync(path).nlink;
}
function assertSafeOperationId(operationId) {
    if (!isS2RetentionCandidateId(operationId))
        throw new OwnedGcRefusal('path-escape');
}
class OwnedGcRefusal extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isErrorWithCode(error, 'ENOENT'))
            return false;
        throw error;
    }
}
async function assertNoSymlinkComponents(root, target) {
    assertContained(root, target);
    const rootAbs = resolve(root);
    const rel = relative(rootAbs, resolve(target));
    const parts = rel.split(/[\\/]/u).filter((part) => part.length > 0);
    let current = rootAbs;
    const rootStat = await lstat(rootAbs);
    if (rootStat.isSymbolicLink())
        throw new OwnedGcRefusal('symlink-detected');
    for (const part of parts) {
        current = join(current, part);
        const currentStat = await lstat(current);
        if (currentStat.isSymbolicLink())
            throw new OwnedGcRefusal('symlink-detected');
    }
}
async function scanTreeForUnsafeLinks(path) {
    const st = await lstat(path);
    if (st.isSymbolicLink())
        throw new OwnedGcRefusal('symlink-detected');
    if (st.isFile()) {
        if (linkCount(path) !== 1)
            throw new OwnedGcRefusal('hardlink-detected');
        return basename(path) === S2_RETENTION_OWNER_MARKER ? 1 : 0;
    }
    if (!st.isDirectory())
        throw new OwnedGcRefusal('path-not-owned-directory');
    let markerCount = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink())
            throw new OwnedGcRefusal('symlink-detected');
        markerCount += await scanTreeForUnsafeLinks(child);
    }
    return markerCount;
}
function parseEventKind(value) {
    if (value === 'candidate-refused' || value === 'candidate-verified' || value === 'candidate-renamed' || value === 'candidate-removed' || value === 'duplicate-committed' || value === 'inflight-replayed')
        return value;
    throw new Error('owned gc ledger event_kind is invalid');
}
function parseLedgerEventLine(line) {
    const parsed = JSON.parse(line);
    if (!isJsonRecord(parsed))
        throw new Error('owned gc ledger entry must be a JSON object');
    const eventKind = parseEventKind(requiredString(parsed, 'event_kind'));
    assertExactKeys(parsed, eventKind === 'candidate-refused'
        ? ['at', 'candidate_id', 'candidate_path_sha256', 'event_id', 'event_kind', 'kind', 'operation_id', 'owner_run', 'policy_id', 'refusal_reason', 'repo_id', 'schema_version']
        : ['at', 'candidate_id', 'candidate_path_sha256', 'event_id', 'event_kind', 'kind', 'operation_id', 'owner_run', 'policy_id', 'repo_id', 'schema_version'], 'owned gc ledger entry');
    const eventId = requiredString(parsed, 'event_id');
    assertSha256Hex(eventId, 'event_id');
    const candidatePathSha256 = requiredString(parsed, 'candidate_path_sha256');
    assertSha256Hex(candidatePathSha256, 'candidate_path_sha256');
    const base = {
        schema_version: requiredString(parsed, 'schema_version') === 'autopilot.s2_retention.ledger.v1' ? 'autopilot.s2_retention.ledger.v1' : (() => { throw new Error('owned gc ledger schema_version is invalid'); })(),
        event_kind: eventKind,
        operation_id: requiredString(parsed, 'operation_id'),
        repo_id: requiredString(parsed, 'repo_id'),
        owner_run: requiredString(parsed, 'owner_run'),
        candidate_id: requiredString(parsed, 'candidate_id'),
        candidate_path_sha256: candidatePathSha256,
        kind: parseKind(requiredString(parsed, 'kind')),
        policy_id: requiredString(parsed, 'policy_id'),
        at: requiredString(parsed, 'at'),
    };
    const withoutId = eventKind === 'candidate-refused'
        ? { ...base, refusal_reason: parseRefusalReason(requiredString(parsed, 'refusal_reason')) }
        : base;
    if (sha256HexUtf8(canonicalJson(withoutId)) !== eventId)
        throw new Error('owned gc ledger event_id digest mismatch');
    return { ...withoutId, event_id: eventId };
}
async function readLedgerEvents(ledgerPath) {
    if (!await pathExists(ledgerPath))
        return [];
    const text = new TextDecoder().decode(readImmutableFileBytes({ path: ledgerPath, maximumBytes: S2_RETENTION_LEDGER_MAX_BYTES, label: 's2 owned gc ledger' }));
    const events = [];
    for (const line of text.split('\n')) {
        if (line.trim().length === 0)
            continue;
        events.push(parseLedgerEventLine(line));
    }
    return events;
}
async function hasCommittedRemoval(ledgerPath, candidateId, repoId, ownerRun, kind, policyId) {
    for (const event of await readLedgerEvents(ledgerPath)) {
        if ((event.event_kind === 'candidate-removed' || event.event_kind === 'inflight-replayed') && event.candidate_id === candidateId && event.repo_id === repoId && event.owner_run === ownerRun && event.kind === kind && event.policy_id === policyId)
            return true;
    }
    return false;
}
async function hasRenamedForReplay(ledgerPath, candidateId, repoId, ownerRun, kind, policyId) {
    for (const event of await readLedgerEvents(ledgerPath)) {
        if (event.event_kind === 'candidate-renamed' && event.candidate_id === candidateId && event.repo_id === repoId && event.owner_run === ownerRun && event.kind === kind && event.policy_id === policyId)
            return true;
    }
    return false;
}
async function observeS2RetentionBoundary(boundary) {
    if (process.env['AUTOPILOT_S2_RETENTION_TEST_BOUNDARY'] !== boundary)
        return;
    const marker = process.env['AUTOPILOT_S2_RETENTION_TEST_MARKER'];
    if (marker !== undefined && marker.length > 0)
        await writeFile(marker, `${boundary}\n`, { flag: 'w', mode: 0o600 });
    await new Promise(() => undefined);
}
async function fsyncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function appendLedgerEvent(retentionRoot, event) {
    await mkdir(retentionRoot, { recursive: true });
    const rootStat = await lstat(retentionRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error('retention ledger root must be a non-symbolic directory');
    const eventId = sha256HexUtf8(canonicalJson(event));
    const complete = { ...event, event_id: eventId };
    const ledgerPath = join(retentionRoot, S2_RETENTION_LEDGER_FILE);
    if (await pathExists(ledgerPath))
        readImmutableFileBytes({ path: ledgerPath, maximumBytes: S2_RETENTION_LEDGER_MAX_BYTES, label: 's2 owned gc ledger' });
    const descriptor = openSync(ledgerPath, fsConstants.O_CREAT | POSIX_O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1)
            throw new Error('retention ledger descriptor must be a single-link file');
        writeFileSync(descriptor, `${canonicalJson(complete)}\n`, 'utf8');
        await observeS2RetentionBoundary(`s2-ledger-after-${event.event_kind}-write`);
        fsyncSync(descriptor);
        await observeS2RetentionBoundary(`s2-ledger-after-${event.event_kind}-fsync`);
    }
    finally {
        closeSync(descriptor);
    }
    await fsyncDirectory(retentionRoot);
    return complete;
}
async function appendRefusal(input, candidateId, path, kind, reason) {
    await appendLedgerEvent(input.retentionRoot, {
        schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'candidate-refused', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
        candidate_path_sha256: sha256HexUtf8(resolve(path)), kind, policy_id: input.policy.policy_id, at: input.nowIso, refusal_reason: reason,
    });
    return { candidateId, kind, path, outcome: 'refused', refusalReason: reason };
}
function markerPath(candidatePath) {
    return join(candidatePath, S2_RETENTION_OWNER_MARKER);
}
function categoryRoot(retentionRoot, kind) {
    return join(retentionRoot, kind === 'trash' ? S2_RETENTION_TRASH_DIR : S2_RETENTION_TRANSITION_BACKUP_DIR);
}
async function readMarker(candidatePath) {
    const path = markerPath(candidatePath);
    try {
        const markerStat = await lstat(path);
        if (markerStat.isSymbolicLink())
            throw new OwnedGcRefusal('symlink-detected');
        if (!markerStat.isFile())
            throw new OwnedGcRefusal('missing-owned-marker');
        if (linkCount(path) !== 1)
            throw new OwnedGcRefusal('hardlink-detected');
    }
    catch (error) {
        if (isErrorWithCode(error, 'ENOENT'))
            throw new OwnedGcRefusal('missing-owned-marker');
        throw error;
    }
    try {
        return parseOwnedGcMarker(readImmutableFileBytes({ path, maximumBytes: 8_192, label: 's2 owned gc marker' }));
    }
    catch (error) {
        if (error instanceof OwnedGcRefusal)
            throw error;
        throw new OwnedGcRefusal('malformed-owned-marker');
    }
}
function assertCandidateMarkerMatches(input, marker, expectedKind, candidateId) {
    if (marker.repo_id !== input.repoId || marker.owner_run !== input.ownerRun)
        throw new OwnedGcRefusal('foreign-owner');
    if (marker.policy_id !== input.policy.policy_id)
        throw new OwnedGcRefusal('policy-mismatch');
    if (marker.kind !== expectedKind)
        throw new OwnedGcRefusal('unexpected-kind');
    if (marker.candidate_id !== candidateId)
        throw new OwnedGcRefusal('ambiguous-owner');
    if (marker.active)
        throw new OwnedGcRefusal('active-run');
    if (marker.quarantined)
        throw new OwnedGcRefusal('quarantined-path');
    if (marker.dirty)
        throw new OwnedGcRefusal('dirty-path');
    if (marker.sole_copy_pin)
        throw new OwnedGcRefusal('sole-copy-pin');
    if (!marker.cold_archive_verified)
        throw new OwnedGcRefusal('cold-archive-unverified');
    if (expectedKind === 'transition-backup' && !input.policy.allow_transition_backup_gc)
        throw new OwnedGcRefusal('policy-mismatch');
}
async function verifyCandidateColdArchive(input, marker) {
    const archivePath = resolve(input.coldArchiveRoot, marker.cold_archive_relpath);
    assertContained(input.coldArchiveRoot, archivePath);
    try {
        await assertS2RetentionNoSymlinkComponents(input.coldArchiveRoot, archivePath);
        verifyS2ColdTerminalProof({
            archivePath,
            expectedColdArchiveSha256: marker.cold_archive_sha256,
            policy: input.policy,
            expected: { repoId: input.repoId, workstreamRun: input.ownerRun, terminalEventSeq: marker.terminal_event_seq, terminalKind: marker.terminal_kind },
        });
    }
    catch {
        throw new OwnedGcRefusal('cold-archive-unverified');
    }
}
async function validateCandidate(input, candidatePath, expectedKind, candidateId) {
    if (candidateId.includes('/') || candidateId.includes('\\') || candidateId === '..' || candidateId.startsWith('../') || candidateId.startsWith('..\\'))
        throw new OwnedGcRefusal('path-escape');
    if (!isS2RetentionCandidateId(candidateId) || basename(candidatePath) !== candidateId)
        throw new OwnedGcRefusal('invalid-candidate-id');
    await assertNoSymlinkComponents(input.retentionRoot, candidatePath);
    assertContained(categoryRoot(input.retentionRoot, expectedKind), candidatePath);
    const st = await lstat(candidatePath);
    if (!st.isDirectory() || st.isSymbolicLink())
        throw new OwnedGcRefusal('path-not-owned-directory');
    const marker = await readMarker(candidatePath);
    assertCandidateMarkerMatches(input, marker, expectedKind, candidateId);
    await verifyCandidateColdArchive(input, marker);
    if (await pathExists(join(candidatePath, S2_RETENTION_ACTIVE_MARKER)))
        throw new OwnedGcRefusal('active-run');
    if (await pathExists(join(candidatePath, S2_RETENTION_QUARANTINE_MARKER)))
        throw new OwnedGcRefusal('quarantined-path');
    if (await pathExists(join(candidatePath, S2_RETENTION_DIRTY_MARKER)))
        throw new OwnedGcRefusal('dirty-path');
    if (await pathExists(join(candidatePath, S2_RETENTION_SOLE_COPY_PIN)))
        throw new OwnedGcRefusal('sole-copy-pin');
    const markerCount = await scanTreeForUnsafeLinks(candidatePath);
    if (markerCount !== 1)
        throw new OwnedGcRefusal('ambiguous-owner');
    return marker;
}
async function validateInflightCandidate(input, inflightRoot, inflightPath, expectedKind, candidateId) {
    await assertNoSymlinkComponents(inflightRoot, inflightPath);
    const st = await lstat(inflightPath);
    if (!st.isDirectory() || st.isSymbolicLink())
        throw new OwnedGcRefusal('path-not-owned-directory');
    const marker = await readMarker(inflightPath);
    assertCandidateMarkerMatches(input, marker, expectedKind, candidateId);
    await verifyCandidateColdArchive(input, marker);
    const markerCount = await scanTreeForUnsafeLinks(inflightPath);
    if (markerCount !== 1)
        throw new OwnedGcRefusal('ambiguous-owner');
}
async function removeCandidate(input, candidatePath, kind, candidateId) {
    if (candidateId.includes('/') || candidateId.includes('\\') || candidateId === '..' || candidateId.startsWith('../') || candidateId.startsWith('..\\'))
        throw new OwnedGcRefusal('path-escape');
    if (!isS2RetentionCandidateId(candidateId))
        throw new OwnedGcRefusal('invalid-candidate-id');
    const ledgerPath = join(input.retentionRoot, S2_RETENTION_LEDGER_FILE);
    if (!await pathExists(candidatePath)) {
        if (await hasCommittedRemoval(ledgerPath, candidateId, input.repoId, input.ownerRun, kind, input.policy.policy_id)) {
            await appendLedgerEvent(input.retentionRoot, {
                schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'duplicate-committed', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
                candidate_path_sha256: sha256HexUtf8(resolve(candidatePath)), kind, policy_id: input.policy.policy_id, at: input.nowIso,
            });
            return { candidateId, kind, path: candidatePath, outcome: 'duplicate-committed' };
        }
        throw new OwnedGcRefusal('missing-without-ledger');
    }
    await validateCandidate(input, candidatePath, kind, candidateId);
    await appendLedgerEvent(input.retentionRoot, {
        schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'candidate-verified', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
        candidate_path_sha256: sha256HexUtf8(resolve(candidatePath)), kind, policy_id: input.policy.policy_id, at: input.nowIso,
    });
    assertSafeOperationId(input.operationId);
    const inflightRoot = join(input.retentionRoot, S2_RETENTION_INFLIGHT_DIR);
    const inflightParent = join(inflightRoot, input.operationId);
    const inflightPath = join(inflightParent, `${kind}-${candidateId}`);
    assertContained(input.retentionRoot, inflightRoot);
    assertContained(inflightRoot, inflightParent);
    assertContained(inflightRoot, inflightPath);
    await mkdir(inflightParent, { recursive: true });
    await assertNoSymlinkComponents(input.retentionRoot, inflightParent);
    await fsyncDirectory(inflightRoot).catch((error) => { if (!isErrorWithCode(error, 'ENOENT'))
        throw error; });
    await rename(candidatePath, inflightPath);
    await fsyncDirectory(categoryRoot(input.retentionRoot, kind));
    await fsyncDirectory(inflightParent);
    await observeS2RetentionBoundary('s2-gc-after-rename');
    await appendLedgerEvent(input.retentionRoot, {
        schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'candidate-renamed', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
        candidate_path_sha256: sha256HexUtf8(resolve(candidatePath)), kind, policy_id: input.policy.policy_id, at: input.nowIso,
    });
    await validateInflightCandidate(input, inflightRoot, inflightPath, kind, candidateId);
    await appendLedgerEvent(input.retentionRoot, {
        schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'candidate-removed', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
        candidate_path_sha256: sha256HexUtf8(resolve(candidatePath)), kind, policy_id: input.policy.policy_id, at: input.nowIso,
    });
    await observeS2RetentionBoundary('s2-gc-before-rm-after-authoritative-ledger');
    await rm(inflightPath, { recursive: true, force: false });
    await fsyncDirectory(inflightParent);
    await observeS2RetentionBoundary('s2-gc-after-rm');
    return { candidateId, kind, path: candidatePath, outcome: 'removed' };
}
async function replayInflight(input) {
    const inflightRoot = join(input.retentionRoot, S2_RETENTION_INFLIGHT_DIR);
    const ledgerPath = join(input.retentionRoot, S2_RETENTION_LEDGER_FILE);
    let operations;
    try {
        operations = await readdir(inflightRoot, { withFileTypes: true });
    }
    catch (error) {
        if (isErrorWithCode(error, 'ENOENT'))
            return [];
        throw error;
    }
    const results = [];
    for (const operation of operations) {
        if (!operation.isDirectory())
            continue;
        const operationPath = join(inflightRoot, operation.name);
        for (const entry of await readdir(operationPath, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const kind = entry.name.startsWith('trash-') ? 'trash' : 'transition-backup';
            const prefix = kind === 'trash' ? 'trash-' : 'transition-backup-';
            const candidateId = entry.name.slice(prefix.length);
            const inflightPath = join(operationPath, entry.name);
            if (!isS2RetentionCandidateId(candidateId))
                continue;
            try {
                if (!await hasRenamedForReplay(ledgerPath, candidateId, input.repoId, input.ownerRun, kind, input.policy.policy_id))
                    throw new OwnedGcRefusal('missing-without-ledger');
                await validateInflightCandidate(input, inflightRoot, inflightPath, kind, candidateId);
                await appendLedgerEvent(input.retentionRoot, {
                    schema_version: 'autopilot.s2_retention.ledger.v1', event_kind: 'inflight-replayed', operation_id: input.operationId, repo_id: input.repoId, owner_run: input.ownerRun, candidate_id: candidateId,
                    candidate_path_sha256: sha256HexUtf8(resolve(inflightPath)), kind, policy_id: input.policy.policy_id, at: input.nowIso,
                });
                await observeS2RetentionBoundary('s2-gc-before-replay-rm-after-authoritative-ledger');
                await rm(inflightPath, { recursive: true, force: false });
                await fsyncDirectory(operationPath);
                await observeS2RetentionBoundary('s2-gc-after-replay-rm');
                results.push({ candidateId, kind, path: inflightPath, outcome: 'replayed' });
            }
            catch (error) {
                if (error instanceof OwnedGcRefusal)
                    results.push(await appendRefusal(input, candidateId, inflightPath, kind, error.reason));
                else
                    throw error;
            }
        }
    }
    return results;
}
async function listCandidateIds(input, kind) {
    if (input.candidateIds !== undefined)
        return input.candidateIds;
    const root = categoryRoot(input.retentionRoot, kind);
    let entries;
    try {
        await assertNoSymlinkComponents(input.retentionRoot, root);
        const rootStat = await lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
            throw new OwnedGcRefusal('path-not-owned-directory');
        entries = await readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (isErrorWithCode(error, 'ENOENT'))
            return [];
        throw error;
    }
    return entries.map((entry) => entry.name).sort();
}
export async function writeS2OwnedGcMarker(candidatePath, marker) {
    await mkdir(candidatePath, { recursive: true });
    await writeFile(join(candidatePath, S2_RETENTION_OWNER_MARKER), canonicalJson(marker), { flag: 'wx', mode: 0o600 });
}
export async function runScheduledS2OwnedGc(input) {
    assertSafeOperationId(input.operationId);
    await mkdir(input.retentionRoot, { recursive: true });
    const rootStat = await lstat(input.retentionRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error('retention root must be a non-symbolic directory');
    await fsyncDirectory(input.retentionRoot);
    const results = [...await replayInflight(input)];
    const kinds = input.policy.allow_transition_backup_gc ? ['trash', 'transition-backup'] : ['trash'];
    for (const kind of kinds) {
        const ids = await listCandidateIds(input, kind);
        let removedForKind = 0;
        for (const candidateId of ids) {
            if (removedForKind >= input.policy.gc_batch_limit)
                break;
            const candidatePath = join(categoryRoot(input.retentionRoot, kind), candidateId);
            try {
                const result = await removeCandidate(input, candidatePath, kind, candidateId);
                results.push(result);
                if (result.outcome === 'removed' || result.outcome === 'duplicate-committed')
                    removedForKind += 1;
            }
            catch (error) {
                if (error instanceof OwnedGcRefusal)
                    results.push(await appendRefusal(input, candidateId, candidatePath, kind, error.reason));
                else
                    throw error;
            }
        }
    }
    return {
        operationId: input.operationId,
        removed: results.filter((result) => result.outcome === 'removed').length,
        refused: results.filter((result) => result.outcome === 'refused').length,
        duplicates: results.filter((result) => result.outcome === 'duplicate-committed').length,
        replayed: results.filter((result) => result.outcome === 'replayed').length,
        results,
    };
}
export async function runCoordinatorOwnedS2RetentionGc(input) {
    const policy = input.policy ?? defineS2RetentionPolicy();
    const results = [];
    for (const run of input.runs) {
        if (!isS2RetentionCandidateId(run.repoId) || run.workstreamRun.length === 0)
            continue;
        const retentionRoot = join(input.stateRoot, 'worktrees', run.repoId, '_retention');
        try {
            const st = await lstat(retentionRoot);
            if (!st.isDirectory() || st.isSymbolicLink())
                continue;
        }
        catch (error) {
            if (isErrorWithCode(error, 'ENOENT'))
                continue;
            throw error;
        }
        results.push(await runScheduledS2OwnedGc({
            retentionRoot,
            coldArchiveRoot: join(retentionRoot, 'cold'),
            repoId: run.repoId,
            ownerRun: run.workstreamRun,
            policy,
            nowIso: input.nowIso,
            operationId: `${input.operationPrefix ?? 'coordinator-s2-gc'}-${sha256HexUtf8(`${run.repoId}:${run.workstreamRun}:${input.nowIso}`).slice(0, 24)}`,
        }));
    }
    return {
        results,
        removed: results.reduce((sum, result) => sum + result.removed, 0),
        refused: results.reduce((sum, result) => sum + result.refused, 0),
        duplicates: results.reduce((sum, result) => sum + result.duplicates, 0),
        replayed: results.reduce((sum, result) => sum + result.replayed, 0),
    };
}
