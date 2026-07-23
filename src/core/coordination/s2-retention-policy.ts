export type S2RetentionGcKind = 'trash' | 'transition-backup';
export type S2RetentionTerminalKind = 'closed' | 'aborted' | 'failed';
export type S2RetentionRefusalReason =
  | 'active-run'
  | 'ambiguous-owner'
  | 'cold-archive-unverified'
  | 'dirty-path'
  | 'foreign-owner'
  | 'hardlink-detected'
  | 'invalid-candidate-id'
  | 'malformed-owned-marker'
  | 'missing-owned-marker'
  | 'missing-without-ledger'
  | 'path-escape'
  | 'path-not-owned-directory'
  | 'policy-mismatch'
  | 'quarantined-path'
  | 'sole-copy-pin'
  | 'symlink-detected'
  | 'unexpected-kind';

export interface S2RetentionPolicy {
  readonly schema_version: 'autopilot.s2_retention_policy.v1';
  readonly policy_id: string;
  readonly cold_terminal_proof_max_bytes: number;
  readonly hot_terminal_summary_max_bytes: number;
  readonly gc_batch_limit: number;
  readonly allow_transition_backup_gc: boolean;
}

export const S2_RETENTION_OWNER_MARKER = '.s2-retention-owner.json';
export const S2_RETENTION_DIRTY_MARKER = '.s2-retention-dirty';
export const S2_RETENTION_QUARANTINE_MARKER = '.s2-retention-quarantined';
export const S2_RETENTION_ACTIVE_MARKER = '.s2-retention-active';
export const S2_RETENTION_SOLE_COPY_PIN = '.s2-retention-sole-copy-pin';
export const S2_RETENTION_LEDGER_FILE = '_retention-ledger.ndjson';
export const S2_RETENTION_TRASH_DIR = '_trash';
export const S2_RETENTION_INFLIGHT_DIR = '_gc-inflight';
export const S2_RETENTION_TRANSITION_BACKUP_DIR = 'transition-backups';

const DEFAULT_POLICY: S2RetentionPolicy = Object.freeze({
  schema_version: 'autopilot.s2_retention_policy.v1',
  policy_id: 'autopilot-s2-e-retention-v1',
  cold_terminal_proof_max_bytes: 1_048_576,
  hot_terminal_summary_max_bytes: 2_048,
  gc_batch_limit: 64,
  allow_transition_backup_gc: true,
});

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

function assertPolicyId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) throw new Error('retention policy_id must be a stable lowercase identifier');
}

export function s2DefaultRetentionPolicy(): S2RetentionPolicy {
  return DEFAULT_POLICY;
}

export function defineS2RetentionPolicy(input: Partial<Omit<S2RetentionPolicy, 'schema_version'>> = {}): S2RetentionPolicy {
  const policy: S2RetentionPolicy = {
    schema_version: 'autopilot.s2_retention_policy.v1',
    policy_id: input.policy_id ?? DEFAULT_POLICY.policy_id,
    cold_terminal_proof_max_bytes: input.cold_terminal_proof_max_bytes ?? DEFAULT_POLICY.cold_terminal_proof_max_bytes,
    hot_terminal_summary_max_bytes: input.hot_terminal_summary_max_bytes ?? DEFAULT_POLICY.hot_terminal_summary_max_bytes,
    gc_batch_limit: input.gc_batch_limit ?? DEFAULT_POLICY.gc_batch_limit,
    allow_transition_backup_gc: input.allow_transition_backup_gc ?? DEFAULT_POLICY.allow_transition_backup_gc,
  };
  assertPolicyId(policy.policy_id);
  assertPositiveSafeInteger(policy.cold_terminal_proof_max_bytes, 'cold_terminal_proof_max_bytes');
  assertPositiveSafeInteger(policy.hot_terminal_summary_max_bytes, 'hot_terminal_summary_max_bytes');
  assertPositiveSafeInteger(policy.gc_batch_limit, 'gc_batch_limit');
  if (policy.hot_terminal_summary_max_bytes >= policy.cold_terminal_proof_max_bytes) throw new Error('hot_terminal_summary_max_bytes must stay below cold_terminal_proof_max_bytes');
  return Object.freeze(policy);
}

export function isS2RetentionCandidateId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(value);
}
