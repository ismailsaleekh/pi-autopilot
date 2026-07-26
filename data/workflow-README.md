# Autopilot workflow data

`workflow.kdl` is the model-checkable transcription of D76 §5.3 plus the D76/D74 execution clauses named in the work item. It contains data only: closed machines, orthogonal axes, attempt attributes, verdict vocabularies, and capacity classes.

## KDL shape

Top-level required identity:

- `schema "autopilot.workflow.v1"`
- `version 1`

Top-level data node types:

- `machine <name> { ... }` declares one finite state machine. Current machines are `run`, `lane`, and `candidate`.
- `axis <name> contract=<contracts-enum> { value <exact-value> ... }` declares an orthogonal axis. Axes are not states and are not included in reachability/deadlock checks.
- `attribute <exact-value> contract="attempt_attribute"` declares an attempt attribute. Attributes are not states.
- `verdict_set <kind> contract=<contracts-enum> { value <exact-value> ... }` declares a closed verdict vocabulary used by verdict-producing transitions.
- `total_verdicts machine=<machine> kind=<verdict_set> from=<state>` marks a verdict-producing state whose outgoing transitions must cover every value in the named `verdict_set`.
- `capacity_class <name> gate=<resource_gate> { state <state> ... }` declares which states a resource gate may count.

## Machine shape

Inside each `machine`:

- Exactly one `initial <state>` node names a declared state.
- `state <state> terminal=<bool> ...` declares an exact state value. `terminal` is required on every state.
- `transition from=<state> to=<state> evidence=<artifact> ...` declares a directed edge. `from`, `to`, and `evidence` are required. `from` and `to` must name states in the same machine.
- Optional transition fields such as `verdict_kind`, `verdict`, `route`, and `doc` are descriptive/checker inputs, not control flow.

All state/value spellings must match `contracts.kdl` byte-for-byte. The checker should reject undeclared states, duplicate states in one machine, transitions crossing machines, transitions missing `evidence`, and any state spelling not found in the corresponding contract enum.

## Property-checking notes

- C1/C2/C3/C4 apply to `machine` states and `transition` edges only. `axis`, `attribute`, `verdict_set`, `total_verdicts`, and `capacity_class` nodes are not state graphs.
- C5: for each `total_verdicts` row, collect outgoing transitions from that state whose `verdict_kind` matches `kind`; their `verdict` values must equal the named `verdict_set` exactly.
- C6: every `transition` must carry a non-empty `evidence` property.
- C7: the lane checker should propagate a boolean that becomes true after entering any lane `state` with `forward_gate=#true`. It must prove `closed` is unreachable while that boolean is false. `forward-ready` and `forward-integrated` are marked as forward gates.
- C8: `parallel_cap` may count only states listed under `capacity_class "implementer-active"`; currently that set is exactly `implementing`.

## Bounded forward validation

Forward validation rounds are represented structurally as two named states only:

1. `forward-validating-1`
2. `forward-validating-2`

Round 1 `FORWARD_READY` goes to `forward-ready`; Round 1 blocker verdicts go to one consolidated `forward-fixing` state and then Round 2. Round 2 `FORWARD_READY` goes to `forward-ready`; Round 2 blocker verdicts route Tier 2/3 through the `tier-2-3-amendment` evidence edge back to allocation authority. There is no `forward-validating-3` state.

## Attempt attributes

D76 §5.3 says `interrupted`, `checkpointed`, and `superseded` are attempt attributes. They therefore appear only as top-level `attribute` nodes. The string `superseded` also appears as a `candidate` state because `contracts.kdl` separately declares it in `candidate_state`.
