import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_PACKAGE_VERSION } from "./runtime-constants.js";
export const COORDINATOR_COMPILED_ENTRYPOINT_ENV = 'AUTOPILOT_COORDINATOR_COMPILED_ENTRYPOINT';
const PACKAGE_NAME = 'pi-autopilot';
const SOURCE_CLIENT_RELATIVE_PATH = join('src', 'core', 'coordination', 'client.ts');
const DIST_CLIENT_RELATIVE_PATH = join('dist', 'src', 'core', 'coordination', 'client.js');
const SOURCE_EXTENSION_RELATIVE_PATH = join('src', 'extension.ts');
const DIST_EXTENSION_RELATIVE_PATH = join('dist', 'src', 'extension.js');
const BOOTSTRAP_RELATIVE_PATH = join('dist', 'src', 'cli', 'autopilot-coordinator-bootstrap.js');
const COORDINATOR_RELATIVE_PATH = join('dist', 'src', 'cli', 'autopilot-coordinator.js');
const LAUNCH_SIGNER_RELATIVE_PATH = join('bin', 'autopilot-launch-signer.mjs');
const AGENT_RUNNER_RELATIVE_PATH = join('bin', 'autopilot-agent-run.mjs');
function isContained(root, target) {
    const child = relative(root, target);
    return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}
function assertClosedPackagePath(packageRoot, target, label) {
    const normalizedRoot = resolve(packageRoot);
    const normalizedTarget = resolve(target);
    if (!isContained(normalizedRoot, normalizedTarget)) {
        throw new CoordinationRuntimeError('coordinator-unavailable', `${label} escapes the verified package root`, [
            `package_root=${normalizedRoot}`,
            `selected_compiled_entrypoint=${normalizedTarget}`,
        ]);
    }
    const rootInfo = lstatSync(normalizedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator package root is not a physical directory', [`package_root=${normalizedRoot}`]);
    let cursor = normalizedRoot;
    for (const segment of relative(normalizedRoot, normalizedTarget).split(/[\\/]/u)) {
        cursor = join(cursor, segment);
        let info;
        try {
            info = lstatSync(cursor);
        }
        catch (error) {
            throw new CoordinationRuntimeError('coordinator-unavailable', `${label} is missing from the installed package`, [
                `package_root=${normalizedRoot}`,
                `selected_compiled_entrypoint=${normalizedTarget}`,
                `packaging_cause=${error instanceof Error ? error.message : String(error)}`,
            ]);
        }
        if (info.isSymbolicLink())
            throw new CoordinationRuntimeError('coordinator-unavailable', `${label} contains a symbolic link`, [`selected_compiled_entrypoint=${normalizedTarget}`, `symbolic_link=${cursor}`]);
    }
    const targetInfo = lstatSync(normalizedTarget);
    if (!targetInfo.isFile())
        throw new CoordinationRuntimeError('coordinator-unavailable', `${label} is not a regular file`, [`selected_compiled_entrypoint=${normalizedTarget}`]);
    const realRoot = realpathSync(normalizedRoot);
    const realTarget = realpathSync(normalizedTarget);
    const expectedRealTarget = join(realRoot, relative(normalizedRoot, normalizedTarget));
    if (realTarget !== expectedRealTarget || !isContained(realRoot, realTarget)) {
        throw new CoordinationRuntimeError('coordinator-unavailable', `${label} real path drifted outside its verified package identity`, [
            `package_root=${normalizedRoot}`,
            `selected_compiled_entrypoint=${normalizedTarget}`,
            `resolved_entrypoint=${realTarget}`,
        ]);
    }
}
function verifyPackageIdentity(packageRoot) {
    const manifestPath = join(packageRoot, 'package.json');
    assertClosedPackagePath(packageRoot, manifestPath, 'coordinator package manifest');
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    }
    catch (error) {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator package manifest is unreadable', [`package_root=${packageRoot}`, `packaging_cause=${error instanceof Error ? error.message : String(error)}`]);
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator package manifest has invalid package identity', [`package_root=${packageRoot}`]);
    const record = manifest;
    const expectedVersion = COORDINATOR_PACKAGE_VERSION;
    if (record['name'] !== PACKAGE_NAME || record['version'] !== expectedVersion) {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator package identity does not match the running client build', [
            `package_root=${packageRoot}`,
            `expected_package=${PACKAGE_NAME}@${expectedVersion}`,
            `observed_package=${String(record['name'])}@${String(record['version'])}`,
        ]);
    }
    return record;
}
/**
 * Resolve one module against a CLOSED pair of source/dist layouts. This is not
 * ancestor discovery: each candidate root is derived by removing exactly the
 * segments in one package-owned relative path, then the complete path is
 * compared byte-for-byte. Adding another build layout requires an explicit
 * code + test change rather than a filesystem-search fallback.
 */
