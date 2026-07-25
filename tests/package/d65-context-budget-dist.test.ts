import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import {
  assertD65ContextBudgetOpaqueToolCallContract,
  buildD65ContextBudgetReceiptFixture,
  type D65ContextBudgetReceiptApi,
} from '../helpers/d65-context-budget-receipt.ts';

// BUG-180 compiled-boundary witness. The shipped artifact is `dist/`, so proving
// only the TypeScript source would leave the actual consumer-facing D65 writer/
// reader uncertified. This runs the exact same behavioral battery against the
// REBUILT compiled module (never a static string/grep assertion), so a stale or
// divergent dist that still carried the private identifier grammar fails loudly.

interface CompiledManifestModule {
  readonly parseD65LaunchManifest: (value: unknown) => D65LaunchManifest;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFunction(module: Readonly<Record<string, unknown>>, name: string): unknown {
  const candidate = module[name];
  if (typeof candidate !== 'function') throw new TypeError(`compiled D65 module must export ${name}`);
  return candidate;
}

async function loadCompiledReceiptApi(): Promise<D65ContextBudgetReceiptApi> {
  const moduleUrl = new URL('../../dist/src/core/coordination/d65-launch-integration.js', import.meta.url).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isRecord(loaded)) throw new TypeError('compiled D65 launch-integration module must be an object');
  return {
    writeD65ContextBudgetReceipt: requireFunction(loaded, 'writeD65ContextBudgetReceipt') as D65ContextBudgetReceiptApi['writeD65ContextBudgetReceipt'],
    requireD65ContextBudgetReceipt: requireFunction(loaded, 'requireD65ContextBudgetReceipt') as D65ContextBudgetReceiptApi['requireD65ContextBudgetReceipt'],
    d65ContextBudgetReceiptPath: requireFunction(loaded, 'd65ContextBudgetReceiptPath') as D65ContextBudgetReceiptApi['d65ContextBudgetReceiptPath'],
  };
}

async function loadCompiledManifestParser(): Promise<CompiledManifestModule['parseD65LaunchManifest']> {
  const moduleUrl = new URL('../../dist/src/core/coordination/d65-launch-manifest.js', import.meta.url).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isRecord(loaded)) throw new TypeError('compiled D65 launch-manifest module must be an object');
  return requireFunction(loaded, 'parseD65LaunchManifest') as CompiledManifestModule['parseD65LaunchManifest'];
}

void describe('BUG-180 compiled D65 context_budget receipt contract', () => {
  void it('accepts and preserves a provider-native composite tool-call id through the rebuilt dist writer/reader', async () => {
    const api = await loadCompiledReceiptApi();
    const parse = await loadCompiledManifestParser();
    const fixture = await buildD65ContextBudgetReceiptFixture('dist', parse);
    try {
      assertD65ContextBudgetOpaqueToolCallContract(api, fixture);
    } finally {
      await fixture.close();
    }
  });

  void it('BUG-180 compiles the canonical opaque contract into dist rather than a private D65 grammar', async () => {
    const { readFile } = await import('node:fs/promises');
    const compiled = await readFile(new URL('../../dist/src/core/coordination/d65-launch-integration.js', import.meta.url), 'utf8');
    // The compiled D65 writer/reader must import the ONE canonical helper and must
    // carry no private tool-call-id grammar of its own.
    assert.match(compiled, /opaqueToolCallIdIssue/u, 'compiled D65 must consume the canonical opaque tool-call-ID helper');
    assert.equal(compiled.includes('D65_CONTEXT_BUDGET_CALL_ID'), false, 'the duplicate D65 tool-call-id validator must not exist in dist');
  });
});
