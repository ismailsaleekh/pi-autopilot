import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, platform, uptime } from 'node:os';

export function currentBootId(): string {
  if (platform() === 'linux') {
    try {
      const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (value.length > 0) return `linux:${value}`;
    } catch {
      // Continue to the host boot-time fingerprint.
    }
  }
  if (platform() === 'darwin') {
    const result = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return `darwin:${createHash('sha256').update(result.stdout.trim(), 'utf8').digest('hex')}`;
    }
  }
  const bootSeconds = Math.floor((Date.now() - uptime() * 1000) / 1000);
  return `boot-estimate:${hostname()}:${String(bootSeconds)}`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
