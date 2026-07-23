import assert from 'node:assert/strict';
import { it } from 'node:test';

import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { classifyHeartbeatFailure, classifyHeartbeatOwnedRecoveryFailure } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationSessionLease } from '../../src/core/coordination/types.ts';

// Issue: when the coordinator PID stayed live but its socket was momentarily
// unavailable, a single heartbeat failure set #fatalError and stopped the
// heartbeat interval permanently. Later socket recovery could not restore the
// session, which stayed attached but heartbeat-expired with authority
// unreleased. The fix classifies heartbeat failures so a transient coordinator
// connection outage (coordinator-unavailable / contention / timeout) retries
// while the durable session lease is still valid; only terminal authority
// failures or lease expiry halt loudly.

function session(leaseExpiresAt: string): CoordinationSessionLease {
  return {
    schema_version: 'autopilot.session_lease.v2', session_lease_id: 'session-lease-1', repo_id: 'repo-1', workstream_run: 'run-1', session_id: 'session-1',
    session_generation: 1, pid: 1, boot_id: 'boot-1', lease_expires_at: leaseExpiresAt, attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 1, version: 1,
  } as const;
}

const FUTURE_LEASE = new Date(Date.now() + 30_000).toISOString();
const EXPIRED_LEASE = new Date(Date.now() - 1_000).toISOString();

void it('classifies transient coordinator connection failures as retryable while the lease is valid', () => {
  for (const code of ['coordinator-unavailable', 'coordinator-contention', 'request-timeout'] as const) {
    const result = classifyHeartbeatFailure(new CoordinationRuntimeError(code, `transient ${code} socket outage`, []), session(FUTURE_LEASE));
    assert.equal(result.kind, 'transient', `${code} must be retryable while the lease is valid`);
    assert.equal(result.code, code);
    assert.ok(result.leaseExpiryMs > Date.now(), 'future lease must remain valid');
  }
});

void it('classifies terminal authority failures as halting regardless of lease validity', () => {
  for (const code of ['fenced-session', 'recovery-required', 'schema-mismatch', 'protocol-mismatch', 'idempotency-conflict', 'store-corrupt', 'system-fatal'] as const) {
    const result = classifyHeartbeatFailure(new CoordinationRuntimeError(code, `terminal ${code}`, []), session(FUTURE_LEASE));
    assert.equal(result.kind, 'terminal', `${code} must halt the heartbeat loop immediately`);
  }
});

void it('keeps heartbeat authority alive while a typed owned operation blocks source-changing dispatch', () => {
  for (const code of ['recovery-required', 'git-partial-effect', 'disk-failure', 'permission-denied'] as const) {
    const error = new CoordinationRuntimeError(code, `owned ${code}`, [`operation=${code}`]);
    const result = classifyHeartbeatOwnedRecoveryFailure(error);
    assert.equal(result.kind, 'dispatch-blocked');
    assert.equal(result.error, error);
  }
  const invalidState = classifyHeartbeatOwnedRecoveryFailure(new CoordinationRuntimeError('invalid-state', 'invariant broke exact scope'));
  assert.equal(invalidState.kind, 'terminal');
  const fenced = classifyHeartbeatOwnedRecoveryFailure(new CoordinationRuntimeError('fenced-session', 'generation replaced'));
  assert.equal(fenced.kind, 'terminal');
});

void it('reports the exact lease expiry boundary so the bridge can halt once authority is genuinely lost', () => {
  const transient = classifyHeartbeatFailure(new CoordinationRuntimeError('coordinator-unavailable', 'socket unavailable', []), session(EXPIRED_LEASE));
  assert.equal(transient.kind, 'transient');
  assert.ok(transient.leaseExpiryMs <= Date.now(), 'an expired lease must no longer permit retry; the bridge halts on the next tick');
});

void it('classifies non-runtime errors as terminal so unknown failures never silently spin the loop', () => {
  const result = classifyHeartbeatFailure(new Error('unexpected'), session(FUTURE_LEASE));
  assert.equal(result.kind, 'terminal');
  assert.equal(result.code, 'unknown');
});
