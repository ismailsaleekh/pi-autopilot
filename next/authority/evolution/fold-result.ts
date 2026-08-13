import type { DomainFact } from "../protocol/domain-fact.capsule.js";
import type {
  ActionId,
  ArtifactRoot,
  CandidateId,
  CommandId,
  Digest,
  EvidenceId,
  FindingId,
  PlanRootId,
  PublicationId,
  RunId,
  SubmissionId,
  WorkItemId,
} from "../protocol/identifiers.js";
import type { JournalRecord } from "../protocol/journal-record.capsule.js";
import type { RunState } from "../model/run-state.js";

export type FoldError =
  | { readonly code: "post-terminal" }
  | {
      readonly code: "run-mismatch";
      readonly expectedRunId: RunId;
      readonly actualRunId: RunId;
    }
  | {
      readonly code: "duplicate-sequence";
      readonly sequence: number;
    }
  | {
      readonly code: "stale-sequence";
      readonly lastSequence: number;
      readonly actualSequence: number;
    }
  | {
      readonly code: "sequence-gap";
      readonly expectedSequence: number;
      readonly actualSequence: number;
    }
  | { readonly code: "unexpected-genesis" }
  | { readonly code: "already-suspended" }
  | { readonly code: "not-suspended" }
  | { readonly code: "resume-request-mismatch" }
  | { readonly code: "resume-sequence-mismatch" }
  | { readonly code: "planning-outcome-after-planning" }
  | {
      readonly code: "decision-fact-root-mismatch";
      readonly expectedFactRoot: ArtifactRoot;
      readonly actualFactDigest: Digest;
    }
  | {
      readonly code: "fact-run-mismatch";
      readonly factKind: DomainFact["kind"];
      readonly expectedRunId: RunId;
      readonly actualRunId: RunId;
    }
  | { readonly code: "duplicate-requirements-binding" }
  | { readonly code: "duplicate-work-item"; readonly workItemId: WorkItemId }
  | { readonly code: "unknown-work-item"; readonly workItemId: WorkItemId }
  | { readonly code: "duplicate-submission"; readonly submissionId: SubmissionId }
  | { readonly code: "duplicate-plan-root"; readonly planRootId: PlanRootId }
  | { readonly code: "unknown-plan-root"; readonly planRootId: PlanRootId }
  | { readonly code: "duplicate-plan-supersession"; readonly planRootId: PlanRootId }
  | { readonly code: "duplicate-coverage-link" }
  | { readonly code: "duplicate-finding"; readonly findingId: FindingId }
  | { readonly code: "unknown-finding"; readonly findingId: FindingId }
  | { readonly code: "finding-already-cleared"; readonly findingId: FindingId }
  | { readonly code: "duplicate-evidence"; readonly evidenceId: EvidenceId }
  | { readonly code: "duplicate-candidate"; readonly candidateId: CandidateId }
  | { readonly code: "unknown-candidate"; readonly candidateId: CandidateId }
  | { readonly code: "duplicate-publication"; readonly publicationId: PublicationId }
  | { readonly code: "unknown-publication"; readonly publicationId: PublicationId }
  | { readonly code: "publication-already-observed"; readonly publicationId: PublicationId }
  | { readonly code: "duplicate-command-settlement"; readonly commandId: CommandId }
  | { readonly code: "duplicate-action"; readonly actionId: ActionId }
  | { readonly code: "unknown-domain-fact-kind" }
  | { readonly code: "unknown-journal-record-kind" };

export type FoldResult =
  | {
      readonly kind: "applied";
      readonly state: RunState;
    }
  | {
      readonly kind: "rejected";
      readonly state: RunState;
      readonly recordKind: JournalRecord["kind"];
      readonly error: FoldError;
    };
