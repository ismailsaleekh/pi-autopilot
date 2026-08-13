import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export interface HygieneFinding {
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

const ROOTS = Object.freeze([
  "authority",
  "runtime",
  "storage",
  "ports",
  "adapters",
  "apps",
  "extensions",
  "policy-root",
  "testkit",
  "tests",
]);

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
      } else if (new Set([".ts", ".md", ".json"]).has(extname(entry.name))) {
        output.push(absolute);
      }
    }
  };
  visit(directory);
  return Object.freeze(output);
}

export function checkHygiene(nextRoot: string): readonly HygieneFinding[] {
  const root = resolve(nextRoot);
  const output: HygieneFinding[] = [];
  for (const scannedRoot of ROOTS) {
    for (const file of filesBelow(join(root, scannedRoot))) {
      const logical = slash(relative(root, file));
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const unfinishedWords = Object.freeze([
          `TO${"DO"}`,
          `FIX${"ME"}`,
          `PLACE${"HOLDER"}`,
        ]);
        if (unfinishedWords.some((word) => new RegExp(`\\b${word}\\b`, "i").test(line))) {
          output.push(Object.freeze({
            path: logical,
            line: index + 1,
            detail: "unfinished-work marker is forbidden in delivered scope",
          }));
        }
      }
    }
  }
  return Object.freeze(output);
}
