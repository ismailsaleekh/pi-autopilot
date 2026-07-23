import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { chmod, mkdir, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import type { FileIdentity, Sha256Digest } from './contracts.ts';

export const S2_CORPUS_MAX_INVENTORY_NODES = 1_000_000;
export type InventoryNodeKind = 'regular' | 'directory' | 'socket' | 'symlink';

export interface InventoryNode {
  readonly relative_path: string;
  readonly kind: InventoryNodeKind;
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
  readonly sha256: Sha256Digest | null;
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

export interface SecureRegularFileRead {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly mode: number;
  readonly size_bytes: number;
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function digestBytes(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameStableFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.nlink === right.nlink;
}

export function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), link_count: stat.nlink });
}

export function readRegularFileNoFollow(path: string, maximumBytes: number): SecureRegularFileRead {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) throw new Error('S2-D input is not a bounded physical regular file');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after) || bytes.byteLength !== before.size) throw new Error('S2-D input changed during bounded read');
    return Object.freeze({ bytes, identity: Object.freeze({ device: String(before.dev), inode: String(before.ino), link_count: before.nlink }), mode: before.mode, size_bytes: before.size });
  } finally { closeSync(descriptor); }
}

export async function hashRegularFile(path: string): Promise<Sha256Digest> {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('S2-D hash input is not a regular file');
    const hash = createHash('sha256');
    const stream = createReadStream(path, { fd: descriptor, autoClose: false, highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after)) throw new Error('S2-D hash input changed during read');
    return `sha256:${hash.digest('hex')}`;
  } finally { closeSync(descriptor); }
}

export async function copyRegularFileNoFollow(source: string, destination: string, mode: number): Promise<void> {
  const descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationCreated = false;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('S2-D copy input is not a regular file');
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    const output = await open(destination, 'wx', mode & 0o777);
    destinationCreated = true;
    try {
      const stream = createReadStream(source, { fd: descriptor, autoClose: false, highWaterMark: 1024 * 1024 });
      let copied = 0;
      for await (const chunk of stream) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await output.write(chunk.subarray(offset));
          if (written.bytesWritten < 1) throw new Error('S2-D copy made no forward progress');
          copied += written.bytesWritten;
          offset += written.bytesWritten;
        }
      }
      if (copied !== before.size) throw new Error('S2-D copy byte count changed during read');
      await output.sync();
    } finally { await output.close(); }
    await chmod(destination, mode & 0o777);
    const after = fstatSync(descriptor);
    if (!sameStableFile(before, after)) throw new Error('S2-D copy input changed during read');
    const copiedStat = lstatSync(destination);
    if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || copiedStat.nlink !== 1 || (copiedStat.dev === before.dev && copiedStat.ino === before.ino)) throw new Error('S2-D copy output does not have independent regular-file identity');
  } catch (error) {
    if (destinationCreated) await rm(destination, { force: true });
    throw error;
  } finally { closeSync(descriptor); }
}

function normalizedRelative(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('..')) throw new Error('S2-D inventory path escaped root');
  return rel.split(sep).join('/');
}

async function nodeFor(root: string, path: string): Promise<InventoryNode> {
  const stat = lstatSync(path);
  const kind: InventoryNodeKind = stat.isFile() ? 'regular' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isSocket() ? 'socket' : (() => { throw new Error('S2-D inventory found unsupported filesystem node'); })();
  const targetDigest = kind === 'symlink' ? digestBytes(readlinkSync(path)) : null;
  const fileDigest = kind === 'regular' ? await hashRegularFile(path) : null;
  return Object.freeze({ relative_path: normalizedRelative(root, path), kind, identity: fileIdentity(path), mode: stat.mode & 0o777, size_bytes: stat.size, sha256: fileDigest, symlink_target_sha256: targetDigest });
}

