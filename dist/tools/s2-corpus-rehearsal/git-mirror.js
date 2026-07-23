import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from "../../src/core/coordination/canonical-json.js";
import { assertNoSharedRegularFileIdentity, compareCodeUnits, digestBytes, inside, inventoryTree } from "./inventory.js";
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 120_000;
function gitEnvironment() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('GIT_') || /(?:SSH|CREDENTIAL|ASKPASS)/u.test(key))
            continue;
        env[key] = value;
    }
    env['GIT_OPTIONAL_LOCKS'] = '0';
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    return env;
}
async function runGit(cwd, args, accepted = [0]) {
    return await new Promise((resolveRun, rejectRun) => {
        const child = spawn('git', args, { cwd, env: gitEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let overflow = false;
        const capture = (target, chunk, current) => {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            const remaining = Math.max(0, MAX_DIAGNOSTIC_BYTES - current);
            if (bytes.byteLength > remaining)
                overflow = true;
            if (remaining > 0)
                target.push(bytes.subarray(0, remaining));
            return current + Math.min(bytes.byteLength, remaining);
        };
        child.stdout?.on('data', (chunk) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
        child.stderr?.on('data', (chunk) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectRun(new Error('S2-D Git command timed out'));
        }, GIT_TIMEOUT_MS);
        child.once('error', () => { clearTimeout(timer); rejectRun(new Error('S2-D Git command could not be spawned')); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            const out = Buffer.concat(stdout).toString('utf8');
            const err = Buffer.concat(stderr).toString('utf8');
            if (code === null || !accepted.includes(code) || signal !== null || overflow)
                rejectRun(new Error(`S2-D Git command failed: code=${String(code)} signal=${String(signal)} overflow=${String(overflow)} stderr_bytes=${String(Buffer.byteLength(err, 'utf8'))}`));
            else
                resolveRun({ stdout: out, stderr: err });
        });
    });
}
export async function gitRefs(cwd, gitDir) {
    const prefix = gitDir === undefined ? [] : ['--git-dir', gitDir];
    const output = await runGit(cwd, [...prefix, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)']);
    return Object.freeze(output.stdout.split('\n').filter((line) => line.length > 0).sort(compareCodeUnits));
}
async function deleteRemoteTrackingRefs(cwd) {
    const output = await runGit(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes'], [0]);
    for (const ref of output.stdout.split('\n').filter((line) => line.length > 0).sort(compareCodeUnits))
        await runGit(cwd, ['update-ref', '-d', ref], [0, 1]);
}
async function sanitizeGitConfig(gitCommonDir) {
    const extensionNames = (await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'config', '--local', '--name-only', '--get-regexp', '^extensions\\.'], [0, 1])).stdout.split('\n').filter((line) => line.length > 0);
    const allowed = new Set(['extensions.objectformat', 'extensions.refstorage']);
    const unsupported = extensionNames.filter((name) => !allowed.has(name.toLowerCase()));
    if (unsupported.length > 0)
        throw new Error(`S2-D Git mirror encountered unsupported extensions: ${unsupported.join(',')}`);
    const objectFormat = (await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'config', '--local', '--get', 'extensions.objectformat'], [0, 1])).stdout.trim();
    const refStorage = (await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'config', '--local', '--get', 'extensions.refstorage'], [0, 1])).stdout.trim();
    if (objectFormat !== '' && objectFormat !== 'sha256')
        throw new Error('S2-D Git mirror encountered unsupported object format');
    if (refStorage !== '' && refStorage !== 'reftable')
        throw new Error('S2-D Git mirror encountered unsupported ref storage');
    const config = [
        '[core]',
        `\trepositoryformatversion = ${objectFormat === '' && refStorage === '' ? '0' : '1'}`,
        '\tfilemode = true',
        '\tbare = false',
        '\tlogallrefupdates = false',
        ...(objectFormat !== '' || refStorage !== '' ? ['[extensions]', ...(objectFormat === 'sha256' ? ['\tobjectformat = sha256'] : []), ...(refStorage === 'reftable' ? ['\trefstorage = reftable'] : [])] : []),
        '',
    ].join('\n');
    await writeFile(join(gitCommonDir, 'config'), config, { encoding: 'utf8', mode: 0o600 });
    await rm(join(gitCommonDir, 'hooks'), { recursive: true, force: true });
    await mkdir(join(gitCommonDir, 'hooks'), { recursive: true, mode: 0o700 });
    await rm(join(gitCommonDir, 'logs'), { recursive: true, force: true });
    await rm(join(gitCommonDir, 'FETCH_HEAD'), { force: true });
}
function parseWorktreePorcelain(output) {
    const facts = [];
    let worktreePath = null;
    let headSha = null;
    let branchRef = null;
    let prunable = false;
    const flush = () => {
        if (worktreePath === null)
            return;
        if (headSha === null || !/^[a-f0-9]{40,64}$/u.test(headSha))
            throw new Error('S2-D Git worktree fact omits a head SHA');
        facts.push(Object.freeze({ worktree_path: worktreePath, head_sha: headSha, branch_ref: branchRef, prunable }));
        worktreePath = null;
        headSha = null;
        branchRef = null;
        prunable = false;
    };
    for (const line of output.split('\n')) {
        if (line.length === 0) {
            flush();
            continue;
        }
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? '' : line.slice(space + 1);
        if (key === 'worktree')
            worktreePath = resolve(value);
        else if (key === 'HEAD')
            headSha = value;
        else if (key === 'branch')
            branchRef = value;
        else if (key === 'prunable')
            prunable = true;
    }
    flush();
    return Object.freeze(facts.sort((left, right) => compareCodeUnits(left.worktree_path, right.worktree_path)));
}
export async function gitWorktreeFacts(gitCommonDir) {
    const output = await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(output.stdout);
}
export async function verifyGitMirror(gitCommonDir, cloneRoot) {
    const forbidden = [join(gitCommonDir, 'objects', 'info', 'alternates'), join(gitCommonDir, 'objects', 'info', 'grafts'), join(gitCommonDir, 'shallow'), join(gitCommonDir, 'config.worktree'), join(gitCommonDir, 'FETCH_HEAD'), join(gitCommonDir, 'logs')];
    if (forbidden.some(existsSync))
        throw new Error('S2-D Git mirror retained alternates, grafts, shallow, worktree config, FETCH_HEAD, or logs');
    const packRoot = join(gitCommonDir, 'objects', 'pack');
    if (existsSync(packRoot) && (await readdir(packRoot)).some((name) => name.endsWith('.promisor')))
        throw new Error('S2-D Git mirror retained promisor metadata');
    const config = readFileSync(join(gitCommonDir, 'config'), 'utf8');
    if (/\b(?:url|pushurl|insteadOf|include\.path|core\.hooksPath)\b/iu.test(config))
        throw new Error('S2-D Git mirror retained remote, include, or hook routing config');
    const remotes = await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'remote'], [0]);
    if (remotes.stdout.trim() !== '')
        throw new Error('S2-D Git mirror retained a remote');
    if ((await readdir(join(gitCommonDir, 'hooks'))).length !== 0)
        throw new Error('S2-D Git mirror retained hooks');
    await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'rev-list', '--objects', '--all', '--missing=print']);
    await runGit(gitCommonDir, ['--git-dir', gitCommonDir, 'fsck', '--full', '--strict']);
    const registrations = await gitWorktreeFacts(gitCommonDir);
    for (const fact of registrations)
        if (!inside(cloneRoot, fact.worktree_path))
            throw new Error('S2-D Git mirror worktree registration escapes clone root');
    return registrations;
}
export async function buildWritableGitMirror(input) {
    const sourceRepository = realpathSync(input.source_repository_root);
    const cloneRoot = resolve(input.clone_root);
    const copyRepository = resolve(input.copy_repository_root);
    const gitCommonDir = join(copyRepository, '.git');
    if (!inside(cloneRoot, copyRepository) || !inside(cloneRoot, gitCommonDir))
        throw new Error('S2-D Git mirror destination escapes clone root');
    if (existsSync(copyRepository) || existsSync(gitCommonDir))
        throw new Error('S2-D Git mirror destinations must be absent');
    const sourceRefs = await gitRefs(sourceRepository);
    await mkdir(dirname(copyRepository), { recursive: true, mode: 0o700 });
    try {
        await runGit(cloneRoot, ['clone', '--no-checkout', '--no-hardlinks', sourceRepository, copyRepository]);
        await runGit(copyRepository, ['remote', 'remove', 'origin'], [0, 2]);
        await deleteRemoteTrackingRefs(copyRepository);
        await runGit(copyRepository, ['fetch', '--update-head-ok', '--prune', '--no-tags', sourceRepository, '+refs/*:refs/*']);
        await deleteRemoteTrackingRefs(copyRepository);
        await sanitizeGitConfig(gitCommonDir);
        const copyRefs = await gitRefs(copyRepository);
        if (canonicalJson(sourceRefs) !== canonicalJson(copyRefs))
            throw new Error('S2-D Git mirror refs differ from source refs');
        const registrations = await verifyGitMirror(gitCommonDir, cloneRoot);
        const sourceCommon = (await runGit(sourceRepository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
        assertNoSharedRegularFileIdentity(await inventoryTree(realpathSync(sourceCommon)), await inventoryTree(gitCommonDir));
        return Object.freeze({ repository_root: copyRepository, git_common_dir: gitCommonDir, refs_sha256: digestBytes(canonicalJson(copyRefs)), registrations_sha256: digestBytes(canonicalJson(registrations)), registrations, });
    }
    catch (error) {
        await rm(copyRepository, { recursive: true, force: true });
        throw error;
    }
}
export function hashGitWitness(facts, refsValue) {
    return digestBytes(canonicalJson({ facts, refs: refsValue }));
}
export function assertPhysicalGitRepository(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('S2-D Git repository path is not a physical directory');
}
