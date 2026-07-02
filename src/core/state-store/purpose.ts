import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  parseAutopilotDecisionRow,
  parseAutopilotMasterPlan,
} from '../contracts/index.ts';
import type { AutopilotDecisionRow, AutopilotMasterPlan } from '../contracts/types.ts';

const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export class AutopilotPurposeStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AutopilotPurposeStoreError';
    this.code = code;
  }
}

export interface AutopilotMissionDocument {
  readonly path: string;
  readonly text: string;
  readonly sections: readonly string[];
}

export interface AutopilotPurposeSnapshot {
  readonly mission: AutopilotMissionDocument | null;
  readonly masterPlan: AutopilotMasterPlan | null;
  readonly decisionsTail: readonly AutopilotDecisionRow[];
}

const REQUIRED_MISSION_SECTIONS = [
  'Goal',
  'Non-goals / exclusions',
  'Perfect-quality bar',
  'Definition of done',
  'Key constraints',
  'Current strategy summary',
  'Open questions',
] as const;

export async function readAutopilotPurposeSnapshot(input: {
  readonly root: string;
  readonly decisionTailLimit?: number;
  readonly requirePurpose?: boolean;
}): Promise<AutopilotPurposeSnapshot> {
  assertAbsoluteRoot(input.root);
  const decisionTailLimit = input.decisionTailLimit ?? 50;
  if (!Number.isInteger(decisionTailLimit) || decisionTailLimit < 0 || decisionTailLimit > 10_000) {
    throw new AutopilotPurposeStoreError(
      'invalid-decision-tail-limit',
      `decisionTailLimit must be an integer in [0, 10000], got ${String(decisionTailLimit)}`,
    );
  }

  const missionPath = join(input.root, 'mission.md');
  const masterPlanPath = join(input.root, 'master-plan.json');
  const decisionLogPath = join(input.root, 'decision-log.jsonl');

  const mission = await readAutopilotMissionIfPresent(missionPath);
  const masterPlan = await readAutopilotMasterPlanIfPresent(masterPlanPath);
  const decisions = await readAutopilotDecisionsIfPresent(decisionLogPath);

  if (input.requirePurpose === true) {
    if (mission === null) throw new AutopilotPurposeStoreError('missing-mission', `missing mission.md at ${missionPath}`);
    if (masterPlan === null) {
      throw new AutopilotPurposeStoreError('missing-master-plan', `missing master-plan.json at ${masterPlanPath}`);
    }
  }

  if (mission !== null && masterPlan !== null) {
    const missionRef = resolveRef(input.root, masterPlan.mission_ref, 'master_plan.mission_ref');
    if (missionRef !== mission.path) {
      throw new AutopilotPurposeStoreError(
        'purpose-ref-mismatch',
        `master-plan mission_ref ${masterPlan.mission_ref} does not resolve to mission.md`,
      );
    }
  }

  for (const decision of decisions) {
    if (decision.master_plan_ref !== undefined) {
      resolveRef(input.root, decision.master_plan_ref, 'decision.master_plan_ref');
    }
    if (masterPlan !== null && decision.workstream !== masterPlan.workstream) {
      throw new AutopilotPurposeStoreError(
        'decision-workstream-mismatch',
        `decision ${String(decision.id)} workstream ${decision.workstream} does not match master-plan workstream ${masterPlan.workstream}`,
      );
    }
  }

  const newestDecision = decisions.length === 0 ? undefined : decisions[decisions.length - 1];
  if (masterPlan !== null) {
    const newestDecisionId = newestDecision?.id ?? 0;
    if (masterPlan.last_decision_id !== newestDecisionId) {
      throw new AutopilotPurposeStoreError(
        'master-plan-decision-id-mismatch',
        `master-plan last_decision_id ${String(masterPlan.last_decision_id)} does not match decision log tail ${String(newestDecisionId)}`,
      );
    }
  }

  const tail = decisionTailLimit === 0 ? [] : decisions.slice(-decisionTailLimit);
  const frozenTail = Object.freeze(tail);
  return Object.freeze({
    mission,
    masterPlan,
    decisionsTail: frozenTail,
  });
}

