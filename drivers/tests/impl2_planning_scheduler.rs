use std::collections::BTreeSet;

use drivers::planning::{
    PlanningAcceptedRef, PlanningError, PlanningIssuedRef, PlanningLaunchAckRef, PlanningManifest,
    PlanningPolicy, PlanningRefs, PlanningTerminalFailureRef, PlanningWaveFailure,
    next_planning_wave, planning_policy,
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

fn manifest_from_kdl(workstream: &str, text: &str) -> PlanningManifest {
    let policy = PlanningPolicy::parse(text).expect("edited planning policy parses");
    PlanningManifest::from_policy(workstream, &policy).expect("manifest from edited policy")
}

fn accept_roles(manifest: &PlanningManifest, roles: &[&str]) -> PlanningRefs {
    let selected_roles = roles.iter().copied().collect::<BTreeSet<_>>();
    let mut issued = Vec::new();
    let mut launch_acks = BTreeSet::new();
    let mut accepted = BTreeSet::new();
    for (index, assignment) in manifest
        .assignments
        .iter()
        .filter(|assignment| selected_roles.contains(assignment.role.as_str()))
        .enumerate()
    {
        let action_id = format!("accepted-action-{index}");
        issued.push(PlanningIssuedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: action_id.clone(),
            run_revision: 1,
        });
        launch_acks.insert(PlanningLaunchAckRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: action_id.clone(),
            run_revision: 1,
            task_id: format!("task-{index}"),
        });
        accepted.insert(PlanningAcceptedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id,
            run_revision: 1,
        });
    }
    PlanningRefs {
        issued,
        launch_acks,
        accepted,
        terminal_failures: BTreeSet::new(),
        activation_refs: BTreeSet::new(),
    }
}

