#!/usr/bin/env node
import { isAbsolute, join, resolve } from 'node:path';
import { CoordinatorClient } from "../core/coordination/client.js";
import { CoordinationRuntimeError } from "../core/coordination/failures.js";
import { migrationRecoveryUsage, runMigrationRecoveryCli } from "./migration-recovery.js";
import { coordinationMigrationUsage, runCoordinationMigration } from "../core/coordination/migration.js";
import { activatePatchBuild, reportPatchActivationReadiness } from "../core/coordination/patch-activation.js";
import { CoordinatorAlreadyRunningError, runCoordinatorUntilSignal } from "../core/coordination/server.js";
import { coordinatorRuntimePaths } from "../core/coordination/runtime-paths.js";
import { COORDINATOR_STARTUP_ATTEMPT_ID_ENV, createCoordinatorStartupAttemptId, createCoordinatorStartupObserver } from "../core/coordination/startup-observation.js";
import { retireSchema11CoordinatorForUpgrade } from "../core/coordination/schema11-retirement.js";
import { stageCoordinatorSemanticReplayFile } from "../core/coordination/store.js";
import { AUTOPILOT_STATE_ROOT_ENV, resolveRepoIdentity } from "../core/parallel-runtime.js";
function usage() {
    return [
        'usage: autopilot-coordinator serve [--state-root <absolute-path>]',
        '       autopilot-coordinator status [--state-root <absolute-path>] [--repo-id <id>] [--run <workstream-run>]',
        '       autopilot-coordinator doctor [--state-root <absolute-path>]',
        '       autopilot-coordinator export [--state-root <absolute-path>] [--output <absolute-path>]',
        '       autopilot-coordinator replay --replay-id <stable-id> --input <absolute-request-jsonl> [--state-root <absolute-path>]',
        '       autopilot-coordinator upgrade-schema11 [--state-root <absolute-path>]',
        '       autopilot-coordinator activate-patch [--state-root <absolute-path>]',
        '       autopilot-coordinator patch-readiness [--state-root <absolute-path>]',
        coordinationMigrationUsage(),
        migrationRecoveryUsage(),
    ].join('\n');
}
function parseArgs(argv) {
    const command = argv[0];
    if (command !== 'serve' && command !== 'status' && command !== 'doctor' && command !== 'export' && command !== 'replay' && command !== 'upgrade-schema11' && command !== 'activate-patch' && command !== 'patch-readiness' && command !== 'migrate' && command !== 'verify' && command !== 'rollback' && command !== 'cutover')
        throw new Error(usage());
    let stateRoot = null;
    let repoId = 'global';
    let repoKey = null;
    let repoRoot = null;
    let workstreamRun = null;
    let outputPath = null;
    let inputPath = null;
    let replayId = null;
    let migrationCommand = command === 'verify' || command === 'rollback' || command === 'cutover' ? command : null;
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        const value = argv[index + 1];
        if (token === '--help' || token === '-h')
            throw new Error(usage());
        if (token === '--dry-run' || token === '--apply') {
            if (command !== 'migrate')
                throw new Error(`${token} is supported only by migrate`);
            if (migrationCommand !== null)
                throw new Error('migrate requires exactly one of --dry-run or --apply');
            migrationCommand = token === '--dry-run' ? 'dry-run' : 'apply';
            continue;
        }
        if (token !== '--state-root' && token !== '--repo-id' && token !== '--repo-key' && token !== '--repo-root' && token !== '--run' && token !== '--output' && token !== '--input' && token !== '--replay-id')
            throw new Error(`unknown option ${String(token)}\n${usage()}`);
        if (value === undefined || value.startsWith('--'))
            throw new Error(`${token} requires a value`);
        if (token === '--state-root')
            stateRoot = value;
        else if (token === '--repo-id')
            repoId = value;
        else if (token === '--repo-key')
            repoKey = value;
        else if (token === '--repo-root')
            repoRoot = value;
        else if (token === '--run')
            workstreamRun = value;
        else if (token === '--output')
            outputPath = value;
        else if (token === '--input')
            inputPath = value;
        else
            replayId = value;
        index += 1;
    }
    if (stateRoot !== null && !isAbsolute(stateRoot))
        throw new Error('--state-root must be absolute');
    if (outputPath !== null && !isAbsolute(outputPath))
        throw new Error('--output must be absolute');
    if (inputPath !== null && !isAbsolute(inputPath))
        throw new Error('--input must be absolute');
    if (repoRoot !== null && !isAbsolute(repoRoot))
        throw new Error('--repo-root must be absolute');
    const isMigration = command === 'migrate' || command === 'verify' || command === 'rollback' || command === 'cutover';
    if (command !== 'status' && (repoId !== 'global' || workstreamRun !== null))
        throw new Error('--repo-id and --run are supported only by status');
    if (command !== 'export' && outputPath !== null)
        throw new Error('--output is supported only by export');
    if (command === 'replay' && (inputPath === null || replayId === null))
        throw new Error('replay requires --input and --replay-id');
    if (command !== 'replay' && (inputPath !== null || replayId !== null))
        throw new Error('--input and --replay-id are supported only by replay');
    if (!isMigration && (repoKey !== null || repoRoot !== null))
        throw new Error('--repo-key and --repo-root are supported only by migration commands');
    if (repoKey !== null && repoRoot !== null)
        throw new Error('migration accepts only one of --repo-key or --repo-root');
    if (isMigration && migrationCommand === null)
        throw new Error(`migration command requires a mode\n${coordinationMigrationUsage()}`);
    return { command, stateRoot, repoId, repoKey, repoRoot, workstreamRun, outputPath, inputPath, replayId, migrationCommand };
}
function environment(args) {
    return args.stateRoot === null ? process.env : { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: resolve(args.stateRoot) };
}
async function main(argv) {
    if (argv[0] === '--help' || argv[0] === '-h') {
        console.log(usage());
        return 0;
    }
    if (argv[0] === 'recovery') {
        try {
            console.log(JSON.stringify(await runMigrationRecoveryCli(argv.slice(1)), null, 2));
            return 0;
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError) {
                console.error(error.message);
                return error.failure_class === 'system-fatal' ? 70 : 1;
            }
            console.error(error instanceof Error ? error.message : String(error));
            return 2;
        }
    }
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
    const env = environment(args);
    let startupObserver = null;
    try {
        if (args.command === 'serve') {
            const paths = coordinatorRuntimePaths(env);
            const configuredAttempt = env[COORDINATOR_STARTUP_ATTEMPT_ID_ENV];
            const attemptId = configuredAttempt === undefined ? createCoordinatorStartupAttemptId() : configuredAttempt;
            startupObserver = await createCoordinatorStartupObserver(paths, attemptId, env);
            await runCoordinatorUntilSignal(paths, startupObserver);
            return 0;
        }
        if (args.migrationCommand !== null) {
            const repoKey = args.repoKey ?? resolveRepoIdentity(args.repoRoot ?? process.cwd()).repoKey;
            const report = await runCoordinationMigration({ command: args.migrationCommand, repoKey, ...(args.repoRoot === null ? {} : { repoRoot: resolve(args.repoRoot) }), env });
            console.log(JSON.stringify(report, null, 2));
            return report.blockers.length === 0 ? 0 : 3;
        }
        if (args.command === 'replay') {
            if (args.inputPath === null || args.replayId === null)
                throw new CoordinationRuntimeError('invalid-request', 'replay input identity is missing');
            const staged = await stageCoordinatorSemanticReplayFile(coordinatorRuntimePaths(env), args.replayId, args.inputPath);
            console.log(JSON.stringify({ schema_version: 'autopilot.coordinator_replay_stage_result.v1', replay_id: args.replayId, ...staged, recovery: 'restart the coordinator to consume the validated inbox atomically' }, null, 2));
            return 0;
        }
        if (args.command === 'upgrade-schema11') {
            console.log(JSON.stringify(await retireSchema11CoordinatorForUpgrade(coordinatorRuntimePaths(env)), null, 2));
            return 0;
        }
        if (args.command === 'activate-patch') {
            console.log(JSON.stringify(await activatePatchBuild(coordinatorRuntimePaths(env)), null, 2));
            return 0;
        }
        if (args.command === 'patch-readiness') {
            console.log(JSON.stringify(await reportPatchActivationReadiness(coordinatorRuntimePaths(env)), null, 2));
            return 0;
        }
        const client = new CoordinatorClient({ env });
        const response = args.command === 'status'
            ? await client.query('status', args.repoId, args.workstreamRun)
            : args.command === 'doctor'
                ? await client.query('doctor')
                : await client.query('export', 'global', null, { output_path: args.outputPath ?? join(client.paths.exportsRoot, 'coordinator-export.json') });
        console.log(JSON.stringify(response.payload, null, 2));
        return 0;
    }
    catch (error) {
        if (error instanceof CoordinatorAlreadyRunningError && args.command === 'serve') {
            await startupObserver?.electionLoser(error);
            console.log(error.message);
            return 0;
        }
        await startupObserver?.failed(error);
        if (error instanceof CoordinationRuntimeError) {
            console.error(error.message);
            return error.failure_class === 'system-fatal' ? 70 : 1;
        }
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        return 1;
    }
}
process.exitCode = await main(process.argv.slice(2));
