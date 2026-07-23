import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface PackedManifestInvocation {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: Readonly<Record<string, unknown>> | null;
}

function parseLastJsonLine(stdout: string): Readonly<Record<string, unknown>> | null {
  const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) return null;
  const parsed: unknown = JSON.parse(last) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Readonly<Record<string, unknown>>
    : null;
}

export async function invokePackedManifestAutopilot(input: {
  readonly consumerRoot: string;
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly homeRoot: string;
  readonly workstream: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<PackedManifestInvocation> {
  const installedRoot = join(input.consumerRoot, 'node_modules', 'pi-autopilot');
  const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')) as Readonly<Record<string, unknown>>;
  const pi = manifest['pi'];
  if (typeof pi !== 'object' || pi === null || Array.isArray(pi)) throw new Error('installed Pi package manifest is missing');
  const declared = (pi as Readonly<Record<string, unknown>>)['extensions'];
  if (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== './extensions/autopilot.ts') throw new Error('installed Pi package extension declaration drifted');

  const scriptPath = join(input.consumerRoot, `invoke-manifest-${input.workstream}.mjs`);
  const packageSdkPath = fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url));
  const globalSdkPath = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
  const sdkUrl = pathToFileURL(existsSync(packageSdkPath) ? packageSdkPath : globalSdkPath).href;
  await writeFile(scriptPath, `
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sdk from ${JSON.stringify(sdkUrl)};

const installedRoot=${JSON.stringify(installedRoot)};
const projectRoot=${JSON.stringify(input.projectRoot)};
const agentDir=${JSON.stringify(join(input.homeRoot, '.pi', 'agent'))};
const stateRoot=${JSON.stringify(input.stateRoot)};
process.env.AUTOPILOT_STATE_ROOT=stateRoot;
process.env.PI_OFFLINE='1';
process.env.PI_SKIP_VERSION_CHECK='1';
process.env.PI_TELEMETRY='0';

const manifest=JSON.parse(readFileSync(join(installedRoot,'package.json'),'utf8'));
const manifestEntry=manifest.pi.extensions[0];
const loader=new sdk.DefaultResourceLoader({
  cwd:projectRoot,
  agentDir,
  additionalExtensionPaths:[installedRoot],
  noExtensions:true,
  noSkills:true,
  noPromptTemplates:true,
  noContextFiles:true,
});
await loader.reload();
const loaded=loader.getExtensions();
const modelRuntime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json')});
const registry=new sdk.ModelRegistry(modelRuntime);
const created=await sdk.createAgentSession({
  cwd:projectRoot,
  agentDir,
  resourceLoader:loader,
  sessionManager:sdk.SessionManager.inMemory(projectRoot),
  settingsManager:sdk.SettingsManager.inMemory(),
  modelRuntime,
  noTools:'builtin',
});
const session=created.session;
const messages=[];
const notifications=[];
let thinking='off';
let active=[];
session.extensionRunner.bindCore({
  sendMessage:()=>{},
  sendUserMessage:(content,options)=>messages.push({content,deliverAs:options?.deliverAs}),
  appendEntry:()=>{},setSessionName:()=>{},getSessionName:()=>undefined,setLabel:()=>{},
  getActiveTools:()=>[...active],getAllTools:()=>[],setActiveTools:(names)=>{active=[...names]},refreshTools:()=>{},
  getCommands:()=>session.extensionRunner.getRegisteredCommands().map((command)=>({name:command.name,description:command.description})),
  setModel:()=>Promise.resolve(true),getThinkingLevel:()=>thinking,setThinkingLevel:(value)=>{thinking=value},
},{
  getModel:()=>undefined,isIdle:()=>true,isProjectTrusted:()=>true,getSignal:()=>undefined,abort:()=>{},hasPendingMessages:()=>false,
  shutdown:()=>{},getContextUsage:()=>({tokens:1000,contextWindow:200000,percent:0.5}),compact:()=>{},getSystemPrompt:()=>'',
});
const command=session.extensionRunner.getCommand('autopilot');
if(!command) throw new Error('real manifest-loaded extension did not register /autopilot');
const context={
  cwd:projectRoot,
  ui:{notify:(message,kind)=>notifications.push({message,kind})},
  modelRegistry:registry,
  sessionManager:{getSessionId:()=>${JSON.stringify(`session-${input.workstream}`)}},
  isIdle:()=>true,
};
let thrown=null;
try { await command.handler(${JSON.stringify(`${input.workstream} synthetic offline work`)},context); }
catch(error){ thrown=error instanceof Error ? error.stack ?? error.message : String(error); }
try { await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); } catch {}
session.dispose();
let lock=null;
const lockPath=join(stateRoot,'coordinator','lifecycle-v2','coordinator.lock');
if(existsSync(lockPath)){try{lock=JSON.parse(readFileSync(lockPath,'utf8'))}catch{}}
console.log(JSON.stringify({
  manifestEntry,
  loadedExtensionPath:join(installedRoot,manifestEntry),
  loadErrors:loaded.errors,
  commandRegistered:true,
  messages:messages.length,
  notifications,
  thrown,
  lock,
}));
`, 'utf8');
  await mkdir(input.homeRoot, { recursive: true });
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: input.projectRoot,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...input.env,
      HOME: input.homeRoot,
      USERPROFILE: input.homeRoot,
      AUTOPILOT_STATE_ROOT: input.stateRoot,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      CI: '1',
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
    result: parseLastJsonLine(String(result.stdout)),
  };
}
