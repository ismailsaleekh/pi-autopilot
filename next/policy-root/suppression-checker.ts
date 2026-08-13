import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type SuppressionKind =
  | "any"
  | "ts-ignore"
  | "ts-nocheck"
  | "as-cast"
  | "type-assertion"
  | "non-null";

export interface SuppressionFinding {
  readonly kind: SuppressionKind;
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

const SCANNED_ROOTS = Object.freeze(["authority", "runtime", "storage"]);

function slash(value: string): string {
  return value.split(sep).join("/");
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function filesBelow(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    return Object.freeze([]);
  }
  const output: string[] = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .slice()
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (extname(entry.name) === ".ts" && !entry.name.endsWith(".d.ts")) {
        output.push(absolute);
      }
    }
  };
  visit(directory);
  return Object.freeze(output);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function scanSuppressionText(path: string, text: string): readonly SuppressionFinding[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const output: SuppressionFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\/\/[\/]?\s*@ts-ignore\b|\/\*\s*@ts-ignore\b/.test(line)) {
      output.push(Object.freeze({
        kind: "ts-ignore",
        path,
        line: index + 1,
        detail: "@ts-ignore is forbidden",
      }));
    }
    if (/^\s*\/\/[\/]?\s*@ts-nocheck\b|\/\*\s*@ts-nocheck\b/.test(line)) {
      output.push(Object.freeze({
        kind: "ts-nocheck",
        path,
        line: index + 1,
        detail: "@ts-nocheck is forbidden",
      }));
    }
  }

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      output.push(Object.freeze({
        kind: "any",
        path,
        line: lineOf(sourceFile, node),
        detail: "the any type is forbidden",
      }));
    } else if (ts.isAsExpression(node)) {
      const permittedConst = node.type.kind === ts.SyntaxKind.TypeReference
        && node.type.getText(sourceFile) === "const";
      if (!permittedConst) {
        output.push(Object.freeze({
          kind: "as-cast",
          path,
          line: lineOf(sourceFile, node),
          detail: "as-casts are forbidden except as const",
        }));
      }
    } else if (ts.isTypeAssertionExpression(node)) {
      output.push(Object.freeze({
        kind: "type-assertion",
        path,
        line: lineOf(sourceFile, node),
        detail: "angle-bracket type assertions are forbidden",
      }));
    } else if (ts.isNonNullExpression(node)) {
      output.push(Object.freeze({
        kind: "non-null",
        path,
        line: lineOf(sourceFile, node),
        detail: "non-null assertions are forbidden",
      }));
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return Object.freeze(output);
}

export function checkSuppressions(nextRoot: string): readonly SuppressionFinding[] {
  const root = resolve(nextRoot);
  const output: SuppressionFinding[] = [];
  for (const scannedRoot of SCANNED_ROOTS) {
    for (const file of filesBelow(join(root, scannedRoot))) {
      const logicalPath = slash(relative(root, file));
      output.push(...scanSuppressionText(logicalPath, readFileSync(file, "utf8")));
    }
  }
  return Object.freeze(output);
}

export function formatSuppressionFinding(value: SuppressionFinding): string {
  return `suppression ${value.kind} ${value.path}:${String(value.line)} ${value.detail}`;
}
