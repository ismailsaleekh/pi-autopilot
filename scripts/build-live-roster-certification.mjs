import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_GPT55_HEAVY_CANDIDATE,
  CODEX_GPT55_HEAVY_RECIPE,
  buildW4CertifiedRosterForCandidate,
} from '../dist/src/core/roster/provider-recipes.js';
import {
  W4_PROVIDER_PACK_REGISTRY,
} from '../dist/src/core/roster/providers/index.js';
import {
  ROSTER_ROLE_ORDER,
  canonicalSha256,
} from '../dist/src/core/roster/route-policies.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const OUTPUT_ROOT = resolve(PACKAGE_ROOT, 'artifacts/qualification/live/codex-gpt55-heavy');
const SOURCE_TASKS_PATH = resolve(OUTPUT_ROOT, 'source-tasks.json');
const EXPECTED = Object.freeze({
  parent: ['gpt-5.6-sol', 'xhigh'],
  strategy: ['gpt-5.6-sol', 'xhigh'],
  implement: ['gpt-5.5', 'high'],
  validate: ['gpt-5.5', 'high'],
  fix: ['gpt-5.5', 'high'],
  adjudicate: ['gpt-5.6-terra', 'high'],
  bughunt: ['gpt-5.6-sol', 'xhigh'],
  extract: ['gpt-5.5', 'high'],
});

function fail(message) {
  throw new Error(`live Codex certification: ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  writeFileSync(path, bytes);
  return { sha256: sha256Bytes(bytes), byte_count: bytes.byteLength };
}

function argvValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || typeof argv[index + 1] !== 'string') fail(`attestation argv lacks ${flag}`);
  return argv[index + 1];
}

function reportHasField(report, label, expected) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedExpected = expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escapedLabel}\\s*(?:[:=]\\s*|\\s+)\`?${escapedExpected}\`?`, 'iu').test(report);
}

const sourceTasks = readJson(SOURCE_TASKS_PATH);
if (sourceTasks.schema_version !== 'autopilot.live_certification_source_tasks.v1') fail('source task map schema is invalid');
const pack = W4_PROVIDER_PACK_REGISTRY.find((entry) => entry.provider_pack_id === 'codex-gpt55-heavy-sol-terra-w4');
if (pack === undefined) fail('provider pack is missing');
if (pack.certification_package_version !== '1.3.0' || pack.certification_pi_version !== '0.82.0') fail('provider pack certification baseline is stale');

const liveEvidence = [];
const roleResults = [];
let parentAttestationSummary = null;

for (const role of ROSTER_ROLE_ORDER) {
  const taskId = sourceTasks.roles?.[role];
  const expected = EXPECTED[role];
  if (typeof taskId !== 'string' || expected === undefined) fail(`source task is missing for ${role}`);
  const attestationPath = resolve(REPO_ROOT, '.pi/tasks', sourceTasks.session_dir, `${taskId}.attestation.json`);
  const reportPath = resolve(REPO_ROOT, '.pi/certification-reports', `codex-${role}.md`);
  const attestation = readJson(attestationPath);
  const reportBytes = readFileSync(reportPath);
  const invocation = attestation.invocation ?? {};
  const lifecycle = attestation.lifecycle ?? {};
  const authority = attestation.authority ?? {};
  const reportArtifact = attestation.artifacts?.report ?? {};
  const argv = invocation.argv;
  if (!Array.isArray(argv)) fail(`${role} attestation argv is invalid`);
  if (attestation.schema_version !== 'phase2.pi_task_attestation.v1' || lifecycle.status !== 'completed' || lifecycle.exit_code !== 0) fail(`${role} task did not complete`);
  if (invocation.provider !== 'openai-codex' || invocation.model_id !== expected[0] || invocation.provider_scoped_model_id !== `openai-codex/${expected[0]}`) fail(`${role} model identity drifted`);
  if (invocation.api_identity !== 'openai-codex-responses' || invocation.auth_class !== 'pi-codex-oauth' || invocation.credential_kind !== 'oauth') fail(`${role} auth/API identity drifted`);
  if (invocation.route_class !== 'subscription-agent' || invocation.channel !== 'subscription-codex' || invocation.direct_api_key !== false || invocation.final_stop_reason !== 'stop') fail(`${role} did not use the direct subscription route`);
  if (argvValue(argv, '--thinking') !== expected[1] || !argv.includes('--no-extensions')) fail(`${role} thinking or prompt-isolation flags drifted`);
  if (authority.start_worktree_clean !== true || authority.finish_worktree_clean !== true || authority.start_tree_oid !== authority.finish_tree_oid) fail(`${role} worktree authority drifted`);
  if (reportArtifact.sha256 !== sha256Bytes(reportBytes) || reportArtifact.byte_length !== reportBytes.byteLength) fail(`${role} report hash binding drifted`);
  const reportText = reportBytes.toString('utf8');
  for (const [label, expectedValue] of [['role', role], ['prompt profile', 'pi-default.v1'], ['fallback', 'forbidden'], ['result', 'PASS']]) {
    if (!reportHasField(reportText, label, expectedValue)) fail(`${role} report lacks ${label}=${expectedValue}`);
  }

  const summary = {
    schema_version: 'autopilot.live_role_attestation_summary.v1',
    role,
    provider_id: invocation.provider,
    model_id: invocation.model_id,
    thinking: expected[1],
    api: invocation.api_identity,
    auth_class: invocation.auth_class,
    credential_kind: invocation.credential_kind,
    route_class: invocation.route_class,
    channel: invocation.channel,
    direct_api_key: invocation.direct_api_key,
    service_tier: null,
    cache_policy: 'provider-default',
    system_prompt_profile: 'pi-default.v1',
    fallback_used: false,
    final_stop_reason: invocation.final_stop_reason,
    pi_session_id: invocation.pi_session_id,
    source_task_id: taskId,
    source_attestation_sha256: attestation.attestation_sha256,
    source_metadata_sha256: attestation.source_hashes?.metadata_sha256,
    source_events_sha256: attestation.source_hashes?.events_sha256,
    source_report_sha256: reportArtifact.sha256,
    source_report_byte_count: reportArtifact.byte_length,
    start_commit_oid: authority.start_commit_oid,
    finish_commit_oid: authority.finish_commit_oid,
    start_tree_oid: authority.start_tree_oid,
    finish_tree_oid: authority.finish_tree_oid,
    start_worktree_clean: authority.start_worktree_clean,
    finish_worktree_clean: authority.finish_worktree_clean,
    secret_free: true,
  };
  const evidencePath = resolve(OUTPUT_ROOT, 'authenticated/no-fallback/execution', `${role}.json`);
  const written = writeJson(evidencePath, summary);
  const ref = {
    evidence_id: `codex-gpt55-heavy-${role}-proof`,
    kind: 'execution-proof',
    uri: `w3-evidence://codex-gpt55-heavy/authenticated/no-fallback/execution/${role}.json`,
    sha256: written.sha256,
    byte_count: written.byte_count,
    secret_free: true,
  };
  liveEvidence.push(ref);
  roleResults.push({ role, state: 'pass', evidence_refs: [ref] });
  if (role === 'parent') parentAttestationSummary = summary;
}

