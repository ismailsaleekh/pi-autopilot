// Authoritative code-surface enumeration for the docs freshness gate.
//
// Governing principle (design §2): the surface inventory is enumerated from CODE,
// never from docs. This module is the single source of that inventory. It has two
// halves, both deterministic and offline:
//
//   1. Value layer — import the compiled constants under dist/ (names, roster,
//      scheduler/context defaults, schema names, tool names). These are the exact
//      runtime values the generator embeds and the fact-pins assert.
//   2. AST layer — a bounded TypeScript-compiler-API pass over src/extension.ts +
//      src/internal/status-extension.ts + the two CLI entrypoints, yielding the set
//      of ACTUALLY registered commands/tools and the CLI subcommand lists. C1
//      cross-checks the AST registration set against the exported constant set so
//      neither a doc nor a literal registration can drift from the constants.
//
// Every failure here is loud (throws). There is no regex-accept-or-skip path.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AST_SOURCES, DIST_MODULES, PACKAGE_ROOT } from './config.mjs';

const require = createRequire(import.meta.url);

function distMissing(relPath) {
  return new Error(
    `docs gate cannot read compiled module ${relPath}. Run "npm run build" first; ` +
      'the docs generator/verifier requires an up-to-date dist/ (never a source fallback).',
  );
}

async function importDist(relPath) {
  const absolute = resolve(PACKAGE_ROOT, relPath);
  try {
    readFileSync(absolute);
  } catch {
    throw distMissing(relPath);
  }
  return await import(pathToFileURL(absolute).href);
}

function readSource(relPath) {
  return readFileSync(resolve(PACKAGE_ROOT, relPath), 'utf8');
}

function loadTypeScript() {
  try {
    return require('typescript');
  } catch {
    throw new Error('docs gate requires the "typescript" devDependency for the AST cross-check; it was not resolvable.');
  }
}

/**
 * Collect all string-literal values assigned to `export const NAME = '...'` in a
 * compiled/source module via the TS AST, keyed by exported identifier. Used to map
 * a constant identifier (e.g. AUTOPILOT_COMMAND) back to its literal value from
 * source when we need identifier-level provenance the compiled module does not keep.
 */
