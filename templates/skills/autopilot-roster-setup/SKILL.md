---
name: autopilot-roster-setup
description: Normally inactive agent-first Autopilot roster setup lane. Use only when /autopilot needs roster onboarding or the user explicitly asks to inspect, propose, refine, reject, doctor, or save Autopilot model rosters.
disable-model-invocation: true
---

# Autopilot roster setup

This skill guides Phase 37 Autopilot roster onboarding. It is intentionally normally inactive: load it only through `/skill:autopilot-roster-setup` or when the user explicitly asks to set up Autopilot rosters after `/autopilot` reports onboarding is required.

## Non-negotiable mode

- Run an agent-first, ordinary multi-turn conversation. Do not open a wizard, menu, questionnaire, or scripted UI flow.
- Stay pre-run. Do not start `/autopilot`, child agents, background agents, worktree creation, source mutation, tests, builds, provider calls for work, or any spend-producing run.
- Use only the roster setup operation contract (`autopilot_manage_rosters`: `inspect`, `propose`, `reject`, `doctor`, `save`) when it is available. If it is unavailable, say the setup lane is blocked and do not write anything.
- Never infer provider quality, billing, readiness, auth, route, API, thinking, service tier, cache policy, or prompt profile from names or credential shape. Use only returned non-secret contract fields and diagnostics.
- Never reveal, request, store, or echo secrets. Outputs must be secret-free: provider IDs, model IDs, route classes, auth class/source/status, hashes, and diagnostics are allowed; API keys, OAuth tokens, raw auth files, and environment secret values are not.

## Conversation phases

### 1. Inspect (zero-write)

Ask the user for the original `/autopilot ...` command if it is not already present. Preserve that exact string as `original_command` for every operation and for the final retry instruction.

Call `inspect` only to read non-secret availability and existing default facts. `inspect` must have `write_count=0`, `lock_count=0`, and `files_touched=[]`. For `scope: trusted-project`, require project trust; if trust is absent or revoked, report `ROSTER_PROJECT_UNTRUSTED`/`ROSTER_STORAGE_TRUST_REQUIRED` honestly and offer user-scope setup instead.

### 2. Propose and refine (zero-write)

Call `propose` to produce candidate rosters. `propose`, every refinement, `doctor`, and `reject` are zero-write and zero-lock. If any result reports writes, locks, files touched, secrets, or unknown schema, stop and report a contract failure.

Present candidates as a concise conversation, not a menu. Include:

- scope and whether project trust was accepted;
- candidate set ID and exact `candidate_set_sha256`;
- each candidate profile (`precision`, `cruise`, `afterburner`), roster ID, revision, `roster_sha256`, assignment-set hash, route/billing/auth summaries, and readiness;
- diagnostics exactly as returned, with secret-free remediation;
- convergence honestly: if profiles share an assignment set or diagnostic `ROSTER_CONVERGED_ASSIGNMENT_SET`, say they are behaviorally converged instead of implying different quality;
- blocked states honestly: if readiness is blocked or qualification is required, say it is not ready and do not work around it.

Recommend Cruise only when a Cruise candidate is actually ready in the returned contract. If recommended Cruise is blocked, do not choose another default implicitly; report `ROSTER_RECOMMENDED_PROFILE_BLOCKED` and ask for an explicit qualified choice (`ROSTER_EXPLICIT_CHOICE_REQUIRED`).

### 2b. Custom/mixed proposal (zero-write, v2 only)

If the user asks for custom or mixed roles, do **not** send a caller-built roster, precomputed roster hash, provider manifest, or anything parsed from `original_command`. Use `autopilot.roster_tool_request.v2` with `action: "propose-custom"` and a closed `custom_roster_request` whose `schema_version` is `autopilot.custom_roster_request.v2`. The payload must contain:

