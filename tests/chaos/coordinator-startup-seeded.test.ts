import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface SeedCase {
  readonly name: string;
  readonly seed: number;
  readonly events: readonly string[];
  readonly expected: string;
}

interface StartupModel {
  lock: 'absent' | 'exact' | 'drift';
  endpoint: 'absent' | 'delayed' | 'exact' | 'unknown';
  child: 'running' | 'clean-loser' | 'dead';
  exactReport: boolean;
  authorityPreserved: boolean;
  operationSent: boolean;
  terminal: string | null;
}

function parseCorpus(value: unknown): readonly SeedCase[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('chaos corpus must be an object');
  const record = value as Readonly<Record<string, unknown>>;
  if (record['schema_version'] !== 'autopilot.coordinator_startup_chaos_corpus.v1' || !Array.isArray(record['seeds'])) throw new Error('chaos corpus schema is invalid');
  return record['seeds'].map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('chaos seed must be an object');
    const seed = entry as Readonly<Record<string, unknown>>;
    if (typeof seed['name'] !== 'string' || typeof seed['seed'] !== 'number' || !Number.isSafeInteger(seed['seed']) || !Array.isArray(seed['events']) || seed['events'].some((event) => typeof event !== 'string') || typeof seed['expected'] !== 'string') throw new Error('chaos seed fields are invalid');
    return { name: seed['name'], seed: seed['seed'], events: seed['events'] as string[], expected: seed['expected'] };
  });
}

function apply(model: StartupModel, event: string): void {
  if (model.terminal !== null && event !== 'operation-attempt') return;
  if (event === 'winner-lock-exact' || event === 'replacement-exact') model.lock = 'exact';
  else if (event === 'winner-endpoint-delayed') model.endpoint = 'delayed';
  else if (event === 'winner-endpoint-exact') model.endpoint = 'exact';
  else if (event === 'child-exit-0-with-exact-report') { model.child = 'clean-loser'; model.exactReport = true; }
  else if (event === 'winner-process-death') { model.child = 'dead'; model.terminal = 'fail-coordinator-unavailable'; }
  else if (event === 'winner-lock-drift' || event === 'partial-metadata-write') {
    if (event === 'winner-lock-drift') { model.lock = 'drift'; model.terminal = 'fail-closed-no-operation'; }
  } else if (event === 'endpoint-replaced-unknown') { model.endpoint = 'unknown'; model.terminal = 'fail-closed-no-operation'; }
  else if (event === 'socket-unlink') model.endpoint = 'absent';
  else if (event === 'exact-process-retirement') model.lock = 'absent';
  else if (event === 'session-handoff' || event === 'active-session' || event === 'running-child' || event === 'leases') model.authorityPreserved = true;
  else if (event === 'same-socket-operation') {
    if (model.lock === 'exact' && (model.endpoint === 'exact' || model.endpoint === 'absent') && model.terminal === null) { model.endpoint = 'exact'; model.operationSent = true; model.terminal = model.authorityPreserved ? 'success-authority-preserved' : 'success-one-exact-winner'; }
  } else if (event === 'operation-attempt') {
    if (model.lock === 'exact' && model.endpoint === 'exact' && model.terminal === null) model.operationSent = true;
  }
}

void it('replays the curated deterministic startup-chaos corpus without forbidden effects', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const seeds = parseCorpus(JSON.parse(await readFile(resolve(packageRoot, 'tests/fixtures/coordinator-startup-chaos-seeds.json'), 'utf8')) as unknown);
  assert.equal(new Set(seeds.map((seed) => seed.name)).size, seeds.length);
  for (const scenario of seeds) {
    const model: StartupModel = { lock: 'absent', endpoint: 'absent', child: 'running', exactReport: false, authorityPreserved: false, operationSent: false, terminal: null };
    for (const event of scenario.events) apply(model, event);
    assert.equal(model.terminal, scenario.expected, scenario.name);
    if (scenario.expected.startsWith('fail')) assert.equal(model.operationSent, false, `${scenario.name} sent a forbidden operation`);
    if (scenario.events.includes('child-exit-0-with-exact-report')) assert.equal(model.exactReport, true, scenario.name);
    if (scenario.expected === 'success-authority-preserved') assert.equal(model.authorityPreserved, true, scenario.name);
  }
});
