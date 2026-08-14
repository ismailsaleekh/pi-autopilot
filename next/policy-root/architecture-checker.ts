import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type ArchitectureRule =
  | "project-graph"
  | "one-append-edge"
  | "authority-purity"
  | "adapters-are-leaves"
  | "constructor-capabilities"
  | "extensions-sdk-only"
  | "durable-write-boundary"
  | "boundary-entry"
  | "old-new-isolation";

export interface ArchitectureFinding {
  readonly rule: ArchitectureRule;
  readonly origin: "source" | "emitted" | "config";
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

export interface SourceUnit {
  readonly origin: "source" | "emitted";
  readonly path: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

interface ImportEdge {
  readonly specifier: string;
  readonly node: ts.Node;
}

const PRODUCTION_ROOTS = Object.freeze([
  "authority",
  "runtime",
  "storage",
  "ports",
  "adapters",
  "apps",
  "extensions",
]);

const AMBIENT_AUTHORITY_NAMES = new Set([
  "Date",
  "Intl",
  "Promise",
  "process",
  "window",
  "document",
  "navigator",
  "fetch",
  "eval",
  "Function",
  "globalThis",
  "WebAssembly",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "performance",
  "crypto",
  "require",
]);

const TIMER_OR_SCHEDULER_NAMES = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "retry",
  "enqueue",
  "schedule",
]);

const AUTHORITY_CONSTRUCTION_NAMES = new Set([
  "defineCapsule",
  "canonicalEncodeUnknown",
  "canonicalDigestUnknown",
  "digestBytes",
]);

const DURABLE_WRITE_NAMES = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "fdatasync",
  "fdatasyncSync",
  "fsync",
  "fsyncSync",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
]);

function slash(value: string): string {
  return value.split(sep).join("/");
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function isProductionPath(path: string): boolean {
  return PRODUCTION_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function collectFiles(directory: string, extensions: ReadonlySet<string>): readonly string[] {
  if (!existsSync(directory)) {
    return Object.freeze([]);
  }
  const output: string[] = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .slice()
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (extensions.has(extname(entry.name))) {
        output.push(absolute);
      }
    }
  };
  visit(directory);
  return Object.freeze(output);
}

function parseUnit(
  logicalPath: string,
  text: string,
  origin: "source" | "emitted",
): SourceUnit {
  const language = origin === "source" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return Object.freeze({
    origin,
    path: logicalPath,
    text,
    sourceFile: ts.createSourceFile(logicalPath, text, ts.ScriptTarget.ES2022, true, language),
  });
}

function collectProjectConfigFiles(configPath: string, visited: Set<string>, output: Set<string>): void {
  const absoluteConfig = resolve(configPath);
  if (visited.has(absoluteConfig) || !existsSync(absoluteConfig)) {
    return;
  }
  visited.add(absoluteConfig);
  const read = ts.readConfigFile(absoluteConfig, ts.sys.readFile);
  if (read.error !== undefined) {
    return;
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(absoluteConfig),
    undefined,
    absoluteConfig,
  );
  for (const file of parsed.fileNames) {
    output.add(resolve(file));
  }
  for (const reference of parsed.projectReferences ?? []) {
    const referencePath = reference.path.endsWith(".json")
      ? reference.path
      : join(reference.path, "tsconfig.json");
    collectProjectConfigFiles(referencePath, visited, output);
  }
}

