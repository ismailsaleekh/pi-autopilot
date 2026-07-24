import { randomBytes } from 'node:crypto';
import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
const WORKSTREAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Locally generated run ids remain lowercase for compatibility, while sealed
// production/D65 run authority may carry canonical UTC `T`/`Z` bytes. Keep the
// activation grammar aligned with the closed roster schemas without admitting
// separators, traversal, Unicode, or more than 120 ASCII bytes.
const WORKSTREAM_RUN_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,119}$/u;
const AUTOPILOT_REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;
const ROSTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const WORKSTREAM_RUN_MAX_LENGTH = 120;
export function isValidWorkstreamSlug(value) {
    return WORKSTREAM_PATTERN.test(value);
}
export function isValidRosterId(value) {
    return ROSTER_ID_PATTERN.test(value);
}
export function isValidWorkstreamRun(value) {
    return WORKSTREAM_RUN_PATTERN.test(value);
}
/** Closed repo-id grammar shared by roster storage and sealed launch authority. */
export function isValidAutopilotRepoId(value) {
    return AUTOPILOT_REPO_ID_PATTERN.test(value);
}
export function buildAutopilotWorkstreamRun(workstream, now = new Date(), entropy = randomBytes(3).toString('hex')) {
    if (!isValidWorkstreamSlug(workstream)) {
        throw new Error(`Invalid Autopilot workstream slug: ${workstream}`);
    }
    if (!/^[a-f0-9]{6,24}$/u.test(entropy)) {
        throw new Error('Autopilot workstream_run entropy must be 6..24 lowercase hex characters.');
    }
    const normalizedWorkstream = workstream
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'run';
    const timestamp = now.toISOString()
        .replace(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, 'z')
        .replace('T', 't');
    const suffix = `${timestamp}-${entropy}`;
    const maxPrefixLength = WORKSTREAM_RUN_MAX_LENGTH - suffix.length - 1;
    const prefix = normalizedWorkstream.slice(0, Math.max(1, maxPrefixLength)).replace(/-+$/u, '') || 'run';
    const workstreamRun = `${prefix}-${suffix}`;
    if (!isValidWorkstreamRun(workstreamRun)) {
        throw new Error(`Generated invalid Autopilot workstream_run: ${workstreamRun}`);
    }
    return workstreamRun;
}
/**
 * The exact legacy `/autopilot` argument parser. Its result contract is exactly
 * `{ workstream, remainder, rosterId }` — byte-unchanged from the pre-D65
 * baseline. It has no knowledge of `--launch-manifest`; the closed D65 launch
 * mode is parsed separately by {@link parseAutopilotLaunchArgs} so the public
 * legacy result never grows an enumerable `launchManifestPath` field.
 */
export function parseAutopilotArgs(args, options = {}) {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return { ok: false, message: 'Usage: /autopilot <workstream> [task intro or current focus]' };
    }
    const firstSpace = trimmed.search(/\s/);
    const workstream = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
    if (!isValidWorkstreamSlug(workstream)) {
        return {
            ok: false,
            message: 'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
        };
    }
    let remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
    let rosterId = null;
    if (options.parseRoster !== false && /^--roster(?:\s|=|$)/u.test(remainder)) {
        const match = /^--roster\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
        const candidateRosterId = match?.[1];
        if (candidateRosterId === undefined) {
            return { ok: false, message: 'Usage: /autopilot <workstream> [--roster <id>] [task intro or current focus]' };
        }
        if (!isValidRosterId(candidateRosterId)) {
            return { ok: false, message: 'Roster id must start with a lowercase letter and contain only lowercase letters, digits, or dash.' };
        }
        rosterId = candidateRosterId;
        remainder = (match?.[2] ?? '').trim();
    }
    return { ok: true, value: { workstream, remainder, rosterId } };
}
/**
 * The launch-aware `/autopilot` argument parser. It accepts the closed D65
 * launch option `--launch-manifest <absolute-path>` (before or after
 * `--roster`) and returns the superset {@link ParsedAutopilotLaunchArgs}. When
 * no manifest is supplied, `launchManifestPath` is null and the remaining
 * `workstream`/`remainder`/`rosterId` are exactly what the legacy parser would
 * produce for the same input. This is the SOLE consumer of the launch option;
 * the legacy public result contract is never altered.
 */
