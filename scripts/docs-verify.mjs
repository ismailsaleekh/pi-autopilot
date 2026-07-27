#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GENERATED_MARKER, PACKAGE_ROOT, renderGeneratedDocs } from './docs-generate.mjs';

function usage(exitCode = 2) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: node scripts/docs-verify.mjs\n');
  process.exit(exitCode);
}

function firstGeneratedMarkerOk(path, text) {
  return text.split(/\r?\n/u).slice(0, 5).includes(GENERATED_MARKER);
}

function diffLines(path, expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first += 1;
  let lastA = a.length - 1;
  let lastB = b.length - 1;
  while (lastA >= first && lastB >= first && a[lastA] === b[lastB]) {
    lastA -= 1;
    lastB -= 1;
  }
  const start = Math.max(0, first - 3);
  const endA = Math.min(a.length - 1, lastA + 3);
  const endB = Math.min(b.length - 1, lastB + 3);
  const lines = [`--- expected/${path}`, `+++ actual/${path}`, `@@ line ${start + 1} @@`];
  for (let i = start; i <= endA; i += 1) lines.push(`-${a[i] ?? ''}`);
  for (let i = start; i <= endB; i += 1) lines.push(`+${b[i] ?? ''}`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) usage(0);
    usage(2);
  }

  const expected = renderGeneratedDocs();
  const findings = [];
  for (const [rel, next] of expected) {
    const abs = resolve(PACKAGE_ROOT, rel);
    if (!existsSync(abs)) {
      findings.push(`missing generated doc: ${rel}`);
      continue;
    }
    const current = readFileSync(abs, 'utf8');
    if (!firstGeneratedMarkerOk(rel, current)) findings.push(`${rel}: missing ${GENERATED_MARKER} in first 5 lines`);
    if (current !== next) findings.push(`${rel}: byte mismatch\n${diffLines(rel, next, current)}`);
  }

  if (findings.length > 0) {
    process.stderr.write(`docs-verify FAILED with ${findings.length} finding(s):\n`);
    for (const finding of findings) process.stderr.write(`  - ${finding.replace(/\n/gu, '\n    ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`docs-verify: ${expected.size} generated file(s) match docs-generate byte-for-byte.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`docs-verify: ${error.message}\n`);
  process.exitCode = error.sourceMissing ? 2 : 2;
}