export function collectActualUnits(nextRoot: string): {
  readonly units: readonly SourceUnit[];
  readonly projectFindings: readonly ArchitectureFinding[];
} {
  const absoluteRoot = resolve(nextRoot);
  const sourceFiles: string[] = [];
  for (const productionRoot of PRODUCTION_ROOTS) {
    const files = collectFiles(join(absoluteRoot, productionRoot), new Set([".ts"]));
    for (const file of files) {
      if (!file.endsWith(".d.ts") && !file.endsWith(".test.ts")) {
        sourceFiles.push(file);
      }
    }
  }
  const testkitSourceFiles = collectFiles(join(absoluteRoot, "testkit"), new Set([".ts"]))
    .filter((file) => !file.endsWith(".d.ts"));
  const projectFiles = new Set<string>();
  collectProjectConfigFiles(join(absoluteRoot, "tsconfig.json"), new Set(), projectFiles);
  const projectFindings: ArchitectureFinding[] = [];
  for (const sourceFile of [...sourceFiles, ...testkitSourceFiles]) {
    if (!projectFiles.has(resolve(sourceFile))) {
      projectFindings.push(Object.freeze({
        rule: "project-graph",
        origin: "config",
        path: slash(relative(absoluteRoot, sourceFile)),
        line: 1,
        detail: "production TypeScript file is outside the referenced TS project graph",
      }));
    }
  }

  const units: SourceUnit[] = sourceFiles
    .sort(compareText)
    .map((file) => parseUnit(
      slash(relative(absoluteRoot, file)),
      readFileSync(file, "utf8"),
      "source",
    ));
  const emittedRoot = join(absoluteRoot, "dist");
  const emittedFiles = collectFiles(emittedRoot, new Set([".js"]));
  const emittedLogicalPaths = new Set<string>();
  for (const file of emittedFiles) {
    const logicalPath = slash(relative(emittedRoot, file));
    if (isProductionPath(logicalPath)) {
      emittedLogicalPaths.add(logicalPath);
      units.push(parseUnit(logicalPath, readFileSync(file, "utf8"), "emitted"));
    }
  }
  for (const sourceFile of sourceFiles) {
    const logicalSource = slash(relative(absoluteRoot, sourceFile));
    const expectedEmission = logicalSource.replace(/\.ts$/, ".js");
    if (!emittedLogicalPaths.has(expectedEmission)) {
      projectFindings.push(Object.freeze({
        rule: "project-graph",
        origin: "config",
        path: logicalSource,
        line: 1,
        detail: "production TypeScript file has no corresponding fresh emitted JavaScript",
      }));
    }
  }
  const emittedTestkitRoot = join(absoluteRoot, "dist-testkit", "testkit");
  const emittedTestkitFiles = new Set(collectFiles(emittedTestkitRoot, new Set([".js"]))
    .map((file) => slash(relative(emittedTestkitRoot, file))));
  for (const sourceFile of testkitSourceFiles) {
    const logicalSource = slash(relative(join(absoluteRoot, "testkit"), sourceFile));
    const expectedEmission = logicalSource.replace(/\.ts$/, ".js");
    if (!emittedTestkitFiles.has(expectedEmission)) {
      projectFindings.push(Object.freeze({
        rule: "project-graph",
        origin: "config",
        path: `testkit/${logicalSource}`,
        line: 1,
        detail: "testkit TypeScript file has no corresponding fresh emitted JavaScript",
      }));
    }
  }
  return Object.freeze({
    units: Object.freeze(units),
    projectFindings: Object.freeze(projectFindings),
  });
}

function lineOf(unit: SourceUnit, node: ts.Node): number {
  return unit.sourceFile.getLineAndCharacterOfPosition(node.getStart(unit.sourceFile)).line + 1;
}

function finding(
  rule: ArchitectureRule,
  unit: SourceUnit,
  node: ts.Node,
  detail: string,
): ArchitectureFinding {
  return Object.freeze({
    rule,
    origin: unit.origin,
    path: unit.path,
    line: lineOf(unit, node),
    detail,
  });
}

function configFinding(path: string, detail: string): ArchitectureFinding {
  return Object.freeze({
    rule: "project-graph",
    origin: "config",
    path,
    line: 1,
    detail,
  });
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function importsOf(unit: SourceUnit): readonly ImportEdge[] {
  const output: ImportEdge[] = [];
  visit(unit.sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        output.push(Object.freeze({ specifier: node.moduleSpecifier.text, node }));
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        output.push(Object.freeze({ specifier: argument.text, node }));
      }
    }
  });
  return Object.freeze(output);
}

