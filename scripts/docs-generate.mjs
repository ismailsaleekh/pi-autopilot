#!/usr/bin/env node
// Autopilot docs generator (design §6.1, §10).
//
// Regenerates every GENERATED:* region across docs/**/*.md from authoritative code
// surfaces, rebuilds docs/read-before-edit.md and docs/INDEX.md generated regions,
// and rebuilds docs/manifest.json. It NEVER edits authored prose or frontmatter
// fences other than the generated regions and the manifest — so a run is a pure,
// idempotent projection of code into the docs. `docs:verify` then asserts the tree
// equals a fresh run of this generator (C2/C7), which makes factual drift impossible.
//
// Usage: node scripts/docs-generate.mjs [--check]
//   (no flag)  write regenerated regions + manifest in place
//   --check    do not write; exit non-zero if any region/manifest is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MANIFEST_PATH, PACKAGE_ROOT } from './docs/config.mjs';
import { loadCodeSurfaces } from './docs/code-surfaces.mjs';
import { buildManifest, loadDocsModel, serializeManifest, sourceToDocsMap } from './docs/model.mjs';
import {
  findMarkerAnomalies,
  findRegions,
  renderClis,
  renderCommands,
  renderDefaults,
  renderModelRoster,
  renderReadBeforeEdit,
  renderRuntimePaths,
  renderSchemas,
  renderTools,
  wrapRegion,
} from './docs/regions.mjs';

const RENDERERS = {
  commands: renderCommands,
  tools: renderTools,
  clis: renderClis,
  schemas: renderSchemas,
  'model-roster': renderModelRoster,
  defaults: renderDefaults,
  'runtime-paths': renderRuntimePaths,
};

function renderRegion(id, surfaces, sourceToDocs) {
  if (id === 'read-before-edit') return renderReadBeforeEdit(sourceToDocs);
  const renderer = RENDERERS[id];
  if (renderer === undefined) throw new Error(`no renderer for GENERATED region "${id}"`);
  return renderer(surfaces);
}

/** Apply fresh generated content to one doc body; returns the rewritten body. */
function regenerateBody(location, body, surfaces, sourceToDocs) {
  const anomalies = findMarkerAnomalies(body);
  if (anomalies.length > 0) {
    throw new Error(`${location}: malformed GENERATED markers:\n  - ${anomalies.join('\n  - ')}`);
  }
  const regions = findRegions(body);
  let result = '';
  let cursor = 0;
  for (const region of regions) {
    result += body.slice(cursor, region.start);
    const inner = renderRegion(region.id, surfaces, sourceToDocs);
    result += wrapRegion(region.id, inner);
    cursor = region.end;
  }
  result += body.slice(cursor);
  return result;
}

async function main() {
  const check = process.argv.includes('--check');
  const surfaces = await loadCodeSurfaces();
  const model = loadDocsModel();
  const sourceToDocs = sourceToDocsMap(model);

  const pending = [];

  for (const doc of model.docs) {
    const regenerated = regenerateBody(doc.location, doc.body, surfaces, sourceToDocs);
    if (regenerated !== doc.body) {
      pending.push({ path: doc.location, next: doc.rawText.replace(doc.body, regenerated) });
    }
  }

  // Manifest: preserve the existing coverage floor (only docs-verify --write ratchets it).
  const manifestAbsolute = resolve(PACKAGE_ROOT, MANIFEST_PATH);
  let existingFloor = 0;
  try {
    const existing = JSON.parse(readFileSync(manifestAbsolute, 'utf8'));
    if (typeof existing.coverage_floor === 'number') existingFloor = existing.coverage_floor;
  } catch {
    existingFloor = 0;
  }
  const manifestText = serializeManifest(buildManifest(model, existingFloor));
  let manifestCurrent = '';
  try {
    manifestCurrent = readFileSync(manifestAbsolute, 'utf8');
  } catch {
    manifestCurrent = '';
  }
  if (manifestText !== manifestCurrent) pending.push({ path: MANIFEST_PATH, next: manifestText, absolute: manifestAbsolute });

  if (check) {
    if (pending.length > 0) {
      console.error(`docs-generate --check: ${String(pending.length)} generated artifact(s) are stale:`);
      for (const item of pending) console.error(`  - ${item.path}`);
      console.error('Run "npm run docs:generate" to regenerate.');
      process.exitCode = 1;
    } else {
      console.log('docs-generate --check: all generated regions + manifest are up to date.');
    }
    return;
  }

  for (const item of pending) {
    const absolute = item.absolute ?? resolve(PACKAGE_ROOT, item.path);
    writeFileSync(absolute, item.next, 'utf8');
    console.log(`regenerated ${item.path}`);
  }
  if (pending.length === 0) console.log('docs-generate: nothing to regenerate (already current).');
}

await main();
