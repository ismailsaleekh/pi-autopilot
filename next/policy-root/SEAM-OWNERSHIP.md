# W1+ seam ownership

The clean rebuild separates **lane territory** from **integration territory**.
This is an enforcement contract, not a suggestion.

## Lane territory

A lane may change only the paths enumerated in its operator-approved brief. The
brief's file list is an enforced expectation: a path not listed is not implicitly
available because it is needed to make a lane green. Lane-owned code and its
accept-good/reject-bad tests land together. A lane reports a missing composition
surface, contract defect, fingerprint change, or suite registration as a closure
request; it does not manufacture a fake edge or edit another lane's files.

No routine lane edits `policy-root/`, a root/package TS config, the default gate,
package scripts, protocol fingerprints, protected baselines, or architecture
amendment markers. In particular, changing a suite from pending to registered is
not lane territory. The lane supplies the exact command and observed evidence in
its closure report.

## Integration territory

The integration owner alone adjudicates and lands cross-lane composition:
referenced TS projects, project references, protocol amendments, the sole journal
append edge, package/default-gate behavior, suite-manifest registration, protected
hashes, and governance baseline succession. Integration reconciles concurrent
requests once, without duplicating package scripts or test projects, and verifies
the resulting default gate in its unnarrowed form.

A registered suite entry must contain its runnable command. The protected default
gate discovers and runs every registered command automatically; future lanes
therefore request registration rather than editing `package.json`, gate code, or
`required-suites.json`.

Architecture amendments require explicit operator authority and the documented
marker/tooling protocol in `amendments/README.md`. A marker is never lane-local
permission and never makes a red protected change green by itself.