- an ordinary-language `natural_language_request` describing the user's intent;
- `profile_id` (`precision`, `cruise`, or `afterburner`);
- exactly one `role_assignment_intent` item for every role (`parent`, `strategy`, `implement`, `validate`, `fix`, `adjudicate`, `bughunt`, `extract`), with explicit `role`, `provider_id`, `model_id`, `api`, and `thinking` plus optional `service_tier`, `cache_policy`, and `system_prompt_profile`;
- `qualification_manifest` as `null` unless the package has supplied an exact custom_roster certification manifest for the exact roster.

The package, not you, resolves the current model registry inventory and registered route policies, builds the canonical `generation_source: user-custom` roster, and returns `autopilot.roster_tool_result.v2` with `custom_validation`, `custom_roster`, `approval_binding`, and zero writes. Unknown fields are errors. A structurally valid custom roster is **not ready**: it remains blocked until `custom_validation.certification_status` is `autopilot-certified` for the exact `validation_result_sha256`, `roster_sha256`, and `manifest_sha256`. With the current empty custom trust registry, custom save attempts must block with zero writes; report that honestly.

### 3. Approval gate before save

Before any `save`, present the current proposal facts exactly and ask for an ordinary explicit user approval turn. The user does not need to echo the machine presentation; natural language such as "use your recommendation" can be enough when you, the setup agent, interpret it as approving the current proposal.

The host package only authorizes that a nonempty bounded user/rpc/interactive turn occurred after the current package-bound presentation. It does not parse approval semantics. You must interpret the user's meaning, and you must still bind the `save` request to exact contract fields from the current proposal:

```text
scope: <user|trusted-project>
candidate_set_sha256: sha256:<64 lowercase hex>
approved_roster_sha256s, in proposal order: [sha256:..., sha256:...]
default_roster_id: <exact roster id>
default_roster_revision: <integer>
default_roster_sha256: sha256:<64 lowercase hex>
original_command: <exact original /autopilot command>
```

Reject stale, partial, reordered, duplicate, hash-mismatched, ambiguous, rejecting, or refining user turns. Do not save from a thumbs-up, menu choice, or implied consent unless you can honestly interpret it as approval of the current presented proposal. Do not compute substitute hashes; the canonical hashes are the contract hashes returned by the roster operation.

For custom v2 proposals, the approval presentation and `save` request must also bind the exact `validation_result_sha256`, `roster_sha256`, and `manifest_sha256` from `approval_binding`; structural validation alone is not approval to launch.

### 4. Save (the only write action)

Call `save` only after host authorization and your semantic interpretation of explicit user approval. Bind the exact `candidate_set_sha256`, approved roster subset in proposal order, default roster tuple (`roster_id + roster_revision + roster_sha256`), scope, trust state, and `original_command`. Current W0/offline candidates are not production launchable; save can succeed only for a registry-verified W4-ready approved subset.

A successful save must publish immutable roster revision files first, publish `config.json` last, read back every byte/hash, and return a secret-free `autopilot.roster_setup_receipt.v1`. Accept success only when:

- `status` is `saved` and `ok` is true;
- `write_count` matches the visible authority writes reported by the operation (W0 success is three: two roster files plus `config.json`);
- `lock_count` is one for successful save;
- `receipt.fresh_session_required` is true;
- `receipt.zero_secrets` is true;
- the receipt default tuple exactly matches one saved roster;
- the receipt `original_command` exactly equals the preserved original command.

For failed or blocked save, report diagnostics and counters honestly. Pre-approval freshness failures must have no lock and no files touched.

### 5. After a successful save

Do not auto-start Autopilot. Do not call `/autopilot` in the same session. Tell the user:

1. Start a fresh Pi session.
2. Retry exactly the original command from the receipt, byte-for-byte.
3. Keep the receipt hashes for audit.

The final response after save must include the exact original command as a code block and must say that a fresh Pi session is required.

## If blocked

Blocked is a valid outcome. Explain the exact diagnostic codes, the secret-free reason, and the next safe user action. Do not fabricate readiness, fall back to another provider, switch to OpenRouter or a metered gateway, clamp thinking, use a different API, write defaults, publish selections, create worktrees, or start work.
