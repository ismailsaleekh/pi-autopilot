import { randomBytes } from 'node:crypto';

import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';

export interface ParsedAutopilotArgs {
  readonly workstream: string;
  readonly remainder: string;
  readonly rosterId: string | null;
}

/**
 * The launch-aware superset of {@link ParsedAutopilotArgs}. This is a SEPARATE,
 * versioned launch-option result so the legacy public `ParsedAutopilotArgs`
 * contract is byte-unchanged (no enumerable `launchManifestPath:null` field on
 * the legacy result). Only the D65 launch command path consumes this shape.
 */
export interface ParsedAutopilotLaunchArgs {
  readonly workstream: string;
  readonly remainder: string;
  readonly rosterId: string | null;
  /**
   * The absolute path to a sealed D65 prelaunch manifest, when the caller
   * supplies `--launch-manifest <absolute-path>`. Its presence selects the
   * closed D65 launch mode; its absence preserves the exact legacy behavior.
   */
  readonly launchManifestPath: string | null;
}

export interface ParsedAutopilotCloseArgs {
  readonly workstream: string;
  readonly workstreamRun: string | null;
  readonly dryRun: boolean;
}

export interface ParsedAutopilotConfigArgs {
  readonly action: 'show' | 'parallel-cap';
  readonly parallelCap?: number;
}

export interface ParsedAutopilotClaimGcArgs {
  readonly apply: boolean;
}

export interface ParsedAutopilotCoordinationArgs {
  readonly action: 'status' | 'doctor';
}

export interface ParsedAutopilotInjectArgs {
  readonly workstream: string;
}

export type ParseAutopilotArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotLaunchArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotLaunchArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotCloseArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotCloseArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotInjectArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotInjectArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotConfigArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotConfigArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotClaimGcArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotClaimGcArgs }
  | { readonly ok: false; readonly message: string };

export type ParseAutopilotCoordinationArgsResult =
  | { readonly ok: true; readonly value: ParsedAutopilotCoordinationArgs }
  | { readonly ok: false; readonly message: string };

const WORKSTREAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSTREAM_RUN_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;
const ROSTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const WORKSTREAM_RUN_MAX_LENGTH = 120;

export interface ParseAutopilotArgsOptions {
  readonly parseRoster?: boolean;
}

export function isValidWorkstreamSlug(value: string): boolean {
  return WORKSTREAM_PATTERN.test(value);
}

export function isValidRosterId(value: string): boolean {
  return ROSTER_ID_PATTERN.test(value);
}

export function isValidWorkstreamRun(value: string): boolean {
  return WORKSTREAM_RUN_PATTERN.test(value);
}

export function buildAutopilotWorkstreamRun(workstream: string, now: Date = new Date(), entropy = randomBytes(3).toString('hex')): string {
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
export function parseAutopilotArgs(args: string, options: ParseAutopilotArgsOptions = {}): ParseAutopilotArgsResult {
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
  let remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
  let rosterId: string | null = null;
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
export function parseAutopilotLaunchArgs(args: string, options: ParseAutopilotArgsOptions = {}): ParseAutopilotLaunchArgsResult {
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
  let remainder = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
  let rosterId: string | null = null;
  let launchManifestPath: string | null = null;
  // `--launch-manifest <absolute-path>` selects the closed D65 launch mode. It
  // may appear before or after `--roster`; the remaining text is the task intro.
  // A relative or empty path is rejected (no inferred default).
  {
    const match = /^--launch-manifest(?:\s+|=)(\S+)(?:\s+([\s\S]*))?$/u.exec(remainder);
    if (/^--launch-manifest(?:\s|=|$)/u.test(remainder)) {
      const candidate = match?.[1];
      if (candidate === undefined) return { ok: false, message: 'Usage: /autopilot <workstream> --launch-manifest <absolute-path> [--roster <id>] [task intro]' };
      if (!candidate.startsWith('/') || candidate.includes('\u0000')) return { ok: false, message: '--launch-manifest requires an absolute path.' };
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
    if (candidate === undefined) return { ok: false, message: 'Usage: /autopilot <workstream> --launch-manifest <absolute-path> [--roster <id>] [task intro]' };
    if (!candidate.startsWith('/') || candidate.includes('\u0000')) return { ok: false, message: '--launch-manifest requires an absolute path.' };
    launchManifestPath = candidate;
    remainder = (match?.[2] ?? '').trim();
  }
  return { ok: true, value: { workstream, remainder, rosterId, launchManifestPath } };
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

export function parseAutopilotConfigArgs(args: string): ParseAutopilotConfigArgsResult {
  const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 1 && tokens[0] === 'show') return { ok: true, value: { action: 'show' } };
  if (tokens.length === 2 && tokens[0] === 'parallel-cap') {
    const raw = tokens[1];
    if (raw === undefined || !/^\d+$/u.test(raw)) return { ok: false, message: 'parallel-cap requires an integer in range 1..32.' };
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
      return { ok: false, message: 'parallel-cap requires an integer in range 1..32.' };
    }
    return { ok: true, value: { action: 'parallel-cap', parallelCap: parsed } };
  }
  return { ok: false, message: 'Usage: /autopilot-config show OR /autopilot-config parallel-cap <1..32>' };
}

export function parseAutopilotClaimGcArgs(args: string): ParseAutopilotClaimGcArgsResult {
  const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === '--dry-run')) return { ok: true, value: { apply: false } };
  if (tokens.length === 1 && tokens[0] === '--apply') return { ok: true, value: { apply: true } };
  return { ok: false, message: 'Usage: /autopilot-claim-gc --dry-run OR /autopilot-claim-gc --apply' };
}

export function parseAutopilotCoordinationArgs(args: string): ParseAutopilotCoordinationArgsResult {
  const tokens = args.trim().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 1 && (tokens[0] === 'status' || tokens[0] === 'doctor')) {
    return { ok: true, value: { action: tokens[0] } };
  }
  return { ok: false, message: 'Usage: /autopilot-coordination status OR /autopilot-coordination doctor' };
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