fn move_line_before(text: &str, moving: &str, before: &str) -> String {
    assert_eq!(
        text.match_indices(moving).count(),
        1,
        "planning KDL must contain exactly one moving line"
    );
    assert_eq!(
        text.match_indices(before).count(),
        1,
        "planning KDL must contain exactly one target line"
    );
    let without_moving = text.replace(moving, "");
    without_moving.replace(before, &format!("{moving}{before}"))
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

    let issued = p1
        .iter()
        .take(4)
        .enumerate()
        .map(|(index, assignment)| PlanningIssuedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: format!("action-{index}"),
            run_revision: 1,
        })
        .collect::<Vec<_>>();
    let refs = PlanningRefs {
        issued: issued.clone(),
        launch_acks: issued
            .iter()
            .map(|issued| PlanningLaunchAckRef {
                assignment_id: issued.assignment_id.clone(),
                action_id: issued.action_id.clone(),
                run_revision: issued.run_revision,
                task_id: format!("task-{}", issued.action_id),
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

    let next = next_planning_wave(&manifest, &refs, 64).expect("P1 top-up remains schedulable");
    assert_eq!(
        next.len(),
        3,
        "cap headroom must top up only unfinished P1 members"
    );
    assert_eq!(next[0].assignment_id, p1[4].assignment_id);
    assert_eq!(next[1].assignment_id, p1[5].assignment_id);
    assert_eq!(next[2].assignment_id, p1[6].assignment_id);
    assert!(
        next.iter()
            .all(|assignment| assignment.role == "task-extractor")
    );
    assert!(
        next.iter()
            .all(|assignment| assignment.role != "repository-scout")
    );
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
        issued: issued.clone(),
        launch_acks: issued
            .iter()
            .map(|issued| PlanningLaunchAckRef {
                assignment_id: issued.assignment_id.clone(),
                action_id: issued.action_id.clone(),
                run_revision: issued.run_revision,
                task_id: format!("task-{}", issued.action_id),
            })
            .collect(),
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
                assert!(
                    blocked
                        .completed_assignments
                        .contains(&accepted.assignment_id)
                );
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
            .find(|wave| wave.id == "P2.scout")
            .expect("scout wave declared in data")
            .dependencies,
        vec!["P1.extract".to_owned()]
    );
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
fn scout_wave_blocked_until_every_p1_member_accepted() {
    let scout_line =
        "planning_wave \"P2.scout\" role=\"repository-scout\" depends=\"P1.extract\"\n";
    let extract_line = "planning_wave \"P1.extract\" role=\"task-extractor\"\n";
    let reordered_kdl = move_line_before(
        include_str!("../../data/planning.kdl"),
        scout_line,
        extract_line,
    );
    let manifest = manifest_from_kdl("scheduler-scout-deps", &reordered_kdl);
    let next = next_planning_wave(&manifest, &PlanningRefs::default(), 64)
        .expect("dependency-blocked scout leaves P1 schedulable");

    assert_eq!(next.len(), 7);
    assert!(
        next.iter()
            .all(|assignment| assignment.role == "task-extractor")
    );
}

#[test]
fn compile_wave_requires_all_three_declared_dependencies() {
    let compile_line = "planning_wave \"P4.compile\" role=\"plan-compiler\" depends=\"P1.extract,P2.curate,P3.resolve\"\n";
    let resolve_line = "planning_wave \"P3.resolve\" role=\"contradiction-resolver\" depends=\"P2.curate\" activation_ref=\"planning-resolution-required\"\n";
    let reordered_kdl = move_line_before(
        include_str!("../../data/planning.kdl"),
        compile_line,
        resolve_line,
    );
    let manifest = manifest_from_kdl("scheduler-compile-deps", &reordered_kdl);

    let mut two_dependency_refs = accept_roles(
        &manifest,
        &["task-extractor", "repository-scout", "context-curator"],
    );
    two_dependency_refs
        .activation_refs
        .insert("planning-resolution-required".to_owned());
    let blocked_by_active_resolution = next_planning_wave(&manifest, &two_dependency_refs, 64)
        .expect("active P3 dependency blocks compile and schedules resolution");
    assert_eq!(blocked_by_active_resolution.len(), 3);
    assert!(
        blocked_by_active_resolution
            .iter()
            .all(|assignment| assignment.role == "contradiction-resolver")
    );

    let inactive_resolution_refs = accept_roles(
        &manifest,
        &["task-extractor", "repository-scout", "context-curator"],
    );
    let compile_after_inactive_resolution =
        next_planning_wave(&manifest, &inactive_resolution_refs, 64)
            .expect("inactive P3 dependency is complete for compile");
    assert_eq!(compile_after_inactive_resolution.len(), 5);
    assert!(
        compile_after_inactive_resolution
            .iter()
            .all(|assignment| assignment.role == "plan-compiler")
    );

    let mut all_dependency_refs = accept_roles(
        &manifest,
        &[
            "task-extractor",
            "repository-scout",
            "context-curator",
            "contradiction-resolver",
        ],
    );
    all_dependency_refs
        .activation_refs
        .insert("planning-resolution-required".to_owned());
    let compile_after_all_dependencies = next_planning_wave(&manifest, &all_dependency_refs, 64)
        .expect("all compile dependencies satisfied");
    assert_eq!(compile_after_all_dependencies.len(), 5);
    assert!(
        compile_after_all_dependencies
            .iter()
            .all(|assignment| assignment.role == "plan-compiler")
    );
}

#[test]
fn unknown_or_cyclic_wave_dependency_is_rejected_at_parse() {
    let base = include_str!("../../data/planning.kdl");
    let unknown_dependency = base.replace(
        "planning_wave \"P2.scout\" role=\"repository-scout\" depends=\"P1.extract\"",
        "planning_wave \"P2.scout\" role=\"repository-scout\" depends=\"P1.missing\"",
    );
    assert_eq!(
        PlanningPolicy::parse(&unknown_dependency),
        Err(PlanningError::BadDeclaration(
            "wave P2.scout references unknown dependency P1.missing".to_owned()
        ))
    );

    let self_dependency = base.replace(
        "planning_wave \"P2.scout\" role=\"repository-scout\" depends=\"P1.extract\"",
        "planning_wave \"P2.scout\" role=\"repository-scout\" depends=\"P2.scout\"",
    );
    assert_eq!(
        PlanningPolicy::parse(&self_dependency),
        Err(PlanningError::BadDeclaration(
            "wave P2.scout depends on itself".to_owned()
        ))
    );

    let cycle = base.replace(
        "planning_wave \"P1.extract\" role=\"task-extractor\"",
        "planning_wave \"P1.extract\" role=\"task-extractor\" depends=\"P2.scout\"",
    );
    assert_eq!(
        PlanningPolicy::parse(&cycle),
        Err(PlanningError::BadDeclaration(
            "planning_wave dependency cycle: P1.extract -> P2.scout -> P1.extract".to_owned()
        ))
    );
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
        launch_acks: BTreeSet::new(),
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
    assert!(
        before_restart
            .iter()
            .all(|assignment| assignment.assignment_id != p1[0].assignment_id)
    );
}