export async function readAutopilotMissionIfPresent(path: string): Promise<AutopilotMissionDocument | null> {
  if (!existsSync(path)) return null;
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new AutopilotPurposeStoreError('invalid-mission', `mission.md is not a file at ${path}`);
  }
  const text = await readFile(path, 'utf8');
  const sections = extractMissionSections(text);
  const missing = REQUIRED_MISSION_SECTIONS.filter((section) => !sections.includes(section));
  if (missing.length > 0) {
    throw new AutopilotPurposeStoreError(
      'invalid-mission',
      `mission.md missing required section(s): ${missing.join(', ')}`,
    );
  }
  const frozenSections = Object.freeze(sections);
  return Object.freeze({ path, text, sections: frozenSections });
}

export async function readAutopilotMasterPlanIfPresent(path: string): Promise<AutopilotMasterPlan | null> {
  if (!existsSync(path)) return null;
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new AutopilotPurposeStoreError('invalid-master-plan', `master-plan.json is not a file at ${path}`);
  }
  return parseAutopilotMasterPlan(await readJsonObject(path, 'master-plan.json'));
}

export async function writeAutopilotMasterPlanAtomic(input: {
  readonly masterPlanPath: string;
  readonly masterPlan: AutopilotMasterPlan;
}): Promise<void> {
  const masterPlan = parseAutopilotMasterPlan(input.masterPlan);
  await writeJsonAtomic(input.masterPlanPath, masterPlan);
}

export async function appendAutopilotDecisionRow(input: {
  readonly decisionLogPath: string;
  readonly decision: AutopilotDecisionRow;
}): Promise<void> {
  const decision = parseAutopilotDecisionRow(input.decision);
  const existing = await readAutopilotDecisionsIfPresent(input.decisionLogPath);
  const previous = existing.length === 0 ? undefined : existing[existing.length - 1];
  const expectedId = previous === undefined ? 1 : previous.id + 1;
  if (decision.id !== expectedId) {
    throw new AutopilotPurposeStoreError(
      'decision-id-not-monotonic',
      `decision id ${String(decision.id)} must equal next monotonic id ${String(expectedId)}`,
    );
  }
  await mkdir(dirname(input.decisionLogPath), { recursive: true });
  await appendFile(input.decisionLogPath, `${JSON.stringify(decision)}\n`, { encoding: 'utf8' });
}

export async function readAutopilotDecisionsIfPresent(
  decisionLogPath: string,
): Promise<readonly AutopilotDecisionRow[]> {
  if (!existsSync(decisionLogPath)) return Object.freeze([]);
  const content = await readFile(decisionLogPath, 'utf8');
  if (content.trim().length === 0) return Object.freeze([]);
  const decisions: AutopilotDecisionRow[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonValue(line);
    } catch (error) {
      throw new AutopilotPurposeStoreError(
        'corrupt-decision-jsonl',
        `decision-log.jsonl line ${String(index + 1)} is not valid JSON: ${errorMessage(error)}`,
      );
    }
    const decision = parseAutopilotDecisionRow(parsed);
    const previous = decisions.length === 0 ? undefined : decisions[decisions.length - 1];
    const expectedId = previous === undefined ? 1 : previous.id + 1;
    if (decision.id !== expectedId) {
      throw new AutopilotPurposeStoreError(
        'corrupt-decision-jsonl',
        `decision-log.jsonl line ${String(index + 1)} id ${String(decision.id)} must equal ${String(expectedId)}`,
      );
    }
    decisions.push(decision);
  }
  return Object.freeze(decisions);
}

function extractMissionSections(text: string): readonly string[] {
  const sections: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^##\s+(.+)\s*$/u.exec(line);
    const section = match?.[1]?.trim();
    if (section !== undefined && section.length > 0) sections.push(section);
  }
  return Object.freeze([...new Set(sections)]);
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseJsonValue(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AutopilotPurposeStoreError(
      'corrupt-json-reference',
      `${label} is not valid JSON at ${path}: ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AutopilotPurposeStoreError('corrupt-json-reference', `${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${String(Date.now())}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function resolveRef(root: string, ref: string, label: string): string {
  const resolved = resolve(root, ref);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new AutopilotPurposeStoreError('reference-escape', `${label} ${ref} escapes purpose root`);
  }
  return resolved;
}

function assertAbsoluteRoot(root: string): void {
  if (!isAbsolute(root)) {
    throw new AutopilotPurposeStoreError('invalid-purpose-root', `purpose root must be absolute: ${root}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
