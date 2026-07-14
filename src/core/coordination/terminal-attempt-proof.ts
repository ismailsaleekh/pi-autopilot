import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { parseAutopilotEventRow, parseAutopilotExecutionAudit, parseAutopilotReceipt, parseAutopilotStatusEntry, parseAutopilotUnitSpec } from '../contracts/index.ts';
import type { AutopilotExecutionAudit, AutopilotStatusEntry, AutopilotUnitSpec } from '../contracts/types.ts';
import { assertAutopilotChildTerminalAcceptanceChain, autopilotAuditProvesZeroSourceChange, parseAutopilotChildTerminalAcceptance } from './terminal-acceptance.ts';
import type { CoordinationChildLease, CoordinationEvidenceRef } from './types.ts';

const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface TrustedTerminalArtifact {
  readonly ref: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: `sha256:${string}`;
}

export interface TrustedTerminalAttemptProof {
  readonly spec: AutopilotUnitSpec;
  readonly status: AutopilotStatusEntry;
  readonly audit: AutopilotExecutionAudit;
  readonly terminalEvidence: TrustedTerminalArtifact;
  readonly receipt: TrustedTerminalArtifact;
  readonly artifacts: readonly TrustedTerminalArtifact[];
  readonly sourceChanging: boolean;
  readonly cleanZeroChange: boolean;
  readonly mechanicalProof: readonly string[];
}

