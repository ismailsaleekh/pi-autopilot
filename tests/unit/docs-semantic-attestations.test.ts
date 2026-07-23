import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const moduleUrl = pathToFileURL(join(packageRoot, 'scripts/docs/semantic-attestations.mjs')).href;

function evaluate(expression: string): unknown {
  const source = `
    import { semanticAttestationRequirement, validateSemanticAttestation } from ${JSON.stringify(moduleUrl)};
    const doc = Object.freeze({
      docId: 'subsystems/example',
      location: 'docs/subsystems/example.md',
      reviewPolicy: 'behavioral',
      coversSources: Object.freeze(['src/core/example.ts']),
      bodyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const hashes = Object.freeze({ bodyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const attestation = Object.freeze({
      schema_version: 'autopilot.docs_semantic_attestation.v1',
      doc_id: doc.docId,
      reviewed_body_hash: hashes.bodyHash,
      verdict: 'PASS',
      reviewer: 'independent validate-role',
      reviewed_at: '2026-07-23T00:00:00.000Z',
      covers_sources: [...doc.coversSources],
      notes: 'Reviewed against current covered sources.',
    });
    console.log(JSON.stringify(${expression}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}

void describe('docs semantic attestation enforcement helpers', () => {
  void it('requires an attestation for same-change behavioral prose edits even after hashes are current', () => {
    const requirement = evaluate("semanticAttestationRequirement(doc, hashes, { known: true, files: new Set([doc.location]) })");
    assert.deepEqual(requirement, {
      required: true,
      reason: 'behavioral doc prose changed in this change',
    });
  });

  void it('requires an attestation when the covered-source body hash drifts', () => {
    const requirement = evaluate("semanticAttestationRequirement({ ...doc, bodyHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, hashes, { known: true, files: new Set() })");
    assert.deepEqual(requirement, {
      required: true,
      reason: `covered source body changed; current body_hash is sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    });
  });

  void it('rejects stale existing artifacts for otherwise untriggered behavioral docs', () => {
    const failures = evaluate("validateSemanticAttestation(doc, hashes, { ...attestation, reviewed_body_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' })");
    assert.deepEqual(failures, [
      'semantic attestation reviewed_body_hash sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc != current sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (stale review)',
    ]);
  });

  void it('accepts a current PASS artifact bound to the doc id and covered sources', () => {
    assert.deepEqual(evaluate('validateSemanticAttestation(doc, hashes, attestation)'), []);
  });
});
