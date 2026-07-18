import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { chmod, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { FileIdentity, Sha256Digest } from './contracts.ts';

export const S1_CORPUS_MAX_INVENTORY_NODES = 1_000_000;

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type InventoryNodeKind = 'regular' | 'directory' | 'socket' | 'symlink';

export interface InventoryNode {
  readonly relative_path: string;
  readonly kind: InventoryNodeKind;
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest | null;
  readonly symlink_target: string | null;
  readonly symlink_target_sha256: Sha256Digest | null;
}

export interface TreeInventory {
  readonly canonical_root: string;
  readonly root_identity: FileIdentity;
  readonly nodes: readonly InventoryNode[];
  readonly file_count: number;
  readonly total_bytes: number;
  readonly tree_sha256: Sha256Digest;
}

function digestBytes(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function pathFileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), link_count: stat.nlink });
}

export interface SecureRegularFileRead {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
}

function sameStableFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.nlink === right.nlink;
}

export function readRegularFileNoFollow(path: string, maximumBytes: number): SecureRegularFileRead {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) throw new Error('C5 private input is not a bounded physical regular file');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after) || bytes.byteLength !== before.size) throw new Error('C5 private input changed during its bounded read');
    return Object.freeze({ bytes, identity: Object.freeze({ device: String(before.dev), inode: String(before.ino), link_count: before.nlink }), mode: before.mode, size_bytes: before.size });
  } finally { closeSync(descriptor); }
}

export interface InspectedRegularFile {
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest;
}

export async function inspectRegularFileNoFollow(path: string): Promise<InspectedRegularFile> {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('C5 hash input is not a regular file');
    const hash = createHash('sha256');
    const stream = createReadStream(path, { fd: descriptor, autoClose: false, highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after)) throw new Error('C5 hash input changed during read');
    return Object.freeze({ identity: Object.freeze({ device: String(before.dev), inode: String(before.ino), link_count: before.nlink }), mode: before.mode, size_bytes: before.size, sha256: `sha256:${hash.digest('hex')}` });
  } finally { closeSync(descriptor); }
}

export async function hashRegularFile(path: string): Promise<Sha256Digest> {
  return (await inspectRegularFileNoFollow(path)).sha256;
}

export async function copyRegularFileNoFollow(source: string, destination: string, mode: number): Promise<void> {
  const descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationCreated = false;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('C5 copy input is not a regular file');
    const output = await open(destination, 'wx', mode & 0o777);
    destinationCreated = true;
    try {
      const stream = createReadStream(source, { fd: descriptor, autoClose: false, highWaterMark: 1024 * 1024 });
      let copied = 0;
      for await (const chunk of stream) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const write = await output.write(chunk.subarray(offset));
          if (write.bytesWritten < 1) throw new Error('C5 copy made no forward progress');
          offset += write.bytesWritten;
          copied += write.bytesWritten;
        }
      }
      if (copied !== before.size) throw new Error('C5 copy byte count changed during read');
      await output.sync();
    } finally { await output.close(); }
    await chmod(destination, mode & 0o777);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after)) throw new Error('C5 copy input changed during read');
    const copiedStat = lstatSync(destination);
    if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || copiedStat.nlink !== 1 || (copiedStat.dev === before.dev && copiedStat.ino === before.ino)) throw new Error('C5 copy output does not have independent regular-file identity');
  } catch (error) {
    if (destinationCreated) await rm(destination, { force: true });
    throw error;
  } finally { closeSync(descriptor); }
}

function normalizedRelative(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('..')) throw new Error('C5 inventory path escaped its canonical root');
  return rel.split(sep).join('/');
}

async function inventoryNode(root: string, path: string): Promise<InventoryNode> {
  const stat = lstatSync(path);
  const kind: InventoryNodeKind = stat.isFile() ? 'regular' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isSocket() ? 'socket' : (() => { throw new Error('unsupported filesystem node in C5 inventory'); })();
  const target = kind === 'symlink' ? readlinkSync(path) : null;
  const inspected = kind === 'regular' ? await inspectRegularFileNoFollow(path) : null;
  return Object.freeze({
    relative_path: normalizedRelative(root, path),
    kind,
    identity: inspected?.identity ?? pathFileIdentity(path),
    mode: (inspected?.mode ?? stat.mode) & 0o777,
    size_bytes: inspected?.size_bytes ?? stat.size,
    sha256: inspected?.sha256 ?? null,
    symlink_target: target,
    symlink_target_sha256: target === null ? null : digestBytes(target),
  });
}

