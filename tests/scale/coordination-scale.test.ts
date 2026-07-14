import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { coordinationExclusiveOperation } from '../../src/core/coordination/exclusive-policy.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore, stageCoordinatorSemanticReplay, type CoordinatorSemanticReplayRecord } from '../../src/core/coordination/store.ts';
import type { CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

const EVENT_COUNT = 100_000;
const REQUEST_COUNT = 10_000;
const CLIENT_COUNT = 32;
const REPOSITORY_COUNT = 256;
const SESSION_COUNT = REPOSITORY_COUNT * 2;
const MAILBOX_QUERY_COUNT = CLIENT_COUNT;
const BASE_MUTATION_COUNT = SESSION_COUNT * 2 + REPOSITORY_COUNT + REQUEST_COUNT + MAILBOX_QUERY_COUNT;
const RECOVERY_HEARTBEAT_COUNT = EVENT_COUNT - BASE_MUTATION_COUNT;
const MAX_DURATION_MS = 60_000;
const MAX_RSS = 512 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_INDEXED_QUERY_MS = 1_000;
const SCALE_SEED = 0x41cf09;

interface ScaleSession {
  readonly index: number;
  readonly repoId: string;
  readonly run: string;
  readonly sessionId: string;
  readonly leaseId: string;
  readonly token: string;
  readonly generation: number;
  readonly runVersion: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function repoId(index: number): string {
  return `scale-repo-${String(Math.floor(index / 2))}`;
}

function seededOrder(size: number, seed = SCALE_SEED): number[] {
  const values = Array.from({ length: size }, (_entry, index) => index);
  let state = seed >>> 0;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = values[index];
    values[index] = values[swap] as number;
    values[swap] = current as number;
  }
  return values;
}

function runResource(repository: string, run: string, workstream: string, repositoryRoot: string, stateRoot: string) {
  const canonicalRoot = join(repositoryRoot, repository);
  return {
    schema_version: 'autopilot.coordination_run_resource.v1' as const, repo_id: repository, workstream_run: run,
    source_repo: canonicalRoot, git_common_dir: join(canonicalRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', repository),
    main_worktree_path: join(stateRoot, 'worktrees', repository, 'active', run, 'main'),
    runtime_root: join(stateRoot, 'worktrees', repository, 'active', run, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${run}`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null,
    started_at: '2026-07-12T12:00:00.000Z', version: 1,
  };
}

function attachRunRequest(index: number, repositoryRoot: string, stateRoot: string): CoordinatorRequestEnvelope {
  const run = `scale-run-${String(index)}`;
  const workstream = `scale-work-${String(index)}`;
  const repository = repoId(index);
  const canonicalRoot = join(repositoryRoot, repository);
  const repositoryIndex = Math.floor(index / 2);
  const clientIndex = index % 2 === 0 ? repositoryIndex % CLIENT_COUNT : (repositoryIndex + 1) % CLIENT_COUNT;
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `scale-attach-run-${String(index)}`,
    action: 'attach-run', idempotency_key: `scale-attach-run-${String(index)}`, repo_id: repository, workstream_run: run,
    session_id: null, fencing_generation: null, expected_version: 0,
    payload: {
      repo_key: repository, canonical_root: canonicalRoot, git_common_dir: join(canonicalRoot, '.git'), autopilot_id: `scale-client-${String(clientIndex)}`,
      workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: runResource(repository, run, workstream, repositoryRoot, stateRoot),
    },
  };
}

function recoveryHeartbeatRequest(actor: ScaleSession, ordinal: number): CoordinatorRequestEnvelope {
  const priorHeartbeats = Math.floor(ordinal / SESSION_COUNT);
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `scale-recovery-heartbeat-${String(ordinal)}`,
    action: 'heartbeat', idempotency_key: `scale-recovery-heartbeat-${String(ordinal)}`, repo_id: actor.repoId, workstream_run: actor.run,
    session_id: actor.sessionId, fencing_generation: actor.generation, expected_version: 1 + priorHeartbeats,
    payload: { lease_expires_at: '2099-01-01T00:00:00.000Z', session_lease_id: actor.leaseId, session_token: actor.token },
  };
}

function heartbeatCountForActor(actorIndex: number): number {
  const completeRounds = Math.floor(RECOVERY_HEARTBEAT_COUNT / SESSION_COUNT);
  return completeRounds + (actorIndex < RECOVERY_HEARTBEAT_COUNT % SESSION_COUNT ? 1 : 0);
}

function attachSessionRequest(index: number): CoordinatorRequestEnvelope {
  const actor = session(index);
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `scale-attach-session-${String(index)}`,
    action: 'attach-session', idempotency_key: `scale-attach-session-${String(index)}`, repo_id: actor.repoId, workstream_run: actor.run,
    session_id: actor.sessionId, fencing_generation: actor.generation, expected_version: 1,
    payload: { session_lease_id: actor.leaseId, session_token: actor.token, pid: index + 10_000, boot_id: `scale-boot-${String(index)}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null },
  };
}

function session(index: number): ScaleSession {
  return {
    index, repoId: repoId(index), run: `scale-run-${String(index)}`, sessionId: `scale-session-${String(index)}`,
    leaseId: `scale-session-lease-${String(index)}`, token: digest(`scale-session-token-${String(index)}`), generation: 1, runVersion: 2,
  };
}

function acquireRequest(actor: ScaleSession, requestIndex: number | 'owner'): CoordinatorRequestEnvelope {
  const owner = requestIndex === 'owner';
  const identity = owner ? `owner-${actor.repoId}` : String(requestIndex);
  const groupId = `scale-group-${identity}`;
  const unitId = `scale-unit-${identity}`;
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `scale-acquire-${identity}`,
    action: 'acquire-group', idempotency_key: `scale-acquire-${identity}`, repo_id: actor.repoId, workstream_run: actor.run,
    session_id: actor.sessionId, fencing_generation: actor.generation, expected_version: actor.runVersion,
    payload: {
      acquisition_group_id: groupId, unit_id: unitId, attempt: 1,
      requested_leases: [
        { path: 'src/contested/shared.ts', mode: 'WRITE', purpose: 'scale edit attribution layer' },
        { path: 'src/contested/shared.ts', mode: 'EXCLUSIVE', purpose: owner ? 'scale critical-section contention anchor' : 'scale critical-section requester replay', exclusive_operation: coordinationExclusiveOperation({ operationId: `scale-${identity}`, operationKind: 'canonical-authority-replacement', expectedDurationMs: 30_000 }) },
      ],
      acquisition_kind: 'initial', reason: owner ? 'hold deterministic repository contention anchor' : 'request deterministic repository contention anchor',
      normal_release_condition: { condition_type: 'unit-merged', target_id: `${unitId}:1`, evidence: null },
      spec_ref: `.pi/autopilot/scale/unit-specs/${unitId}.json`, spec_sha256: `sha256:${digest(`scale-spec-${identity}`)}`,
      role: 'implement', preemptible: false, checkpoint_ordinal: 0, session_lease_id: actor.leaseId, session_token: actor.token,
    },
  };
}

function mailboxDrainRequest(actor: ScaleSession, client: number): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: `scale-mailbox-drain-${String(client)}`,
    action: 'drain-mailbox', idempotency_key: `scale-mailbox-drain-${String(client)}`, repo_id: actor.repoId, workstream_run: actor.run,
    session_id: actor.sessionId, fencing_generation: actor.generation, expected_version: 1 + heartbeatCountForActor(actor.index),
    payload: { delivery_id: `scale-delivery-${String(client)}`, session_lease_id: actor.leaseId, session_token: actor.token },
  };
}

