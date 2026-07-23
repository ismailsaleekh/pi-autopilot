import { isAbsolute } from 'node:path';
export const S2_CORPUS_CLONE_REQUEST_SCHEMA = 'autopilot.s2_d_corpus_clone_request.v1';
export const S2_CORPUS_CLONE_MANIFEST_SCHEMA = 'autopilot.s2_d_corpus_clone_manifest.v1';
export const S2_CORPUS_REHEARSAL_RESULT_SCHEMA = 'autopilot.s2_d_corpus_rehearsal_result.v1';
export const S2_D_DURABLE_RUN_ACTIONS = ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'];
export class S2CorpusContractError extends Error {
    name = 'S2CorpusContractError';
    issues;
    constructor(label, issues) {
        super(`${label} failed S2-D corpus contract validation: ${issues.join('; ')}`);
        this.issues = Object.freeze([...issues]);
    }
}
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
function jsonMap(value, fields, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new S2CorpusContractError(label, ['must be an object']);
    const row = value;
    const actual = Object.keys(row).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
        throw new S2CorpusContractError(label, [`field set mismatch: ${actual.join(',')}`]);
    return row;
}
function text(value, label, maximum = 4096) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000'))
        throw new S2CorpusContractError(label, ['must be bounded nonempty text without NUL']);
    return value;
}
function identifier(value, label) {
    const parsed = text(value, label, 192);
    if (!IDENTIFIER.test(parsed))
        throw new S2CorpusContractError(label, ['must be a closed identifier']);
    return parsed;
}
function digest(value, label) {
    if (typeof value !== 'string' || !DIGEST.test(value))
        throw new S2CorpusContractError(label, ['must be sha256:<64 lowercase hex>']);
    return value;
}
function timestamp(value, label) {
    const parsed = text(value, label, 32);
    if (!RFC3339.test(parsed) || !Number.isFinite(Date.parse(parsed)))
        throw new S2CorpusContractError(label, ['must be canonical UTC RFC3339']);
    return parsed;
}
function integer(value, label, minimum = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
        throw new S2CorpusContractError(label, [`must be an integer >= ${String(minimum)}`]);
    return value;
}
function booleanValue(value, label) {
    if (typeof value !== 'boolean')
        throw new S2CorpusContractError(label, ['must be boolean']);
    return value;
}
function array(value, label, maximum = 1_000_000) {
    if (!Array.isArray(value) || value.length > maximum)
        throw new S2CorpusContractError(label, [`must be an array with at most ${String(maximum)} entries`]);
    return value;
}
function exactLiteral(value, values, label) {
    if (typeof value !== 'string' || !values.includes(value))
        throw new S2CorpusContractError(label, [`must be one of ${values.join(',')}`]);
    return value;
}
function absolutePath(value, label) {
    const parsed = text(value, label);
    if (!isAbsolute(parsed))
        throw new S2CorpusContractError(label, ['must be absolute']);
    return parsed;
}
function parseIdentity(value, label) {
    const row = jsonMap(value, ['device', 'inode', 'link_count'], label);
    return Object.freeze({ device: text(row['device'], `${label}.device`, 64), inode: text(row['inode'], `${label}.inode`, 64), link_count: integer(row['link_count'], `${label}.link_count`, 1) });
}
function parseSourceRequest(value, label) {
    const row = jsonMap(value, ['corpus_id', 'state_root', 'repository_root', 'database_path', 'capability_path', 'retained_snapshot_roots'], label);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), state_root: absolutePath(row['state_root'], `${label}.state_root`), repository_root: absolutePath(row['repository_root'], `${label}.repository_root`), database_path: absolutePath(row['database_path'], `${label}.database_path`), capability_path: absolutePath(row['capability_path'], `${label}.capability_path`), retained_snapshot_roots: Object.freeze(array(row['retained_snapshot_roots'], `${label}.retained_snapshot_roots`, 10_000).map((entry, index) => absolutePath(entry, `${label}.retained_snapshot_roots.${String(index)}`))) });
}
function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function sortedUnique(values, identity, label) {
    const keys = values.map(identity);
    if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? '')))
        throw new S2CorpusContractError(label, ['must be sorted and unique']);
    return Object.freeze([...values]);
}
export function parseCorpusCloneRequest(value) {
    const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'created_at', 'destination_root', 'result_path', 'candidate_build', 'corpora'], 'S2-D clone request');
    if (row['schema_version'] !== S2_CORPUS_CLONE_REQUEST_SCHEMA)
        throw new S2CorpusContractError('S2-D clone request', ['schema_version mismatch']);
    const corpora = array(row['corpora'], 'S2-D clone request.corpora', 10_000).map((entry, index) => parseSourceRequest(entry, `S2-D clone request.corpora.${String(index)}`));
    return Object.freeze({ schema_version: S2_CORPUS_CLONE_REQUEST_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D clone request.rehearsal_id'), created_at: timestamp(row['created_at'], 'S2-D clone request.created_at'), destination_root: absolutePath(row['destination_root'], 'S2-D clone request.destination_root'), result_path: absolutePath(row['result_path'], 'S2-D clone request.result_path'), candidate_build: identifier(row['candidate_build'], 'S2-D clone request.candidate_build'), corpora: sortedUnique(corpora, (entry) => entry.corpus_id, 'S2-D clone request.corpora') });
}
function parseWitness(value, label) {
    const row = jsonMap(value, ['corpus_id', 'root_label', 'path_sha256', 'identity', 'file_count', 'total_bytes', 'tree_sha256'], label);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), root_label: identifier(row['root_label'], `${label}.root_label`), path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: parseIdentity(row['identity'], `${label}.identity`), file_count: integer(row['file_count'], `${label}.file_count`), total_bytes: integer(row['total_bytes'], `${label}.total_bytes`), tree_sha256: digest(row['tree_sha256'], `${label}.tree_sha256`) });
}
function parseDatabaseWitness(value, label) {
    const row = jsonMap(value, ['corpus_id', 'role', 'present', 'path_sha256', 'identity', 'size_bytes', 'sha256'], label);
    const present = booleanValue(row['present'], `${label}.present`);
    const identityValue = row['identity'] === null ? null : parseIdentity(row['identity'], `${label}.identity`);
    const size = row['size_bytes'] === null ? null : integer(row['size_bytes'], `${label}.size_bytes`);
    const sha = row['sha256'] === null ? null : digest(row['sha256'], `${label}.sha256`);
    if (present !== (identityValue !== null && size !== null && sha !== null))
        throw new S2CorpusContractError(label, ['presence must match identity, size, and digest']);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), role: exactLiteral(row['role'], ['database', 'wal', 'shm', 'journal'], `${label}.role`), present, path_sha256: digest(row['path_sha256'], `${label}.path_sha256`), identity: identityValue, size_bytes: size, sha256: sha });
}
function parseGitWitness(value, label) {
    const row = jsonMap(value, ['corpus_id', 'ref_digest', 'registration_digest', 'worktree_digest'], label);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), ref_digest: digest(row['ref_digest'], `${label}.ref_digest`), registration_digest: digest(row['registration_digest'], `${label}.registration_digest`), worktree_digest: digest(row['worktree_digest'], `${label}.worktree_digest`) });
}
function parseRebaseEntry(value, label) {
    const row = jsonMap(value, ['corpus_id', 'target_kind', 'target_sha256', 'json_pointer', 'old_path_sha256', 'clone_relative_path', 'rewrite_kind', 'after_sha256'], label);
    const clonePath = row['clone_relative_path'] === null ? null : text(row['clone_relative_path'], `${label}.clone_relative_path`);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), target_kind: exactLiteral(row['target_kind'], ['json-file', 'jsonl-file', 'sqlite-cell', 'git-registration'], `${label}.target_kind`), target_sha256: digest(row['target_sha256'], `${label}.target_sha256`), json_pointer: text(row['json_pointer'], `${label}.json_pointer`, 4096), old_path_sha256: digest(row['old_path_sha256'], `${label}.old_path_sha256`), clone_relative_path: clonePath, rewrite_kind: exactLiteral(row['rewrite_kind'], ['path-rebase', 'remote-neutralization'], `${label}.rewrite_kind`), after_sha256: digest(row['after_sha256'], `${label}.after_sha256`) });
}
function parseProof(value, label) {
    const row = jsonMap(value, ['passed', 'evidence_sha256'], label);
    return Object.freeze({ passed: booleanValue(row['passed'], `${label}.passed`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}
function parseProofs(value, label) {
    const row = jsonMap(value, ['roots_disjoint', 'no_shared_regular_file_identity', 'no_live_symlink_hardlink_socket_route', 'git_mirror_self_contained', 'git_no_remote_alternate_hook_include', 'capability_rotated', 'worktree_paths_rebased', 'no_live_lock_database_evidence_write_route', 'sandbox_write_confinement', 'live_before_after_equal'], label);
    const proofs = Object.freeze({ roots_disjoint: parseProof(row['roots_disjoint'], `${label}.roots_disjoint`), no_shared_regular_file_identity: parseProof(row['no_shared_regular_file_identity'], `${label}.no_shared_regular_file_identity`), no_live_symlink_hardlink_socket_route: parseProof(row['no_live_symlink_hardlink_socket_route'], `${label}.no_live_symlink_hardlink_socket_route`), git_mirror_self_contained: parseProof(row['git_mirror_self_contained'], `${label}.git_mirror_self_contained`), git_no_remote_alternate_hook_include: parseProof(row['git_no_remote_alternate_hook_include'], `${label}.git_no_remote_alternate_hook_include`), capability_rotated: parseProof(row['capability_rotated'], `${label}.capability_rotated`), worktree_paths_rebased: parseProof(row['worktree_paths_rebased'], `${label}.worktree_paths_rebased`), no_live_lock_database_evidence_write_route: parseProof(row['no_live_lock_database_evidence_write_route'], `${label}.no_live_lock_database_evidence_write_route`), sandbox_write_confinement: parseProof(row['sandbox_write_confinement'], `${label}.sandbox_write_confinement`), live_before_after_equal: parseProof(row['live_before_after_equal'], `${label}.live_before_after_equal`) });
    if (!Object.values(proofs).every((proofEntry) => proofEntry.passed))
        throw new S2CorpusContractError(label, ['every isolation proof must pass']);
    return proofs;
}
function parseRunContract(value, label) {
    const row = jsonMap(value, ['corpus_id', 'run_id_sha256', 'repo_id_sha256', 'required_actions', 'attachment_strategy', 'terminal_attempt_lease', 'authority_version_mismatch', 'evidence_sha256'], label);
    const actions = array(row['required_actions'], `${label}.required_actions`, 4).map((entry, index) => exactLiteral(entry, S2_D_DURABLE_RUN_ACTIONS, `${label}.required_actions.${String(index)}`));
    if (actions.length !== S2_D_DURABLE_RUN_ACTIONS.length || actions.some((action, index) => action !== S2_D_DURABLE_RUN_ACTIONS[index]))
        throw new S2CorpusContractError(label, ['required_actions must be the exact durable-run gate sequence']);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), repo_id_sha256: digest(row['repo_id_sha256'], `${label}.repo_id_sha256`), required_actions: S2_D_DURABLE_RUN_ACTIONS, attachment_strategy: exactLiteral(row['attachment_strategy'], ['safe-attachment', 'owned-recovery'], `${label}.attachment_strategy`), terminal_attempt_lease: exactLiteral(row['terminal_attempt_lease'], ['no-retained-terminal-attempt-lease', 'retained-terminal-attempt-reconciled'], `${label}.terminal_attempt_lease`), authority_version_mismatch: exactLiteral(row['authority_version_mismatch'], ['no-operation-authority-version-mismatch', 'operation-authority-version-mismatch-blocked', 'operation-authority-version-mismatch-recovered'], `${label}.authority_version_mismatch`), evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}
export function parseCorpusCloneManifest(value) {
    const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'created_at', 'candidate_build', 'source_witness_before', 'database_witness_before', 'git_witness_before', 'path_rebase_ledger', 'clone_capability_sha256', 'isolation_proofs', 'durable_runs'], 'S2-D clone manifest');
    if (row['schema_version'] !== S2_CORPUS_CLONE_MANIFEST_SCHEMA)
        throw new S2CorpusContractError('S2-D clone manifest', ['schema_version mismatch']);
    const runs = array(row['durable_runs'], 'S2-D clone manifest.durable_runs').map((entry, index) => parseRunContract(entry, `S2-D clone manifest.durable_runs.${String(index)}`));
    return Object.freeze({ schema_version: S2_CORPUS_CLONE_MANIFEST_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D clone manifest.rehearsal_id'), created_at: timestamp(row['created_at'], 'S2-D clone manifest.created_at'), candidate_build: identifier(row['candidate_build'], 'S2-D clone manifest.candidate_build'), source_witness_before: sortedUnique(array(row['source_witness_before'], 'S2-D clone manifest.source_witness_before').map((entry, index) => parseWitness(entry, `S2-D clone manifest.source_witness_before.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.root_label}`, 'S2-D clone manifest.source_witness_before'), database_witness_before: sortedUnique(array(row['database_witness_before'], 'S2-D clone manifest.database_witness_before').map((entry, index) => parseDatabaseWitness(entry, `S2-D clone manifest.database_witness_before.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.role}`, 'S2-D clone manifest.database_witness_before'), git_witness_before: sortedUnique(array(row['git_witness_before'], 'S2-D clone manifest.git_witness_before').map((entry, index) => parseGitWitness(entry, `S2-D clone manifest.git_witness_before.${String(index)}`)), (entry) => entry.corpus_id, 'S2-D clone manifest.git_witness_before'), path_rebase_ledger: sortedUnique(array(row['path_rebase_ledger'], 'S2-D clone manifest.path_rebase_ledger').map((entry, index) => parseRebaseEntry(entry, `S2-D clone manifest.path_rebase_ledger.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.target_kind}\0${entry.target_sha256}\0${entry.json_pointer}`, 'S2-D clone manifest.path_rebase_ledger'), clone_capability_sha256: digest(row['clone_capability_sha256'], 'S2-D clone manifest.clone_capability_sha256'), isolation_proofs: parseProofs(row['isolation_proofs'], 'S2-D clone manifest.isolation_proofs'), durable_runs: sortedUnique(runs, (entry) => `${entry.corpus_id}\0${entry.run_id_sha256}`, 'S2-D clone manifest.durable_runs') });
}
function parseActionResult(value, label) {
    const row = jsonMap(value, ['corpus_id', 'run_id_sha256', 'action', 'outcome', 'evidence_sha256'], label);
    if (row['outcome'] !== 'passed')
        throw new S2CorpusContractError(label, ['outcome must be passed']);
    return Object.freeze({ corpus_id: identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: digest(row['run_id_sha256'], `${label}.run_id_sha256`), action: exactLiteral(row['action'], ['attach', 'doctor', 'reconcile', 'dispatch-dry-run'], `${label}.action`), outcome: 'passed', evidence_sha256: digest(row['evidence_sha256'], `${label}.evidence_sha256`) });
}
function parseBlocker(value, label) {
    const row = jsonMap(value, ['code', 'corpus_id', 'run_id_sha256', 'diagnostic_sha256'], label);
    return Object.freeze({ code: identifier(row['code'], `${label}.code`), corpus_id: row['corpus_id'] === null ? null : identifier(row['corpus_id'], `${label}.corpus_id`), run_id_sha256: row['run_id_sha256'] === null ? null : digest(row['run_id_sha256'], `${label}.run_id_sha256`), diagnostic_sha256: digest(row['diagnostic_sha256'], `${label}.diagnostic_sha256`) });
}
function parseLiveUnchanged(value, label) {
    const row = jsonMap(value, ['source_witness_before_sha256', 'source_witness_after_sha256', 'database_witness_before_sha256', 'database_witness_after_sha256', 'git_witness_before_sha256', 'git_witness_after_sha256', 'database_components', 'git_refs', 'registrations', 'worktrees', 'files', 'passed'], label);
    const parsed = Object.freeze({ source_witness_before_sha256: digest(row['source_witness_before_sha256'], `${label}.source_witness_before_sha256`), source_witness_after_sha256: digest(row['source_witness_after_sha256'], `${label}.source_witness_after_sha256`), database_witness_before_sha256: digest(row['database_witness_before_sha256'], `${label}.database_witness_before_sha256`), database_witness_after_sha256: digest(row['database_witness_after_sha256'], `${label}.database_witness_after_sha256`), git_witness_before_sha256: digest(row['git_witness_before_sha256'], `${label}.git_witness_before_sha256`), git_witness_after_sha256: digest(row['git_witness_after_sha256'], `${label}.git_witness_after_sha256`), database_components: booleanValue(row['database_components'], `${label}.database_components`), git_refs: booleanValue(row['git_refs'], `${label}.git_refs`), registrations: booleanValue(row['registrations'], `${label}.registrations`), worktrees: booleanValue(row['worktrees'], `${label}.worktrees`), files: booleanValue(row['files'], `${label}.files`), passed: booleanValue(row['passed'], `${label}.passed`) });
    if (!parsed.passed || !parsed.database_components || !parsed.git_refs || !parsed.registrations || !parsed.worktrees || !parsed.files || parsed.source_witness_before_sha256 !== parsed.source_witness_after_sha256 || parsed.database_witness_before_sha256 !== parsed.database_witness_after_sha256 || parsed.git_witness_before_sha256 !== parsed.git_witness_after_sha256)
        throw new S2CorpusContractError(label, ['live source before/after proofs must all pass and match']);
    return parsed;
}
export function parseCorpusRehearsalResult(value) {
    const row = jsonMap(value, ['schema_version', 'rehearsal_id', 'candidate_build', 'action_results', 'live_unchanged', 'isolation_proofs', 'new_blockers', 'completed_at'], 'S2-D rehearsal result');
    if (row['schema_version'] !== S2_CORPUS_REHEARSAL_RESULT_SCHEMA)
        throw new S2CorpusContractError('S2-D rehearsal result', ['schema_version mismatch']);
    const blockers = array(row['new_blockers'], 'S2-D rehearsal result.new_blockers').map((entry, index) => parseBlocker(entry, `S2-D rehearsal result.new_blockers.${String(index)}`));
    if (blockers.length !== 0)
        throw new S2CorpusContractError('S2-D rehearsal result', ['new_blockers must be empty for release']);
    const actionValues = array(row['action_results'], 'S2-D rehearsal result.action_results');
    if (actionValues.length === 0)
        throw new S2CorpusContractError('S2-D rehearsal result', ['action_results must cover at least one durable run']);
    const actions = sortedUnique(actionValues.map((entry, index) => parseActionResult(entry, `S2-D rehearsal result.action_results.${String(index)}`)), (entry) => `${entry.corpus_id}\0${entry.run_id_sha256}\0${entry.action}`, 'S2-D rehearsal result.action_results');
    const grouped = new Map();
    for (const action of actions)
        grouped.set(`${action.corpus_id}\0${action.run_id_sha256}`, [...(grouped.get(`${action.corpus_id}\0${action.run_id_sha256}`) ?? []), action.action].sort(compareCodeUnits));
    for (const [key, values] of grouped)
        if (values.join(',') !== 'attach,dispatch-dry-run,doctor,reconcile')
            throw new S2CorpusContractError('S2-D rehearsal result', [`durable-run action coverage is incomplete for ${key}`]);
    return Object.freeze({ schema_version: S2_CORPUS_REHEARSAL_RESULT_SCHEMA, rehearsal_id: identifier(row['rehearsal_id'], 'S2-D rehearsal result.rehearsal_id'), candidate_build: identifier(row['candidate_build'], 'S2-D rehearsal result.candidate_build'), action_results: actions, live_unchanged: parseLiveUnchanged(row['live_unchanged'], 'S2-D rehearsal result.live_unchanged'), isolation_proofs: parseProofs(row['isolation_proofs'], 'S2-D rehearsal result.isolation_proofs'), new_blockers: Object.freeze(blockers), completed_at: timestamp(row['completed_at'], 'S2-D rehearsal result.completed_at') });
}
