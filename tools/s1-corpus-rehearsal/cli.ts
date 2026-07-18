#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { buildCorpusClone } from './clone-controller.ts';
import { parseCorpusCloneManifest, parseCorpusCloneRequest, parseCorpusRehearsalResult } from './contracts.ts';
import { runCorpusRehearsal } from './incident-runner.ts';
import { readRegularFileNoFollow } from './inventory.ts';
import { preflightCorpusCloneRequest } from './request-preflight.ts';

interface GateStatus {
  readonly schema_version: 'autopilot.s1_corpus_gate_status.v1';
  readonly status: 'not_run';
  readonly reason: 'private_corpus_request_unavailable';
}

function usage(): never {
  throw new Error('usage: cli.ts status | validate-request <private-request.json> | validate-manifest <private-manifest.json> | validate-result <private-result.json> | build-clone <private-request.json> | run <private-request.json>');
}

async function privateJson(path: string, requirePrivateMode: boolean): Promise<{ readonly bytes: Uint8Array; readonly value: unknown }> {
  const input = readRegularFileNoFollow(path, 64 * 1024 * 1024);
  if (input.size_bytes < 2 || input.identity.link_count !== 1) throw new Error('C5 private input must be a bounded single-link regular file');
  if (requirePrivateMode && process.platform !== 'win32' && (input.mode & 0o077) !== 0) throw new Error('C5 private request permissions must be 0600 or stricter');
  const bytes = input.bytes;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch { throw new Error('C5 private input is not JSON'); }
  return Object.freeze({ bytes, value });
}

function summary(kind: 'request' | 'manifest' | 'result', rehearsalId: string, bytes: Uint8Array): Readonly<Record<string, unknown>> {
  return Object.freeze({ schema_version: 'autopilot.s1_corpus_contract_validation.v1', kind, rehearsal_id: rehearsalId, input_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, valid: true });
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === 'status') {
    const request = process.env['C5_PRIVATE_REQUEST'];
    if (request === undefined || request.length === 0) {
      const status: GateStatus = { schema_version: 'autopilot.s1_corpus_gate_status.v1', status: 'not_run', reason: 'private_corpus_request_unavailable' };
      process.stdout.write(`${canonicalJson(status)}\n`);
      process.exitCode = 2;
      return;
    }
    const parsed = await privateJson(request, true);
    const value = await preflightCorpusCloneRequest(parseCorpusCloneRequest(parsed.value));
    process.stdout.write(`${canonicalJson(summary('request', value.rehearsal_id, parsed.bytes))}\n`);
    return;
  }
  const path = args[1];
  if (args.length !== 2 || path === undefined) usage();
  const parsed = await privateJson(path, command === 'validate-request' || command === 'build-clone' || command === 'run');
  if (command === 'validate-request') {
    const value = await preflightCorpusCloneRequest(parseCorpusCloneRequest(parsed.value));
    process.stdout.write(`${canonicalJson(summary('request', value.rehearsal_id, parsed.bytes))}\n`);
    return;
  }
  if (command === 'build-clone' || command === 'run') {
    const requestValue = parseCorpusCloneRequest(parsed.value);
    const clone = await buildCorpusClone(requestValue);
    if (command === 'build-clone') {
      process.stdout.write(`${canonicalJson({ schema_version: 'autopilot.s1_corpus_clone_build.v1', rehearsal_id: clone.manifest.rehearsal_id, manifest_sha256: `sha256:${createHash('sha256').update(canonicalJson(clone.manifest)).digest('hex')}`, isolation_passed: Object.values(clone.manifest.isolation_proofs).every((proof) => proof.passed) })}\n`);
      return;
    }
    const result = await runCorpusRehearsal(clone);
    process.stdout.write(`${canonicalJson(summary('result', result.rehearsal_id, Buffer.from(canonicalJson(result), 'utf8')))}\n`);
    return;
  }
  if (command === 'validate-manifest') {
    const value = parseCorpusCloneManifest(parsed.value);
    process.stdout.write(`${canonicalJson(summary('manifest', value.rehearsal_id, parsed.bytes))}\n`);
    return;
  }
  if (command === 'validate-result') {
    const value = parseCorpusRehearsalResult(parsed.value);
    process.stdout.write(`${canonicalJson(summary('result', value.rehearsal_id, parsed.bytes))}\n`);
    return;
  }
  usage();
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`C5 corpus gate failed: ${message}\n`);
  process.exitCode = 1;
});
