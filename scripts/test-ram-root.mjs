// RAM-backed test-root manager (Phase 40 / D70, change C1).
//
// Provides a short, isolated, RAM-backed root that the fast test path routes
// TMPDIR/TMP/TEMP, the npm cache, the Node compile cache, and every SQLite/WAL
// state root, git fixture, and package-install fixture into. Because
// `os.tmpdir()` and the coordinator's `coordinatorTemporaryRoot()` both read
// TMPDIR, pointing TMPDIR at this root moves all 215+ `mkdtemp` sites and every
// coordinator Unix-socket fallback onto RAM with full POSIX fsync semantics.
//
// PRODUCTION DURABILITY IS UNTOUCHED. A RAM filesystem honours `fsync`/`fdatasync`
// exactly; `PRAGMA synchronous=FULL` still flushes to the RAM device. The only
// property removed is whole-machine power-loss durability, which no test can
// observe. No PRAGMA, wire, schema, or store constant is changed by this file.
//
// Platform backends (fail closed; no silent disk fallback):
//   * Linux : /dev/shm/<id> when it is a real tmpfs and has capacity.
//   * macOS : an hdiutil APFS RAM disk mounted at a SHORT path (so coordinator
//             sockets stay under the 100-byte fallback ceiling).
//   * other : an explicit, visible error unless AUTOPILOT_TEST_ALLOW_DISK_ROOT=1
//             is set (opt-in disk root for unsupported platforms, printed loudly).
//
// The manager sizes the RAM disk from a measured/överridable budget, keeps the
// short mount path, and always tears the device down (unmount + eject/rm) even
// on failure.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SIZE_MIB = 4096; // Sized for 8-worker unit lanes + the 32-client trace; override with AUTOPILOT_TEST_RAM_MIB.
const MACOS_SECTOR_BYTES = 512;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
}

function sizeMib() {
  return envInt('AUTOPILOT_TEST_RAM_MIB', DEFAULT_SIZE_MIB);
}

// ---- Linux: /dev/shm tmpfs -------------------------------------------------

function linuxShmRoot() {
  const shm = '/dev/shm';
  if (!existsSync(shm)) return null;
  let fs;
  try {
    fs = statfsSync(shm);
  } catch {
    return null;
  }
  // statfs type for tmpfs is 0x01021994; require a genuine in-memory fs.
  const TMPFS_MAGIC = 0x01021994;
  if (Number(fs.type) !== TMPFS_MAGIC) return null;
  const availableMib = Number(fs.bsize) * Number(fs.bavail) / (1024 * 1024);
  if (availableMib < sizeMib()) return null;
  return shm;
}

function acquireLinux() {
  const shm = linuxShmRoot();
  if (shm === null) {
    throw new Error('RAM-backed test root requires a tmpfs at /dev/shm with sufficient capacity; none is available. Set AUTOPILOT_TEST_ALLOW_DISK_ROOT=1 to opt into a disk root (slower, no RAM guarantee).');
  }
  const root = join(shm, `ap-fast-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    root,
    backend: `linux-tmpfs (${shm})`,
    release() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- macOS: hdiutil APFS RAM disk at a short mount path --------------------

function macCreateRamDisk(volumeName, mib) {
  const sectors = Math.ceil((mib * 1024 * 1024) / MACOS_SECTOR_BYTES);
  // Attach an unmounted RAM-backed block device, then format it APFS. diskutil
  // mounts it at /Volumes/<volumeName>; we keep volumeName short.
  const attach = execFileSync('hdiutil', ['attach', '-nomount', `ram://${String(sectors)}`], { encoding: 'utf8' });
  const device = attach.split('\n')[0]?.trim().split(/\s+/)[0];
  if (device === undefined || !device.startsWith('/dev/')) {
    throw new Error(`hdiutil did not return a RAM device node (got ${JSON.stringify(attach)})`);
  }
  try {
    execFileSync('diskutil', ['erasevolume', 'APFS', volumeName, device], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    // Formatting failed; do not leak the attached device.
    try { execFileSync('hdiutil', ['detach', device], { stdio: 'ignore' }); } catch { /* device already gone */ }
    throw error instanceof Error ? error : new Error(String(error));
  }
  return { device, mountPoint: `/Volumes/${volumeName}` };
}

function acquireMac() {
  // Short, unique volume name so /Volumes/<name> stays well under the socket
  // fallback ceiling (~57 bytes of TMPDIR budget). 6 hex chars is plenty.
  const suffix = `${(process.pid % 46656).toString(36)}${(Date.now() % 46656).toString(36)}`.padStart(6, '0').slice(0, 6);
  const volumeName = `apr${suffix}`; // e.g. "aprk3z9x1" — /Volumes/aprk3z9x1
  const { device, mountPoint } = macCreateRamDisk(volumeName, sizeMib());
  const root = join(mountPoint, 't');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let released = false;
  return {
    root,
    backend: `macos-hdiutil-apfs (${mountPoint}, ${String(sizeMib())} MiB, ${device})`,
    release() {
      if (released) return;
      released = true;
      // Eject unmounts and detaches the RAM device, freeing the memory.
      try { execFileSync('diskutil', ['eject', device], { stdio: 'ignore' }); return; }
      catch { /* fall through to hdiutil detach */ }
      try { execFileSync('hdiutil', ['detach', device, '-force'], { stdio: 'ignore' }); }
      catch { /* last resort: leave a loud trace for the orchestrator */ throw new Error(`failed to eject RAM disk device ${device} at ${mountPoint}; unmount manually`); }
    },
  };
}

// ---- Explicit disk opt-in for unsupported platforms ------------------------

function acquireDiskOptIn() {
  const base = process.env.AUTOPILOT_TEST_DISK_ROOT_BASE ?? '/tmp';
  const root = join(base, `ap-fast-disk-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    root,
    backend: `disk-opt-in (${base}) — NOT RAM-backed; slower, durability-identical`,
    release() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Acquire a RAM-backed (or explicitly opted-in disk) test root. Returns
 * `{ root, backend, release }`. Fails closed with a visible error on an
 * unsupported platform unless AUTOPILOT_TEST_ALLOW_DISK_ROOT=1.
 */
export function acquireTestRamRoot() {
  const allowDisk = process.env.AUTOPILOT_TEST_ALLOW_DISK_ROOT === '1';
  const os = platform();
  if (os === 'linux') {
    if (allowDisk && linuxShmRoot() === null) return acquireDiskOptIn();
    return acquireLinux();
  }
  if (os === 'darwin') {
    if (allowDisk) {
      // Operator explicitly chose a disk root (e.g. hdiutil unavailable in a
      // restricted sandbox). Honour it loudly rather than silently.
      return acquireDiskOptIn();
    }
    return acquireMac();
  }
  if (allowDisk) return acquireDiskOptIn();
  throw new Error(`RAM-backed test root is not implemented for platform "${os}". Set AUTOPILOT_TEST_ALLOW_DISK_ROOT=1 to run on a plain disk root (no RAM guarantee, identical durability semantics).`);
}
