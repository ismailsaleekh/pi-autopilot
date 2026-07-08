import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const REMOTE_OR_EXTERNAL_GIT_SUBCOMMANDS = new Set([
    'clone',
    'fetch',
    'pull',
    'push',
    'ls-remote',
    'request-pull',
    'remote',
    'send-email',
    'sparse-checkout',
    'submodule',
    'svn',
    'worktree',
]);
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const GIT_DIR_ENV_KEYS = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);
export function evaluateAutopilotWorktreeToolCall(event, ctx, policy) {
    const root = canonicalExistingPath(policy.worktreeRoot);
    const allowedWriteRoots = canonicalAllowedWriteRoots(policy.allowedWriteRoots ?? [], root);
    if (event.toolName === 'bash') {
        const command = event.input?.['command'];
        if (typeof command !== 'string' || command.trim().length === 0) {
            return block(`${policy.label}: bash tool input.command must be a non-empty string.`);
        }
        const cwd = canonicalCandidatePath(ctx.cwd ?? root, root);
        const reason = evaluateShellCommandForGit(command, cwd, root, policy.label, 0);
        return reason === null ? undefined : block(reason);
    }
    if (event.toolName === 'write' || event.toolName === 'edit') {
        const rawPath = event.input?.['path'] ?? event.input?.['file_path'];
        if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
            return block(`${policy.label}: ${event.toolName} tool path must be a non-empty string.`);
        }
        const cwd = canonicalCandidatePath(ctx.cwd ?? root, root);
        const absolutePath = canonicalCandidatePath(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath), root);
        if (!isPathInsideRoot(absolutePath, root) && !allowedWriteRoots.some((allowedRoot) => isPathInsideRoot(absolutePath, allowedRoot))) {
            return block(`${policy.label}: ${event.toolName} target ${absolutePath} is outside the registered Autopilot worktree ${root} and allowed Autopilot artifact roots.`);
        }
    }
    return undefined;
}
function evaluateShellCommandForGit(command, initialCwd, root, label, depth) {
    if (depth > 8)
        return `${label}: nested shell command depth exceeded while checking git worktree scope.`;
    const substitutionReason = evaluateCommandSubstitutions(command, initialCwd, root, label, depth);
    if (substitutionReason !== null)
        return substitutionReason;
    let currentCwd = initialCwd;
    for (const segment of splitShellSegments(command)) {
        const evaluation = evaluateShellSegment(segment.text, currentCwd, root, label, depth);
        if (evaluation.blockReason !== null)
            return evaluation.blockReason;
        if (evaluation.nextCwd !== undefined) {
            if (segment.nextSeparator === ';' || segment.nextSeparator === '&&')
                currentCwd = evaluation.nextCwd;
        }
        if (segment.nextSeparator === '|' || segment.nextSeparator === '||') {
            // Pipelines and fallback branches do not reliably carry cd state into the next command.
        }
    }
    return null;
}
function evaluateShellSegment(segment, cwd, root, label, depth) {
    const tokens = tokenizeShellSegment(segment);
    if (tokens.length === 0)
        return { blockReason: null, nextCwd: undefined };
    if (containsUnquotedGrouping(segment) && tokens.includes('git')) {
        return {
            blockReason: `${label}: grouped shell git command is ambiguous; run git directly from the registered Autopilot worktree.`,
            nextCwd: undefined,
        };
    }
    const wrapped = evaluateShellWrapper(tokens, cwd, root, label, depth);
    if (wrapped !== null)
        return { blockReason: wrapped, nextCwd: undefined };
    const nextCwd = cdTargetFromTokens(tokens, cwd);
    const gitIndexes = gitTokenIndexes(tokens);
    if (gitIndexes.length > 0) {
        const envReason = gitEnvironmentAssignmentReason(tokens, label);
        if (envReason !== null)
            return { blockReason: envReason, nextCwd };
    }
    for (const index of gitIndexes) {
        const reason = evaluateGitInvocation(tokens, index, cwd, root, label);
        if (reason !== null)
            return { blockReason: reason, nextCwd };
    }
    return { blockReason: null, nextCwd };
}
function evaluateGitInvocation(tokens, gitIndex, cwd, root, label) {
    if (cwd === null) {
        return `${label}: git invocation has unknown cwd; run git from the registered Autopilot worktree ${root}.`;
    }
    let effectiveCwd = cwd;
    let subcommand = null;
    let subcommandIndex = null;
    for (let index = gitIndex + 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined)
            continue;
        if (isEnvironmentAssignment(token) && subcommand === null) {
            const key = token.slice(0, token.indexOf('='));
            if (isGitScopeEnvironmentKey(key)) {
                return `${label}: explicit ${key} is not allowed; use the registered Autopilot worktree cwd instead.`;
            }
            continue;
        }
        if (token === '-C') {
            const raw = tokens[index + 1];
            if (raw === undefined || raw.length === 0)
                return `${label}: git -C requires a path.`;
            effectiveCwd = canonicalCandidatePath(resolve(effectiveCwd, raw), root);
            index += 1;
            continue;
        }
        if (token.startsWith('-C') && token.length > 2) {
            effectiveCwd = canonicalCandidatePath(resolve(effectiveCwd, token.slice(2)), root);
            continue;
        }
        if (token === '--git-dir' || token.startsWith('--git-dir=')) {
            return `${label}: explicit --git-dir is not allowed; it can redirect git outside the registered Autopilot worktree.`;
        }
        if (token === '--separate-git-dir' || token.startsWith('--separate-git-dir=')) {
            return `${label}: explicit --separate-git-dir is not allowed; it redirects repository state outside the registered Autopilot worktree.`;
        }
        if (token === '--work-tree' || token.startsWith('--work-tree=')) {
            return `${label}: explicit --work-tree is not allowed; use cwd or git -C inside the registered Autopilot worktree.`;
        }
        if (token === '--bare') {
            return `${label}: bare git operations are outside Autopilot worktree scope.`;
        }
        if (token === '-c') {
            const configPair = tokens[index + 1];
            if (configPair !== undefined && isGitScopeConfigPair(configPair)) {
                return `${label}: git -c ${configPair} is not allowed because it can remap repository scope.`;
            }
            index += 1;
            continue;
        }
        if (token === '--config-env') {
            const configPair = tokens[index + 1];
            if (configPair !== undefined && isGitScopeConfigPair(configPair)) {
                return `${label}: git --config-env ${configPair} is not allowed because it can remap repository scope.`;
            }
            index += 1;
            continue;
        }
        if (token.startsWith('--config-env=')) {
            const configPair = token.slice('--config-env='.length);
            if (isGitScopeConfigPair(configPair)) {
                return `${label}: git ${token} is not allowed because it can remap repository scope.`;
            }
            continue;
        }
        if (token === '--namespace') {
            index += 1;
            continue;
        }
        if (token.startsWith('-'))
            continue;
        subcommand = token;
        subcommandIndex = index;
        break;
    }
    if (!isPathInsideRoot(effectiveCwd, root)) {
        return `${label}: git command resolves to ${effectiveCwd}, outside the registered Autopilot worktree ${root}.`;
    }
    if (subcommand !== null && REMOTE_OR_EXTERNAL_GIT_SUBCOMMANDS.has(subcommand)) {
        return `${label}: git ${subcommand} is not local to the Autopilot worktree; use package runtime or operator-approved release flow instead.`;
    }
    const subcommandArgs = subcommandIndex === null ? [] : tokens.slice(subcommandIndex + 1);
    if (subcommand === 'branch' && branchMutationRequested(subcommandArgs)) {
        return `${label}: git branch mutation is not scoped to the active worktree; leave branch lifecycle to the Autopilot runtime.`;
    }
    if (subcommand === 'tag' && tagMutationRequested(subcommandArgs)) {
        return `${label}: git tag mutation is not scoped to the active worktree; leave shared refs to the operator or release flow.`;
    }
    return null;
}
function gitEnvironmentAssignmentReason(tokens, label) {
    for (const token of tokens) {
        if (!isEnvironmentAssignment(token))
            continue;
        const key = token.slice(0, token.indexOf('='));
        if (isGitScopeEnvironmentKey(key)) {
            return `${label}: explicit ${key} is not allowed; use the registered Autopilot worktree cwd instead.`;
        }
    }
    return null;
}
function isGitScopeEnvironmentKey(key) {
    return GIT_DIR_ENV_KEYS.has(key) ||
        key === 'GIT_CONFIG_PARAMETERS' ||
        key === 'GIT_CONFIG_COUNT' ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key);
}
function isGitScopeConfigPair(configPair) {
    return /^core\.(?:worktree|bare)=/iu.test(configPair);
}
function branchMutationRequested(tokens) {
    if (tokens.some((token) => token === '-d' ||
        token === '-D' ||
        token === '--delete' ||
        token === '-m' ||
        token === '-M' ||
        token === '--move' ||
        token === '-c' ||
        token === '-C' ||
        token === '--copy' ||
        token === '--set-upstream-to' ||
        token === '--unset-upstream' ||
        token === '-u' ||
        token === '--edit-description' ||
        token === '--track' ||
        token === '--no-track' ||
        token === '--create-reflog'))
        return true;
    return containsBranchOrTagNameArgument(tokens, new Set([
        '--list',
        '--show-current',
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
    ]));
}
function tagMutationRequested(tokens) {
    if (tokens.some((token) => token === '-d' ||
        token === '--delete' ||
        token === '-f' ||
        token === '--force' ||
        token === '-a' ||
        token === '-s' ||
        token === '-u' ||
        token === '-m' ||
        token === '-F'))
        return true;
    return containsBranchOrTagNameArgument(tokens, new Set([
        '-l',
        '--list',
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '-v',
        '--verify',
    ]));
}
function containsBranchOrTagNameArgument(tokens, readOnlyModes) {
    if (tokens.length === 0)
        return false;
    const hasReadOnlyMode = tokens.some((token) => readOnlyModes.has(token) || [...readOnlyModes].some((mode) => token.startsWith(`${mode}=`)));
    return !hasReadOnlyMode && tokens.some((token) => !token.startsWith('-'));
}
function evaluateShellWrapper(tokens, cwd, root, label, depth) {
    const commandIndex = firstCommandIndex(tokens);
    if (commandIndex === null)
        return null;
    const command = tokens[commandIndex];
    if (command === undefined || !SHELL_WRAPPERS.has(command))
        return null;
    const scriptIndex = shellScriptArgumentIndex(tokens, commandIndex + 1);
    if (scriptIndex === null)
        return null;
    const script = tokens[scriptIndex];
    if (script === undefined)
        return null;
    return evaluateShellCommandForGit(script, cwd ?? root, root, label, depth + 1);
}
function shellScriptArgumentIndex(tokens, start) {
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined)
            continue;
        if (token === '-c' || token === '-lc' || token === '-cl')
            return index + 1 < tokens.length ? index + 1 : null;
        if (token.startsWith('-') && token.includes('c'))
            return index + 1 < tokens.length ? index + 1 : null;
    }
    return null;
}
function cdTargetFromTokens(tokens, cwd) {
    const commandIndex = firstCommandIndex(tokens);
    if (commandIndex === null)
        return undefined;
    if (tokens[commandIndex] !== 'cd')
        return undefined;
    if (cwd === null)
        return null;
    const raw = tokens[commandIndex + 1] ?? process.env['HOME'] ?? '';
    if (raw === '-' || raw.length === 0)
        return null;
    const next = canonicalCandidatePath(resolve(cwd, raw), cwd);
    return existsSync(next) ? next : cwd;
}
function firstCommandIndex(tokens) {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined)
            continue;
        if (isEnvironmentAssignment(token))
            continue;
        if (token === 'command' || token === 'builtin' || token === 'time')
            continue;
        if (token === 'env')
            continue;
        return index;
    }
    return null;
}
function gitTokenIndexes(tokens) {
    const indexes = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] === 'git')
            indexes.push(index);
    }
    return Object.freeze(indexes);
}
function evaluateCommandSubstitutions(command, cwd, root, label, depth) {
    for (const inner of extractDollarParenCommands(command)) {
        const reason = evaluateShellCommandForGit(inner, cwd, root, label, depth + 1);
        if (reason !== null)
            return reason;
    }
    for (const inner of extractBacktickCommands(command)) {
        const reason = evaluateShellCommandForGit(inner, cwd, root, label, depth + 1);
        if (reason !== null)
            return reason;
    }
    return null;
}
function splitShellSegments(command) {
    const segments = [];
    let buffer = '';
    let quote = null;
    for (let index = 0; index < command.length; index += 1) {
        const char = command.charAt(index);
        const next = command.charAt(index + 1);
        if (quote !== null) {
            buffer += char;
            if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"'))
                quote = null;
            continue;
        }
        if (char === "'") {
            quote = 'single';
            buffer += char;
            continue;
        }
        if (char === '"') {
            quote = 'double';
            buffer += char;
            continue;
        }
        if (char === '&' && next === '&') {
            pushSegment(segments, buffer, '&&');
            buffer = '';
            index += 1;
            continue;
        }
        if (char === '|' && next === '|') {
            pushSegment(segments, buffer, '||');
            buffer = '';
            index += 1;
            continue;
        }
        if (char === ';' || char === '|' || char === '\n') {
            pushSegment(segments, buffer, char === '|' ? '|' : ';');
            buffer = '';
            continue;
        }
        buffer += char;
    }
    pushSegment(segments, buffer, null);
    return Object.freeze(segments);
}
function pushSegment(segments, raw, nextSeparator) {
    const text = raw.trim();
    if (text.length > 0)
        segments.push({ text, nextSeparator });
}
function tokenizeShellSegment(segment) {
    const tokens = [];
    let buffer = '';
    let quote = null;
    for (let index = 0; index < segment.length; index += 1) {
        const char = segment.charAt(index);
        if (quote !== null) {
            if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) {
                quote = null;
                continue;
            }
            buffer += char;
            continue;
        }
        if (char === "'") {
            quote = 'single';
            continue;
        }
        if (char === '"') {
            quote = 'double';
            continue;
        }
        if (/\s/u.test(char)) {
            if (buffer.length > 0) {
                tokens.push(buffer);
                buffer = '';
            }
            continue;
        }
        buffer += char;
    }
    if (buffer.length > 0)
        tokens.push(buffer);
    return Object.freeze(tokens);
}
function extractDollarParenCommands(command) {
    const out = [];
    let index = 0;
    while (index < command.length) {
        const start = command.indexOf('$(', index);
        if (start < 0)
            break;
        let depth = 1;
        let cursor = start + 2;
        let quote = null;
        while (cursor < command.length && depth > 0) {
            const char = command.charAt(cursor);
            if (quote !== null) {
                if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"'))
                    quote = null;
                cursor += 1;
                continue;
            }
            if (char === "'")
                quote = 'single';
            else if (char === '"')
                quote = 'double';
            else if (char === '(')
                depth += 1;
            else if (char === ')')
                depth -= 1;
            cursor += 1;
        }
        if (depth === 0)
            out.push(command.slice(start + 2, cursor - 1));
        index = cursor;
    }
    return Object.freeze(out);
}
function extractBacktickCommands(command) {
    const out = [];
    let cursor = 0;
    while (cursor < command.length) {
        const start = command.indexOf('`', cursor);
        if (start < 0)
            break;
        const end = command.indexOf('`', start + 1);
        if (end < 0)
            break;
        out.push(command.slice(start + 1, end));
        cursor = end + 1;
    }
    return Object.freeze(out);
}
function containsUnquotedGrouping(segment) {
    let quote = null;
    for (let index = 0; index < segment.length; index += 1) {
        const char = segment.charAt(index);
        if (quote !== null) {
            if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"'))
                quote = null;
            continue;
        }
        if (char === "'")
            quote = 'single';
        else if (char === '"')
            quote = 'double';
        else if (char === '(' || char === ')')
            return true;
    }
    return false;
}
function isEnvironmentAssignment(token) {
    const equals = token.indexOf('=');
    if (equals <= 0)
        return false;
    const key = token.slice(0, equals);
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key);
}
function canonicalExistingPath(path) {
    return resolve(realpathSync(path));
}
function canonicalAllowedWriteRoots(paths, fallbackRoot) {
    return Object.freeze(paths.map((path) => canonicalCandidatePath(path, fallbackRoot)));
}
function canonicalCandidatePath(path, fallbackRoot) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(fallbackRoot, path);
    if (existsSync(absolute))
        return resolve(realpathSync(absolute));
    let existingParent = absolute;
    while (!existsSync(existingParent)) {
        const parent = dirname(existingParent);
        if (parent === existingParent)
            return absolute;
        existingParent = parent;
    }
    const suffix = relative(existingParent, absolute);
    const realParent = resolve(realpathSync(existingParent));
    return suffix.length === 0 ? realParent : resolve(realParent, suffix);
}
function isPathInsideRoot(path, root) {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel !== sep);
}
function block(reason) {
    return { block: true, reason };
}