function importEdgeIsTypeOnly(edge: ImportEdge): boolean {
  if (ts.isExportDeclaration(edge.node)) {
    return edge.node.isTypeOnly;
  }
  if (!ts.isImportDeclaration(edge.node)) {
    return false;
  }
  const clause = edge.node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  return clause.name === undefined
    && clause.namedBindings !== undefined
    && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function resolvedLogicalImport(unit: SourceUnit, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = unit.path.includes("/") ? unit.path.slice(0, unit.path.lastIndexOf("/")) : "";
  const absolute = slash(resolve("/logical", base, specifier));
  if (!absolute.startsWith("/logical/")) {
    return `../${absolute.slice(1)}`;
  }
  const normalized = absolute.slice("/logical/".length);
  return normalized.replace(/\.(?:js|ts)$/, "");
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return null;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return null;
  }
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function objectKeys(node: ts.ObjectLiteralExpression): ReadonlySet<string> {
  const output = new Set<string>();
  for (const property of node.properties) {
    const name = propertyName(property);
    if (name !== null) {
      output.add(name);
    }
  }
  return output;
}

function objectStringProperty(node: ts.ObjectLiteralExpression, name: string): string | null {
  for (const property of node.properties) {
    if (propertyName(property) !== name || !ts.isPropertyAssignment(property)) {
      continue;
    }
    if (ts.isStringLiteral(property.initializer)) {
      return property.initializer.text;
    }
  }
  return null;
}

function insideSchemaDescriptor(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent)
    && ts.isIdentifier(parent.expression)
    && parent.expression.text === "object";
}

function contextualTypeText(node: ts.ObjectLiteralExpression): string {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.type !== undefined) {
    return parent.type.getText();
  }
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    return parent.type.getText();
  }
  if (ts.isReturnStatement(parent)) {
    let current: ts.Node | undefined = parent.parent;
    while (current !== undefined) {
      if (ts.isFunctionLike(current) && current.type !== undefined) {
        return current.type.getText();
      }
      current = current.parent;
    }
  }
  return "";
}

function checkOneAppendEdge(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const origin of ["source", "emitted"] as const) {
    const originUnits = units.filter((unit) => unit.origin === origin);
    const hasCommitLoopImplementation = originUnits.some(
      (unit) => unit.path.startsWith("runtime/commit-loop/")
        && !unit.path.endsWith("_project.js")
        && !unit.path.endsWith("_project.ts"),
    );
    const calls: Array<{ readonly unit: SourceUnit; readonly node: ts.CallExpression }> = [];
    const externalJournalImports: Array<{ readonly unit: SourceUnit; readonly edge: ImportEdge }> = [];
    for (const unit of originUnits) {
      for (const edge of importsOf(unit)) {
        const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
        if (
          resolvedImport !== null
          && resolvedImport.startsWith("storage/journal/")
          && !unit.path.startsWith("storage/journal/")
        ) {
          externalJournalImports.push({ unit, edge });
        }
      }
      visit(unit.sourceFile, (node) => {
        if (ts.isCallExpression(node) && callName(node) === "appendCommittedBatch") {
          calls.push({ unit, node });
        }
      });
    }

    const anchor = originUnits.find((unit) => unit.path.startsWith("runtime/commit-loop/"))
      ?? originUnits.find((unit) => unit.path.startsWith("storage/journal/"));
    if (!hasCommitLoopImplementation) {
      if ((calls.length !== 0 || externalJournalImports.length !== 0) && anchor !== undefined) {
        output.push(finding(
          "one-append-edge",
          anchor,
          anchor.sourceFile,
          "pre-commit-loop phase requires zero external journal append call/import edges",
        ));
      }
    } else if (anchor !== undefined) {
      if (calls.length !== 1) {
        output.push(finding(
          "one-append-edge",
          anchor,
          anchor.sourceFile,
          `commit-loop phase requires exactly one appendCommittedBatch call edge, found ${String(calls.length)}`,
        ));
      }
      if (externalJournalImports.length !== 1) {
        output.push(finding(
          "one-append-edge",
          anchor,
          anchor.sourceFile,
          `commit-loop phase requires exactly one external journal import edge, found ${String(externalJournalImports.length)}`,
        ));
      }
    }

    for (const call of calls) {
      if (call.unit.path.startsWith("storage/journal/")) {
        continue;
      }
      if (!call.unit.path.startsWith("runtime/commit-loop/")) {
        output.push(finding(
          "one-append-edge",
          call.unit,
          call.node,
          "journal append is callable only from runtime/commit-loop",
        ));
      }
    }
    for (const imported of externalJournalImports) {
      if (!imported.unit.path.startsWith("runtime/commit-loop/")) {
        output.push(finding(
          "one-append-edge",
          imported.unit,
          imported.edge.node,
          "only runtime/commit-loop may import journal append capability",
        ));
      }
    }
  }
  return Object.freeze(output);
}