export type TrustedTerminalAttemptProofResult =
  | { readonly proven: true; readonly proof: TrustedTerminalAttemptProof }
  | { readonly proven: false; readonly reason: string; readonly inspectedPaths: readonly string[] };

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function json(bytes: Uint8Array, label: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function artifact(authorityRoot: string, path: string, label: string): TrustedTerminalArtifact {
  const lexicalPath = resolve(path);
  const lexical = relative(resolve(authorityRoot), lexicalPath);
  if (lexical.length === 0 || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error(`${label} escapes the run main worktree`);
  const root = realpathSync(authorityRoot);
  const before = lstatSync(lexicalPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARTIFACT_BYTES) throw new Error(`${label} must be a bounded regular non-symbolic file`);
  const physical = relative(root, realpathSync(lexicalPath));
  if (physical.length === 0 || physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new Error(`${label} physically escapes the run main worktree`);
  const descriptor = openSync(lexicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error(`${label} identity changed while opening`);
    const bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(lexicalPath);
    if (bytes.byteLength !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size || afterDescriptor.mtimeMs !== opened.mtimeMs || afterDescriptor.ctimeMs !== opened.ctimeMs || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs || afterPath.ctimeMs !== opened.ctimeMs) throw new Error(`${label} identity changed during read`);
    return Object.freeze({ ref: lexical.split(sep).join('/'), path: lexicalPath, bytes, sha256: digest(bytes) });
  } finally {
    closeSync(descriptor);
  }
}

function underRoot(root: string, path: string, label: string): string {
  const absolute = resolve(path);
  const rel = relative(resolve(root), absolute);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the run main worktree`);
  return absolute;
}

function unproven(reason: string, inspectedPaths: readonly string[]): TrustedTerminalAttemptProofResult {
  return { proven: false, reason, inspectedPaths: Object.freeze([...new Set(inspectedPaths)].sort()) };
}

export function proveStructuredAttemptTerminal(input: {
  readonly mainWorktreePath: string;
  readonly runtimeRoot: string;
  readonly repoId: string;
  readonly autopilotId: string;
  readonly workstream: string;
  readonly workstreamRun: string;
  readonly unitId: string;
  readonly attempt: number;
  readonly childLeaseId: string;
  readonly spec: CoordinationEvidenceRef;
}): TrustedTerminalAttemptProofResult {
  const inspectedPaths: string[] = [];
  try {
    const specPath = underRoot(input.mainWorktreePath, resolve(input.mainWorktreePath, input.spec.ref), 'unit spec ref');
    inspectedPaths.push(specPath);
    const specArtifact = artifact(input.mainWorktreePath, specPath, 'unit spec');
    if (specArtifact.sha256 !== input.spec.sha256) return unproven('unit spec hash differs from the coordinator attempt identity', inspectedPaths);
    const spec = parseAutopilotUnitSpec(json(specArtifact.bytes, 'unit spec'));
    if (spec.workstream !== input.workstream || spec.unit_id !== input.unitId || spec.attempt !== input.attempt) return unproven('unit spec identity differs from the durable attempt', inspectedPaths);
    const statusPath = underRoot(input.mainWorktreePath, spec.status_output, 'status output');
    const receiptPath = underRoot(input.mainWorktreePath, spec.receipt_output, 'receipt output');
    const auditPath = underRoot(input.mainWorktreePath, resolve(input.runtimeRoot, 'execution-audits', `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`), 'execution audit');
    inspectedPaths.push(statusPath, receiptPath, auditPath);
    const auditArtifact = artifact(input.mainWorktreePath, auditPath, 'execution audit');
    const audit = parseAutopilotExecutionAudit(json(auditArtifact.bytes, 'execution audit'));
    const statusArtifact = artifact(input.mainWorktreePath, statusPath, 'status output');
    const status = parseAutopilotStatusEntry(json(statusArtifact.bytes, 'status output'), { unitSpec: spec, artifactRoot: input.runtimeRoot, executionAudit: audit });
    const receiptArtifact = artifact(input.mainWorktreePath, receiptPath, 'receipt output');
    const receipt = parseAutopilotReceipt(json(receiptArtifact.bytes, 'receipt output'), { statusOutputPath: statusPath });
    if (status.workstream !== input.workstream || status.unit_id !== input.unitId || status.role !== spec.role || status.attempt !== input.attempt || audit.workstream !== input.workstream || audit.unit_id !== input.unitId || audit.role !== spec.role || audit.attempt !== input.attempt || receipt.workstream !== input.workstream || receipt.unit_id !== input.unitId || receipt.role !== spec.role || receipt.attempt !== input.attempt) return unproven('status, receipt, audit, and spec identities disagree', inspectedPaths);
    const sourceChanging = spec.role === 'implement' || spec.role === 'fix';
    if (audit.truncated_path_sets.length > 0 || audit.baseline_head === null || audit.post_run_head === null || audit.head_change_kind === 'rewrite' || audit.head_change_kind === 'unavailable' || audit.dirty_baseline !== false) return unproven('execution audit does not completely account for a stable clean-baseline Git transition', inspectedPaths);
    if (!sourceChanging && !autopilotAuditProvesZeroSourceChange(audit)) return unproven('non-source terminal repair requires a mechanically clean zero-source-change audit', inspectedPaths);

    const acceptancePath = underRoot(input.mainWorktreePath, resolve(input.runtimeRoot, 'terminal-acceptances', `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`), 'terminal acceptance');
    let terminalEvidence: TrustedTerminalArtifact;
    let transportProof: string;
    const supportingArtifacts: TrustedTerminalArtifact[] = [];
    if (existsSync(acceptancePath)) {
      inspectedPaths.push(acceptancePath);
      const acceptanceArtifact = artifact(input.mainWorktreePath, acceptancePath, 'terminal acceptance');
      const acceptance = parseAutopilotChildTerminalAcceptance(json(acceptanceArtifact.bytes, 'terminal acceptance'));
      const child: CoordinationChildLease = {
        schema_version: 'autopilot.child_lease.v1', child_lease_id: input.childLeaseId,
        owner: { repo_id: input.repoId, autopilot_id: input.autopilotId, workstream_run: input.workstreamRun, unit_id: input.unitId, attempt: input.attempt },
        pid: 1, boot_id: 'terminal-repair-proof', lease_expires_at: acceptance.created_at, status: 'recovery-required', terminal_evidence: null, version: 1,
      };
      assertAutopilotChildTerminalAcceptanceChain({ acceptance, child, specBytes: specArtifact.bytes, statusBytes: statusArtifact.bytes, receiptBytes: receiptArtifact.bytes, auditBytes: auditArtifact.bytes });
      if (acceptance.spec.ref !== specArtifact.ref || acceptance.status.ref !== statusArtifact.ref || acceptance.receipt.ref !== receiptArtifact.ref || acceptance.audit.ref !== auditArtifact.ref) return unproven('terminal acceptance artifact refs differ from the durable attempt artifact paths', inspectedPaths);
      terminalEvidence = acceptanceArtifact;
      transportProof = `parent-terminal-acceptance:${acceptanceArtifact.sha256}`;
    } else {
      const eventsPath = underRoot(input.mainWorktreePath, resolve(input.runtimeRoot, 'events.jsonl'), 'parent event ledger');
      inspectedPaths.push(eventsPath);
      const eventsArtifact = artifact(input.mainWorktreePath, eventsPath, 'parent event ledger');
      const statusRef = relative(resolve(input.runtimeRoot), statusPath).split(sep).join('/');
      const receiptRef = relative(resolve(input.runtimeRoot), receiptPath).split(sep).join('/');
      const matching = new TextDecoder('utf-8', { fatal: true }).decode(eventsArtifact.bytes).split(/\r?\n/u).filter((line) => line.length > 0).map((line) => parseAutopilotEventRow(JSON.parse(line) as unknown)).filter((event) => event.event === 'agent_completed' && event.workstream === input.workstream && event.unit_id === input.unitId && event.role === spec.role && event.verdict === status.verdict && event.status_ref === statusRef && event.receipt_ref === receiptRef);
      if (matching.length !== 1) return unproven(`historical terminal repair requires exactly one parent agent_completed carrier-acceptance fact, found ${String(matching.length)}`, inspectedPaths);
      const acceptedEvent = matching[0];
      if (acceptedEvent === undefined || Date.parse(acceptedEvent.ts) < Date.parse(receipt.emitted_at) || Date.parse(acceptedEvent.ts) < Date.parse(audit.audited_at)) return unproven('parent agent_completed fact predates its receipt or audit', inspectedPaths);
      terminalEvidence = receiptArtifact;
      supportingArtifacts.push(eventsArtifact);
      transportProof = `historical-parent-agent-completed:${String(acceptedEvent.id)}:${eventsArtifact.sha256}`;
    }
    const artifacts = Object.freeze([specArtifact, statusArtifact, receiptArtifact, auditArtifact, ...supportingArtifacts, ...(terminalEvidence === receiptArtifact ? [] : [terminalEvidence])]);
    const proof: TrustedTerminalAttemptProof = {
      spec,
      status,
      audit,
      terminalEvidence,
      receipt: receiptArtifact,
      artifacts,
      sourceChanging,
      cleanZeroChange: autopilotAuditProvesZeroSourceChange(audit),
      mechanicalProof: Object.freeze([
        transportProof,
        `terminal-status:${status.verdict}:${statusArtifact.sha256}`,
        `terminal-receipt:${receiptArtifact.sha256}`,
        `execution-audit:${audit.classification}:${auditArtifact.sha256}`,
        `source-changing:${String(sourceChanging)}`,
        `clean-zero-change:${String(autopilotAuditProvesZeroSourceChange(audit))}`,
      ]),
    };
    return { proven: true, proof };
  } catch (error) {
    return unproven(`structured terminal proof invalid: ${error instanceof Error ? error.message : String(error)}`, inspectedPaths);
  }
}
