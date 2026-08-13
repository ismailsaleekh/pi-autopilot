import { fileURLToPath } from "node:url";
import {
  openCas,
  putBlob,
} from "../../../storage/cas/index.js";
import type {
  CasDurabilityEvent,
  CasDurabilityObserver,
} from "../../../storage/cas/index.js";

function send(message: unknown): void {
  if (process.send !== undefined) {
    process.send(message);
  }
}

function forever(): Promise<void> {
  return new Promise(() => {
    process.on("message", () => {
      // A live IPC listener keeps the helper blocked until the parent sends SIGKILL.
    });
  });
}

function deterministicBytes(seed: number, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + index + 1) >>> 0;
    output[index] = state & 0xff;
  }
  return output;
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const split = Math.floor(bytes.byteLength / 3);
  yield bytes.subarray(0, split);
  yield bytes.subarray(split, split * 2);
  yield bytes.subarray(split * 2);
}

async function killPut(
  casRoot: string,
  point: string,
  seed: number,
  byteLength: number,
): Promise<void> {
  const observer: CasDurabilityObserver = async (event: CasDurabilityEvent): Promise<void> => {
    if (event.objectKind === "blob" && event.point === point) {
      send(Object.freeze({
        digest: event.digest,
        event: "point",
        path: event.path,
        point: event.point,
      }));
      await forever();
    }
  };
  const opened = await openCas(casRoot, { durabilityObserver: observer });
  if (opened.kind === "error") {
    send(Object.freeze({ code: opened.error.code, event: "result", kind: "error" }));
    return;
  }
  const result = await putBlob(opened.store, chunks(deterministicBytes(seed, byteLength)));
  send(Object.freeze({ event: "result", kind: result.kind }));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (mode === "kill-put") {
    await killPut(
      process.argv[3] ?? "",
      process.argv[4] ?? "",
      Number(process.argv[5] ?? "0"),
      Number(process.argv[6] ?? "0"),
    );
  } else {
    send(Object.freeze({ event: "error", message: "unknown child mode" }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
