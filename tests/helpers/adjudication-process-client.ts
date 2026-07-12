import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAdjudicationAssignment } from '../../src/core/coordination/contracts.ts';

function argument(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

function integerArgument(index: number, label: string): number {
  const value = Number(argument(index, label));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

const stateRoot = argument(2, 'state root');
const repoId = argument(3, 'repo id');
const workstreamRun = argument(4, 'workstream run');
const assignmentId = argument(5, 'assignment id');
const autopilotId = argument(6, 'autopilot id');
const sessionId = argument(7, 'session id');
const sessionGeneration = integerArgument(8, 'session generation');
const runVersion = integerArgument(9, 'run version');
const sessionLeaseId = argument(10, 'session lease id');
const sessionToken = argument(11, 'session token');
const bootId = argument(12, 'boot id');
const unitWorktree = argument(13, 'unit worktree');
const unitId = argument(14, 'unit id');

const client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot }, autoStart: false });
const bundleResponse = await client.mutate('claim-adjudication-assignment', { repoId, workstreamRun, sessionId, fencingGeneration: sessionGeneration, expectedVersion: runVersion, idempotencyKey: `claim-adjudication-process:${assignmentId}` }, { unit_id: unitId, attempt: 1, session_lease_id: sessionLeaseId, session_token: sessionToken });
const assignment = parseCoordinationAdjudicationAssignment(bundleResponse.payload['adjudication_assignment']);
if (assignment.assignment_id !== assignmentId) throw new Error(`assignment ${assignmentId} was not claimed exactly`);
const rawDocuments = bundleResponse.payload['authoritative_documents'];
if (!Array.isArray(rawDocuments)) throw new Error('assignment bundle has no authoritative documents');
for (const clause of assignment.conflicting_clauses) {
  const matching = rawDocuments.find((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const artifact = value['artifact'];
    if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) return false;
    const evidence = artifact['evidence'];
    return typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) && evidence['ref'] === clause.authoritative_ref.ref && evidence['sha256'] === clause.authoritative_ref.sha256;
  });
  if (typeof matching !== 'object' || matching === null || Array.isArray(matching) || typeof matching['content_utf8'] !== 'string' || !matching['content_utf8'].includes(clause.exact_requirement)) throw new Error(`assigned authoritative document does not contain clause ${clause.clause_id}`);
}
const childId = `child-${workstreamRun}-${unitId}-1`;
const childToken = createHash('sha256').update(`${assignmentId}\0${String(process.pid)}`, 'utf8').digest('hex');
await client.mutate('register-child', {
  repoId,
  workstreamRun,
  sessionId,
  fencingGeneration: sessionGeneration,
  expectedVersion: runVersion,
  idempotencyKey: `register-adjudicator-process:${assignmentId}`,
}, {
  child_lease_id: childId,
  autopilot_id: autopilotId,
  unit_id: unitId,
  attempt: 1,
  pid: process.pid,
  boot_id: bootId,
  child_token: childToken,
  session_lease_id: sessionLeaseId,
  session_token: sessionToken,
  lease_expires_at: '2099-01-01T00:00:00.000Z',
});
const adjudication = {
  schema_version: 'autopilot.planning_contradiction_adjudication.v1',
  adjudication_id: assignment.assignment_id,
  adjudicator: assignment.adjudicator,
  adjudicator_role: 'adjudicate',
  independent_from_runs: assignment.participating_runs,
  verdict: 'major-contradiction',
  conflicting_clauses: assignment.conflicting_clauses,
  sequencing_can_satisfy_both: false,
  partitioning_can_satisfy_both: false,
  ownership_transfer_can_satisfy_both: false,
  rebase_revalidation_can_satisfy_both: false,
  replanning_can_preserve_both: false,
  operational_reasons: [],
  decision_options: assignment.decision_options,
} as const;
const adjudicationPath = join(unitWorktree, 'adjudications', `${assignment.assignment_id}.json`);
await mkdir(dirname(adjudicationPath), { recursive: true });
await writeFile(adjudicationPath, `${JSON.stringify(adjudication, null, 2)}\n`, 'utf8');
await client.mutate('complete-adjudication', {
  repoId,
  workstreamRun,
  sessionId: null,
  fencingGeneration: null,
  expectedVersion: 1,
  idempotencyKey: `complete-adjudication-process:${assignment.assignment_id}`,
}, {
  assignment_id: assignment.assignment_id,
  adjudication_path: adjudicationPath,
  child_lease_id: childId,
  child_token: childToken,
  pid: process.pid,
  boot_id: bootId,
});
console.log(JSON.stringify({ assignment_id: assignment.assignment_id, adjudication_path: adjudicationPath }));
