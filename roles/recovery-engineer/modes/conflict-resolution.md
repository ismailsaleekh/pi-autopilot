## Mode objective

Resolve one contract-defect finding where the candidate and original approved contract disagree.

## Additional context

Use the typed contract finding, original approved unit and criteria, exact candidate/base/worktree, affected contract surfaces, prior delivery evidence, and original validation gate.

## Mode procedure

Investigate the candidate and approved contract symmetrically, determine whether source or diagnosis is wrong, and make only the in-scope correction that preserves all valid constraints. Do not silently amend task authority or a released contract; use `requires-new-authority` when those bytes must change. Return only repaired/no-defect through the unchanged validator.

## Mode evidence

Evidence is root cause and typed disposition, preserved constraints from candidate and contract, focused checks, and exact candidate/base identities.