function checkAuthorityPurity(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    if (!unit.path.startsWith("authority/")) {
      continue;
    }
    for (const edge of importsOf(unit)) {
      const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
      if (resolvedImport === null || !resolvedImport.startsWith("authority/")) {
        output.push(finding(
          "authority-purity",
          unit,
          edge.node,
          "authority imports must resolve inside the pure authority project",
        ));
      }
    }
    for (const statement of unit.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const flags = ts.getCombinedNodeFlags(statement.declarationList);
        if ((flags & ts.NodeFlags.Const) === 0) {
          output.push(finding(
            "authority-purity",
            unit,
            statement,
            "mutable top-level bindings are forbidden",
          ));
        }
      }
    }
    visit(unit.sourceFile, (node) => {
      if (ts.isTryStatement(node) || ts.isThrowStatement(node)) {
        output.push(finding(
          "authority-purity",
          unit,
          node,
          "exception control flow is forbidden in authority",
        ));
      }
      if (ts.isAwaitExpression(node)) {
        output.push(finding("authority-purity", unit, node, "await is forbidden in authority"));
      }
      if (ts.isFunctionLike(node)) {
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        const isAsync = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        if (isAsync) {
          output.push(finding("authority-purity", unit, node, "async functions are forbidden in authority"));
        }
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          output.push(finding("authority-purity", unit, node, "dynamic import is forbidden in authority"));
        }
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText() === "Math"
          && node.expression.name.text === "random"
        ) {
          output.push(finding("authority-purity", unit, node, "randomness is forbidden in authority"));
        }
        const call = callName(node);
        if (
          call !== null
          && AUTHORITY_CONSTRUCTION_NAMES.has(call)
          && !unit.path.startsWith("authority/protocol/")
        ) {
          output.push(finding(
            "authority-purity",
            unit,
            node,
            "protocol construction and canonical codecs are callable only inside authority/protocol",
          ));
        }
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText() === "JSON"
          && (node.expression.name.text === "stringify" || node.expression.name.text === "parse")
        ) {
          output.push(finding(
            "authority-purity",
            unit,
            node,
            "ambient JSON codecs are forbidden; use the canonical schema codec",
          ));
        }
      }
      if (ts.isIdentifier(node) && AMBIENT_AUTHORITY_NAMES.has(node.text)) {
        if (
          ts.isPropertyAccessExpression(node.parent)
          && node.parent.name === node
          && !ts.isCallExpression(node.parent.parent)
        ) {
          return;
        }
        output.push(finding(
          "authority-purity",
          unit,
          node,
          `ambient capability '${node.text}' is forbidden in authority`,
        ));
      }
    });
  }
  return Object.freeze(output);
}

function adapterContractName(adapter: string): string {
  if (adapter === "process" || adapter === "pi-session") {
    return "child";
  }
  return adapter;
}

function checkAdaptersAreLeaves(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    if (!unit.path.startsWith("adapters/")) {
      continue;
    }
    const segments = unit.path.split("/");
    const adapter = segments[1] ?? "";
    for (const edge of importsOf(unit)) {
      const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
      if (resolvedImport === null) {
        continue;
      }
      const ownAdapter = resolvedImport.startsWith(`adapters/${adapter}/`);
      const ownContract = resolvedImport === `ports/contracts/${adapterContractName(adapter)}.capsule`;
      if (!ownAdapter && !ownContract) {
        output.push(finding(
          "adapters-are-leaves",
          unit,
          edge.node,
          "adapter may import only its own files, its own port contract, and platform libraries",
        ));
      }
    }
    visit(unit.sourceFile, (node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (name !== null && TIMER_OR_SCHEDULER_NAMES.has(name)) {
          output.push(finding(
            "adapters-are-leaves",
            unit,
            node,
            "retry, queue, scheduler, and timer behavior is forbidden in adapters",
          ));
        }
      }
    });
  }
  return Object.freeze(output);
}

