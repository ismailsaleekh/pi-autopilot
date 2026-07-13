import { spawnSync } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { CoordinationRuntimeError } from "./coordination/failures.js";
const windowsRecursivelyHardenedRoots = new Set();
export function assertPrivatePathNoAliases(path) {
    const target = resolve(path);
    if (!existsSync(target))
        return;
    const info = lstatSync(target);
    if (info.isSymbolicLink())
        throw new CoordinationRuntimeError('system-fatal', 'Autopilot private authority refuses a symbolic-link or junction object', [target]);
}
function windowsAccount(env = process.env) {
    const account = env['USERDOMAIN'] !== undefined && env['USERNAME'] !== undefined
        ? `${env['USERDOMAIN']}\\${env['USERNAME']}`
        : env['USERNAME'];
    if (account === undefined || account.length === 0)
        throw new CoordinationRuntimeError('system-fatal', 'cannot determine the Windows account required to secure Autopilot authority');
    return account;
}
/** Builds the exact protected user-only DACL used for package-private authority. */
export function windowsPrivateAclCommand(path, directory, env = process.env) {
    const literalPath = path.replace(/'/gu, "''");
    const literalAccount = windowsAccount(env).replace(/'/gu, "''");
    const inheritance = directory ? '(A;OICI;FA;;;$sid)' : '(A;;FA;;;$sid)';
    const script = [
        `$path='${literalPath}'`,
        `$account='${literalAccount}'`,
        `$sid=(New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value`,
        `$sddl=\"O:$($sid)G:$($sid)D:P${inheritance}\"`,
        ...(directory ? [`if(-not [IO.Directory]::Exists($path)){$create=New-Object Security.AccessControl.DirectorySecurity;$create.SetSecurityDescriptorSddlForm($sddl);[void][IO.Directory]::CreateDirectory($path,$create)}`] : []),
        `$attributes=[IO.File]::GetAttributes($path)`,
        `if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Autopilot private authority refuses a reparse point'}`,
        `$isDirectory=($attributes -band [IO.FileAttributes]::Directory)-ne 0`,
        `$acl=if($isDirectory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}`,
        `$acl.SetSecurityDescriptorSddlForm($sddl)`,
        `if($isDirectory){[IO.Directory]::SetAccessControl($path,$acl)}else{[IO.File]::SetAccessControl($path,$acl)}`,
        `$check=if($isDirectory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}`,
        `$rules=@($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))`,
        `$expectedInheritance=if($isDirectory){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}`,
        `if(-not $check.AreAccessRulesProtected -or $check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $check.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].InheritanceFlags -ne $expectedInheritance -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'Autopilot private DACL verification failed'}`,
    ].join(';');
    return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
}
export function enforceWindowsPrivateAcl(path, directory, env = process.env) {
    const command = windowsPrivateAclCommand(path, directory, env);
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0)
        throw new CoordinationRuntimeError('system-fatal', 'failed to enforce an explicit user-private Windows ACL on Autopilot authority', [path, result.stderr.trim()]);
}
export function windowsPrivateTreeAclCommand(path, env = process.env) {
    const literalPath = path.replace(/'/gu, "''");
    const literalAccount = windowsAccount(env).replace(/'/gu, "''");
    const script = [
        `$root='${literalPath}'`, `$account='${literalAccount}'`,
        `$sid=(New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value`,
        `$stack=New-Object 'System.Collections.Generic.Stack[string]'`,
        `$stack.Push($root)`,
        `while($stack.Count -gt 0){$current=$stack.Pop();$attributes=[IO.File]::GetAttributes($current);if(($attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw \"reparse point in Autopilot authority: $current\"};$dir=($attributes -band [IO.FileAttributes]::Directory)-ne 0;$sddl=if($dir){\"O:$($sid)G:$($sid)D:P(A;OICI;FA;;;$sid)\"}else{\"O:$($sid)G:$($sid)D:P(A;;FA;;;$sid)\"};$acl=if($dir){[IO.Directory]::GetAccessControl($current)}else{[IO.File]::GetAccessControl($current)};$acl.SetSecurityDescriptorSddlForm($sddl);if($dir){[IO.Directory]::SetAccessControl($current,$acl)}else{[IO.File]::SetAccessControl($current,$acl)};$check=if($dir){[IO.Directory]::GetAccessControl($current)}else{[IO.File]::GetAccessControl($current)};$rules=@($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$expectedInheritance=if($dir){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None};if(-not $check.AreAccessRulesProtected -or $check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $check.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].InheritanceFlags -ne $expectedInheritance -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw \"Autopilot private DACL verification failed: $current\"};if($dir){foreach($child in [IO.Directory]::EnumerateFileSystemEntries($current)){$stack.Push($child)}}}`,
    ].join(';');
    return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
}
export function enforceWindowsPrivateTree(path, env = process.env) {
    const command = windowsPrivateTreeAclCommand(path, env);
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0)
        throw new CoordinationRuntimeError('system-fatal', 'failed to recursively enforce user-private Windows ACLs on Autopilot authority', [path, result.stderr.trim()]);
}
export async function enforcePrivateAuthorityPath(path, directory, env = process.env) {
    assertPrivatePathNoAliases(path);
    if (platform() === 'win32')
        enforceWindowsPrivateAcl(path, directory, env);
    else
        await chmod(path, directory ? 0o700 : 0o600);
    assertPrivatePathNoAliases(path);
}
export function ensurePrivateAuthorityDirectorySync(path, env = process.env) {
    assertPrivatePathNoAliases(path);
    if (platform() === 'win32') {
        enforceWindowsPrivateAcl(path, true, env);
        assertPrivatePathNoAliases(path);
        return;
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    assertPrivatePathNoAliases(path);
}
export async function ensurePrivateAuthorityDirectory(path, env = process.env) {
    assertPrivatePathNoAliases(path);
    if (platform() === 'win32') {
        // DirectorySecurity is supplied at creation: no permissively inherited directory is observable.
        enforceWindowsPrivateAcl(path, true, env);
        assertPrivatePathNoAliases(path);
        return;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    assertPrivatePathNoAliases(path);
}
/**
 * Hardens a state tree before the first marker/freeze read. On Windows this is
 * synchronous because all current marker readers are synchronous. Existing
 * override trees are recursively rewritten once; no child read or creation is
 * allowed in a permissive inherited-DACL window.
 */
export function hardenRuntimeAuthorityBeforeMarkerRead(stateRoot, repoKey, env = process.env) {
    if (platform() !== 'win32')
        return;
    const canonicalRoot = resolve(stateRoot);
    const roots = [
        canonicalRoot,
        join(canonicalRoot, 'coordination'),
        join(canonicalRoot, 'coordination', repoKey),
        join(canonicalRoot, 'worktrees'),
        join(canonicalRoot, 'worktrees', repoKey),
        join(canonicalRoot, 'cutovers'),
        join(canonicalRoot, 'migrations'),
    ];
    if (windowsRecursivelyHardenedRoots.has(canonicalRoot)) {
        assertPrivatePathNoAliases(canonicalRoot);
        for (const root of roots.slice(1)) {
            mkdirSync(root, { recursive: true });
            assertPrivatePathNoAliases(root);
        }
        return;
    }
    enforceWindowsPrivateAcl(canonicalRoot, true, env);
    enforceWindowsPrivateTree(canonicalRoot, env);
    for (const root of roots.slice(1)) {
        mkdirSync(root, { recursive: true });
        assertPrivatePathNoAliases(root);
    }
    enforceWindowsPrivateTree(canonicalRoot, env);
    windowsRecursivelyHardenedRoots.add(canonicalRoot);
}
export function isWindowsPrivateTreeHardened(path) {
    return platform() === 'win32' && windowsRecursivelyHardenedRoots.has(resolve(path));
}
export function markWindowsPrivateTreeHardened(path) {
    if (platform() === 'win32')
        windowsRecursivelyHardenedRoots.add(resolve(path));
}
