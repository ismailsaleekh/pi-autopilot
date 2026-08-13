import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

async function flood(byteLength: number): Promise<void> {
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  let remaining = byteLength;
  while (remaining > 0) {
    const bytes = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
    if (!process.stdout.write(bytes)) {
      await once(process.stdout, "drain");
    }
    remaining -= bytes.byteLength;
  }
}

function forever(): Promise<void> {
  return new Promise(() => {
    const keepAlive = setInterval(() => {
      // The process remains an observable group member until signalled.
    }, 10_000);
    process.once("exit", () => clearInterval(keepAlive));
  });
}

function selfSignal(signal: string): void {
  switch (signal) {
    case "SIGINT":
    case "SIGTERM":
    case "SIGKILL":
    case "SIGHUP":
      process.kill(process.pid, signal);
      return;
    default:
      process.exitCode = 97;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (mode === "exit") {
    process.exitCode = Number(process.argv[3] ?? "0");
    return;
  }
  if (mode === "signal-self") {
    selfSignal(process.argv[3] ?? "SIGTERM");
    await forever();
    return;
  }
  if (mode === "flood") {
    await flood(Number(process.argv[3] ?? "0"));
    return;
  }
  if (mode === "environment") {
    process.stdout.write(`${JSON.stringify(process.env)}\n`);
    return;
  }
  if (mode === "text") {
    process.stdout.write(`${process.argv[3] ?? ""}\n`);
    return;
  }
  if (mode === "group-child") {
    process.on("SIGTERM", () => {
      // Ignore graceful termination so escalation can be observed.
    });
    if (typeof process.send === "function") {
      process.send("ready");
    }
    await forever();
    return;
  }
  if (mode === "group-parent" || mode === "group-root-exits") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "group-child"], {
      detached: false,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    if (child.pid === undefined) {
      process.exitCode = 98;
      return;
    }
    await once(child, "message");
    child.disconnect();
    process.stdout.write(`${String(child.pid)}\n`);
    if (mode === "group-root-exits") {
      child.unref();
      return;
    }
    process.on("SIGTERM", () => {
      // Keep both group members alive until the adapter escalates.
    });
    await forever();
    return;
  }
  process.stderr.write("unknown fixture mode\n");
  process.exitCode = 99;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
