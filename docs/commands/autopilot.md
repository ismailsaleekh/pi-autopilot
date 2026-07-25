---
doc_id: commands/autopilot
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot
covers_sources: []
stability: stable
---

# `/autopilot`

Start or resume an Autopilot parent orchestration session for a workstream.

## Synopsis

`/autopilot <workstream> [--launch-manifest <absolute-path> | --roster <id>] [--] [task intro/current focus]`

`--launch-manifest` and `--roster` are mutually exclusive: a sealed launch package
carries its own authenticated roster authority.

## D65 sealed launch mode

For an exact local package launch, start Pi with the **package directory** so the real
package loader follows `package.json` → `pi.extensions` →
`./extensions/autopilot.ts`:

```bash
pi --no-extensions --extension /absolute/path/to/pi-autopilot
```

Do not point Pi at `dist/src/extension.js` as a package-loading shortcut. The package
entrypoint and the external signer are one physical package identity; the closed
source/dist resolver verifies both supported internal layouts against the same
package-root `bin/autopilot-launch-signer.mjs` and `bin/autopilot-agent-run.mjs`, then
rejects cwd, PATH, ancestor, global, symlink, or manifest fallbacks. The sealed signer
path must equal the canonical physical package signer exactly; the runtime spawns only
that verified path, using platform-native absolute-path semantics on POSIX and Windows.

When `--launch-manifest <absolute-path>` is present before task text, `/autopilot`
enters the closed D65 launch mode and consumes a sealed `autopilot.launch_manifest.v1` prelaunch package
rather than regenerating a run. The manifest binds the fixed prelaunch identity
(program/workstream/workstream-run, run timestamp/nonce, clone/roots/repo identity, B0,
content-result, package, branch, roots, bootstrap overlay, trust anchor, prospective
run/resource, roster hash, signed policy candidate, program evidence root, and launch
audit/seal). Every sealed value is consumed exactly, never regenerated. The manifest,
roster storage, and activation layers share the same bounded ASCII alphanumeric-or-
hyphen run/repo identity grammar; a relative path, oversized/symlinked file, unknown
field, unsafe identity, duplicate/misplaced launch flag, or internal mismatch fails closed with no
run state. Because the sealed manifest is the sole roster authority in launch mode, a
`--roster <id>` supplied alongside `--launch-manifest` is **rejected** before any roster
resolution, signer resolution, or parent model call rather than silently ignored.
The sealed roster must be W4-certified authority: every role in the closed D65 role
registry must be `w4-certified-ready` under a `w4-certified-recipe` roster with a real
certification manifest pin, so a non-certifying seed roster can never launch. Launch options must precede task text; a standalone `--` explicitly starts
literal task text when the words `--launch-manifest` are part of the task itself.

In launch mode `/autopilot`:

1. attaches the run with the sealed `attach-run.bootstrap_graph` through **exactly one**
   initial dispatch session;
2. creates the full-tree main worktree from `content_result_commit` through the frozen
   bootstrap saga;
3. registers the operator-signed launch policy (one previously-absent policy path,
   sole parent = content-result commit) and accepts the operator-signed initial
   governing program heartbeat — both produced by the external
   [`autopilot-launch-signer`](../cli/autopilot-launch-signer.md); runtime never signs;
4. replaces any previously registered `context_budget` definition with a wrapper bound
   to this manifest and durable session, then delivers a **bootstrap-plan-only** parent
   turn that may write only the five charter roots (`mission.md`, `master-plan.json`,
   `state.json`, `decision-log.jsonl`, `events.jsonl`) through exact-path `write`/`edit`.
   The bootstrap tool boundary is a positive allowlist: `read`, `grep`, `find`, `ls`,
   exact-path `write`/`edit`, and the manifest/session-bound `context_budget`; `bash`,
   command/process/background aliases, and every unknown tool are denied. Graph
   publication requires an exact tool-call/session receipt with `gate:"ok"` and bounded
   percentage. That receipt's `tool_call_id` is the provider's own carrier id, validated
   by the package's single canonical opaque tool-call-ID contract — the same one used by
   forced-output receipts and child terminal acceptance — so a real Codex Responses
   composite id (`call_…|fc_…`) is accepted and persisted byte-for-byte. The receipt
   writer and reader share that one contract; neither interprets provider structure, and
   no normalization, truncation, or hashing occurs. Its `session_id` is instead the
   package-owned coordinator session identity and binds the shared closed
   session-identity contract;
5. on `agent_settled`, mechanically publishes the first complete graph (sequence 2),
   accepts the successor governing heartbeat, adopts that exact single session (starting
   its periodic heartbeat only now), and delivers the ordinary continuation turn.

Ordinary child dispatch is impossible until graph sequence 2 and its successor
heartbeat are accepted. Bootstrap coordinator operations use a manifest-local state
root; ambient `AUTOPILOT_STATE_ROOT` changes only after successful ordinary session
adoption and is restored at shutdown. The base `context_budget` tool is restored after
bootstrap or any failed launch exit. Any parent write outside the five charter roots,
any non-OK/foreign receipt, signature/identity/cap mismatch, or stale/forked/expired
heartbeat fences the launch before a model or child boundary. Omitting `--launch-manifest` preserves the exact legacy
behavior below byte-for-byte.

## Behavior

- Resolves roster authority before preparing a worktree: explicit `--roster <id>`,
  existing-run terminal transition authority, trusted-project default, user default,
  then agent-first setup when no selectable authority exists. A corrupt, untrusted, or
  stale higher-precedence authority blocks the run; lower precedence is not consulted.
- If setup is required, stays pre-run, activates the packaged `autopilot-roster-setup`
  lane for this session only, and writes no run/worktree state. If an existing run needs
  a roster change, presents exact transition approval and waits for a retry rather than
  replacing the pinned selection.
- Activates the parent `context_budget` tool; the rendered parent prompt requires
  `context_budget` before reading project files, runtime state, or launching child
  work.
- Prepares an isolated, sparse package-owned main worktree, attaches a durable run
  supervisor at a new fencing generation, reconciles owned durable state, and drains
  the durable mailbox before dispatching the parent prompt.
- Records the active workstream for a later `/autopilot-handoff` in the same session.

## State written

Per-workstream runtime under `.pi/autopilot/<workstream>/` inside the isolated main
worktree; shared run/session authority under `~/.pi/agent/autopilot/`. See
[`../INDEX.md`](../INDEX.md#runtime-state-paths).

## Failure classes

Roster resolution/setup requirement, roster model/profile mismatch, worktree
preparation failure, and durable-supervisor attachment failure each produce a loud
notification and abort activation (no silent fallback). Current W4 provider packs and
custom trust pins are blocked, so setup cannot save launch authority from offline or
uncertified custom evidence.

## Related

- [`autopilot-inject.md`](autopilot-inject.md), [`autopilot-handoff.md`](autopilot-handoff.md)
- Roster subsystem: [`../subsystems/roster-onboarding.md`](../subsystems/roster-onboarding.md)
- D65 launch signer: [`../cli/autopilot-launch-signer.md`](../cli/autopilot-launch-signer.md)
- Concepts: [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md),
  [`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md)
- Tool: [`../tools/context_budget.md`](../tools/context_budget.md)
