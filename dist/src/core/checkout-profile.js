import { runGitQuery } from "./git-process.js";
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
export const AUTOPILOT_CHECKOUT_PROFILE_ENV = 'AUTOPILOT_CHECKOUT_PROFILE';
export const AUTOPILOT_PROJECT_CHECKOUT_PROFILE = '.autopilot/checkout-profile.json';
export const AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE = '_checkout-profile.json';
export const AUTOPILOT_CHECKOUT_PROFILE_SCHEMA_VERSION = 'autopilot.checkout_profile.v1';
export const AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_SCHEMA_VERSION = 'autopilot.checkout_profile_snapshot.v1';
export class AutopilotCheckoutProfileError extends Error {
    name = 'AutopilotCheckoutProfileError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotCheckoutProfileError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotCheckoutProfileError(code, message, evidence);
}
export async function resolveAutopilotCheckoutProfile(input) {
    const env = input.env ?? process.env;
    const repoRoot = resolve(input.repoRoot);
    const scan = await scanTrackedTree(repoRoot, input.now ?? new Date());
    const loaded = await loadCheckoutProfile(repoRoot, env);
    const profile = loaded.profile;
    const basePatterns = baseSparsePatternsForProfile(profile);
    const baseBytes = estimateCheckoutBytesForProfile(profile, scan, basePatterns);
    return Object.freeze({
        profile,
        origin: loaded.origin,
        source_path: loaded.sourcePath,
        profile_sha256: sha256Json(profile),
        tracked_tree: scan,
        base_patterns: basePatterns,
        base_checkout_bytes: baseBytes,
        full_checkout_bytes: scan.total_bytes,
    });
}
export function checkoutProfileSnapshotFromResolved(input) {
    const now = input.now ?? new Date();
    return Object.freeze({
        schema_version: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_SCHEMA_VERSION,
        profile: input.resolved.profile,
        profile_origin: input.resolved.origin,
        profile_source_path: input.resolved.source_path,
        profile_sha256: input.resolved.profile_sha256,
        base_patterns: input.resolved.base_patterns,
        base_checkout_bytes: input.resolved.base_checkout_bytes,
        full_checkout_bytes: input.resolved.full_checkout_bytes,
        tracked_head_sha: input.resolved.tracked_tree.head_sha,
        created_at: now.toISOString(),
    });
}
export async function readCheckoutProfileSnapshot(path) {
    if (!existsSync(path))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('invalid-profile-snapshot-json', `failed to read checkout profile snapshot ${path}: ${errorMessage(error)}`);
    }
    return parseCheckoutProfileSnapshot(parsed, path);
}
export function parseCheckoutProfileSnapshot(value, source = '<snapshot>') {
    const record = requireRecord(value, 'checkout profile snapshot');
    const profile = parseAutopilotCheckoutProfile(record['profile'], source);
    const origin = expectOneOf(record, 'profile_origin', ['env', 'project', 'auto-profile']);
    return Object.freeze({
        schema_version: expectConst(record, 'schema_version', AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_SCHEMA_VERSION),
        profile,
        profile_origin: origin,
        profile_source_path: expectNullableString(record, 'profile_source_path'),
        profile_sha256: expectSha(record, 'profile_sha256'),
        base_patterns: expectStringArray(record, 'base_patterns'),
        base_checkout_bytes: expectNonNegativeInteger(record, 'base_checkout_bytes'),
        full_checkout_bytes: expectNonNegativeInteger(record, 'full_checkout_bytes'),
        tracked_head_sha: expectString(record, 'tracked_head_sha'),
        created_at: expectString(record, 'created_at'),
    });
}
export function defaultAutopilotCheckoutProfile() {
    return Object.freeze({
        schema_version: AUTOPILOT_CHECKOUT_PROFILE_SCHEMA_VERSION,
        mode: 'claim-minimal',
        always_include: [
            '.gitignore',
            '.gitattributes',
            'README.md',
            'AGENTS.md',
            AUTOPILOT_PROJECT_CHECKOUT_PROFILE,
        ],
        exclude: [],
        auto_profile: {
            enabled: true,
            heavy_dir_threshold_bytes: 67_108_864,
            max_scan_depth: 4,
        },
        disk_gate: {
            expected_parallel_units: 8,
            headroom_factor: 1.5,
            floor_free_bytes: 2_147_483_648,
        },
        materialization: {
            auto_read_claims: true,
            max_auto_read_bytes: 104_857_600,
            max_single_materialization_bytes: 268_435_456,
            max_auto_read_paths: 64,
        },
    });
}
export function parseAutopilotCheckoutProfile(value, source = '<profile>') {
    const defaults = defaultAutopilotCheckoutProfile();
    const record = requireRecord(value, 'checkout profile');
    const schemaVersion = expectConst(record, 'schema_version', AUTOPILOT_CHECKOUT_PROFILE_SCHEMA_VERSION);
    const mode = expectOneOf(record, 'mode', ['claim-minimal', 'exclude-heavy', 'full']);
    const alwaysInclude = optionalStringArray(record, 'always_include', defaults.always_include).map((path) => normalizeMaterializationPath(path, `${source}:always_include`));
    const exclude = optionalStringArray(record, 'exclude', defaults.exclude).map((path) => normalizeMaterializationPath(path, `${source}:exclude`));
    const autoProfile = parseAutoProfileConfig(record['auto_profile'], defaults.auto_profile, source);
    const diskGate = parseDiskGateConfig(record['disk_gate'], defaults.disk_gate, source);
    const materialization = parseMaterializationConfig(record['materialization'], defaults.materialization, source);
    return Object.freeze({
        schema_version: schemaVersion,
        mode,
        always_include: sortedUnique(alwaysInclude),
        exclude: sortedUnique(exclude),
        auto_profile: autoProfile,
        disk_gate: diskGate,
        materialization,
    });
}
export async function scanTrackedTree(repoRoot, now = new Date()) {
    const resolvedRepoRoot = resolve(repoRoot);
    const headSha = decodeUtf8(runGitQuery({ descriptor: { kind: 'head' }, cwd: resolvedRepoRoot }).stdout, 'git HEAD').trim();
    const entries = [];
    let totalBytes = 0;
    await streamGitLsTree(headSha, resolvedRepoRoot, (record) => {
        const entry = parseTrackedTreeRecord(record);
        entries.push(entry);
        totalBytes += entry.byte_count;
    });
    const sortedEntries = Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path)));
    return Object.freeze({
        repo_root: resolvedRepoRoot,
        head_sha: headSha,
        entries: sortedEntries,
        total_bytes: totalBytes,
        scanned_at: now.toISOString(),
    });
}
export function baseSparsePatternsForProfile(profile) {
    if (profile.mode === 'full')
        return [];
    if (profile.mode === 'exclude-heavy') {
        return Object.freeze([
            '/*',
            ...profile.exclude.flatMap((path) => sparseExcludePatternsForPath(path)),
        ]);
    }
    return Object.freeze(sortedUnique(profile.always_include.flatMap((path) => sparseIncludePatternsForPath(path))));
}
export function sparseIncludePatternsForPaths(paths) {
    return Object.freeze(sortedUnique(paths.flatMap((path) => sparseIncludePatternsForPath(path))));
}
export function sparseIncludePatternsForPath(path) {
    const normalized = normalizeMaterializationPath(path, 'sparse include path');
    if (normalized.endsWith('/**')) {
        const base = normalized.slice(0, -3);
        return Object.freeze([`/${base}/**`]);
    }
    return Object.freeze([`/${normalized}`, `/${normalized}/**`]);
}
export function sparseExcludePatternsForPath(path) {
    const normalized = normalizeMaterializationPath(path, 'sparse exclude path').replace(/\/\*\*$/u, '');
    return Object.freeze([`!/${normalized}`, `!/${normalized}/**`]);
}
export function normalizeMaterializationPath(path, label = 'repo-relative path') {
    return normalizeRepoRelativePath(path, label);
}
export function normalizeRepoRelativePath(value, label = 'repo-relative path') {
    if (value.includes('\0'))
        fail('invalid-repo-path', `${label} contains NUL.`);
    if (isAbsolute(value) || /^[A-Za-z]:/u.test(value))
        fail('invalid-repo-path', `${label} must not be absolute.`, [value]);
    if (value.includes('\\'))
        fail('invalid-repo-path', `${label} must use POSIX separators.`, [value]);
    let suffix = '';
    let raw = value;
    if (raw.endsWith('/**')) {
        suffix = '/**';
        raw = raw.slice(0, -3);
    }
    if (raw.includes('*') || raw.includes('!') || raw.includes('[') || raw.includes(']')) {
        fail('invalid-repo-path', 'repo-relative materialization paths may only use an optional /** suffix.', [value]);
    }
    const normalized = raw.split('/').filter((segment) => segment.length > 0).join('/');
    if (normalized.length === 0)
        fail('invalid-repo-path', 'repo-relative path must not be empty.');
    if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
        fail('invalid-repo-path', 'repo-relative path must not contain traversal segments.', [value]);
    }
    return `${normalized}${suffix}`;
}
export function pathMatchesMaterializationPattern(path, pattern) {
    const normalizedPath = normalizeRepoRelativePath(path);
    const normalizedPattern = normalizeRepoRelativePath(pattern);
    if (normalizedPattern.endsWith('/**')) {
        const base = normalizedPattern.slice(0, -3);
        return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}
export function trackedEntriesForMaterializationPath(scan, path) {
    const normalized = normalizeMaterializationPath(path, 'materialization estimate path');
    const base = normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
    return Object.freeze(scan.entries.filter((entry) => pathMatchesMaterializationPattern(entry.path, base)));
}
export function estimateBytesForMaterializationPaths(scan, paths) {
    const matched = new Map();
    for (const path of paths) {
        for (const entry of trackedEntriesForMaterializationPath(scan, path)) {
            matched.set(entry.path, entry.byte_count);
        }
    }
    return [...matched.values()].reduce((sum, bytes) => sum + bytes, 0);
}
export function submodulePathsForMaterialization(scan, paths) {
    const out = [];
    for (const path of paths) {
        for (const entry of trackedEntriesForMaterializationPath(scan, path)) {
            if (entry.object_type === 'commit')
                out.push(entry.path);
        }
    }
    return Object.freeze(sortedUnique(out));
}
export function trackedPathExists(scan, path) {
    return trackedEntriesForMaterializationPath(scan, path).length > 0;
}
export function estimateCheckoutBytesForProfile(profile, scan, basePatterns = baseSparsePatternsForProfile(profile)) {
    if (profile.mode === 'full')
        return scan.total_bytes;
    if (profile.mode === 'exclude-heavy') {
        const excludedBytes = estimateBytesForMaterializationPaths(scan, profile.exclude);
        return Math.max(0, scan.total_bytes - excludedBytes);
    }
    const basePaths = basePatterns.flatMap(patternToApproximateMaterializationPath).filter((path) => path !== null);
    return estimateBytesForMaterializationPaths(scan, basePaths);
}
async function loadCheckoutProfile(repoRoot, env) {
    const override = env[AUTOPILOT_CHECKOUT_PROFILE_ENV];
    if (override !== undefined) {
        const trimmed = override.trim();
        if (trimmed.length === 0)
            fail('invalid-profile-override', `${AUTOPILOT_CHECKOUT_PROFILE_ENV} must be non-empty when set.`);
        if (!isAbsolute(trimmed))
            fail('invalid-profile-override', `${AUTOPILOT_CHECKOUT_PROFILE_ENV} must be absolute when set.`, [trimmed]);
        return { profile: await readProfileFile(trimmed), origin: 'env', sourcePath: resolve(trimmed) };
    }
    const projectPath = join(repoRoot, AUTOPILOT_PROJECT_CHECKOUT_PROFILE);
    if (existsSync(projectPath)) {
        return { profile: await readProfileFile(projectPath), origin: 'project', sourcePath: projectPath };
    }
    return { profile: defaultAutopilotCheckoutProfile(), origin: 'auto-profile', sourcePath: null };
}
async function readProfileFile(path) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('invalid-profile-json', `checkout profile is not readable JSON: ${errorMessage(error)}`, [path]);
    }
    return parseAutopilotCheckoutProfile(parsed, path);
}
function parseAutoProfileConfig(value, defaults, source) {
    if (value === undefined)
        return defaults;
    const record = requireRecord(value, `${source}:auto_profile`);
    return Object.freeze({
        enabled: optionalBoolean(record, 'enabled', defaults.enabled),
        heavy_dir_threshold_bytes: optionalNonNegativeInteger(record, 'heavy_dir_threshold_bytes', defaults.heavy_dir_threshold_bytes),
        max_scan_depth: optionalPositiveInteger(record, 'max_scan_depth', defaults.max_scan_depth),
    });
}
function parseDiskGateConfig(value, defaults, source) {
    if (value === undefined)
        return defaults;
    const record = requireRecord(value, `${source}:disk_gate`);
    return Object.freeze({
        expected_parallel_units: optionalPositiveInteger(record, 'expected_parallel_units', defaults.expected_parallel_units),
        headroom_factor: optionalPositiveNumber(record, 'headroom_factor', defaults.headroom_factor),
        floor_free_bytes: optionalNonNegativeInteger(record, 'floor_free_bytes', defaults.floor_free_bytes),
    });
}
function parseMaterializationConfig(value, defaults, source) {
    if (value === undefined)
        return defaults;
    const record = requireRecord(value, `${source}:materialization`);
    return Object.freeze({
        auto_read_claims: optionalBoolean(record, 'auto_read_claims', defaults.auto_read_claims),
        max_auto_read_bytes: optionalNonNegativeInteger(record, 'max_auto_read_bytes', defaults.max_auto_read_bytes),
        max_single_materialization_bytes: optionalNonNegativeInteger(record, 'max_single_materialization_bytes', defaults.max_single_materialization_bytes),
        max_auto_read_paths: optionalPositiveInteger(record, 'max_auto_read_paths', defaults.max_auto_read_paths),
    });
}
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
async function streamGitLsTree(revision, cwd, onRecord) {
    const output = runGitQuery({ descriptor: { kind: 'ls-tree-recursive', revision, includeSize: true }, cwd }).stdout;
    let cursor = 0;
    while (cursor < output.length) {
        const delimiter = output.indexOf(0, cursor);
        if (delimiter < 0) {
            fail('invalid-ls-tree-output', 'git ls-tree output ended without a NUL record delimiter.', [`trailing_bytes=${String(output.length - cursor)}`]);
        }
        if (delimiter > cursor)
            onRecord(output.subarray(cursor, delimiter));
        cursor = delimiter + 1;
    }
}
function parseTrackedTreeRecord(raw) {
    const tabIndex = raw.indexOf(9);
    if (tabIndex < 0) {
        fail('invalid-ls-tree-output', 'git ls-tree output did not contain a path separator.', [bytesToHex(raw.subarray(0, 120))]);
    }
    const meta = decodeUtf8(raw.subarray(0, tabIndex), 'git ls-tree metadata').trim().split(/\s+/u);
    if (meta.length < 4) {
        fail('invalid-ls-tree-output', 'git ls-tree output did not contain mode, type, object id, and size metadata.', [bytesToHex(raw.subarray(0, 120))]);
    }
    let decodedPath;
    try {
        decodedPath = STRICT_UTF8_DECODER.decode(raw.subarray(tabIndex + 1));
    }
    catch (error) {
        fail('invalid-ls-tree-output', `git ls-tree path was not valid UTF-8: ${errorMessage(error)}`, [bytesToHex(raw.subarray(tabIndex + 1, tabIndex + 61))]);
    }
    const path = normalizeRepoRelativePath(decodedPath);
    const objectType = parseGitObjectType(meta[1]);
    const byteToken = meta[3];
    if (byteToken === undefined || (!/^\d+$/u.test(byteToken) && byteToken !== '-')) {
        fail('invalid-ls-tree-output', 'git ls-tree output contained an invalid object-size token.', [byteToken ?? '<missing>', path]);
    }
    const byteCount = byteToken === '-' ? 0 : Number(byteToken);
    if (!Number.isSafeInteger(byteCount)) {
        fail('invalid-ls-tree-output', 'git ls-tree object size exceeded the JavaScript safe-integer range.', [byteToken, path]);
    }
    return Object.freeze({ path, byte_count: byteCount, object_type: objectType });
}
function decodeUtf8(value, label) {
    try {
        return STRICT_UTF8_DECODER.decode(value);
    }
    catch (error) {
        fail('invalid-ls-tree-output', `${label} was not valid UTF-8: ${errorMessage(error)}`, [bytesToHex(value.subarray(0, 60))]);
    }
}
function bytesToHex(value) {
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function parseGitObjectType(value) {
    if (value === 'blob' || value === 'tree' || value === 'commit' || value === 'tag')
        return value;
    return 'unknown';
}
function patternToApproximateMaterializationPath(pattern) {
    if (pattern.startsWith('!'))
        return null;
    if (pattern === '/*')
        return null;
    if (!pattern.startsWith('/'))
        return null;
    const raw = pattern.slice(1);
    if (raw.length === 0)
        return null;
    return raw;
}
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail('invalid-profile', `${label} must be an object.`);
    return value;
}
function expectString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        fail('invalid-profile', `${key} must be a non-empty string.`);
    return value;
}
function expectNullableString(record, key) {
    const value = record[key];
    if (value === null)
        return null;
    if (typeof value === 'string')
        return value;
    fail('invalid-profile', `${key} must be a string or null.`);
}
function expectStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        fail('invalid-profile', `${key} must be a string array.`);
    return Object.freeze([...value]);
}
function optionalStringArray(record, key, fallback) {
    if (record[key] === undefined)
        return fallback;
    return expectStringArray(record, key);
}
function expectNonNegativeInteger(record, key) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        fail('invalid-profile', `${key} must be a non-negative safe integer.`);
    return value;
}
function optionalNonNegativeInteger(record, key, fallback) {
    if (record[key] === undefined)
        return fallback;
    return expectNonNegativeInteger(record, key);
}
function optionalPositiveInteger(record, key, fallback) {
    if (record[key] === undefined)
        return fallback;
    const value = expectNonNegativeInteger(record, key);
    if (value <= 0)
        fail('invalid-profile', `${key} must be greater than zero.`);
    return value;
}
function optionalPositiveNumber(record, key, fallback) {
    if (record[key] === undefined)
        return fallback;
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        fail('invalid-profile', `${key} must be a finite number greater than zero.`);
    return value;
}
function optionalBoolean(record, key, fallback) {
    if (record[key] === undefined)
        return fallback;
    const value = record[key];
    if (typeof value !== 'boolean')
        fail('invalid-profile', `${key} must be boolean.`);
    return value;
}
function expectConst(record, key, expected) {
    const value = record[key];
    if (value !== expected)
        fail('invalid-profile', `${key} must equal ${expected}.`);
    return expected;
}
function expectOneOf(record, key, values) {
    const value = record[key];
    if (typeof value !== 'string' || !values.includes(value)) {
        fail('invalid-profile', `${key} must be one of: ${values.join(', ')}.`);
    }
    return value;
}
function expectSha(record, key) {
    const value = expectString(record, key);
    if (!/^sha256:[a-f0-9]{64}$/u.test(value))
        fail('invalid-profile', `${key} must be a sha256 digest.`);
    return value;
}
function sha256Json(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
