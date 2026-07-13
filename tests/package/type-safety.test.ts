import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const allTypeScriptRoots = ['extensions', 'src', 'tests'];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

interface Check {
  readonly rule: string;
  readonly pattern: RegExp;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonField(value: JsonMap, key: string): unknown {
  return value[key];
}

function requireJsonMap(value: unknown, label: string): JsonMap {
  if (!isJsonMap(value)) throw new TypeError(`${label} must be a JSON map`);
  return value;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function walk(dir: string, filePattern = /\.tsx?$/): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path, filePattern)));
    else if (filePattern.test(entry.name)) files.push(path);
  }
  return files;
}

async function filesFor(roots: readonly string[], filePattern?: RegExp): Promise<string[]> {
  const nested = await Promise.all(roots.map((root) => walk(join(packageRoot, root), filePattern)));
  return nested.flat().sort();
}

async function scan(files: readonly string[], checks: readonly Check[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const check of checks) {
        if (check.pattern.test(line)) {
          violations.push({ file, line: index + 1, rule: check.rule, text: line.trim() });
        }
      }
    }
  }
  return violations;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.file}:${String(violation.line)} ${violation.rule}: ${violation.text}`,
    )
    .join('\n');
}

void describe('type-safety standard', () => {
  void it('has no top-type escape, compiler suppressions, double assertions, or broad structural types', async () => {
    const explicitTopTypePattern = new RegExp('\\b' + 'an' + 'y' + '\\b');
    const broadCallablePattern = new RegExp(
      '(?::|as|<|extends\\s+|implements\\s+|\\btype\\s+\\w+\\s*=)\\s*' +
        '(?:' +
        'Func' +
        'tion' +
        '|' +
        'Obj' +
        'ect' +
        ')\\b(?!\\s*\\.)',
    );
    const emptyStructuralPattern = /(?:[\w)]\s*:\s*\{\s*\}\s*(?:[=;,)]|$)|(?:as|<|extends\s+|implements\s+|\btype\s+\w+\s*=)\s*\{\s*\})/;
    const violations = await scan(await filesFor(allTypeScriptRoots), [
      { rule: 'explicit top-type escape', pattern: explicitTopTypePattern },
      { rule: 'compiler suppression', pattern: /@ts-(?:ignore|expect-error|nocheck)/ },
      { rule: 'double assertion', pattern: /\bas\s+(?:unknown|never)\s+as\b/ },
      { rule: 'broad callable/object type', pattern: broadCallablePattern },
      { rule: 'empty structural type', pattern: emptyStructuralPattern },
    ]);
    assert.equal(violations.length, 0, formatViolations(violations));
  });

  void it('has no non-null assertion bypasses in source, extensions, or tests', async () => {
    const bang = '!';
    const nonNullAssertionPattern = new RegExp(
      '(?:' +
        bang +
        '\\.' +
        '|' +
        bang +
        '\\)' +
        '|' +
        bang +
        ';' +
        '|' +
        bang +
        '\\]' +
        '|' +
        bang +
        '$' +
        ')',
    );
    const violations = await scan(await filesFor(allTypeScriptRoots), [
      { rule: 'non-null assertion', pattern: nonNullAssertionPattern },
    ]);
    assert.equal(violations.length, 0, formatViolations(violations));
  });

  void it('uses fileURLToPath rather than URL.pathname for module-relative filesystem paths', async () => {
    const filesystemSources = await filesFor(['src', 'tests', 'scripts'], /\.(?:[cm]?js|tsx?)$/u);
    const violations = await scan(filesystemSources, [
      { rule: 'URL pathname filesystem conversion', pattern: /import\.meta\.url[^\n]*\.pathname/u },
    ]);
    assert.equal(violations.length, 0, formatViolations(violations));
    const encoded = fileURLToPath(pathToFileURL(join(tmpdir(), 'pi-autopilot path')));
    assert.equal(encoded.includes('%20'), false);
    assert.equal(encoded.includes('pi-autopilot path'), true);
  });

  void it('overrides inherited lib checking in the package compiler config', async () => {
    const config = requireJsonMap(parseJson(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8')), 'tsconfig');
    const compilerOptions = requireJsonMap(jsonField(config, 'compilerOptions'), 'compilerOptions');
    assert.equal(jsonField(compilerOptions, 'skipLibCheck'), false);
  });
});
