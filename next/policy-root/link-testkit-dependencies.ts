import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const modulePolicyRoot = dirname(fileURLToPath(import.meta.url));
const moduleParent = dirname(modulePolicyRoot);
const nextRoot = moduleParent.endsWith("dist-policy") ? dirname(moduleParent) : moduleParent;
const distRoot = join(nextRoot, "dist");
const testkitRoot = join(nextRoot, "dist-testkit");

for (const project of ["adapters", "apps", "authority", "ports", "runtime", "storage"]) {
  const target = join(distRoot, project);
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
  const link = join(testkitRoot, project);
  if (existsSync(link) || lstatExists(link)) {
    rmSync(link, { force: true, recursive: true });
  }
  symlinkSync(relative(testkitRoot, target), link, "dir");
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
