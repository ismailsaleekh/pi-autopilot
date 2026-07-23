#!/usr/bin/env node
// Autopilot deterministic docs-freshness verifier — checks C0–C11 (design §9).
//
// Every check is pure, offline, and deterministic (no model, network, time, or
// randomness). Every failure names the exact doc + exact surface + expected/actual.
// There is no skip-on-error path: an unparseable doc or unresolved reference is a
// hard failure (F.silent_fallback is banned).
//
// Modes:
//   node scripts/docs-verify.mjs            run C0–C11 in check mode (default)
//   node scripts/docs-verify.mjs --write    BOUNDED re-stamp: recompute signature_hash
//                                           + body_hash for every doc and rebuild
//                                           manifest.json (ratcheting the coverage
//                                           floor). It NEVER invents covers_surfaces
//                                           and NEVER silences C1/C3/C8.
//   node scripts/docs-verify.mjs --json     machine-readable result
//
// C11's ENFORCEMENT (a current semantic attestation must exist for every triggered
// behavioral doc, and any existing stale receipt is rejected) is deterministic here;
// the PRODUCTION of that attestation is a separate, agentic, offline validate-role
// review recorded under artifacts/docs-semantic/.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  ATTESTATION_DIR,
  GATEWAY_PATH,
  MANIFEST_PATH,
  PACKAGE_ROOT,
  README_PATH,
  STALE_PHRASES,
  STATE_ROOT_LITERAL,
  STATE_ROOT_SOURCE,
  SURFACE_EXPORTER_FILES,
} from './docs/config.mjs';
import { DocFrontmatterError, composeDoc, serializeFrontmatter, splitFrontmatter } from './docs/frontmatter.mjs';
import { enumerateSurfaces, loadCodeSurfaces } from './docs/code-surfaces.mjs';
import { FRONTMATTER_KEY_ORDER, buildManifest, loadDocsModel, serializeManifest, sourceToDocsMap } from './docs/model.mjs';
import { computeCoverHashes, computeDocProseHash } from './docs/hashing.mjs';
import { evaluateSemanticAttestation } from './docs/attestation.mjs';
import { evaluateFactPins } from './docs/fact-pins.mjs';
import { checkReferences, resolveLinks } from './docs/references.mjs';
import { findMarkerAnomalies, findRegions, renderClis, renderCommands, renderDefaults, renderModelRoster, renderReadBeforeEdit, renderRuntimePaths, renderSchemas, renderTools, wrapRegion } from './docs/regions.mjs';
import { semanticAttestationArtifactName, semanticAttestationRequirement } from './docs/semantic-attestations.mjs';

const REGION_RENDERERS = {
  commands: renderCommands,
  tools: renderTools,
  clis: renderClis,
  schemas: renderSchemas,
  'model-roster': renderModelRoster,
  defaults: renderDefaults,
  'runtime-paths': renderRuntimePaths,
};

class Findings {
  constructor() {
    this.items = [];
  }

  add(check, location, message) {
    this.items.push({ check, location, message });
  }

  get failed() {
    return this.items.length > 0;
  }
}

function listChangedFilesInHead() {
  // Files changed by the most recent commit (when a parent commit exists) plus the
  // working tree + index, used by C4's git-aware anti-self-certification guard. When
  // git or history is unavailable the guard is simply skipped — the PRIMARY C4
  // signature-stale error still hard-blocks regardless, so a re-stamp can never slip
  // through; the guard only ADDS an explicit self-certification callout when git can
  // confirm the doc body was untouched in the same change.
  const collect = (args) => {
    try {
      return execFileSync('git', args, { cwd: PACKAGE_ROOT, encoding: 'utf8' }).split('\n').filter((line) => line.length > 0);
    } catch {
      return null;
    }
  };
  const working = collect(['diff', '--name-only', 'HEAD']);
  const staged = collect(['diff', '--name-only', '--cached']);
  if (working === null && staged === null) return { known: false, files: new Set() };
  const committed = collect(['diff', '--name-only', 'HEAD~1', 'HEAD']) ?? [];
  return { known: true, files: new Set([...committed, ...(working ?? []), ...(staged ?? [])]) };
}

