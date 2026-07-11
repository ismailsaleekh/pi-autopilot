import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { platform } from 'node:os';

import { CoordinatorClient, durableIdentifier } from './client.ts';
import { parseCoordinationMessage, parseCoordinationRun, parseCoordinationSessionLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { currentBootId } from './process-identity.ts';
import { COORDINATOR_HEARTBEAT_MS, COORDINATOR_SESSION_LEASE_MS } from './runtime-paths.ts';
import type { CoordinationMessage, CoordinationRun, CoordinationSessionLease, CoordinatorResponseEnvelope } from './types.ts';
import type { ActiveAutopilotRow, AutopilotRepoIdentity, ProcessEnvLike } from '../parallel-runtime.ts';

export const AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA = 'autopilot.coordinator_session_context.v1' as const;

export interface CoordinatorSessionContext {
  readonly schema_version: typeof AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA;
  readonly state_root: string;
  readonly repo_id: string;
  readonly repo_key: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly session_id: string;
  readonly session_generation: number;
  readonly run_version: number;
  readonly session_lease_id: string;
  readonly session_token: string;
  readonly session_version: number;
  readonly pid: number;
  readonly boot_id: string;
}

export interface RunSupervisorAttachment {
  readonly run: CoordinationRun;
  readonly session: CoordinationSessionLease;
  readonly contextPath: string;
  readonly context: CoordinatorSessionContext;
}

export interface CoordinationMessageInjection {
  readonly customType: 'autopilot-coordination';
  readonly content: string;
  readonly display: true;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CoordinationMessageSink {
  send(message: CoordinationMessageInjection, delivery: 'steer' | 'followUp', triggerTurn: boolean): void;
  isIdle(): boolean;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

const SESSION_CONTEXT_FIELDS = ['autopilot_id', 'boot_id', 'pid', 'repo_id', 'repo_key', 'run_version', 'schema_version', 'session_generation', 'session_id', 'session_lease_id', 'session_token', 'session_version', 'state_root', 'workstream', 'workstream_run'] as const;
const AUTHORITY_TOKEN = /^[a-f0-9]{64}$/u;

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: JsonMap, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is invalid`);
  return value;
}

function requireAuthorityToken(record: JsonMap, field: string): string {
  const value = requireString(record, field);
  if (!AUTHORITY_TOKEN.test(value)) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is not a valid authority token`);
  return value;
}

function requireInteger(record: JsonMap, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CoordinationRuntimeError('invalid-state', `coordinator payload field ${field} is invalid`);
  return value;
}

function requireRecord(value: unknown, label: string): JsonMap {
  if (!isJsonMap(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value;
}

function payloadRecord(response: CoordinatorResponseEnvelope, field: string): JsonMap {
  return requireRecord(response.payload[field], `response.${field}`);
}

function payloadArray(response: CoordinatorResponseEnvelope, field: string): readonly unknown[] {
  const value = response.payload[field];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `response.${field} is not an array`);
  return value;
}

function leaseExpiry(): string {
  return new Date(Date.now() + COORDINATOR_SESSION_LEASE_MS).toISOString();
}

function messageContent(message: CoordinationMessage): string {
  const payload = JSON.stringify(message.payload);
  const bounded = payload.length <= 2_000 ? payload : `${payload.slice(0, 2_000)}…<truncated>`;
  return `Autopilot coordination ${message.message_type} (${message.correlation_id}): ${bounded}`;
}

export async function writeCoordinatorSessionContext(path: string, context: CoordinatorSessionContext): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(context, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  if (platform() !== 'win32') await chmod(path, 0o600);
}

export async function readCoordinatorSessionContext(path: string): Promise<CoordinatorSessionContext> {
  if (!isAbsolute(path)) throw new CoordinationRuntimeError('invalid-request', 'coordinator session context path must be absolute');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', 'coordinator session context is unreadable', [path, error instanceof Error ? error.message : String(error)]);
  }
  const record = requireRecord(value, 'coordinator session context');
  const unknownFields = Object.keys(record).filter((field) => !(SESSION_CONTEXT_FIELDS as readonly string[]).includes(field));
  const missingFields = SESSION_CONTEXT_FIELDS.filter((field) => !(field in record));
  if (unknownFields.length > 0 || missingFields.length > 0) throw new CoordinationRuntimeError('schema-mismatch', 'coordinator session context fields are incompatible', [...unknownFields.map((field) => `unknown=${field}`), ...missingFields.map((field) => `missing=${field}`)]);
  if (record['schema_version'] !== AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA) throw new CoordinationRuntimeError('schema-mismatch', 'coordinator session context schema is incompatible');
  const stateRoot = requireString(record, 'state_root');
  if (!isAbsolute(stateRoot) || normalize(stateRoot) !== stateRoot) throw new CoordinationRuntimeError('invalid-state', 'coordinator session state root is not a normalized absolute path');
  const sessionGeneration = requireInteger(record, 'session_generation');
  const sessionPid = requireInteger(record, 'pid');
  if (sessionGeneration < 1 || sessionPid < 1) throw new CoordinationRuntimeError('invalid-state', 'coordinator session generation and pid must be positive');
  return {
    schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA,
    state_root: stateRoot,
    repo_id: requireString(record, 'repo_id'),
    repo_key: requireString(record, 'repo_key'),
    autopilot_id: requireString(record, 'autopilot_id'),
    workstream: requireString(record, 'workstream'),
    workstream_run: requireString(record, 'workstream_run'),
    session_id: requireString(record, 'session_id'),
    session_generation: sessionGeneration,
    run_version: requireInteger(record, 'run_version'),
    session_lease_id: requireString(record, 'session_lease_id'),
    session_token: requireAuthorityToken(record, 'session_token'),
    session_version: requireInteger(record, 'session_version'),
    pid: sessionPid,
    boot_id: requireString(record, 'boot_id'),
  };
}

export class DurableRunSupervisorClient {
  readonly #client: CoordinatorClient;

  constructor(env: ProcessEnvLike = process.env) {
    this.#client = new CoordinatorClient({ env });
  }

  get client(): CoordinatorClient {
    return this.#client;
  }

  async attach(input: { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow; readonly rawSessionId: string; readonly handoffToken?: string | null }): Promise<RunSupervisorAttachment> {
    const repoId = input.repo.repoKey;
    const sessionId = durableIdentifier('session', input.rawSessionId);
    const status = await this.#client.query('status', repoId, input.active.workstream_run);
    const runValues = payloadArray(status, 'runs');
    let run: CoordinationRun;
    if (runValues.length === 0) {
      const attachedRun = await this.#client.mutate('attach-run', {
        repoId,
        workstreamRun: input.active.workstream_run,
        sessionId: null,
        fencingGeneration: null,
        expectedVersion: 0,
        idempotencyKey: `attach-run:${repoId}:${input.active.workstream_run}`,
      }, {
        repo_key: input.repo.repoKey,
        canonical_root: input.repo.repoRoot,
        git_common_dir: input.repo.gitCommonDir,
        autopilot_id: input.active.autopilot_id,
        workstream: input.active.workstream,
      });
      run = parseCoordinationRun(payloadRecord(attachedRun, 'run'));
    } else if (runValues.length === 1) {
      run = parseCoordinationRun(runValues[0]);
      if (run.autopilot_id !== input.active.autopilot_id || run.workstream !== input.active.workstream) throw new CoordinationRuntimeError('invalid-state', 'durable run supervisor identity disagrees with the active Autopilot row');
    } else {
      throw new CoordinationRuntimeError('invalid-state', 'coordinator returned duplicate durable run supervisors');
    }
    const generation = run.active_session_generation + 1;
    const sessionLeaseId = `session-lease-${randomUUID()}`;
    const sessionToken = randomBytes(32).toString('hex');
    const attachSession = await this.#client.mutate('attach-session', {
      repoId,
      workstreamRun: run.workstream_run,
      sessionId,
      fencingGeneration: generation,
      expectedVersion: run.version,
      idempotencyKey: `attach-session:${repoId}:${run.workstream_run}:${sessionLeaseId}`,
    }, {
      session_lease_id: sessionLeaseId,
      session_token: sessionToken,
      pid: process.pid,
      boot_id: currentBootId(),
      lease_expires_at: leaseExpiry(),
      handoff_token: input.handoffToken ?? null,
    });
    const attachedRun = parseCoordinationRun(payloadRecord(attachSession, 'run'));
    const session = parseCoordinationSessionLease(payloadRecord(attachSession, 'session'));
    const context: CoordinatorSessionContext = {
      schema_version: AUTOPILOT_COORDINATOR_SESSION_CONTEXT_SCHEMA,
      state_root: this.#client.paths.stateRoot,
      repo_id: repoId,
      repo_key: input.repo.repoKey,
      autopilot_id: input.active.autopilot_id,
      workstream: input.active.workstream,
      workstream_run: input.active.workstream_run,
      session_id: session.session_id,
      session_generation: session.session_generation,
      run_version: attachedRun.version,
      session_lease_id: session.session_lease_id,
      session_token: sessionToken,
      session_version: session.version,
      pid: session.pid,
      boot_id: session.boot_id,
    };
    const contextPath = join(this.#client.paths.sessionsRoot, `${createHash('sha256').update(`${repoId}\0${run.workstream_run}\0${session.session_lease_id}`, 'utf8').digest('hex')}.json`);
    await writeCoordinatorSessionContext(contextPath, context);
    return { run: attachedRun, session, contextPath, context };
  }
}