function* semanticEventCorpus(repositoryRoot: string, stateRoot: string, sessions: readonly ScaleSession[]): Generator<CoordinatorSemanticReplayRecord> {
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    yield attachRunRequest(index, repositoryRoot, stateRoot);
    yield attachSessionRequest(index);
  }
  // These are real session-recovery heartbeats accepted by the shipped
  // operator replay path, not a test-only event schema or direct event insert.
  for (let ordinal = 0; ordinal < RECOVERY_HEARTBEAT_COUNT; ordinal += 1) {
    const actor = sessions[ordinal % SESSION_COUNT];
    if (actor === undefined) throw new Error(`scale recovery heartbeat actor ${String(ordinal)} is missing`);
    yield recoveryHeartbeatRequest(actor, ordinal);
  }
  for (let repository = 0; repository < REPOSITORY_COUNT; repository += 1) {
    const owner = sessions[repository * 2];
    if (owner === undefined) throw new Error(`scale owner ${String(repository)} is missing`);
    yield acquireRequest(owner, 'owner');
  }
  for (const index of seededOrder(REQUEST_COUNT)) {
    const actor = sessions[(index % REPOSITORY_COUNT) * 2 + 1];
    if (actor === undefined) throw new Error(`scale requester ${String(index)} is missing`);
    yield acquireRequest(actor, index);
  }
  for (let client = 0; client < CLIENT_COUNT; client += 1) {
    const owner = sessions[client * 2];
    if (owner === undefined) throw new Error(`scale mailbox actor ${String(client)} is missing`);
    yield mailboxDrainRequest(owner, client);
  }
}

interface ExportSummary {
  readonly counts: Readonly<Record<string, number>>;
  readonly logicalClients: ReadonlySet<string>;
}

