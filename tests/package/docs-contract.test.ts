import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRootUrl = new URL('../../', import.meta.url);
const packageRoot = fileURLToPath(packageRootUrl);

function runNode(scriptRelPath: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(scriptRelPath, packageRootUrl))], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function text(relPath: string): string {
  return readFileSync(new URL(relPath, packageRootUrl), 'utf8');
}

function literal(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
}

void describe('current docs and generated-contract package gate', () => {
  void it('passes the deterministic offline docs-verify gate', () => {
    const result = runNode('scripts/docs-verify.mjs');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /docs-verify: 6 generated file\(s\) match docs-generate byte-for-byte\./u);
  });

  void it('ships the package gateway plus generated docs required by the current payload contract', () => {
    const pkg = JSON.parse(text('package.json')) as { files?: readonly string[]; scripts?: Readonly<Record<string, string>> };
    assert.ok(existsSync(new URL('AUTOPILOT-INSTRUCTIONS.md', packageRootUrl)), 'gateway must exist');
    assert.ok(existsSync(new URL('docs/INDEX.md', packageRootUrl)), 'docs index must exist in source');
    assert.ok(existsSync(new URL('docs/generated/index.md', packageRootUrl)), 'generated docs index must exist');
    assert.ok(pkg.files?.includes('docs/generated/'), 'package.json files[] must ship generated docs');
    assert.ok(pkg.files?.includes('AUTOPILOT-INSTRUCTIONS.md'), 'package.json files[] must ship the gateway');
    assert.equal(pkg.scripts?.['docs:generate'], 'node scripts/docs-generate.mjs');
    assert.equal(pkg.scripts?.['docs:verify'], 'node scripts/docs-verify.mjs');
    assert.match(pkg.scripts?.['prepack'] ?? '', /gate:release/u, 'prepack must run the release gate');
  });

  void it('keeps operator entry docs routed to the current architecture surfaces', () => {
    const gateway = text('AUTOPILOT-INSTRUCTIONS.md');
    for (const target of ['docs/INDEX.md', 'docs/read-before-edit.md']) {
      assert.match(gateway, literal(target), `gateway must route to ${target}`);
    }
    const readme = text('README.md');
    for (const target of ['docs/task-document-format.md', 'docs/generated/', 'docs/cli/autopilot-agent-run.md', 'docs/operations/release-certification.md']) {
      assert.match(readme, literal(target), `README must route to ${target}`);
    }
    for (const surface of ['/autopilot-plan', '/autopilot', '/autopilot-onboard', '/autopilot-inject', '/autopilot-status', '/autopilot-config', '/autopilot-handoff', '/autopilot-close', '/autopilot-abort', 'autopilot-core', 'autopilot-agent-run']) {
      assert.match(readme, literal(surface), `README missing current surface ${surface}`);
    }
  });

  void it('keeps TEST_PLAN coverage rows aligned to the current package-local gates', () => {
    const plan = text('TEST_PLAN.md');
    for (const row of ['Host API correctness', 'Rust behavior', 'Payload', 'Binaries', 'Runtime pair', 'Zero skip/todo policy']) {
      assert.match(plan, literal(row), `TEST_PLAN missing row: ${row}`);
    }
    for (const command of ['npm run typecheck', 'npm run test:host', 'npm run test:rust', 'npm run payload:check', 'npm run gate:binary-parity', 'npm run gate:launch-entrypoint']) {
      assert.match(plan, literal(command), `TEST_PLAN missing command: ${command}`);
    }
  });
});
