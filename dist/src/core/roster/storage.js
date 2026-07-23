import { timingSafeEqual, createHash } from 'node:crypto';
import { assertRosterSha256, assertValidRepoId, assertValidRosterId, assertValidRosterRevision, assertValidWorkstreamRun, formatAuthorityPath, preRunSelectionPath, resolveRosterScopePaths, rosterRevisionPath, } from "./paths.js";
import { acquireRosterWriterLock, publishCreateOnlyAtomic, publishReplaceAtomic, readAuthorityFileIfPresent, RosterStorageError, } from "./transaction.js";
export { RosterStorageError, assertRosterStorageNodeGuarantees } from "./transaction.js";
export { DEFAULT_USER_STATE_ROOT_DISPLAY, defaultUserStateRoot, formatAuthorityPath, preRunSelectionPath, resolveRosterScopePaths, rosterRevisionPath, } from "./paths.js";
const STORAGE_CODES = new Set([
    'ROSTER_AUTH_REQUIRED',
    'ROSTER_AUTH_CHANNEL_FORBIDDEN',
    'ROSTER_ROUTE_FORBIDDEN',
    'ROSTER_PROJECT_UNTRUSTED',
    'ROSTER_PROPOSAL_REJECTED',
    'ROSTER_APPROVAL_STALE_CANDIDATE_SET',
    'ROSTER_APPROVAL_STALE_CONFIG',
    'ROSTER_PRIORITY_PROOF_REQUIRED',
    'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING',
    'ROSTER_RECEIPT_REPLAY_REQUIRED',
    'ROSTER_CONVERGED_ASSIGNMENT_SET',
    'ROSTER_EXPLICIT_CHOICE_REQUIRED',
    'ROSTER_RECOMMENDED_PROFILE_BLOCKED',
    'ROSTER_TRANSITION_REQUIRED',
    'ROSTER_PINNED_SELECTION_UNAVAILABLE',
    'ROSTER_HISTORICAL_V1_BYTES_PRESERVED',
    'ROSTER_REQUEST_PROFILE_DRIFT',
    'ROSTER_OBSERVED_MODEL_MISMATCH',
    'ROSTER_OBSERVED_THINKING_MISMATCH',
    'ROSTER_QUALIFICATION_REQUIRED',
    'ROSTER_CREATE_ONLY_CONFLICT',
    'ROSTER_SELECTION_IDEMPOTENT_REPLAY',
    'ROSTER_STORAGE_AUTHORITY_UNSAFE',
    'ROSTER_STORAGE_PATH_INVALID',
    'ROSTER_STORAGE_PERMISSION_DENIED',
    'ROSTER_STORAGE_TRUST_REQUIRED',
    'ROSTER_STORAGE_UNSUPPORTED_PLATFORM',
    'ROSTER_CONFIG_CAS_MISMATCH',
    'ROSTER_READBACK_MISMATCH',
    'ROSTER_LOCK_STALE_PROCESS_UNPROVEN',
    'ROSTER_HISTORICAL_PROOF_REQUIRED',
    'ROSTER_HISTORICAL_SELECTION_PRESENT',
    'ROSTER_HISTORICAL_VERSION_UNSUPPORTED',
    'ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH',
    'ROSTER_HISTORICAL_CONFLICTING_EVIDENCE',
]);
export class RosterStorage {
    #codec;
    #stateRoot;
    constructor(options) {
        this.#codec = options.codec;
        this.#stateRoot = options.stateRoot;
    }
    async readDefaultRoster(input) {
        let paths;
        try {
            paths = this.#resolvePaths(input.scope, input.trustedProject);
            const trust = await this.#checkTrustedProject(input.scope, input.trustedProject, 'read');
            if (trust !== null) {
                return readResult(false, 'blocked', [trust], null, null, null);
            }
            const configRead = await readAuthorityFileIfPresent(paths.configPath, paths.authorityRoot);
            if (configRead === null) {
                return readResult(true, 'inspected', [], null, null, null);
            }
            const configHash = await this.#hash(configRead.bytes);
            const config = await this.#decodeConfig(configRead.bytes);
            if (config.config_sha256 !== configHash) {
                return readResult(false, 'failed', [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', 'config bytes do not match config_sha256')], configHash, null, null);
            }
            validateConfigProjection(config, input.scope, paths);
            const defaultRoster = exactDefaultMatch(config);
            if (defaultRoster === null) {
                return readResult(false, 'blocked', [diagnostic('ROSTER_TRANSITION_REQUIRED', 'error', 'config default tuple does not match exactly one saved roster')], configHash, null, config);
            }
            const readback = await this.#readbackConfigRosters(paths, config, configHash);
            if (!readback.ok) {
                return readResult(false, 'failed', readback.diagnostics, configHash, null, config);
            }
            return readResult(true, 'inspected', [], configHash, defaultRoster, config);
        }
        catch (error) {
            return readResult(false, 'failed', [diagnosticFromError(error)], null, null, null);
        }
    }
    async saveApprovedDefault(input) {
        const acc = { writeCount: 0, lockCount: 0, filesTouched: [] };
        let lock = null;
        let configSha256 = null;
        try {
            assertRosterSha256(input.approved_candidate_set_sha256, 'approved_candidate_set_sha256');
            assertRosterSha256(input.current_candidate_set_sha256, 'current_candidate_set_sha256');
            assertRosterSha256(input.default_roster_sha256, 'default_roster_sha256');
            assertValidRosterId(input.default_roster_id, 'default_roster_id');
            assertValidRosterRevision(input.default_roster_revision, 'default_roster_revision');
            if (input.original_command.length === 0) {
                throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', 'original_command must be non-empty');
            }
            const paths = this.#resolvePaths(input.scope, input.trustedProject);
            if (input.approved_candidate_set_sha256 !== input.current_candidate_set_sha256) {
                return saveResult(false, 'blocked', [diagnostic('ROSTER_APPROVAL_STALE_CANDIDATE_SET')], acc, null, null, 'none');
            }
            const trustBeforeRead = await this.#checkTrustedProject(input.scope, input.trustedProject, 'save');
            if (trustBeforeRead !== null) {
                return saveResult(false, 'blocked', [trustBeforeRead], acc, null, null, 'none');
            }
            const rosters = await this.#decodeRosterPublications(paths, input.scope, input.roster_bytes);
            validateApprovedRosterOrder(input.approved_roster_sha256s, rosters);
            const config = await this.#decodeConfig(Buffer.from(input.config_bytes));
            configSha256 = await this.#hash(input.config_bytes);
            validateSaveConfig({ config, paths, input, rosters, configSha256 });
            await emitStorageStage(input.faults, { stage: 'after-approval-validation' });
            const observedPrevious = await this.#readCurrentConfigSha256(paths);
            if (observedPrevious !== input.expected_previous_config_sha256) {
                return saveResult(false, 'blocked', [diagnostic('ROSTER_APPROVAL_STALE_CONFIG'), diagnostic('ROSTER_CONFIG_CAS_MISMATCH')], acc, null, null, 'none');
            }
            const trustBeforeLock = await this.#checkTrustedProject(input.scope, input.trustedProject, 'save');
            if (trustBeforeLock !== null) {
                return saveResult(false, 'blocked', [trustBeforeLock], acc, null, null, 'none');
            }
            await emitStorageStage(input.faults, { stage: 'before-lock', path: paths.lockPath });
            lock = await acquireRosterWriterLock({
                lockPath: paths.lockPath,
                authorityRoot: paths.authorityRoot,
                hooks: transactionHooks(input.faults),
            });
            acc.lockCount += 1;
            await emitStorageStage(input.faults, { stage: 'after-lock', path: paths.lockPath });
            const lockedObservedPrevious = await this.#readCurrentConfigSha256(paths);
            if (lockedObservedPrevious !== input.expected_previous_config_sha256) {
                return saveResult(false, 'blocked', [diagnostic('ROSTER_APPROVAL_STALE_CONFIG'), diagnostic('ROSTER_CONFIG_CAS_MISMATCH')], acc, null, null, 'none');
            }
            for (const roster of rosters) {
                await emitStorageStage(input.faults, { stage: 'before-roster-publish', path: roster.path });
                const publish = await publishCreateOnlyAtomic({
                    path: roster.path,
                    authorityRoot: paths.authorityRoot,
                    bytes: roster.bytes,
                    hooks: transactionHooks(input.faults),
                });
                if (publish.status === 'conflict') {
                    return saveResult(false, 'blocked', [diagnostic('ROSTER_CREATE_ONLY_CONFLICT')], acc, null, null, 'none');
                }
                if (publish.status === 'created') {
                    acc.writeCount += 1;
                    acc.filesTouched.push(roster.displayPath);
                }
                await emitStorageStage(input.faults, { stage: 'after-roster-publish', path: roster.path });
            }
            await emitStorageStage(input.faults, { stage: 'after-rosters-before-config', path: paths.configPath });
            if (input.faults?.crashStage === 'after-rosters-before-config') {
                return saveResult(false, 'failed', [diagnostic('ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING', 'fatal')], acc, null, null, 'orphaned-rosters-no-config');
            }
            await emitStorageStage(input.faults, { stage: 'before-config-publish', path: paths.configPath });
            await publishReplaceAtomic({
                path: paths.configPath,
                authorityRoot: paths.authorityRoot,
                bytes: input.config_bytes,
                hooks: transactionHooks(input.faults),
            });
            acc.writeCount += 1;
            acc.filesTouched.push(formatAuthorityPath(paths.configPath, paths.authorityRoot, paths.authorityDisplayRoot));
            await emitStorageStage(input.faults, { stage: 'after-config-publish', path: paths.configPath });
            if (input.faults?.crashStage === 'after-config-before-readback') {
                return saveResult(false, 'failed', [diagnostic('ROSTER_RECEIPT_REPLAY_REQUIRED', 'error')], acc, configSha256, null, 'config-published-receipt-replay-required');
            }
            await emitStorageStage(input.faults, { stage: 'before-readback', path: paths.configPath });
            const readback = await this.#readbackConfigRosters(paths, config, configSha256);
            await emitStorageStage(input.faults, { stage: 'after-readback', path: paths.configPath });
            if (!readback.ok) {
                return saveResult(false, 'failed', [...readback.diagnostics, diagnostic('ROSTER_RECEIPT_REPLAY_REQUIRED', 'error')], acc, configSha256, null, 'config-published-receipt-replay-required');
            }
            if (input.faults?.crashStage === 'after-readback-before-receipt') {
                return saveResult(false, 'failed', [diagnostic('ROSTER_RECEIPT_REPLAY_REQUIRED', 'error')], acc, configSha256, null, 'config-published-receipt-replay-required');
            }
            await emitStorageStage(input.faults, { stage: 'before-receipt' });
            const receipt = await this.#createReceipt(input, config);
            await emitStorageStage(input.faults, { stage: 'after-receipt' });
            return saveResult(true, 'saved', [], acc, configSha256, receipt, 'none');
        }
        catch (error) {
            return saveResult(false, 'failed', [diagnosticFromError(error)], acc, configSha256, null, 'none');
        }
        finally {
            if (lock !== null) {
                await lock.release();
            }
        }
    }
    async publishPreRunSelection(input) {
        const filesTouched = [];
        try {
            const paths = this.#resolvePaths('user', undefined);
            const bytes = Buffer.from(input.selection_bytes);
            const selection = await this.#decodeSelection(bytes);
            validateSelectionProjection(selection);
            const selectionSha = await this.#hash(bytes);
            if (selection.selection_sha256 !== selectionSha) {
                return selectionResult(false, 'failed', [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', 'selection bytes do not match selection_sha256')], 0, filesTouched, selection.selection_sha256, false);
            }
            const path = preRunSelectionPath(paths, selection);
            const displayPath = formatAuthorityPath(path, paths.userStateRoot, paths.userStateDisplayRoot);
            if (input.selection_path !== undefined && input.selection_path !== path && input.selection_path !== displayPath) {
                return selectionResult(false, 'blocked', [diagnostic('ROSTER_CREATE_ONLY_CONFLICT', 'error', 'selection_path does not match decoded repo/workstream path')], 0, filesTouched, selection.selection_sha256, false);
            }
            const publish = await publishCreateOnlyAtomic({
                path,
                authorityRoot: paths.userStateRoot,
                bytes,
                hooks: transactionHooks(input.faults),
            });
            if (publish.status === 'conflict') {
                return selectionResult(false, 'blocked', [diagnostic('ROSTER_CREATE_ONLY_CONFLICT')], 0, filesTouched, selection.selection_sha256, false);
            }
            if (publish.status === 'idempotent') {
                return selectionResult(true, 'inspected', [diagnostic('ROSTER_SELECTION_IDEMPOTENT_REPLAY', 'info')], 0, filesTouched, selection.selection_sha256, true);
            }
            filesTouched.push(displayPath);
            const readback = await readAuthorityFileIfPresent(path, paths.userStateRoot);
            if (readback === null || !bytesEqual(readback.bytes, bytes)) {
                return selectionResult(false, 'failed', [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')], 1, filesTouched, selection.selection_sha256, false);
            }
            return selectionResult(true, 'published', [], 1, filesTouched, selection.selection_sha256, false);
        }
        catch (error) {
            return selectionResult(false, 'failed', [diagnosticFromError(error)], 0, filesTouched, null, false);
        }
    }
    zeroWriteResult(action) {
        const status = action === 'propose' ? 'proposed' : action === 'reject' ? 'rejected' : 'inspected';
        const diagnostics = action === 'reject' ? [diagnostic('ROSTER_PROPOSAL_REJECTED', 'info')] : [];
        return Object.freeze({ action, ok: true, status, diagnostics, write_count: 0, lock_count: 0, files_touched: [] });
    }
    async #decodeRosterPublications(paths, scope, rosterBytes) {
        const decoded = [];
        for (const bytesLike of rosterBytes) {
            const bytes = Buffer.from(bytesLike);
            const authority = await this.#decodeRoster(bytes);
            validateRosterProjection(authority, scope);
            const hash = await this.#hash(bytes);
            if (hash !== authority.roster_sha256) {
                throw new RosterStorageError('ROSTER_READBACK_MISMATCH', `roster bytes hash ${hash} does not match decoded roster_sha256 ${authority.roster_sha256}`);
            }
            const path = rosterRevisionPath(paths, authority);
            decoded.push(Object.freeze({
                authority,
                bytes,
                path,
                displayPath: formatAuthorityPath(path, paths.authorityRoot, paths.authorityDisplayRoot),
            }));
        }
        return Object.freeze(decoded);
    }
    async #readbackConfigRosters(paths, config, expectedConfigSha256) {
        try {
            const configRead = await readAuthorityFileIfPresent(paths.configPath, paths.authorityRoot);
            if (configRead === null) {
                return { ok: false, diagnostics: [diagnostic('ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING', 'fatal')] };
            }
            const configHash = await this.#hash(configRead.bytes);
            if (configHash !== expectedConfigSha256) {
                return { ok: false, diagnostics: [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', 'config readback hash mismatch')] };
            }
            const readbackConfig = await this.#decodeConfig(configRead.bytes);
            if (!sameConfigAuthority(config, readbackConfig)) {
                return { ok: false, diagnostics: [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', 'config readback projection mismatch')] };
            }
            for (const ref of readbackConfig.rosters) {
                const path = rosterRevisionPath(paths, ref);
                const rosterRead = await readAuthorityFileIfPresent(path, paths.authorityRoot);
                if (rosterRead === null) {
                    return { ok: false, diagnostics: [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', `missing roster readback ${ref.roster_id}`)] };
                }
                const rosterHash = await this.#hash(rosterRead.bytes);
                if (rosterHash !== ref.roster_sha256) {
                    return { ok: false, diagnostics: [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal', `roster readback hash mismatch ${ref.roster_id}`)] };
                }
            }
            return { ok: true };
        }
        catch (error) {
            return { ok: false, diagnostics: [diagnosticFromError(error)] };
        }
    }
    async #readCurrentConfigSha256(paths) {
        const current = await readAuthorityFileIfPresent(paths.configPath, paths.authorityRoot);
        return current === null ? null : await this.#hash(current.bytes);
    }
    async #checkTrustedProject(scope, trustedProject, phase) {
        if (scope === 'user')
            return null;
        if (trustedProject === undefined) {
            return diagnostic(phase === 'read' ? 'ROSTER_PROJECT_UNTRUSTED' : 'ROSTER_STORAGE_TRUST_REQUIRED');
        }
        const trusted = await trustedProject.isProjectTrusted();
        if (trusted)
            return null;
        return diagnostic(phase === 'read' ? 'ROSTER_PROJECT_UNTRUSTED' : 'ROSTER_STORAGE_TRUST_REQUIRED');
    }
    #resolvePaths(scope, trustedProject) {
        const input = this.#stateRoot === undefined
            ? { scope }
            : { scope, stateRoot: this.#stateRoot };
        if (scope === 'trusted-project') {
            if (trustedProject === undefined) {
                throw new RosterStorageError('ROSTER_STORAGE_TRUST_REQUIRED', 'trustedProject context is required for trusted-project storage');
            }
            const withProject = this.#stateRoot === undefined
                ? { scope, trustedProjectRoot: trustedProject.root }
                : { scope, stateRoot: this.#stateRoot, trustedProjectRoot: trustedProject.root };
            return resolveRosterScopePaths(withProject);
        }
        return resolveRosterScopePaths(input);
    }
    async #hash(bytes) {
        const hash = await this.#codec.hashBytes(Buffer.from(bytes));
        assertRosterSha256(hash, 'codec hash');
        return hash;
    }
    async #decodeRoster(bytes) {
        return await this.#codec.decodeRoster(Buffer.from(bytes));
    }
    async #decodeConfig(bytes) {
        return await this.#codec.decodeConfig(Buffer.from(bytes));
    }
    async #decodeSelection(bytes) {
        return await this.#codec.decodeSelection(Buffer.from(bytes));
    }
    async #createReceipt(input, config) {
        if (this.#codec.createSetupReceipt === undefined)
            return null;
        const receipt = await this.#codec.createSetupReceipt({
            scope: input.scope,
            saved_rosters: config.rosters,
            default_roster_id: input.default_roster_id,
            default_roster_revision: input.default_roster_revision,
            default_roster_sha256: input.default_roster_sha256,
            approved_candidate_set_sha256: input.approved_candidate_set_sha256,
            approved_roster_sha256s: input.approved_roster_sha256s,
            config_sha256: config.config_sha256,
            original_command: input.original_command,
        });
        assertRosterSha256(receipt.receipt_sha256, 'receipt_sha256');
        if (receipt.receipt_bytes !== undefined) {
            const receiptHash = await this.#hash(receipt.receipt_bytes);
            if (receiptHash !== receipt.receipt_sha256) {
                throw new RosterStorageError('ROSTER_READBACK_MISMATCH', 'receipt bytes do not match receipt_sha256');
            }
        }
        return receipt;
    }
}
export function sha256Bytes(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function validateRosterProjection(authority, scope) {
    assertValidRosterId(authority.roster_id);
    assertValidRosterRevision(authority.roster_revision);
    assertRosterSha256(authority.roster_sha256, 'roster_sha256');
    assertRosterSha256(authority.assignment_set_sha256, 'assignment_set_sha256');
    if (authority.scope !== scope || authority.selected_scope !== scope) {
        throw new RosterStorageError('ROSTER_STORAGE_TRUST_REQUIRED', `roster scope ${authority.scope}/${authority.selected_scope} does not match save scope ${scope}`);
    }
}
function validateConfigProjection(config, scope, paths) {
    if (config.scope !== scope) {
        throw new RosterStorageError('ROSTER_STORAGE_TRUST_REQUIRED', `config scope ${config.scope} does not match ${scope}`);
    }
    assertValidRosterId(config.default_roster_id, 'default_roster_id');
    assertValidRosterRevision(config.default_roster_revision, 'default_roster_revision');
    assertRosterSha256(config.default_roster_sha256, 'default_roster_sha256');
    assertRosterSha256(config.config_sha256, 'config_sha256');
    if (config.previous_config_sha256 !== null)
        assertRosterSha256(config.previous_config_sha256, 'previous_config_sha256');
    if (config.rosters.length === 0) {
        throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'config must contain at least one saved roster');
    }
    const seen = new Set();
    for (const ref of config.rosters) {
        assertValidRosterId(ref.roster_id);
        assertValidRosterRevision(ref.roster_revision);
        assertRosterSha256(ref.roster_sha256, 'roster_sha256');
        assertRosterSha256(ref.assignment_set_sha256, 'assignment_set_sha256');
        const key = `${ref.roster_id}\0${String(ref.roster_revision)}`;
        if (seen.has(key)) {
            throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', `duplicate saved roster ref ${ref.roster_id} revision ${String(ref.roster_revision)}`);
        }
        seen.add(key);
        if (ref.path !== undefined) {
            const expectedPath = rosterRevisionPath(paths, ref);
            const expectedDisplayPath = formatAuthorityPath(expectedPath, paths.authorityRoot, paths.authorityDisplayRoot);
            if (ref.path !== expectedPath && ref.path !== expectedDisplayPath) {
                throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `saved roster path does not match immutable revision path for ${ref.roster_id}`);
            }
        }
    }
}
function validateSelectionProjection(selection) {
    assertValidRepoId(selection.repo_id);
    assertValidWorkstreamRun(selection.workstream_run);
    assertValidRosterId(selection.roster_id);
    assertValidRosterRevision(selection.roster_revision);
    assertRosterSha256(selection.roster_sha256, 'roster_sha256');
    assertRosterSha256(selection.assignment_set_sha256, 'assignment_set_sha256');
    assertRosterSha256(selection.config_sha256, 'config_sha256');
    assertRosterSha256(selection.selection_sha256, 'selection_sha256');
}
function validateSaveConfig(input) {
    validateConfigProjection(input.config, input.input.scope, input.paths);
    if (input.config.config_sha256 !== input.configSha256) {
        throw new RosterStorageError('ROSTER_READBACK_MISMATCH', `config bytes hash ${input.configSha256} does not match config_sha256 ${input.config.config_sha256}`);
    }
    if (input.config.previous_config_sha256 !== input.input.expected_previous_config_sha256) {
        throw new RosterStorageError('ROSTER_APPROVAL_STALE_CONFIG', 'config previous_config_sha256 does not match expected CAS preimage');
    }
    if (input.config.default_roster_id !== input.input.default_roster_id ||
        input.config.default_roster_revision !== input.input.default_roster_revision ||
        input.config.default_roster_sha256 !== input.input.default_roster_sha256) {
        throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'save default tuple does not match complete-after-state config default tuple');
    }
    validateConfigRosterOrder(input.config.rosters, input.rosters);
    const defaultIsApproved = input.rosters.some((roster) => roster.authority.roster_id === input.input.default_roster_id &&
        roster.authority.roster_revision === input.input.default_roster_revision &&
        roster.authority.roster_sha256 === input.input.default_roster_sha256);
    if (!defaultIsApproved) {
        throw new RosterStorageError('ROSTER_APPROVAL_STALE_CANDIDATE_SET', 'default roster tuple must be one of the approved roster hashes');
    }
    if (exactDefaultMatch(input.config) === null) {
        throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'default roster tuple must match exactly one config roster ref');
    }
}
function validateConfigRosterOrder(configRosters, rosters) {
    if (configRosters.length !== rosters.length) {
        throw new RosterStorageError('ROSTER_APPROVAL_STALE_CANDIDATE_SET', 'config roster refs must exactly match the approved roster list');
    }
    for (let index = 0; index < rosters.length; index += 1) {
        const configRef = configRosters[index];
        const roster = rosters[index];
        if (configRef === undefined || roster === undefined || !sameRosterRef(configRef, roster.authority)) {
            throw new RosterStorageError('ROSTER_APPROVAL_STALE_CANDIDATE_SET', 'config roster order must exactly match the approved roster list');
        }
    }
}
function validateApprovedRosterOrder(approved, rosters) {
    const unique = new Set(approved);
    if (unique.size !== approved.length || approved.length !== rosters.length) {
        throw new RosterStorageError('ROSTER_APPROVAL_STALE_CANDIDATE_SET', 'approved roster hash list must be unique and exactly match saved rosters');
    }
    for (let index = 0; index < approved.length; index += 1) {
        const approvedHash = approved[index];
        const roster = rosters[index];
        if (approvedHash === undefined || roster === undefined || approvedHash !== roster.authority.roster_sha256) {
            throw new RosterStorageError('ROSTER_APPROVAL_STALE_CANDIDATE_SET', 'approved roster hash order drifted before save');
        }
    }
}
function exactDefaultMatch(config) {
    const matches = config.rosters.filter((ref) => ref.roster_id === config.default_roster_id &&
        ref.roster_revision === config.default_roster_revision &&
        ref.roster_sha256 === config.default_roster_sha256);
    return matches.length === 1 ? matches[0] ?? null : null;
}
function sameRosterRef(a, b) {
    return a.roster_id === b.roster_id && a.roster_revision === b.roster_revision && a.roster_sha256 === b.roster_sha256 && a.assignment_set_sha256 === b.assignment_set_sha256;
}
function sameConfigAuthority(a, b) {
    return stableStringify(a) === stableStringify(b);
}
function readResult(ok, status, diagnostics, configSha256, defaultRoster, config) {
    return Object.freeze({
        action: 'inspect',
        ok,
        status,
        diagnostics: sortDiagnostics(diagnostics),
        write_count: 0,
        lock_count: 0,
        files_touched: [],
        config_sha256: configSha256,
        default_roster: defaultRoster,
        config,
    });
}
function saveResult(ok, status, diagnostics, acc, configSha256, receipt, crashOutcome) {
    return Object.freeze({
        action: 'save',
        ok,
        status,
        diagnostics: sortDiagnostics(diagnostics),
        write_count: acc.writeCount,
        lock_count: acc.lockCount,
        files_touched: Object.freeze([...acc.filesTouched]),
        config_sha256: configSha256,
        receipt,
        crash_outcome: crashOutcome,
    });
}
function selectionResult(ok, status, diagnostics, writeCount, filesTouched, selectionSha256, idempotentReplay) {
    return Object.freeze({
        action: 'publish-pre-run-selection',
        ok,
        status,
        diagnostics: sortDiagnostics(diagnostics),
        write_count: writeCount,
        lock_count: 0,
        files_touched: Object.freeze([...filesTouched]),
        selection_sha256: selectionSha256,
        idempotent_replay: idempotentReplay,
    });
}
function diagnostic(code, severity, _message) {
    const normalizedCode = normalizeDiagnosticCode(code);
    return Object.freeze({
        code: normalizedCode,
        severity: severity ?? severityForCode(normalizedCode),
        message: diagnosticMessageForCode(normalizedCode),
        remediation: 'Follow the Phase 37 roster storage authority and repair the saved roster state before retrying.',
        secret_free: true,
    });
}
function diagnosticFromError(error) {
    if (error instanceof RosterStorageError) {
        const code = normalizeDiagnosticCode(error.code);
        return diagnostic(code, severityForCode(code));
    }
    return diagnostic('ROSTER_READBACK_MISMATCH', 'fatal');
}
function normalizeDiagnosticCode(code) {
    return STORAGE_CODES.has(code) ? code : 'ROSTER_READBACK_MISMATCH';
}
function diagnosticMessageForCode(code) {
    switch (code) {
        case 'ROSTER_APPROVAL_STALE_CANDIDATE_SET':
            return 'Approved roster authority no longer matches the requested save input.';
        case 'ROSTER_APPROVAL_STALE_CONFIG':
        case 'ROSTER_CONFIG_CAS_MISMATCH':
            return 'Saved roster config changed before publication could be proven.';
        case 'ROSTER_CREATE_ONLY_CONFLICT':
            return 'Immutable roster authority already exists with different bytes.';
        case 'ROSTER_LOCK_STALE_PROCESS_UNPROVEN':
            return 'Roster writer lock already exists and cannot be safely broken.';
        case 'ROSTER_PROJECT_UNTRUSTED':
        case 'ROSTER_STORAGE_TRUST_REQUIRED':
            return 'Trusted project roster storage requires an explicit trusted project context.';
        case 'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING':
            return 'Roster publication stopped after immutable roster files and before config publication.';
        case 'ROSTER_READBACK_MISMATCH':
            return 'Roster storage readback or codec validation failed closed.';
        case 'ROSTER_RECEIPT_REPLAY_REQUIRED':
            return 'Roster config is published and receipt emission must be replayed.';
        case 'ROSTER_SELECTION_IDEMPOTENT_REPLAY':
            return 'Pre-run selection bytes were already published exactly.';
        case 'ROSTER_STORAGE_AUTHORITY_UNSAFE':
            return 'Roster storage authority file safety checks failed.';
        case 'ROSTER_STORAGE_PATH_INVALID':
            return 'Roster storage rejected an invalid authority path.';
        case 'ROSTER_STORAGE_PERMISSION_DENIED':
            return 'Roster storage authority permissions are not private to the current user.';
        case 'ROSTER_STORAGE_UNSUPPORTED_PLATFORM':
            return 'Roster storage platform guarantees are unavailable.';
        case 'ROSTER_TRANSITION_REQUIRED':
            return 'Roster storage requires an explicit approved transition.';
        default:
            return `${code} roster storage diagnostic`;
    }
}
function severityForCode(code) {
    if (code === 'ROSTER_SELECTION_IDEMPOTENT_REPLAY' || code === 'ROSTER_PROPOSAL_REJECTED')
        return 'info';
    if (code === 'ROSTER_RECEIPT_REPLAY_REQUIRED')
        return 'error';
    if (code === 'ROSTER_STORAGE_UNSUPPORTED_PLATFORM' || code === 'ROSTER_STORAGE_AUTHORITY_UNSAFE' || code === 'ROSTER_READBACK_MISMATCH')
        return 'fatal';
    return 'error';
}
function sortDiagnostics(diagnostics) {
    const byCode = new Map();
    for (const item of diagnostics)
        byCode.set(item.code, item);
    return Object.freeze([...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)));
}
function transactionHooks(faults) {
    if (faults?.onTransactionStage === undefined)
        return undefined;
    return { onStage: faults.onTransactionStage };
}
async function emitStorageStage(faults, event) {
    if (faults?.onStage === undefined)
        return;
    await faults.onStage(event);
}
function bytesEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
