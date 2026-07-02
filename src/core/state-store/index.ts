import { constants as fsConstants, existsSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  parseAutopilotEventRow,
  parseAutopilotReceipt,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  parseAutopilotUnitSpec,
} from '../contracts/index.ts';
import type {
  AutopilotEventRow,
  AutopilotReceipt,
  AutopilotState,
  AutopilotStatusEntry,
  AutopilotUnitSpec,
} from '../contracts/types.ts';
import {
  readAutopilotPurposeSnapshot,
  type AutopilotPurposeSnapshot,
} from './purpose.ts';

export * from './purpose.ts';

const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export class AutopilotStateStoreError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AutopilotStateStoreError';
    this.code = code;
  }
}

export interface AutopilotResumeSnapshot {
  readonly purpose: AutopilotPurposeSnapshot;
  readonly state: AutopilotState;
  readonly eventsTail: readonly AutopilotEventRow[];
  readonly statuses: Readonly<Record<string, AutopilotStatusEntry>>;
  readonly receipts: Readonly<Record<string, AutopilotReceipt>>;
}

export interface AutopilotStateReferenceValidationResult {
  readonly statuses: Readonly<Record<string, AutopilotStatusEntry>>;
  readonly receipts: Readonly<Record<string, AutopilotReceipt>>;
  readonly specs: Readonly<Record<string, AutopilotUnitSpec>>;
}

/**
 * Write a validated AutopilotState to disk atomically using temp-file + rename.
 * No partial or corrupt files are left on crash.
 *
 * References are validated against `artifactRoot` unless `validateReferences` is
 * explicitly `false`. By default the directory containing `statePath` is used as
 * the artifact root.
 *
 * Migration note: This function never reads from a legacy runtime root.
 * If you need to migrate old state, copy it into `.pi/autopilot/<workstream>`
 * first and then resume from there. Migration is opt-in and off by default.
 */
export async function writeAutopilotStateAtomic(input: {
  readonly statePath: string;
  readonly state: AutopilotState;
  readonly artifactRoot?: string;
  readonly validateReferences?: boolean;
}): Promise<void> {
  const state = parseAutopilotState(input.state);
  if (input.validateReferences !== false) {
    await validateAutopilotStateReferences({
      state,
      artifactRoot: input.artifactRoot ?? dirname(input.statePath),
    });
  }
  await writeJsonAtomic(input.statePath, state);
}

/**
 * Append a single bounded AutopilotEventRow to events.jsonl.
 * The write is append-only: existing rows are never overwritten or rewritten.
 * Event ids must be strictly monotonic (1, 2, 3, …).
 */
