import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  AUTOPILOT_STATUS_TOOL,
} from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

interface RpcCommandResponse {
  readonly id?: string;
  readonly type: 'response';
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface RpcNotifyRequest {
  readonly type: 'extension_ui_request';
  readonly method: 'notify';
  readonly message: string;
  readonly notifyType?: 'info' | 'warning' | 'error';
}

interface RpcCommandInfo {
  readonly name: string;
  readonly description?: string;
}

interface RpcRunResult {
  readonly events: readonly unknown[];
  readonly stdout: string;
}

const packageRoot = new URL('../../', import.meta.url).pathname;
const extensionPath = join(packageRoot, 'extensions/autopilot.ts');
const forbiddenLegacyCommand = ['hlo', 'v2'].join('-');

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: JsonMap, key: string): unknown {
  return value[key];
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseJson(line));
}

function isRpcCommandResponse(value: unknown): value is RpcCommandResponse {
  if (!isJsonMap(value)) return false;
  return field(value, 'type') === 'response' && typeof field(value, 'command') === 'string';
}

function isRpcNotifyRequest(value: unknown): value is RpcNotifyRequest {
  if (!isJsonMap(value)) return false;
  return (
    field(value, 'type') === 'extension_ui_request' &&
    field(value, 'method') === 'notify' &&
    typeof field(value, 'message') === 'string'
  );
}

function requireResponse(events: readonly unknown[], id: string): RpcCommandResponse {
  const response = events.find(
    (event): event is RpcCommandResponse => isRpcCommandResponse(event) && event.id === id,
  );
  if (response === undefined) throw new Error(`missing RPC response ${id}`);
  return response;
}

function requireCommandInfo(value: unknown): RpcCommandInfo {
  if (!isJsonMap(value)) throw new TypeError('RPC command entry must be a map');
  const name = field(value, 'name');
  const description = field(value, 'description');
  if (typeof name !== 'string') throw new TypeError('RPC command entry missing name');
  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('RPC command description must be text when present');
  }
  return description === undefined ? { name } : { name, description };
}

function commandsFrom(response: RpcCommandResponse): RpcCommandInfo[] {
  if (!isJsonMap(response.data)) throw new TypeError('get_commands data must be a map');
  const commands = field(response.data, 'commands');
  if (!Array.isArray(commands)) throw new TypeError('get_commands commands must be an array');
  return commands.map((command) => requireCommandInfo(command));
}

function commandNames(commands: readonly RpcCommandInfo[]): string[] {
  return commands.map((command) => command.name).sort();
}

function requireListedCommand(commands: readonly RpcCommandInfo[], name: string): RpcCommandInfo {
  const command = commands.find((entry) => entry.name === name);
  if (command === undefined) throw new Error(`missing listed command ${name}`);
  return command;
}

function notifications(events: readonly unknown[]): RpcNotifyRequest[] {
  return events.filter((event): event is RpcNotifyRequest => isRpcNotifyRequest(event));
}

function offlineEnv(
  home: string,
  overrides: { readonly [key: string]: string | undefined } = {},
): { readonly [key: string]: string | undefined } {
  return {
    ...process.env,
    ...overrides,
    HOME: home,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    CI: '1',
  };
}

