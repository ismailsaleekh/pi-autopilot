// Fact-pin resolution (C5). A fact-pin is `{ text?, symbol, expect }` where symbol
// is "src/path.ts#EXPORTED_NAME". We import the COMPILED value from dist/ and assert
// it deep-equals `expect`, and — when `text` is present — that the exact `text`
// string appears verbatim in the doc body. This generalizes the historical exact
// test-chain assertion to any pinned constant, so a changed default constant fails
// the doc loudly instead of silently rotting.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PACKAGE_ROOT } from './config.mjs';

function distPathForSource(sourceRel) {
  if (!sourceRel.startsWith('src/') || !sourceRel.endsWith('.ts')) {
    throw new Error(`fact-pin symbol must reference a src/**.ts file; got "${sourceRel}"`);
  }
  return `dist/${sourceRel.slice(0, -3)}.js`.replace(/^dist\/src\//u, 'dist/src/');
}

async function importValue(sourceRel, exportName) {
  const distRel = distPathForSource(sourceRel);
  const absolute = resolve(PACKAGE_ROOT, distRel);
  try {
    readFileSync(absolute);
  } catch {
    throw new Error(`fact-pin cannot load compiled ${distRel}; run "npm run build" first (no source fallback)`);
  }
  const module = await import(pathToFileURL(absolute).href);
  if (!Object.prototype.hasOwnProperty.call(module, exportName)) {
    throw new Error(`fact-pin symbol "${exportName}" is not exported by ${distRel}`);
  }
  return module[exportName];
}

function deepEqual(actual, expected) {
  if (actual === expected) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => deepEqual(actual[index], item));
  }
  return false;
}

/**
 * Evaluate every fact-pin of a doc against compiled values + doc body text.
 * @returns {Promise<string[]>} list of failure messages (empty = pass)
 */
export async function evaluateFactPins(doc) {
  const failures = [];
  for (const pin of doc.factPins) {
    const symbol = pin.symbol;
    if (typeof symbol !== 'string' || !symbol.includes('#')) {
      failures.push(`fact-pin symbol must be "src/path.ts#NAME"; got ${JSON.stringify(symbol)}`);
      continue;
    }
    const [sourceRel, exportName] = symbol.split('#');
    let actual;
    try {
      actual = await importValue(sourceRel, exportName);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!deepEqual(actual, pin.expect)) {
      failures.push(`fact-pin ${symbol} expected ${JSON.stringify(pin.expect)} but code exports ${JSON.stringify(actual)}`);
      continue;
    }
    if (typeof pin.text === 'string' && !doc.body.includes(pin.text)) {
      failures.push(`fact-pin text "${pin.text}" for ${symbol} is not present verbatim in the doc body`);
    }
  }
  return failures;
}
