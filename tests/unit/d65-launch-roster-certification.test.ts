import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  D65_REQUIRED_ROSTER_GENERATION_SOURCE,
  D65_REQUIRED_ROSTER_QUALIFICATION_STATE,
  D65_REQUIRED_ROSTER_ROLES,
} from '../../src/core/coordination/d65-launch-roster.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { packagedCertifiedLaunchRoster } from '../helpers/d65-certified-roster.ts';

// D65-A6 roster-authority amendment regressions.
//
// The launch contract used to pin literal per-role model ids. That list was
// written before any roster was live-certified and was simultaneously:
//   - too strict: the operator's real W4-certified roster could NOT launch;
//   - too weak:  a non-certifying seed roster COULD launch.
// These regressions pin BOTH failure directions so neither can silently return.

void describe('D65 launch roster certification authority (D65-A6)', () => {
  void it('the packaged certified roster is W4-certified launch authority for every closed role', () => {
    const roster = packagedCertifiedLaunchRoster();
    assert.equal(roster.roster_id, 'cruise-codex-gpt55-heavy-subscription-51b6779e1472');
    assert.equal(roster.generation_source, D65_REQUIRED_ROSTER_GENERATION_SOURCE);
    assert.equal(roster.certification_manifest_id, 'codex-gpt55-heavy-sol-terra-w4-live-20260724');
    assert.match(String(roster.certification_manifest_sha256), /^sha256:[a-f0-9]{64}$/u);

    const roles = roster.assignments.map((assignment) => assignment.role).sort();
    assert.deepEqual(roles, [...D65_REQUIRED_ROSTER_ROLES].sort());
    for (const assignment of roster.assignments) {
      assert.equal(assignment.qualification_state, D65_REQUIRED_ROSTER_QUALIFICATION_STATE, assignment.role);
      assert.equal(assignment.provider_id, 'openai-codex', assignment.role);
      assert.equal(assignment.billing_route_class, 'subscription-oauth', assignment.role);
      assert.equal(assignment.auth_class, 'oauth', assignment.role);
    }
  });

  void it('regression (too strict): the certified roster assigns models the OLD hardcoded list rejected', () => {
    // The superseded list required sol@xhigh for validate/adjudicate,
    // terra@high for implement/fix, and luna@high for extract. The certified
    // roster diverges on exactly these five roles; the launch contract must
    // follow certification authority, not the obsolete literal list.
    const roster = packagedCertifiedLaunchRoster();
    const byRole = new Map<string, (typeof roster.assignments)[number]>(roster.assignments.map((assignment) => [String(assignment.role), assignment]));
    const supersededList: Record<string, readonly [string, string]> = {
      validate: ['gpt-5.6-sol', 'xhigh'],
      adjudicate: ['gpt-5.6-sol', 'xhigh'],
      implement: ['gpt-5.6-terra', 'high'],
      fix: ['gpt-5.6-terra', 'high'],
      extract: ['gpt-5.6-luna', 'high'],
    };
    let diverged = 0;
    for (const [role, [modelId, thinking]] of Object.entries(supersededList)) {
      const assignment = byRole.get(role);
      if (assignment === undefined) throw new Error(`certified roster is missing role ${role}`);
      if (assignment.model_id !== modelId || assignment.thinking !== thinking) diverged += 1;
      // Whatever the certified model is, it must still be certified authority.
      assert.equal(assignment.qualification_state, D65_REQUIRED_ROSTER_QUALIFICATION_STATE, role);
    }
    assert.equal(diverged, 5, 'the certified roster must diverge from the superseded hardcoded list on five roles');
  });

  void it('regression (too weak): every non-certifying seed roster is rejected as launch authority', () => {
    // Model-name equality is NOT certification. The old contract accepted
    // `cruise-codex-subscription-bdb4f15f0ff9` (a w0 seed with a null
    // certification pin) purely because its model names matched.
    const seed = SEED_ROSTERS.find((entry) => entry.roster_id === 'cruise-codex-subscription-bdb4f15f0ff9');
    if (seed === undefined) throw new Error('the historical seed roster must still exist');
    assert.equal(seed.generation_source, 'w0-non-certifying-seed');
    assert.equal(seed.certification_manifest_id, null);
    assert.notEqual(seed.generation_source, D65_REQUIRED_ROSTER_GENERATION_SOURCE);
    for (const assignment of seed.assignments) {
      assert.notEqual(assignment.qualification_state, D65_REQUIRED_ROSTER_QUALIFICATION_STATE, assignment.role);
    }
    // No packaged seed roster may ever be W4-certified launch authority.
    for (const roster of SEED_ROSTERS) {
      assert.notEqual(roster.generation_source, D65_REQUIRED_ROSTER_GENERATION_SOURCE, roster.roster_id);
      assert.equal(roster.certification_manifest_id, null, roster.roster_id);
    }
  });
});