function checkConstructorCapabilities(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  const evidenceFields = Object.freeze([
    "actionId",
    "attemptId",
    "command",
    "cwd",
    "environment",
    "evidenceId",
    "exit",
    "kindId",
    "output",
    "runId",
    "tree",
    "workItemId",
  ]);
  for (const unit of units) {
    for (const edge of importsOf(unit)) {
      const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
      if (
        resolvedImport === "authority/protocol/accepted-batch"
        && !unit.path.startsWith("authority/facade/")
        && !importEdgeIsTypeOnly(edge)
      ) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          edge.node,
          "AcceptedBatch mint capability may be value-imported only by authority/facade",
        ));
      }
    }
    visit(unit.sourceFile, (node) => {
      if (!ts.isObjectLiteralExpression(node) || insideSchemaDescriptor(node)) {
        return;
      }
      const keys = objectKeys(node);
      const kind = objectStringProperty(node, "kind");
      const typeText = contextualTypeText(node);
      const terminalShape = kind === "t1" || kind === "t2" || typeText.includes("TerminalOutcome");
      if (terminalShape && !unit.path.startsWith("authority/outcome/")) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "TerminalOutcome values may be constructed only in authority/outcome",
        ));
      }
      const evidenceShape = evidenceFields.every((field) => keys.has(field))
        || typeText.includes("EvidenceEnvelope");
      if (evidenceShape && !unit.path.startsWith("runtime/dispatcher/")) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "EvidenceEnvelope values may be constructed only in runtime/dispatcher",
        ));
      }
      if (
        typeText.includes("AcceptedBatch")
        && !unit.path.startsWith("authority/facade/")
        && unit.path !== "authority/protocol/accepted-batch.ts"
      ) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "AcceptedBatch values may be constructed only in authority/facade",
        ));
      }
      if (
        kind !== null
        && new Set(["failed", "blocked", "timeout", "cancelled", "unsafe"]).has(kind)
        && typeText.includes("TerminalOutcome")
      ) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "a third semantic terminal variant is forbidden",
        ));
      }
    });
    visit(unit.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      const name = callName(node);
      if (name === "makeTerminalOutcome" && !unit.path.startsWith("authority/outcome/")) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "TerminalOutcome constructor capability is owned by authority/outcome",
        ));
      }
      if (name === "makeEvidenceEnvelope" && !unit.path.startsWith("runtime/dispatcher/")) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "EvidenceEnvelope constructor capability is owned by runtime/dispatcher",
        ));
      }
      if (
        (name === "makeAcceptedBatch" || name === "mintAcceptedBatch")
        && !unit.path.startsWith("authority/facade/")
      ) {
        output.push(finding(
          "constructor-capabilities",
          unit,
          node,
          "AcceptedBatch constructor capability is owned by authority/facade",
        ));
      }
    });
  }
  return Object.freeze(output);
}

function checkExtensionsSdkOnly(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    if (!unit.path.startsWith("extensions/") || unit.path.startsWith("extensions/sdk/")) {
      continue;
    }
    for (const edge of importsOf(unit)) {
      const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
      if (resolvedImport === null || !resolvedImport.startsWith("extensions/sdk/")) {
        output.push(finding(
          "extensions-sdk-only",
          unit,
          edge.node,
          "extension implementation may import only the extension SDK",
        ));
      }
    }
  }
  return Object.freeze(output);
}

function checkDurableWriteBoundary(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    if (!isProductionPath(unit.path)) {
      continue;
    }
    const allowed = unit.path.startsWith("storage/") || unit.path.startsWith("adapters/workspace/");
    if (allowed) {
      continue;
    }
    visit(unit.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      const name = callName(node);
      if (name !== null && DURABLE_WRITE_NAMES.has(name)) {
        output.push(finding(
          "durable-write-boundary",
          unit,
          node,
          `durable-write API '${name}' is restricted to storage and adapters/workspace`,
        ));
      }
    });
  }
  return Object.freeze(output);
}

