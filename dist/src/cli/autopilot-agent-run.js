#!/usr/bin/env node
import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from "../core/agent-runner.js";
const EXIT_BY_FAILURE_CLASS = Object.freeze({
    'spec-invalid': 2,
    'pi-spawn-failed': 10,
    'missing-structured-output': 20,
    'invalid-structured-output': 21,
    'status-non-success': 30,
});
async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== 'autopilot-agent-run help')
            console.error(message);
        console.log(usage().trimEnd());
        return message === 'autopilot-agent-run help' ? 0 : 2;
    }
    try {
        const result = await runAutopilotAgentFromSpecPath(args.specPath, {
            dryRun: args.dryRun,
            ...(args.piExecutable === undefined ? {} : { piExecutable: args.piExecutable }),
        });
        if (args.json) {
            console.log(JSON.stringify({
                status: result.status,
                unit_id: result.spec.unit_id,
                role: result.spec.role,
                verdict: result.statusEntry?.verdict ?? null,
                status_output: result.statusOutput,
                receipt_output: result.receiptOutput,
                prompt_snapshot: result.promptSnapshotPath,
                context_path: result.contextPath,
                summary: result.summary,
            }));
        }
        else {
            console.log(`autopilot-agent-run ${result.status} unit=${result.spec.unit_id} role=${result.spec.role} ` +
                `status=${result.statusOutput} summary=${result.summary}`);
        }
        return 0;
    }
    catch (error) {
        if (error instanceof AutopilotAgentRunError) {
            const payload = {
                status: 'failed',
                failure_class: error.failureClass,
                reason: error.details.reason,
                status_output: error.details.statusOutput,
                receipt_output: error.details.receiptOutput,
                prompt_snapshot: error.details.promptSnapshotPath,
            };
            if (args.json) {
                console.error(JSON.stringify(payload));
            }
            else {
                console.error(`autopilot-agent-run failed class=${error.failureClass} reason=${error.details.reason}`);
            }
            return EXIT_BY_FAILURE_CLASS[error.failureClass];
        }
        console.error(`autopilot-agent-run failed unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return 1;
    }
}
function parseArgs(argv) {
    let dryRun = false;
    let json = false;
    let piExecutable;
    const positional = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined)
            continue;
        if (arg === '--dry-run') {
            dryRun = true;
        }
        else if (arg === '--json') {
            json = true;
        }
        else if (arg === '--pi-executable') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--'))
                throw new Error('--pi-executable requires a value');
            piExecutable = value;
            index += 1;
        }
        else if (arg === '--help' || arg === '-h') {
            throw new Error('autopilot-agent-run help');
        }
        else if (arg.startsWith('--')) {
            throw new Error(`unknown option ${arg}`);
        }
        else {
            positional.push(arg);
        }
    }
    if (positional.length !== 1) {
        throw new Error(`expected exactly one <unit-spec.json>, got ${String(positional.length)}`);
    }
    const specPath = positional[0];
    if (specPath === undefined)
        throw new Error('expected <unit-spec.json>');
    return { specPath, dryRun, json, ...(piExecutable === undefined ? {} : { piExecutable }) };
}
function usage() {
    return 'usage: autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>\n';
}
const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