export class AutopilotSessionBridge {
  readonly #supervisor: DurableRunSupervisorClient;
  readonly #sink: CoordinationMessageSink;
  #attachment: RunSupervisorAttachment;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #handoffPrepared = false;
  #fatalError: Error | null = null;
  #operation: Promise<void> = Promise.resolve();

  private constructor(supervisor: DurableRunSupervisorClient, attachment: RunSupervisorAttachment, sink: CoordinationMessageSink) {
    this.#supervisor = supervisor;
    this.#attachment = attachment;
    this.#sink = sink;
  }

  static async start(input: { readonly repo: AutopilotRepoIdentity; readonly active: ActiveAutopilotRow; readonly rawSessionId: string; readonly sink: CoordinationMessageSink; readonly env?: ProcessEnvLike }): Promise<AutopilotSessionBridge> {
    const supervisor = new DurableRunSupervisorClient(input.env ?? process.env);
    const attachment = await supervisor.attach({ repo: input.repo, active: input.active, rawSessionId: input.rawSessionId });
    const bridge = new AutopilotSessionBridge(supervisor, attachment, input.sink);
    await bridge.reconcileOwnedRun('session-attachment-before-mailbox-and-dispatch');
    await bridge.drainMailbox();
    bridge.#startHeartbeat();
    return bridge;
  }

