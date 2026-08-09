# Autopilot contract data

`contracts.kdl` is the source document for generated Rust types, TypeScript types, and prompt-visible admissibility text.

## KDL shape

Top-level nodes are regular:

- `schema "autopilot.contracts.v1"` and `version 1` identify the file.
- `type <name> doc=<text>` declares scalar names used by fields.
- `artifact <name> schema=<schema-id> producer=<Producer> model_produced=<bool> { ... }` declares one artifact schema.
- `field <name> type=<type-id> required=<bool> ...` declares a scalar/object field. Field names are the JSON/YAML names to generate, including exact spellings such as `isAgent` and `triggerOnCompletion`.
- `group <name> required=<bool> { field ... }` declares a nested object with fixed child fields.
- `list <name> item=<type-or-record> required=<bool> ...` declares an array.
- `record <name> { field/list/group ... }` declares a reusable nested item shape scoped to the artifact.
- `enum <name> { value <exact-value> ... }` declares a closed vocabulary. Values are exact wire/model strings.
- `frame direction=<host-to-core|core-to-host> kind=<kind> { ... }` declares one D78 seam frame payload. The common envelope is the `seam_envelope` artifact.
- `artifact_category`, `resource_gate`, `scheduler_order`, `constant`, and `pattern` are declarative data rows consumed by codegen/docs; they are not Rust control flow.

Boolean values use KDL v2 literals (`#true`, `#false`). Nullable fields are represented as `required=#true nullable=#true` when D76 prints `<x|null>` and as `required=#false nullable=#true` when an optional artifact detail is allowed. A required nullable field may add `require_explicit_null=#true` when a JSON `null` must be present explicitly rather than silently deserializing from a missing field. `max_bytes` names a Core byte bound; codegen also declares JSON Schema `maxLength`, whose character-count semantics are not Rust enforcement.

## WorkMap V2 enforcement split

Generated Rust structs for the closed V2 profile enforce required-field presence, JSON types, explicit required-null presence, and unknown-field denial. They do not enforce constants, cardinalities, string/byte bounds, uniqueness, aggregate bounds, paths/ids, or cross-field semantics. The generated JSON Schema declares the applicable shape limits but is not the Core admission validator.

Core V2 admission enforces the schema constant; exact serialized-byte cap; every min/max/unique/path/id bound; ASCII/control-free V2 authority ids and paths; the 242-byte derived-safe unit/dependency cap; nonempty `origin_anchor`; and serialized WorkMap size at most 1 MiB. `files` are exclusive implementation-owner leaves and reject equal/ancestor claims. `package_scope_files` is a required explicit package/read closure table input, never child write authority: with no proofs or bindings every scope is empty; otherwise one closure scope exactly equals the global owner leaves, all proofs are on that unit, and it transitively depends on every other unit. Vendor destinations/manifests remain owned exact `files` leaves while a final closure may only echo them in package scope. Both source and approved-image validation run the same closure algorithm, including immutable-origin collision checks.

## Producer-visible admissibility text

Every artifact with `model_produced=#true` must have a non-empty `admits` child. Codegen must render that text into the producing model prompt and use the same text as the `expected` string in a `Rejection`. This is the D77 A5 boundary rule.

Current model-produced artifacts are:

- `allocation_lane_proposal`
- `delivery_result`
- `validation_verdict`
- `finding`

## Context anchors and kernel purity

`context_anchor` uses the discriminator field `anchor_form`, not a backend-specific field name. Two `pattern` rows necessarily contain the literal `git://...` anchor strings because D76 §4.1 defines those URI forms. That is allowed in data.

W0-4 codegen must not emit those literal backend substrings into `kernel/**/*.rs`. The purity gate scans kernel source only; generated files are excluded. Generated kernel-facing code should use generic names such as `version-control-lines` / `version-control-whole-file` or numeric discriminants, while driver layers may preserve the literal data needed for prompts.

## Completeness notes

- D76 printed YAML blocks are represented field-for-field for `role_frontmatter`, `context_manifest`, and `control_frame`.
- D76 §5.3 state/verdict vocabularies are represented as closed enums. `interrupted`, `checkpointed`, and `superseded` are encoded as `attempt_attribute`, not `lane_state`.
- D78 §3.2 has exactly twelve `frame` nodes: six `host-to-core` and six `core-to-host`.
- D74 §20 durable artifact categories are data rows so generated outputs can stay synchronized with the runtime layout.
