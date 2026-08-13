import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export interface NegativeCompileResult {
  readonly path: string;
  readonly failedAsRequired: boolean;
  readonly diagnostics: readonly string[];
  readonly diagnosticCodes: readonly number[];
}

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = basename(moduleParent) === "dist-policy" ? dirname(moduleParent) : moduleParent;
const policyRoot = join(nextRoot, "policy-root");

function compilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    useUnknownInCatchVariables: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  };
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${String(diagnostic.code)} ${message}`;
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${relative(nextRoot, diagnostic.file.fileName)}:${String(location.line + 1)} TS${String(diagnostic.code)} ${message}`;
}

export function compileNegativeFixture(path: string): NegativeCompileResult {
  const program = ts.createProgram([path], compilerOptions());
  const rawDiagnostics = ts.getPreEmitDiagnostics(program);
  const diagnostics = rawDiagnostics.map(diagnosticText);
  return Object.freeze({
    path,
    failedAsRequired: diagnostics.length > 0,
    diagnostics: Object.freeze(diagnostics),
    diagnosticCodes: Object.freeze(rawDiagnostics.map((diagnostic) => diagnostic.code)),
  });
}

export function runNegativeCompileFixtures(fixturesDirectory: string): readonly NegativeCompileResult[] {
  if (!existsSync(fixturesDirectory)) {
    return Object.freeze([]);
  }
  const files = readdirSync(fixturesDirectory)
    .filter((name) => name.endsWith(".compile-fail.ts"))
    .sort();
  return Object.freeze(files.map((name) => compileNegativeFixture(join(fixturesDirectory, name))));
}

const invokedFile = basename(process.argv[1] ?? "");
if (invokedFile === "negative-compile.ts" || invokedFile === "negative-compile.js") {
  const results = runNegativeCompileFixtures(join(policyRoot, "fixtures"));
  let failed = false;
  for (const result of results) {
    if (!result.failedAsRequired) {
      process.stderr.write(`negative fixture unexpectedly compiled: ${relative(nextRoot, result.path)}\n`);
      failed = true;
    }
  }
  if (failed) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`negative compile fixtures: ${String(results.length)} rejected\n`);
  }
}

export function fixtureSource(path: string): string {
  return readFileSync(path, "utf8");
}
