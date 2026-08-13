import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export interface PayloadFinding {
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

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
      } else if (extname(entry.name) === ".ts") {
        output.push(absolute);
      }
    }
  };
  visit(directory);
  return Object.freeze(output);
}

export function checkPayloadShapes(nextRoot: string): readonly PayloadFinding[] {
  const root = resolve(nextRoot);
  const output: PayloadFinding[] = [];
  const forbiddenBag = /Record\s*<\s*string\s*,\s*unknown\s*>|\{\s*\[\s*[^\]]+\s*:\s*string\s*\]\s*:\s*unknown\s*;?\s*\}/;
  const metadataName = /\bmetadata\b/i;
  for (const scannedRoot of ["authority", "ports"]) {
    for (const file of filesBelow(join(root, scannedRoot))) {
      const logical = slash(relative(root, file));
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (forbiddenBag.test(line)) {
          output.push(Object.freeze({
            path: logical,
            line: index + 1,
            detail: "open Record<string, unknown> payload bags are forbidden",
          }));
        }
        if (metadataName.test(line) && !logical.startsWith("policy-root/")) {
          output.push(Object.freeze({
            path: logical,
            line: index + 1,
            detail: "authoritative metadata fields are forbidden; use explicit fields or ArtifactRef",
          }));
        }
      }
    }
  }
  return Object.freeze(output);
}
