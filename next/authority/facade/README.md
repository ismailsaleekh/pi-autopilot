# authority/facade

The semantic authority has four public operations:

- `initial(genesis) -> RunState`
- `prepare(state, inertJsonStimulus) -> AcceptedBatch | Feedback`
- `replay(state, committedBatch) -> FoldResult`
- `project(state) -> RunView`

W1 `prepare` strictly decodes the inert value with the frozen stimulus capsule and
uses an exhaustive dispatch table. Every valid kind currently returns
`admission-not-implemented` with `not yet implemented: <kind>`; malformed values
return exact schema feedback. It never emits a fake decision.

`seams.ts` freezes W2's pure admission/reaction/outcome/assembly signatures.
`prepareWithSeams` is a pure composition hook for W2 and tests; it cannot mint
without passing through protocol's capability edge, which policy-root permits only
from facade, including aliased value imports. The mint canonical-round-trips
facts, commands, and outcome, checks run identity, and binds the canonical ordered
facts to `factRoot` before branding, so accepted payloads retain no caller-owned
aliases.
