import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_PACKAGE_BUILD } from "./runtime-constants.js";
export const COORDINATOR_COMPILED_ENTRYPOINT_ENV = 'AUTOPILOT_COORDINATOR_COMPILED_ENTRYPOINT';
const PACKAGE_NAME = 'pi-autopilot';
const SOURCE_CLIENT_RELATIVE_PATH = join('src', 'core', 'coordination', 'client.ts');
const DIST_CLIENT_RELATIVE_PATH = join('dist', 'src', 'core', 'coordination', 'client.js');
const BOOTSTRAP_RELATIVE_PATH = join('dist', 'src', 'cli', 'autopilot-coordinator-bootstrap.js');
const COORDINATOR_RELATIVE_PATH = join('dist', 'src', 'cli', 'autopilot-coordinator.js');
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
function expectedPackageVersion() {
    const suffix = COORDINATOR_PACKAGE_BUILD.lastIndexOf('-cf');
    if (suffix < 1)
        throw new CoordinationRuntimeError('system-fatal', 'coordinator package build does not encode a package version');
    return COORDINATOR_PACKAGE_BUILD.slice(0, suffix);
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
    const expectedVersion = expectedPackageVersion();
    if (record['name'] !== PACKAGE_NAME || record['version'] !== expectedVersion) {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator package identity does not match the running client build', [
            `package_root=${packageRoot}`,
            `expected_package=${PACKAGE_NAME}@${expectedVersion}`,
            `observed_package=${String(record['name'])}@${String(record['version'])}`,
        ]);
    }
}
function packageRootForClientModule(modulePath) {
    const sourceRoot = resolve(dirname(modulePath), '..', '..', '..');
    if (modulePath === join(sourceRoot, SOURCE_CLIENT_RELATIVE_PATH))
        return sourceRoot;
    const distRoot = resolve(dirname(modulePath), '..', '..', '..', '..');
    if (modulePath === join(distRoot, DIST_CLIENT_RELATIVE_PATH))
        return distRoot;
    throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator client module location is outside the closed source/dist package layouts', [`client_module=${modulePath}`]);
}
export function resolveCoordinatorExecutable(clientModuleUrl) {
    let modulePath;
    try {
        modulePath = fileURLToPath(clientModuleUrl);
    }
    catch (error) {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator client module URL is not a local package file', [`packaging_cause=${error instanceof Error ? error.message : String(error)}`]);
    }
    const packageRoot = packageRootForClientModule(resolve(modulePath));
    verifyPackageIdentity(packageRoot);
    assertClosedPackagePath(packageRoot, modulePath, 'coordinator client module');
    const bootstrapPath = join(packageRoot, BOOTSTRAP_RELATIVE_PATH);
    const coordinatorPath = join(packageRoot, COORDINATOR_RELATIVE_PATH);
    assertClosedPackagePath(packageRoot, bootstrapPath, 'compiled coordinator bootstrap');
    assertClosedPackagePath(packageRoot, coordinatorPath, 'compiled coordinator artifact');
    return Object.freeze({ packageRoot, bootstrapPath, coordinatorPath });
}