async function parseDeterministicExport(path: string): Promise<ExportSummary> {
  const counts: Record<string, number> = {};
  const logicalClients = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyCapture: string | null = null;
  let currentKey: string | null = null;
  let awaitingTopKey = false;
  let arrayKey: string | null = null;
  let row = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    for (const character of chunk) {
      if (row.length > 0) row += character;
      if (inString) {
        if (keyCapture !== null) keyCapture += character;
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          if (keyCapture !== null) { currentKey = JSON.parse(keyCapture) as string; keyCapture = null; awaitingTopKey = false; }
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        if (depth === 1 && awaitingTopKey) keyCapture = '"';
        continue;
      }
      if (character === '{') {
        if (depth === 2 && arrayKey !== null) row = '{';
        depth += 1;
        if (depth === 1) awaitingTopKey = true;
        continue;
      }
      if (character === '}') {
        depth -= 1;
        if (row.length > 0 && depth === 2) {
          const parsed = JSON.parse(row) as Readonly<Record<string, unknown>>;
          counts[arrayKey ?? ''] = (counts[arrayKey ?? ''] ?? 0) + 1;
          if (arrayKey === 'runs') {
            const autopilotId = parsed['autopilot_id'];
            if (typeof autopilotId !== 'string') throw new Error('exported run has no logical client identity');
            logicalClients.add(autopilotId);
          }
          row = '';
        }
        continue;
      }
      if (character === '[') {
        if (depth === 1) { arrayKey = currentKey; if (arrayKey !== null) counts[arrayKey] = 0; }
        depth += 1;
        continue;
      }
      if (character === ']') {
        depth -= 1;
        if (depth === 1) arrayKey = null;
        continue;
      }
      if (character === ',' && depth === 1) { awaitingTopKey = true; currentKey = null; }
    }
  }
  assert.equal(depth, 0, 'deterministic export JSON is structurally complete');
  assert.equal(inString, false, 'deterministic export has no unterminated string');
  return { counts, logicalClients };
}

async function sqliteFootprint(databasePath: string): Promise<number> {
  let total = 0;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try { total += (await stat(path)).size; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return total;
}

void describe('Coordination Fabric release-scale corpus', () => {
  void it('production-replays exactly 100k semantic events and 10k contested requests within release bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autopilot-coordination-scale-'));
    const stateRoot = join(root, 'state');
    const repositoryRoot = join(root, 'generic-scale-repositories');
    const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const sessions = Array.from({ length: SESSION_COUNT }, (_entry, index) => session(index));
    const started = Date.now();
    try {
      const staged = await stageCoordinatorSemanticReplay(paths, 'cf9-scale-100k', semanticEventCorpus(repositoryRoot, stateRoot, sessions));
      assert.equal(staged.record_count, EVENT_COUNT);

      const imported = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-12T12:00:00.000Z') });
      const replayDuration = Date.now() - started;
      try {
        assert.equal(imported.integrity(), 'ok');
        for (let repository = 0; repository < REPOSITORY_COUNT; repository += 1) {
          const actor = sessions[repository * 2];
          if (actor === undefined) throw new Error(`scale indexed-query actor ${String(repository)} is missing`);
          const queryStarted = Date.now();
          const status = imported.status(actor.repoId, actor.run);
          assert.ok(Date.now() - queryStarted < MAX_INDEXED_QUERY_MS, `indexed status query ${String(repository)} exceeded one second`);
          const expected = Math.floor((REQUEST_COUNT - 1 - repository) / REPOSITORY_COUNT) + 1;
          assert.equal(status.payload['pending_messages'], expected);
        }
        for (let client = 0; client < CLIENT_COUNT; client += 1) {
          const owner = sessions[client * 2];
          if (owner === undefined) throw new Error(`scale mailbox actor ${String(client)} is missing`);
          const queryStarted = Date.now();
          const replay = imported.handle(mailboxDrainRequest(owner, client));
          assert.equal(replay.ok, true, `mailbox drain replay ${String(client)} failed`);
          assert.ok(Date.now() - queryStarted < MAX_INDEXED_QUERY_MS, `actual mailbox-drain query ${String(client)} exceeded one second`);
        }
        const firstExportPath = join(root, 'scale-export.json');
        const firstExport = imported.exportTo(firstExportPath);
        const secondExport = imported.exportTo(join(root, 'scale-export-repeat.json'));
        assert.equal(firstExport.payload['sha256'], secondExport.payload['sha256']);
        const exactExportBytes = await readFile(firstExportPath);
        assert.equal(exactExportBytes[exactExportBytes.byteLength - 1], 0x0a, 'deterministic export must end in one newline byte');
        assert.equal(firstExport.payload['sha256'], `sha256:${createHash('sha256').update(exactExportBytes).digest('hex')}`, 'export digest must cover exact file bytes including newline');
      } finally { imported.close(); }

      const summary = await parseDeterministicExport(join(root, 'scale-export.json'));
      assert.equal(summary.counts['events'], EVENT_COUNT);
      assert.equal(summary.counts['claim_requests'], REQUEST_COUNT);
      assert.equal(summary.counts['repositories'], REPOSITORY_COUNT);
      assert.equal(summary.counts['semantic_replays'], 1);
      assert.equal(summary.logicalClients.size, CLIENT_COUNT);

      const databaseBytes = await sqliteFootprint(paths.databasePath);
      const exportBytes = (await stat(join(root, 'scale-export.json'))).size;
      const rss = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
      assert.ok(replayDuration < MAX_DURATION_MS, `staging and transactional replay took ${String(replayDuration)}ms`);
      assert.ok(databaseBytes < MAX_DATABASE_BYTES, `database+WAL+SHM used ${String(databaseBytes)} bytes`);
      assert.ok(rss < MAX_RSS, `peak-observed RSS used ${String(rss)} bytes`);
      assert.ok(exportBytes > 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
