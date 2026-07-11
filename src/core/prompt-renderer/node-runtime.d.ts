declare module 'node:fs' {
  export function mkdirSync(path: string | URL, options?: { readonly recursive?: boolean; readonly mode?: number }): void;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}

declare module 'node:fs/promises' {
  export function writeFile(path: string | URL, data: string, encoding: 'utf8'): Promise<void>;
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
