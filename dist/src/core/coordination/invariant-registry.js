function invariant(input) {
    if ((input.mechanical_repair === null) === (input.no_safe_repair_proof === null))
        throw new Error(`S1 invariant ${input.id} must declare exactly one repair disposition`);
    return Object.freeze(input);
}
export const S1_INVARIANT_REGISTRY = Object.freeze([
    invariant({ id: 'F4-PHYSICAL-INTEGRITY', scope: 'global', criticality: 'authority-critical', detector_name: 'physical-integrity', detector: (host) => host.detectPhysicalIntegrity(), mechanical_repair: null, no_safe_repair_proof: 'Unreadable or corrupt SQLite pages have no mechanically derivable replacement bytes.' }),
    invariant({ id: 'F4-STORE-GENERATION', scope: 'global', criticality: 'authority-critical', detector_name: 'store-generation', detector: (host) => host.detectStoreGeneration(), mechanical_repair: null, no_safe_repair_proof: 'Ambiguous pointer/publication/path/hash ownership cannot select store authority safely.' }),
    invariant({ id: 'F4-WRITER-GUARD', scope: 'global', criticality: 'authority-critical', detector_name: 'writer-guard', detector: (host) => host.detectWriterGuard(), mechanical_repair: null, no_safe_repair_proof: 'Writer authority cannot be inferred from PID, time, host, or filesystem metadata.' }),
    invariant({ id: 'F4-MIGRATION-BOUNDARY', scope: 'global', criticality: 'authority-critical', detector_name: 'migration-boundary', detector: (host) => host.detectMigrationBoundary(), mechanical_repair: null, no_safe_repair_proof: 'An unknown source schema/generation boundary cannot be migrated without reinterpreting bytes.' }),
    invariant({ id: 'F4-EVENT-COUNTER-BEHIND', scope: 'repository', criticality: 'progress-critical', detector_name: 'event-counter-behind', detector: (host) => host.detectEventCounterBehind(), mechanical_repair: 'Observe MAX(events.event_seq), advance the repository counter, allocate the next event, and append immutable repair evidence in one transaction.', no_safe_repair_proof: null }),
    invariant({ id: 'F4-EVENT-COUNTER-AHEAD', scope: 'global', criticality: 'authority-critical', detector_name: 'event-counter-ahead', detector: (host) => host.detectEventCounterAhead(), mechanical_repair: null, no_safe_repair_proof: 'Counter-ahead means immutable event history is missing; missing events cannot be invented.' }),
    invariant({ id: 'F4-PAYLOAD-INDEX-AMBIGUITY', scope: 'workstream_run', criticality: 'authority-critical', detector_name: 'payload-index-ambiguity', detector: (host) => host.detectPayloadIndexAmbiguity(), mechanical_repair: null, no_safe_repair_proof: 'Payload/index truth is ambiguous and payload ownership is never guessed; indexed single-run ownership is fenced.' }),
    invariant({ id: 'F3-CANONICAL-IDENTITY', scope: 'entity', criticality: 'authority-critical', detector_name: 'canonical-identity', detector: (host) => host.detectCanonicalIdentity(), mechanical_repair: 'Derive only the exact frozen semantic tuple and deterministic NUL-delimited ID.', no_safe_repair_proof: null }),
    invariant({ id: 'F3-ALIAS-ONE-HOP', scope: 'global', criticality: 'authority-critical', detector_name: 'alias-one-hop', detector: (host) => host.detectAliasOneHop(), mechanical_repair: null, no_safe_repair_proof: 'Alias chains, repoints, updates, and deletion destroy immutable historical identity.' }),
    invariant({ id: 'F3-SEMANTIC-UNIQUENESS', scope: 'workstream_run', criticality: 'authority-critical', detector_name: 'semantic-uniqueness', detector: (host) => host.detectSemanticUniqueness(), mechanical_repair: 'Select a current canonical projection only from complete committed and external facts; otherwise persist identity-recovery-pending.', no_safe_repair_proof: null }),
    invariant({ id: 'F3-OPERATION-CANONICAL-INDEX', scope: 'workstream_run', criticality: 'authority-critical', detector_name: 'operation-canonical-index', detector: (host) => host.detectOperationCanonicalIndex(), mechanical_repair: 'Resolve an operation worktree ID through one immutable alias hop to its deterministic canonical ID.', no_safe_repair_proof: null }),
    invariant({ id: 'F3-IDENTITY-RECOVERY', scope: 'workstream_run', criticality: 'authority-critical', detector_name: 'identity-recovery', detector: (host) => host.detectIdentityRecovery(), mechanical_repair: null, no_safe_repair_proof: 'Incomplete Git/registration/branch/child/attempt facts cannot authorize release, merge, deletion, or metadata pruning.' }),
]);
const definitionsById = new Map(S1_INVARIANT_REGISTRY.map((definition) => [definition.id, definition]));
if (definitionsById.size !== S1_INVARIANT_REGISTRY.length)
    throw new Error('S1 invariant registry contains duplicate IDs');
export function s1InvariantDefinition(id) {
    const definition = definitionsById.get(id);
    if (definition === undefined)
        throw new Error(`Unknown S1 invariant ${id}`);
    return definition;
}
export function runS1InvariantDetectors(host, invariantIds) {
    const seen = new Set();
    for (const id of invariantIds) {
        if (seen.has(id))
            throw new Error(`S1 invariant detector ${id} was requested twice in one pass`);
        seen.add(id);
        s1InvariantDefinition(id).detector(host);
    }
}
