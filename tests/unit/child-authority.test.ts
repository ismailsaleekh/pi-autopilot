import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutopilotChildLeaseHandle } from '../../src/core/coordination/child-authority.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationChildLease, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';

const evidence = { ref: '.pi/autopilot/work/terminal-acceptances/unit.validate.attempt-1.json', sha256: `sha256:${'a'.repeat(64)}` as const };

function child(status: 'running' | 'terminal'): CoordinationChildLease {
  return {
    schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-run-unit-1',
    owner: { repo_id: 'repo', autopilot_id: 'autopilot', workstream_run: 'run', unit_id: 'unit', attempt: 1 },
    pid: process.pid, boot_id: 'boot', lease_expires_at: '2099-01-01T00:00:00.000Z', status,
    terminal_evidence: status === 'terminal' ? evidence : null, version: status === 'terminal' ? 2 : 1,
  };
}

const session: CoordinatorSessionContext = {
  schema_version: 'autopilot.coordinator_session_context.v1', state_root: '/tmp/state', repo_id: 'repo', repo_key: 'repo', autopilot_id: 'autopilot', workstream: 'work', workstream_run: 'run',
  session_id: 'session', session_generation: 1, run_version: 1, session_lease_id: 'session-lease', session_token: 'b'.repeat(64), session_version: 1, pid: process.pid, boot_id: 'boot',
};

void describe('child authority terminal acknowledgement recovery', () => {
  void it('accepts exact durable terminal state when the complete-child response is lost', async () => {
    let completeCalls = 0;
    const fakeClient = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: '/tmp/unused-child-authority-test' }, autoStart: false });
    Object.defineProperty(fakeClient, 'mutate', { value: async (action: string): Promise<CoordinatorResponseEnvelope> => {
      if (action !== 'complete-child') throw new Error(`unexpected mutation ${action}`);
      completeCalls += 1;
      throw new Error('simulated dropped completion response');
    } });
    Object.defineProperty(fakeClient, 'query', { value: async (): Promise<CoordinatorResponseEnvelope> => ({
      schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.6', request_id: 'status-after-drop', ok: true, committed_event_seq: null, error_code: null, retryable: false,
      payload: { child_leases: [child('terminal')] },
    }) });
    const handle = new AutopilotChildLeaseHandle(fakeClient, session, child('running'), 'c'.repeat(64), process.pid, 'boot');
    await handle.completeTerminal(evidence);
    assert.equal(completeCalls, 1);
    assert.equal(handle.child.status, 'terminal');
    assert.deepEqual(handle.child.terminal_evidence, evidence);
    await handle.markRecoveryRequired();
    assert.equal(completeCalls, 1, 'accepted terminal state must never be followed by recovery-required');
  });
});
