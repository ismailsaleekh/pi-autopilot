import { spawnSync } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

import { CoordinationRuntimeError } from './coordination/failures.ts';

/** Kept local to this leaf module so authority hardening never imports runtime policy. */
export interface PrivatePathEnv {
  readonly [key: string]: string | undefined;
}

export interface WindowsPrivateAclCommand {
  readonly executable: 'powershell.exe';
  readonly args: readonly string[];
}

const windowsRecursivelyHardenedRoots = new Set<string>();

export function assertPrivatePathNoAliases(path: string): void {
  const target = resolve(path);
  if (!existsSync(target)) return;
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new CoordinationRuntimeError('system-fatal', 'Autopilot private authority refuses a symbolic-link or junction object', [target]);
}

function windowsAccount(env: PrivatePathEnv = process.env): string {
  const account = env['USERDOMAIN'] !== undefined && env['USERNAME'] !== undefined
    ? `${env['USERDOMAIN']}\\${env['USERNAME']}`
    : env['USERNAME'];
  if (account === undefined || account.length === 0) throw new CoordinationRuntimeError('system-fatal', 'cannot determine the Windows account required to secure Autopilot authority');
  return account;
}

/** Builds the exact protected user-only DACL used for package-private authority. */
export function windowsPrivateAclCommand(path: string, directory: boolean, env: PrivatePathEnv = process.env): WindowsPrivateAclCommand {
  const literalPath = path.replace(/'/gu, "''");
  const literalAccount = windowsAccount(env).replace(/'/gu, "''");
  const inheritance = directory ? '(A;OICI;FA;;;$sid)' : '(A;;FA;;;$sid)';
  const script = [
    `$path='${literalPath}'`,
    `$account='${literalAccount}'`,
    `$sid=(New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value`,
    `$sddl=\"O:$($sid)G:$($sid)D:P${inheritance}\"`,
    ...(directory ? [`if(-not [IO.Directory]::Exists($path)){$create=New-Object Security.AccessControl.DirectorySecurity;$create.SetSecurityDescriptorSddlForm($sddl);[void][IO.Directory]::CreateDirectory($path,$create)}`] : []),
    `$item=Get-Item -LiteralPath $path -Force`,
    `if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Autopilot private authority refuses a reparse point'}`,
    `$acl=Get-Acl -LiteralPath $path`,
    `$acl.SetSecurityDescriptorSddlForm($sddl)`,
    `Set-Acl -LiteralPath $path -AclObject $acl`,
    `$check=Get-Acl -LiteralPath $path`,
    `if(-not $check.AreAccessRulesProtected -or @($check.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid }).Count -ne 0){throw 'Autopilot private DACL verification failed'}`,
  ].join(';');
  return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
}

export function enforceWindowsPrivateAcl(path: string, directory: boolean, env: PrivatePathEnv = process.env): void {
  const command = windowsPrivateAclCommand(path, directory, env);
  const result = spawnSync(command.executable, command.args, { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new CoordinationRuntimeError('system-fatal', 'failed to enforce an explicit user-private Windows ACL on Autopilot authority', [path, result.stderr.trim()]);
}

export function windowsPrivateTreeAclCommand(path: string, env: PrivatePathEnv = process.env): WindowsPrivateAclCommand {
  const literalPath = path.replace(/'/gu, "''");
  const literalAccount = windowsAccount(env).replace(/'/gu, "''");
  const script = [
    `$root='${literalPath}'`, `$account='${literalAccount}'`,
    `$sid=(New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value`,
    `$stack=New-Object 'System.Collections.Generic.Stack[System.IO.FileSystemInfo]'`,
    `$stack.Push((Get-Item -LiteralPath $root -Force))`,
    `while($stack.Count -gt 0){$item=$stack.Pop();if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw \"reparse point in Autopilot authority: $($item.FullName)\"};$dir=$item.PSIsContainer;$sddl=if($dir){\"O:$($sid)G:$($sid)D:P(A;OICI;FA;;;$sid)\"}else{\"O:$($sid)G:$($sid)D:P(A;;FA;;;$sid)\"};$acl=Get-Acl -LiteralPath $item.FullName;$acl.SetSecurityDescriptorSddlForm($sddl);Set-Acl -LiteralPath $item.FullName -AclObject $acl;if($dir){foreach($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)){$stack.Push($child)}}}`,
  ].join(';');
  return { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
}

export function enforceWindowsPrivateTree(path: string, env: PrivatePathEnv = process.env): void {
  const command = windowsPrivateTreeAclCommand(path, env);
  const result = spawnSync(command.executable, command.args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new CoordinationRuntimeError('system-fatal', 'failed to recursively enforce user-private Windows ACLs on Autopilot authority', [path, result.stderr.trim()]);
}

export async function enforcePrivateAuthorityPath(path: string, directory: boolean, env: PrivatePathEnv = process.env): Promise<void> {
  assertPrivatePathNoAliases(path);
  if (platform() === 'win32') enforceWindowsPrivateAcl(path, directory, env);
  else await chmod(path, directory ? 0o700 : 0o600);
  assertPrivatePathNoAliases(path);
}

export function ensurePrivateAuthorityDirectorySync(path: string, env: PrivatePathEnv = process.env): void {
  assertPrivatePathNoAliases(path);
  if (platform() === 'win32') { enforceWindowsPrivateAcl(path, true, env); assertPrivatePathNoAliases(path); return; }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  assertPrivatePathNoAliases(path);
}

export async function ensurePrivateAuthorityDirectory(path: string, env: PrivatePathEnv = process.env): Promise<void> {
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
export function hardenRuntimeAuthorityBeforeMarkerRead(stateRoot: string, repoKey: string, env: PrivatePathEnv = process.env): void {
  if (platform() !== 'win32') return;
  const roots = [
    stateRoot,
    join(stateRoot, 'coordination'),
    join(stateRoot, 'coordination', repoKey),
    join(stateRoot, 'worktrees'),
    join(stateRoot, 'worktrees', repoKey),
    join(stateRoot, 'cutovers'),
    join(stateRoot, 'migrations'),
  ];
  for (const root of roots) enforceWindowsPrivateAcl(root, true, env);
  if (!windowsRecursivelyHardenedRoots.has(stateRoot)) {
    enforceWindowsPrivateTree(stateRoot, env);
    windowsRecursivelyHardenedRoots.add(stateRoot);
  }
}

export function markWindowsPrivateTreeHardened(path: string): void {
  if (platform() === 'win32') windowsRecursivelyHardenedRoots.add(path);
}