function exportedStringConstants(ts, sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const constants = new Map();
  const visit = (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          ts.isStringLiteral(declaration.initializer)
        ) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

/**
 * Extract the set of command names passed to `pi.registerCommand(<CONST>, …)` and
 * the tool constructors referenced in `pi.registerTool(create…Tool(…))` from the
 * extension source, resolving constant identifiers to their literal values.
 */
function extractRegisteredSurfaces(ts, extensionSource, nameConstants) {
  const sourceFile = ts.createSourceFile(AST_SOURCES.extension, extensionSource, ts.ScriptTarget.ES2022, true);
  const registeredCommands = new Set();
  const registeredToolFactories = new Set();

  const resolveArg = (arg) => {
    if (ts.isStringLiteral(arg)) return arg.text;
    if (ts.isIdentifier(arg)) {
      const value = nameConstants.get(arg.text);
      if (value === undefined) {
        throw new Error(`extension.ts registers a command with unknown constant "${arg.text}" (not an exported string const in names.ts)`);
      }
      return value;
    }
    throw new Error('extension.ts registerCommand first argument is neither a string literal nor a known name constant');
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'registerCommand') {
        const first = node.arguments[0];
        if (first === undefined) throw new Error('extension.ts registerCommand called with no arguments');
        registeredCommands.add(resolveArg(first));
      } else if (method === 'registerTool') {
        const first = node.arguments[0];
        if (first !== undefined && ts.isCallExpression(first) && ts.isIdentifier(first.expression)) {
          registeredToolFactories.add(first.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { registeredCommands, registeredToolFactories };
}

/** Parse the coordinator CLI subcommand union from its `parseArgs` guard. */
function extractCoordinatorSubcommands(coordinatorSource) {
  // The CLI validates `command !== 'serve' && command !== 'status' && …`. We read
  // the exact union from the CliArgs.command type declaration, which is the single
  // authoritative list, and fail loudly if it cannot be located.
  const typeMatch = coordinatorSource.match(/readonly command:\s*([^;]+);/u);
  if (typeMatch === null) throw new Error('autopilot-coordinator.ts CliArgs.command union not found');
  const commands = [...typeMatch[1].matchAll(/'([a-z0-9-]+)'/gu)].map((entry) => entry[1]);
  if (commands.length === 0) throw new Error('autopilot-coordinator.ts CliArgs.command union is empty');
  // `recovery` is dispatched before parseArgs; include it explicitly from the guard.
  if (!coordinatorSource.includes("argv[0] === 'recovery'")) {
    throw new Error('autopilot-coordinator.ts no longer dispatches the recovery subcommand as expected');
  }
  return [...commands, 'recovery'];
}

function extractAgentRunInvocations(agentRunSource) {
  // The generated CLI synopsis must come from the runner's own usage() function,
  // not a second hand-maintained string in the docs renderer. Keep the parser narrow
  // and loud so a changed usage shape forces the generator to be updated.
  const usageMatch = agentRunSource.match(/function usage\(\): string \{[\s\S]*?return \[\n([\s\S]*?)\n\s*\]\.join\('\\n'\);/u);
  if (usageMatch === null) throw new Error('autopilot-agent-run.ts usage() return array not found');
  const invocations = [];
  for (const entry of usageMatch[1].matchAll(/^\s*'([^']*)',?$/gmu)) {
    const line = entry[1];
    if (line.startsWith('usage: ')) invocations.push(line.slice('usage: '.length));
    else if (line.trim().startsWith('autopilot-agent-run ')) invocations.push(line.trim());
  }
  if (invocations.length === 0) throw new Error('autopilot-agent-run.ts usage() has no invocation lines');
  return invocations;
}

/**
 * Build the full authoritative surface inventory used by the generator and checks.
 * @returns {Promise<import('./code-surfaces.mjs').CodeSurfaces>}
 */
export async function loadCodeSurfaces() {
  const ts = loadTypeScript();
  const names = await importDist(DIST_MODULES.names);
  const roster = await importDist(DIST_MODULES.modelRoster);
  const scheduler = await importDist(DIST_MODULES.schedulerConfig);
  const contextBudget = await importDist(DIST_MODULES.contextBudget);
  const materialization = await importDist(DIST_MODULES.materialization);
  const contractsTypes = await importDist(DIST_MODULES.contractsTypes);

  const namesSource = readSource('src/core/names.ts');
  const materializationSource = readSource('src/core/materialization.ts');
  const nameConstants = exportedStringConstants(ts, namesSource, 'names.ts');
  for (const [identifier, value] of exportedStringConstants(ts, materializationSource, 'materialization.ts')) {
    if (!nameConstants.has(identifier)) nameConstants.set(identifier, value);
  }

  const extensionSource = readSource(AST_SOURCES.extension);
  const { registeredCommands, registeredToolFactories } = extractRegisteredSurfaces(ts, extensionSource, nameConstants);

  // Slash commands, in registration order as declared by the constants module.
  const commandConstants = [
    'AUTOPILOT_COMMAND',
    'AUTOPILOT_INJECT_COMMAND',
    'AUTOPILOT_ONBOARD_COMMAND',
    'AUTOPILOT_HANDOFF_COMMAND',
    'AUTOPILOT_CONFIG_COMMAND',
    'AUTOPILOT_CLOSE_COMMAND',
    'AUTOPILOT_ABORT_COMMAND',
    'AUTOPILOT_CLAIM_GC_COMMAND',
    'AUTOPILOT_COORDINATION_COMMAND',
  ];
  const commands = commandConstants.map((constant) => {
    const value = names[constant];
    if (typeof value !== 'string') throw new Error(`names.ts is missing exported command constant ${constant}`);
    return value;
  });

  // Cross-check: the AST-registered command set must equal the constant set (C1).
  const constantSet = new Set(commands);
  for (const registered of registeredCommands) {
    if (!constantSet.has(registered)) {
      throw new Error(`extension.ts registers command "${registered}" that is not in the documented command constant set`);
    }
  }
  for (const documented of commands) {
    if (!registeredCommands.has(documented)) {
      throw new Error(`command constant "${documented}" is never registered in extension.ts`);
    }
  }

  const tools = [
    { name: names.CONTEXT_BUDGET_TOOL_NAME, availability: 'parent', factory: 'createContextBudgetTool' },
    { name: names.AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME, availability: 'parent', factory: 'createClaimResponseTool' },
    { name: names.AUTOPILOT_STATUS_TOOL, availability: 'child', factory: null },
    { name: materialization.AUTOPILOT_MATERIALIZE_CONTEXT_TOOL, availability: 'child', factory: null },
  ];
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error(`tool constant for factory ${String(tool.factory)} is missing or empty`);
    }
    if (tool.availability === 'parent' && tool.factory !== null && !registeredToolFactories.has(tool.factory)) {
      throw new Error(`parent tool factory "${tool.factory}" is never registered via pi.registerTool in extension.ts`);
    }
  }

  const schemaNames = names.AUTOPILOT_SCHEMA_NAMES;
  if (!Array.isArray(schemaNames) || schemaNames.length === 0) throw new Error('AUTOPILOT_SCHEMA_NAMES is missing or empty');

  const roles = contractsTypes.AUTOPILOT_ROLE_VALUES;
  if (!Array.isArray(roles) || roles.length === 0) throw new Error('AUTOPILOT_ROLE_VALUES is missing or empty');

  const parentAssignment = roster.AUTOPILOT_PARENT_MODEL_ASSIGNMENT;
  const roleRoster = roster.AUTOPILOT_ROLE_MODEL_ROSTER;
  if (parentAssignment === undefined || roleRoster === undefined) throw new Error('model roster exports are missing');

  const coordinatorSource = readSource(AST_SOURCES.coordinatorCli);
  const coordinatorSubcommands = extractCoordinatorSubcommands(coordinatorSource);
  const agentRunSource = readSource(AST_SOURCES.agentRunCli);
  const runnerInvocations = extractAgentRunInvocations(agentRunSource);

  return Object.freeze({
    packageName: names.AUTOPILOT_PACKAGE_NAME,
    extensionName: names.AUTOPILOT_EXTENSION_NAME,
    commands: Object.freeze(commands),
    tools: Object.freeze(tools.map((tool) => Object.freeze({ ...tool }))),
    schemaNames: Object.freeze([...schemaNames]),
    roles: Object.freeze([...roles]),
    thinkingValues: Object.freeze([...contractsTypes.AUTOPILOT_THINKING_VALUES]),
    verdicts: Object.freeze([...contractsTypes.AUTOPILOT_VERDICT_VALUES]),
    parentAssignment: Object.freeze({ ...parentAssignment }),
    roleRoster: Object.freeze(
      roles.map((role) => Object.freeze({ role, ...roleRoster[role] })),
    ),
    runnerBin: names.AUTOPILOT_RUNNER_BIN,
    runnerInvocations: Object.freeze(runnerInvocations),
    coordinatorBin: names.AUTOPILOT_COORDINATOR_BIN,
    coordinatorSubcommands: Object.freeze(coordinatorSubcommands),
    runtimeRootPrefix: names.AUTOPILOT_RUNTIME_ROOT_PREFIX,
    defaults: Object.freeze({
      parallelCap: scheduler.AUTOPILOT_DEFAULT_PARALLEL_CAP,
      minParallelCap: scheduler.AUTOPILOT_MIN_PARALLEL_CAP,
      maxParallelCap: scheduler.AUTOPILOT_MAX_PARALLEL_CAP,
      contextHaltPercent: contextBudget.DEFAULT_CONTEXT_HALT_PERCENT,
    }),
    envVars: Object.freeze({
      stateRoot: 'AUTOPILOT_STATE_ROOT',
      contextHaltPercent: contextBudget.AUTOPILOT_CONTEXT_HALT_PERCENT_ENV,
      statusContext: names.AUTOPILOT_STATUS_CONTEXT_ENV,
      coordinatorSessionContext: names.AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV,
    }),
  });
}

/**
 * The full "documentable surface" string set (C1). A doc's covers_surfaces entries
 * are validated against this set, and every element must be covered by ≥1 doc.
 */
export function enumerateSurfaces(surfaces) {
  const result = new Set();
  for (const command of surfaces.commands) result.add(`/${command}`);
  for (const tool of surfaces.tools) result.add(tool.name);
  result.add(surfaces.runnerBin);
  result.add(surfaces.coordinatorBin);
  for (const schema of surfaces.schemaNames) result.add(schema);
  return result;
}
