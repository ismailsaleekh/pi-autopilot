import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';

export interface ParsedAutopilotArgs {
  readonly workstream: string;
  readonly remainder: string;
}

export interface ParsedAutopilotCloseArgs {
  readonly workstream: string;
  readonly workstreamRun: string | null;
  readonly dryRun: boolean;
}

export interface ParsedAutopilotInjectArgs {
  readonly workstream: string;
}

export type ParseAutopilotArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotCloseArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotCloseArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotInjectArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotInjectArgs }
  | { readonly ok: false; readonly message: string };

const WORKSTREAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidWorkstreamSlug(value: string): boolean {
  return WORKSTREAM_PATTERN.test(value);
}

export function parseAutopilotArgs(args: string): ParseAutopilotArgsResult {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Usage: /autopilot <workstream> [task intro or current focus]' };
  }
  const firstSpace = trimmed.search(/\s/);
  const workstream = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
  if (!isValidWorkstreamSlug(workstream)) {
    return {
      ok: false,
      message:
        'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
    };
  }
  const remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
  return { ok: true, value: { workstream, remainder } };
}

export function parseAutopilotInjectArgs(args: string): ParseAutopilotInjectArgsResult {
  const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length !== 1) {
    return { ok: false, message: 'Usage: /autopilot-inject <workstream>' };
  }
  const workstream = tokens[0];
  if (workstream === undefined || !isValidWorkstreamSlug(workstream)) {
    return {
      ok: false,
      message:
        'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
    };
  }
  return { ok: true, value: { workstream } };
}

export function parseAutopilotCloseArgs(args: string): ParseAutopilotCloseArgsResult {
  return parseAutopilotLifecycleArgs(args, 'Usage: /autopilot-close <workstream> [--run <workstream_run>] [--dry-run]');
}

export function parseAutopilotAbortArgs(args: string): ParseAutopilotCloseArgsResult {
  return parseAutopilotLifecycleArgs(args, 'Usage: /autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]');
}

function parseAutopilotLifecycleArgs(args: string, usage: string): ParseAutopilotCloseArgsResult {
  const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { ok: false, message: usage };
  }
  const workstream = tokens[0];
  if (workstream === undefined || !isValidWorkstreamSlug(workstream)) {
    return {
      ok: false,
      message:
        'Workstream must start with a letter or digit and contain only letters, digits, dot, underscore, or dash.',
    };
  }
  let workstreamRun: string | null = null;
  let dryRun = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--run') {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: '--run requires a non-empty workstream_run value.' };
      }
      if (workstreamRun !== null) return { ok: false, message: '--run may be provided at most once.' };
      workstreamRun = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `Unknown /autopilot-close argument: ${token}` };
  }
  return { ok: true, value: { workstream, workstreamRun, dryRun } };
}

export function runtimeRootForWorkstream(workstream: string): string {
  if (!isValidWorkstreamSlug(workstream)) {
    throw new Error(`Invalid Autopilot workstream slug: ${workstream}`);
  }
  return `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
}

export function packageRootFromModuleUrl(moduleUrl: string): URL {
  return new URL('../', moduleUrl);
}

export function runnerInvocationFromModuleUrl(moduleUrl: string): string {
  const runner = new URL('bin/autopilot-agent-run.mjs', packageRootFromModuleUrl(moduleUrl));
  return runner.pathname;
}
