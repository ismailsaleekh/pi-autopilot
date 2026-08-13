# authority/evolution

The fold is synchronous and pure. `foldAll` consumes each decoded finite chunk in
one pass without making another array; callers may feed arbitrarily many chunks.
`initialState` consumes the genesis record once; every later record must use exactly
`lastSequence + 1` and the same
run ID. Equal sequences are duplicates, lower sequences are stale, gaps are
out-of-order, and a later genesis is invalid. All are typed rejections that retain
the exact input state.

`DecisionCommitted` embeds its canonical ordered `facts` and retains `factRoot`.
The fold independently hashes those facts before applying them; a mismatch is the
typed, state-inert `decision-fact-root-mismatch` rejection. Runtime must perform
the same binding check before append. `commandRoot` remains a CAS reference.

All twelve `DomainFact` kinds have one exhaustive handler. Facts in a committed
batch apply atomically: a bad fact rejects the record and exposes the pre-record
state. Entity tables are key-sorted, while meaningful latest pointers (current
plan, candidate, and publication) remain order-sensitive.

A committed outcome is terminal. Terminal checking has first priority, so every
later record is rejected as `post-terminal` and the state object is returned
unchanged.
