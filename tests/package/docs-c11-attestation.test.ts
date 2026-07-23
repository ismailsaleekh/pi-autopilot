import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Lowest-layer regression for the hardened C11 semantic-attestation contract
// (design D67 / Phase 39). It drives the PURE evaluator in scripts/docs/attestation.mjs
// and the prose-hash helper in scripts/docs/hashing.mjs directly, so every fail-closed
// requirement is proven without touching the filesystem, network, model, or time.
//
// Requirements proven (handoff §7.7):
//   - a well-formed current receipt PASSes,
//   - mechanical restamping alone (body_hash refreshed, semantic_attestation/receipt
//     unchanged) cannot clear C11,
//   - prose mutation invalidates the receipt (reviewed_doc_sha256 binding),
//   - source mutation invalidates the receipt (reviewed_body_hash + body_hash binding),
//   - stale / missing / wrong-doc / wrong-source-set / non-PASS / malformed receipts reject.

const { evaluateSemanticAttestation } = (await import(new URL('../../scripts/docs/attestation.mjs', import.meta.url).href)) as {
  evaluateSemanticAttestation: (input: unknown) => string[];
};
const { computeDocProseHash, sha256 } = (await import(new URL('../../scripts/docs/hashing.mjs', import.meta.url).href)) as {
  computeDocProseHash: (body: string) => string;
  sha256: (text: string) => string;
};

const SCHEMA = 'autopilot.docs_semantic_attestation.v2';
const DOC_ID = 'subsystems/example';
const SOURCES = ['src/core/a.ts', 'src/core/b.ts'];
const BODY_HASH = sha256('covered-source-body-v1');
const PROSE = '# Example\n\nAuthored prose describing exact behavior.\n';
const PROSE_HASH = computeDocProseHash(PROSE);

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    docId: DOC_ID,
    coversSources: SOURCES,
    reviewPolicy: 'behavioral',
    bodyHash: BODY_HASH,
    semanticAttestation: BODY_HASH,
    ...overrides,
  };
}

function currentReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA,
    doc_id: DOC_ID,
    reviewed_body_hash: BODY_HASH,
    reviewed_doc_sha256: PROSE_HASH,
    covers_sources: [...SOURCES],
    verdict: 'PASS',
    reviewer: 'validate-role (independent offline review)',
    reviewed_at: '2026-07-22T00:00:00.000Z',
    notes: 'Prose matches the covered sources exactly.',
    ...overrides,
  };
}

function evaluate(doc: Record<string, unknown>, receipt: unknown, opts: { exists?: boolean; parseError?: string | null } = {}): string[] {
  return evaluateSemanticAttestation({
    doc,
    currentBodyHash: BODY_HASH,
    currentProseHash: PROSE_HASH,
    attestationExists: opts.exists ?? true,
    attestation: receipt,
    parseError: opts.parseError ?? null,
    attestationRel: `artifacts/docs-semantic/${DOC_ID.replace(/\//gu, '__')}.json`,
  });
}