async function run() {
  const write = process.argv.includes('--write');
  const json = process.argv.includes('--json');
  const findings = new Findings();

  // ---- C0: parse-or-die frontmatter (FM12) ---------------------------------
  let model;
  try {
    model = loadDocsModel();
  } catch (error) {
    if (error instanceof DocFrontmatterError) {
      findings.add('C0', error.location ?? 'docs/', error.message);
      return report(findings, json);
    }
    throw error;
  }

  const surfaces = await loadCodeSurfaces();
  const surfaceSet = enumerateSurfaces(surfaces);
  const sourceToDocs = sourceToDocsMap(model);

  // ---- --write: bounded re-stamp of hashes + manifest ----------------------
  if (write) {
    return await restamp(model, surfaces);
  }

  // ---- C1: surface enumeration (constants + AST cross-check, FM1) -----------
  const coveredSurfaces = new Set();
  for (const doc of model.docs) for (const surface of doc.coversSurfaces) coveredSurfaces.add(surface);
  for (const surface of surfaceSet) {
    if (!coveredSurfaces.has(surface)) {
      findings.add('C1', 'docs/', `code surface "${surface}" is not covered by any doc's covers_surfaces`);
    }
  }
  for (const doc of model.docs) {
    for (const surface of doc.coversSurfaces) {
      if (!surfaceSet.has(surface)) {
        findings.add('C1', doc.location, `covers_surfaces entry "${surface}" is not a real code surface (surface set: commands, tools, bins, schemas)`);
      }
    }
  }

  // ---- C2: generated-region byte-equality (FM1/FM2/FM7/FM14) ---------------
  for (const doc of model.docs) {
    const anomalies = findMarkerAnomalies(doc.body);
    for (const anomaly of anomalies) findings.add('C2', doc.location, anomaly);
    for (const region of findRegions(doc.body)) {
      const renderer = region.id === 'read-before-edit'
        ? () => renderReadBeforeEdit(sourceToDocs)
        : REGION_RENDERERS[region.id];
      if (renderer === undefined) {
        findings.add('C2', doc.location, `unknown GENERATED region id "${region.id}"`);
        continue;
      }
      const expected = wrapRegion(region.id, renderer(surfaces));
      const actual = doc.body.slice(region.start, region.end);
      if (expected !== actual) {
        findings.add('C2', doc.location, `GENERATED:${region.id} is stale; run "npm run docs:generate" (byte mismatch vs code)`);
      }
    }
  }

  // ---- C3: reference existence (FM2/FM5) -----------------------------------
  for (const doc of model.docs) {
    for (const failure of checkReferences(doc)) findings.add('C3', doc.location, failure);
  }
  // The runtime-paths generated region embeds the default state root; assert the
  // exact source literal still exists so a moved default fails loud (FM7/FM2).
  const stateRootSource = readFileSync(resolve(PACKAGE_ROOT, STATE_ROOT_SOURCE), 'utf8');
  if (!stateRootSource.includes(STATE_ROOT_LITERAL)) {
    findings.add('C3', STATE_ROOT_SOURCE, `default state-root literal ${STATE_ROOT_LITERAL} no longer exists; the runtime-paths region is stale`);
  }

  // ---- C4: signature fence + git-aware body-change guard (FM3 trigger) ------
  const git = listChangedFilesInHead();
  for (const doc of model.docs) {
    if (doc.coversSources.length === 0) continue;
    let hashes;
    try {
      hashes = computeCoverHashes(doc.coversSources);
    } catch (error) {
      findings.add('C4', doc.location, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (doc.signatureHash === null) {
      findings.add('C4', doc.location, 'covers_sources present but signature_hash is unset; run "npm run docs:attest"');
      continue;
    }
    if (doc.signatureHash !== hashes.signatureHash) {
      findings.add('C4', doc.location, `signature_hash is stale (contract of covers_sources changed). Update prose + run "npm run docs:attest". expected ${hashes.signatureHash} got ${doc.signatureHash}`);
      // Anti-self-certification: a signature change must be accompanied by a body edit.
      if (git.known && !git.files.has(doc.location)) {
        findings.add('C4', doc.location, 'signature changed but the doc body was NOT edited in this change — re-stamping without re-reading is forbidden (self-certification guard)');
      }
    }
  }

  // ---- C5: fact-pins (FM7) --------------------------------------------------
  for (const doc of model.docs) {
    for (const failure of await evaluateFactPins(doc)) findings.add('C5', doc.location, failure);
  }

  // ---- C6: link/anchor resolution (FM4/FM8) --------------------------------
  const anchorCache = new Map();
  for (const doc of model.docs) {
    for (const failure of resolveLinks(doc.location, doc.body, anchorCache)) findings.add('C6', doc.location, failure);
  }
  for (const hubPath of [README_PATH, GATEWAY_PATH]) {
    const absolute = resolve(PACKAGE_ROOT, hubPath);
    if (!existsSync(absolute)) {
      findings.add('C6', hubPath, `${hubPath === GATEWAY_PATH ? 'gateway' : 'README hub'} is missing`);
      continue;
    }
    for (const failure of resolveLinks(hubPath, readFileSync(absolute, 'utf8'), anchorCache)) findings.add('C6', hubPath, failure);
  }

  // ---- C7: manifest equality + no duplicate generated ownership (FM6/FM13) --
  const manifestAbsolute = resolve(PACKAGE_ROOT, MANIFEST_PATH);
  const currentManifestText = existsSync(manifestAbsolute) ? readFileSync(manifestAbsolute, 'utf8') : '';
  let coverageFloor = 0;
  let fullCoverageRequired = false;
  try {
    const parsed = JSON.parse(currentManifestText);
    if (typeof parsed.coverage_floor === 'number') coverageFloor = parsed.coverage_floor;
    if (parsed.full_coverage_required === true) fullCoverageRequired = true;
  } catch {
    coverageFloor = 0;
  }
  const rebuiltManifest = serializeManifest(buildManifest(model, { floor: coverageFloor, fullCoverageRequired }));
  if (rebuiltManifest !== currentManifestText) {
    findings.add('C7', MANIFEST_PATH, 'manifest.json does not equal a fresh rebuild from frontmatter; run "npm run docs:attest"');
  }
  const generatedOwners = new Map();
  for (const doc of model.docs) {
    for (const region of findRegions(doc.body)) {
      if (region.id === 'read-before-edit') continue;
      if (generatedOwners.has(region.id)) {
        findings.add('C7', doc.location, `GENERATED:${region.id} is also emitted by ${generatedOwners.get(region.id)} — a generated region must have exactly one owning doc`);
      } else {
        generatedOwners.set(region.id, doc.location);
      }
    }
  }

  // ---- C8: coverage completeness from the code-computed boundary set --------
  // The boundary is computed from code (surface-exporter files, CLI entrypoints,
  // subsystem barrels). Coverage is enforced against a MONOTONIC floor stored in the
  // manifest: it may only ratchet up (a regression is a hard error), and when the
  // floor reaches the boundary size, 100% coverage becomes mandatory. Uncovered
  // boundary files below the floor are surfaced as migration guidance, not errors,
  // so migration proceeds one cluster per PR without a big-bang (design §14).
  const boundary = computeBoundarySet();
  const coveredSources = new Set();
  for (const doc of model.docs) for (const source of doc.coversSources) coveredSources.add(source);
  let boundaryCovered = 0;
  const uncovered = [];
  for (const boundaryFile of [...boundary].sort()) {
    if (coveredSources.has(boundaryFile) || isTransitivelyCovered(boundaryFile, coveredSources)) boundaryCovered += 1;
    else uncovered.push(boundaryFile);
  }
  if (boundaryCovered < coverageFloor) {
    findings.add('C8', MANIFEST_PATH, `coverage regressed: ${String(boundaryCovered)} boundary files covered but the manifest floor is ${String(coverageFloor)} (floor may only ratchet up). Run "npm run docs:attest" only after restoring coverage.`);
  }
  // Once full coverage has been reached (recorded in the manifest), it is a HARD
  // invariant: any NEW uncovered boundary file (e.g. a brand-new subsystem barrel or
  // CLI entrypoint) fails loudly until documented. This is what makes "add a new
  // surface -> a doc is required" mechanical rather than advisory.
  if (fullCoverageRequired && uncovered.length > 0) {
    for (const boundaryFile of uncovered) {
      findings.add('C8', boundaryFile, 'new boundary source has no owning doc; full docs coverage is required (add it to a subsystem/cli/command doc covers_sources)');
    }
  }
  // Every doc must be in the manifest (orphan detection, FM9).
  let manifestDocs = {};
  try {
    manifestDocs = JSON.parse(currentManifestText).docs ?? {};
  } catch {
    manifestDocs = {};
  }
  for (const doc of model.docs) {
    if (!Object.prototype.hasOwnProperty.call(manifestDocs, doc.docId)) {
      findings.add('C8', doc.location, `doc "${doc.docId}" is not present in manifest.json (orphan)`);
    }
  }

  // ---- C9: stale-phrase blocklist (FM2) ------------------------------------
  for (const doc of model.docs) {
    for (const phrase of STALE_PHRASES) {
      // Skip generated regions (they never contain prose) and only scan authored prose.
      const prose = stripGeneratedRegions(doc.body);
      const index = prose.toLowerCase().indexOf(phrase.toLowerCase());
      if (index !== -1) findings.add('C9', doc.location, `contains banned stale phrase "${phrase}"`);
    }
  }

  // ---- C10: payload parity -------------------------------------------------
  for (const failure of checkPayloadParity()) findings.add('C10', 'package.json', failure);

  // ---- C11: semantic-attestation currency + prose binding (FM3/FM11) --------
  //
  // FAIL-CLOSED CONTRACT (design D67, hardened Phase 39):
  //   Every triggered `review_policy: behavioral` doc with covered sources, plus any
  //   doc that already carries a receipt/frontmatter semantic_attestation, must carry a
  //   CURRENT, independently produced review receipt. "Current" is bound to BOTH:
  //     (a) the covered-source body hash  -> a behavior edit invalidates the receipt, and
  //     (b) the authored document-prose hash (generated regions stripped)
  //         -> a prose-only edit ALSO invalidates the receipt.
  //   The frontmatter `semantic_attestation` is the review-owned copy of the current
  //   covered-source body hash: `docs:attest` (restamp) updates the MECHANICAL body_hash
  //   but NEVER writes `semantic_attestation`, so a restamp alone cannot clear this gate.
  //   The machine proves receipt currency + shape ONLY; reviewer independence remains a
  //   procedural requirement (it cannot and does not claim to prove independence).
  for (const doc of model.docs) {
    if (doc.reviewPolicy !== 'behavioral' || doc.coversSources.length === 0) continue;
    let hashes;
    try {
      hashes = computeCoverHashes(doc.coversSources);
    } catch {
      continue; // covered-source read failure already reported by C4
    }
    const artifactName = semanticAttestationArtifactName(doc.docId);
    const attestationRel = `${ATTESTATION_DIR}/${artifactName}`;
    const attestationPath = resolve(PACKAGE_ROOT, attestationRel);
    const requirement = semanticAttestationRequirement(doc, hashes, git);
    const attestationExists = existsSync(attestationPath);
    if (!requirement.required && !attestationExists && doc.semanticAttestation === null) continue;
    if (requirement.required && !attestationExists) {
      findings.add('C11', doc.location, `behavioral doc requires a current independent semantic attestation (${requirement.reason}) at ${attestationRel}`);
    }
    let attestation = null;
    let parseError = null;
    if (attestationExists) {
      try {
        attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const message of evaluateSemanticAttestation({
      doc: { docId: doc.docId, coversSources: doc.coversSources, reviewPolicy: doc.reviewPolicy, bodyHash: doc.bodyHash, semanticAttestation: doc.semanticAttestation },
      currentBodyHash: hashes.bodyHash,
      currentProseHash: computeDocProseHash(doc.body),
      attestationExists,
      attestation,
      parseError,
      attestationRel,
    })) {
      findings.add('C11', doc.location, message);
    }
  }

  return report(findings, json);
}

function stripGeneratedRegions(body) {
  return body.replace(/<!-- GENERATED:[a-z-]+ START[\s\S]*?<!-- GENERATED:[a-z-]+ END -->/gu, '');
}

function computeBoundarySet() {
  // The "must-document" boundary is computed FROM CODE so a genuinely new surface
  // exporter, CLI entrypoint, or subsystem barrel is automatically required to have a
  // doc (design section 4/17). Nothing here is a hardcoded doc list.
  const boundary = new Set(SURFACE_EXPORTER_FILES);
  // Every CLI entrypoint: src/cli/*.ts (excluding *.d.ts).
  const cliDir = resolve(PACKAGE_ROOT, 'src/cli');
  if (existsSync(cliDir)) {
    for (const entry of readdirSync(cliDir)) {
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) boundary.add(`src/cli/${entry}`);
    }
  }
  // Every subsystem barrel: src/core/*/index.ts, discovered dynamically.
  const coreDir = resolve(PACKAGE_ROOT, 'src/core');
  if (existsSync(coreDir)) {
    for (const entry of readdirSync(coreDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const barrel = `src/core/${entry.name}/index.ts`;
      if (existsSync(resolve(PACKAGE_ROOT, barrel))) boundary.add(barrel);
    }
  }
  return boundary;
}

function isTransitivelyCovered(boundaryFile, coveredSources) {
  // A subsystem barrel dir is covered if any covered source lives under its directory.
  if (boundaryFile.endsWith('/index.ts')) {
    const dir = boundaryFile.slice(0, -'index.ts'.length);
    for (const source of coveredSources) if (source.startsWith(dir)) return true;
  }
  return false;
}

function checkPayloadParity() {
  const failures = [];
  const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const files = pkg.files ?? [];
  const hasDocs = files.includes('docs/') || files.includes('docs');
  if (!hasDocs) failures.push('package.json "files" must include "docs/" so the docs tree + manifest ship in the npm payload');
  const hasGateway = files.includes(GATEWAY_PATH);
  if (!hasGateway) failures.push(`package.json "files" must include "${GATEWAY_PATH}" (the mandatory gateway)`);
  return failures;
}

async function restamp(model, surfaces) {
  const sourceToDocs = sourceToDocsMap(model);
  let stamped = 0;
  for (const doc of model.docs) {
    if (doc.coversSources.length === 0) continue;
    const hashes = computeCoverHashes(doc.coversSources);
    // MECHANICAL restamp only: signature_hash + body_hash. It deliberately NEVER
    // writes `semantic_attestation` (the review-owned currency proof), so a source
    // author cannot clear C11 by restamping — a fresh independent review must record
    // semantic_attestation separately. (Design D67 anti-self-certification contract.)
    const nextFrontmatter = { ...doc.frontmatter, signature_hash: hashes.signatureHash, body_hash: hashes.bodyHash };
    if (doc.frontmatter.signature_hash === hashes.signatureHash && doc.frontmatter.body_hash === hashes.bodyHash) continue;
    const frontmatterText = serializeFrontmatter(nextFrontmatter, FRONTMATTER_KEY_ORDER);
    const { body } = splitFrontmatter(doc.rawText, doc.location);
    writeFileSync(resolve(PACKAGE_ROOT, doc.location), composeDoc(frontmatterText, body), 'utf8');
    stamped += 1;
    console.log(`re-stamped hashes for ${doc.docId}`);
  }

  // Rebuild manifest with a ratcheted coverage floor (never lowered).
  const reloaded = loadDocsModel();
  const boundary = computeBoundarySet();
  const coveredSources = new Set();
  for (const doc of reloaded.docs) for (const source of doc.coversSources) coveredSources.add(source);
  let boundaryCovered = 0;
  for (const boundaryFile of boundary) {
    if (coveredSources.has(boundaryFile) || isTransitivelyCovered(boundaryFile, coveredSources)) boundaryCovered += 1;
  }
  const manifestAbsolute = resolve(PACKAGE_ROOT, MANIFEST_PATH);
  let previousFloor = 0;
  let previousFullCoverage = false;
  try {
    const parsed = JSON.parse(readFileSync(manifestAbsolute, 'utf8'));
    if (typeof parsed.coverage_floor === 'number') previousFloor = parsed.coverage_floor;
    if (parsed.full_coverage_required === true) previousFullCoverage = true;
  } catch {
    previousFloor = 0;
  }
  const nextFloor = Math.max(previousFloor, boundaryCovered);
  // full_coverage_required latches true once the boundary is fully covered and is
  // never unset, so a later brand-new boundary file is a hard C8 failure.
  const fullCoverageRequired = previousFullCoverage || boundaryCovered >= boundary.size;
  const manifestText = serializeManifest(buildManifest(reloaded, { floor: nextFloor, fullCoverageRequired }));
  writeFileSync(manifestAbsolute, manifestText, 'utf8');
  console.log(`re-stamped ${String(stamped)} doc(s); rebuilt manifest (coverage_floor=${String(nextFloor)}, full_coverage_required=${String(fullCoverageRequired)}). read-before-edit + generated regions are owned by docs:generate.`);
  void surfaces;
  void sourceToDocs;
}

function report(findings, json) {
  const quiet = process.argv.includes('--quiet');
  if (json) {
    console.log(JSON.stringify({ schema_version: 'autopilot.docs_verify_result.v1', passed: !findings.failed, findings: findings.items }, null, 2));
  } else if (findings.failed) {
    console.error(`docs-verify FAILED with ${String(findings.items.length)} finding(s):`);
    for (const item of findings.items) console.error(`  [${item.check}] ${item.location}: ${item.message}`);
  } else if (!quiet) {
    console.log('docs-verify: C0–C11 all pass (deterministic, offline).');
  }
  if (findings.failed) process.exitCode = 1;
}

await run();
