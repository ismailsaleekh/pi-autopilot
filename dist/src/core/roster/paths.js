import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
export const DEFAULT_USER_STATE_ROOT_DISPLAY = '~/.pi/agent/autopilot/';
const ROSTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;
const WORKSTREAM_RUN_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export function defaultUserStateRoot(home = homedir()) {
    return normalizeAbsoluteRoot(join(home, '.pi', 'agent', 'autopilot'), 'home-derived state root');
}
export function isRosterSha256(value) {
    return SHA256_PATTERN.test(value);
}
export function assertRosterSha256(value, label) {
    if (!isRosterSha256(value)) {
        throw new Error(`${label} must be sha256:<64 lowercase hex>`);
    }
}
export function assertValidRosterId(value, label = 'roster_id') {
    assertPathSegment(value, label, ROSTER_ID_PATTERN);
}
export function assertValidRepoId(value, label = 'repo_id') {
    assertPathSegment(value, label, REPO_ID_PATTERN);
}
export function assertValidWorkstreamRun(value, label = 'workstream_run') {
    assertPathSegment(value, label, WORKSTREAM_RUN_PATTERN);
}
export function assertValidRosterRevision(value, label = 'roster_revision') {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be an integer >= 1`);
    }
}
export function resolveRosterScopePaths(input) {
    const stateRootInjected = input.stateRoot !== undefined;
    const userStateRoot = stateRootInjected
        ? normalizeAbsoluteRoot(input.stateRoot, 'stateRoot')
        : defaultUserStateRoot();
    const userStateDisplayRoot = stateRootInjected
        ? userStateRoot
        : DEFAULT_USER_STATE_ROOT_DISPLAY.replace(/\/$/u, '');
    const authorityRoot = input.scope === 'user'
        ? userStateRoot
        : normalizeAbsoluteRoot(join(requireTrustedProjectRoot(input.trustedProjectRoot), '.autopilot'), 'trusted project authority root');
    const authorityDisplayRoot = input.scope === 'user'
        ? userStateDisplayRoot
        : authorityRoot;
    return Object.freeze({
        scope: input.scope,
        authorityRoot,
        authorityDisplayRoot,
        configPath: join(authorityRoot, 'config.json'),
        rostersRoot: join(authorityRoot, 'rosters'),
        lockPath: join(authorityRoot, '.roster-writer.lock'),
        userStateRoot,
        userStateDisplayRoot,
        selectionsRoot: join(userStateRoot, 'roster-selections'),
    });
}
export function rosterRevisionFileName(roster_revision) {
    assertValidRosterRevision(roster_revision);
    return `revision-${String(roster_revision)}.json`;
}
export function rosterRevisionPath(paths, ref) {
    assertValidRosterId(ref.roster_id);
    return join(paths.rostersRoot, ref.roster_id, rosterRevisionFileName(ref.roster_revision));
}
export function preRunSelectionPath(paths, key) {
    assertValidRepoId(key.repo_id);
    assertValidWorkstreamRun(key.workstream_run);
    return join(paths.selectionsRoot, key.repo_id, `${key.workstream_run}.json`);
}
export function formatAuthorityPath(path, authorityRoot, displayRoot) {
    const normalizedPath = normalizeAbsoluteRoot(path, 'path');
    const normalizedRoot = normalizeAbsoluteRoot(authorityRoot, 'authorityRoot');
    const rel = relative(normalizedRoot, normalizedPath);
    if (rel === '')
        return displayRoot;
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
        return normalizedPath;
    }
    return join(displayRoot, rel);
}
export function normalizeAbsoluteRoot(value, label) {
    if (value === undefined || value.length === 0) {
        throw new Error(`${label} must be an absolute path`);
    }
    assertNoNul(value, label);
    const resolved = resolve(value);
    if (!isAbsolute(resolved)) {
        throw new Error(`${label} must be absolute: ${value}`);
    }
    return resolved;
}
export function pathIsInsideOrEqual(root, candidate) {
    const normalizedRoot = normalizeAbsoluteRoot(root, 'root');
    const normalizedCandidate = normalizeAbsoluteRoot(candidate, 'candidate');
    const rel = relative(normalizedRoot, normalizedCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}
function requireTrustedProjectRoot(value) {
    if (value === undefined) {
        throw new Error('trustedProjectRoot is required for trusted-project roster storage');
    }
    return normalizeAbsoluteRoot(value, 'trustedProjectRoot');
}
function assertPathSegment(value, label, pattern) {
    assertNoNul(value, label);
    if (!pattern.test(value) || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
        throw new Error(`${label} is not a valid roster storage path segment: ${value}`);
    }
}
function assertNoNul(value, label) {
    if (value.includes('\0')) {
        throw new Error(`${label} must not contain NUL`);
    }
}
