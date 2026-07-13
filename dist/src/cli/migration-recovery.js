import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { durableIdentifier } from "../core/coordination/client.js";
import { parseCoordinationMigrationRecoveryWork } from "../core/coordination/contracts.js";
import { CoordinationRuntimeError } from "../core/coordination/failures.js";
import { coordinationMigrationCoordinatorRunning, retireCoordinationMigrationCoordinator } from "../core/coordination/migration.js";
import { coordinatorRuntimePaths } from "../core/coordination/runtime-paths.js";
import { DurableRunSupervisorClient, readMigrationRecoveryEvidenceFile } from "../core/coordination/supervisor.js";
import { AUTOPILOT_STATE_ROOT_ENV, resolveRepoIdentity } from "../core/parallel-runtime.js";
export function migrationRecoveryUsage() {
    return [
        '       autopilot-coordinator recovery list --repo-root <absolute-path> [--run <run>] [--state-root <absolute-path>]',
        '       autopilot-coordinator recovery show --repo-root <absolute-path> --recovery-id <id> [--run <run>] [--state-root <absolute-path>]',
        '       autopilot-coordinator recovery doctor --repo-root <absolute-path> [--run <run>] [--state-root <absolute-path>]',
        '       autopilot-coordinator recovery retain-authority --repo-root <absolute-path> --run <run> (--recovery-id <id>|--all) [--state-root <absolute-path>]',
        '       autopilot-coordinator recovery release-with-evidence --repo-root <absolute-path> --run <run> --recovery-id <id> --source <unit-merge|attempt-reset|quarantine-capture|run-close|run-abort> --target-id <id> --evidence <absolute-json-path> [--state-root <absolute-path>]',
    ].join('\n');
}
function source(value) {
    const allowed = ['unit-merge', 'attempt-reset', 'quarantine-capture', 'run-close', 'run-abort'];
    if (!allowed.includes(value))
        throw new Error(`--source must be one of ${allowed.join(', ')}`);
    return value;
}
function parse(argv) {
    const raw = argv[0];
    const command = raw === 'retain' ? 'retain-authority' : raw === 'release' ? 'release-with-evidence' : raw;
    if (command !== 'list' && command !== 'show' && command !== 'doctor' && command !== 'retain-authority' && command !== 'release-with-evidence')
        throw new Error(migrationRecoveryUsage());
    let stateRoot = null, repoRoot = null, run = null, recoveryId = null, releaseSource = null, targetId = null, evidence = null, all = false;
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--all') {
            all = true;
            continue;
        }
        const value = argv[index + 1];
        if (!['--state-root', '--repo-root', '--run', '--recovery-id', '--source', '--target-id', '--evidence'].includes(token ?? ''))
            throw new Error(`unknown recovery option ${String(token)}\n${migrationRecoveryUsage()}`);
        if (value === undefined || value.startsWith('--'))
            throw new Error(`${String(token)} requires a value`);
        if (token === '--state-root')
            stateRoot = value;
        else if (token === '--repo-root')
            repoRoot = value;
        else if (token === '--run')
            run = value;
        else if (token === '--recovery-id')
            recoveryId = value;
        else if (token === '--source')
            releaseSource = source(value);
        else if (token === '--target-id')
            targetId = value;
        else
            evidence = value;
        index += 1;
    }
    if (repoRoot === null || !isAbsolute(repoRoot))
        throw new Error('recovery requires an absolute --repo-root');
    if (stateRoot !== null && !isAbsolute(stateRoot))
        throw new Error('--state-root must be absolute');
    if (evidence !== null && !isAbsolute(evidence))
        throw new Error('--evidence must be absolute');
    if ((command === 'show' || command === 'retain-authority' || command === 'release-with-evidence') && recoveryId === null && !all)
        throw new Error(`${command} requires --recovery-id${command === 'retain-authority' ? ' or --all' : ''}`);
    if ((command === 'retain-authority' || command === 'release-with-evidence') && run === null)
        throw new Error(`${command} requires --run`);
    if (recoveryId !== null && all)
        throw new Error('--recovery-id and --all are mutually exclusive');
    if (all && command !== 'retain-authority')
        throw new Error('--all is supported only by retain-authority');
    if (command === 'release-with-evidence' && (releaseSource === null || targetId === null || evidence === null))
        throw new Error('release-with-evidence requires --source, --target-id, and --evidence');
    if (command !== 'release-with-evidence' && (releaseSource !== null || targetId !== null || evidence !== null))
        throw new Error('--source, --target-id, and --evidence are supported only by release-with-evidence');
    return { command, stateRoot, repoRoot: resolve(repoRoot), run, recoveryId, all, source: releaseSource, targetId, evidence };
}
function rows(payload) {
    const value = payload['migration_recovery_work'];
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator status omitted migration recovery work');
    return Object.freeze(value.map(parseCoordinationMigrationRecoveryWork));
}
async function detach(supervisor, attachment) {
    await supervisor.client.mutate('detach-session', {
        repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id,
        fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version,
        idempotencyKey: durableIdentifier('detach-migration-recovery', attachment.session.session_lease_id),
    }, { reason: 'migration recovery CLI completed', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    await rm(attachment.contextPath, { force: true });
}
function replayed(work, command, evidenceBytes, releaseSource, targetId) {
    const resolution = work.resolution;
    if (work.status !== 'resolved' || resolution === null)
        return false;
    if (command === 'retain-authority')
        return resolution.resolution_type === 'authority-retained';
    if (command !== 'release-with-evidence' || evidenceBytes === null)
        return false;
    const sha = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
    return resolution.resolution_type === 'authority-released' && resolution.release_source === releaseSource && resolution.release_target_id === targetId && resolution.evidence.sha256 === sha;
}
async function executeMigrationRecoveryCli(argv, baseEnv) {
    const args = parse(argv);
    const env = args.stateRoot === null ? baseEnv : { ...baseEnv, [AUTOPILOT_STATE_ROOT_ENV]: args.stateRoot };
    const repo = resolveRepoIdentity(args.repoRoot);
    const supervisor = new DurableRunSupervisorClient(env, { allowMigrationRecoveryAutoStart: true });
    const status = await supervisor.client.query('status', repo.repoKey, args.run);
    const allRows = rows(status.payload);
    const pending = allRows.filter((work) => work.status === 'pending');
    if (args.command === 'list')
        return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'list', repo_key: repo.repoKey, run: args.run, pending_count: pending.length, recovery: pending };
    if (args.command === 'doctor') {
        const doctor = await supervisor.client.query('doctor');
        return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'doctor', repo_key: repo.repoKey, run: args.run, pending_count: pending.length, healthy: doctor.payload['healthy'], doctor: doctor.payload };
    }
    if (args.command === 'show') {
        const exact = allRows.filter((work) => work.recovery_id === args.recoveryId);
        if (exact.length !== 1)
            throw new CoordinationRuntimeError('invalid-state', 'recovery show requires exactly one matching row', [String(args.recoveryId)]);
        return { schema_version: 'autopilot.migration_recovery_cli.v1', action: 'show', repo_key: repo.repoKey, recovery: exact[0] };
    }
    const evidenceBytes = args.evidence === null ? null : readMigrationRecoveryEvidenceFile(args.evidence);
    const targets = args.all ? pending : allRows.filter((work) => work.recovery_id === args.recoveryId);
    if (targets.length === 0)
        throw new CoordinationRuntimeError('invalid-state', 'no matching migration recovery work', [String(args.recoveryId ?? args.run)]);
    if (targets.some((work) => work.workstream_run !== args.run))
        throw new CoordinationRuntimeError('invalid-request', 'recovery work does not belong to --run');
    const already = targets.filter((work) => replayed(work, args.command, evidenceBytes, args.source, args.targetId));
    const unresolved = targets.filter((work) => work.status === 'pending');
    if (already.length + unresolved.length !== targets.length)
        throw new CoordinationRuntimeError('invalid-state', 'existing recovery resolution conflicts with requested outcome');
    if (unresolved.length === 0)
        return { schema_version: 'autopilot.migration_recovery_cli.v1', action: args.command, replayed: true, resolved_count: already.length, remaining_recovery_count: pending.length };
    const first = unresolved[0];
    if (first === undefined || args.run === null)
        throw new CoordinationRuntimeError('invalid-state', 'recovery target disappeared');
    const attachment = await supervisor.attachMigrationRecovery({ repo, workstreamRun: args.run, recoveryId: first.recovery_id, rawSessionId: `recovery-cli-${process.pid}-${randomUUID()}` });
    let primary = null;
    const results = [];
    try {
        for (const work of unresolved)
            results.push(await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: work, resolution: args.command === 'retain-authority' ? { resolutionType: 'authority-retained' } : { resolutionType: 'authority-released', releaseSource: args.source, releaseTargetId: args.targetId, evidenceBytes: evidenceBytes } }));
    }
    catch (error) {
        primary = error;
    }
    try {
        await detach(supervisor, attachment);
    }
    catch (error) {
        primary = primary === null ? error : new AggregateError([primary, error], 'recovery mutation and fenced detach both failed');
    }
    if (primary !== null)
        throw primary;
    const last = results.at(-1);
    return { schema_version: 'autopilot.migration_recovery_cli.v1', action: args.command, replayed: false, resolved_count: results.length, outcome: args.command === 'retain-authority' ? 'authority-retained' : 'authority-released', remaining_recovery_count: last?.remainingRecoveryWork.length ?? pending.length };
}
export async function runMigrationRecoveryCli(argv, baseEnv = process.env) {
    const args = parse(argv);
    const env = args.stateRoot === null ? baseEnv : { ...baseEnv, [AUTOPILOT_STATE_ROOT_ENV]: args.stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const coordinatorWasRunning = coordinationMigrationCoordinatorRunning(paths);
    try {
        return await executeMigrationRecoveryCli(argv, baseEnv);
    }
    finally {
        if (!coordinatorWasRunning && coordinationMigrationCoordinatorRunning(paths)) {
            const blockers = await retireCoordinationMigrationCoordinator(paths);
            if (blockers.length > 0)
                throw new CoordinationRuntimeError('invalid-state', 'recovery CLI could not retire its temporary frozen coordinator', blockers);
        }
    }
}
