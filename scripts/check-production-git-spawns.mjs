#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function fail(message, evidence = []) {
  const result = { schema_version: 'autopilot.production_git_spawn_check.v1', passed: false, error: message, violations: evidence };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}

function under(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function regularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`symbolic link is forbidden in production source scan: ${path}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`non-regular production source entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function lineNumber(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

try {
  const argument = process.argv[2];
  if (argument === undefined || process.argv.length !== 3 || (argument !== '--cwd' && !isAbsolute(argument))) throw new Error('usage: node scripts/check-production-git-spawns.mjs <absolute-installed-root|--cwd>');
  const requestedRoot = argument === '--cwd' ? process.cwd() : argument;
  const rootInfo = lstatSync(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('installed root must be one non-symlink directory');
  const root = realpathSync(requestedRoot);
  const sourceRoots = [join(root, 'src'), join(root, 'dist', 'src')];
  const scanRoots = [...sourceRoots, join(root, 'dist', 'extensions'), join(root, 'bin'), join(root, 'extensions'), join(root, 'scripts')];
  for (const scanRoot of scanRoots) {
    const info = lstatSync(scanRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || !under(root, realpathSync(scanRoot))) throw new Error(`production source root is unsafe: ${scanRoot}`);
  }

  const ownerRelativePaths = [
    'core/agent-runner',
    'core/coordination/client',
    'core/coordination/migration',
    'core/coordination/process-identity',
    'core/disk-gate',
    'core/git-process',
    'core/parallel-runtime',
    'core/private-path',
  ];
  const approvedProcessOwners = new Set();
  const allowedGitLiteralOwners = new Set();
  for (const sourceRoot of sourceRoots) {
    const extension = sourceRoot.endsWith(join('dist', 'src')) ? '.js' : '.ts';
    for (const relativePath of ownerRelativePaths) approvedProcessOwners.add(resolve(sourceRoot, `${relativePath}${extension}`));
    allowedGitLiteralOwners.add(resolve(sourceRoot, `core/git-process${extension}`));
    allowedGitLiteralOwners.add(resolve(sourceRoot, `core/git-guard${extension}`));
  }
  approvedProcessOwners.add(resolve(root, 'bin', 'autopilot-agent-run.mjs'));
  for (const script of ['check-package-payload.mjs', 'run-certified-command.mjs', 'test-packed-consumer-release.mjs', 'verify-packed-consumer.mjs']) approvedProcessOwners.add(resolve(root, 'scripts', script));
  allowedGitLiteralOwners.add(resolve(root, 'scripts', 'check-production-git-spawns.mjs'));

  const violations = [];
  const childProcessModule = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bgetBuiltinModule\s*\(\s*)(['"])(?:node:)?child_process\1/gu;
  // Any exact executable token must remain owned by git-process. This catches
  // aliases, namespace calls, local/cross-file wrappers, and variables such as
  // `const executable = 'git'`, rather than only direct spawn('git', ...) calls.
  const exactGitLiteral = /(['"`])git\1/gu;
  for (const sourceRoot of scanRoots) {
    for (const path of regularFiles(sourceRoot)) {
      if (!/\.(?:[cm]?js|ts)$/u.test(path) || path.endsWith('.d.ts')) continue;
      const absolute = resolve(path);
      const text = readFileSync(path, 'utf8');
      childProcessModule.lastIndex = 0;
      const moduleMatch = childProcessModule.exec(text);
      if (moduleMatch !== null && !approvedProcessOwners.has(absolute)) {
        violations.push({ path: relative(root, path).replace(/\\/gu, '/'), line: lineNumber(text, moduleMatch.index), expression: moduleMatch[0], reason: 'unapproved-production-process-owner' });
        continue;
      }
      if (allowedGitLiteralOwners.has(absolute)) continue;
      exactGitLiteral.lastIndex = 0;
      const gitMatch = exactGitLiteral.exec(text);
      if (gitMatch !== null) violations.push({ path: relative(root, path).replace(/\\/gu, '/'), line: lineNumber(text, gitMatch.index), expression: gitMatch[0], reason: 'raw-git-executable-token-outside-owner' });
    }
  }
  if (violations.length > 0) fail('raw production Git process authority exists outside core/git-process', violations);
  else process.stdout.write(`${JSON.stringify({ schema_version: 'autopilot.production_git_spawn_check.v1', scanned_roots: ['src', 'dist/src', 'dist/extensions', 'bin', 'extensions', 'scripts'], allowed_git_owner: ['src/core/git-process.ts', 'dist/src/core/git-process.js'], approved_process_owners: [...approvedProcessOwners].map((path) => relative(root, path).replace(/\\/gu, '/')).sort(), violations: [], passed: true }, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
