declare const process: {
  readonly argv: readonly string[];
  readonly env: { [key: string]: string | undefined };
  readonly execPath: string;
  exit(code?: number): never;
};

declare module 'node:test' {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
}

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
  }
  export function mkdir(path: string | URL, options?: { readonly recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function rm(path: string | URL, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: readonly string[]): string;
  export function resolve(...parts: readonly string[]): string;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
}

declare module 'node:child_process' {
  export interface SpawnSyncOptions {
    readonly cwd?: string | URL;
    readonly encoding?: 'utf8';
    readonly env?: { readonly [key: string]: string | undefined };
    readonly input?: string;
    readonly timeout?: number;
  }
  export interface SpawnSyncReturns {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns;
}
