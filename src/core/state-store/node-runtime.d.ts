declare module 'node:fs' {
  export namespace constants {
    const R_OK: number;
  }
  export function existsSync(path: string | URL): boolean;
}

declare module 'node:fs/promises' {
  export function access(path: string | URL, mode?: number): Promise<void>;
  export function appendFile(
    path: string | URL,
    data: string,
    options?: { readonly encoding?: string },
  ): Promise<void>;
  export function mkdir(
    path: string | URL,
    options?: { readonly recursive?: boolean },
  ): Promise<string | undefined>;
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function rm(
    path: string | URL,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void>;
  export function stat(path: string | URL): Promise<{ isFile(): boolean }>;
  export function writeFile(
    path: string | URL,
    data: string,
    options?: { readonly encoding?: string; readonly flag?: string },
  ): Promise<void>;
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
}
