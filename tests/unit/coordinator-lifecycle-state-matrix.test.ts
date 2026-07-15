import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface JsonMap { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonMap;
}

void it('keeps the lifecycle QA state matrix closed, complete, and fail-closed', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const matrix = record(JSON.parse(await readFile(resolve(packageRoot, 'tests/fixtures/coordinator-lifecycle-state-matrix.json'), 'utf8')) as unknown, 'matrix');
  assert.equal(matrix['schema_version'], 'autopilot.coordinator_lifecycle_state_matrix.v1');
  const dimensions = record(matrix['dimensions'], 'dimensions');
  const rowsValue = matrix['rows'];
  if (!Array.isArray(rowsValue)) throw new Error('matrix rows must be an array');
  const dimensionNames = ['lock', 'predecessor_fence', 'endpoint', 'child', 'database', 'authority', 'clients'] as const;
  const rows = rowsValue.map((value, index) => record(value, `row ${String(index)}`));
  assert.ok(rows.length >= 10);
  for (const name of dimensionNames) {
    const domain = dimensions[name];
    if (!Array.isArray(domain) || domain.some((entry) => typeof entry !== 'string')) throw new Error(`${name} domain must be a string array`);
    const observed = new Set(rows.map((row) => row[name]));
    for (const value of domain) assert.equal(observed.has(value), true, `${name}=${String(value)} must have a table-driven row`);
  }
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row['id'];
    if (typeof id !== 'string' || id.length === 0) throw new Error('matrix row id must be nonempty');
    assert.equal(ids.has(id), false, `duplicate matrix row ${id}`);
    ids.add(id);
    const allowed = row['allowed_mutation'];
    const forbidden = row['forbidden_effects'];
    if (!Array.isArray(allowed) || allowed.some((entry) => typeof entry !== 'string')) throw new Error(`${id} allowed_mutation must be a string array`);
    if (!Array.isArray(forbidden) || forbidden.length === 0 || forbidden.some((entry) => typeof entry !== 'string')) throw new Error(`${id} forbidden_effects must be a nonempty string array`);
    for (const field of ['expected_authority_owner', 'expected_endpoint', 'retry_wait', 'regression']) assert.equal(typeof row[field], 'string', `${id}.${field}`);
    assert.equal(row['terminal_failure_code'] === null || typeof row['terminal_failure_code'] === 'string', true, `${id}.terminal_failure_code`);
    if (row['lock'] === 'unknown' || row['lock'] === 'live-drift' || row['endpoint'] === 'unknown' || row['database'] === 'corrupt') assert.deepEqual(allowed, [], `${id} must permit no mutation`);
  }
});
