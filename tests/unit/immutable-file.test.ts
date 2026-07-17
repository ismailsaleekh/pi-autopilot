import assert from 'node:assert/strict';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { readImmutableFileBytes } from '../../src/core/coordination/immutable-file.ts';

void describe('descriptor-pinned immutable file reads', () => {
  void it('reads one exact bounded inode and rejects symlinks, hardlinks, and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-immutable-file-'));
    try {
      const path = join(root, 'evidence.json');
      const bytes = new TextEncoder().encode('{"evidence":true}\n');
      await writeFile(path, bytes);
      assert.deepEqual([...readImmutableFileBytes({ path, maximumBytes: 1024, label: 'test evidence' })], [...bytes]);

      const symbolic = join(root, 'symbolic.json');
      await symlink(path, symbolic);
      assert.throws(
        () => readImmutableFileBytes({ path: symbolic, maximumBytes: 1024, label: 'symbolic evidence' }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required' && /single-link regular non-symbolic/u.test(error.message),
      );

      const hardlink = join(root, 'hardlink.json');
      await link(path, hardlink);
      assert.throws(
        () => readImmutableFileBytes({ path, maximumBytes: 1024, label: 'hardlinked evidence' }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required' && /single-link regular non-symbolic/u.test(error.message),
      );
      assert.deepEqual(
        [...readImmutableFileBytes({ path: hardlink, maximumBytes: 1024, label: 'link-fenced lock', allowMultipleLinks: true })],
        [...bytes],
      );
      await rm(hardlink);

      await writeFile(path, new Uint8Array(0));
      assert.equal(readImmutableFileBytes({ path, maximumBytes: 1024, minimumBytes: 0, label: 'empty WAL component' }).byteLength, 0);

      const oversized = new Uint8Array(1025);
      oversized.fill(0x20);
      await writeFile(path, oversized);
      assert.throws(
        () => readImmutableFileBytes({ path, maximumBytes: 1024, label: 'oversized evidence' }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required' && /single-link regular non-symbolic/u.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
