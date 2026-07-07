import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
const WORKSTREAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isValidWorkstreamSlug(value) {
    return WORKSTREAM_PATTERN.test(value);
}
export function parseAutopilotArgs(args) {
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
    const remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
    return { ok: true, value: { workstream, remainder } };
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
