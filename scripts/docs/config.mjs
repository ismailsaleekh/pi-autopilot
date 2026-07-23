// Shared configuration for the Autopilot agent-first documentation freshness gate.
//
// This module is the single place that resolves package-root-relative paths and
// enumerates the fixed structural catalog (generated regions, doc-type shapes,
// boundary policy). It intentionally holds no code facts — every fact is read
// from compiled code by code-surfaces.mjs. See docs/subsystems/coordination.md
// for the public design surface.

import { fileURLToPath } from 'node:url';

/** Absolute path to the pi-autopilot package root. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Directory (relative to package root) that holds every governed markdown doc. */
export const DOCS_DIR = 'docs';

/** The single program-consumed navigation + coverage index. */
export const MANIFEST_PATH = 'docs/manifest.json';

/** The tiny mandatory gateway that routes agents into docs before touching code. */
export const GATEWAY_PATH = 'AUTOPILOT-INSTRUCTIONS.md';

/** README hub — verified for outbound docs links only (C6). */
export const README_PATH = 'README.md';

/** Repo root AGENTS.md (outside this package) is referenced by the gateway only. */

/** Manifest schema tag; bumped only on a breaking manifest-shape change. */
export const MANIFEST_SCHEMA = 'autopilot.docs_manifest.v1';

/** Semantic-attestation artifact directory (agentic review receipts, hash-checked by C11). */
export const ATTESTATION_DIR = 'artifacts/docs-semantic';

/** Attestation artifact schema tag. */
export const ATTESTATION_SCHEMA = 'autopilot.docs_semantic_attestation.v1';

/** Allowed per-doc modes. */
export const DOC_MODES = Object.freeze(['generated', 'authored', 'mixed']);

/** Allowed review policies. `behavioral` also hard-blocks on a body-hash change. */
export const REVIEW_POLICIES = Object.freeze(['contract', 'behavioral']);

/** Allowed stability markers. */
export const STABILITY_VALUES = Object.freeze(['stable', 'evolving', 'frozen']);

// Compiled modules (under dist/) that carry the authoritative runtime values the
// generator embeds and the fact-pins import. The gate builds dist before running,
// so a missing dist is a loud, actionable error rather than a silent skip.
export const DIST_MODULES = Object.freeze({
  names: 'dist/src/core/names.js',
  modelRoster: 'dist/src/core/model-roster.js',
  schedulerConfig: 'dist/src/core/scheduler-config.js',
  contextBudget: 'dist/src/core/context-budget.js',
  materialization: 'dist/src/core/materialization.js',
  contractsTypes: 'dist/src/core/contracts/types.js',
});

// Source files parsed by the AST layer for structural facts (registration
// cross-check, command synopses, CLI subcommands).
export const AST_SOURCES = Object.freeze({
  extension: 'src/extension.ts',
  statusExtension: 'src/internal/status-extension.ts',
  coordinatorCli: 'src/cli/autopilot-coordinator.ts',
  agentRunCli: 'src/cli/autopilot-agent-run.ts',
});

// The generated-region catalog. Each region id is emitted from code, byte-verified
// by C2, and owned by exactly one doc (C7). `source` is the human-facing provenance
// string rendered into the START marker.
export const GENERATED_REGIONS = Object.freeze({
  commands: { source: 'src/extension.ts, src/core/names.ts' },
  tools: { source: 'src/core/names.ts, src/internal/status-extension.ts' },
  clis: { source: 'src/cli/autopilot-coordinator.ts, src/cli/autopilot-agent-run.ts' },
  schemas: { source: 'src/core/names.ts' },
  'model-roster': { source: 'src/core/model-roster.ts' },
  defaults: { source: 'src/core/scheduler-config.ts, src/core/context-budget.ts' },
  'runtime-paths': { source: 'src/core/names.ts, src/core/parallel-runtime.ts' },
  'read-before-edit': { source: 'docs/manifest.json' },
});

// Boundary policy (C8). The "must-document" set is computed from code:
//   1. surface-constant exporter files,
//   2. every src/cli/*.ts entrypoint,
//   3. every src/core/*/index.ts subsystem barrel.
// Coverage is checked against a monotonic floor stored in the manifest so it can
// only ratchet up per PR and never silently regress.
export const SURFACE_EXPORTER_FILES = Object.freeze([
  'src/core/names.ts',
  'src/core/model-roster.ts',
  'src/core/context-budget.ts',
  'src/core/scheduler-config.ts',
  'src/core/materialization.ts',
]);

// The exact state-root join asserted to still exist in source for the
// runtime-paths generated region (a reference-existence fact-pin, FM7/FM2).
export const STATE_ROOT_SOURCE = 'src/core/parallel-runtime.ts';
export const STATE_ROOT_LITERAL = "join(homedir(), '.pi', 'agent', 'autopilot')";
export const STATE_ROOT_DISPLAY = '~/.pi/agent/autopilot';

// Banned stale phrases (C9). Extends the historical package.test.ts blocklist.
export const STALE_PHRASES = Object.freeze([
  'placeholder',
  'does not yet',
  'skeleton lane',
  'coming soon',
  'TODO',
  'TBD',
  'to be written',
  '/autopilot-restart',
  'autopilot-restart',
  'hlo-v2',
  'hlo-agent-run',
  'hlo_emit_status',
]);
