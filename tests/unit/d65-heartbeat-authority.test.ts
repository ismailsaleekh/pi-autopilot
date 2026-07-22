import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import {
  d65HeartbeatHighWaterPath,
  readD65HeartbeatHighWater,
  reconcileD65HeartbeatHighWater,
} from '../../src/core/coordination/d65-heartbeat-high-water.ts';
import { verifyD65PairedHeartbeatGate } from '../../src/core/coordination/d65-heartbeat-gate.ts';
import {
  parseD65HeartbeatAcceptanceResult,
  parseD65ProgramHeartbeat,
} from '../../src/core/coordination/d65-launch-policy.ts';

const DIGEST = (byte: string): `sha256:${string}` => `sha256:${byte.repeat(64)}`;

function head(kind: 'catch-up' | 'governing' = 'governing') {
  return parseD65HeartbeatAcceptanceResult({
    schema_version: 'autopilot.program_heartbeat_acceptance_result.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1', sequence: 1,
    heartbeat_ref: 'program-heartbeats/00000000000000000001.json', heartbeat_sha256: DIGEST('a'), acceptance_kind: kind, prior_sha256: null,
    issued_at: '2026-07-21T00:00:00.000Z', valid_until: '2026-07-21T00:15:00.000Z', coordinator_time: '2026-07-21T00:00:01.000Z',
  });
}

function governingRow() {
  const heartbeat = parseD65ProgramHeartbeat({
    schema_version: 'autopilot.program_heartbeat.v1', program_id: 'program-1', sequence: 1, prior_sha256: null,
    issued_at: '2026-07-21T00:00:00.000Z', valid_until: '2026-07-21T00:15:00.000Z', package_commit: 'a'.repeat(40), package_tree: 'b'.repeat(40), base_commit: 'c'.repeat(40), base_tree: 'd'.repeat(40),
    rows: [{ workstream: 'work-1', workstream_run: 'run-1', parent_session_file_sha256: null, coordinator_session_lease_id: 'session-1', accepted_graph_sequence: 2, accepted_graph_sha256: DIGEST('b'), status_sha256: DIGEST('c'), doctor_sha256: DIGEST('d'), session_lease_state: 'attached', child_lease_ids: [], launch_policy_sha256: DIGEST('e'), last_progress_event_seq: 10, last_handoff_sha256: null, row_state: 'active', dispatch_allowed: true, stop_reasons: [] }],
    provider_health: [{ provider: 'openai-codex', state: 'healthy', observation_ref: 'authority/provider.json', observation_sha256: DIGEST('f'), cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
    dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: 'authority/operator.spki', trust_anchor_sha256: DIGEST('1'), signer_key_id: DIGEST('1'), signature: 'A'.repeat(86),
  });
  const row = heartbeat.rows[0];
  if (row === undefined) throw new Error('heartbeat fixture omitted its governing row');
  return row;
}

void describe('D65 heartbeat high-water cache', () => {
  void it('reconstructs mode-private canonical bytes from the durable head and repairs deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd65-heartbeat-high-water-'));
    await chmod(root, 0o700);
    try {
      const durable = head();
      const first = reconcileD65HeartbeatHighWater({ programEvidenceRoot: root, head: durable, verifyExternal: (value) => assert.deepEqual(value, durable) });
      assert.equal(first.sequence, 1);
      const path = d65HeartbeatHighWaterPath(root, 'run-1');
      assert.equal(await readFile(path, 'utf8'), `${canonicalJson(first)}\n`);
      await unlink(path);
      const repaired = reconcileD65HeartbeatHighWater({ programEvidenceRoot: root, head: durable, verifyExternal: () => undefined });
      assert.deepEqual(repaired, first);
      assert.deepEqual(readD65HeartbeatHighWater(root, 'run-1'), first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('rejects a newer/divergent cache and non-private cache directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd65-heartbeat-high-water-invalid-'));
    await chmod(root, 0o700);
    try {
      const directory = join(root, 'program-heartbeat-high-water');
      await mkdir(directory, { mode: 0o700 });
      const path = d65HeartbeatHighWaterPath(root, 'run-1');
      const newer = { schema_version: 'autopilot.heartbeat_high_water.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1', sequence: 2, heartbeat_sha256: DIGEST('9'), issued_at: '2026-07-21T00:01:00.000Z', valid_until: '2026-07-21T00:16:00.000Z', updated_at: '2026-07-21T00:01:01.000Z' };
      await writeFile(path, `${canonicalJson(newer)}\n`, { mode: 0o600 });
      await assert.rejects(async () => reconcileD65HeartbeatHighWater({ programEvidenceRoot: root, head: head(), verifyExternal: () => undefined }), /newer than durable coordinator authority/u);
      await unlink(path);
      await chmod(directory, 0o755);
      assert.throws(() => readD65HeartbeatHighWater(root, 'run-1'), /cache directory must be a no-follow directory with exact mode 0700/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

void describe('D65 paired status/doctor heartbeat gate', () => {
  void it('accepts one unchanged five-second boundary and fences every independent mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd65-heartbeat-pair-'));
    await chmod(root, 0o700);
    try {
      const durable = head();
      const cache = reconcileD65HeartbeatHighWater({ programEvidenceRoot: root, head: durable, verifyExternal: () => undefined });
      const boundary = { graph_sequence: 2, graph_sha256: DIGEST('b'), policy_sha256: DIGEST('e'), heartbeat_sequence: 1, heartbeat_sha256: DIGEST('a'), session_lease_id: 'session-1', session_generation: 1, run_version: 4 } as const;
      const status = { coordinator_time: '2026-07-21T00:00:02.000Z', semantic_snapshot_sha256: DIGEST('c'), accepted_program_heartbeat: durable, boundary };
      const doctor = { coordinator_time: '2026-07-21T00:00:03.000Z', semantic_snapshot_sha256: DIGEST('d'), accepted_program_heartbeat: durable, boundary };
      assert.equal(verifyD65PairedHeartbeatGate({ status, doctor, governingRow: governingRow(), highWater: cache }).coordinator_time, doctor.coordinator_time);
      assert.throws(() => verifyD65PairedHeartbeatGate({ status, doctor: { ...doctor, coordinator_time: '2026-07-21T00:00:08.001Z' }, governingRow: governingRow(), highWater: cache }), /exceeds five coordinator seconds/u);
      assert.throws(() => verifyD65PairedHeartbeatGate({ status, doctor: { ...doctor, boundary: { ...boundary, run_version: 5 } }, governingRow: governingRow(), highWater: cache }), /semantic boundary changed/u);
      assert.throws(() => verifyD65PairedHeartbeatGate({ status: { ...status, accepted_program_heartbeat: head('catch-up') }, doctor: { ...doctor, accepted_program_heartbeat: head('catch-up') }, governingRow: governingRow(), highWater: cache }), /catch-up and cannot govern/u);
      assert.throws(() => verifyD65PairedHeartbeatGate({ status: { ...status, semantic_snapshot_sha256: DIGEST('0') }, doctor, governingRow: governingRow(), highWater: cache }), /semantic digests do not equal/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
