import { indexValues } from "../model/authenticated-index.js";
import type { RunState } from "../model/run-state.js";
import { compareDecimalNatural } from "../protocol/identifiers.js";
import type {
  AtomId,
  ArtifactRef,
  PlanRootId,
  RequirementId,
  SourceAnchor,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { AtomDisposition, DispositionMeaning } from "../protocol/atom.capsule.js";

export type CoverageObligation =
  | { readonly kind: "requirements-unbound"; readonly diagnostic: string }
  | { readonly kind: "inventory-unsealed"; readonly diagnostic: string }
  | { readonly kind: "atom-index-unproven"; readonly diagnostic: string }
  | { readonly kind: "disposition-index-unproven"; readonly diagnostic: string }
  | { readonly kind: "atom-undispositioned"; readonly atomId: AtomId; readonly sourceAnchor: SourceAnchor; readonly requirementId: RequirementId; readonly diagnostic: string }
  | { readonly kind: "disposition-count-mismatch"; readonly diagnostic: string };

export interface AnchorTraceLink {
  readonly atomId: AtomId;
  readonly requirementId: RequirementId;
  readonly planRootId: PlanRootId | null;
  readonly workItemIds: readonly WorkItemId[];
  readonly evidence: readonly ArtifactRef[];
  readonly disposition: DispositionMeaning["kind"] | null;
}

export interface AnchorTrace {
  readonly anchor: SourceAnchor;
  readonly atomIndexRoot: RunState["indexes"]["atoms"]["root"];
  readonly dispositionIndexRoot: RunState["indexes"]["dispositions"]["root"];
  readonly links: readonly AnchorTraceLink[];
  readonly complete: boolean;
}

function workItems(disposition: AtomDisposition): readonly WorkItemId[] {
  return disposition.meaning.kind === "implemented-by"
    ? disposition.meaning.workItems
    : Object.freeze([]);
}

function coverageEvidence(disposition: AtomDisposition): readonly ArtifactRef[] {
  return disposition.meaning.evidence;
}

/** Loud, bounded coverage diagnostics; no absence is inferred from a missing page. */
export function coverageObligations(state: RunState): readonly CoverageObligation[] {
  const output: CoverageObligation[] = [];
  if (state.requirements === null) {
    return Object.freeze([{ kind: "requirements-unbound", diagnostic: "requirements are not bound" }]);
  }
  if (!state.requirements.inventorySealed) {
    output.push(Object.freeze({ kind: "inventory-unsealed", diagnostic: "atom inventory is not sealed" }));
  }
  const atoms = indexValues(state.indexes.atoms, "atom");
  const dispositions = indexValues(state.indexes.dispositions, "disposition");
  if (atoms === null) {
    output.push(Object.freeze({ kind: "atom-index-unproven", diagnostic: "complete atom page is unavailable" }));
  }
  if (dispositions === null) {
    output.push(Object.freeze({ kind: "disposition-index-unproven", diagnostic: "complete disposition page is unavailable" }));
  }
  if (atoms !== null && dispositions !== null) {
    const dispositionIds = new Set(dispositions.flatMap((value) => value.kind === "disposition" ? [value.disposition.atomId] : []));
    for (const value of atoms) {
      if (value.kind === "atom" && !dispositionIds.has(value.atom.atomId)) {
        output.push(Object.freeze({
          kind: "atom-undispositioned",
          atomId: value.atom.atomId,
          sourceAnchor: value.atom.sourceAnchor,
          requirementId: value.atom.requirementId,
          diagnostic: `atom ${value.atom.atomId} has no proved legal disposition`,
        }));
      }
    }
  }
  if (compareDecimalNatural(state.counters.declaredAtoms, state.counters.dispositionedAtoms) !== 0) {
    output.push(Object.freeze({ kind: "disposition-count-mismatch", diagnostic: "declared and dispositioned atom counts differ" }));
  }
  return Object.freeze(output);
}

export function coverageComplete(state: RunState): boolean {
  return coverageObligations(state).length === 0;
}

export function traceAnchor(state: RunState, anchor: SourceAnchor): AnchorTrace {
  const atoms = indexValues(state.indexes.atoms, "atom");
  const dispositions = indexValues(state.indexes.dispositions, "disposition");
  if (atoms === null || dispositions === null) {
    return Object.freeze({
      anchor,
      atomIndexRoot: state.indexes.atoms.root,
      dispositionIndexRoot: state.indexes.dispositions.root,
      links: Object.freeze([]),
      complete: false,
    });
  }
  const byAtom = new Map<AtomId, AtomDisposition>();
  for (const value of dispositions) {
    if (value.kind === "disposition") {
      byAtom.set(value.disposition.atomId, value.disposition);
    }
  }
  const links: AnchorTraceLink[] = [];
  for (const value of atoms) {
    if (value.kind !== "atom" || value.atom.sourceAnchor !== anchor) {
      continue;
    }
    const disposition = byAtom.get(value.atom.atomId) ?? null;
    links.push(Object.freeze({
      atomId: value.atom.atomId,
      requirementId: value.atom.requirementId,
      planRootId: disposition?.meaning.planRootId ?? null,
      workItemIds: disposition === null ? Object.freeze([]) : workItems(disposition),
      evidence: disposition === null ? Object.freeze([]) : coverageEvidence(disposition),
      disposition: disposition?.meaning.kind ?? null,
    }));
  }
  return Object.freeze({
    anchor,
    atomIndexRoot: state.indexes.atoms.root,
    dispositionIndexRoot: state.indexes.dispositions.root,
    links: Object.freeze(links),
    complete: true,
  });
}
