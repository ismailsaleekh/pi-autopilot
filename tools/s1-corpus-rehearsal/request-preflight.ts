import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { S1_ACTUAL_CF50_TARBALL_SHA256, type CorpusCloneRequest, type CorpusSourceRequest } from './contracts.ts';
import { closedGitWorktreeRegistrationFacts } from './closed-git-registration.ts';
import { compareCodeUnits, hashRegularFile } from './inventory.ts';

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function physicalDirectory(path: string, label: string): string {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical directory`);
  if (canonical !== resolve(path)) throw new Error(`${label} must use its canonical physical path`);
  return canonical;
}

function physicalFile(path: string, label: string): string {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a single-link physical regular file`);
  if (canonical !== resolve(path)) throw new Error(`${label} must use its canonical physical path`);
  return canonical;
}

function normalizedCorpus(corpus: CorpusSourceRequest): CorpusSourceRequest {
  const stateRoot = physicalDirectory(corpus.state_root, `C5 corpus ${corpus.corpus_id} state root`);
  const repositoryRoot = physicalDirectory(corpus.repository_root, `C5 corpus ${corpus.corpus_id} repository root`);
  const databasePath = physicalFile(corpus.database_path, `C5 corpus ${corpus.corpus_id} database`);
  if (!inside(stateRoot, databasePath)) throw new Error(`C5 corpus ${corpus.corpus_id} database escapes its coherent state root`);
  const expectedDatabase = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).databasePath;
  if (databasePath !== expectedDatabase) throw new Error(`C5 corpus ${corpus.corpus_id} database is not the exact coordinator database for its declared state root`);
  const retained = corpus.retained_snapshot_roots.map((path, index) => physicalDirectory(path, `C5 corpus ${corpus.corpus_id} retained root ${String(index)}`)).sort(compareCodeUnits);
  const measuredRoots = [stateRoot, repositoryRoot, ...retained];
  for (const registration of closedGitWorktreeRegistrationFacts(repositoryRoot)) {
    if (existsSync(registration.worktree_path) && !measuredRoots.some((root) => inside(root, registration.worktree_path))) throw new Error(`C5 corpus ${corpus.corpus_id} has a present Git worktree outside every measured source root`);
  }
  return Object.freeze({ ...corpus, state_root: stateRoot, repository_root: repositoryRoot, database_path: databasePath, retained_snapshot_roots: Object.freeze(retained) });
}

export async function preflightCorpusCloneRequest(request: CorpusCloneRequest): Promise<CorpusCloneRequest> {
  if (existsSync(request.destination_root)) throw new Error('C5 destination root must be new and absent');
  const destinationParent = physicalDirectory(dirname(request.destination_root), 'C5 destination parent');
  const destinationRoot = resolve(request.destination_root);
  if (dirname(destinationRoot) !== destinationParent) throw new Error('C5 destination root must have a canonical physical parent');
  const operatorHome = process.env['HOME'];
  if (operatorHome !== undefined && existsSync(operatorHome)) {
    const home = realpathSync(operatorHome);
    if (inside(home, destinationRoot) || inside(destinationRoot, home)) throw new Error('C5 destination root must remain outside operator home sandbox authority');
  }
  const resultPath = resolve(request.result_path);
  if (!inside(destinationRoot, resultPath) || resultPath === destinationRoot) throw new Error('C5 result path must be a file below the new destination root');
  const corpora = request.corpora.map(normalizedCorpus);
  const sourceRoots = corpora.flatMap((corpus) => [corpus.state_root, corpus.repository_root, ...corpus.retained_snapshot_roots]);
  for (const source of sourceRoots) {
    if (inside(source, destinationRoot) || inside(destinationRoot, source)) throw new Error('C5 destination is not disjoint from source authority');
  }
  const candidate = physicalFile(request.candidate_tarball_path, 'C5 candidate tarball');
  const cf50 = physicalFile(request.cf50_tarball_path, 'C5 actual cf50 tarball');
  if (await hashRegularFile(candidate) !== request.candidate_tarball_sha256) throw new Error('C5 candidate tarball digest mismatch');
  if (request.cf50_tarball_sha256 !== S1_ACTUAL_CF50_TARBALL_SHA256 || await hashRegularFile(cf50) !== S1_ACTUAL_CF50_TARBALL_SHA256) throw new Error('C5 actual cf50 tarball digest is not the frozen published fixture');
  return Object.freeze({ ...request, destination_root: destinationRoot, result_path: resultPath, candidate_tarball_path: candidate, cf50_tarball_path: cf50, corpora: Object.freeze(corpora) });
}
