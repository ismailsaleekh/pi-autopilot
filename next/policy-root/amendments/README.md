# Architecture amendments

Protocol, protected-policy, compiler-project, and default-gate changes require an
operator-approved marker named `ARCHITECTURE-AMENDMENT-<NNN>.md` in this
directory. Routine lanes never create markers or edit `policy-root/`.

## Marker protocol

The next marker ID is the successor of the active governance baseline (`001`
after `w0-trusted-baseline`). It must contain exactly one fenced
`architecture-amendment` JSON object. The object records:

- `format: 1` and the three-digit `id`;
- a non-empty citation of operator approval and rationale;
- a sorted `protectedFiles` list naming every and only protected path changed by
  the amendment, including the marker itself and `protected-files.json`;
- sorted `fingerprintChanges` entries with the exact old/new capsule digests.

The amendment tool rejects malformed, missing, extra, stale, or incomplete
markers. A marker never relaxes the default gate; protected changes remain red
until committed and pinned by the successor governance tag.

## Approved tooling and tag succession

From `next/`, compile policy tooling and invoke only:

```bash
PI_AUTOPILOT_ARCHITECTURE_AMENDMENT_APPROVED=1 \
  node dist-policy/policy-root/bootstrap-baselines.js --approved-amendment
```

All three authorities are mandatory: `--approved-amendment`, the exact approval
environment value `1`, and the next valid marker. The first invocation validates
the complete scope and regenerates fingerprints plus the protection manifest.
Commit the complete reviewed amendment, then rerun the same command from a clean
working tree. Only that second invocation creates the annotated successor tag.
The approval environment must not be ambient or used by the default gate.

Tag succession is closed and contiguous:

```text
w0-trusted-baseline
  -> governance-baseline-001
  -> governance-baseline-002
  -> ...
```

The bootstrap tag must resolve exactly to externally ratified commit
`b5f5a142b1c99a67aed90a99fcb1ad05e8f28f7e`. Every successor must be an
annotated tag at a descendant commit and carry the
tooling metadata that binds its predecessor, amendment marker digest, and
committed protection-manifest digest. The checker rejects gaps, malformed or
lightweight successor tags, invalid ancestry, metadata mismatch, and a selected
baseline that is not an ancestor of `HEAD`. Operationally, governance-baseline
tag creation is reserved to this tooling and protected repository administration;
a hand-created tag is never an approved baseline.

The protection checker reads `protected-files.json` from the selected committed
tag object, never from the working tree. Editing hashes, removing entries, and
recomputing the working manifest's self-digest therefore cannot self-certify.
