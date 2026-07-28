use drivers::allocation::{
    AllocationError, AllocationPolicy, AllocationSubmission, ApprovedUnit, BOUNDARY_ID, FutureUnit,
    accept_lane_proposal, validate_allocation,
};
use kernel::boundary::{BoundaryMode, Producer, boundary_by_id};
use kernel::generated::{AllocationLaneProposal, DeliveryBoundary, Id, TestId};

#[test]
fn allocator_boundary_is_a_registered_model_boundary() {
    let descriptor = boundary_by_id(BOUNDARY_ID).expect("allocation boundary registered");
    assert_eq!(descriptor.producer(), Producer::Model);
    // Mode is a lifecycle position, not an invariant: a Model boundary starts in Record
    // and is flipped one-way to Enforce once a real transcript exists (D79 4). Pinning
    // Record here would make the D79 4 flip fail this test, so assert the mode is one of
    // the two legal states and let boundary_coverage (A2) enforce the real rule -- that
    // an Enforce boundary has a recorded real-model transcript.
    assert!(matches!(
        descriptor.mode(),
        BoundaryMode::Record | BoundaryMode::Enforce
    ));
    let raw = serde_json::to_string(&lane("l1", &["u1"], 0)).expect("proposal json");
    assert_eq!(
        accept_lane_proposal(&raw)
            .expect("proposal accepted")
            .lane_id,
        id("l1")
    );
}

#[test]
fn valid_allocation_preserves_units_and_authority() {
    let units = units();
    let accepted = validate_allocation(&units, &submission(lanes()), policy()).expect("valid");
    assert_eq!(accepted.lanes.len(), 3);
    assert_eq!(accepted.lanes[0].proposal.lane_id, id("l1"));
}

#[test]
fn single_unit_allocation_preserves_boundary_contract() {
    let units = vec![unit("u1", 1, &[], &[], &[], &["edge-u1"])];
    let accepted = validate_allocation(
        &units,
        &submission_for(&units, vec![lane("l1", &["u1"], 0)]),
        policy(),
    )
    .expect("single unit valid");
    assert_eq!(accepted.lanes.len(), 1);
    assert_eq!(accepted.lanes[0].proposal.ordered_unit_ids, ids(&["u1"]));
}

#[test]
fn totality_requires_exact_assignment_or_future_reason() {
    let mut four_units = units();
    four_units.push(unit("u4", 4, &[], &[], &[], &["edge-u4"]));
    let mut partial = submission(lanes());
    partial.authority_echo = four_units.clone();
    assert_eq!(
        validate_allocation(&four_units, &partial, policy()).expect_err("missing rejected"),
        AllocationError::MissingUnit(id("u4"))
    );
    partial.future_units.push(FutureUnit {
        unit_id: id("u4"),
        reason: "blocked frontier".to_owned(),
    });
    assert!(validate_allocation(&four_units, &partial, policy()).is_ok());
    partial.future_units[0].reason.clear();
    assert_eq!(
        validate_allocation(&four_units, &partial, policy()).expect_err("blank future rejected"),
        AllocationError::FutureWithoutReason(id("u4"))
    );
}

#[test]
fn authority_and_predecessor_gates_cannot_change() {
    let units = units();
    let mut changed = submission(lanes());
    changed.authority_echo[1]
        .criteria
        .push(id("invented-criterion"));
    assert_eq!(
        validate_allocation(&units, &changed, policy()).expect_err("authority rejected"),
        AllocationError::AuthorityChanged(id("u2"))
    );

    let mut gate_changed = submission(lanes());
    gate_changed.lanes[1].predecessor_forward_criteria.clear();
    assert_eq!(
        validate_allocation(&units, &gate_changed, policy()).expect_err("gate rejected"),
        AllocationError::PredecessorGateChanged(id("l2"))
    );
}

