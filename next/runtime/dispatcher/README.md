# runtime/dispatcher

Exhaustive seven-command imperative dispatch. Command handlers construct and
capsule-verify deterministic port intents, call a supplied port executor once,
verify the exact observation variant and action/run identity, normalize immutable
artifacts, require a digest-bound installation receipt, and submit a
`command-observation-received` stimulus. Adapter retry policy is absent. This
module owns the `EvidenceEnvelope` semantic mint: executors return only a strict
raw host receipt, while identity and authority bindings come from the committed
`execute-evidence` command.
