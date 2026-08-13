export { foldDomainFact } from "./domain-fact-fold.js";
export { deriveActionTransition, deriveSemanticTransition, fold, foldAll, foldMany } from "./fold.js";
export type {
  DomainFactFoldResult,
} from "./domain-fact-fold.js";
export type {
  ActionTransitionDraft,
  ActionTransitionResult,
  FoldInput,
  SemanticTransitionDraft,
  SemanticTransitionResult,
} from "./fold.js";
export type { FoldError, FoldResult } from "./fold-result.js";
