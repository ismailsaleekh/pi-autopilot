use drivers::finalize::{
    finalization_data_covers_gate, verify_final_gate, BughunterTriggers, FinalCondition,
    FinalGateInput, RiskLevel, TipEvidence,
};

#[test]
fn finalization_data_declares_each_gate_condition() {
    assert!(finalization_data_covers_gate());
}

#[test]
fn gate_refuses_when_any_single_required_condition_is_unmet() {
    for (condition, make_bad) in [
        (FinalCondition::UnitsClosed, unset_units as fn(&mut FinalGateInput)),
        (FinalCondition::MandatoryFindings, unset_findings),
        (FinalCondition::RequiredProofFresh, unset_proof),
        (FinalCondition::JobsTerminal, unset_jobs),
        (FinalCondition::AttributableDiff, unset_diff),
        (FinalCondition::FinalCommands, unset_commands),
        (FinalCondition::FullSuite, unset_suite),
        (FinalCondition::FinalValidator, unset_validator),
        (FinalCondition::RequiredBughunter, unset_bughunter),
    ] {
        let mut input = passing_input();
        make_bad(&mut input);
        assert_eq!(
            verify_final_gate(&input),
            Err(condition),
            "gate must refuse when only {} is unmet",
            condition.id()
        );
    }
}

#[test]
fn evidence_from_an_earlier_tip_does_not_satisfy_a_changed_final_tip() {
    let mut input = passing_input();
    input.final_tip = "tip-b".to_owned();
    assert_eq!(
        verify_final_gate(&input),
        Err(FinalCondition::FinalCommands),
        "evidence gathered at commit A is rejected after a tip-changing fix to commit B"
    );

    input.final_commands = evidence("tip-b");
    assert_eq!(verify_final_gate(&input), Err(FinalCondition::FullSuite));
    input.full_suite = evidence("tip-b");
    assert_eq!(verify_final_gate(&input), Err(FinalCondition::FinalValidator));
    input.final_validator = evidence("tip-b");
    assert_eq!(verify_final_gate(&input), Err(FinalCondition::RequiredBughunter));
}

#[test]
fn bughunter_is_required_for_each_mandatory_trigger() {
    for triggers in [
        BughunterTriggers { implementation_lanes: 2, ..low_single_lane() },
        BughunterTriggers { risk: RiskLevel::High, ..low_single_lane() },
        BughunterTriggers { protected_security_data_or_migration: true, ..low_single_lane() },
        BughunterTriggers { semantic_conflict_resolution: true, ..low_single_lane() },
        BughunterTriggers { operator_required: true, ..low_single_lane() },
    ] {
        let mut input = passing_input();
        input.triggers = triggers;
        input.bughunter = None;
        assert_eq!(verify_final_gate(&input), Err(FinalCondition::RequiredBughunter));
    }

    let mut optional = passing_input();
    optional.triggers = low_single_lane();
    optional.bughunter = None;
    assert!(verify_final_gate(&optional).is_ok());
}

fn passing_input() -> FinalGateInput {
    FinalGateInput {
        final_tip: "tip-a".to_owned(),
        every_unit_closed: true,
        no_mandatory_findings: true,
        no_stale_required_proof: true,
        no_active_or_unknown_jobs: true,
        attributable_integrated_diff: true,
        final_commands: evidence("tip-a"),
        full_suite: evidence("tip-a"),
        final_validator: evidence("tip-a"),
        bughunter: Some(evidence("tip-a")),
        triggers: BughunterTriggers { implementation_lanes: 2, ..low_single_lane() },
    }
}

fn low_single_lane() -> BughunterTriggers {
    BughunterTriggers {
        implementation_lanes: 1,
        risk: RiskLevel::Low,
        protected_security_data_or_migration: false,
        semantic_conflict_resolution: false,
        operator_required: false,
    }
}

fn evidence(tip: &str) -> TipEvidence {
    TipEvidence { tip: tip.to_owned(), passed: true }
}

fn unset_units(input: &mut FinalGateInput) { input.every_unit_closed = false; }
fn unset_findings(input: &mut FinalGateInput) { input.no_mandatory_findings = false; }
fn unset_proof(input: &mut FinalGateInput) { input.no_stale_required_proof = false; }
fn unset_jobs(input: &mut FinalGateInput) { input.no_active_or_unknown_jobs = false; }
fn unset_diff(input: &mut FinalGateInput) { input.attributable_integrated_diff = false; }
fn unset_commands(input: &mut FinalGateInput) { input.final_commands.passed = false; }
fn unset_suite(input: &mut FinalGateInput) { input.full_suite.passed = false; }
fn unset_validator(input: &mut FinalGateInput) { input.final_validator.passed = false; }
fn unset_bughunter(input: &mut FinalGateInput) { input.bughunter = None; }
