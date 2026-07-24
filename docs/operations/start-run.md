---
doc_id: operations/start-run
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Start or Resume a Run

## D65 sealed launch (recovery/first-wave runs)

A D65 fresh run starts from a sealed prelaunch package produced out of band by the
operator/control plane. Launch it with:

`/autopilot <workstream> --launch-manifest <absolute-path> [task intro]`

The runtime consumes the sealed `autopilot.launch_manifest.v1` exactly: it binds the
fixed prelaunch identity, attaches the run with the sealed bootstrap graph through one
session, creates the full-tree main worktree from the content-result commit, consumes
the operator-signed launch policy + initial heartbeat (never self-signed; see
[`../cli/autopilot-launch-signer.md`](../cli/autopilot-launch-signer.md)), runs a
bootstrap-plan-only parent turn limited to the five charter roots, then mechanically
publishes the first complete graph and accepts the successor heartbeat before any
ordinary child dispatch. Any mismatch exits before a parent model call. Omitting
`--launch-manifest` uses the ordinary roster-resolved path below unchanged.

## Recipe

1. In a Pi session, run `/autopilot <workstream> [--roster <id>] [task intro]`.
2. Autopilot resolves roster authority before worktree mutation. If no selectable
   authority exists, it activates the packaged setup lane and stops pre-run; current
   W4 offline provider packs and custom roster trust pins cannot be saved as launchable
   authority.
3. If this is an existing run and `--roster <id>` differs from the pinned terminal
   roster, Autopilot presents an exact existing-run transition approval instead of
   mutating the run; approve only the exact phrase if you intend the roster change, then
   retry the original command.
4. With a resolved roster, Autopilot selects the pinned parent request profile,
   activates `context_budget`, prepares or resumes the isolated sparse main worktree,
   attaches the durable run supervisor at the current generation, drains the mailbox,
   and queues the parent prompt.
5. The parent calls `context_budget` first, then plans and launches dependency-cleared,
   file-disjoint child units up to `parallel_cap` using v2 roster identity.

## Resuming after a Pi session restart

- If you only need to restore the binding (no new parent prompt), run
  `/autopilot-inject <workstream>`. Then `/autopilot-handoff` and `/autopilot-config`
  will target the restored workstream.
- If you want a fresh parent turn, run `/autopilot <workstream>` again — it reconciles
  owned durable state, authenticates the existing pinned roster selection/mirror plus
  any committed transition chain, and replays pending evidence before dispatch.

## Preconditions

- Roster authority must resolve from explicit `--roster`, trusted-project default,
  user default, setup-required, or an existing-run transition chain; corrupt/untrusted
  higher-precedence authority fails loudly with no fallback.
- The selected parent request profile must be exactly settable/observable; otherwise
  activation fails loudly (no fallback).
- Post-cutover activation requires a durable coordinator session before worktree mutation.

## Verify

- `/autopilot-coordination status` shows the durable run and session leases.
- Runtime files appear under `.pi/autopilot/<workstream>/`, including
  `roster-snapshot.json` after a resolved new run.

## Related

- Commands: [`../commands/autopilot.md`](../commands/autopilot.md), [`../commands/autopilot-inject.md`](../commands/autopilot-inject.md)
- Roster subsystem: [`../subsystems/roster-onboarding.md`](../subsystems/roster-onboarding.md)
- Concept: [`../concepts/generations-and-fencing.md`](../concepts/generations-and-fencing.md), [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md)
- Operations: [`release-certification.md`](release-certification.md)
