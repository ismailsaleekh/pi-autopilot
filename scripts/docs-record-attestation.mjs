#!/usr/bin/env node
// Record a semantic-review receipt for one behavioral doc (design D67, Phase 39 C11).
//
// This is the REVIEW-OWNED half of the docs freshness gate. It is deliberately NOT
// `docs:attest` (which only restamps mechanical signature_hash/body_hash). This tool:
//   1. computes the current covered-source body hash and authored-prose hash,
//   2. writes an `autopilot.docs_semantic_attestation.v2` receipt binding BOTH hashes,
//      the exact doc_id + covers_sources, the verdict, and bounded reviewer/notes,
//   3. stamps the doc frontmatter `semantic_attestation` to the current body hash.
//
// It refuses to write anything unless a real independent verdict + notes are provided
// on the command line, so the machine cannot self-certify. The reviewer identity /
// notes / verdict are the human/agentic review's own words; the hashes are mechanical.
//
// Usage:
//   node scripts/docs-record-attestation.mjs \
//     --doc <doc_id> --verdict PASS \
//     --reviewer "<identity>" --reviewed-at <iso8601> \
//     --notes "<why the prose matches the covered sources>"
//
// A FAIL verdict writes the receipt (so the failure is durable) but leaves the doc's
// semantic_attestation UNSET, so C11 keeps failing until a real PASS review lands.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ATTESTATION_DIR, ATTESTATION_SCHEMA, PACKAGE_ROOT } from './docs/config.mjs';
import { computeCoverHashes, computeDocProseHash } from './docs/hashing.mjs';
import { composeDoc, serializeFrontmatter, splitFrontmatter } from './docs/frontmatter.mjs';
import { FRONTMATTER_KEY_ORDER, loadDocsModel } from './docs/model.mjs';

function fail(message) {
  console.error(`docs-record-attestation: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) fail(`option ${String(key)} requires a value`);
    if (key === '--doc') out.doc = value;
    else if (key === '--verdict') out.verdict = value;
    else if (key === '--reviewer') out.reviewer = value;
    else if (key === '--reviewed-at') out.reviewedAt = value;
    else if (key === '--notes') out.notes = value;
    else fail(`unknown option ${String(key)}`);
  }
  for (const required of ['doc', 'verdict', 'reviewer', 'reviewedAt', 'notes']) {
    if (typeof out[required] !== 'string' || out[required].trim().length === 0) fail(`--${required === 'reviewedAt' ? 'reviewed-at' : required} is required and must be non-empty`);
  }
  if (out.verdict !== 'PASS' && out.verdict !== 'FAIL') fail('--verdict must be exactly PASS or FAIL');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(out.reviewedAt)) fail('--reviewed-at must be an ISO-8601 UTC millisecond timestamp');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = loadDocsModel();
  const doc = model.byId.get(args.doc);
  if (doc === undefined) fail(`no such doc_id: ${args.doc}`);
  if (doc.reviewPolicy !== 'behavioral') fail(`doc ${args.doc} is not review_policy: behavioral (C11 does not gate it)`);
  if (doc.coversSources.length === 0) fail(`doc ${args.doc} has no covers_sources`);

  const hashes = computeCoverHashes(doc.coversSources);
  const proseHash = computeDocProseHash(doc.body);

  const receipt = {
    schema_version: ATTESTATION_SCHEMA,
    doc_id: doc.docId,
    reviewed_body_hash: hashes.bodyHash,
    reviewed_doc_sha256: proseHash,
    covers_sources: [...doc.coversSources].sort(),
    verdict: args.verdict,
    reviewer: args.reviewer,
    reviewed_at: args.reviewedAt,
    notes: args.notes,
  };

  const dir = resolve(PACKAGE_ROOT, ATTESTATION_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const artifactPath = resolve(dir, `${doc.docId.replace(/\//gu, '__')}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`wrote ${ATTESTATION_DIR}/${doc.docId.replace(/\//gu, '__')}.json (verdict=${args.verdict})`);

  // Stamp frontmatter semantic_attestation ONLY on a PASS. This is the review-owned
  // currency proof C11 checks; docs:attest never writes it.
  if (args.verdict === 'PASS') {
    const absolute = resolve(PACKAGE_ROOT, doc.location);
    const raw = readFileSync(absolute, 'utf8');
    const { body } = splitFrontmatter(raw, doc.location);
    const nextFrontmatter = { ...doc.frontmatter, semantic_attestation: hashes.bodyHash };
    const frontmatterText = serializeFrontmatter(nextFrontmatter, FRONTMATTER_KEY_ORDER);
    writeFileSync(absolute, composeDoc(frontmatterText, body), 'utf8');
    console.log(`stamped semantic_attestation=${hashes.bodyHash} in ${doc.location}`);
  } else {
    console.log('FAIL verdict: semantic_attestation left unset; C11 will keep failing until a PASS review lands.');
  }
}

main();
