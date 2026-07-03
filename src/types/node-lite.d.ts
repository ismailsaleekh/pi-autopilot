declare const process: {
  readonly argv: readonly string[];
  readonly env: { [key: string]: string | undefined };
  readonly execPath: string;
  readonly pid: number;
  cwd(): string;
  chdir(directory: string): void;
  kill(pid: number, signal?: 0 | string): boolean;
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
  export interface Stats {
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
  }
  export function existsSync(path: string | URL): boolean;
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function realpathSync(path: string | URL): string;
  export function statSync(path: string | URL): Stats;
}

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
  }
  export interface Stats {
    readonly mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export interface FileHandle {
    writeFile(data: string, encoding?: 'utf8'): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function appendFile(path: string | URL, data: string, encoding?: 'utf8'): Promise<void>;
  export function mkdir(path: string | URL, options?: { readonly recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function open(path: string | URL, flags: string): Promise<FileHandle>;
  export function readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function rm(path: string | URL, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function stat(path: string | URL): Promise<Stats>;
  export function unlink(path: string | URL): Promise<void>;
  export function writeFile(path: string | URL, data: string | Uint8Array, encoding?: 'utf8'): Promise<void>;
  export function writeFile(path: string | URL, data: string | Uint8Array, options: { readonly encoding?: 'utf8'; readonly flag?: string }): Promise<void>;
} 

declare module 'node:os' {
  export function homedir(): string;
  export function hostname(): string;
  export function platform(): string;
  export function tmpdir(): string;
  export function uptime(): number;
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
    readonly error?: Error;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns;
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
}
