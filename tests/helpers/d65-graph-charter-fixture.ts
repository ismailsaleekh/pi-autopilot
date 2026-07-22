import { parseD65BootstrapCharter } from '../../src/core/coordination/d65-bootstrap-charter.ts';

export function d65BootstrapCharterFixture(input: {
  readonly repoId?: string;
  readonly repoKey?: string;
  readonly autopilotId?: string;
  readonly workstream?: string;
  readonly workstreamRun?: string;
  readonly programId?: string;
} = {}): Readonly<Record<string, unknown>> {
  const repoId = input.repoId ?? 'repo-1';
  const repoKey = input.repoKey ?? repoId;
  const autopilotId = input.autopilotId ?? 'auto-1';
  const workstream = input.workstream ?? 'work-1';
  const workstreamRun = input.workstreamRun ?? 'run-1';
  const programId = input.programId ?? 'program-1';
  const root = `/tmp/d65-charter/${repoId}`;
  const bootstrapCommit = 'a'.repeat(40);
  const bootstrapRef = `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`;
  const bootstrapSha = `sha256:${'b'.repeat(64)}`;
  const trustRef = `.pi/autopilot-trust/d65/${programId}/operator-ed25519.spki`;
  const trustSha = `sha256:${'c'.repeat(64)}`;
  const repository = { schema_version: 'autopilot.coordination_repository.v1', repo_id: repoId, repo_key: repoKey, canonical_root: root, git_common_dir: `${root}/.git`, created_event_seq: 1, version: 1 };
  const run = { schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun, coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1 };
  const runResource = { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun, source_repo: root, git_common_dir: `${root}/.git`, worktree_root: `${root}/.pi/worktrees`, main_worktree_path: `${root}/.pi/worktrees/main`, runtime_root: `${root}/.pi/worktrees/main/.pi/autopilot/${workstream}`, branch: `autopilot/${workstreamRun}/main`, target_branch: 'main', target_base_sha: 'd'.repeat(40), origin_url: null, started_at: '2026-07-22T00:00:00.000Z', version: 1 };
  const mailboxCursor = { schema_version: 'autopilot.mailbox_cursor.v1', repo_id: repoId, workstream_run: workstreamRun, delivered_through_event_seq: 0, acknowledged_through_event_seq: 0, version: 1 };
  const bootstrapGraph = { ref: bootstrapRef, sha256: bootstrapSha, byte_count: 128, git_commit: bootstrapCommit, covered_event_seq: 0 };
  const bootstrapArtifact = { schema_version: 'autopilot.authoritative_artifact.v1', artifact_id: `semantic-graph-bootstrap:${workstreamRun}`, repo_id: repoId, source_run: workstreamRun, source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph_bootstrap.v1', git_commit: bootstrapCommit, evidence: { ref: bootstrapRef, sha256: bootstrapSha }, registered_event_seq: 1, version: 1 };
  const trustAnchor = { trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha, git_commit: bootstrapCommit, git_mode: '100644', git_type: 'blob', git_blob_oid: 'e'.repeat(40), byte_count: 44 };
  const attachResult = { schema_version: 'autopilot.attach_run_result.v2', repository, run, run_resource: runResource, mailbox_cursor: mailboxCursor, bootstrap_graph: bootstrapGraph, bootstrap_artifact: bootstrapArtifact, trust_anchor: trustAnchor };
  const attachEvent = { schema_version: 'autopilot.coordination_event.v1', repo_id: repoId, event_seq: 1, event_type: 'run-attached', entity_type: 'run', entity_id: workstreamRun, idempotency_key: `attach-run:${workstreamRun}`, request_sha256: `sha256:${'f'.repeat(64)}`, occurred_at: '2026-07-22T00:00:00.000Z' };
  const charter = { repository, run, run_resource: runResource, mailbox_cursor: mailboxCursor, bootstrap_graph: bootstrapGraph, bootstrap_artifact: bootstrapArtifact, trust_anchor: trustAnchor, attach_event: attachEvent, attach_result: attachResult };
  parseD65BootstrapCharter(charter);
  return Object.freeze(charter);
}