void describe('C11 hardened semantic-attestation evaluator', () => {
  void it('passes for an exact, current, independently reviewed receipt', () => {
    assert.deepEqual(evaluate(baseDoc(), currentReceipt()), []);
  });

  void it('does not gate contract-policy or source-free docs', () => {
    assert.deepEqual(evaluate(baseDoc({ reviewPolicy: 'contract' }), null, { exists: false }), []);
    assert.deepEqual(evaluate(baseDoc({ coversSources: [] }), null, { exists: false }), []);
  });

  void it('rejects a mechanical restamp: body_hash refreshed but semantic_attestation stale', () => {
    // docs:attest updates body_hash to the current value but never writes
    // semantic_attestation. A source author who restamped without a review still has a
    // stale semantic_attestation and a stale receipt -> must fail loudly.
    const staleValue = sha256('covered-source-body-v0');
    const failures = evaluate(
      baseDoc({ bodyHash: BODY_HASH, semanticAttestation: staleValue }),
      currentReceipt({ reviewed_body_hash: staleValue }),
    );
    assert.ok(failures.some((f) => f.includes('semantic_attestation') && f.includes('stale review')), failures.join('\n'));
    assert.ok(failures.some((f) => f.includes('reviewed_body_hash')), failures.join('\n'));
  });

  void it('rejects when semantic_attestation is entirely missing (restamp cannot grant it)', () => {
    const failures = evaluate(baseDoc({ semanticAttestation: null }), currentReceipt());
    assert.ok(failures.some((f) => f.includes('missing frontmatter semantic_attestation')), failures.join('\n'));
  });

  void it('invalidates the receipt on a prose-only edit (reviewed_doc_sha256 binding)', () => {
    // Same sources/body hash, but the receipt was keyed to the OLD prose bytes.
    const oldProseHash = computeDocProseHash('# Example\n\nOld prose that no longer matches.\n');
    const failures = evaluate(baseDoc(), currentReceipt({ reviewed_doc_sha256: oldProseHash }));
    assert.ok(failures.some((f) => f.includes('reviewed_doc_sha256') && f.includes('prose changed')), failures.join('\n'));
  });

  void it('invalidates the receipt on a covered-source behavior edit', () => {
    // Source changed -> current body hash differs from the doc's recorded body_hash,
    // its semantic_attestation, and the receipt's reviewed_body_hash.
    const oldHash = sha256('covered-source-body-v0');
    const failures = evaluate(
      baseDoc({ bodyHash: oldHash, semanticAttestation: oldHash }),
      currentReceipt({ reviewed_body_hash: oldHash }),
    );
    assert.ok(failures.some((f) => f.includes('body_hash is stale')), failures.join('\n'));
    assert.ok(failures.some((f) => f.includes('semantic_attestation') && f.includes('stale review')), failures.join('\n'));
    assert.ok(failures.some((f) => f.includes('reviewed_body_hash')), failures.join('\n'));
  });

  void it('rejects a missing attestation artifact', () => {
    const failures = evaluate(baseDoc(), null, { exists: false });
    assert.ok(failures.some((f) => f.includes('no semantic attestation artifact')), failures.join('\n'));
  });

  void it('rejects an unparseable attestation artifact', () => {
    const failures = evaluate(baseDoc(), null, { exists: true, parseError: 'Unexpected token }' });
    assert.ok(failures.some((f) => f.includes('unparseable')), failures.join('\n'));
  });

  void it('rejects a wrong-schema receipt (v1 legacy)', () => {
    const failures = evaluate(baseDoc(), currentReceipt({ schema_version: 'autopilot.docs_semantic_attestation.v1' }));
    assert.ok(failures.some((f) => f.includes('wrong schema_version')), failures.join('\n'));
  });

  void it('rejects a wrong-doc receipt', () => {
    const failures = evaluate(baseDoc(), currentReceipt({ doc_id: 'subsystems/other' }));
    assert.ok(failures.some((f) => f.includes('wrong-doc')), failures.join('\n'));
  });

  void it('rejects a wrong-source-set receipt', () => {
    const failures = evaluate(baseDoc(), currentReceipt({ covers_sources: ['src/core/a.ts'] }));
    assert.ok(failures.some((f) => f.includes('wrong-source-set')), failures.join('\n'));
  });

  void it('rejects a non-PASS verdict', () => {
    const failures = evaluate(baseDoc(), currentReceipt({ verdict: 'FAIL' }));
    assert.ok(failures.some((f) => f.includes('not PASS')), failures.join('\n'));
  });

  void it('rejects an empty reviewer / timestamp / notes', () => {
    for (const field of ['reviewer', 'reviewed_at', 'notes']) {
      const failures = evaluate(baseDoc(), currentReceipt({ [field]: '   ' }));
      assert.ok(failures.some((f) => f.includes(`"${field}"`)), `${field}: ${failures.join('\n')}`);
    }
  });

  void it('prose hash ignores generated regions (code-only regeneration does not invalidate)', () => {
    const withRegionA = `intro\n<!-- GENERATED:commands START (source: x) -->\nA\n<!-- GENERATED:commands END -->\noutro\n`;
    const withRegionB = `intro\n<!-- GENERATED:commands START (source: x) -->\nB-different\n<!-- GENERATED:commands END -->\noutro\n`;
    assert.equal(computeDocProseHash(withRegionA), computeDocProseHash(withRegionB));
    // But an authored-prose change outside the region does move the hash.
    const proseEdit = `intro-changed\n<!-- GENERATED:commands START (source: x) -->\nA\n<!-- GENERATED:commands END -->\noutro\n`;
    assert.notEqual(computeDocProseHash(withRegionA), computeDocProseHash(proseEdit));
  });
});
