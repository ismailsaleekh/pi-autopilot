// Two-tier hashing for the docs freshness fence (design §7.1).
//
//   signature_hash = SHA-256 over a normalized digest of the EXPORTED type/value
//                    signatures of covers_sources, computed via the TypeScript
//                    compiler API (never a regex). A contract change moves this hash
//                    and hard-blocks (C4) until re-attested. Internal refactors that
//                    do not touch exported signatures leave it unchanged (low noise).
//
//   body_hash      = SHA-256 over the normalized full bytes of covers_sources. It
//                    does NOT block; it populates the agentic review worklist so a
//                    behavior-only change is still surfaced (C11).
//
// Both are pure functions of on-disk source bytes: deterministic, offline, no time,
// no network, no randomness.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { PACKAGE_ROOT } from './config.mjs';

const require = createRequire(import.meta.url);

function ts() {
  try {
    return require('typescript');
  } catch {
    throw new Error('docs gate requires the "typescript" devDependency for signature hashing.');
  }
}

/** Normalize source bytes for body hashing: strip CR, normalize trailing whitespace/newlines. */
function normalizeBody(text) {
  return text.replace(/\r\n/gu, '\n').replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '\n');
}

// Matches a full GENERATED:<id> region (START marker … END marker). Kept in one
// place so the prose hash, C9 stale-phrase scan, and any future consumer strip the
// exact same mechanically-owned bytes.
const GENERATED_REGION_RE = /<!-- GENERATED:[a-z-]+ START[\s\S]*?<!-- GENERATED:[a-z-]+ END -->/gu;

/**
 * SHA-256 over the AUTHORED prose of a doc body: generated regions (which are a pure
 * projection of code and already byte-verified by C2) are removed, then the remainder
 * is normalized exactly like a source body. This is what a semantic review actually
 * reads, so binding the receipt to it means a prose-only edit invalidates the receipt
 * (C11 req 3) while a code-only regeneration of a generated region does not.
 * @param {string} body
 * @returns {string}
 */
export function computeDocProseHash(body) {
  return sha256(normalizeBody(body.replace(GENERATED_REGION_RE, '')));
}

function readSourceOrThrow(relPath) {
  const absolute = resolve(PACKAGE_ROOT, relPath);
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    throw new Error(`covers_sources entry does not exist: ${relPath}`);
  }
}

/**
 * Compute a stable digest of the exported signatures of a TypeScript source file.
 * We walk top-level exported declarations and emit a canonical text form of each
 * exported name + kind + (for typed declarations) its printed type/shape, sorted
 * by name so ordering changes do not move the hash.
 */
function exportedSignatureText(compiler, sourceText, fileName) {
  const sourceFile = compiler.createSourceFile(fileName, sourceText, compiler.ScriptTarget.ES2022, true);
  const printer = compiler.createPrinter({ removeComments: true, newLine: compiler.NewLineKind.LineFeed });
  const signatures = [];

  const isExported = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === compiler.SyntaxKind.ExportKeyword) ?? false;

  const printClause = (node) => printer.printNode(compiler.EmitHint.Unspecified, node, sourceFile).replace(/\s+/gu, ' ').trim();

  const visit = (node) => {
    if (compiler.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (compiler.isIdentifier(declaration.name)) {
          const typeText = declaration.type !== undefined ? printClause(declaration.type) : inferLiteralShape(compiler, declaration.initializer);
          signatures.push(`const ${declaration.name.text}: ${typeText}`);
        }
      }
    } else if (compiler.isFunctionDeclaration(node) && isExported(node) && node.name !== undefined) {
      const params = node.parameters.map((parameter) => printClause(parameter)).join(', ');
      const returnType = node.type !== undefined ? printClause(node.type) : 'inferred';
      signatures.push(`function ${node.name.text}(${params}): ${returnType}`);
    } else if (compiler.isClassDeclaration(node) && isExported(node) && node.name !== undefined) {
      const members = node.members
        .filter((member) => member.name !== undefined && compiler.isIdentifier(member.name))
        .map((member) => `${member.name.text}:${compiler.SyntaxKind[member.kind]}`)
        .sort();
      signatures.push(`class ${node.name.text} {${members.join(';')}}`);
    } else if (compiler.isInterfaceDeclaration(node) && isExported(node)) {
      const members = node.members.map((member) => printClause(member)).sort();
      signatures.push(`interface ${node.name.text} {${members.join(';')}}`);
    } else if (compiler.isTypeAliasDeclaration(node) && isExported(node)) {
      signatures.push(`type ${node.name.text} = ${printClause(node.type)}`);
    } else if (compiler.isEnumDeclaration(node) && isExported(node)) {
      const members = node.members.map((member) => printClause(member)).sort();
      signatures.push(`enum ${node.name.text} {${members.join(';')}}`);
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  return signatures.sort().join('\n');
}

function inferLiteralShape(compiler, initializer) {
  if (initializer === undefined) return 'untyped';
  if (compiler.isStringLiteral(initializer)) return 'string-literal';
  if (initializer.kind === compiler.SyntaxKind.NumericLiteral) return 'number-literal';
  if (initializer.kind === compiler.SyntaxKind.TrueKeyword || initializer.kind === compiler.SyntaxKind.FalseKeyword) return 'boolean-literal';
  if (compiler.isArrowFunction(initializer) || compiler.isFunctionExpression(initializer)) return 'function';
  if (compiler.isObjectLiteralExpression(initializer)) {
    const keys = initializer.properties
      .filter((property) => property.name !== undefined && compiler.isIdentifier(property.name))
      .map((property) => property.name.text)
      .sort();
    return `object{${keys.join(',')}}`;
  }
  if (compiler.isArrayLiteralExpression(initializer)) return 'array';
  if (compiler.isCallExpression(initializer)) return 'call';
  return 'expr';
}

/**
 * @param {readonly string[]} coversSources
 * @returns {{ signatureHash: string, bodyHash: string }}
 */
export function computeCoverHashes(coversSources) {
  const compiler = ts();
  const signatureParts = [];
  const bodyParts = [];
  for (const relPath of [...coversSources].sort()) {
    const source = readSourceOrThrow(relPath);
    if (relPath.endsWith('.ts')) {
      signatureParts.push(`# ${relPath}\n${exportedSignatureText(compiler, source, relPath)}`);
    } else {
      // Non-TS covered sources (rare): the whole normalized body is the signature.
      signatureParts.push(`# ${relPath}\n${normalizeBody(source)}`);
    }
    bodyParts.push(`# ${relPath}\n${normalizeBody(source)}`);
  }
  return {
    signatureHash: `sha256:${createHash('sha256').update(signatureParts.join('\n'), 'utf8').digest('hex')}`,
    bodyHash: `sha256:${createHash('sha256').update(bodyParts.join('\n'), 'utf8').digest('hex')}`,
  };
}

/** SHA-256 of an arbitrary UTF-8 string, prefixed. */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