export async function inventoryTree(rootPath: string): Promise<TreeInventory> {
  const canonicalRoot = realpathSync(rootPath);
  const rootStat = lstatSync(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('S2-D inventory root must be a physical directory');
  const pending = [canonicalRoot];
  const nodes: InventoryNode[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('S2-D inventory traversal underflow');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\u0000')) throw new Error('S2-D inventory found invalid entry name');
      const path = join(directory, entry.name);
      const node = await nodeFor(canonicalRoot, path);
      nodes.push(node);
      if (nodes.length > S2_CORPUS_MAX_INVENTORY_NODES) throw new Error('S2-D inventory exceeded bounded node limit');
      if (node.kind === 'directory') pending.push(path);
    }
  }
  nodes.sort((left, right) => compareCodeUnits(left.relative_path, right.relative_path));
  const totalBytes = nodes.reduce((total, node) => total + (node.kind === 'regular' ? node.size_bytes : 0), 0);
  const digestInput = nodes.map((node) => ({ relative_path: node.relative_path, kind: node.kind, identity: node.identity, mode: node.mode, size_bytes: node.size_bytes, sha256: node.sha256, symlink_target_sha256: node.symlink_target_sha256 }));
  return Object.freeze({ canonical_root: canonicalRoot, root_identity: fileIdentity(canonicalRoot), nodes: Object.freeze(nodes), file_count: nodes.filter((node) => node.kind === 'regular').length, total_bytes: totalBytes, tree_sha256: digestBytes(canonicalJson(digestInput)) });
}

export function inventoryDigest(inventory: TreeInventory): Sha256Digest {
  return digestBytes(canonicalJson({ root_identity: inventory.root_identity, file_count: inventory.file_count, total_bytes: inventory.total_bytes, tree_sha256: inventory.tree_sha256 }));
}

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function assertDisjointCanonicalRoots(leftPath: string, rightPath: string): void {
  const left = realpathSync(leftPath);
  const right = realpathSync(rightPath);
  if (inside(left, right) || inside(right, left)) throw new Error('S2-D source and clone roots are not disjoint');
}

export function assertNoSharedRegularFileIdentity(source: TreeInventory, copy: TreeInventory): void {
  const sourceIds = new Set(source.nodes.filter((node) => node.kind === 'regular').map((node) => `${node.identity.device}\0${node.identity.inode}`));
  for (const node of copy.nodes) {
    if (node.kind !== 'regular') continue;
    if (node.identity.link_count !== 1) throw new Error(`S2-D clone regular file is hardlinked: ${node.relative_path}`);
    if (sourceIds.has(`${node.identity.device}\0${node.identity.inode}`)) throw new Error(`S2-D clone shares a regular-file identity with live source: ${node.relative_path}`);
  }
}

export function assertNoSymlinkSocketOrHardlinkRoute(inventory: TreeInventory): void {
  for (const node of inventory.nodes) {
    if (node.kind === 'symlink' || node.kind === 'socket') throw new Error(`S2-D clone contains a live-routable ${node.kind}: ${node.relative_path}`);
    if (node.kind === 'regular' && node.identity.link_count !== 1) throw new Error(`S2-D clone contains a hardlinked file: ${node.relative_path}`);
  }
}

export async function copyTreeWithoutLinks(sourceRoot: string, destinationRoot: string): Promise<void> {
  const source = realpathSync(sourceRoot);
  const destination = resolve(destinationRoot);
  if (inside(source, destination) || inside(destination, source)) throw new Error('S2-D copy roots must be disjoint');
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('S2-D copy source must be a physical directory');
  await mkdir(destination, { mode: sourceStat.mode & 0o777 });
  const pending: string[] = [source];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error('S2-D copy traversal underflow');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\u0000')) throw new Error('S2-D copy found invalid entry name');
      const sourcePath = join(directory, entry.name);
      const sourceInfo = lstatSync(sourcePath);
      if (sourceInfo.isSymbolicLink() || sourceInfo.isSocket() || (sourceInfo.isFile() && sourceInfo.nlink !== 1)) throw new Error('S2-D copy refuses live-routable symlink/socket/hardlink authority');
      const relativePath = relative(source, sourcePath);
      const destinationPath = resolve(destination, relativePath);
      if (!inside(destination, destinationPath)) throw new Error('S2-D copy destination escaped root');
      if (sourceInfo.isDirectory()) {
        await mkdir(destinationPath, { mode: sourceInfo.mode & 0o777 });
        pending.push(sourcePath);
      } else if (sourceInfo.isFile()) {
        await copyRegularFileNoFollow(sourcePath, destinationPath, sourceInfo.mode & 0o777);
      } else throw new Error('S2-D copy found unsupported filesystem node');
    }
  }
  const copied = await inventoryTree(destination);
  assertNoSymlinkSocketOrHardlinkRoute(copied);
}