  get attachment(): RunSupervisorAttachment {
    return this.#attachment;
  }

  async reconcileOwnedRun(reason = 'explicit-owned-run-reconciliation'): Promise<void> {
    await this.#enqueue(async () => {
      this.#assertOpen();
      const session = this.#attachment.session;
      await this.#supervisor.client.mutate('reconcile-run', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: this.#attachment.context.run_version,
        idempotencyKey: `reconcile-run:${session.session_lease_id}:${randomUUID()}`,
      }, { reason, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    });
  }

  async drainMailbox(): Promise<readonly CoordinationMessage[]> {
    let delivered: readonly CoordinationMessage[] = [];
    await this.#enqueue(async () => {
      this.#assertOpen();
      delivered = await this.#drainMailboxNow();
    });
    return delivered;
  }

  async #drainMailboxNow(): Promise<readonly CoordinationMessage[]> {
    const session = this.#attachment.session;
    const response = await this.#supervisor.client.mutate('drain-mailbox', {
      repoId: session.repo_id,
      workstreamRun: session.workstream_run,
      sessionId: session.session_id,
      fencingGeneration: session.session_generation,
      expectedVersion: session.version,
      idempotencyKey: `drain-mailbox:${session.session_lease_id}:${randomUUID()}`,
    }, { delivery_id: `delivery-${randomUUID()}`, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    const delivered = Object.freeze(payloadArray(response, 'messages').map((value) => parseCoordinationMessage(value)));
    for (const message of delivered) {
      this.#sink.send({ customType: 'autopilot-coordination', content: messageContent(message), display: true, details: { message_id: message.message_id, message_type: message.message_type, correlation_id: message.correlation_id } }, this.#sink.isIdle() ? 'steer' : 'followUp', true);
      await this.#supervisor.client.mutate('acknowledge-message', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: message.version,
        idempotencyKey: `ack-message:${message.message_id}`,
      }, { message_id: message.message_id, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
    }
    return delivered;
  }

  async prepareHandoff(): Promise<string> {
    let token = '';
    await this.#enqueue(async () => {
      this.#assertOpen();
      this.#stopHeartbeat();
      const session = this.#attachment.session;
      token = `handoff-${randomUUID()}`;
      try {
        const response = await this.#supervisor.client.mutate('prepare-handoff', {
          repoId: session.repo_id,
          workstreamRun: session.workstream_run,
          sessionId: session.session_id,
          fencingGeneration: session.session_generation,
          expectedVersion: session.version,
          idempotencyKey: `prepare-handoff:${session.session_lease_id}`,
        }, { handoff_token: token, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
        const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
        this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
        this.#handoffPrepared = true;
        await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
      } catch (error) {
        if (!this.#handoffPrepared) this.#startHeartbeat();
        throw error;
      }
    });
    return token;
  }

  async close(reason = 'session-shutdown'): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return;
      this.#stopHeartbeat();
      if (this.#handoffPrepared) {
        this.#closed = true;
        return;
      }
      const session = this.#attachment.session;
      const response = await this.#supervisor.client.mutate('detach-session', {
        repoId: session.repo_id,
        workstreamRun: session.workstream_run,
        sessionId: session.session_id,
        fencingGeneration: session.session_generation,
        expectedVersion: session.version,
        idempotencyKey: `detach-session:${session.session_lease_id}`,
      }, { reason, session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
      const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
      this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
      await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
      this.#closed = true;
    });
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      void this.#enqueue(async () => {
        if (this.#closed || this.#handoffPrepared) return;
        const session = this.#attachment.session;
        const response = await this.#supervisor.client.mutate('heartbeat', {
          repoId: session.repo_id,
          workstreamRun: session.workstream_run,
          sessionId: session.session_id,
          fencingGeneration: session.session_generation,
          expectedVersion: session.version,
          idempotencyKey: `heartbeat:${session.session_lease_id}:${String(session.version)}`,
        }, { lease_expires_at: leaseExpiry(), session_lease_id: session.session_lease_id, session_token: this.#attachment.context.session_token });
        const nextSession = parseCoordinationSessionLease(payloadRecord(response, 'session'));
        this.#attachment = { ...this.#attachment, session: nextSession, context: { ...this.#attachment.context, session_version: nextSession.version } };
        await writeCoordinatorSessionContext(this.#attachment.contextPath, this.#attachment.context);
        await this.#drainMailboxNow();
      }).catch((error: unknown) => {
        this.#fatalError = error instanceof Error ? error : new Error(String(error));
        this.#stopHeartbeat();
        try {
          this.#sink.send({
            customType: 'autopilot-coordination',
            content: `Autopilot coordination heartbeat halted loudly: ${this.#fatalError.message}`,
            display: true,
            details: { error_code: 'coordinator-unavailable' },
          }, this.#sink.isIdle() ? 'steer' : 'followUp', false);
        } catch (notificationError) {
          this.#fatalError = new Error(`coordinator heartbeat failed (${this.#fatalError.message}) and Pi notification delivery failed (${notificationError instanceof Error ? notificationError.message : String(notificationError)})`);
        }
      });
    }, COORDINATOR_HEARTBEAT_MS);

  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoordinationRuntimeError('fenced-session', 'session bridge is closed');
    if (this.#fatalError !== null) throw new CoordinationRuntimeError('coordinator-unavailable', this.#fatalError.message);
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(run, run);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}
