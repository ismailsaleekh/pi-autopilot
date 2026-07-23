#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { canonicalJson } from "../../src/core/coordination/canonical-json.js";
import { buildMutableClone, preflightCloneRequest, writeRehearsalResult } from "./release-gate.js";
import { parseCorpusCloneManifest, parseCorpusCloneRequest, parseCorpusRehearsalResult } from "./contracts.js";
import { readRegularFileNoFollow } from "./inventory.js";
function usage() {
    throw new Error('usage: autopilot-s2-corpus-rehearsal status | request <private-request.json> | clone <private-request.json> | rehearse <private-request.json> | manifest <private-manifest.json> | result <private-result.json>');
}
async function privateJson(path, requirePrivateMode) {
    const input = readRegularFileNoFollow(path, 64 * 1024 * 1024);
    if (input.size_bytes < 2 || input.identity.link_count !== 1)
        throw new Error('S2-D private input must be a bounded single-link regular file');
    if (requirePrivateMode && process.platform !== 'win32' && (input.mode & 0o077) !== 0)
        throw new Error('S2-D private request/result permissions must be 0600 or stricter');
    let value;
    try {
        value = JSON.parse(Buffer.from(input.bytes).toString('utf8'));
    }
    catch {
        throw new Error('S2-D private input is not JSON');
    }
    return Object.freeze({ bytes: input.bytes, value });
}
function sha(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function summary(kind, rehearsalId, bytes) {
    return Object.freeze({ schema_version: 'autopilot.s2_d_corpus_contract_validation.v1', kind, rehearsal_id: rehearsalId, input_sha256: sha(bytes), valid: true });
}
async function main(args) {
    const command = args[0];
    if (command === 'status') {
        const resultPath = process.env['S2_D_REHEARSAL_RESULT'];
        if (resultPath === undefined || resultPath.length === 0) {
            const status = { schema_version: 'autopilot.s2_d_corpus_gate_status.v1', status: 'not_run', reason: 'private_rehearsal_result_unavailable' };
            process.stdout.write(`${canonicalJson(status)}\n`);
            process.exitCode = 2;
            return;
        }
        const parsed = await privateJson(resultPath, true);
        const result = parseCorpusRehearsalResult(parsed.value);
        process.stdout.write(`${canonicalJson({ schema_version: 'autopilot.s2_d_corpus_gate_status.v1', status: 'certified', rehearsal_id: result.rehearsal_id, candidate_build: result.candidate_build, result_sha256: sha(parsed.bytes), durable_run_action_count: result.action_results.length })}\n`);
        return;
    }
    const path = args[1];
    if (args.length !== 2 || path === undefined)
        usage();
    const parsed = await privateJson(path, command === 'request' || command === 'clone' || command === 'rehearse' || command === 'result');
    if (command === 'request') {
        const request = await preflightCloneRequest(parseCorpusCloneRequest(parsed.value));
        process.stdout.write(`${canonicalJson(summary('request', request.rehearsal_id, parsed.bytes))}\n`);
        return;
    }
    if (command === 'clone' || command === 'rehearse') {
        const clone = await buildMutableClone(parseCorpusCloneRequest(parsed.value));
        if (command === 'clone') {
            process.stdout.write(`${canonicalJson({ schema_version: 'autopilot.s2_d_corpus_clone_build.v1', rehearsal_id: clone.manifest.rehearsal_id, manifest_sha256: sha(canonicalJson(clone.manifest)), isolation_passed: Object.values(clone.manifest.isolation_proofs).every((proof) => proof.passed), durable_run_count: clone.manifest.durable_runs.length })}\n`);
            return;
        }
        const result = await writeRehearsalResult(clone);
        process.stdout.write(`${canonicalJson(summary('result', result.rehearsal_id, Buffer.from(canonicalJson(result), 'utf8')))}\n`);
        return;
    }
    if (command === 'manifest') {
        const manifest = parseCorpusCloneManifest(parsed.value);
        process.stdout.write(`${canonicalJson(summary('manifest', manifest.rehearsal_id, parsed.bytes))}\n`);
        return;
    }
    if (command === 'result') {
        const result = parseCorpusRehearsalResult(parsed.value);
        process.stdout.write(`${canonicalJson(summary('result', result.rehearsal_id, parsed.bytes))}\n`);
        return;
    }
    usage();
}
await main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`S2-D corpus rehearsal failed: ${message}\n`);
    process.exitCode = 1;
});
