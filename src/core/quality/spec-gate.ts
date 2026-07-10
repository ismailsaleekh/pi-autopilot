import type {
  AutopilotQualityProfile,
  AutopilotRole,
  AutopilotUnitSpec,
  AutopilotVerificationPlan,
  AutopilotWitnessSpec,
} from '../contracts/types.ts';
import { autopilotModelRosterIssues } from '../model-roster.ts';

export class AutopilotSpecQualityGateError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Autopilot unit spec failed quality gate: ${issues.join('; ')}`);
    this.name = 'AutopilotSpecQualityGateError';
    this.issues = issues;
  }
}

const SOURCE_CHANGE_PROFILES: readonly AutopilotQualityProfile[] = [
  'source-change',
  'test-change',
  'docs-change',
  'config-change',
  'package-change',
] as const;

const REQUIRED_PURPOSE_CONTEXT_REFS = ['mission.md', 'master-plan.json'] as const;

export function assertAutopilotSpecQualityGate(spec: AutopilotUnitSpec): void {
  const issues = autopilotSpecQualityGateIssues(spec);
  if (issues.length > 0) throw new AutopilotSpecQualityGateError(issues);
}

export function autopilotSpecQualityGateIssues(spec: AutopilotUnitSpec): readonly string[] {
  const issues: string[] = [];
  const profile = spec.quality_profile;
  const riskLevel = spec.risk_level;
  const acceptanceCriteria = spec.acceptance_criteria;
  const verificationPlan = spec.verification_plan;
  const closureCriteria = spec.closure_criteria;

  issues.push(...autopilotModelRosterIssues(spec));

  if (profile === undefined) issues.push('quality_profile is required before child launch');
  if (riskLevel === undefined) issues.push('risk_level is required before child launch');
  if (acceptanceCriteria === undefined || acceptanceCriteria.length === 0) {
    issues.push('acceptance_criteria must contain at least one criterion before child launch');
  }
  if (verificationPlan === undefined) {
    issues.push('verification_plan is required before child launch');
  }
  if (closureCriteria === undefined || closureCriteria.length === 0) {
    issues.push('closure_criteria must contain at least one criterion before child launch');
  }

  if (profile !== undefined) issues.push(...roleProfileIssues(spec.role, profile));

  if (verificationPlan !== undefined) {
    issues.push(...verificationPlanGateIssues(spec, verificationPlan));
  }

  if (spec.role !== 'strategy') {
    for (const requiredRef of REQUIRED_PURPOSE_CONTEXT_REFS) {
      if (!hasContextRefEnding(spec, requiredRef)) {
        issues.push(`non-strategy specs must include ${requiredRef} in context_refs`);
      }
    }
  }

  if (profile !== undefined && isSourceChangeProfile(profile)) {
    if (verificationPlan !== undefined && requiredWitnesses(verificationPlan).length === 0) {
      issues.push('source-changing specs require at least one required verification witness');
    }
  }

  if (
    (spec.role === 'validate' || spec.role === 'bughunt') &&
    verificationPlan !== undefined &&
    requiredWitnesses(verificationPlan).length === 0
  ) {
    issues.push(`${spec.role} specs require at least one required witness expectation`);
  }

  if (riskLevel === 'high' || riskLevel === 'critical') {
    if (verificationPlan !== undefined && !hasRealBoundaryProofOrBlocker(verificationPlan)) {
      issues.push(`${riskLevel} risk specs require a real-boundary witness or explicit blocker rationale`);
    }
  }

  if (
    (spec.role === 'validate' || spec.role === 'bughunt' || spec.role === 'adjudicate') &&
    spec.thinking !== 'xhigh' &&
    riskLevel !== 'low'
  ) {
    issues.push(`${spec.role} specs require xhigh thinking unless risk_level is low`);
  }

  return Object.freeze(issues);
}

function roleProfileIssues(role: AutopilotRole, profile: AutopilotQualityProfile): readonly string[] {
  if (role === 'strategy') return profile === 'strategy' ? [] : ['strategy role requires quality_profile strategy'];
  if (role === 'validate' || role === 'bughunt') {
    return profile === 'validation-only'
      ? []
      : [`${role} role requires quality_profile validation-only`];
  }
  if (role === 'adjudicate') {
    return profile === 'adjudication' ? [] : ['adjudicate role requires quality_profile adjudication'];
  }
  if (role === 'extract') return profile === 'extract' ? [] : ['extract role requires quality_profile extract'];
  if (role === 'implement' || role === 'fix') {
    return isSourceChangeProfile(profile)
      ? []
      : [`${role} role requires a source/test/docs/config/package change quality_profile`];
  }
  const exhaustive: never = role;
  return [`unsupported role ${exhaustive}`];
}

function verificationPlanGateIssues(
  spec: AutopilotUnitSpec,
  plan: AutopilotVerificationPlan,
): readonly string[] {
  const issues: string[] = [];
  const witnesses = allWitnesses(plan);
  const declaredCommands = new Set(spec.validation_commands);
  for (const command of declaredCommands) {
    if (!witnesses.some((witness) => witness.command === command)) {
      issues.push(`validation command ${JSON.stringify(command)} must have a verification witness`);
    }
  }
  return issues;
}

function hasContextRefEnding(spec: AutopilotUnitSpec, suffix: string): boolean {
  return spec.context_refs.some((ref) => ref.path === suffix || ref.path.endsWith(`/${suffix}`));
}

function isSourceChangeProfile(profile: AutopilotQualityProfile): boolean {
  return SOURCE_CHANGE_PROFILES.includes(profile);
}

function hasRealBoundaryProofOrBlocker(plan: AutopilotVerificationPlan): boolean {
  return plan.real_boundary_witnesses.some(
    (witness) => witness.required || witness.blocker_reason !== undefined,
  );
}

function requiredWitnesses(plan: AutopilotVerificationPlan): readonly AutopilotWitnessSpec[] {
  return allWitnesses(plan).filter((witness) => witness.required);
}

function allWitnesses(plan: AutopilotVerificationPlan): readonly AutopilotWitnessSpec[] {
  return Object.freeze([
    ...plan.positive_witnesses,
    ...plan.negative_witnesses,
    ...plan.regression_witnesses,
    ...plan.real_boundary_witnesses,
    ...plan.blast_radius_checks,
    ...plan.docs_schema_prompt_checks,
    ...plan.dirty_tree_checks,
  ]);
}
