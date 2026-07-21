// Docs model loader + manifest builder.
//
// Reads every docs/**/*.md, parses + validates its frontmatter against the schema
// (design §5.1), and returns a typed in-memory model plus the canonical manifest
// object. Both the generator and the verifier consume this so there is a single
// definition of "what the docs declare". Parse/schema failures throw (C0: never skip).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  DOCS_DIR,
  DOC_MODES,
  MANIFEST_SCHEMA,
  PACKAGE_ROOT,
  REVIEW_POLICIES,
  STABILITY_VALUES,
} from './config.mjs';
import { DocFrontmatterError, parseFrontmatter, splitFrontmatter } from './frontmatter.mjs';

// Canonical frontmatter key order (drives byte-stable re-stamps + serialization).
export const FRONTMATTER_KEY_ORDER = Object.freeze([
  'doc_id',
  'mode',
  'review_policy',
  'covers_surfaces',
  'covers_sources',
  'signature_hash',
  'body_hash',
  'semantic_attestation',
  'fact_pins',
  'stability',
]);

const REQUIRED_KEYS = Object.freeze(['doc_id', 'mode', 'review_policy', 'covers_surfaces', 'covers_sources', 'stability']);
const OPTIONAL_KEYS = Object.freeze(['signature_hash', 'body_hash', 'semantic_attestation', 'fact_pins']);
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

function listMarkdownDocs() {
  const root = resolve(PACKAGE_ROOT, DOCS_DIR);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function assertStringArray(value, key, location) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new DocFrontmatterError(`"${key}" must be a non-empty array of non-empty strings`, location);
  }
  return value;
}

function validateFactPins(value, location) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DocFrontmatterError('"fact_pins" must be a list', location);
  return value.map((pin, index) => {
    if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) {
      throw new DocFrontmatterError(`fact_pins[${String(index)}] must be a map`, location);
    }
    for (const requiredKey of ['symbol', 'expect']) {
      if (!Object.prototype.hasOwnProperty.call(pin, requiredKey)) {
        throw new DocFrontmatterError(`fact_pins[${String(index)}] is missing "${requiredKey}"`, location);
      }
    }
    return Object.freeze({ ...pin });
  });
}

/** Parse + validate one doc file into a model entry. */
function loadDoc(absolutePath) {
  const location = relative(PACKAGE_ROOT, absolutePath);
  const text = readFileSync(absolutePath, 'utf8');
  const { frontmatterText, body, hasFrontmatter } = splitFrontmatter(text, location);
  if (!hasFrontmatter) {
    throw new DocFrontmatterError('doc is missing required "---" YAML frontmatter', location);
  }
  const frontmatter = parseFrontmatter(frontmatterText, location);

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_KEYS.has(key)) throw new DocFrontmatterError(`unknown frontmatter key "${key}"`, location);
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      throw new DocFrontmatterError(`missing required frontmatter key "${key}"`, location);
    }
  }

  const docId = frontmatter.doc_id;
  if (typeof docId !== 'string' || docId.length === 0) throw new DocFrontmatterError('"doc_id" must be a non-empty string', location);
  const expectedDocId = relative(resolve(PACKAGE_ROOT, DOCS_DIR), absolutePath).replace(/\.md$/u, '');
  if (docId !== expectedDocId) {
    throw new DocFrontmatterError(`"doc_id" is "${docId}" but must equal the path under docs/ without extension: "${expectedDocId}"`, location);
  }

  if (!DOC_MODES.includes(frontmatter.mode)) throw new DocFrontmatterError(`"mode" must be one of ${DOC_MODES.join(', ')}`, location);
  if (!REVIEW_POLICIES.includes(frontmatter.review_policy)) throw new DocFrontmatterError(`"review_policy" must be one of ${REVIEW_POLICIES.join(', ')}`, location);
  if (!STABILITY_VALUES.includes(frontmatter.stability)) throw new DocFrontmatterError(`"stability" must be one of ${STABILITY_VALUES.join(', ')}`, location);

  const coversSurfaces = assertStringArray(frontmatter.covers_surfaces, 'covers_surfaces', location);
  const coversSources = frontmatter.covers_sources;
  if (!Array.isArray(coversSources) || coversSources.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new DocFrontmatterError('"covers_sources" must be an array (possibly empty) of non-empty strings', location);
  }
  const factPins = validateFactPins(frontmatter.fact_pins, location);

  for (const hashKey of ['signature_hash', 'body_hash', 'semantic_attestation']) {
    const value = frontmatter[hashKey];
    if (value !== undefined && (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value))) {
      throw new DocFrontmatterError(`"${hashKey}" must be a "sha256:<64 hex>" string when present`, location);
    }
  }

  // NOTE: presence of signature_hash/body_hash for TS-covering docs is enforced by
  // C4 (the fence), NOT here. Keeping C0 tolerant of absent hashes lets `docs:attest`
  // stamp a freshly-authored doc before the first verify, avoiding a chicken-and-egg
  // bootstrap. C0 still rejects a malformed hash string above.
  return Object.freeze({
    location,
    docId,
    mode: frontmatter.mode,
    reviewPolicy: frontmatter.review_policy,
    coversSurfaces: Object.freeze([...coversSurfaces]),
    coversSources: Object.freeze([...coversSources]),
    signatureHash: frontmatter.signature_hash ?? null,
    bodyHash: frontmatter.body_hash ?? null,
    semanticAttestation: frontmatter.semantic_attestation ?? null,
    factPins: Object.freeze(factPins),
    stability: frontmatter.stability,
    frontmatter: Object.freeze({ ...frontmatter }),
    body,
    rawText: text,
  });
}