if (parentAttestationSummary === null) fail('parent route witness is missing');
for (const [kind, evidenceId] of [['route-proof', 'codex-gpt55-heavy-route-proof'], ['billing-proof', 'codex-gpt55-heavy-billing-proof']]) {
  const proof = {
    schema_version: 'autopilot.live_global_route_attestation.v1',
    proof_kind: kind,
    provider_id: 'openai-codex',
    api: 'openai-codex-responses',
    auth_class: 'pi-codex-oauth',
    credential_kind: 'oauth',
    route_class: 'subscription-agent',
    channel: 'subscription-codex',
    direct_api_key: false,
    billing_route_class: 'subscription-oauth',
    fallback_used: false,
    source_task_id: parentAttestationSummary.source_task_id,
    source_attestation_sha256: parentAttestationSummary.source_attestation_sha256,
    secret_free: true,
  };
  const basename = kind === 'route-proof' ? 'route.json' : 'billing.json';
  const written = writeJson(resolve(OUTPUT_ROOT, 'authenticated/no-fallback', basename), proof);
  liveEvidence.push({
    evidence_id: evidenceId,
    kind,
    uri: `w3-evidence://codex-gpt55-heavy/authenticated/no-fallback/${basename}`,
    sha256: written.sha256,
    byte_count: written.byte_count,
    secret_free: true,
  });
}

liveEvidence.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
const manifestPreimage = {
  schema_version: 'autopilot.certification_manifest.v1',
  manifest_id: 'codex-gpt55-heavy-sol-terra-w4-live-20260724',
  manifest_revision: 1,
  subject_kind: 'provider_recipe',
  subject_id: CODEX_GPT55_HEAVY_RECIPE.recipe_id,
  subject_sha256: CODEX_GPT55_HEAVY_RECIPE.recipe_sha256,
  package_version: pack.certification_package_version,
  pi_version: pack.certification_pi_version,
  qualification_state: 'w4-certified-ready',
  role_results: roleResults,
  required_evidence: [...pack.required_evidence].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  live_evidence: liveEvidence,
  issued_at: '2026-07-24T23:45:00.000Z',
  expires_at: '2026-08-24T23:45:00.000Z',
};
const manifest = { ...manifestPreimage, manifest_sha256: canonicalSha256(manifestPreimage) };
writeJson(resolve(OUTPUT_ROOT, 'manifest.json'), manifest);
const certifiedRoster = buildW4CertifiedRosterForCandidate({
  candidate: CODEX_GPT55_HEAVY_CANDIDATE,
  certification_manifest_id: manifest.manifest_id,
  certification_manifest_sha256: manifest.manifest_sha256,
});
if (certifiedRoster === null) fail('certified roster could not be derived');
writeJson(resolve(OUTPUT_ROOT, 'certified-roster.json'), certifiedRoster);
console.log(JSON.stringify({
  manifest_id: manifest.manifest_id,
  manifest_sha256: manifest.manifest_sha256,
  certified_roster_sha256: certifiedRoster.roster_sha256,
  role_evidence_count: roleResults.length,
  live_evidence_count: liveEvidence.length,
}, null, 2));
