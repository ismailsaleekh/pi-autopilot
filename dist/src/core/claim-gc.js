import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseAutopilotExecutionAudit, parseAutopilotState, parseAutopilotStatusEntry } from "./contracts/index.js";
import { appendClaimEvent, coordinationRootForRepo, readActiveAutopilots, readPathClaims, readUnitIndex, resolveAutopilotStateRoot, resolveRepoIdentity, taskRootForActiveAutopilot, withAutopilotFileLock, writeJsonAtomic, writePathClaims } from "./parallel-runtime.js";
import { coordinationCutoverCommitted } from "./coordination/migration-paths.js";
import { runLegacyCoordinationPreflight } from "./coordination/legacy-preflight.js";
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
    if (coordinationCutoverCommitted(resolveAutopilotStateRoot(env), repo.repoKey))
        fail('legacy-authority-archived', 'claim GC is disabled after coordination cutover; coordinator reconciliation is authoritative.');
    if (!input.apply) {
        await withAutopilotFileLock(join(coordinationRoot, '.locks', 'activation.lock'), `claim-gc-preflight-active:${repo.repoKey}`, async () => {
            await withAutopilotFileLock(join(coordinationRoot, '.locks', 'path-claims.lock'), `claim-gc-preflight-claims:${repo.repoKey}`, async () => {
                await runLegacyCoordinationPreflight({
                    coordinationRoot,
                    repoKey: repo.repoKey,
                    mode: 'claim-gc-dry-run',
                    now,
                });
            });
        });
    }
    const rows = await readActiveAutopilots(coordinationRoot);
    const evaluate = async () => {
        const claims = await readPathClaims(coordinationRoot);
        const candidates = await classifyClaimGcCandidates(rows, claims);
        const releasable = candidates.filter((candidate) => candidate.stale && candidate.blockers.length === 0).map((candidate) => candidate.claim);
        const releasedLabels = [];
        if (input.apply && releasable.length > 0) {
            const releaseKeys = new Set(releasable.map(claimKey));
            const remaining = claims.filter((claim) => !releaseKeys.has(claimKey(claim)));
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
        return { candidates, releasedLabels };
    };
    const evaluation = input.apply
        ? await withAutopilotFileLock(join(coordinationRoot, '.locks', 'path-claims.lock'), `claim-gc:${repo.repoKey}`, evaluate)
        : await evaluate();
    const resultWithoutPath = {
        schema_version: 'autopilot.claim_gc.v1',
        mode: input.apply ? 'apply' : 'dry-run',
        repo_key: repo.repoKey,
        released_claims: [...evaluation.releasedLabels],
        candidates: [...evaluation.candidates],
        evidence_path: null,
        created_at: now.toISOString(),
    };
    const evidenceRoot = join(coordinationRoot, 'claim-gc');
    await mkdir(evidenceRoot, { recursive: true });
    const evidencePath = join(evidenceRoot, `${timestamp(now)}.${input.apply ? 'apply' : 'dry-run'}.json`);
    const result = { ...resultWithoutPath, evidence_path: evidencePath };
    await writeJsonAtomic(evidencePath, result);
    return result;
}
async function classifyClaimGcCandidates(rows, claims) {
    const candidates = [];
    const fallbackProofs = new Map();
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
        if (unit !== undefined) {
            if (unit.status === 'merged' || unit.status === 'aborted' || unit.status === 'quarantined' || unit.status === 'superseded') {
                candidates.push({ claim, stale: true, proof: [`unit attempt status is ${unit.status}`, `archive_ref=${unit.archive_ref ?? 'none'}`], blockers: [] });
                continue;
            }
            candidates.push({ claim, stale: false, proof: [], blockers: [`unit attempt status is live: ${unit.status}`] });
            continue;
        }
        if (claim.claim_type !== 'READ') {
            candidates.push({ claim, stale: false, proof: [], blockers: ['unit attempt metadata missing; runtime terminal fallback applies only to READ claims'] });
            continue;
        }
        const fallbackKey = `${row.autopilot_id}\0${row.workstream_run}\0${claim.workstream}\0${claim.unit_id}\0${String(claim.attempt)}`;
        let fallback = fallbackProofs.get(fallbackKey);
        if (fallback === undefined) {
            fallback = await proveRuntimeTerminalReadClaim(row, claim);
            fallbackProofs.set(fallbackKey, fallback);
        }
        candidates.push({ claim, stale: fallback.stale, proof: fallback.proof, blockers: fallback.blockers });
    }
    return Object.freeze(candidates);
}
async function proveRuntimeTerminalReadClaim(row, claim) {
    const statePath = join(row.runtime_root, 'state.json');
    if (!existsSync(statePath)) {
        return blockedRuntimeProof('unit attempt metadata missing and runtime state.json is absent');
    }
    try {
        const state = parseAutopilotState(await readJsonFile(statePath));
        if (claim.workstream !== row.workstream || state.workstream !== row.workstream) {
            return blockedRuntimeProof('runtime terminal proof workstream identity mismatch');
        }
        const stateUnit = state.units[claim.unit_id];
        if (stateUnit === undefined) {
            return blockedRuntimeProof(`runtime state lacks unit ${claim.unit_id}`);
        }
        if (stateUnit.attempt !== claim.attempt) {
            return blockedRuntimeProof(`runtime state unit attempt is ${String(stateUnit.attempt)}, claim attempt is ${String(claim.attempt)}`);
        }
        if (stateUnit.state === 'running' || state.running.includes(claim.unit_id)) {
            return blockedRuntimeProof('runtime state marks unit attempt live: running');
        }
        if (stateUnit.state !== 'completed') {
            return blockedRuntimeProof(`runtime state unit is not completed: ${stateUnit.state}`);
        }
        if (!state.completed.includes(claim.unit_id)) {
            return blockedRuntimeProof('runtime state completed unit is absent from completed queue');
        }
        if (stateUnit.status_ref === undefined) {
            return blockedRuntimeProof('runtime completed unit lacks status_ref');
        }
        const auditRef = `execution-audits/${stateUnit.unit_id}.${stateUnit.role}.attempt-${String(stateUnit.attempt)}.json`;
        const auditPath = resolveRuntimeRef(row.runtime_root, auditRef, 'execution audit ref');
        const audit = parseAutopilotExecutionAudit(await readJsonFile(auditPath));
        if (audit.workstream !== state.workstream ||
            audit.unit_id !== stateUnit.unit_id ||
            audit.role !== stateUnit.role ||
            audit.attempt !== stateUnit.attempt) {
            return blockedRuntimeProof('runtime execution audit identity does not match completed state unit');
        }
        const statusPath = resolveRuntimeRef(row.runtime_root, stateUnit.status_ref, 'status_ref');
        const status = parseAutopilotStatusEntry(await readJsonFile(statusPath), {
            artifactRoot: row.runtime_root,
            executionAudit: audit,
        });
        if (status.workstream !== state.workstream ||
            status.unit_id !== stateUnit.unit_id ||
            status.role !== stateUnit.role ||
            status.attempt !== stateUnit.attempt) {
            return blockedRuntimeProof('runtime status identity does not match completed state unit');
        }
        if (status.verdict !== 'DONE' && status.verdict !== 'PASS') {
            return blockedRuntimeProof(`runtime completed unit status is not successful: ${status.verdict}`);
        }
        return {
            stale: true,
            proof: [
                'unit attempt metadata missing; using validated runtime terminal proof',
                `state unit status is ${stateUnit.state}`,
                `status_ref=${stateUnit.status_ref} verdict=${status.verdict}`,
                `audit_ref=${auditRef} classification=${audit.classification}`,
            ],
            blockers: [],
        };
    }
    catch (error) {
        return blockedRuntimeProof(`runtime terminal proof invalid: ${errorMessage(error)}`);
    }
}
function blockedRuntimeProof(blocker) {
    return { stale: false, proof: [], blockers: [blocker] };
}
async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        throw new Error(`failed to read ${path}: ${errorMessage(error)}`);
    }
}
function resolveRuntimeRef(runtimeRoot, ref, label) {
    const resolvedRoot = resolve(runtimeRoot);
    const resolved = resolve(resolvedRoot, ref);
    const rel = relative(resolvedRoot, resolved);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
        throw new Error(`${label} ${ref} escapes runtime root`);
    }
    return resolved;
}
function claimKey(claim) {
    return `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
}
function timestamp(now) {
    return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
