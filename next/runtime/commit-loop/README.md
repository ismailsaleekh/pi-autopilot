# runtime/commit-loop

The sole production `appendCommittedBatch` caller. The loop decodes hostile
stimuli, calls the public authority facade, installs the opaque command artifact
before journal reference, appends and acknowledges one decision record, replays
it into state, and only then dispatches commands. Resume closes the poisoned
epoch, acquires a successor, checks replay completion, verifies every loaded
command batch against its journaled root, and reconciles once per durable action
identity. An uncertain selected append and duplicate ingest schedule this
reconciliation only after leaving the commit queue, so observation re-entry
cannot deadlock it. No artifact, role, finding, command-kind, or terminal
semantics are interpreted here.
