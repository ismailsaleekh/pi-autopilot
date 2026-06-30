import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';

export interface ParsedAutopilotArgs {
  readonly workstream: string;
  readonly remainder: string;
}

export type ParseAutopilotArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotArgs }
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
