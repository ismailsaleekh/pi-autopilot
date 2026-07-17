import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationMailboxDeliveryReceipt, parseCoordinationReconciliationDetail, parseCoordinationReconciliationReceipt, parseCoordinationResultDetail, parseCoordinationResultReceipt } from '../../src/core/coordination/contracts.ts';
import { byteBudgetPage, COORDINATOR_MAX_PAGE_ENTITY_BYTES, COORDINATOR_PAGE_TARGET_BYTES, encodePaginationCursor, encodedJsonBytes, paginationCursorSnapshot, paginationRevision, paginationScope, parsePaginationCursor } from '../../src/core/coordination/pagination.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinationMailboxDeliveryReceipt, type CoordinationReconciliationDetail, type CoordinationRequestedLease, type CoordinatorRequestEnvelope, type CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function isJsonMap(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonMap(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function responseBytes(payload: Readonly<Record<string, unknown>>): number {
  const response: CoordinatorResponseEnvelope = {
    schema_version: 'autopilot.coordinator_response.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'pagination-byte-witness', ok: true,
    committed_event_seq: null, error_code: null, retryable: false, payload,
  };
  return encodedJsonBytes(response);
}

function mutation(input: Omit<CoordinatorRequestEnvelope, 'schema_version' | 'protocol_version' | 'request_id'> & { readonly requestId: string }): CoordinatorRequestEnvelope {
  return { schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: input.requestId, action: input.action, idempotency_key: input.idempotency_key, repo_id: input.repo_id, workstream_run: input.workstream_run, session_id: input.session_id, fencing_generation: input.fencing_generation, expected_version: input.expected_version, payload: input.payload };
}