export function parseAutopilotLaunchArgs(args, options = {}) {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return { ok: false, message: 'Usage: /autopilot <workstream> [task intro or current focus]' };
    }
    const firstSpace = trimmed.search(/\s/);
    const workstream = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
    if (!isValidWorkstreamSlug(workstream)) {
        return {
            ok: false,
            message: 'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
        };
    }
    let remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
    let rosterId = null;
    let launchManifestPath = null;
    // `--launch-manifest <absolute-path>` selects the closed D65 launch mode. It
    // may appear before or after `--roster`; the remaining text is the task intro.
    // A relative or empty path is rejected (no inferred default).
    {
        const match = /^--launch-manifest(?:\s+|=)(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
        if (/^--launch-manifest(?:\s|=|$)/u.test(remainder)) {
            const candidate = match?.[1];
            if (candidate === undefined)
                return { ok: false, message: 'Usage: /autopilot <workstream> --launch-manifest <absolute-path> [--roster <id>] [task intro]' };
            if (!candidate.startsWith('/') || candidate.includes('\u0000'))
                return { ok: false, message: '--launch-manifest requires an absolute path.' };
            launchManifestPath = candidate;
            remainder = (match?.[2] ?? '').trim();
        }
    }
    if (options.parseRoster !== false && /^--roster(?:\s|=|$)/u.test(remainder)) {
        const match = /^--roster\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
        const candidateRosterId = match?.[1];
        if (candidateRosterId === undefined) {
            return { ok: false, message: 'Usage: /autopilot <workstream> [--roster <id>] [task intro or current focus]' };
        }
        if (!isValidRosterId(candidateRosterId)) {
            return { ok: false, message: 'Roster id must start with a lowercase letter and contain only lowercase letters, digits, or dash.' };
        }
        rosterId = candidateRosterId;
        remainder = (match?.[2] ?? '').trim();
    }
    // Allow `--launch-manifest` to follow `--roster` as well.
    if (launchManifestPath === null && /^--launch-manifest(?:\s|=|$)/u.test(remainder)) {
        const match = /^--launch-manifest(?:\s+|=)(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
        const candidate = match?.[1];
        if (candidate === undefined)
            return { ok: false, message: 'Usage: /autopilot <workstream> --launch-manifest <absolute-path> [--roster <id>] [task intro]' };
        if (!candidate.startsWith('/') || candidate.includes('\u0000'))
            return { ok: false, message: '--launch-manifest requires an absolute path.' };
        launchManifestPath = candidate;
        remainder = (match?.[2] ?? '').trim();
    }
    // A manifest flag anywhere in unescaped task text is never ordinary prose: it
    // would otherwise silently fall through to the legacy generated-run path. All
    // launch options must precede task text. A standalone `--` explicitly starts
    // literal task text and is the only way to mention the flag without selecting
    // launch mode; the separator/remainder bytes stay legacy-compatible.
    if (containsUnescapedLaunchManifestOption(remainder)) {
        return { ok: false, message: '--launch-manifest must appear before task text, may appear at most once, and must precede an optional standalone -- task separator.' };
    }
    return { ok: true, value: { workstream, remainder, rosterId, launchManifestPath } };
}
function containsUnescapedLaunchManifestOption(value) {
    const tokens = value.split(/\s+/u).filter((token) => token.length > 0);
    const separator = tokens.indexOf('--');
    const optionTokens = separator < 0 ? tokens : tokens.slice(0, separator);
    return optionTokens.some((token) => token === '--launch-manifest' || token.startsWith('--launch-manifest='));
}
export function parseAutopilotInjectArgs(args) {
    const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length !== 1) {
        return { ok: false, message: 'Usage: /autopilot-inject <workstream>' };
    }
    const workstream = tokens[0];
    if (workstream === undefined || !isValidWorkstreamSlug(workstream)) {
        return {
            ok: false,
            message: 'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
        };
    }
    return { ok: true, value: { workstream } };
}
export function parseAutopilotCloseArgs(args) {
    return parseAutopilotLifecycleArgs(args, 'Usage: /autopilot-close <workstream> [--run <workstream_run>] [--dry-run]');
}
export function parseAutopilotAbortArgs(args) {
    return parseAutopilotLifecycleArgs(args, 'Usage: /autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]');
}
export function parseAutopilotConfigArgs(args) {
    const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length === 1 && tokens[0] === 'show')
        return { ok: true, value: { action: 'show' } };
    if (tokens.length === 2 && tokens[0] === 'parallel-cap') {
        const raw = tokens[1];
        if (raw === undefined || !/^\d+$/u.test(raw))
            return { ok: false, message: 'parallel-cap requires an integer in range 1..32.' };
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
            return { ok: false, message: 'parallel-cap requires an integer in range 1..32.' };
        }
        return { ok: true, value: { action: 'parallel-cap', parallelCap: parsed } };
    }
    return { ok: false, message: 'Usage: /autopilot-config show OR /autopilot-config parallel-cap <1..32>' };
}
export function parseAutopilotClaimGcArgs(args) {
    const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === '--dry-run'))
        return { ok: true, value: { apply: false } };
    if (tokens.length === 1 && tokens[0] === '--apply')
        return { ok: true, value: { apply: true } };
    return { ok: false, message: 'Usage: /autopilot-claim-gc --dry-run OR /autopilot-claim-gc --apply' };
}
export function parseAutopilotCoordinationArgs(args) {
    const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length === 1 && (tokens[0] === 'status' || tokens[0] === 'doctor')) {
        return { ok: true, value: { action: tokens[0] } };
    }
    return { ok: false, message: 'Usage: /autopilot-coordination status OR /autopilot-coordination doctor' };
}
function parseAutopilotLifecycleArgs(args, usage) {
    const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return { ok: false, message: usage };
    }
    const workstream = tokens[0];
    if (workstream === undefined || !isValidWorkstreamSlug(workstream)) {
        return {
            ok: false,
            message: 'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
        };
    }
    let workstreamRun = null;
    let dryRun = false;
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined)
            continue;
        if (token === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (token === '--run') {
            const value = tokens[index + 1];
            if (value === undefined || value.startsWith('--')) {
                return { ok: false, message: '--run requires a non-empty workstream_run value.' };
            }
            if (workstreamRun !== null)
                return { ok: false, message: '--run may be provided at most once.' };
            workstreamRun = value;
            index += 1;
            continue;
        }
        return { ok: false, message: `Unknown /autopilot-close argument: ${token}` };
    }
    return { ok: true, value: { workstream, workstreamRun, dryRun } };
}
export function runtimeRootForWorkstream(workstream) {
    if (!isValidWorkstreamSlug(workstream)) {
        throw new Error(`Invalid Autopilot workstream slug: ${workstream}`);
    }
    return `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
}
export function packageRootFromModuleUrl(moduleUrl) {
    return new URL('../', moduleUrl);
}
export function runnerInvocationFromModuleUrl(moduleUrl) {
    const runner = new URL('bin/autopilot-agent-run.mjs', packageRootFromModuleUrl(moduleUrl));
    return runner.pathname;
}