async function runRpc(
  commands: readonly JsonMap[],
  envOverrides: { readonly [key: string]: string | undefined } = {},
): Promise<RpcRunResult> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-rpc-'));
  try {
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const sessionDir = join(root, 'sessions');
    await initGitProject(cwd);
    await mkdir(home, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const input = commands.map((command) => JSON.stringify(command)).join('\n') + '\n';
    const result = spawnPiRpc(cwd, home, sessionDir, input, {
      ...envOverrides,
      [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'autopilot-state'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.stderr, '');
    return { events: parseJsonLines(result.stdout), stdout: result.stdout };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function initGitProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# rpc project\n', 'utf8');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'autopilot@example.invalid']);
  git(project, ['config', 'user.name', 'Autopilot Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function spawnPiRpc(
  cwd: string,
  home: string,
  sessionDir: string,
  input: string,
  envOverrides: { readonly [key: string]: string | undefined },
) {
  return spawnSync('pi', [
    '--mode',
    'rpc',
    '--no-session',
    '--session-dir',
    sessionDir,
    '--offline',
    '--no-extensions',
    '-e',
    extensionPath,
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
  ], {
    cwd,
    env: offlineEnv(home, envOverrides),
    encoding: 'utf8',
    input,
    timeout: 15_000,
  });
}

void describe('Pi RPC Autopilot command wiring', () => {
  void it('reports only the Autopilot slash commands over pi --mode rpc', async () => {
    const { events } = await runRpc([{ id: 'commands', type: 'get_commands' }]);
    const commands = commandsFrom(requireResponse(events, 'commands'));
    assert.deepEqual(commandNames(commands), [
      AUTOPILOT_COMMAND,
      AUTOPILOT_HANDOFF_COMMAND,
      AUTOPILOT_ONBOARD_COMMAND,
    ]);
    assert.match(requireListedCommand(commands, AUTOPILOT_COMMAND).description ?? '', /Start or resume Autopilot/);
    assert.match(
      requireListedCommand(commands, AUTOPILOT_ONBOARD_COMMAND).description ?? '',
      /paste-ready Autopilot onboarding instructions/,
    );
    assert.match(
      requireListedCommand(commands, AUTOPILOT_HANDOFF_COMMAND).description ?? '',
      /current active workstream/,
    );
    assert.equal(commands.some((command) => command.name === forbiddenLegacyCommand), false);
    assert.equal(commands.some((command) => command.name === 'autopilot-restart'), false);
    assert.equal(commands.some((command) => command.name === AUTOPILOT_STATUS_TOOL), false);
  });

  void it('rejects invalid AUTOPILOT_CONTEXT_HALT_PERCENT during /autopilot activation over RPC', async () => {
    const { events } = await runRpc(
      [{ id: 'autopilot', type: 'prompt', message: '/autopilot rpc-demo threshold check' }],
      { AUTOPILOT_CONTEXT_HALT_PERCENT: 'not-a-number' },
    );

    const autopilot = requireResponse(events, 'autopilot');
    assert.equal(autopilot.success, true, autopilot.error);
    const notifyMessages = notifications(events).map((event) => event.message);
    assert.equal(
      notifyMessages.some((message) =>
        /Autopilot could not activate context_budget: AUTOPILOT_CONTEXT_HALT_PERCENT/.test(message),
      ),
      true,
    );
    assert.equal(notifyMessages.some((message) => /Autopilot activated for rpc-demo\./.test(message)), false);
  });

  void it('executes prompt-only Autopilot commands through offline RPC', async () => {
    const { events, stdout } = await runRpc([
      { id: 'commands', type: 'get_commands' },
      { id: 'handoff-before', type: 'prompt', message: '/autopilot-handoff operator note before activation' },
      { id: 'onboard', type: 'prompt', message: '/autopilot-onboard rpc-demo old refs' },
    ]);

    const commands = commandsFrom(requireResponse(events, 'commands'));
    assert.deepEqual(commandNames(commands), [
      AUTOPILOT_COMMAND,
      AUTOPILOT_HANDOFF_COMMAND,
      AUTOPILOT_ONBOARD_COMMAND,
    ]);
    const onboard = requireResponse(events, 'onboard');
    const handoffBefore = requireResponse(events, 'handoff-before');
    assert.equal(onboard.success, true, onboard.error);
    assert.equal(handoffBefore.success, true, handoffBefore.error);
    assert.equal(stdout.includes(`/${forbiddenLegacyCommand}`), false);
    assert.equal(stdout.includes('/autopilot-restart'), false);
    assert.equal(stdout.includes(AUTOPILOT_STATUS_TOOL), false);

    const notifyMessages = notifications(events).map((event) => event.message);
    assert.equal(notifyMessages.some((message) => /No active Autopilot workstream/.test(message)), true);
    assert.equal(
      notifyMessages.some((message) => /Autopilot onboard brief/.test(message) && /rpc-demo/.test(message)),
      true,
    );
  });
});
