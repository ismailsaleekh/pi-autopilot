// Generated-region markers + the single renderer that both the generator (writes)
// and the verifier (byte-compares) call. Keeping one renderer guarantees C2
// byte-equality by construction: there is no second copy of the rendering logic
// that could drift.

import { GENERATED_REGIONS, STATE_ROOT_DISPLAY } from './config.mjs';

const START = (id, source) => `<!-- GENERATED:${id} START (source: ${source}) -->`;
const END = (id) => `<!-- GENERATED:${id} END -->`;

/** Locate every generated region in a doc body. Returns ordered {id, source, inner, start, end}. */
export function findRegions(body) {
  const regions = [];
  const pattern = /<!-- GENERATED:([a-z-]+) START \(source: ([^)]*)\) -->\n([\s\S]*?)\n<!-- GENERATED:\1 END -->/gu;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    regions.push({
      id: match[1],
      source: match[2],
      inner: match[3],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return regions;
}

/** Detect a malformed/half-open marker so tampering fails loud (FM14 / C2). */
export function findMarkerAnomalies(body) {
  const starts = [...body.matchAll(/<!-- GENERATED:([a-z-]+) START/gu)].map((match) => match[1]);
  const ends = [...body.matchAll(/<!-- GENERATED:([a-z-]+) END -->/gu)].map((match) => match[1]);
  const anomalies = [];
  const startCounts = new Map();
  for (const id of starts) startCounts.set(id, (startCounts.get(id) ?? 0) + 1);
  const endCounts = new Map();
  for (const id of ends) endCounts.set(id, (endCounts.get(id) ?? 0) + 1);
  for (const [id, count] of startCounts) {
    if ((endCounts.get(id) ?? 0) !== count) anomalies.push(`GENERATED:${id} has ${String(count)} START but ${String(endCounts.get(id) ?? 0)} END markers`);
  }
  for (const [id, count] of endCounts) {
    if (!startCounts.has(id)) anomalies.push(`GENERATED:${id} has ${String(count)} END marker(s) with no START`);
  }
  return anomalies;
}

/** Wrap rendered inner content in its START/END markers. */
export function wrapRegion(id, inner) {
  const config = GENERATED_REGIONS[id];
  if (config === undefined) throw new Error(`unknown generated region id: ${id}`);
  return `${START(id, config.source)}\n${inner}\n${END(id)}`;
}

// ---- Region renderers (pure functions of code surfaces) ----------------------

const COMMAND_SYNOPSIS = Object.freeze({
  autopilot: '/autopilot <workstream> [--roster <id>] [task intro/current focus]',
  'autopilot-inject': '/autopilot-inject <workstream>',
  'autopilot-onboard': '/autopilot-onboard <workstream> [handoff refs/notes]',
  'autopilot-handoff': '/autopilot-handoff [comments]',
  'autopilot-config': '/autopilot-config show | parallel-cap <n>',
  'autopilot-close': '/autopilot-close <workstream> [--run <workstream_run>] [--dry-run]',
  'autopilot-abort': '/autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]',
  'autopilot-claim-gc': '/autopilot-claim-gc --dry-run|--apply',
  'autopilot-coordination': '/autopilot-coordination status|doctor',
});

const COMMAND_DOC = Object.freeze({
  autopilot: 'commands/autopilot.md',
  'autopilot-inject': 'commands/autopilot-inject.md',
  'autopilot-onboard': 'commands/autopilot-onboard.md',
  'autopilot-handoff': 'commands/autopilot-handoff.md',
  'autopilot-config': 'commands/autopilot-config.md',
  'autopilot-close': 'commands/autopilot-close.md',
  'autopilot-abort': 'commands/autopilot-abort.md',
  'autopilot-claim-gc': 'commands/autopilot-claim-gc.md',
  'autopilot-coordination': 'commands/autopilot-coordination.md',
});

/** Escape a table cell so a literal `|` (even inside backticks) does not split columns. */
function cell(value) {
  return value.replace(/\|/gu, '\\|');
}

function table(header, rows) {
  const head = `| ${header.map(cell).join(' | ')} |`;
  const rule = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n');
  return `${head}\n${rule}\n${body}`;
}

export function renderCommands(surfaces) {
  const rows = surfaces.commands.map((command) => {
    const synopsis = COMMAND_SYNOPSIS[command];
    if (synopsis === undefined) throw new Error(`no documented synopsis for command "${command}" — update regions.mjs COMMAND_SYNOPSIS`);
    const doc = COMMAND_DOC[command];
    const ref = doc === undefined ? `\`/${command}\`` : `[\`/${command}\`](${doc})`;
    return [ref, `\`${synopsis}\``];
  });
  return table(['Command', 'Synopsis'], rows);
}

export function renderTools(surfaces) {
  const rows = surfaces.tools.map((tool) => [
    `\`${tool.name}\``,
    tool.availability === 'parent' ? 'parent session' : 'child runner only',
  ]);
  return table(['Tool', 'Availability'], rows);
}

export function renderClis(surfaces) {
  const runner = surfaces.runnerInvocations.map((invocation) => `\`${invocation}\``).join('<br>');
  const coordinator = `\`${surfaces.coordinatorBin} ${surfaces.coordinatorSubcommands.join('|')}\``;
  return table(['CLI', 'Invocation'], [
    [`\`${surfaces.runnerBin}\``, runner],
    [`\`${surfaces.coordinatorBin}\``, coordinator],
  ]);
}

export function renderSchemas(surfaces) {
  return surfaces.schemaNames.map((schema) => `- \`${schema}\``).join('\n');
}

export function renderModelRoster(surfaces) {
  const rows = [['parent/orchestrator', `\`${surfaces.parentAssignment.model}\``, `\`${surfaces.parentAssignment.thinking}\``]];
  for (const entry of surfaces.roleRoster) {
    rows.push([entry.role, `\`${entry.model}\``, `\`${entry.thinking}\``]);
  }
  return table(['Role', 'Model', 'Thinking'], rows);
}

export function renderDefaults(surfaces) {
  const rows = [
    ['`parallel_cap` (default)', `\`${String(surfaces.defaults.parallelCap)}\``, '`src/core/scheduler-config.ts#AUTOPILOT_DEFAULT_PARALLEL_CAP`'],
    ['`parallel_cap` (min)', `\`${String(surfaces.defaults.minParallelCap)}\``, '`src/core/scheduler-config.ts#AUTOPILOT_MIN_PARALLEL_CAP`'],
    ['`parallel_cap` (max)', `\`${String(surfaces.defaults.maxParallelCap)}\``, '`src/core/scheduler-config.ts#AUTOPILOT_MAX_PARALLEL_CAP`'],
    ['context halt percent', `\`${String(surfaces.defaults.contextHaltPercent)}\``, '`src/core/context-budget.ts#DEFAULT_CONTEXT_HALT_PERCENT`'],
  ];
  return table(['Default', 'Value', 'Source'], rows);
}

export function renderRuntimePaths(surfaces) {
  const rows = [
    ['State root (default)', `\`${STATE_ROOT_DISPLAY}\``, `\`${surfaces.envVars.stateRoot}\` override`],
    ['Per-workstream runtime root', `\`${surfaces.runtimeRootPrefix}/<workstream>/\``, 'inside the isolated main worktree'],
    ['Coordinator authority root', `\`${STATE_ROOT_DISPLAY}/coordinator/\``, 'db/WAL/SHM, locks, socket, capability'],
    ['Worktree root', `\`${STATE_ROOT_DISPLAY}/worktrees/<repo-key>/\``, 'per-run main + unit worktrees'],
  ];
  return table(['Path', 'Location', 'Notes'], rows);
}

export function renderRosterReadiness(surfaces) {
  const packRows = surfaces.rosterReadiness.providerPacks.map((entry) => [
    `\`${entry.provider_pack_id}\``,
    `\`${entry.provider_id}\``,
    `\`${entry.recipe_id}@${String(entry.recipe_revision)}\``,
    `\`${entry.route_policy_id}@${String(entry.route_policy_revision)}\``,
    `\`${entry.certification_package_version}\``,
    `\`${entry.certification_pi_version}\``,
    entry.ready_profiles.length === 0 ? 'none' : entry.ready_profiles.map((profile) => `\`${profile}\``).join(', '),
    `\`${entry.readiness}\``,
    String(entry.required_evidence_count),
    String(entry.trusted_manifest_pin_count),
    String(entry.trusted_certified_roster_pin_count),
  ]);
  const routeRows = surfaces.rosterReadiness.routePolicies.map((policy) => [
    `\`${policy.provider_id}\``,
    `\`${policy.route_policy_id}@${String(policy.route_policy_revision)}\``,
    `\`${policy.billing_route_class}\``,
    policy.allowed_apis.map((api) => `\`${api}\``).join(', '),
    policy.allowed_auth_classes.map((auth) => `\`${auth}\``).join(', '),
    policy.allowed_auth_sources.map((source) => `\`${source}\``).join(', '),
    policy.allowed_service_tiers.map((tier) => tier === null ? `\`null\`` : `\`${tier}\``).join(', '),
    policy.allowed_cache_policies.map((cache) => `\`${cache}\``).join(', '),
    policy.allowed_system_prompt_profiles.map((profile) => `\`${profile}\``).join(', '),
    `\`${policy.policy_state}\``,
    `\`${policy.qualification_state}\``,
    policy.non_certifying_seed === true ? 'yes' : 'no',
    policy.requires_live_billing_proof === true ? 'yes' : 'no',
    policy.forbidden_gateways.map((gateway) => `\`${gateway}\``).join(', '),
  ]);
  const candidateRows = surfaces.rosterReadiness.candidates.map((candidate) => [
    `\`${candidate.candidate_id}\``,
    `\`${candidate.profile_id}\``,
    `\`${candidate.recipe_id}@${String(candidate.recipe_revision)}\``,
    `\`${candidate.route_policy_id}@${String(candidate.route_policy_revision)}\``,
    `\`${candidate.roster_id}\``,
    String(candidate.roster_revision),
    `\`${candidate.roster_sha256}\``,
    `\`${candidate.assignment_set_sha256}\``,
    `\`${candidate.candidate_state}\``,
    `\`${candidate.launch_readiness}\``,
    `\`${candidate.qualification_state}\``,
    candidate.non_certifying_seed === true ? 'yes' : 'no',
    candidate.synthetic_fixture_ready_only === true ? 'yes' : 'no',
    candidate.diagnostic_codes.map((code) => `\`${code}\``).join(', '),
  ]);
  return [
    '### W4 provider registry (current package pins)',
    '',
    table(['Provider pack', 'Provider', 'Recipe', 'Route policy', 'Certification package', 'Certification Pi', 'Ready profiles', 'Registry readiness', 'Required evidence refs', 'Trusted manifest pins', 'Trusted certified roster pins'], packRows),
    '',
    '### Route policies',
    '',
    table(['Provider', 'Route policy', 'Billing route', 'APIs', 'Auth classes', 'Auth sources', 'Service tiers', 'Cache policies', 'System prompt profiles', 'Policy state', 'Qualification state', 'Non-certifying seed', 'Requires live billing proof', 'Forbidden gateways'], routeRows),
    '',
    '### Seed candidates',
    '',
    table(['Candidate', 'Profile', 'Recipe', 'Route policy', 'Roster ID', 'Revision', 'Roster SHA-256', 'Assignment-set SHA-256', 'Candidate state', 'Launch readiness', 'Qualification state', 'Non-certifying seed', 'Synthetic fixture ready only', 'Diagnostics'], candidateRows),
  ].join('\n');
}

/** Render the source-path → owning-doc read-gate table (design §4). */
export function renderReadBeforeEdit(sourceToDocs) {
  const rows = [...sourceToDocs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, docs]) => [`\`${source}\``, docs.map((doc) => `[\`${doc}\`](${relativeFromReadBeforeEdit(doc)})`).join(', ')]);
  return table(['Source path', 'Owning doc(s)'], rows);
}

function relativeFromReadBeforeEdit(docId) {
  // read-before-edit.md lives at docs/read-before-edit.md; doc ids are relative to docs/.
  return `${docId}.md`;
}

export { STATE_ROOT_DISPLAY };