function packageRootForKnownModule(input) {
    const modulePath = resolve(input.modulePath);
    for (const relativePath of [input.sourceRelativePath, input.distRelativePath]) {
        const segments = relativePath.split(/[\\/]/u);
        let candidateRoot = modulePath;
        for (const _segment of segments)
            candidateRoot = dirname(candidateRoot);
        if (modulePath === join(candidateRoot, relativePath))
            return candidateRoot;
    }
    throw new CoordinationRuntimeError('coordinator-unavailable', `${input.label} module location is outside the closed source/dist package layouts`, [`module=${modulePath}`]);
}
function localModulePath(moduleUrl, label) {
    try {
        return resolve(fileURLToPath(moduleUrl));
    }
    catch (error) {
        throw new CoordinationRuntimeError('coordinator-unavailable', `${label} module URL is not a local package file`, [`packaging_cause=${error instanceof Error ? error.message : String(error)}`]);
    }
}
export function resolveCoordinatorExecutable(clientModuleUrl) {
    const modulePath = localModulePath(clientModuleUrl, 'coordinator client');
    const packageRoot = packageRootForKnownModule({
        modulePath,
        sourceRelativePath: SOURCE_CLIENT_RELATIVE_PATH,
        distRelativePath: DIST_CLIENT_RELATIVE_PATH,
        label: 'coordinator client',
    });
    verifyPackageIdentity(packageRoot);
    assertClosedPackagePath(packageRoot, modulePath, 'coordinator client module');
    const bootstrapPath = join(packageRoot, BOOTSTRAP_RELATIVE_PATH);
    const coordinatorPath = join(packageRoot, COORDINATOR_RELATIVE_PATH);
    assertClosedPackagePath(packageRoot, bootstrapPath, 'compiled coordinator bootstrap');
    assertClosedPackagePath(packageRoot, coordinatorPath, 'compiled coordinator artifact');
    return Object.freeze({ packageRoot, bootstrapPath, coordinatorPath });
}
/**
 * Resolve every extension-spawned executable from the physical package that
 * loaded the extension. BUG-179 proved that composing `../bin` directly from
 * import.meta works for src/extension.ts but points at nonexistent dist/bin
 * from compiled dist/src/extension.js; the signer failed first and the child
 * runner carried the same latent peer. Both exact layouts and both executables
 * now share this one closed package-root derivation; no PATH, cwd, global
 * install, or ancestor fallback is permitted.
 */
export function resolveExtensionPackageExecutables(extensionModuleUrl) {
    const modulePath = localModulePath(extensionModuleUrl, 'Autopilot extension');
    const packageRoot = packageRootForKnownModule({
        modulePath,
        sourceRelativePath: SOURCE_EXTENSION_RELATIVE_PATH,
        distRelativePath: DIST_EXTENSION_RELATIVE_PATH,
        label: 'Autopilot extension',
    });
    const manifest = verifyPackageIdentity(packageRoot);
    assertClosedPackagePath(packageRoot, modulePath, 'Autopilot extension module');
    const bin = manifest['bin'];
    const binRecord = typeof bin === 'object' && bin !== null && !Array.isArray(bin) ? bin : null;
    if (binRecord?.['autopilot-launch-signer'] !== 'bin/autopilot-launch-signer.mjs' || binRecord['autopilot-agent-run'] !== 'bin/autopilot-agent-run.mjs') {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'extension executable manifest identity does not name the package-owned signer and runner bins', [`package_root=${packageRoot}`]);
    }
    const launchSignerPath = join(packageRoot, LAUNCH_SIGNER_RELATIVE_PATH);
    const agentRunnerPath = join(packageRoot, AGENT_RUNNER_RELATIVE_PATH);
    assertClosedPackagePath(packageRoot, launchSignerPath, 'launch signer executable');
    assertClosedPackagePath(packageRoot, agentRunnerPath, 'agent runner executable');
    // Return only canonical physical spellings. Consumers compare sealed paths
    // byte-for-byte and spawn these verified paths, never caller-provided aliases.
    return Object.freeze({
        packageRoot: realpathSync(packageRoot),
        launchSignerPath: realpathSync(launchSignerPath),
        agentRunnerPath: realpathSync(agentRunnerPath),
    });
}
