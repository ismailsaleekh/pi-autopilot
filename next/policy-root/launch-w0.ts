import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packageRoot = process.cwd();
const tsc = join(packageRoot, "..", "node_modules", ".bin", "tsc");
const compile = spawnSync(tsc, ["-p", "tsconfig.policy.json", "--pretty", "false"], {
  cwd: packageRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (compile.error !== undefined) {
  process.stderr.write(`${compile.error.message}\n`);
  process.exitCode = 1;
} else if (compile.status !== 0) {
  process.exitCode = compile.status ?? 1;
} else {
  const gate = spawnSync(process.execPath, ["dist-policy/policy-root/w0-gate.js"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (gate.error !== undefined) {
    process.stderr.write(`${gate.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = gate.status ?? 1;
  }
}