function firstParameterIsUnknown(node: ts.SignatureDeclaration): boolean {
  const parameter = node.parameters[0];
  return parameter !== undefined
    && parameter.type !== undefined
    && parameter.type.kind === ts.SyntaxKind.UnknownKeyword;
}

function checkBoundaryEntry(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    visit(unit.sourceFile, (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText() === "JSON"
        && node.expression.name.text === "parse"
        && !unit.path.startsWith("runtime/boundary-codecs/")
      ) {
        output.push(finding(
          "boundary-entry",
          unit,
          node,
          "JSON.parse is legal only inside runtime/boundary-codecs",
        ));
      }
      if (
        unit.origin === "source"
        && unit.path.startsWith("runtime/boundary-codecs/")
        && ts.isFunctionLike(node)
        && (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && !firstParameterIsUnknown(node)
      ) {
        output.push(finding(
          "boundary-entry",
          unit,
          node,
          "exported boundary decoder must receive its external value as unknown",
        ));
      }
    });
  }
  return Object.freeze(output);
}

function checkOldNewIsolation(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  for (const unit of units) {
    for (const edge of importsOf(unit)) {
      const lower = edge.specifier.toLowerCase();
      const resolvedImport = resolvedLogicalImport(unit, edge.specifier);
      const escaped = resolvedImport !== null && resolvedImport.startsWith("../");
      const namesOldTree = lower.includes("/src/")
        || lower.includes("/kernel/")
        || lower.includes("/drivers/")
        || lower.includes("pi-autopilot/src")
        || lower.includes("pi-autopilot/kernel")
        || lower.includes("pi-autopilot/drivers");
      if (escaped || namesOldTree) {
        output.push(finding(
          "old-new-isolation",
          unit,
          edge.node,
          "next production code may not import outside next or name an old implementation tree",
        ));
      }
    }
  }
  return Object.freeze(output);
}

export function checkArchitectureUnits(units: readonly SourceUnit[]): readonly ArchitectureFinding[] {
  return Object.freeze([
    ...checkOneAppendEdge(units),
    ...checkAuthorityPurity(units),
    ...checkAdaptersAreLeaves(units),
    ...checkConstructorCapabilities(units),
    ...checkExtensionsSdkOnly(units),
    ...checkDurableWriteBoundary(units),
    ...checkBoundaryEntry(units),
    ...checkOldNewIsolation(units),
  ]);
}

interface CompilerOptionsShape {
  readonly strict?: unknown;
  readonly exactOptionalPropertyTypes?: unknown;
  readonly noUncheckedIndexedAccess?: unknown;
  readonly useUnknownInCatchVariables?: unknown;
  readonly noImplicitReturns?: unknown;
  readonly noFallthroughCasesInSwitch?: unknown;
  readonly lib?: unknown;
  readonly types?: unknown;
}

function parsedCompilerOptions(path: string): CompilerOptionsShape | null {
  if (!existsSync(path)) {
    return null;
  }
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error !== undefined || typeof read.config !== "object" || read.config === null) {
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
  return {
    strict: parsed.options.strict,
    exactOptionalPropertyTypes: parsed.options.exactOptionalPropertyTypes,
    noUncheckedIndexedAccess: parsed.options.noUncheckedIndexedAccess,
    useUnknownInCatchVariables: parsed.options.useUnknownInCatchVariables,
    noImplicitReturns: parsed.options.noImplicitReturns,
    noFallthroughCasesInSwitch: parsed.options.noFallthroughCasesInSwitch,
    lib: parsed.options.lib,
    types: parsed.options.types,
  };
}

