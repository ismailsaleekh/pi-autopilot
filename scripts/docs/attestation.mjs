// Pure, deterministic C11 semantic-attestation evaluator (design D67, hardened
// Phase 39). Extracted from docs-verify.mjs so the fail-closed contract is unit
// testable in isolation with no filesystem, network, model, or time.
//
// FAIL-CLOSED CONTRACT
//   Every `review_policy: behavioral` doc with covered sources must carry a CURRENT,
//   independently produced review receipt whose currency is bound to BOTH:
//     (a) the covered-source body hash          -> a behavior edit invalidates it, and
//     (b) the authored document-prose hash       -> a prose-only edit invalidates it.
//   The frontmatter `semantic_attestation` is the review-owned copy of the current
//   covered-source body hash. `docs:attest` (restamp) updates the MECHANICAL body_hash
//   but NEVER writes semantic_attestation, so a restamp alone can never clear C11.
//
//   The machine proves receipt currency + shape ONLY. Reviewer independence is a
//   procedural requirement; this evaluator does not and cannot claim to prove it.

import { ATTESTATION_SCHEMA } from './config.mjs';

/**
 * @typedef {object} AttestationInput
 * @property {{ docId: string, coversSources: readonly string[], reviewPolicy: string, bodyHash: string|null, semanticAttestation: string|null }} doc
 * @property {string} currentBodyHash   current covered-source body hash (sha256:…)
 * @property {string} currentProseHash  current authored-prose hash (sha256:…)
 * @property {boolean} attestationExists whether the artifact file is present
 * @property {unknown} attestation      parsed artifact JSON, or null if missing/unparseable
 * @property {string|null} [parseError] a parse-error message when the artifact was unparseable
 * @property {string} attestationRel    the artifact's package-relative path (for messages)
 */

/**
 * Evaluate C11 for a single doc. Returns an array of human-readable failure messages
 * (empty === the doc's semantic receipt is current, well-formed, and PASS).
 * @param {AttestationInput} input
 * @returns {string[]}
 */
export function evaluateSemanticAttestation(input) {
  const { doc, currentBodyHash, currentProseHash, attestationExists, attestation, parseError, attestationRel } = input;
  const failures = [];

  // Only behavioral docs with covered sources are gated by C11.
  if (doc.reviewPolicy !== 'behavioral' || doc.coversSources.length === 0) return failures;

  // (1a) frontmatter body_hash must equal the current covered-source body hash.
  if (doc.bodyHash === null) {
    failures.push('behavioral doc with covered sources has no body_hash; run "npm run docs:attest" after an independent review');
  } else if (doc.bodyHash !== currentBodyHash) {
    failures.push(`body_hash is stale: covered-source behavior changed (expected ${currentBodyHash}, got ${doc.bodyHash}). Re-review then run "npm run docs:attest".`);
  }

  // (1b) frontmatter semantic_attestation is the review-owned currency proof. docs:attest
  // never writes it, so it can only reach the current value through a real review.
  if (doc.semanticAttestation === null) {
    failures.push(`missing frontmatter semantic_attestation; an independent review must record the current covered-source body hash (${currentBodyHash})`);
  } else if (doc.semanticAttestation !== currentBodyHash) {
    failures.push(`semantic_attestation ${doc.semanticAttestation} != current covered-source body hash ${currentBodyHash} (stale review; docs:attest cannot refresh semantic authority)`);
  }

  // (2) the attestation artifact itself.
  if (!attestationExists) {
    failures.push(`no semantic attestation artifact at ${attestationRel} (an independent review must produce it)`);
    return failures;
  }
  if (attestation === null || typeof attestation !== 'object') {
    failures.push(`semantic attestation is unparseable: ${parseError ?? 'not a JSON object'}`);
    return failures;
  }

  const record = /** @type {Record<string, unknown>} */ (attestation);
  if (record.schema_version !== ATTESTATION_SCHEMA) {
    failures.push(`semantic attestation has wrong schema_version (${String(record.schema_version)}); expected ${ATTESTATION_SCHEMA}`);
  }
  if (record.doc_id !== doc.docId) {
    failures.push(`semantic attestation is for doc_id "${String(record.doc_id)}", not "${doc.docId}" (wrong-doc artifact)`);
  }
  if (record.reviewed_body_hash !== currentBodyHash) {
    failures.push(`reviewed_body_hash ${String(record.reviewed_body_hash)} != current covered-source body hash ${currentBodyHash} (source changed since review)`);
  }
  if (record.reviewed_doc_sha256 !== currentProseHash) {
    failures.push(`reviewed_doc_sha256 ${String(record.reviewed_doc_sha256)} != current authored-prose hash ${currentProseHash} (doc prose changed since review)`);
  }
  const attestedSources = Array.isArray(record.covers_sources) ? [...record.covers_sources].sort() : null;
  const docSources = [...doc.coversSources].sort();
  if (attestedSources === null || attestedSources.length !== docSources.length || attestedSources.some((source, index) => source !== docSources[index])) {
    failures.push('covers_sources in the attestation do not exactly match the doc\'s covered sources (wrong-source-set)');
  }
  if (record.verdict !== 'PASS') {
    failures.push(`semantic attestation verdict is "${String(record.verdict)}", not PASS`);
  }
  for (const field of ['reviewer', 'reviewed_at', 'notes']) {
    if (typeof record[field] !== 'string' || record[field].trim().length === 0) {
      failures.push(`semantic attestation "${field}" must be a bounded non-empty string`);
    }
  }
  return failures;
}