#[test]
fn cycles_duplicates_concurrency_and_ownership_are_rejected_without_mutation() {
    let units = units();
    let mut duplicate = submission(vec![
        lane("l1", &["u1", "u2"], 0),
        lane("l2", &["u2"], 1),
        lane("l3", &["u3"], 2),
    ]);
    duplicate.lanes[0].predecessor_forward_criteria = vec![id("fg-u2")];
    assert_eq!(
        validate_allocation(&units, &duplicate, policy()).expect_err("duplicate rejected"),
        AllocationError::DuplicateUnit(id("u2"))
    );

    let reversed = submission(vec![
        lane("l1", &["u2", "u1"], 0),
        lane("l2", &["u3"], 1),
        lane("l3", &[], 2),
    ]);
    assert_eq!(
        validate_allocation(&units, &reversed, policy()).expect_err("cycle rejected"),
        AllocationError::UnitOrderCreatesCycle(id("u2"))
    );

    let mut ownership = submission(lanes());
    ownership
        .ownership_claims
        .push("src/lib.rs owned by l1".to_owned());
    assert_eq!(
        validate_allocation(&units, &ownership, policy()).expect_err("ownership rejected"),
        AllocationError::InventedOwnership("src/lib.rs owned by l1".to_owned())
    );
    assert_eq!(
        ownership.lanes.len(),
        3,
        "rejection did not mutate proposal"
    );
}

#[test]
fn cap_and_downstream_edges_are_preserved() {
    let units = units();
    assert_eq!(
        validate_allocation(
            &units,
            &submission(lanes()),
            AllocationPolicy {
                parallel_cap: 2,
                active_implementers: 0
            }
        )
        .expect_err("cap rejected"),
        AllocationError::ParallelCapExceeded
    );
    let mut changed = submission(lanes());
    changed.lanes[2]
        .downstream_release_edges
        .push(id("invented-edge"));
    assert_eq!(
        validate_allocation(&units, &changed, policy()).expect_err("edge rejected"),
        AllocationError::DownstreamEdgeChanged(id("l3"))
    );
}

fn submission(lanes: Vec<AllocationLaneProposal>) -> AllocationSubmission {
    submission_for(&units(), lanes)
}

fn submission_for(
    units: &[ApprovedUnit],
    lanes: Vec<AllocationLaneProposal>,
) -> AllocationSubmission {
    AllocationSubmission {
        lanes,
        future_units: Vec::new(),
        authority_echo: units.to_vec(),
        ownership_claims: Vec::new(),
        overlap_blocks: Vec::new(),
    }
}

fn units() -> Vec<ApprovedUnit> {
    vec![
        unit("u1", 1, &[], &[], &[], &["edge-u1"]),
        unit("u2", 2, &["u1"], &["d-u2"], &["fg-u2"], &["edge-u2"]),
        unit("u3", 3, &["u2"], &["d-u3"], &["fg-u3"], &["edge-u3"]),
    ]
}

fn unit(
    id_value: &str,
    order: u32,
    deps: &[&str],
    decisions: &[&str],
    gates: &[&str],
    edges: &[&str],
) -> ApprovedUnit {
    ApprovedUnit {
        id: id(id_value),
        operator_order: order,
        decisions: ids(decisions),
        criteria: vec![id(&format!("criterion-{id_value}"))],
        dependencies: ids(deps),
        predecessor_forward_criteria: ids(gates),
        downstream_release_edges: ids(edges),
    }
}

fn lanes() -> Vec<AllocationLaneProposal> {
    vec![
        lane("l1", &["u1"], 0),
        lane("l2", &["u2"], 1),
        lane("l3", &["u3"], 2),
    ]
}

fn lane(lane_id: &str, unit_ids: &[&str], wave: u32) -> AllocationLaneProposal {
    let mut gates = Vec::new();
    let mut edges = Vec::new();
    for unit_id in unit_ids {
        match *unit_id {
            "u1" => edges.push(id("edge-u1")),
            "u2" => {
                gates.push(id("fg-u2"));
                edges.push(id("edge-u2"));
            }
            "u3" => {
                gates.push(id("fg-u3"));
                edges.push(id("edge-u3"));
            }
            _ => {}
        }
    }
    AllocationLaneProposal {
        lane_id: id(lane_id),
        objective: format!("objective {lane_id}"),
        ordered_unit_ids: ids(unit_ids),
        rationale: "cohesive".to_owned(),
        delivery_boundary: DeliveryBoundary("terminal".to_owned()),
        predecessor_forward_criteria: gates,
        downstream_release_edges: edges,
        context_family_id: id("ctx"),
        context_estimate: 100,
        focused_tests: vec![TestId("test".to_owned())],
        launch_wave: wave,
        continue_existing_logical_lane: None,
    }
}

fn policy() -> AllocationPolicy {
    AllocationPolicy {
        parallel_cap: 8,
        active_implementers: 0,
    }
}

fn ids(values: &[&str]) -> Vec<Id> {
    values.iter().map(|value| id(value)).collect()
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}
