import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { CoordinationRuntimeError } from "./failures.js";
function sameIdentity(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
/**
 * Reads one immutable authority/evidence file through an O_NOFOLLOW descriptor.
 * The path and descriptor must identify the same bounded inode before and
 * after the complete read. Authority evidence defaults to one link; lock-saga
 * callers may explicitly admit a stable multi-link inode during link fencing.
 */
export function readImmutableFileBytes(input) {
    const code = input.errorCode ?? 'recovery-required';
    const minimum = input.minimumBytes ?? 1;
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || !Number.isSafeInteger(minimum) || minimum < 0 || minimum > input.maximumBytes)
        throw new CoordinationRuntimeError('invalid-request', 'immutable file byte bounds are invalid', [input.label]);
    let descriptor = null;
    try {
        const before = lstatSync(input.path);
        const validLinkCount = input.allowMultipleLinks === true ? before.nlink >= 1 : before.nlink === 1;
        const linkContract = input.allowMultipleLinks === true ? 'regular non-symbolic file' : 'single-link regular non-symbolic file';
        if (!before.isFile() || before.isSymbolicLink() || !validLinkCount || before.size < minimum || before.size > input.maximumBytes)
            throw new CoordinationRuntimeError(code, `${input.label} must be a bounded ${linkContract}`, [input.path, `size=${String(before.size)}`, `link_count=${String(before.nlink)}`]);
        descriptor = openSync(input.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        const validOpenedLinkCount = input.allowMultipleLinks === true ? opened.nlink >= 1 : opened.nlink === 1;
        if (!opened.isFile() || !validOpenedLinkCount || !sameIdentity(before, opened))
            throw new CoordinationRuntimeError(code, `${input.label} identity changed while opening`, [input.path]);
        const bytes = new Uint8Array(opened.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
            if (count === 0)
                break;
            offset += count;
        }
        const afterDescriptor = fstatSync(descriptor);
        const afterPath = lstatSync(input.path);
        const validAfterDescriptorLinks = input.allowMultipleLinks === true ? afterDescriptor.nlink >= 1 : afterDescriptor.nlink === 1;
        const validAfterPathLinks = input.allowMultipleLinks === true ? afterPath.nlink >= 1 : afterPath.nlink === 1;
        if (offset !== bytes.byteLength || !afterDescriptor.isFile() || !validAfterDescriptorLinks || !sameIdentity(opened, afterDescriptor) || !afterPath.isFile() || afterPath.isSymbolicLink() || !validAfterPathLinks || !sameIdentity(opened, afterPath))
            throw new CoordinationRuntimeError(code, `${input.label} identity changed during descriptor-pinned read`, [input.path]);
        return bytes;
    }
    catch (error) {
        if (error instanceof CoordinationRuntimeError)
            throw error;
        throw new CoordinationRuntimeError(code, `${input.label} could not be read through its immutable descriptor`, [input.path, error instanceof Error ? error.message : String(error)]);
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
    }
}
