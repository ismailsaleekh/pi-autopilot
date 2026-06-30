declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array, inputEncoding?: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
}

declare module 'node:fs' {
  export interface Stats {
    readonly size: number;
    isFile(): boolean;
  }

  export function readFileSync(path: string | URL): Uint8Array;
  export function statSync(path: string | URL): Stats;
}

declare module 'node:path' {
  export const sep: string;
  export function isAbsolute(path: string): boolean;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
}

declare const Buffer: {
  from(value: string, encoding?: 'utf8'): Uint8Array;
  byteLength(value: string, encoding?: 'utf8'): number;
};
