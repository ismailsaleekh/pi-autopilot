declare module 'node:fs' {
  export function renameSync(oldPath: string | URL, newPath: string | URL): void;
  export function rmSync(path: string | URL, options?: { readonly force?: boolean }): void;
  export function writeFileSync(
    path: string | URL,
    data: string,
    options?: { readonly encoding?: 'utf8'; readonly flag?: string; readonly mode?: number },
  ): void;
}
