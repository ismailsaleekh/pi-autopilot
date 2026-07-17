import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCoordinatorAdmissionOffer, type CoordinatorAdmissionIdentity } from '../../src/core/coordination/admission.ts';
import { classifyCoordinatorInitialPeer, parseCoordinatorLegacyFacadeHandshake, type CoordinatorLegacyFacadeIdentity } from '../../src/core/coordination/peer-classification.ts';

const ADMISSION: CoordinatorAdmissionIdentity = Object.freeze({
  implementationBuild: '1.2.0-s1', wireLineage: 'protocol-1.6-api-schema-12', apiSchemaVersion: 12, storeSchemaVersion: 13,
  knownClientBuilds: Object.freeze(['1.2.0-s1']),
});
const IDENTITY: CoordinatorLegacyFacadeIdentity = Object.freeze({ legacyFacadeBuild: '1.1.8-cf50', apiSchemaVersion: 12, admissionIdentity: ADMISSION });
const HANDSHAKE = Object.freeze({
  schema_version: 'autopilot.coordinator_handshake.v1', package_build: '1.1.8-cf50', protocol_version: '1.6', database_schema_version: 12,
  lifecycle_lock_schema: 'autopilot.coordinator_lock.v2', lifecycle_pid: 42, lifecycle_boot_id: 'boot',
  lifecycle_process_start_identity: 'start', lifecycle_instance_id: 'instance', lifecycle_started_at: '2026-07-16T00:00:00.000Z',
});

void describe('explicit coordinator peer classification', () => {
  void it('classifies offer absence only as the exact known cf50 predecessor', () => {
    const classified = classifyCoordinatorInitialPeer(HANDSHAKE, IDENTITY);
    assert.equal(classified.kind, 'known-cf50-predecessor');
    assert.equal(classified.handshake.package_build, '1.1.8-cf50');
  });

  void it('classifies the one exact additive offer as an S1 negotiation candidate', () => {
    const classified = classifyCoordinatorInitialPeer({ ...HANDSHAKE, admission_upgrade: createCoordinatorAdmissionOffer(ADMISSION) }, IDENTITY);
    assert.equal(classified.kind, 's1-admission-offered');
    if (classified.kind !== 's1-admission-offered') throw new Error('expected S1 offer');
    assert.equal(classified.offer.action, 'negotiate-admission');
  });

  void it('rejects build, protocol, schema, offer, lifecycle, and extra-field drift instead of inferring compatibility', () => {
    const invalid: readonly unknown[] = [
      { ...HANDSHAKE, package_build: '1.1.9' },
      { ...HANDSHAKE, package_build: '1.2.0-s1' },
      { ...HANDSHAKE, protocol_version: '1.7' },
      { ...HANDSHAKE, database_schema_version: 13 },
      { ...HANDSHAKE, lifecycle_lock_schema: 'autopilot.coordinator_lock.v3' },
      { ...HANDSHAKE, lifecycle_pid: 0 },
      { ...HANDSHAKE, extra: true },
      { ...HANDSHAKE, admission_upgrade: { ...createCoordinatorAdmissionOffer(ADMISSION), action: 'best-effort' } },
      { ...HANDSHAKE, admission_upgrade: { ...createCoordinatorAdmissionOffer(ADMISSION), extra: true } },
    ];
    for (const candidate of invalid) assert.throws(() => parseCoordinatorLegacyFacadeHandshake(candidate, IDENTITY));
  });
});
