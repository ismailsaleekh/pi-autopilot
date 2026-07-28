use std::collections::BTreeSet;

use drivers::planning::{
    next_planning_wave, planning_policy, PlanningAcceptedRef, PlanningIssuedRef, PlanningManifest,
    PlanningRefs, PlanningTerminalFailureRef, PlanningWaveFailure,
};

fn manifest(workstream: &str) -> PlanningManifest {
    let policy = planning_policy().expect("planning policy parses from data/planning.kdl");
    PlanningManifest::from_policy(workstream, &policy).expect("manifest from planning policy")
}

fn by_role<'a>(
    manifest: &'a PlanningManifest,
    role: &str,
) -> Vec<&'a drivers::planning::PlanningAgentAssignment> {
    manifest
        .assignments
        .iter()
        .filter(|assignment| assignment.role == role)
        .collect()
}

#[test]
fn planning_scheduler_respects_role_barrier_and_partial_topup() {
    let manifest = manifest("scheduler-topup");
    let p1 = by_role(&manifest, "task-extractor");
    assert_eq!(
        p1.len(),
        7,
        "fixture must exercise the seven-member P1 wave"
    );

    let refs = PlanningRefs {
        issued: p1
            .iter()
            .take(4)
            .enumerate()
            .map(|(index, assignment)| PlanningIssuedRef {
                assignment_id: assignment.assignment_id.clone(),
                action_id: format!("action-{index}"),
                run_revision: 1,
            })
            .collect(),
        accepted: BTreeSet::from([PlanningAcceptedRef {
            assignment_id: p1[0].assignment_id.clone(),
            action_id: "action-0".to_owned(),
            run_revision: 1,
        }]),
        terminal_failures: BTreeSet::new(),
        activation_refs: BTreeSet::new(),
    };

    let next = next_planning_wave(&manifest, &refs, 4).expect("P1 top-up remains schedulable");
    assert_eq!(
        next.len(),
        1,
        "one accepted P1 member frees exactly one cap slot"
    );
    assert_eq!(next[0].assignment_id, p1[4].assignment_id);
    assert_eq!(next[0].role, "task-extractor");
    assert!(next
        .iter()
        .all(|assignment| assignment.role != "repository-scout"));
}

#[test]
fn planning_failed_member_pauses_without_erasing_siblings() {
    let manifest = manifest("scheduler-blocked");
    let p1 = by_role(&manifest, "task-extractor");
    let issued = p1
        .iter()
        .enumerate()
        .map(|(index, assignment)| PlanningIssuedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: format!("action-{index}"),
            run_revision: 1,
        })
        .collect::<Vec<_>>();
    let accepted = issued
        .iter()
        .take(6)
        .map(|issued| PlanningAcceptedRef {
            assignment_id: issued.assignment_id.clone(),
            action_id: issued.action_id.clone(),
            run_revision: issued.run_revision,
        })
        .collect();
    let terminal_failures = BTreeSet::from([PlanningTerminalFailureRef {
        assignment_id: issued[6].assignment_id.clone(),
        action_id: issued[6].action_id.clone(),
        run_revision: issued[6].run_revision,
        status: "failed".to_owned(),
    }]);
    let refs = PlanningRefs {
        issued,
        accepted,
        terminal_failures,
        activation_refs: BTreeSet::new(),
    };

    let err = next_planning_wave(&manifest, &refs, manifest.planning_wave_cap)
        .expect_err("failed P1 member blocks the wave loudly");
    match err {
        PlanningWaveFailure::Blocked(blocked) => {
            assert_eq!(blocked.wave_id, "P1.extract");
            assert_eq!(
                blocked.failed_assignments,
                vec![p1[6].assignment_id.clone()]
            );
            assert_eq!(blocked.attempts.get(&p1[6].assignment_id).copied(), Some(1));
            assert_eq!(blocked.completed_assignments.len(), 6);
            for accepted in p1.iter().take(6) {
                assert!(blocked
                    .completed_assignments
                    .contains(&accepted.assignment_id));
            }
        }
    }
}

#[test]
fn planning_compiler_count_and_wave_graph_are_data_defined() {
    let policy = planning_policy().expect("planning policy parses");
    let manifest =
        PlanningManifest::from_policy("scheduler-data", &policy).expect("manifest from policy");
    assert_eq!(by_role(&manifest, "plan-compiler").len(), 5);
    assert_eq!(manifest.planning_wave_cap, 7);
    assert_eq!(
        manifest
            .waves
            .iter()
            .find(|wave| wave.id == "P4.compile")
            .expect("compile wave declared in data")
            .dependencies,
        vec![
            "P1.extract".to_owned(),
            "P2.curate".to_owned(),
            "P3.resolve".to_owned()
        ]
    );

    let four_compiler_kdl = include_str!("../../data/planning.kdl").replace(
        "assignment_role \"plan-compiler\" count=5",
        "assignment_role \"plan-compiler\" count=4",
    );
    let edited_policy = drivers::planning::PlanningPolicy::parse(&four_compiler_kdl)
        .expect("edited data policy parses");
    let edited_manifest = PlanningManifest::from_policy("scheduler-data-edited", &edited_policy)
        .expect("edited manifest from policy");
    assert_eq!(by_role(&edited_manifest, "plan-compiler").len(), 4);
}

#[test]
fn planning_resume_recomputes_identical_wave_from_event_refs() {
    let manifest = manifest("scheduler-resume");
    let p1 = by_role(&manifest, "task-extractor");
    let refs = PlanningRefs {
        issued: vec![PlanningIssuedRef {
            assignment_id: p1[0].assignment_id.clone(),
            action_id: "action-accepted".to_owned(),
            run_revision: 1,
        }],
        accepted: BTreeSet::from([PlanningAcceptedRef {
            assignment_id: p1[0].assignment_id.clone(),
            action_id: "action-accepted".to_owned(),
            run_revision: 1,
        }]),
        terminal_failures: BTreeSet::new(),
        activation_refs: BTreeSet::new(),
    };

    let before_restart = next_planning_wave(&manifest, &refs, 4).expect("wave before restart");
    let after_restart_refs = refs.clone();
    let after_restart =
        next_planning_wave(&manifest, &after_restart_refs, 4).expect("wave after restart");
    assert_eq!(before_restart, after_restart);
    assert_eq!(
        before_restart
            .iter()
            .map(|assignment| assignment.assignment_id.clone())
            .collect::<Vec<_>>(),
        p1.iter()
            .skip(1)
            .take(4)
            .map(|assignment| assignment.assignment_id.clone())
            .collect::<Vec<_>>()
    );
    assert!(before_restart
        .iter()
        .all(|assignment| assignment.assignment_id != p1[0].assignment_id));
}
