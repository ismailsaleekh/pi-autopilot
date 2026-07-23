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
  autopilot: '/autopilot <workstream> [task intro/current focus]',
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
