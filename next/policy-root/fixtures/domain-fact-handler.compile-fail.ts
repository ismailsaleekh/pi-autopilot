import type { DomainFact } from "../../authority/protocol/domain-fact.capsule.js";

type AddedDomainFact = DomainFact | {
  readonly kind: "added-without-bookkeeping";
};

const handlers = {
  "candidate-accepted": true,
  "coverage-linked": true,
  "evidence-observed": true,
  "finding-cleared": true,
  "finding-raised": true,
  "plan-root-accepted": true,
  "plan-root-superseded": true,
  "publication-intended": true,
  "publication-observed": true,
  "requirements-bound": true,
  "submission-bound": true,
  "work-declared": true,
} satisfies Readonly<Record<AddedDomainFact["kind"], true>>;

void handlers;