/** Load + validate every governed doc. Throws on the first schema violation (C0). */
export function loadDocsModel() {
  const docs = listMarkdownDocs().map((path) => loadDoc(path));
  const byId = new Map();
  for (const doc of docs) {
    if (byId.has(doc.docId)) throw new DocFrontmatterError(`duplicate doc_id "${doc.docId}"`, doc.location);
    byId.set(doc.docId, doc);
  }
  return { docs, byId };
}

/**
 * Build the canonical manifest object from the docs model. This is the single
 * program-consumed navigation + coverage index (design §5.2). It is deterministic:
 * all maps are emitted with sorted keys/arrays.
 */
export function buildManifest(model, coverageState) {
  const coverageFloor = typeof coverageState === 'number' ? coverageState : coverageState.floor;
  const fullCoverageRequired = typeof coverageState === 'number' ? false : coverageState.fullCoverageRequired === true;
  const surfaceToDocs = new Map();
  const sourceToDocs = new Map();
  const docEntries = {};

  for (const doc of [...model.docs].sort((a, b) => (a.docId < b.docId ? -1 : 1))) {
    for (const surface of doc.coversSurfaces) {
      if (!surfaceToDocs.has(surface)) surfaceToDocs.set(surface, new Set());
      surfaceToDocs.get(surface).add(doc.docId);
    }
    for (const source of doc.coversSources) {
      if (!sourceToDocs.has(source)) sourceToDocs.set(source, new Set());
      sourceToDocs.get(source).add(doc.docId);
    }
    docEntries[doc.docId] = {
      mode: doc.mode,
      review_policy: doc.reviewPolicy,
      stability: doc.stability,
      covers_surfaces: [...doc.coversSurfaces].sort(),
      covers_sources: [...doc.coversSources].sort(),
      signature_hash: doc.signatureHash,
      body_hash: doc.bodyHash,
      semantic_attestation: doc.semanticAttestation,
    };
  }

  const sortedRecord = (map) => {
    const out = {};
    for (const key of [...map.keys()].sort()) out[key] = [...map.get(key)].sort();
    return out;
  };

  return {
    schema_version: MANIFEST_SCHEMA,
    generator: 'scripts/docs-generate.mjs',
    coverage_floor: coverageFloor,
    full_coverage_required: fullCoverageRequired,
    surface_to_docs: sortedRecord(surfaceToDocs),
    source_to_docs: sortedRecord(sourceToDocs),
    docs: sortObjectKeys(docEntries),
  };
}

function sortObjectKeys(record) {
  const out = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/** Canonical JSON serialization used for manifest byte-equality (C7). */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Build the source→docs map (for the read-before-edit region). */
export function sourceToDocsMap(model) {
  const map = new Map();
  for (const doc of model.docs) {
    for (const source of doc.coversSources) {
      if (!map.has(source)) map.set(source, []);
      map.get(source).push(doc.docId);
    }
  }
  for (const [source, docs] of map) map.set(source, [...new Set(docs)].sort());
  return map;
}
