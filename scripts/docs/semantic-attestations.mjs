// Deterministic semantic-attestation validation for C11.
//
// The gate cannot produce an independent semantic review (that is agentic), but it
// can deterministically require and validate the current receipt whenever a
// behavioral doc is triggered, and it can reject any stale receipt that exists.

import { ATTESTATION_SCHEMA } from './config.mjs';

function artifactName(docId) {
  return `${docId.replace(/\//gu, '__')}.json`;
}

function sortedStrings(values) {
  return [...values].sort();
}

function sameStringSet(left, right) {
  if (!Array.isArray(right) || right.some((item) => typeof item !== 'string' || item.length === 0)) return false;
  const a = sortedStrings(left);
  const b = sortedStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * C11 trigger: a behavioral doc in the current change, or any source-body drift
 * against the frontmatter hash. Existing v2 artifacts/frontmatter receipts are always
 * validated too so a stale receipt cannot sit in-tree silently.
 *
 * @param {{ docId: string, location: string, reviewPolicy: string, coversSources: readonly string[], bodyHash: string | null }} doc
 * @param {{ bodyHash: string }} hashes
 * @param {{ known: boolean, files: Set<string> }} git
 * @returns {{ required: boolean, reason: string | null }}
 */
export function semanticAttestationRequirement(doc, hashes, git) {
  if (doc.reviewPolicy !== 'behavioral' || doc.coversSources.length === 0) return { required: false, reason: null };
  if (doc.bodyHash !== hashes.bodyHash) return { required: true, reason: `covered source body changed; current body_hash is ${hashes.bodyHash}` };
  if (git.known && git.files.has(doc.location)) return { required: true, reason: 'behavioral doc prose changed in this change' };
  return { required: false, reason: null };
}

/**
 * @param {{ docId: string, coversSources: readonly string[], semanticAttestation?: string | null }} doc
 * @param {{ bodyHash: string, docProseHash?: string, proseHash?: string }} hashes
 * @param {unknown} attestation
 * @returns {readonly string[]}
 */
export function validateSemanticAttestation(doc, hashes, attestation) {
  const failures = [];
  if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return ['semantic attestation must be a JSON object'];
  }
  const record = /** @type {Readonly<Record<string, unknown>>} */ (attestation);
  const proseHash = hashes.docProseHash ?? hashes.proseHash ?? null;
  if (record.schema_version !== ATTESTATION_SCHEMA) failures.push(`semantic attestation has wrong schema_version (${String(record.schema_version)}); expected ${ATTESTATION_SCHEMA}`);
  if (record.doc_id !== doc.docId) failures.push(`semantic attestation doc_id ${String(record.doc_id)} != ${doc.docId}`);
  if (record.reviewed_body_hash !== hashes.bodyHash) failures.push(`semantic attestation reviewed_body_hash ${String(record.reviewed_body_hash)} != current ${hashes.bodyHash} (stale review)`);
  if (proseHash === null) failures.push('semantic attestation validation requires the current authored-prose hash');
  else if (record.reviewed_doc_sha256 !== proseHash) failures.push(`semantic attestation reviewed_doc_sha256 ${String(record.reviewed_doc_sha256)} != current ${proseHash} (stale prose review)`);
  if (doc.semanticAttestation !== undefined && doc.semanticAttestation !== null && doc.semanticAttestation !== hashes.bodyHash) failures.push(`frontmatter semantic_attestation ${doc.semanticAttestation} != current ${hashes.bodyHash} (stale review)`);
  if (record.verdict !== 'PASS') failures.push(`semantic attestation verdict is "${String(record.verdict)}", not PASS`);
  if (!sameStringSet(doc.coversSources, record.covers_sources)) failures.push('semantic attestation covers_sources do not match current doc covers_sources');
  if (typeof record.reviewer !== 'string' || record.reviewer.trim().length === 0) failures.push('semantic attestation reviewer must be a non-empty string');
  if (typeof record.reviewed_at !== 'string' || record.reviewed_at.trim().length === 0) failures.push('semantic attestation reviewed_at must be a non-empty string');
  if (typeof record.notes !== 'string' || record.notes.trim().length === 0) failures.push('semantic attestation notes must be a non-empty string');
  return failures;
}

export function semanticAttestationArtifactName(docId) {
  return artifactName(docId);
}
