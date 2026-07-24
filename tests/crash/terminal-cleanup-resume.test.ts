// Sharded from the close × boundary / abort × boundary matrix (Phase 40 / D70
// change C4). This shard covers the CLOSE recoveries plus the explicit missing
// S2-binding regression; the ABORT recoveries live in the sibling
// terminal-cleanup-resume-abort.test.ts. Test names and bodies are identical to
// the pre-split matrix; the shared harness holds the byte-identical runBoundary.

import { describe, it } from 'node:test';

import { AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES } from '../../src/core/close-runtime.ts';
import { runBoundary } from '../helpers/terminal-cleanup-harness.ts';

void describe('post-terminal close/abort process-death recovery', () => {
  void it('reconstructs missing S2 terminal retention binding after coordinator commit before cleanup recovery', async () => {
    await runBoundary('close', 'after-terminal-commit', { deleteS2BindingBeforeRecovery: true });
  });

  for (const boundary of AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES) {
    void it(`close resumes after real process death at ${boundary}`, async () => {
      await runBoundary('close', boundary);
    });
  }
});
