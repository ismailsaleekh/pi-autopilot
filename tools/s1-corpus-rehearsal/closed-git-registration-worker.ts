import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';

const READ_ONLY_GIT_ENV = Object.freeze({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

async function main(): Promise<void> {
  const repositoryRoot = process.argv[2];
  if (repositoryRoot === undefined || process.argv[3] !== undefined) throw new Error('usage: closed-git-registration-worker.ts <repository-root>');
  const registrations = gitWorktreeRegistrationFacts(repositoryRoot, READ_ONLY_GIT_ENV);
  process.stdout.write(`${canonicalJson(registrations)}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`C5 closed Git registration worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