void describe('BUG-176 protocol-1.6 byte-bounded coordinator pagination', () => {
  void it('proves attach-session is the first overflowing activation action and measures every encoded reconciliation contributor', () => {
    const ids = (prefix: string): readonly string[] => Array.from({ length: 4_096 }, (_entry, index) => `${prefix}-${digest(`${prefix}:${String(index)}`)}-${String(index).padStart(5, '0')}`);
    const fields = {
      released_lease_ids: ids('edit-lease'), released_observation_ids: ids('observation'), stale_observation_ids: ids('stale-observation'),
      released_request_ids: ids('claim-request'), notification_ids: ids('message'), offered_group_ids: ids('acquisition-group'),
    };
    const run = { schema_version: 'autopilot.coordination_run.v1', repo_id: `sha256-${digest('measurement-repo')}`, autopilot_id: 'measurement-autopilot', workstream: 'measurement-workstream', workstream_run: 'measurement-run', coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 2, created_event_seq: 1, version: 3 };
    const session = { schema_version: 'autopilot.session_lease.v2', session_lease_id: 'measurement-session-lease', repo_id: run.repo_id, workstream_run: run.workstream_run, session_id: 'measurement-session', session_generation: 2, pid: 4242, boot_id: 'measurement-boot', lease_expires_at: '2026-07-14T00:01:00.000Z', attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 99, version: 1 };
    const envelope = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({ schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.5', request_id: 'measurement-attach-session', ok: true, committed_event_seq: 99, error_code: null, retryable: false, payload });
    const empty = { released_lease_ids: [], released_observation_ids: [], stale_observation_ids: [], released_request_ids: [], notification_ids: [], offered_group_ids: [] };
    const baseBytes = encodedJsonBytes(envelope({ run, session, reconciliation: empty }));
    const fieldBytes = Object.fromEntries(Object.entries(fields).map(([field, values]) => [field, encodedJsonBytes(envelope({ run, session, reconciliation: { ...empty, [field]: values } })) - baseBytes]));
    const attachSessionBytes = encodedJsonBytes(envelope({ run, session, reconciliation: fields }));
    const catalogRuns = Array.from({ length: 128 }, (_entry, index) => ({ ...run, workstream_run: `measurement-run-${String(index).padStart(4, '0')}`, autopilot_id: `measurement-autopilot-${String(index).padStart(4, '0')}` }));
    const catalogResources = catalogRuns.map((catalogRun) => ({ schema_version: 'autopilot.coordination_run_resource.v1', repo_id: run.repo_id, workstream_run: catalogRun.workstream_run, source_repo: '/synthetic/repository', git_common_dir: '/synthetic/repository/.git', worktree_root: '/synthetic/state/worktrees', main_worktree_path: `/synthetic/state/worktrees/${catalogRun.workstream_run}/main`, runtime_root: `/synthetic/state/worktrees/${catalogRun.workstream_run}/main/.pi/autopilot/measurement-workstream`, branch: `autopilot/${catalogRun.workstream_run}`, target_branch: 'main', target_base_sha: digest(`base:${catalogRun.workstream_run}`), origin_url: 'https://example.invalid/synthetic/repository.git', started_at: '2026-07-14T00:00:00.000Z', version: 1 }));
    const runCatalogBytes = encodedJsonBytes(envelope({ schema_version: 'autopilot.coordinator_run_catalog.v1', package_build: '1.1.0-cf42', protocol_version: '1.5', database_schema_version: 11, runs: catalogRuns, run_resources: catalogResources, next_cursor: 'measurement-run-0127', pending_migration_recovery_count: 0, pending_migration_recovery: [] }));
    const measurement = { schema_version: 'autopilot.coordinator_frame_measurement.v1', cardinality_per_reconciliation_field: 4_096, base_bytes: baseBytes, field_bytes: fieldBytes, run_catalog_bytes: runCatalogBytes, attach_session_bytes: attachSessionBytes, frame_ceiling_bytes: 1_048_576 };
    console.log(`coordinator-frame-measurement ${JSON.stringify(measurement)}`);
    assert.ok(runCatalogBytes < 1_048_576, 'bounded run-catalog is the first activation response and must fit');
    assert.ok(attachSessionBytes > 1_048_576, 'the next activation action, attach-session, must reproduce the old overflow');
    assert.equal(baseBytes + Object.values(fieldBytes).reduce((total, value) => total + value, 0), attachSessionBytes, 'encoded collection contributions must account for the full old response exactly');
  });

  void it('pages by canonical encoded bytes and rejects malformed, cross-scope, drifted, and oversized entities', () => {
    const items = Array.from({ length: 2_000 }, (_entry, index) => ({ entity_id: `entity-${String(index).padStart(5, '0')}`, payload: `${String(index)}:${'x'.repeat(1_900)}` }));
    const scopeSha256 = paginationScope(['unit-page', 'repo-a', 'run-a']);
    const revisionSha256 = paginationRevision(items);
    const cursorForOffset = (offset: number): string => encodePaginationCursor({ kind: 'unit-page', scopeSha256, revisionSha256, section: 'entities', snapshot: '2026-07-14T00:00:00.000Z', offset });
    const payloadForPage = (page: readonly (typeof items)[number][], nextCursor: string | null): Readonly<Record<string, unknown>> => ({ schema_version: 'autopilot.test_page.v1', items: page, next_cursor: nextCursor });
    const aggregate: (typeof items)[number][] = [];
    let offset = 0;
    let pageCount = 0;
    while (offset < items.length) {
      const page = byteBudgetPage({ items, offset, cursorForOffset, payloadForPage });
      assert.ok(encodedJsonBytes(payloadForPage(page.items, page.nextCursor)) <= COORDINATOR_PAGE_TARGET_BYTES);
      assert.ok(responseBytes(payloadForPage(page.items, page.nextCursor)) < 1_048_576);
      aggregate.push(...page.items);
      pageCount += 1;
      if (page.nextCursor === null) offset = items.length;
      else offset = parsePaginationCursor(page.nextCursor, { kind: 'unit-page', scopeSha256, revisionSha256, section: 'entities', snapshot: '2026-07-14T00:00:00.000Z' });
    }
    assert.ok(pageCount > 1);
    assert.deepEqual(aggregate, items);
    const scan = encodePaginationCursor({ kind: 'unit-scan', scopeSha256, revisionSha256, section: 'all-sections', snapshot: '2026-07-14T00:00:00.000Z', offset: 0 });
    assert.equal(paginationCursorSnapshot(scan, { kind: 'unit-scan', scopeSha256, section: 'all-sections' }), '2026-07-14T00:00:00.000Z');
    assert.throws(() => parsePaginationCursor(`${scan}tampered`, { kind: 'unit-scan', scopeSha256, revisionSha256, section: 'all-sections', snapshot: '2026-07-14T00:00:00.000Z' }), /malformed/u);
    assert.throws(() => parsePaginationCursor(scan, { kind: 'unit-scan', scopeSha256: paginationScope(['foreign']), revisionSha256, section: 'all-sections', snapshot: '2026-07-14T00:00:00.000Z' }), /different query scope/u);
    assert.throws(() => parsePaginationCursor(scan, { kind: 'unit-scan', scopeSha256, revisionSha256: paginationRevision([]), section: 'all-sections', snapshot: '2026-07-14T00:00:00.000Z' }), /drifted/u);
    const oversized = [{ entity_id: 'oversized', payload: 'z'.repeat(COORDINATOR_MAX_PAGE_ENTITY_BYTES + 1) }];
    assert.throws(() => byteBudgetPage({ items: oversized, offset: 0, cursorForOffset, payloadForPage }), /single durable coordinator entity exceeds/u);
  });

  void it('durably pages a large mailbox across replay, concurrent arrival, and restart without gaps or duplicate page identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-mailbox-pages-'));
    const stateRoot = join(root, 'state');
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
    let store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') });
    try {
      const repoId = `sha256-${digest('mailbox-page-repo')}`;
      const run = 'mailbox-page-run';
      assert.equal(store.handle(mutation({ requestId: 'mailbox-attach-run', action: 'attach-run', idempotency_key: 'mailbox-attach-run', repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: 0, payload: {
        repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: 'mailbox-autopilot', workstream: 'mailbox-workstream', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'worktrees', 'main', '.pi', 'autopilot', 'mailbox-workstream'), branch: 'autopilot/mailbox', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-14T00:00:00.000Z', version: 1 },
      } })).ok, true);
      const sessionToken = digest('mailbox-page-session-token');
      assert.equal(store.handle(mutation({ requestId: 'mailbox-attach-session', action: 'attach-session', idempotency_key: 'mailbox-attach-session', repo_id: repoId, workstream_run: run, session_id: 'mailbox-page-session', fencing_generation: 1, expected_version: 1, payload: { session_lease_id: 'mailbox-page-session-lease', session_token: sessionToken, pid: process.pid, boot_id: 'mailbox-page-boot', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null } })).ok, true);
      const expectedIds: string[] = [];
      for (let index = 0; index < 4_000; index += 1) {
        const messageId = `mailbox-message-${String(index).padStart(5, '0')}-${digest(`mailbox:${String(index)}`).slice(0, 32)}`;
        expectedIds.push(messageId);
        const preDelivered = index === 3_999;
        store.enqueueMessageForTest({ schema_version: 'autopilot.coordination_message.v1', message_id: messageId, repo_id: repoId, recipient_workstream_run: run, message_type: 'recovery-required', correlation_id: `mailbox-correlation-${String(index).padStart(5, '0')}`, payload: { reason: `synthetic durable mailbox witness ${String(index)} ${'m'.repeat(420)}` }, status: preDelivered ? 'delivered' : 'pending', created_event_seq: index + 10, delivered_event_seq: preDelivered ? 8 : null, acknowledged_event_seq: null, version: preDelivered ? 2 : 1 });
      }
      const aggregateIds: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pageOrdinal = 0;
      let finalReceipt: CoordinationMailboxDeliveryReceipt | null = null;
      let maximumMailboxFrameBytes = 0;
      let compactSnapshotWitness: Readonly<Record<string, unknown>> | null = null;
      do {
        const payload: Record<string, unknown> = { delivery_id: 'mailbox-large-delivery', session_lease_id: 'mailbox-page-session-lease', session_token: sessionToken };
        if (cursor !== null) payload['cursor'] = cursor;
        const request = mutation({ requestId: `mailbox-drain-${String(pageOrdinal)}`, action: 'drain-mailbox', idempotency_key: `mailbox-drain-${String(pageOrdinal)}`, repo_id: repoId, workstream_run: run, session_id: 'mailbox-page-session', fencing_generation: 1, expected_version: 1, payload });
        const response = store.handle(request);
        assert.equal(response.ok, true, JSON.stringify(response.payload));
        maximumMailboxFrameBytes = Math.max(maximumMailboxFrameBytes, encodedJsonBytes(response));
        assert.ok(maximumMailboxFrameBytes < 1_048_576);
        if (pageOrdinal === 0) {
          assert.deepEqual(store.handle(request), response, 'first committed page must replay byte-identically from idempotency storage');
          store.enqueueMessageForTest({ schema_version: 'autopilot.coordination_message.v1', message_id: 'mailbox-message-late-arrival', repo_id: repoId, recipient_workstream_run: run, message_type: 'recovery-required', correlation_id: 'mailbox-late-arrival', payload: { reason: 'arrived after durable delivery membership was frozen' }, status: 'pending', created_event_seq: 9_999, delivered_event_seq: null, acknowledged_event_seq: null, version: 1 });
          const acknowledgedAfterSnapshot = store.handle(mutation({ requestId: 'mailbox-snapshot-witness-ack', action: 'acknowledge-message', idempotency_key: 'mailbox-snapshot-witness-ack', repo_id: repoId, workstream_run: run, session_id: 'mailbox-page-session', fencing_generation: 1, expected_version: 2, payload: { message_id: expectedIds[3_999], session_lease_id: 'mailbox-page-session-lease', session_token: sessionToken } }));
          assert.equal(acknowledgedAfterSnapshot.ok, true, 'test witness must mutate the live message after delivery membership is frozen');
        }
        const messages = response.payload['messages'];
        if (!Array.isArray(messages)) throw new Error('mailbox page omitted messages');
        for (const message of messages) {
          if (!isJsonMap(message)) throw new Error('mailbox page message is malformed');
          const messageId = message['message_id'];
          if (typeof messageId !== 'string') throw new Error('mailbox page message identity is malformed');
          assert.equal(seen.has(messageId), false, `mailbox page repeated ${messageId}`);
          seen.add(messageId);
          aggregateIds.push(messageId);
          if (messageId === expectedIds[3_999]) compactSnapshotWitness = message;
        }
        finalReceipt = parseCoordinationMailboxDeliveryReceipt(response.payload['delivery_receipt']);
        if (pageOrdinal === 0) {
          const forged = encodePaginationCursor({ kind: 'mailbox-delivery', scopeSha256: paginationScope(['mailbox-delivery', repoId, run, 'mailbox-page-session-lease', 'mailbox-large-delivery']), revisionSha256: finalReceipt.message_ids_sha256, section: 'mailbox-large-delivery', offset: expectedIds.length - 1 });
          const skipped = store.handle(mutation({ requestId: 'mailbox-forged-skip', action: 'drain-mailbox', idempotency_key: 'mailbox-forged-skip', repo_id: repoId, workstream_run: run, session_id: 'mailbox-page-session', fencing_generation: 1, expected_version: 1, payload: { delivery_id: 'mailbox-large-delivery', cursor: forged, session_lease_id: 'mailbox-page-session-lease', session_token: sessionToken } }));
          assert.equal(skipped.ok, false);
          assert.equal(skipped.error_code, 'stale-version');
        }
        const next = response.payload['next_cursor'];
        if (next !== null && typeof next !== 'string') throw new Error('mailbox page continuation is malformed');
        cursor = typeof next === 'string' ? next : null;
        pageOrdinal += 1;
        if (pageOrdinal === 1) { store.close(); store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') }); }
      } while (cursor !== null);
      assert.ok(pageOrdinal > 1);
      assert.deepEqual(aggregateIds, expectedIds);
      assert.equal(seen.has('mailbox-message-late-arrival'), false, 'new arrival must not enter an existing durable delivery membership');
      if (compactSnapshotWitness === null) throw new Error('compacted mailbox snapshot witness was not delivered');
      assert.equal(compactSnapshotWitness['status'], 'delivered', 'compacted snapshot must not expose the later live acknowledgement');
      assert.equal(compactSnapshotWitness['delivered_event_seq'], 8);
      assert.equal(compactSnapshotWitness['acknowledged_event_seq'], null);
      assert.equal(compactSnapshotWitness['version'], 2, 'compacted snapshot must retain the exact pre-acknowledgement version');
      if (finalReceipt === null) throw new Error('mailbox delivery receipt missing');
      assert.equal(finalReceipt.completed, true);
      assert.equal(finalReceipt.message_count, expectedIds.length);
      assert.equal(finalReceipt.message_ids_sha256, `sha256:${createHash('sha256').update(JSON.stringify(expectedIds), 'utf8').digest('hex')}`);
      const statusSummary = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'mailbox-status-summary', action: 'status', idempotency_key: null, repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: null, payload: {} });
      const doctorSummary = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'mailbox-doctor-summary', action: 'doctor', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: {} });
      assert.equal(statusSummary.ok, true); assert.ok(encodedJsonBytes(statusSummary) < 1_048_576);
      assert.equal(doctorSummary.ok, true); assert.ok(encodedJsonBytes(doctorSummary) < 1_048_576);
      const statusScan = statusSummary.payload['scan_token'];
      const doctorScan = doctorSummary.payload['scan_token'];
      if (typeof statusScan !== 'string' || typeof doctorScan !== 'string') throw new Error('projection summaries omitted scan tokens');
      const heartbeat = store.handle(mutation({ requestId: 'mailbox-snapshot-heartbeat', action: 'heartbeat', idempotency_key: 'mailbox-snapshot-heartbeat', repo_id: repoId, workstream_run: run, session_id: 'mailbox-page-session', fencing_generation: 1, expected_version: 1, payload: { lease_expires_at: '2099-01-01T00:01:00.000Z', session_lease_id: 'mailbox-page-session-lease', session_token: sessionToken } }));
      assert.equal(heartbeat.ok, true);
      const statusAfterMutation = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'mailbox-status-snapshot-detail', action: 'status', idempotency_key: null, repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: null, payload: { section: 'session_leases', scan_token: statusScan } });
      const doctorAfterMutation = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: 'mailbox-doctor-snapshot-detail', action: 'doctor', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: { section: 'invariant_findings', scan_token: doctorScan } });
      assert.equal(statusAfterMutation.ok, true, JSON.stringify(statusAfterMutation.payload));
      assert.equal(doctorAfterMutation.ok, true, JSON.stringify(doctorAfterMutation.payload));
      const snapshottedSessions = statusAfterMutation.payload['items'];
      if (!Array.isArray(snapshottedSessions) || !isJsonMap(snapshottedSessions[0])) throw new Error('status snapshot omitted its stable session');
      assert.equal(snapshottedSessions[0]['version'], 1, 'status continuation must read the immutable pre-heartbeat snapshot');
      assert.equal(statusAfterMutation.payload['observed_at'], null);
      assert.equal(doctorAfterMutation.payload['observed_at'], '2026-07-14T00:00:00.000Z');
      console.log(`coordinator-mailbox-pagination-measurement ${JSON.stringify({ message_count: expectedIds.length, page_count: pageOrdinal, maximum_frame_bytes: maximumMailboxFrameBytes, status_summary_bytes: encodedJsonBytes(statusSummary), doctor_summary_bytes: encodedJsonBytes(doctorSummary) })}`);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  void it('migrates an oversized cf42 idempotency result into an exact compact replay plus durable detail pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-cf42-receipt-migration-'));
    const stateRoot = join(root, 'state');
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
    const repoId = `sha256-${digest('cf42-receipt-repo')}`;
    const run = 'cf42-receipt-run';
    const sessionToken = digest('cf42-receipt-session-token');
    const attachPayload = { session_lease_id: 'cf42-receipt-session-lease', session_token: sessionToken, pid: process.pid, boot_id: 'cf42-receipt-boot', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null };
    let store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') });
    const generationDatabasePath = store.currentGeneration().database_path;
    try {
      assert.equal(store.handle(mutation({ requestId: 'cf42-receipt-run-request', action: 'attach-run', idempotency_key: 'cf42-receipt-run-key', repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: 'cf42-receipt-autopilot', workstream: 'cf42-receipt-workstream', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'worktrees', 'main', '.pi', 'autopilot', 'cf42-receipt-workstream'), branch: 'autopilot/cf42-receipt', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-14T00:00:00.000Z', version: 1 } } })).ok, true);
      assert.equal(store.handle(mutation({ requestId: 'cf42-receipt-attach-request', action: 'attach-session', idempotency_key: 'cf42-receipt-attach-key', repo_id: repoId, workstream_run: run, session_id: 'cf42-receipt-session', fencing_generation: 1, expected_version: 1, payload: attachPayload })).ok, true);
    } finally { store.close(); }
    const detailsByField = {
      released_lease_ids: Array.from({ length: 4_096 }, (_entry, index) => `edit-lease-${digest(`cf42-lease:${String(index)}`)}`),
      released_observation_ids: Array.from({ length: 4_096 }, (_entry, index) => `observation-${digest(`cf42-observation:${String(index)}`)}`),
      stale_observation_ids: Array.from({ length: 4_096 }, (_entry, index) => `stale-observation-${digest(`cf42-stale:${String(index)}`)}`),
      released_request_ids: Array.from({ length: 4_096 }, (_entry, index) => `claim-request-${digest(`cf42-request:${String(index)}`)}`),
      notification_ids: Array.from({ length: 4_096 }, (_entry, index) => `message-${digest(`cf42-message:${String(index)}`)}`),
      offered_group_ids: Array.from({ length: 4_096 }, (_entry, index) => `acquisition-group-${digest(`cf42-group:${String(index)}`)}`),
    };
    const oldRequest: Readonly<Record<string, unknown>> = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'cf42-receipt-attach-retry', action: 'attach-session', idempotency_key: 'cf42-receipt-attach-key', repo_id: repoId, workstream_run: run, session_id: 'cf42-receipt-session', fencing_generation: 1, expected_version: 1, payload: attachPayload };
    const oldSemantic = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', action: 'attach-session', repo_id: repoId, workstream_run: run, session_id: 'cf42-receipt-session', fencing_generation: 1, expected_version: 1, payload: attachPayload };
    const oldDigest = `sha256:${createHash('sha256').update(canonicalJson(oldSemantic), 'utf8').digest('hex')}`;
    const database = new DatabaseSync(generationDatabasePath);
    try {
      const row = database.prepare('SELECT payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, 'cf42-receipt-attach-key');
      const payloadText = row?.['payload_json'];
      if (typeof payloadText !== 'string') throw new Error('cf42 fixture attach result disappeared');
      const parsedPayload: unknown = JSON.parse(payloadText);
      if (!isJsonMap(parsedPayload)) throw new Error('cf42 fixture attach result is malformed');
      const legacyPayload = Object.fromEntries(Object.entries(parsedPayload).filter(([field]) => field !== 'reconciliation_receipt'));
      legacyPayload['reconciliation'] = detailsByField;
      database.prepare('UPDATE idempotency_results SET request_sha256=?, payload_json=? WHERE repo_id=? AND idempotency_key=?').run(oldDigest, canonicalJson(legacyPayload), repoId, 'cf42-receipt-attach-key');
      database.prepare('UPDATE events SET request_sha256=? WHERE repo_id=? AND idempotency_key=?').run(oldDigest, repoId, 'cf42-receipt-attach-key');
    } finally { database.close(); }
    store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') });
    try {
      const replay = store.replayLegacyRequest(oldRequest);
      const compactReplayBytes = encodedJsonBytes(replay);
      assert.ok(compactReplayBytes < 1_048_576);
      assert.equal(replay.payload['reconciliation'], undefined);
      const receipt = parseCoordinationReconciliationReceipt(replay.payload['reconciliation_receipt']);
      assert.equal(receipt.detail_count, 24_576);
      const details: CoordinationReconciliationDetail[] = [];
      let cursor: string | null = null;
      let detailPageCount = 0;
      let maximumDetailFrameBytes = 0;
      do {
        const response = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `cf42-detail-page-${String(details.length)}`, action: 'reconciliation-details', idempotency_key: null, repo_id: repoId, workstream_run: run, session_id: 'cf42-receipt-session', fencing_generation: 1, expected_version: null, payload: { reconciliation_receipt_id: receipt.reconciliation_receipt_id, cursor, session_lease_id: 'cf42-receipt-session-lease', session_token: sessionToken } });
        assert.equal(response.ok, true, JSON.stringify(response.payload));
        maximumDetailFrameBytes = Math.max(maximumDetailFrameBytes, encodedJsonBytes(response));
        assert.ok(maximumDetailFrameBytes < 1_048_576);
        detailPageCount += 1;
        const page = response.payload['details'];
        if (!Array.isArray(page)) throw new Error('cf42 migrated detail page is malformed');
        details.push(...page.map(parseCoordinationReconciliationDetail));
        const next = response.payload['next_cursor'];
        if (next !== null && typeof next !== 'string') throw new Error('cf42 migrated detail cursor is malformed');
        cursor = typeof next === 'string' ? next : null;
      } while (cursor !== null);
      assert.equal(details.length, receipt.detail_count);
      assert.deepEqual(details.map((detail) => detail.ordinal), Array.from({ length: receipt.detail_count }, (_entry, index) => index + 1));
      assert.equal(`sha256:${createHash('sha256').update(JSON.stringify(details), 'utf8').digest('hex')}`, receipt.details_sha256);
      console.log(`coordinator-reconciliation-pagination-measurement ${JSON.stringify({ detail_count: details.length, page_count: detailPageCount, old_response_bytes: encodedJsonBytes({ schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.5', request_id: 'cf42-receipt-attach-retry', ok: true, committed_event_seq: receipt.committed_event_seq, error_code: null, retryable: false, payload: { reconciliation: detailsByField } }), compact_replay_bytes: compactReplayBytes, maximum_detail_frame_bytes: maximumDetailFrameBytes })}`);
      const migratedDatabase = new DatabaseSync(generationDatabasePath, { readOnly: true });
      try {
        const idempotency = migratedDatabase.prepare('SELECT request_sha256, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, 'cf42-receipt-attach-key');
        assert.equal(idempotency?.['request_sha256'], oldDigest, 'schema migration must preserve the exact cf42 semantic request digest');
        const migratedPayload = idempotency?.['payload_json'];
        assert.equal(typeof migratedPayload === 'string' && migratedPayload.includes('reconciliation_receipt'), true);
        assert.equal(typeof migratedPayload === 'string' && migratedPayload.includes('released_lease_ids'), false);
      } finally { migratedDatabase.close(); }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  void it('commits a valid sub-1-MiB mutation through an exact durable result receipt instead of rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-frame-precommit-'));
    const stateRoot = join(root, 'state');
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
    const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-14T00:00:00.000Z') });
    try {
      const repoId = `sha256-${digest('frame-precommit-repo')}`;
      const run = 'frame-precommit-run';
      const attachRun = store.handle(mutation({ requestId: 'attach-frame-run', action: 'attach-run', idempotency_key: 'attach-frame-run', repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: 0, payload: {
        repo_key: repoId, canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), autopilot_id: 'frame-autopilot', workstream: 'frame-workstream', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'worktrees', 'main', '.pi', 'autopilot', 'frame-workstream'), branch: 'autopilot/frame', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-14T00:00:00.000Z', version: 1 },
      } }));
      assert.equal(attachRun.ok, true);
      const sessionToken = digest('frame-session-token');
      const attach = store.handle(mutation({ requestId: 'attach-frame-session', action: 'attach-session', idempotency_key: 'attach-frame-session', repo_id: repoId, workstream_run: run, session_id: 'frame-session', fencing_generation: 1, expected_version: 1, payload: { session_lease_id: 'frame-session-lease', session_token: sessionToken, pid: process.pid, boot_id: 'frame-boot', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null } }));
      assert.equal(attach.ok, true);
      const requestedLeases = Array.from({ length: 1_024 }, (_entry, index): CoordinationRequestedLease => ({ path: `fixtures/${String(index).padStart(4, '0')}-${'p'.repeat(160)}.json`, mode: 'WRITE', purpose: `edit realistic generated fixture ${String(index)} ${'q'.repeat(160)}` }));
      const acquire = mutation({ requestId: 'oversized-expanded-acquire', action: 'acquire-group', idempotency_key: 'oversized-expanded-acquire', repo_id: repoId, workstream_run: run, session_id: 'frame-session', fencing_generation: 1, expected_version: 2, payload: { acquisition_group_id: 'oversized-expanded-group', acquisition_kind: 'initial', unit_id: 'oversized-expanded-unit', attempt: 1, requested_leases: requestedLeases, reason: 'prove response expansion is fenced before commit', normal_release_condition: { condition_type: 'unit-merged', target_id: 'oversized-expanded-unit:1', evidence: null }, spec_ref: '.pi/autopilot/frame/unit-specs/oversized-expanded-unit.json', spec_sha256: `sha256:${digest('frame-spec')}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: 'frame-session-lease', session_token: sessionToken } });
      assert.ok(encodedJsonBytes({ transport_version: 'autopilot.coordinator_transport.v1', capability: digest('frame-capability'), request: acquire }) < 1_048_576, 'fixture request itself must fit the production frame');
      const committed = store.handle(acquire);
      assert.equal(committed.ok, true, JSON.stringify(committed.payload));
      assert.ok(encodedJsonBytes(committed) < 1_048_576);
      assert.equal(committed.payload['edit_leases'], undefined);
      const receipt = parseCoordinationResultReceipt(committed.payload['result_receipt']);
      assert.equal(receipt.collections['edit_leases']?.item_count, requestedLeases.length);
      const productionClient = new CoordinatorClient({ env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }, autoStart: false });
      Object.defineProperty(productionClient, 'request', { value: async (request: CoordinatorRequestEnvelope): Promise<CoordinatorResponseEnvelope> => store.handle(request) });
      const expanded = await productionClient.mutate('acquire-group', { repoId, workstreamRun: run, sessionId: 'frame-session', fencingGeneration: 1, expectedVersion: 2, idempotencyKey: 'oversized-expanded-acquire' }, acquire.payload);
      const expandedLeases = expanded.payload['edit_leases'];
      if (!Array.isArray(expandedLeases)) throw new Error('production mutation consumer did not reconstruct result details');
      assert.equal(expandedLeases.length, requestedLeases.length);
      assert.deepEqual(expanded.payload['request_refs'], []);
      const details: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `expanded-result-${String(details.length)}`, action: 'result-details', idempotency_key: null, repo_id: repoId, workstream_run: run, session_id: 'frame-session', fencing_generation: 1, expected_version: null, payload: { result_receipt_id: receipt.result_receipt_id, cursor, session_lease_id: 'frame-session-lease', session_token: sessionToken } });
        assert.equal(page.ok, true, JSON.stringify(page.payload));
        assert.ok(encodedJsonBytes(page) < 1_048_576);
        const values = page.payload['details'];
        if (!Array.isArray(values)) throw new Error('result detail page omitted details');
        details.push(...values.map(parseCoordinationResultDetail));
        const next = page.payload['next_cursor'];
        if (next !== null && typeof next !== 'string') throw new Error('result detail continuation is malformed');
        cursor = typeof next === 'string' ? next : null;
      } while (cursor !== null);
      assert.equal(details.length, receipt.detail_count);
      const status = store.status(repoId, run).payload;
      const groups = status['acquisition_groups'];
      const editLeases = status['edit_leases'];
      if (!Array.isArray(groups) || !Array.isArray(editLeases)) throw new Error('status result witness omitted coordinator collections');
      assert.equal(groups.length, 1);
      assert.equal(editLeases.length, requestedLeases.length);
      assert.deepEqual(store.handle(acquire), committed, 'result-receipt mutation must replay byte-identically without a second effect');
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
