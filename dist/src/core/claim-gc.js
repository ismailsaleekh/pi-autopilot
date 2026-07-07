import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendClaimEvent, coordinationRootForRepo, readActiveAutopilots, readPathClaims, readUnitIndex, resolveRepoIdentity, taskRootForActiveAutopilot, writeJsonAtomic, writePathClaims } from "./parallel-runtime.js";
export class AutopilotClaimGcError extends Error {
    name = 'AutopilotClaimGcError';
    code;
    constructor(code, message) {
        super(`AutopilotClaimGcError [${code}]: ${message}`);
        this.code = code;
    }
}
function fail(code, message) {
    throw new AutopilotClaimGcError(code, message);
}
export async function runAutopilotClaimGc(input) {
    const env = input.env ?? process.env;
    const now = input.now ?? new Date();
    const repo = resolveRepoIdentity(input.sourceCwd);
    const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
    const rows = await readActiveAutopilots(coordinationRoot);
    const claims = await readPathClaims(coordinationRoot);
    const candidates = [];
    for (const claim of claims) {
        const row = rows.find((active) => active.autopilot_id === claim.autopilot_id && active.workstream_run === claim.workstream_run);
        if (row === undefined) {
            candidates.push({ claim, stale: false, proof: [], blockers: ['active Autopilot row missing; refuse to infer stale without archive evidence'] });
            continue;
        }
        if (row.status === 'closed' || row.status === 'crashed') {
            candidates.push({ claim, stale: true, proof: [`active row status is ${row.status}`], blockers: [] });
            continue;
        }
        const taskRoot = taskRootForActiveAutopilot(row);
        if (!existsSync(taskRoot)) {
            candidates.push({ claim, stale: false, proof: [], blockers: [`task root missing while active row is ${row.status}`] });
            continue;
        }
        const index = await readUnitIndex(taskRoot);
        const unit = index.units.find((candidate) => candidate.unit_id === claim.unit_id && candidate.attempt === claim.attempt);
        if (unit === undefined) {
            candidates.push({ claim, stale: false, proof: [], blockers: ['unit attempt metadata missing'] });
            continue;
        }
        if (unit.status === 'merged' || unit.status === 'aborted' || unit.status === 'quarantined' || unit.status === 'superseded') {
            candidates.push({ claim, stale: true, proof: [`unit attempt status is ${unit.status}`, `archive_ref=${unit.archive_ref ?? 'none'}`], blockers: [] });
            continue;
        }
        candidates.push({ claim, stale: false, proof: [], blockers: [`unit attempt status is live: ${unit.status}`] });
    }
    const releasable = candidates.filter((candidate) => candidate.stale && candidate.blockers.length === 0).map((candidate) => candidate.claim);
    let evidencePath = null;
    const releasedLabels = [];
    if (input.apply && releasable.length > 0) {
        const remaining = claims.filter((claim) => !releasable.some((release) => claimKey(claim) === claimKey(release)));
        await writePathClaims(coordinationRoot, remaining);
        for (const claim of releasable) {
            releasedLabels.push(`${claim.claim_type} ${claim.path} ${claim.unit_id} attempt ${String(claim.attempt)}`);
            await appendClaimEvent(coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'release',
                ts: now.toISOString(),
                repo_key: repo.repoKey,
                autopilot_id: claim.autopilot_id,
                workstream: claim.workstream,
                workstream_run: claim.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
                path: claim.path,
                claim_type: claim.claim_type,
                active_run_epoch: claim.active_run_epoch,
                reason: 'autopilot claim gc mechanical stale release',
            });
        }
    }
    if (input.apply && candidates.some((candidate) => candidate.blockers.length > 0 && candidate.stale)) {
        fail('incomplete-stale-proof', 'internal stale proof invariant failed.');
    }
    const resultWithoutPath = {
        schema_version: 'autopilot.claim_gc.v1',
        mode: input.apply ? 'apply' : 'dry-run',
        repo_key: repo.repoKey,
        released_claims: [...releasedLabels],
        candidates: [...candidates],
        evidence_path: null,
        created_at: now.toISOString(),
    };
    const evidenceRoot = join(coordinationRoot, 'claim-gc');
    await mkdir(evidenceRoot, { recursive: true });
    evidencePath = join(evidenceRoot, `${timestamp(now)}.${input.apply ? 'apply' : 'dry-run'}.json`);
    const result = { ...resultWithoutPath, evidence_path: evidencePath };
    await writeJsonAtomic(evidencePath, result);
    return result;
}
function claimKey(claim) {
    return `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.active_run_epoch}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
}
function timestamp(now) {
    return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}