export async function appendAutopilotEventRow(input: {
  readonly eventsPath: string;
  readonly event: AutopilotEventRow;
}): Promise<void> {
  const event = parseAutopilotEventRow(input.event);
  const existing = await readAutopilotEventsIfPresent(input.eventsPath);
  const previous = lastEvent(existing);
  const expectedId = previous === undefined ? 1 : previous.id + 1;
  if (event.id !== expectedId) {
    throw new AutopilotStateStoreError(
      'event-id-not-monotonic',
      `event id ${String(event.id)} must equal next monotonic id ${String(expectedId)}`,
    );
  }
  await mkdir(dirname(input.eventsPath), { recursive: true });
  await appendFile(input.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}

/**
 * Load a resume snapshot: validated state + bounded event tail + reference
 * artifacts (statuses, receipts).
 *
 * By default reads from `.pi/autopilot/<workstream>/state.json` and
 * `.pi/autopilot/<workstream>/events.jsonl`. Legacy runtime directories are
 * never consulted unless you explicitly migrate their contents into the
 * Autopilot root first. Migration is opt-in and off by default.
 */
export async function readAutopilotResumeSnapshot(input: {
  readonly root: string;
  readonly statePath?: string;
  readonly eventsPath?: string;
  readonly eventTailLimit?: number;
  readonly validateReferences?: boolean;
}): Promise<AutopilotResumeSnapshot> {
  assertAbsoluteRoot(input.root);
  const statePath = input.statePath ?? join(input.root, 'state.json');
  const eventsPath = input.eventsPath ?? join(input.root, 'events.jsonl');
  const eventTailLimit = input.eventTailLimit ?? 50;
  if (!Number.isInteger(eventTailLimit) || eventTailLimit < 0 || eventTailLimit > 10_000) {
    throw new AutopilotStateStoreError(
      'invalid-event-tail-limit',
      `eventTailLimit must be an integer in [0, 10000], got ${String(eventTailLimit)}`,
    );
  }

  const purpose = await readAutopilotPurposeSnapshot({
    root: input.root,
    decisionTailLimit: eventTailLimit,
  });
  const state = parseAutopilotState(await readJsonObject(statePath, 'state.json'));
  const events = await readAutopilotEventsIfPresent(eventsPath);
  const newestEvent = lastEvent(events);
  if (newestEvent !== undefined && newestEvent.id !== state.last_event_id) {
    throw new AutopilotStateStoreError(
      'state-event-id-mismatch',
      `state.last_event_id ${String(state.last_event_id)} does not match events tail id ${String(
        newestEvent.id,
      )}`,
    );
  }
  if (events.length === 0 && state.last_event_id !== 0) {
    throw new AutopilotStateStoreError(
      'state-event-id-mismatch',
      `state.last_event_id ${String(state.last_event_id)} is non-zero but events.jsonl is empty/missing`,
    );
  }

  const emptyStatuses: Record<string, AutopilotStatusEntry> = {};
  const emptyReceipts: Record<string, AutopilotReceipt> = {};
  const emptySpecs: Record<string, AutopilotUnitSpec> = {};
  const refs =
    input.validateReferences === false
      ? { statuses: emptyStatuses, receipts: emptyReceipts, specs: emptySpecs }
      : await validateAutopilotStateReferences({ state, artifactRoot: input.root });
  const tail = eventTailLimit === 0 ? [] : events.slice(-eventTailLimit);
  const frozenTail = Object.freeze(tail);
  return Object.freeze({
    purpose,
    state,
    eventsTail: frozenTail,
    statuses: refs.statuses,
    receipts: refs.receipts,
  });
}

/**
 * Validate every reference inside an AutopilotState:
 * - spec_ref  → valid AutopilotUnitSpec with matching identity
 * - status_ref → valid AutopilotStatusEntry with matching identity
 * - receipt_ref → valid AutopilotReceipt with matching identity
 *
 * All resolved paths are verified to stay within `artifactRoot`. Absolute paths
 * or traversal segments are rejected.
 */
export async function validateAutopilotStateReferences(input: {
  readonly state: AutopilotState;
  readonly artifactRoot: string;
}): Promise<AutopilotStateReferenceValidationResult> {
  const state = parseAutopilotState(input.state);
  assertAbsoluteRoot(input.artifactRoot);
  const statuses: Record<string, AutopilotStatusEntry> = {};
  const receipts: Record<string, AutopilotReceipt> = {};
  const specs: Record<string, AutopilotUnitSpec> = {};
  validateQueueStateCoherence(state);

  for (const unit of Object.values(state.units)) {
    let spec: AutopilotUnitSpec | undefined;
    if (unit.spec_ref !== undefined) {
      const specPath = resolveRef(input.artifactRoot, unit.spec_ref, 'spec_ref');
      spec = parseAutopilotUnitSpec(await readJsonObject(specPath, unit.spec_ref));
      if (spec.workstream !== state.workstream) {
        throw new AutopilotStateStoreError(
          'spec-ref-mismatch',
          `${unit.spec_ref} workstream does not match state workstream`,
        );
      }
      if (spec.unit_id !== unit.unit_id || spec.role !== unit.role || spec.attempt !== unit.attempt) {
        throw new AutopilotStateStoreError(
          'spec-ref-mismatch',
          `${unit.spec_ref} identity does not match state unit ${unit.unit_id}`,
        );
      }
      specs[unit.spec_ref] = spec;
    }

    let statusPath: string | undefined;
    if (unit.status_ref !== undefined) {
      statusPath = resolveRef(input.artifactRoot, unit.status_ref, 'status_ref');
      const status = parseAutopilotStatusEntry(await readJsonObject(statusPath, unit.status_ref), {
        ...(spec === undefined ? {} : { unitSpec: spec }),
        artifactRoot: input.artifactRoot,
      });
      if (
        status.workstream !== state.workstream ||
        status.unit_id !== unit.unit_id ||
        status.role !== unit.role ||
        status.attempt !== unit.attempt
      ) {
        throw new AutopilotStateStoreError(
          'status-ref-mismatch',
          `${unit.status_ref} identity does not match state unit ${unit.unit_id}`,
        );
      }
      statuses[unit.status_ref] = status;
    }

    if (unit.receipt_ref !== undefined) {
      const receiptPath = resolveRef(input.artifactRoot, unit.receipt_ref, 'receipt_ref');
      const receipt = parseAutopilotReceipt(await readJsonObject(receiptPath, unit.receipt_ref), {
        ...(spec === undefined ? {} : { unitSpec: spec }),
        ...(statusPath === undefined ? {} : { statusOutputPath: statusPath }),
      });
      if (
        receipt.workstream !== state.workstream ||
        receipt.unit_id !== unit.unit_id ||
        receipt.role !== unit.role ||
        receipt.attempt !== unit.attempt
      ) {
        throw new AutopilotStateStoreError(
          'receipt-ref-mismatch',
          `${unit.receipt_ref} identity does not match state unit ${unit.unit_id}`,
        );
      }
      receipts[unit.receipt_ref] = receipt;
    }
  }

  const frozenStatuses = Object.freeze(statuses);
  const frozenReceipts = Object.freeze(receipts);
  const frozenSpecs = Object.freeze(specs);
  return Object.freeze({
    statuses: frozenStatuses,
    receipts: frozenReceipts,
    specs: frozenSpecs,
  });
}

/**
 * Read all AutopilotEventRows from an events.jsonl file.
 * Returns an empty frozen array if the file does not exist or is empty.
 * Validates monotonic ids and rejects malformed JSON or invalid event rows.
 */
export async function readAutopilotEventsIfPresent(
  eventsPath: string,
): Promise<readonly AutopilotEventRow[]> {
  if (!existsSync(eventsPath)) return Object.freeze([]);
  const content = await readFile(eventsPath, 'utf8');
  if (content.trim().length === 0) return Object.freeze([]);
  const events: AutopilotEventRow[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonValue(line);
    } catch (error) {
      throw new AutopilotStateStoreError(
        'corrupt-events-jsonl',
        `events.jsonl line ${String(index + 1)} is not valid JSON: ${errorMessage(error)}`,
      );
    }
    let event: AutopilotEventRow;
    try {
      event = parseAutopilotEventRow(parsed);
    } catch (error) {
      throw new AutopilotStateStoreError(
        'corrupt-events-jsonl',
        `events.jsonl line ${String(index + 1)} failed Autopilot event validation: ${errorMessage(error)}`,
      );
    }
    const previous = lastEvent(events);
    const expectedId = previous === undefined ? 1 : previous.id + 1;
    if (event.id !== expectedId) {
      throw new AutopilotStateStoreError(
        'corrupt-events-jsonl',
        `events.jsonl line ${String(index + 1)} id ${String(event.id)} must equal ${String(
          expectedId,
        )}`,
      );
    }
    events.push(event);
  }
  return Object.freeze(events);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${String(Date.now())}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    throw new AutopilotStateStoreError(
      'missing-reference',
      `${label} is not readable at ${path}: ${errorMessage(error)}`,
    );
  }
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new AutopilotStateStoreError('missing-reference', `${label} is not a file at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = parseJsonValue(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AutopilotStateStoreError(
      'corrupt-json-reference',
      `${label} is not valid JSON at ${path}: ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AutopilotStateStoreError('corrupt-json-reference', `${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function lastEvent(events: readonly AutopilotEventRow[]): AutopilotEventRow | undefined {
  return events.length === 0 ? undefined : events[events.length - 1];
}

function validateQueueStateCoherence(state: AutopilotState): void {
  const queueExpectations = [
    ['ready_queue', state.ready_queue, 'ready'],
    ['running', state.running, 'running'],
    ['blocked', state.blocked, 'blocked'],
    ['completed', state.completed, 'completed'],
  ] as const;
  for (const [queueName, unitIds, expectedState] of queueExpectations) {
    for (const unitId of unitIds) {
      const unit = state.units[unitId];
      if (unit === undefined) continue;
      if (unit.state !== expectedState) {
        throw new AutopilotStateStoreError(
          'queue-state-mismatch',
          `${queueName} contains ${unitId} but units.${unitId}.state is ${unit.state}, expected ${expectedState}`,
        );
      }
    }
  }
}

function resolveRef(root: string, ref: string, label: string): string {
  const resolved = resolve(root, ref);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new AutopilotStateStoreError('reference-escape', `${label} ${ref} escapes artifact root`);
  }
  return resolved;
}

function assertAbsoluteRoot(root: string): void {
  if (!isAbsolute(root)) {
    throw new AutopilotStateStoreError('invalid-artifact-root', `artifact root must be absolute: ${root}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
