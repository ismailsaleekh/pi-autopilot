import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = moduleParent.endsWith("dist-policy") ? dirname(moduleParent) : moduleParent;
const emittedAuthority = join(nextRoot, "dist", "authority");

function javascriptFiles(directory: string): readonly string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (extname(entry.name) === ".js") {
        output.push(absolute);
      }
    }
  };
  visit(directory);
  return Object.freeze(output.sort());
}

test("fresh emitted authority contains no ambient effect references", () => {
  const forbidden = Object.freeze([
    "Date.",
    "Math.random",
    "globalThis",
    "process.",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "fetch(",
    "new Promise",
  ]);
  const files = javascriptFiles(emittedAuthority);
  assert.equal(files.length > 0, true);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} contains ${token}`);
    }
  }
});
