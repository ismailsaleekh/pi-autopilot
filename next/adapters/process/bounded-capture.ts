import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import type { CaptureObservation } from "./types.js";

function systemCode(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "unknown";
  }
  try {
    const value = Reflect.get(input, "code");
    return typeof value === "string" && value.length > 0 ? value : "unknown";
  } catch {
    return "uninspectable";
  }
}

class TruncatingTransform extends Transform {
  private readonly maximumBytes: bigint;
  private observed = 0n;
  private captured = 0n;

  public constructor(maximumBytes: number) {
    super();
    this.maximumBytes = BigInt(maximumBytes);
  }

  public observation(path: string, faultCode: string | null): CaptureObservation {
    return Object.freeze({
      capturedBytes: this.captured.toString(10),
      faultCode,
      observedBytes: this.observed.toString(10),
      path,
      truncated: this.observed > this.captured,
    });
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.observed += BigInt(bytes.byteLength);
    const remaining = this.maximumBytes - this.captured;
    if (remaining <= 0n) {
      callback();
      return;
    }
    const acceptedLength = remaining < BigInt(bytes.byteLength)
      ? Number(remaining)
      : bytes.byteLength;
    this.captured += BigInt(acceptedLength);
    callback(null, acceptedLength === bytes.byteLength ? bytes : bytes.subarray(0, acceptedLength));
  }
}

export class BoundedCapture {
  private readonly limiter: TruncatingTransform;
  private readonly output: Writable;
  private readonly path: string;
  private faultCode: string | null = null;
  private attached = false;

  public constructor(path: string, maximumBytes: number, output: Writable) {
    this.path = path;
    this.limiter = new TruncatingTransform(maximumBytes);
    this.output = output;
    this.output.on("error", (error: unknown) => {
      this.faultCode = systemCode(error);
    });
  }

  public attach(input: Readable): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    input.pipe(this.limiter).pipe(this.output);
    void finished(this.output).catch(() => {
      input.unpipe(this.limiter);
      input.resume();
    });
  }

  public closeWithoutInput(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.limiter.pipe(this.output);
    this.limiter.end();
  }

  public async settled(): Promise<void> {
    try {
      await finished(this.output);
    } catch {
      // The fixed fault code is exposed by observation(); raw errors never cross.
    }
  }

  public observation(): CaptureObservation {
    return this.limiter.observation(this.path, this.faultCode);
  }
}
