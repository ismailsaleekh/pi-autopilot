import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AutopilotRosterCanonicalizationError,
  autopilotRosterContractCanonicalJson,
  autopilotRosterContractSha256OmittingOwnField,
  computeAutopilotAssignmentSetSha256,
  computeAutopilotRosterCandidateSetId,
  parseAutopilotRoster,
  parseAutopilotRosterCandidateSet,
  parseRosterJsonWithDuplicateKeyRejection,
  rosterCanonicalSha256,
} from '../../src/core/contracts/index.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURES = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-acceptance-fixtures.v1.json'));
const MANIFEST = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-contract-freeze.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('Phase 37 roster canonical hashes', () => {
  void it('uses RFC-8785 style sorted object keys plus one terminal LF', () => {
    const left = { z: 1, a: { b: true, a: 'first' }, list: [3, 2, 1] };
    const right = { list: [3, 2, 1], a: { a: 'first', b: true }, z: 1 };
    assert.equal(autopilotRosterContractCanonicalJson(left), '{"a":{"a":"first","b":true},"list":[3,2,1],"z":1}\n');
    assert.equal(rosterCanonicalSha256(left), rosterCanonicalSha256(right));
  });

  void it('reproduces sealed fixture canonical hashes and candidate-set IDs', () => {
    const candidateSet = parseAutopilotRosterCandidateSet(objectAt(REGISTRY, 'synthetic_candidate_set'));
    assert.equal(computeAutopilotRosterCandidateSetId(candidateSet), candidateSet['candidate_set_id']);
    assert.equal(
      autopilotRosterContractSha256OmittingOwnField(candidateSet, 'candidate_set_sha256'),
      candidateSet['candidate_set_sha256'],
    );

    const rosterRecord = objectAt(arrayAt(MANIFEST, 'generated_rosters'), '0');
    const roster = parseAutopilotRoster(rosterRecord);
    assert.equal(
      computeAutopilotAssignmentSetSha256(roster.assignments),
      roster.assignment_set_sha256,
    );
    assert.equal(
      autopilotRosterContractSha256OmittingOwnField(rosterRecord, 'roster_sha256'),
      roster.roster_sha256,
    );
  });

  void it('omits only the current object hash field and retains nested hashes in the preimage', () => {
    const rosterRecord = objectAt(arrayAt(MANIFEST, 'generated_rosters'), '0');
    parseAutopilotRoster(rosterRecord);
    const originalHash = autopilotRosterContractSha256OmittingOwnField(rosterRecord, 'roster_sha256');
    const drifted = cloneRecord(rosterRecord);
    const assignments = arrayAt(drifted, 'assignments').map((entry) => cloneRecord(objectAtValue(entry)));
    const firstAssignment = assignments[0];
    if (firstAssignment === undefined) throw new Error('missing first assignment');
    firstAssignment['assignment_sha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    drifted['assignments'] = assignments;
    assert.notEqual(autopilotRosterContractSha256OmittingOwnField(drifted, 'roster_sha256'), originalHash);
  });

  void it('rejects non-JSON and non-canonical preimage hazards before hashing', () => {
    assert.throws(() => autopilotRosterContractCanonicalJson({ a: undefined }), AutopilotRosterCanonicalizationError);
    assert.throws(() => autopilotRosterContractCanonicalJson([1, Number.NaN]), AutopilotRosterCanonicalizationError);
    const sparse: unknown[] = [];
    sparse[1] = 'hole';
    assert.throws(() => autopilotRosterContractCanonicalJson(sparse), /sparse array hole/u);
  });

  void it('rejects duplicate object members in raw JSON input', () => {
    assert.throws(
      () => parseRosterJsonWithDuplicateKeyRejection('{"a":1,"nested":{"b":1,"b":2}}'),
      /duplicate object member "b"/u,
    );
  });
});

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function objectAt(record: Readonly<Record<string, unknown>> | readonly unknown[], key: string): Readonly<Record<string, unknown>> {
  if (isReadonlyUnknownArray(record)) return objectAtValue(record[Number(key)]);
  return objectAtValue(record[key]);
}

function isReadonlyUnknownArray(value: Readonly<Record<string, unknown>> | readonly unknown[]): value is readonly unknown[] {
  return Array.isArray(value);
}

function objectAtValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw new Error('expected object fixture value');
}

function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected array fixture value at ${key}`);
}
