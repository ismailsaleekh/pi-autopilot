import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CoordinationRuntimeError } from './failures.ts';

export const PACKAGE_ISOLATION_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PACKAGE_ISOLATION_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface PackageIsolationViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
}

interface ForbiddenReference {
  readonly rule: string;
  readonly value: string;
}

function forbiddenReferences(): readonly ForbiddenReference[] {
  return [
    { rule: 'closed repository name', value: ['ai', 'pipeline'].join('-') },
    { rule: 'closed development runtime import', value: ['orchestrator', 'src', 'dev'].join('/') },
    { rule: 'closed development runtime state', value: ['dev', 'orchestrator'].join('-') },
    { rule: 'closed planning path', value: ['plans', 'active'].join('/') },
    { rule: 'product fixture assumption', value: ['products', 'stroy-mart'].join('/') },
    { rule: 'legacy private agent root', value: ['.claude', ['dev', 'orchestrator'].join('-')].join('/') },
  ];
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

async function walk(root: string, path: string): Promise<readonly string[]> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new CoordinationRuntimeError('invalid-state', 'package isolation scan refuses symbolic links', [path]);
  const canonicalPath = await realpath(path);
  if (!isWithin(root, canonicalPath)) throw new CoordinationRuntimeError('invalid-state', 'package isolation scan path escapes package root', [path, canonicalPath]);
  if (stat.isFile()) return [canonicalPath];
  if (!stat.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'artifacts') continue;
    const child = join(path, entry.name);
    files.push(...await walk(root, child));
  }
  return files;
}

function shouldScan(path: string): boolean {
  return ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md'].includes(extname(path));
}

export async function scanStandalonePackageBoundary(
  packageRoot: string,
  options: { readonly includeTests?: boolean } = {},
): Promise<readonly PackageIsolationViolation[]> {
  const root = await realpath(resolve(packageRoot));
  const candidates = [
    'src',
    'dist',
    'extensions',
    'bin',
    'templates',
    ...(options.includeTests === true ? ['tests'] : []),
    'package.json',
    'README.md',
    'TESTING.md',
    'TEST_PLAN.md',
    'PUBLISHING.md',
  ];
  const files: string[] = [];
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (!isWithin(root, path)) throw new CoordinationRuntimeError('invalid-state', 'package isolation candidate escapes package root', [path]);
    try {
      files.push(...await walk(root, path));
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
  }
  const violations: PackageIsolationViolation[] = [];
  let totalBytes = 0;
  for (const file of [...new Set(files)].filter(shouldScan).sort()) {
    const bytes = await readFile(file);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > PACKAGE_ISOLATION_MAX_FILE_BYTES) throw new CoordinationRuntimeError('invalid-state', 'package isolation source file exceeds scan bound', [file, String(bytes.byteLength)]);
    if (totalBytes > PACKAGE_ISOLATION_MAX_TOTAL_BYTES) throw new CoordinationRuntimeError('invalid-state', 'package isolation scan exceeds total byte bound', [String(totalBytes)]);
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const reference of forbiddenReferences()) {
        if (line.toLowerCase().includes(reference.value.toLowerCase())) {
          violations.push({
            file: relative(root, file).replace(/\\/gu, '/'),
            line: index + 1,
            rule: reference.rule,
            excerpt: line.trim().slice(0, 240),
          });
        }
      }
    }
  }
  return Object.freeze(violations);
}

export async function assertStandalonePackageBoundary(packageRoot: string): Promise<void> {
  const violations = await scanStandalonePackageBoundary(packageRoot);
  if (violations.length > 0) throw new CoordinationRuntimeError('invalid-state', 'standalone package boundary scan found closed-repository dependencies', violations.slice(0, 100).map((entry) => `${entry.file}:${String(entry.line)} ${entry.rule}: ${entry.excerpt}`));
}

interface NodeError extends Error {
  readonly code?: string;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && (error as NodeError).code === 'ENOENT';
}
