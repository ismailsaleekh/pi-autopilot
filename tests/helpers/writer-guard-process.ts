import { CoordinatorWriterGuard } from '../../src/core/coordination/writer-guard.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';

const timeoutValue = process.argv[2];
const timeoutMs = timeoutValue === undefined ? 500 : Number(timeoutValue);
const mode = process.argv[3] ?? 'hold';
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('writer guard helper timeout is invalid');
if (mode !== 'hold' && mode !== 'once') throw new Error('writer guard helper mode is invalid');

try {
  const guard = await CoordinatorWriterGuard.acquire(coordinatorRuntimePaths(), timeoutMs);
  console.log(JSON.stringify({ state: 'acquired', pid: process.pid }));
  if (mode === 'once') {
    guard.release();
    process.exitCode = 0;
  } else {
  const hold = setInterval(() => guard.assertHeld(), 250);
  const release = (): void => {
    clearInterval(hold);
    guard.release();
    process.exitCode = 0;
  };
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  process.once('SIGHUP', release);
  }
} catch (error) {
  console.log(JSON.stringify({ state: 'failed', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 70;
}
