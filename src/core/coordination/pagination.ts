import { createHash } from 'node:crypto';

import { CoordinationRuntimeError } from './failures.ts';
import { COORDINATOR_MAX_FRAME_BYTES } from './runtime-constants.ts';

export const COORDINATOR_PAGE_TARGET_BYTES = 786_432;
export const COORDINATOR_MAX_PAGE_ENTITY_BYTES = 524_288;

interface JsonMap {
  readonly [key: string]: unknown;
}

interface CursorDocument {
  readonly schema_version: 'autopilot.coordinator_cursor.v1';
  readonly kind: string;
  readonly scope_sha256: string;
  readonly revision_sha256: string;
  readonly section: string;
  readonly snapshot: string | null;
  readonly offset: number;
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function paginationRevision(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function paginationScope(parts: readonly (string | null)[]): string {
  return `sha256:${createHash('sha256').update(parts.map((part) => part ?? '<null>').join('\0'), 'utf8').digest('hex')}`;
}

function cursorDigest(encoded: string): string {
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function encodeCursorBody(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeCursorBody(value: string): string {
  if (value.length % 2 !== 0 || !/^[a-f0-9]+$/u.test(value)) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor body is not lowercase hexadecimal');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodePaginationCursor(input: {
  readonly kind: string;
  readonly scopeSha256: string;
  readonly revisionSha256: string;
  readonly section: string;
  readonly snapshot?: string | null;
  readonly offset: number;
}): string {
  const document: CursorDocument = {
    schema_version: 'autopilot.coordinator_cursor.v1',
    kind: input.kind,
    scope_sha256: input.scopeSha256,
    revision_sha256: input.revisionSha256,
    section: input.section,
    snapshot: input.snapshot ?? null,
    offset: input.offset,
  };
  const encoded = encodeCursorBody(JSON.stringify(document));
  return `cursor-${encoded}-${cursorDigest(encoded)}`;
}

function decodePaginationCursor(value: string): CursorDocument {
  const match = /^cursor-([a-f0-9]+)-([a-f0-9]{64})$/u.exec(value);
  if (match === null) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor is malformed');
  const encoded = match[1];
  const digest = match[2];
  if (encoded === undefined || digest === undefined || cursorDigest(encoded) !== digest) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor digest is invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(decodeCursorBody(encoded)) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor body is invalid JSON', [error instanceof Error ? error.message : String(error)]); }
  if (!isJsonMap(parsed)) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor body must be an object');
  const fields = Object.keys(parsed).sort();
  const expectedFields = ['kind', 'offset', 'revision_sha256', 'schema_version', 'scope_sha256', 'section', 'snapshot'];
  if (fields.length !== expectedFields.length || fields.some((field, index) => field !== expectedFields[index])) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor fields are incompatible', fields);
  const offset = parsed['offset'];
  const snapshot = parsed['snapshot'];
  if (parsed['schema_version'] !== 'autopilot.coordinator_cursor.v1' || typeof parsed['kind'] !== 'string' || typeof parsed['scope_sha256'] !== 'string' || typeof parsed['revision_sha256'] !== 'string' || typeof parsed['section'] !== 'string' || (snapshot !== null && typeof snapshot !== 'string')) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor body has invalid field types');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new CoordinationRuntimeError('invalid-request', 'coordinator pagination cursor offset is invalid');
  return { schema_version: 'autopilot.coordinator_cursor.v1', kind: parsed['kind'], scope_sha256: parsed['scope_sha256'], revision_sha256: parsed['revision_sha256'], section: parsed['section'], snapshot, offset };
}

export function paginationCursorSnapshot(value: string, expected: { readonly kind: string; readonly scopeSha256: string; readonly section: string }): string | null {
  const parsed = decodePaginationCursor(value);
  if (parsed.kind !== expected.kind || parsed.scope_sha256 !== expected.scopeSha256 || parsed.section !== expected.section || parsed.offset !== 0) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator pagination scan token belongs to a different query scope');
  return parsed.snapshot;
}

export function paginationCursorState(value: string, expected: { readonly kind: string; readonly scopeSha256: string; readonly section: string }): { readonly revisionSha256: string; readonly snapshot: string | null; readonly offset: number } {
  const parsed = decodePaginationCursor(value);
  if (parsed.kind !== expected.kind || parsed.scope_sha256 !== expected.scopeSha256 || parsed.section !== expected.section) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator pagination cursor belongs to a different query scope');
  return { revisionSha256: parsed.revision_sha256, snapshot: parsed.snapshot, offset: parsed.offset };
}

export function parsePaginationCursor(value: string, expected: {
  readonly kind: string;
  readonly scopeSha256: string;
  readonly revisionSha256: string;
  readonly section: string;
  readonly snapshot?: string | null;
}): number {
  const parsed = decodePaginationCursor(value);
  if (parsed.kind !== expected.kind || parsed.scope_sha256 !== expected.scopeSha256 || parsed.section !== expected.section || parsed.snapshot !== (expected.snapshot ?? null)) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator pagination cursor belongs to a different query scope');
  if (parsed.revision_sha256 !== expected.revisionSha256) throw new CoordinationRuntimeError('stale-version', 'coordinator pagination cursor drifted from its durable snapshot');
  return parsed.offset;
}

export function byteBudgetPage<T>(input: {
  readonly items: readonly T[];
  readonly offset: number;
  readonly cursorForOffset: (offset: number) => string;
  readonly payloadForPage: (items: readonly T[], nextCursor: string | null) => Readonly<Record<string, unknown>>;
  readonly maximumItems?: number;
}): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  if (input.offset > input.items.length) throw new CoordinationRuntimeError('stale-version', 'coordinator pagination cursor is beyond the durable collection');
  const page: T[] = [];
  let nextOffset = input.offset;
  while (nextOffset < input.items.length && page.length < (input.maximumItems ?? 1_024)) {
    const entity = input.items[nextOffset];
    if (entity === undefined) throw new CoordinationRuntimeError('store-corrupt', 'coordinator pagination collection has a missing entity');
    const entityBytes = encodedJsonBytes(entity);
    if (entityBytes > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', `single durable coordinator entity exceeds the ${String(COORDINATOR_MAX_PAGE_ENTITY_BYTES)} byte pagination ceiling`, [`offset=${String(nextOffset)}`, `encoded_bytes=${String(entityBytes)}`]);
    const candidate = [...page, entity];
    const candidateOffset = nextOffset + 1;
    const candidateCursor = candidateOffset < input.items.length ? input.cursorForOffset(candidateOffset) : null;
    const candidateBytes = encodedJsonBytes(input.payloadForPage(candidate, candidateCursor));
    if (candidateBytes > COORDINATOR_PAGE_TARGET_BYTES) {
      if (page.length === 0) throw new CoordinationRuntimeError('frame-too-large', 'single durable coordinator entity cannot fit in a byte-budgeted page', [`offset=${String(nextOffset)}`, `encoded_bytes=${String(candidateBytes)}`]);
      break;
    }
    page.push(entity);
    nextOffset = candidateOffset;
  }
  const nextCursor = nextOffset < input.items.length ? input.cursorForOffset(nextOffset) : null;
  const finalBytes = encodedJsonBytes(input.payloadForPage(page, nextCursor));
  if (finalBytes > COORDINATOR_PAGE_TARGET_BYTES || finalBytes >= COORDINATOR_MAX_FRAME_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'byte-budgeted coordinator page exceeded its locked encoded ceiling', [`encoded_bytes=${String(finalBytes)}`]);
  return { items: Object.freeze(page), nextCursor };
}
