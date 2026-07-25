import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAutopilotRosterContract } from "./contracts.js";
const PACKAGED_MANIFEST_RELATIVE_PATHS = Object.freeze([
    'artifacts/qualification/live/codex-gpt55-heavy/manifest.json',
]);
function packageRootFromModule(moduleUrl) {
    const moduleDir = dirname(fileURLToPath(moduleUrl));
    const candidates = [
        resolve(moduleDir, '..', '..', '..'),
        resolve(moduleDir, '..', '..', '..', '..'),
    ];
    for (const candidate of candidates) {
        if (existsSync(resolve(candidate, 'package.json')) && existsSync(resolve(candidate, 'artifacts'))) {
            return realpathSync(candidate);
        }
    }
    throw new Error('pi-autopilot package root could not be resolved for live certification manifests');
}
export function loadPackagedLiveCertificationManifests(moduleUrl = import.meta.url) {
    const packageRoot = packageRootFromModule(moduleUrl);
    return Object.freeze(PACKAGED_MANIFEST_RELATIVE_PATHS.map((relativePath) => {
        const absolutePath = resolve(packageRoot, relativePath);
        const realPath = realpathSync(absolutePath);
        if (!realPath.startsWith(`${packageRoot}/`))
            throw new Error(`live certification manifest escapes package root: ${relativePath}`);
        const value = JSON.parse(readFileSync(realPath, 'utf8'));
        return parseAutopilotRosterContract('autopilot.certification_manifest.v1', value);
    }));
}
