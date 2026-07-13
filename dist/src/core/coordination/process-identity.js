import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, platform, uptime } from 'node:os';
let cachedBootId = null;
export function currentBootId() {
    if (cachedBootId !== null)
        return cachedBootId;
    if (platform() === 'linux') {
        try {
            const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            if (value.length > 0) {
                cachedBootId = `linux:${value}`;
                return cachedBootId;
            }
        }
        catch {
            // Continue to the host boot-time fingerprint.
        }
    }
    if (platform() === 'darwin') {
        const result = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim().length > 0) {
            cachedBootId = `darwin:${createHash('sha256').update(result.stdout.trim(), 'utf8').digest('hex')}`;
            return cachedBootId;
        }
    }
    // Windows does not expose a boot UUID through Node. Quantizing the wall-clock
    // uptime estimate avoids adjacent processes disagreeing because their samples
    // straddle a millisecond/second boundary, while the PID liveness check remains
    // the second half of stale-lock identity proof.
    const bootTenSeconds = Math.round((Date.now() - uptime() * 1000) / 10_000) * 10;
    cachedBootId = `boot-estimate:${hostname()}:${String(bootTenSeconds)}`;
    return cachedBootId;
}
export function predecessorCompatibleBootEstimate(nowMs, uptimeSeconds, host) {
    const bootSeconds = Math.floor((nowMs - uptimeSeconds * 1000) / 1000);
    return `boot-estimate:${host}:${String(bootSeconds)}`;
}
export function predecessorCompatibleBootId() {
    if (platform() === 'linux') {
        try {
            const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            if (value.length > 0)
                return `linux:${value}`;
        }
        catch { /* continue */ }
    }
    if (platform() === 'darwin') {
        const result = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim().length > 0)
            return `darwin:${createHash('sha256').update(result.stdout.trim(), 'utf8').digest('hex')}`;
    }
    // Exact aa3e377 fallback representation. The current coordinator continuously
    // refreshes this compatibility fence, so wall-clock correction cannot leave a
    // 30-second stale window in which the old binary reaches shared authority.
    return predecessorCompatibleBootEstimate(Date.now(), uptime(), hostname());
}
export function isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}
/**
 * Returns the strongest OS process-creation identity exposed to this Node
 * runtime. It narrows PID-reuse ambiguity but is not an OS-bound process handle.
 * Callers fail closed when it is unavailable.
 */
export function processStartIdentity(pid) {
    if (!isProcessAlive(pid))
        return null;
    if (platform() === 'linux') {
        try {
            const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8').trim();
            const close = stat.lastIndexOf(')');
            if (close < 0)
                return null;
            const fields = stat.slice(close + 1).trim().split(/\s+/u);
            const startTicks = fields[19];
            if (startTicks !== undefined && /^\d+$/u.test(startTicks))
                return `linux-start-ticks:${startTicks}`;
        }
        catch {
            return null;
        }
    }
    if (platform() === 'darwin') {
        // proc_pidinfo(PROC_PIDTBSDINFO) returns the kernel's microsecond-resolution
        // birth timeval. Python is only a bridge to libproc; if it is unavailable or
        // the ABI call is incomplete we fail closed instead of falling back to ps(1)'s
        // ambiguous one-second lstart value.
        const script = [
            'import ctypes,sys',
            'class B(ctypes.Structure):',
            " _fields_=[('flags',ctypes.c_uint32),('status',ctypes.c_uint32),('xstatus',ctypes.c_uint32),('pid',ctypes.c_uint32),('ppid',ctypes.c_uint32),('uid',ctypes.c_uint32),('gid',ctypes.c_uint32),('ruid',ctypes.c_uint32),('rgid',ctypes.c_uint32),('svuid',ctypes.c_uint32),('svgid',ctypes.c_uint32),('rfu',ctypes.c_uint32),('comm',ctypes.c_char*16),('name',ctypes.c_char*32),('nfiles',ctypes.c_uint32),('pgid',ctypes.c_uint32),('pjobc',ctypes.c_uint32),('e_tdev',ctypes.c_uint32),('e_tpgid',ctypes.c_uint32),('nice',ctypes.c_uint32),('start_sec',ctypes.c_uint64),('start_usec',ctypes.c_uint64)]",
            "lib=ctypes.CDLL('/usr/lib/libproc.dylib')",
            'b=B()',
            'n=lib.proc_pidinfo(int(sys.argv[1]),3,0,ctypes.byref(b),ctypes.sizeof(b))',
            "print(f'{b.start_sec}:{b.start_usec:06d}' if n==ctypes.sizeof(b) and b.start_sec else '')",
        ].join('\n');
        const result = spawnSync('/usr/bin/python3', ['-c', script, String(pid)], { encoding: 'utf8', timeout: 5_000 });
        const value = result.status === 0 ? result.stdout.trim() : '';
        return /^\d+:[0-9]{6}$/u.test(value) ? `darwin-proc-birth:${value}` : null;
    }
    if (platform() === 'win32') {
        const command = `$p=Get-Process -Id ${String(pid)} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10_000 });
        const value = result.status === 0 ? result.stdout.trim() : '';
        return /^\d+$/u.test(value) ? `windows-start-ticks:${value}` : null;
    }
    return null;
}
export function preflightProcessRetirementSupport() {
    if (platform() !== 'darwin')
        return;
    // libproc is supplied through the dyld shared cache on current macOS and may
    // not have a stat-visible file. Loading it in processStartIdentity is the check.
    if (!existsSync('/usr/bin/python3'))
        throw new Error('macOS coordinator retirement requires /usr/bin/python3; dependency preflight failed closed');
    if (processStartIdentity(process.pid) === null)
        throw new Error('macOS libproc process-birth identity preflight failed; coordinator retirement is unavailable');
}
export function isExactProcessAlive(pid, expectedStartIdentity) {
    if (!isProcessAlive(pid))
        return false;
    const observed = processStartIdentity(pid);
    return observed !== null && observed === expectedStartIdentity;
}
/**
 * Historical API name retained for package compatibility. This is a fail-closed
 * identity-checked PID signal, not a mathematically atomic handle-bound kill:
 * Node exposes no portable pidfd/process-handle signal primitive. The residual
 * read-to-signal race is therefore treated as an explicit platform limitation.
 */
export function retireExactProcess(pid, expectedStartIdentity) {
    preflightProcessRetirementSupport();
    const first = processStartIdentity(pid);
    const second = processStartIdentity(pid);
    if (first === null || first !== expectedStartIdentity || second !== expectedStartIdentity)
        throw new Error(`refusing to retire/signal pid ${String(pid)} because its process-creation identity changed or became ambiguous`);
    process.kill(pid, 'SIGTERM');
}