export function checkCompilerBaseline(nextRoot: string): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  const configPaths = Object.freeze([
    "authority/tsconfig.json",
    "ports/tsconfig.json",
    "storage/tsconfig.json",
    "runtime/tsconfig.json",
    "adapters/tsconfig.json",
    "apps/tsconfig.json",
    "testkit/tsconfig.json",
    "tsconfig.tests.json",
    "tsconfig.policy.json",
  ]);
  const requiredFlags: ReadonlyArray<keyof CompilerOptionsShape> = Object.freeze([
    "strict",
    "exactOptionalPropertyTypes",
    "noUncheckedIndexedAccess",
    "useUnknownInCatchVariables",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
  ]);
  for (const configPath of configPaths) {
    const options = parsedCompilerOptions(join(nextRoot, configPath));
    if (options === null) {
      output.push(configFinding(configPath, "required TS project config is missing or unreadable"));
      continue;
    }
    for (const flag of requiredFlags) {
      if (options[flag] !== true) {
        output.push(configFinding(configPath, `strict compiler flag '${flag}' must be true`));
      }
    }
  }
  const authority = parsedCompilerOptions(join(nextRoot, "authority", "tsconfig.json"));
  if (authority !== null) {
    const libraries = Array.isArray(authority.lib) ? authority.lib.map(String) : [];
    const types = Array.isArray(authority.types) ? authority.types : [];
    if (libraries.some((library) => library.toLowerCase().includes("dom")) || types.length !== 0) {
      output.push(configFinding(
        "authority/tsconfig.json",
        "authority must expose neither DOM libraries nor ambient type packages",
      ));
    }
  }
  return Object.freeze(output);
}

export function checkLegacyReferenceText(
  path: string,
  text: string,
): readonly ArchitectureFinding[] {
  const output: ArchitectureFinding[] = [];
  const lines = text.split(/\r?\n/);
  const nextReference = /(?:packages\/pi-autopilot\/next|(?:^|["'`./])next\/)/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (nextReference.test(line)) {
      output.push(Object.freeze({
        rule: "old-new-isolation",
        origin: "source",
        path,
        line: index + 1,
        detail: "old package code and manifest may not reference the clean-rebuild next tree",
      }));
    }
  }
  return Object.freeze(output);
}

function checkLegacyPackageIsolation(nextRoot: string): readonly ArchitectureFinding[] {
  const packageRoot = dirname(resolve(nextRoot));
  const output: ArchitectureFinding[] = [];
  const manifest = join(packageRoot, "package.json");
  if (existsSync(manifest)) {
    output.push(...checkLegacyReferenceText("../package.json", readFileSync(manifest, "utf8")));
  }
  const legacyRoots = Object.freeze([
    "src",
    "host/src",
    "child-runtime",
    "extensions",
    "bin",
    "kernel/src",
    "drivers/src",
    "codegen/src",
    "modelcheck/src",
  ]);
  const extensions = new Set([".ts", ".js", ".mjs", ".cjs", ".rs"]);
  for (const legacyRoot of legacyRoots) {
    for (const file of collectFiles(join(packageRoot, legacyRoot), extensions)) {
      output.push(...checkLegacyReferenceText(
        `../${slash(relative(packageRoot, file))}`,
        readFileSync(file, "utf8"),
      ));
    }
  }
  return Object.freeze(output);
}

export function checkArchitecture(nextRoot: string): readonly ArchitectureFinding[] {
  const collected = collectActualUnits(nextRoot);
  return Object.freeze([
    ...collected.projectFindings,
    ...checkCompilerBaseline(nextRoot),
    ...checkArchitectureUnits(collected.units),
    ...checkLegacyPackageIsolation(nextRoot),
  ]);
}

export function formatArchitectureFinding(value: ArchitectureFinding): string {
  return `${value.rule} ${value.origin} ${value.path}:${String(value.line)} ${value.detail}`;
}

export function fixtureUnits(
  files: Readonly<{ readonly path: string; readonly text: string }[]>,
): readonly SourceUnit[] {
  const output: SourceUnit[] = [];
  for (const file of files) {
    output.push(parseUnit(file.path, file.text, "source"));
    const transpiled = ts.transpileModule(file.text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      fileName: file.path,
    });
    output.push(parseUnit(file.path.replace(/\.ts$/, ".js"), transpiled.outputText, "emitted"));
  }
  return Object.freeze(output);
}