export async function inventoryTree(rootPath: string): Promise<TreeInventory> {
  const canonicalRoot = realpathSync(rootPath);
  const rootStat = lstatSync(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('C5 inventory root must be a physical directory');
  const pending = [canonicalRoot];
  const nodes: InventoryNode[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('C5 inventory traversal stack underflow');
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === '.' || name === '..' || name.includes('\u0000')) throw new Error(`invalid filesystem entry in C5 inventory: ${name}`);
      const path = join(directory, name);
      const node = await inventoryNode(canonicalRoot, path);
      nodes.push(node);
      if (nodes.length > S1_CORPUS_MAX_INVENTORY_NODES) throw new Error(`C5 inventory exceeded ${String(S1_CORPUS_MAX_INVENTORY_NODES)} nodes`);
      if (node.kind === 'directory') pending.push(path);
    }
  }
  nodes.sort((left, right) => compareCodeUnits(left.relative_path, right.relative_path));
  const totalBytes = nodes.reduce((total, node) => total + (node.kind === 'regular' ? node.size_bytes : 0), 0);
  const digestInput = nodes.map((node) => ({ relative_path: node.relative_path, kind: node.kind, identity: node.identity, mode: node.mode, size_bytes: node.size_bytes, sha256: node.sha256, symlink_target_sha256: node.symlink_target_sha256 }));
  return Object.freeze({ canonical_root: canonicalRoot, root_identity: pathFileIdentity(canonicalRoot), nodes: Object.freeze(nodes), file_count: nodes.filter((node) => node.kind === 'regular').length, total_bytes: totalBytes, tree_sha256: digestBytes(canonicalJson(digestInput)) });
}

export function sourcePathDigest(rehearsalId: string, canonicalSourcePath: string): Sha256Digest {
  const path = resolve(canonicalSourcePath);
  return digestBytes(`pi-autopilot/c5/source-path/v1\0${rehearsalId}\0${path}`);
}

export function assertDisjointCanonicalRoots(leftPath: string, rightPath: string): void {
  const left = realpathSync(leftPath);
  const right = realpathSync(rightPath);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contained = (rel: string): boolean => rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  if (contained(leftToRight) || contained(rightToLeft)) throw new Error('C5 source/copy roots are not disjoint');
}

export function assertNoSharedRegularFileIdentity(source: TreeInventory, copy: TreeInventory): void {
  const sourceIdentities = new Set(source.nodes.filter((node) => node.kind === 'regular').map((node) => `${node.identity.device}\0${node.identity.inode}`));
  for (const node of copy.nodes) {
    if (node.kind !== 'regular') continue;
    const key = `${node.identity.device}\0${node.identity.inode}`;
    if (sourceIdentities.has(key)) throw new Error(`C5 copy shares a regular-file identity with source: ${node.relative_path}`);
    if (node.identity.link_count !== 1) throw new Error(`C5 copy regular file is hardlinked: ${node.relative_path}`);
  }
}

export function assertCloneSymlinksContained(cloneRootPath: string, inventory: TreeInventory): void {
  const cloneRoot = realpathSync(cloneRootPath);
  for (const node of inventory.nodes) {
    if (node.kind !== 'symlink' || node.symlink_target === null) continue;
    const linkPath = resolve(cloneRoot, ...node.relative_path.split('/'));
    let resolvedTarget: string;
    try { resolvedTarget = realpathSync(linkPath); }
    catch { throw new Error(`C5 clone symlink is dangling or unresolvable: ${node.relative_path}`); }
    const rel = relative(cloneRoot, resolvedTarget);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`C5 clone symlink escapes clone authority: ${node.relative_path}`);
  }
}

export function inventoryDigest(inventory: TreeInventory): Sha256Digest {
  return digestBytes(canonicalJson({ root_identity: inventory.root_identity, file_count: inventory.file_count, total_bytes: inventory.total_bytes, tree_sha256: inventory.tree_sha256 }));
}
