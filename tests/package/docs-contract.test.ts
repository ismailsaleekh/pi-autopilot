import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The deterministic docs-freshness gate (design D67 / Phase 39). This test is the
// package-owned enforcement point: it runs scripts/docs-verify.mjs (checks C0–C11)
// and scripts/docs-generate.mjs --check in-band inside `npm run test:package`, so a
// stale or drifted doc fails the offline gate exactly like security-scan/sbom.
//
// It also absorbs the historical presence-only doc checks and README→TEST_PLAN
// mapping that used to live in package.test.ts, per the single-source-of-truth
// doctrine: those are now expressed as (a) C1 surface coverage in the docs gate and
// (b) the explicit README-hub + TEST_PLAN mappings asserted below.

const packageRoot = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(packageRoot);

function runNode(scriptRelPath: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(scriptRelPath, packageRoot)), ...args], {
    cwd: rootPath,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function docText(relPath: string): string {
  return readFileSync(new URL(relPath, packageRoot), 'utf8');
}

function literalPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
}

void describe('docs freshness gate (C0–C11)', () => {
  void it('passes the deterministic offline docs-verify gate', () => {
    const result = runNode('scripts/docs-verify.mjs', ['--json']);
    let parsed: { passed?: boolean; findings?: readonly { check: string; location: string; message: string }[] };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new Error(`docs-verify did not emit JSON. stdout=${result.stdout} stderr=${result.stderr}`);
    }
    const findings = parsed.findings ?? [];
    assert.equal(
      parsed.passed,
      true,
      `docs-verify reported ${String(findings.length)} finding(s):\n${findings.map((finding) => `  [${finding.check}] ${finding.location}: ${finding.message}`).join('\n')}`,
    );
    assert.equal(result.status, 0, result.stderr);
  });

  void it('has no stale generated regions or manifest (docs-generate --check)', () => {
    const result = runNode('scripts/docs-generate.mjs', ['--check']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /all generated regions \+ manifest are up to date/u);
  });

  void it('ships the mandatory gateway and docs tree in the package payload', async () => {
    assert.ok(existsSync(new URL('AUTOPILOT-INSTRUCTIONS.md', packageRoot)), 'gateway must exist');
    assert.ok(existsSync(new URL('docs/INDEX.md', packageRoot)), 'docs/INDEX.md must exist');
    assert.ok(existsSync(new URL('docs/read-before-edit.md', packageRoot)), 'read-gate must exist');
    assert.ok(existsSync(new URL('docs/manifest.json', packageRoot)), 'manifest must exist');
    const pkg = JSON.parse(docText('package.json')) as { files: readonly string[]; scripts: Record<string, string> };
    assert.ok(pkg.files.includes('docs/'), 'package.json files[] must ship docs/');
    assert.ok(pkg.files.includes('AUTOPILOT-INSTRUCTIONS.md'), 'package.json files[] must ship the gateway');
    for (const script of ['docs:generate', 'docs:verify', 'docs:attest']) {
      assert.equal(typeof pkg.scripts[script], 'string', `package.json must declare ${script}`);
    }
    assert.match(pkg.scripts['prepack'] ?? '', /docs-verify\.mjs/u, 'prepack must gate publish on docs-verify');
  });

  void it('manifest is a valid navigation + coverage index over every governed doc', () => {
    const manifest = JSON.parse(docText('docs/manifest.json')) as {
      schema_version: string;
      coverage_floor: number;
      surface_to_docs: Record<string, readonly string[]>;
      source_to_docs: Record<string, readonly string[]>;
      docs: Record<string, unknown>;
    };
    assert.equal(manifest.schema_version, 'autopilot.docs_manifest.v1');
    assert.ok(manifest.coverage_floor >= 1, 'coverage floor must be positive after PR-1');
    // Every public surface must be navigable to at least one doc (C1 mirror).
    for (const surface of ['/autopilot', '/autopilot-coordination', 'context_budget', 'autopilot-agent-run', 'autopilot-coordinator', 'autopilot.unit_spec.v1', 'autopilot.execution_audit.v1']) {
      const docs = manifest.surface_to_docs[surface];
      assert.ok(Array.isArray(docs) && docs.length > 0, `manifest surface_to_docs missing ${surface}`);
    }
    // The first real consumer doc must be present (PR-1 no-deferred-infrastructure).
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.docs, 'subsystems/coordination'), 'coordination subsystem doc must be in the manifest');
  });

  void it('routes agents into docs from the gateway and README hub', () => {
    const gateway = docText('AUTOPILOT-INSTRUCTIONS.md');
    for (const target of ['docs/INDEX.md', 'docs/read-before-edit.md']) {
      assert.match(gateway, literalPattern(target), `gateway must route to ${target}`);
    }
    const readme = docText('README.md');
    assert.match(readme, literalPattern('AUTOPILOT-INSTRUCTIONS.md'), 'README hub must link the gateway');
    assert.match(readme, literalPattern('docs/INDEX.md'), 'README hub must link the docs index');
  });

  void it('absorbs the README-hub surface coverage that package.test.ts no longer duplicates', () => {
    // Single source of truth: surface *coverage* is enforced by the docs gate (C1)
    // over docs/, while the README stays a thin hub. We assert the hub still names
    // the public command set and routes into docs, rather than re-listing every
    // surface string as prose (the retired presence-only check).
    const readme = docText('README.md');
    for (const surface of ['/autopilot', '/autopilot-close', '/autopilot-coordination', 'autopilot-agent-run', 'autopilot-coordinator', 'context_budget']) {
      assert.match(readme, literalPattern(surface), `README hub missing ${surface}`);
    }
  });
});
