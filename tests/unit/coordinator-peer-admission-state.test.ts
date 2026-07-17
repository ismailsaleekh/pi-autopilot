import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCoordinatorAdmissionRequest, createCoordinatorAdmissionResponse, type CoordinatorAdmissionIdentity } from '../../src/core/coordination/admission.ts';
import { COORDINATOR_PEER_MODES, COORDINATOR_SOCKET_ADMISSION_STATES, CoordinatorSocketPeerState, requiredVocabularyForSurface } from '../../src/core/coordination/peer-admission-state.ts';

const IDENTITY: CoordinatorAdmissionIdentity = Object.freeze({
  implementationBuild: '1.2.0-s1', wireLineage: 'protocol-1.6-api-schema-12', apiSchemaVersion: 12, storeSchemaVersion: 13,
  knownClientBuilds: Object.freeze(['1.2.0-s1']),
});
const ENDPOINT = Object.freeze({
  lifecycle_pid: 42, lifecycle_boot_id: 'boot', lifecycle_process_start_identity: 'start', lifecycle_instance_id: 'instance',
  legacy_lock_sha256: `sha256:${'11'.repeat(32)}`, runtime_identity_sha256: `sha256:${'22'.repeat(32)}`, store_generation_id: `generation-${'33'.repeat(16)}`,
});

function response(clientBuild = '1.2.0-s1') {
  const envelope = createCoordinatorAdmissionRequest({ requestId: 'state-request', identity: IDENTITY, nonce: 'ab'.repeat(32) });
  return createCoordinatorAdmissionResponse({ request: { ...envelope.payload, client_build: clientBuild }, identity: IDENTITY, endpoint: ENDPOINT, capability: '44'.repeat(32) });
}

void describe('socket-scoped peer admission state', () => {
  void it('locks exactly three peer modes and five socket states', () => {
    assert.deepEqual(COORDINATOR_PEER_MODES, ['legacy-anonymous-protocol-1.6', 'negotiated-s1', 'known-cf50-predecessor']);
    assert.deepEqual(COORDINATOR_SOCKET_ADMISSION_STATES, ['awaiting-handshake', 'legacy-handshake-served', 'negotiated-admitted', 'negotiated-rejected', 'closed-invalid']);
    assert.equal(requiredVocabularyForSurface('canonical-worktree-aliases'), 'canonical-worktree-aliases-v1');
    assert.equal(requiredVocabularyForSurface('scoped-logical-faults'), 'scoped-logical-faults-v1');
    assert.equal(requiredVocabularyForSurface('store-generations'), 'store-generations-v1');
  });

  void it('allows an old peer to go directly from exact handshake to legacy action', () => {
    const peer = new CoordinatorSocketPeerState();
    assert.equal(peer.state, 'awaiting-handshake');
    assert.deepEqual(peer.acceptRequest('handshake'), { kind: 'legacy-handshake', peerMode: 'legacy-anonymous-protocol-1.6' });
    assert.equal(peer.state, 'legacy-handshake-served');
    assert.deepEqual(peer.acceptRequest('heartbeat'), { kind: 'legacy-operation', peerMode: 'legacy-anonymous-protocol-1.6' });
    assert.equal(peer.peerMode, 'legacy-anonymous-protocol-1.6');
  });

  void it('requires handshake before negotiation or operation and rejects a second sequence', () => {
    for (const firstAction of ['heartbeat', 'negotiate-admission']) {
      const peer = new CoordinatorSocketPeerState();
      assert.throws(() => peer.acceptRequest(firstAction));
      assert.equal(peer.state, 'closed-invalid');
    }
    const duplicateHandshake = new CoordinatorSocketPeerState();
    duplicateHandshake.acceptRequest('handshake');
    assert.throws(() => duplicateHandshake.acceptRequest('handshake'));
    assert.equal(duplicateHandshake.state, 'closed-invalid');

    const duplicateNegotiation = new CoordinatorSocketPeerState();
    duplicateNegotiation.acceptRequest('handshake');
    duplicateNegotiation.acceptRequest('negotiate-admission');
    assert.throws(() => duplicateNegotiation.acceptRequest('negotiate-admission'));
    assert.equal(duplicateNegotiation.state, 'closed-invalid');
  });

  void it('admits S1 only after successful same-socket negotiation and enforces vocabulary', () => {
    const peer = new CoordinatorSocketPeerState();
    peer.acceptRequest('handshake');
    peer.acceptRequest('negotiate-admission');
    assert.throws(() => peer.acceptRequest('status'));
    assert.equal(peer.state, 'closed-invalid', 'an operation racing incomplete negotiation invalidates the socket');

    const admitted = new CoordinatorSocketPeerState();
    admitted.acceptRequest('handshake');
    admitted.acceptRequest('negotiate-admission');
    admitted.completeAdmission(response());
    assert.equal(admitted.state, 'negotiated-admitted');
    assert.equal(admitted.peerMode, 'negotiated-s1');
    assert.deepEqual(admitted.acceptRequest('status', 'store-generations'), { kind: 'negotiated-operation', peerMode: 'negotiated-s1' });
    assert.deepEqual(admitted.acceptRequest('heartbeat'), { kind: 'legacy-operation', peerMode: 'negotiated-s1' });
    assert.throws(() => admitted.acceptRequest('negotiate-admission'));
  });

  void it('blocks every operation after a signed rejection', () => {
    const peer = new CoordinatorSocketPeerState();
    peer.acceptRequest('handshake');
    peer.acceptRequest('negotiate-admission');
    peer.completeAdmission(response('1.2.1-unknown'));
    assert.equal(peer.state, 'negotiated-rejected');
    assert.equal(peer.peerMode, 'legacy-anonymous-protocol-1.6');
    assert.throws(() => peer.acceptRequest('heartbeat'));
    assert.equal(peer.state, 'closed-invalid');
  });

  void it('does not let admission state authorize another socket', () => {
    const admitted = new CoordinatorSocketPeerState();
    admitted.acceptRequest('handshake');
    admitted.acceptRequest('negotiate-admission');
    admitted.completeAdmission(response());

    const otherSocket = new CoordinatorSocketPeerState();
    assert.equal(otherSocket.state, 'awaiting-handshake');
    assert.throws(() => otherSocket.acceptRequest('status', 'store-generations'));
    assert.equal(admitted.state, 'negotiated-admitted');
    admitted.close();
    assert.equal(admitted.grantedVocabulary.size, 0);
  });

  void it('invalidates malformed admission without continuation state', () => {
    const peer = new CoordinatorSocketPeerState();
    peer.acceptRequest('handshake');
    peer.acceptRequest('negotiate-admission');
    assert.throws(() => peer.rejectMalformedAdmission());
    assert.equal(peer.state, 'closed-invalid');
    assert.equal(peer.peerMode, null);
  });
});
