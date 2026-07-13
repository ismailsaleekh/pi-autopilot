import { abortAutopilotWorkstream, closeAutopilotWorkstream, type AutopilotTerminalCleanupBoundary } from '../../src/core/close-runtime.ts';

const [action, sourceCwd, workstream, workstreamRun, boundary] = process.argv.slice(2);
if ((action !== 'close' && action !== 'abort') || sourceCwd === undefined || workstream === undefined || workstreamRun === undefined || boundary === undefined) {
  process.exitCode = 2;
} else {
  const run = action === 'close' ? closeAutopilotWorkstream : abortAutopilotWorkstream;
  await run({
    workstream,
    sourceCwd,
    workstreamRun,
    coordinationSessionId: `crash-worker-${action}-${boundary}`,
    observeTerminalCleanupBoundary: (reached: AutopilotTerminalCleanupBoundary) => {
      if (reached === boundary) process.exit(86);
    },
  });
  process.exitCode = 3;
}
