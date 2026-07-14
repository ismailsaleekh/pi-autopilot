import { randomBytes } from 'node:crypto';

import { CoordinatorClient } from './client.ts';
import { parseCoordinationChildLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { currentBootId } from './process-identity.ts';
import { COORDINATOR_HEARTBEAT_MS, COORDINATOR_SESSION_LEASE_MS } from './runtime-paths.ts';
import { readCoordinatorSessionContext, type CoordinatorSessionContext } from './supervisor.ts';
import type { CoordinationChildLease, CoordinatorResponseEnvelope } from './types.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import type { AutopilotUnitSpec } from '../contracts/types.ts';
import type { ProcessEnvLike } from '../parallel-runtime.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

function requireRecord(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
  return value as JsonMap;
}

function childFromResponse(response: CoordinatorResponseEnvelope): CoordinationChildLease {
  return parseCoordinationChildLease(requireRecord(response.payload['child'], 'coordinator child response'));
}

function childExpiry(): string {
  return new Date(Date.now() + COORDINATOR_SESSION_LEASE_MS).toISOString();
}

export class AutopilotChildLeaseHandle {
  readonly #client: CoordinatorClient;
  readonly #session: CoordinatorSessionContext;
  readonly #childToken: string;
  readonly #pid: number;
  readonly #bootId: string;
  #child: CoordinationChildLease;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #fatalError: Error | null = null;
  #terminal = false;
  #terminalCompletionUncertain = false;
  readonly #preemption = new AbortController();
  #operation: Promise<void> = Promise.resolve();

  constructor(client: CoordinatorClient, session: CoordinatorSessionContext, child: CoordinationChildLease, childToken: string, pid: number, bootId: string) {
    this.#client = client;
    this.#session = session;
    this.#child = child;
    this.#childToken = childToken;
    this.#pid = pid;
    this.#bootId = bootId;
    const heartbeat = setInterval(() => {
      void this.#enqueue(async () => {
        if (this.#terminal) return;
        const response = await this.#client.mutate('heartbeat-child', {
          repoId: this.#session.repo_id,
          workstreamRun: this.#session.workstream_run,
          sessionId: null,
          fencingGeneration: null,
          expectedVersion: this.#child.version,
          idempotencyKey: `heartbeat-child:${this.#child.child_lease_id}:${String(this.#child.version)}`,
        }, { child_lease_id: this.#child.child_lease_id, child_token: this.#childToken, pid: this.#pid, boot_id: this.#bootId, lease_expires_at: childExpiry() });
        this.#child = childFromResponse(response);
        const payload = requireRecord(response.payload, 'child heartbeat response');
        if (payload['preemption_requested'] === true) {
          this.#preemption.abort(new CoordinationRuntimeError('recovery-required', 'deadlock policy requested child preemption and owner recovery'));
          this.#stopHeartbeat();
        }
      }).catch((error: unknown) => {
        this.#fatalError = error instanceof Error ? error : new Error(String(error));
        this.#stopHeartbeat();
      });
    }, COORDINATOR_HEARTBEAT_MS);
    this.#heartbeat = heartbeat;
  }

  get child(): CoordinationChildLease {
    return this.#child;
  }

  get preemptionSignal(): AbortSignal {
    return this.#preemption.signal;
  }

  async checkpoint(checkpointOrdinal: number, criticalSection: string | null, preemptible: boolean): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#terminal) throw new CoordinationRuntimeError('invalid-state', 'terminal child cannot record a checkpoint');
      await this.#client.mutate('checkpoint-child', {
        repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: null, fencingGeneration: null,
        expectedVersion: this.#child.version, idempotencyKey: `checkpoint-child:${this.#child.child_lease_id}:${String(checkpointOrdinal)}`,
      }, { child_lease_id: this.#child.child_lease_id, child_token: this.#childToken, pid: this.#pid, boot_id: this.#bootId, checkpoint_ordinal: checkpointOrdinal, critical_section: criticalSection, preemptible });
    });
  }

  assertHealthy(): void {
    if (this.#fatalError !== null) throw new CoordinationRuntimeError('coordinator-unavailable', `child authority heartbeat failed: ${this.#fatalError.message}`);
  }

  async completeAdjudication(assignmentId: string, adjudicationPath: string, terminalEvidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#terminal) throw new CoordinationRuntimeError('invalid-state', 'terminal child cannot complete adjudication');
      this.assertHealthy();
      this.#stopHeartbeat();
      const response = await this.#client.mutate('complete-adjudication', {
        repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: null, fencingGeneration: null, expectedVersion: this.#child.version,
        idempotencyKey: `complete-adjudication:${assignmentId}:${this.#child.child_lease_id}`,
      }, { assignment_id: assignmentId, adjudication_path: adjudicationPath, terminal_evidence_ref: terminalEvidence.ref, terminal_evidence_sha256: terminalEvidence.sha256, child_lease_id: this.#child.child_lease_id, child_token: this.#childToken, pid: this.#pid, boot_id: this.#bootId });
      this.#child = childFromResponse(response);
      this.#terminal = true;
    });
  }

  async completeTerminal(evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Promise<void> {
    await this.#complete('terminal', evidence.ref, evidence.sha256);
  }

  async markRecoveryRequired(): Promise<void> {
    // A terminal mutation whose acknowledgement was lost must never be followed
    // by a contradictory recovery-required mutation. Startup reconciliation can
    // safely resolve a genuinely uncommitted running child after lease expiry.
    if (this.#terminal || this.#terminalCompletionUncertain) return;
    await this.#complete('recovery-required', null, null);
  }

  async #complete(status: 'terminal' | 'recovery-required', evidenceRef: string | null, evidenceSha256: `sha256:${string}` | null): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#terminal) return;
      this.#stopHeartbeat();
      const idempotencyKey = `complete-child:${this.#child.child_lease_id}:${status}:${evidenceSha256 ?? 'none'}`;
      const payload = { child_lease_id: this.#child.child_lease_id, child_token: this.#childToken, pid: this.#pid, boot_id: this.#bootId, status, evidence_ref: evidenceRef, evidence_sha256: evidenceSha256 };
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await this.#client.mutate('complete-child', {
            repoId: this.#session.repo_id,
            workstreamRun: this.#session.workstream_run,
            sessionId: null,
            fencingGeneration: null,
            expectedVersion: this.#child.version,
            idempotencyKey,
          }, payload);
          this.#child = childFromResponse(response);
          this.#terminal = true;
          return;
        } catch (error) {
          lastError = error;
          let observed: CoordinationChildLease | null = null;
          try {
            const response = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
            const childValues = response.payload['child_leases'];
            if (!Array.isArray(childValues)) throw new CoordinationRuntimeError('invalid-state', 'coordinator status child_leases is not an array');
            observed = childValues.map(parseCoordinationChildLease).find((candidate) => candidate.child_lease_id === this.#child.child_lease_id) ?? null;
          } catch {
            if (status === 'terminal') this.#terminalCompletionUncertain = true;
            throw error;
          }
          if (observed === null) throw new CoordinationRuntimeError('invalid-state', 'child lease disappeared while terminal completion acknowledgement was reconciled', [this.#child.child_lease_id]);
          if (observed.status === status) {
            const exactEvidence = status === 'recovery-required'
              ? observed.terminal_evidence === null
              : observed.terminal_evidence?.ref === evidenceRef && observed.terminal_evidence.sha256 === evidenceSha256;
            if (!exactEvidence) throw new CoordinationRuntimeError('idempotency-conflict', 'child reached the requested terminal status with different evidence', [this.#child.child_lease_id]);
            this.#child = observed;
            this.#terminal = true;
            return;
          }
          if (observed.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child completion observed contradictory ${observed.status} state`, [this.#child.child_lease_id]);
          this.#child = observed;
        }
      }
      throw lastError instanceof Error ? lastError : new CoordinationRuntimeError('coordinator-unavailable', 'child completion failed without a typed error');
    });
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(run, run);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}

export async function registerAutopilotChildAuthority(spec: AutopilotUnitSpec, specEvidence: { readonly ref: string; readonly sha256: `sha256:${string}` }, env: ProcessEnvLike = process.env): Promise<AutopilotChildLeaseHandle> {
  const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for live child authority preflight`);
  const session = await readCoordinatorSessionContext(contextPath);
  if (session.workstream !== spec.workstream) throw new CoordinationRuntimeError('unauthorized-client', 'unit workstream differs from coordinator session authority');
  const client = new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } });
  const childLeaseId = `child-${session.workstream_run}-${spec.unit_id}-${String(spec.attempt)}`;
  const childToken = randomBytes(32).toString('hex');
  const pid = process.pid;
  const bootId = currentBootId();
  await client.mutate('register-attempt', {
    repoId: session.repo_id, workstreamRun: session.workstream_run, sessionId: session.session_id, fencingGeneration: session.session_generation, expectedVersion: session.run_version,
    idempotencyKey: `register-attempt:${session.workstream_run}:${spec.unit_id}:${String(spec.attempt)}`,
  }, { unit_id: spec.unit_id, attempt: spec.attempt, spec_ref: specEvidence.ref, spec_sha256: specEvidence.sha256, role: spec.role, preemptible: true, checkpoint_ordinal: 0, session_lease_id: session.session_lease_id, session_token: session.session_token });
  const response = await client.mutate('register-child', {
    repoId: session.repo_id,
    workstreamRun: session.workstream_run,
    sessionId: session.session_id,
    fencingGeneration: session.session_generation,
    expectedVersion: session.run_version,
    idempotencyKey: `register-child:${childLeaseId}`,
  }, {
    child_lease_id: childLeaseId,
    autopilot_id: session.autopilot_id,
    unit_id: spec.unit_id,
    attempt: spec.attempt,
    pid,
    boot_id: bootId,
    child_token: childToken,
    session_lease_id: session.session_lease_id,
    session_token: session.session_token,
    lease_expires_at: childExpiry(),
  });
  const handle = new AutopilotChildLeaseHandle(client, session, childFromResponse(response), childToken, pid, bootId);
  await handle.checkpoint(1, null, true);
  return handle;
}
