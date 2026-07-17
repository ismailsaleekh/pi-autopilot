declare const process: {
  readonly argv: readonly string[];
  readonly env: { [key: string]: string | undefined };
  readonly execPath: string;
  readonly pid: number;
  readonly stdin: import('node:readline').ReadableInput;
  cwd(): string;
  chdir(directory: string): void;
  memoryUsage(): { readonly rss: number; readonly heapTotal: number; readonly heapUsed: number; readonly external: number; readonly arrayBuffers: number };
  resourceUsage(): { readonly maxRSS: number };
  kill(pid: number, signal?: 0 | string): boolean;
  exit(code?: number): never;
  exitCode: number | undefined;
  once(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): void;
  off(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): void;
};

declare module 'node:test' {
  export function after(fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, error?: unknown, message?: string): Promise<void>;
    doesNotThrow(fn: () => unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module 'node:fs' {
  export interface Stats {
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly dev: number;
    readonly ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string | URL): boolean;
  export function copyFileSync(source: string | URL, destination: string | URL, mode?: number): void;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string | URL | number): Uint8Array;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function readdirSync(path: string | URL, options: { readonly withFileTypes: true }): import('node:fs/promises').Dirent[];
  export function realpathSync(path: string | URL): string;
  export function lstatSync(path: string | URL): Stats;
  export function statSync(path: string | URL): Stats;
  export function chmodSync(path: string | URL, mode: number): void;
  export function openSync(path: string | URL, flags: number | string, mode?: number): number;
  export function writeSync(fd: number, data: string): number;
  export function writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  export function writeFileSync(fd: number, data: string, encoding?: 'utf8'): void;
  export function writeFileSync(path: string | URL, data: string | Uint8Array, options?: { readonly encoding?: 'utf8'; readonly flag?: string; readonly mode?: number }): void;
  export function linkSync(existingPath: string | URL, newPath: string | URL): void;
  export interface ReadStream extends AsyncIterable<string> { destroy(): void; }
  export function createReadStream(path: string | URL, options: { readonly encoding: 'utf8'; readonly fd?: number; readonly autoClose?: boolean }): ReadStream;
  export function unlinkSync(path: string | URL): void;
  export function rmSync(path: string | URL, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
  export function linkSync(existingPath: string | URL, newPath: string | URL): void;
  export function fstatSync(fd: number): Stats;
  export function closeSync(fd: number): void;
  export function fsyncSync(fd: number): void;
  export namespace constants {
    const O_RDONLY: number;
    const O_WRONLY: number;
    const O_CREAT: number;
    const O_EXCL: number;
    const O_NOFOLLOW: number;
    const COPYFILE_EXCL: number;
  }
}

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    readonly mtimeMs: number;
    readonly size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface FileHandle {
    writeFile(data: string, encoding?: 'utf8'): Promise<void>;
    write(data: Uint8Array): Promise<{ readonly bytesWritten: number; readonly buffer: Uint8Array }>;
    read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ readonly bytesRead: number; readonly buffer: Uint8Array }>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function appendFile(path: string | URL, data: string, encoding?: 'utf8'): Promise<void>;
  export function lstat(path: string | URL): Promise<Stats>;
  export function link(existingPath: string | URL, newPath: string | URL): Promise<void>;
  export function chmod(path: string | URL, mode: number): Promise<void>;
  export function copyFile(source: string | URL, destination: string | URL, mode?: number): Promise<void>;
  export function mkdir(path: string | URL, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function open(path: string | URL, flags: string, mode?: number): Promise<FileHandle>;
  export function readdir(path: string | URL): Promise<string[]>;
  export function readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function realpath(path: string | URL): Promise<string>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function rm(path: string | URL, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function stat(path: string | URL): Promise<Stats>;
  export function symlink(target: string | URL, path: string | URL, type?: 'dir' | 'file' | 'junction'): Promise<void>;
  export function unlink(path: string | URL): Promise<void>;
  export function writeFile(path: string | URL, data: string | Uint8Array, encoding?: 'utf8'): Promise<void>;
  export function writeFile(path: string | URL, data: string | Uint8Array, options: { readonly encoding?: 'utf8'; readonly flag?: string; readonly mode?: number }): Promise<void>;
} 

declare module 'node:readline' {
  export interface ReadableInput extends AsyncIterable<string | Uint8Array> {}
  export interface Interface extends AsyncIterable<string> { close(): void; }
  export function createInterface(options: { readonly input: ReadableInput | import('node:fs').ReadStream; readonly crlfDelay: number }): Interface;
}

declare module 'node:os' {
  export function homedir(): string;
  export function hostname(): string;
  export function platform(): string;
  export function tmpdir(): string;
  export function uptime(): number;
}

declare module 'node:path' {
  export function extname(path: string): string;
  export function join(...parts: readonly string[]): string;
  export function resolve(...parts: readonly string[]): string;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
}

declare module 'node:child_process' {
  export interface SpawnSyncOptions {
    readonly cwd?: string | URL;
    readonly encoding: 'utf8';
    readonly env?: { readonly [key: string]: string | undefined };
    readonly input?: string;
    readonly timeout?: number;
    readonly maxBuffer?: number;
  }
  export interface SpawnSyncReturns {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: Error;
  }
  export interface SpawnSyncBufferOptions {
    readonly cwd?: string | URL;
    readonly env?: { readonly [key: string]: string | undefined };
    readonly input?: string | Uint8Array;
    readonly timeout?: number;
    readonly maxBuffer?: number;
  }
  export interface SpawnSyncBufferReturns {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: NodeBuffer;
    readonly stderr: NodeBuffer;
    readonly error?: Error;
  }
  export interface ChildProcessDataChunk extends Uint8Array {
    toString(): string;
    toString(encoding: 'utf8'): string;
  }
  export interface ChildProcessWritablePipe {
    write(data: string, callback?: (error: Error | null | undefined) => void): void;
    end(): void;
  }
  export interface ChildProcessReadablePipe {
    on(event: 'data', listener: (chunk: ChildProcessDataChunk) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  }
  export interface ChildProcessLite {
    readonly stdin: ChildProcessWritablePipe;
    readonly stdout: ChildProcessReadablePipe;
    readonly stderr: ChildProcessReadablePipe;
    readonly killed: boolean;
    readonly pid: number | undefined;
    readonly exitCode: number | null;
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
    unref(): void;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
    once(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
    once(event: 'error', listener: (error: Error) => void): void;
  }
  export interface SpawnOptionsLite {
    readonly cwd?: string;
    readonly env?: { readonly [key: string]: string | undefined };
    readonly stdio?: readonly ['pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'] | 'ignore';
    readonly shell?: boolean;
    readonly detached?: boolean;
  }
  export function execFileSync(
    command: string,
    args: readonly string[],
    options: { readonly encoding: 'utf8'; readonly maxBuffer?: number },
  ): string;
  export function spawn(command: string, args: readonly string[], options?: SpawnOptionsLite): ChildProcessLite;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnSyncBufferOptions,
  ): SpawnSyncBufferReturns;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ): SpawnSyncReturns;
}

declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
  export function randomUUID(): string;
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

declare interface NodeBuffer extends Uint8Array {
  readonly byteLength: number;
  readUInt32BE(offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  subarray(start?: number, end?: number): NodeBuffer;
  toString(encoding?: 'utf8'): string;
}

declare const Buffer: {
  from(value: string | Uint8Array, encoding?: 'utf8'): NodeBuffer;
  byteLength(value: string, encoding?: 'utf8'): number;
  alloc(size: number): NodeBuffer;
  allocUnsafe(size: number): NodeBuffer;
  concat(values: readonly Uint8Array[]): NodeBuffer;
};

declare module 'node:net' {
  export interface Socket {
    readonly destroyed: boolean;
    write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    end(): void;
    destroy(): void;
    on(event: 'data', listener: (chunk: NodeBuffer) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    once(event: 'connect' | 'close', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    off(event: 'error', listener: (error: Error) => void): this;
  }
  export interface Server {
    listen(path: string): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'listening', listener: () => void): this;
    off(event: 'error', listener: (error: Error) => void): this;
    off(event: 'listening', listener: () => void): this;
    close(callback: (error?: Error) => void): void;
  }
  export function connect(path: string): Socket;
  export function createServer(listener: (socket: Socket) => void): Server;
}

declare module 'node:sqlite' {
  export type SQLInputValue = string | number | bigint | null | Uint8Array;
  export type SQLOutputValue = string | number | bigint | null | Uint8Array;
  export interface StatementResultingChanges {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    get(...parameters: readonly SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...parameters: readonly SQLInputValue[]): Record<string, SQLOutputValue>[];
    iterate(...parameters: readonly SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
    run(...parameters: readonly SQLInputValue[]): StatementResultingChanges;
  }
  export class DatabaseSync {
    constructor(path: string | URL, options?: { readonly timeout?: number; readonly enableForeignKeyConstraints?: boolean; readonly readOnly?: boolean });
    readonly isTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    serialize(schema?: string): Uint8Array;
    close(): void;
  }
  export function backup(source: DatabaseSync, path: string | URL): Promise<number>;
}
