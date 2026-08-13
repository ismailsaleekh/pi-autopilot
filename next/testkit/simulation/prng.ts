function normalizeSeed(seed: unknown): number {
  return typeof seed === "number" && Number.isFinite(seed)
    ? Math.trunc(seed) >>> 0
    : 0;
}

function splitMix32(value: number): number {
  let mixed = (value + 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

/**
 * Deterministic xoshiro128** with SplitMix32 expansion from one 32-bit seed.
 * The algorithm uses only specified uint32 operations, so its stream is stable
 * across supported JavaScript processes and hosts.
 */
export class DeterministicRandom {
  private state0: number;
  private state1: number;
  private state2: number;
  private state3: number;

  public constructor(seed: unknown) {
    const normalized = normalizeSeed(seed);
    this.state0 = splitMix32(normalized);
    this.state1 = splitMix32(this.state0);
    this.state2 = splitMix32(this.state1);
    this.state3 = splitMix32(this.state2);
    if ((this.state0 | this.state1 | this.state2 | this.state3) === 0) {
      this.state3 = 1;
    }
  }

  public nextUint32(): number {
    const result = Math.imul(rotateLeft(Math.imul(this.state1, 5) >>> 0, 7), 9) >>> 0;
    const temporary = (this.state1 << 9) >>> 0;

    this.state2 = (this.state2 ^ this.state0) >>> 0;
    this.state3 = (this.state3 ^ this.state1) >>> 0;
    this.state1 = (this.state1 ^ this.state2) >>> 0;
    this.state0 = (this.state0 ^ this.state3) >>> 0;
    this.state2 = (this.state2 ^ temporary) >>> 0;
    this.state3 = rotateLeft(this.state3, 11);
    return result;
  }

  public nextBounded(bound: unknown): number {
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound <= 0) {
      return 0;
    }
    const safeBound = Math.min(bound, 0x1_0000_0000);
    const threshold = (0x1_0000_0000 - safeBound) % safeBound;
    let value = this.nextUint32();
    while (value < threshold) {
      value = this.nextUint32();
    }
    return value % safeBound;
  }

  public nextBoolean(): boolean {
    return (this.nextUint32() & 1) === 0;
  }

  public fork(label: unknown): DeterministicRandom {
    let mixed = this.nextUint32();
    if (typeof label === "string") {
      for (let index = 0; index < label.length; index += 1) {
        mixed = Math.imul(mixed ^ label.charCodeAt(index), 0x01000193) >>> 0;
      }
    }
    return new DeterministicRandom(mixed);
  }

  public snapshot(): readonly [number, number, number, number] {
    return Object.freeze([this.state0, this.state1, this.state2, this.state3]);
  }
}
