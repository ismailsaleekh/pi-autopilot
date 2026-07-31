# Core recut W1 final report

## Status

HALT: final focused checks are green and the D80 default tooling gate passes, but the evidence-amended W1 hard maximum is still missed.

Exact blocker: tooling gate LOC is `1,999`, exceeding the W1 hard maximum `1,800` by `199` LOC. Per instruction, no further trim loop/workaround is attempted.

## Structural changes

- Preserved the consumer-first shape: one checked KDL reader (`codegen/src/kdl_read.rs`), one normalized current contracts model (`codegen/src/contracts.rs`), and one shared workflow graph (`codegen/src/workflow.rs`) consumed by `modelcheck`.
- Consolidated duplicate KDL leaf/u64/skip handling into `SourceDoc`; contracts/workflow use that single reader.
- Kept output stale-file checks, byte diff check, and atomic temp-file replace semantics; switched output tree walking to `walkdir`.
- Kept generated TypeScript/Rust/prompt bytes unchanged; added `heck` only for parity-checked type/field casing while retaining legacy enum variant casing.
- Reduced modelcheck handwritten predicates without adding another parser; C1-C8 remain direct graph predicates over `codegen::workflow::Workflow`.

## LOC

```text
raw  gate  file
656   638  codegen/src/contracts.rs
408   390  codegen/src/emit.rs
210   206  codegen/src/kdl_read.rs
 57    53  codegen/src/lib.rs
 11    10  codegen/src/main.rs
110   103  codegen/src/output.rs
374   367  codegen/src/workflow.rs
226   215  modelcheck/src/lib.rs
 18    17  modelcheck/src/main.rs
---  ----
2070 1999  total
```

`./scripts/gates/loc.sh tooling` -> `0`: `loc=1999 budget=2000`; W1 hard maximum check still fails: `1999 > 1800`.

## Generated output hashes

```text
ffd03e08f67404c1705fdd8d7022ff172a0fc1678c9ae895be150ccb2a472ab5  kernel/src/generated/mod.rs
f78309807de041792a7bd824b02ff32844237ce128bacd1e23eb5a4b681a660b  src/generated/index.ts
c7b744b68ae597083f8a5a516c381de2506417821500829306ccabf73620e22d  src/generated/tool-schemas.ts
64ffda516276c4476c097101beac73e403b496a4dab8c28826aec450aa390b1a  src/generated/child-extension.ts
6200cd45c6617d2c1ce2093d5b0bd6cd66e09ce9eec4ba3636f7a3f1b3762c76  generated/prompts/agent_handoff.md
951ae8d6ddb6db707d0ee3c9d08d2f94572d8013e88d643bfdb7049260edcc60  generated/prompts/allocation_lane_proposal.md
f56b1d3a67572d38132895998a52f5bf5e30ba5c19a6d1b4e1140530e7456f69  generated/prompts/delivery_result.md
376e17e31dc391a7952d15c03d848334d7a8d580349ffda11fb28d2d6ad55fe5  generated/prompts/delivery_submission_v2.md
6155ca5609f8ac433dd2b2c4dff793626cfde7c96117c8b2fe468f9b0f2dd39a  generated/prompts/finding_v2.md
f1d2a0029bb8bdfd12179a3847f121732381c5339bd30d60c8378186b65a1938  generated/prompts/finding.md
8f1d69a00b265a4d9f20896ad3220a05d1e5d84987383f19059781507a7c1371  generated/prompts/plan_review.md
f73ddc0ad9d60fa227dce36831aee4a91cea10c2ef6992e5c31047964c6ef499  generated/prompts/questions.md
5dd29f44a94f909647cdfb670513e400de6be0588cc3e68cc8878febe73bbbf8  generated/prompts/scout_dossier.md
cc3e2af058b6c682dd6f86ccef5d698d0b75063ea079ad7a8164781aa93a417c  generated/prompts/task_atoms.md
c94a8b24425b54d771fa4ca0d12c8aa15edf81751242ac82f9403a699193ceea  generated/prompts/validation_submission_v2.md
1fb39232d2e82292d4ab84a68c1e93e5da09bb85aa7cf16f1ab3581419a959f3  generated/prompts/validation_verdict.md
ab11f4f4b6addfa91c1ea04cfccf6e984bb18d38c475b3bd2cb12dd46fa12fdb  generated/prompts/work_map.md
```

## Diagnostics and mutations

- Unknown top-level/child KDL nodes, unknown/duplicate properties, typed entries, extra/missing arguments, missing children, forbidden children, type mismatches, duplicate artifacts/profiles, unknown field/list types, required/nullable/closed JSON schema behavior, constants, atomic output writes, stale output detection, and first differing line diagnostics are preserved with line-bearing errors.
- `codegen/tests/check_mode.rs`: 2/2 passed (hand-edit drift/check/recover; unknown KDL node line diagnostic).
- `modelcheck/tests/property_mutations.rs`: 9/9 passed (C1-C8 mutation failures plus unknown node rejection).
- `tests/workflow_matches_d76.rs`: 2/2 passed (workflow/contract parity and drift detection).
- `npm run modelcheck`: C1 PASS, C2 PASS, C3 PASS, C4 PASS, C5 PASS, C6 PASS, C7 PASS, C8 PASS.

## Final focused commands and exits

- `cargo fmt -p codegen -p modelcheck` -> `0`
- `cargo clippy -p codegen -p modelcheck --all-targets -- -D warnings` -> `0`
- `cargo test -p codegen` -> `0`
- `npm run codegen:check` -> `0`
- `shasum -a 256 kernel/src/generated/mod.rs src/generated/index.ts src/generated/tool-schemas.ts src/generated/child-extension.ts generated/prompts/*.md` -> `0`
- `cargo test -p modelcheck` -> `0`
- `npm run modelcheck` -> `0`
- `./scripts/gates/loc.sh tooling` -> `0` (`loc=1999 budget=2000`)

W1_FINAL_HALTED
