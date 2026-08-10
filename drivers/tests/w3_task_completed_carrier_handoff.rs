use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, EventKind, EventRow, Id, ModeId, Ref, SeamEnvelope};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn receipt_v1_planning_accepts_then_consumes_without_carrier_or_spec_rereads() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-handoff");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let mut state = CoreState::open(None).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&task_atoms("TE01-A")).unwrap();
    let submit = json!({"v":1,"id":6,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
        "schema":"autopilot.child_control_request.v1","request_id":"request-1",
        "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
        "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
        "tool_call_id":"tool-call-1","kind":"submit",
        "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
        "raw_payload":raw,
        "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
    }}});
    let accepted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(accepted.kind, "child-control", "{accepted:?}");
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    let receipt = accepted.payload["response"]["receipt"]["receipt"].clone();

    // Exact replay returns the original receipt and appends no second accepted
    // root. A changed raw payload is rejected before it can create artifacts.
    let mut replay_submit = submit.clone();
    replay_submit["payload"]["request"]["request_id"] = json!("request-2");
    replay_submit["payload"]["request"]["tool_call_id"] = json!("tool-call-2");
    let replay = seam::handle_line(&replay_submit.to_string(), &mut state).unwrap();
    assert_eq!(replay.payload["response"]["outcome"], "ACCEPT");
    assert_eq!(replay.payload["response"]["request_id"], "request-2");
    assert_eq!(replay.payload["response"]["receipt"]["receipt"], receipt);
    assert_eq!(
        replay.payload["response"]["receipt"]["receipt"]["tool_call_id"],
        "tool-call-1"
    );
    let mut conflict = submit.clone();
    conflict["payload"]["request"]["raw_payload"] =
        serde_json::from_str(&task_atoms("TE01-B")).unwrap();
    let retry = seam::handle_line(&conflict.to_string(), &mut state).unwrap();
    assert_eq!(retry.payload["response"]["outcome"], "RETRY");

    fs::remove_file(&issue.binding.spec_path).unwrap();
    let replay_without_spec = seam::handle_line(&replay_submit.to_string(), &mut state).unwrap();
    assert_eq!(replay_without_spec.payload["response"]["outcome"], "ACCEPT");
    fs::remove_file(&issue.binding.carrier_path).unwrap();
    let frame = json!({"v":1,"id":7,"kind":"task-completed","payload":{"task_id":"task-terminal","action_id":issue.receipt_binding.action_id,"assignment_id":issue.receipt_binding.assignment_id,"status":"completed"}});
    let completed = seam::handle_line(&frame.to_string(), &mut state).unwrap();
    assert_spawn_assignment(&completed, "planning-ws-task-extractor-02");
    let again = seam::handle_line(&frame.to_string(), &mut state).unwrap();
    assert_eq!(
        spawned_assignment_ids(&again),
        spawned_assignment_ids(&completed)
    );
}

#[test]
fn checkpoint_accepts_a_role_complete_handoff_without_terminalizing_the_assignment() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("checkpoint-handoff");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let mut state = CoreState::open(None).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "CP01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let allowed = spec
        .allowed_tools
        .iter()
        .map(|tool| tool.0.as_str())
        .collect::<Vec<_>>();
    assert!(allowed.contains(&"autopilot_checkpoint"), "{allowed:?}");
    assert!(allowed.contains(&"autopilot_report_blocked"), "{allowed:?}");
    let handoff = json!({
        "schema":"autopilot.agent-handoff.v1",
        "completed":["read the first authority range"],
        "remaining":["extract the remaining atoms"],
        "critical_state":{
            "semantic_lens":"WORK",
            "authority_coverage":["task://mission#first-range"],
            "atom_ledger":["CP01-A|WORK|first atom|task://mission#first-range"],
            "duplicate_dispositions":["none"],
            "unresolved_ambiguities":["none"]
        },
        "next_action":"continue with the next unread authority range",
        "\u{10000}":"supplementary-key",
        "\u{e000}":"bmp-private-use-key"
    });
    let checkpoint = json!({"v":1,"id":60,"kind":"child-control","payload":{
        "broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":"checkpoint-request-1",
            "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
            "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
            "tool_call_id":"checkpoint-call-1","kind":"checkpoint",
            "tool_name":"autopilot_checkpoint",
            "profile_id":"autopilot.agent-handoff.v1:autopilot_checkpoint",
            "raw_payload":handoff,
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }
    }});
    let accepted = seam::handle_line(&checkpoint.to_string(), &mut state).unwrap();
    assert_eq!(accepted.kind, "child-control", "{accepted:?}");
    assert_eq!(
        accepted.payload["response"]["outcome"], "ACCEPT",
        "{accepted:?}"
    );
    assert_eq!(
        accepted.payload["response"]["receipt"]["kind"],
        "checkpoint"
    );
    assert_eq!(accepted.payload["blocked_gate"], serde_json::Value::Null);
    let receipt: kernel::generated::CheckpointReceipt =
        serde_json::from_value(accepted.payload["response"]["receipt"]["receipt"].clone()).unwrap();
    assert_eq!(receipt.assignment_id, issue.receipt_binding.assignment_id);
    assert_eq!(receipt.session_id, spec.session_id);
    assert_eq!(receipt.role_id, spec.role_id);
    assert_eq!(receipt.mode, spec.mode);
    assert_eq!(receipt.tool_call_id, "checkpoint-call-1");
    let canonical = drivers::evidence::canonical_json(&handoff).unwrap();
    assert_eq!(receipt.handoff_digest.0, sha256_hex(&canonical));
    assert_eq!(receipt.handoff, handoff);

    let mut malformed = checkpoint.clone();
    malformed["payload"]["request"]["request_id"] = json!("checkpoint-request-2");
    malformed["payload"]["request"]["tool_call_id"] = json!("checkpoint-call-2");
    malformed["payload"]["request"]["raw_payload"]["critical_state"]
        .as_object_mut()
        .unwrap()
        .remove("atom_ledger");
    let retry = seam::handle_line(&malformed.to_string(), &mut state).unwrap();
    assert_eq!(retry.payload["response"]["outcome"], "RETRY");
    assert_eq!(
        retry.payload["response"]["diagnostic"]["errors"][0]["code"],
        "checkpoint.handoff"
    );

    // A checkpoint is control evidence only. The exact assignment remains
    // live and may subsequently terminalize only through its generated submit.
    let raw: serde_json::Value = serde_json::from_str(&task_atoms("CP01-A")).unwrap();
    let submit = json!({"v":1,"id":61,"kind":"child-control","payload":{
        "broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":"submit-after-checkpoint",
            "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
            "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
            "tool_call_id":"submit-call-after-checkpoint","kind":"submit",
            "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
            "raw_payload":raw,
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }
    }});
    let submitted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(submitted.payload["response"]["outcome"], "ACCEPT");
    assert_eq!(submitted.payload["response"]["receipt"]["kind"], "submit");
}

#[test]
fn blocked_latch_is_rooted_replayed_and_observed_once() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("blocked-latch");
    fixture.install_transport_with_nonexistent_command_names();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let reporter =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "BL01-");
    let sibling_a =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-02", "BL02-");
    let sibling_b =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-03", "BL03-");
    let terminal =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-04", "BL04-");
    let foreign = fixture.issue_task_extractor(
        "foreign-workstream",
        "planning-foreign-task-extractor-01",
        "FOREIGN-",
    );
    append_ref(
        &mut state,
        &runner::receipt_binding_ref(&foreign.receipt_binding).unwrap(),
    );
    for (issue, task_id) in [
        (&sibling_b, "task-beta"),
        (&reporter, "task-reporter"),
        (&sibling_a, "task-alpha"),
        (&terminal, "task-terminal"),
        (&foreign, "task-foreign"),
    ] {
        let launched = json!({"v":1,"id":63,"kind":"spawn-result","payload":{
            "action_id":issue.receipt_binding.action_id,
            "assignment_id":issue.receipt_binding.assignment_id,
            "status":"launched","task_id":task_id,"diagnostic":null
        }});
        seam::handle_line(&launched.to_string(), &mut state).unwrap();
    }
    append_ref(
        &mut state,
        &Ref(format!(
            "terminal-consumed:{}:{}:{}",
            terminal.receipt_binding.action_id.0,
            terminal.receipt_binding.assignment_id.0,
            terminal.receipt_binding.run_revision
        )),
    );
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&reporter.binding.spec_path).unwrap()).unwrap();
    let blocked = json!({"v":1,"id":64,"kind":"child-control","payload":{
        "broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":"blocked-request-1",
            "token":spec.child_control_token,"run_id":reporter.receipt_binding.run_id,
            "assignment_id":reporter.receipt_binding.assignment_id,"attempt":reporter.receipt_binding.attempt,
            "tool_call_id":"blocked-call-1","kind":"blocked",
            "tool_name":"autopilot_report_blocked",
            "profile_id":"autopilot.blocked_report.v1:autopilot_report_blocked",
            "raw_payload":{"schema":"autopilot.blocked_report.v1","reason_code":"infrastructure","summary":"launch is blocked","evidence":[{"kind":"observation","value":"focused fixture"}],"last_attempted_action":"run focused fixture"},
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }
    }});
    let accepted = seam::handle_line(&blocked.to_string(), &mut state).unwrap();
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    assert_eq!(accepted.payload["response"]["receipt"]["kind"], "blocked");
    assert_eq!(
        accepted.payload["blocked_gate"]["cancellations"],
        json!([
            {"task_id":"task-alpha","action_id":"action-planning-ws-task-extractor-02","assignment_id":"planning-ws-task-extractor-02","reporter":false},
            {"task_id":"task-beta","action_id":"action-planning-ws-task-extractor-03","assignment_id":"planning-ws-task-extractor-03","reporter":false},
            {"task_id":"task-reporter","action_id":"action-planning-ws-task-extractor-01","assignment_id":"planning-ws-task-extractor-01","reporter":true}
        ])
    );
    let receipt = accepted.payload["response"]["receipt"]["receipt"].clone();
    let mut replay = blocked.clone();
    replay["payload"]["request"]["request_id"] = json!("blocked-request-2");
    replay["payload"]["request"]["tool_call_id"] = json!("blocked-call-2");
    let replayed = seam::handle_line(&replay.to_string(), &mut state).unwrap();
    assert_eq!(replayed.payload["response"]["receipt"]["receipt"], receipt);
    let mut conflict = replay.clone();
    conflict["payload"]["request"]["raw_payload"]["summary"] = json!("different blocker");
    let rejected = seam::handle_line(&conflict.to_string(), &mut state).unwrap();
    assert_eq!(rejected.payload["response"]["outcome"], "RETRY");

    // A rooted exact alias authenticates against only durable binding/receipt/
    // latch/root authority. It must survive deletion of all mutable child
    // sources, while a changed canonical report remains a RETRY.
    fs::create_dir_all(Path::new(&reporter.binding.carrier_path).parent().unwrap()).unwrap();
    fs::write(&reporter.binding.carrier_path, b"mutable carrier source").unwrap();
    fs::remove_file(&reporter.binding.spec_path).unwrap();
    fs::remove_file(&reporter.binding.carrier_path).unwrap();
    let source_free = seam::handle_line(&replay.to_string(), &mut state).unwrap();
    assert_eq!(source_free.payload["response"]["outcome"], "ACCEPT");
    let changed_without_sources = seam::handle_line(&conflict.to_string(), &mut state).unwrap();
    assert_eq!(
        changed_without_sources.payload["response"]["outcome"],
        "RETRY"
    );

    let reopened = CoreState::open(Some(event_path)).unwrap();
    let mut reopened = reopened;
    let restarted_source_free = seam::handle_line(&replay.to_string(), &mut reopened).unwrap();
    assert_eq!(
        restarted_source_free.payload["response"]["outcome"],
        "ACCEPT"
    );
    let reconcile = json!({"v":1,"id":65,"kind":"blocked-reconcile","payload":{
        "schema":"autopilot.blocked_reconcile.v1","broker_capability":fixture.broker_capability()
    }});
    let malformed_reconcile =
        json!({"v":1,"id":650,"kind":"blocked-reconcile","payload":{"unexpected":true}});
    let malformed_reconcile_response =
        seam::handle_line(&malformed_reconcile.to_string(), &mut reopened).unwrap();
    assert_eq!(malformed_reconcile_response.kind, "done");
    assert!(
        malformed_reconcile_response.payload["status"]
            .as_str()
            .is_some_and(|status| status.starts_with("rejection:blocked-reconcile:"))
    );
    let reconciliation = seam::handle_line(&reconcile.to_string(), &mut reopened).unwrap();
    assert_eq!(reconciliation.kind, "blocked-reconcile");
    assert_eq!(
        reconciliation.payload["records"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        reconciliation.payload["records"][0]["blocked_gate"]["cancellations"],
        accepted.payload["blocked_gate"]["cancellations"]
    );
    let observed = json!({"v":1,"id":66,"kind":"blocked-result-observed","payload":{
        "schema":"autopilot.blocked_result_observed.v1","broker_capability":fixture.broker_capability(),
        "token":spec.child_control_token,"run_id":reporter.receipt_binding.run_id,
        "assignment_id":reporter.receipt_binding.assignment_id,"attempt":reporter.receipt_binding.attempt,
        "receipt_id":receipt["receipt_id"],"tool_call_id":"blocked-call-2"
    }});
    let malformed_observation =
        json!({"v":1,"id":660,"kind":"blocked-result-observed","payload":{"unexpected":true}});
    let malformed_observation_response =
        seam::handle_line(&malformed_observation.to_string(), &mut reopened).unwrap();
    assert_eq!(malformed_observation_response.kind, "done");
    assert!(
        malformed_observation_response.payload["status"]
            .as_str()
            .is_some_and(|status| status.starts_with("rejection:blocked-result-observed:"))
    );
    let mut unauthorized_observation = observed.clone();
    unauthorized_observation["payload"]["broker_capability"] = json!("f".repeat(64));
    let unauthorized_observation_response =
        seam::handle_line(&unauthorized_observation.to_string(), &mut reopened).unwrap();
    assert_eq!(unauthorized_observation_response.kind, "done");
    let first_observation = seam::handle_line(&observed.to_string(), &mut reopened).unwrap();
    assert_eq!(first_observation.kind, "blocked-result-observed");
    let duplicate_observation = seam::handle_line(&observed.to_string(), &mut reopened).unwrap();
    assert_eq!(duplicate_observation.payload, first_observation.payload);
    let rows = fs::read_to_string(fixture.root.join("events.jsonl")).unwrap();
    assert_eq!(rows.matches("blocked:result-observed").count(), 1);
}

#[test]
fn blocked_publication_boundaries_recover_once_and_corruption_fails_closed() {
    fn remove_event_kinds(path: &Path, removed: &[&str]) {
        let rows = fs::read_to_string(path).unwrap();
        let retained = rows
            .lines()
            .filter(|line| {
                let event: EventRow = serde_json::from_str(line).unwrap();
                !removed.contains(&event.kind.0.as_str())
            })
            .collect::<Vec<_>>();
        fs::write(path, format!("{}\n", retained.join("\n"))).unwrap();
    }
    fn event_kind_count(path: &Path, kind: &str) -> usize {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| serde_json::from_str::<EventRow>(line).unwrap().kind.0 == kind)
            .count()
    }

    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("blocked-publication-boundaries");
    fixture.install_transport_with_nonexistent_command_names();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let reporter =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "BND-");
    let launched = json!({"v":1,"id":69,"kind":"spawn-result","payload":{
        "action_id":reporter.receipt_binding.action_id,
        "assignment_id":reporter.receipt_binding.assignment_id,
        "status":"launched","task_id":"boundary-reporter","diagnostic":null
    }});
    seam::handle_line(&launched.to_string(), &mut state).unwrap();
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&reporter.binding.spec_path).unwrap()).unwrap();
    let blocked = json!({"v":1,"id":70,"kind":"child-control","payload":{
        "broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":"boundary-request",
            "token":spec.child_control_token,"run_id":reporter.receipt_binding.run_id,
            "assignment_id":reporter.receipt_binding.assignment_id,"attempt":reporter.receipt_binding.attempt,
            "tool_call_id":"boundary-call","kind":"blocked",
            "tool_name":"autopilot_report_blocked",
            "profile_id":"autopilot.blocked_report.v1:autopilot_report_blocked",
            "raw_payload":{"schema":"autopilot.blocked_report.v1","reason_code":"infrastructure","summary":"publication boundary","evidence":[{"kind":"observation","value":"focused fixture"}],"last_attempted_action":"run focused fixture"},
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }
    }});
    assert_eq!(
        seam::handle_line(&blocked.to_string(), &mut state)
            .unwrap()
            .payload["response"]["outcome"],
        "ACCEPT"
    );
    let durable_root = Path::new(&reporter.binding.carrier_path)
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf();
    let latch_path = fs::read_dir(durable_root.join("blocked-latches"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    drop(state);

    // A Host restart has no surviving child socket to resend the raw report.
    // Reconciliation must publish the already-admitted immutable prepared
    // transaction, rather than deadlocking in the degraded pending posture.
    remove_event_kinds(
        &event_path,
        &["blocked:accepted", "blocked:latch-event-ref"],
    );
    let mut prepared_restarted = CoreState::open(Some(event_path.clone())).unwrap();
    let prepared_reconcile = json!({"v":1,"id":700,"kind":"blocked-reconcile","payload":{
        "schema":"autopilot.blocked_reconcile.v1","broker_capability":fixture.broker_capability()
    }});
    let prepared_recovery =
        seam::handle_line(&prepared_reconcile.to_string(), &mut prepared_restarted).unwrap();
    assert_eq!(prepared_recovery.kind, "blocked-reconcile");
    assert_eq!(
        prepared_recovery.payload["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(event_kind_count(&event_path, "blocked:accepted"), 1);
    assert_eq!(event_kind_count(&event_path, "blocked:latch-event-ref"), 1);
    drop(prepared_restarted);

    // Receipt+latch with no accepted root uses the same prepared transaction;
    // an unrelated row cannot select a new cancellation snapshot or IDs.
    remove_event_kinds(
        &event_path,
        &["blocked:accepted", "blocked:latch-event-ref"],
    );
    let mut recovered = CoreState::open(Some(event_path.clone())).unwrap();
    append_ref(
        &mut recovered,
        &Ref("unrelated-durable:blocked-receipt-latch-recovery".to_owned()),
    );
    let receipt_latch_recovery = seam::handle_line(&blocked.to_string(), &mut recovered).unwrap();
    assert_eq!(
        receipt_latch_recovery.payload["response"]["outcome"],
        "ACCEPT"
    );
    assert_eq!(event_kind_count(&event_path, "blocked:accepted"), 1);
    assert_eq!(event_kind_count(&event_path, "blocked:latch-event-ref"), 1);
    drop(recovered);

    // Receipt-only is also recovered from that immutable prepared authority,
    // not by re-deriving mutable launch acknowledgements.
    remove_event_kinds(
        &event_path,
        &["blocked:accepted", "blocked:latch-event-ref"],
    );
    fs::remove_file(&latch_path).unwrap();
    let mut receipt_only = CoreState::open(Some(event_path.clone())).unwrap();
    let receipt_only_recovery = seam::handle_line(&blocked.to_string(), &mut receipt_only).unwrap();
    assert_eq!(
        receipt_only_recovery.payload["response"]["outcome"],
        "ACCEPT"
    );
    assert!(latch_path.exists());
    assert_eq!(event_kind_count(&event_path, "blocked:accepted"), 1);
    assert_eq!(event_kind_count(&event_path, "blocked:latch-event-ref"), 1);
    drop(receipt_only);

    // The accepted root is the publication boundary: open repairs exactly a
    // missing event-ref and never duplicates receipt, latch, root, or ref.
    remove_event_kinds(&event_path, &["blocked:latch-event-ref"]);
    let mut root_repaired = CoreState::open(Some(event_path.clone())).unwrap();
    assert_eq!(event_kind_count(&event_path, "blocked:accepted"), 1);
    assert_eq!(event_kind_count(&event_path, "blocked:latch-event-ref"), 1);
    let reconcile = json!({"v":1,"id":71,"kind":"blocked-reconcile","payload":{
        "schema":"autopilot.blocked_reconcile.v1","broker_capability":fixture.broker_capability()
    }});
    assert_eq!(
        seam::handle_line(&reconcile.to_string(), &mut root_repaired)
            .unwrap()
            .kind,
        "blocked-reconcile"
    );
    drop(root_repaired);

    // A rooted artifact fault is not a Core death. It globally suppresses
    // launch routes and makes private reconciliation a deterministic frame.
    fs::write(&latch_path, b"{}").unwrap();
    let mut degraded = CoreState::open(Some(event_path.clone())).unwrap();
    let rows_before = fs::read_to_string(&event_path).unwrap();
    let private_rejection = seam::handle_line(&reconcile.to_string(), &mut degraded).unwrap();
    assert_eq!(private_rejection.kind, "done");
    assert!(
        private_rejection.payload["status"]
            .as_str()
            .is_some_and(|status| status.starts_with("rejection:blocked-reconcile:"))
    );
    let run = json!({"v":1,"id":72,"kind":"command","payload":{
        "raw":"/autopilot ws",
        "background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},
        "background_capability_diagnostic":null
    }});
    let launch_rejection = seam::handle_line(&run.to_string(), &mut degraded).unwrap();
    assert_eq!(launch_rejection.kind, "done");
    assert!(
        launch_rejection.payload["status"]
            .as_str()
            .is_some_and(|status| status.starts_with("rejection:blocked-latch:"))
    );
    assert_eq!(fs::read_to_string(event_path).unwrap(), rows_before);
}

#[test]
fn blocked_rejections_leave_no_durable_artifacts_before_a_reporter_launch_ack() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("blocked-rejection-zero-state");
    fixture.install_transport_with_nonexistent_command_names();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let reporter =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "BRJ-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&reporter.binding.spec_path).unwrap()).unwrap();
    let blocked = json!({"v":1,"id":67,"kind":"child-control","payload":{
        "broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":"blocked-reject-1",
            "token":spec.child_control_token,"run_id":reporter.receipt_binding.run_id,
            "assignment_id":reporter.receipt_binding.assignment_id,"attempt":reporter.receipt_binding.attempt,
            "tool_call_id":"blocked-reject-call","kind":"blocked",
            "tool_name":"autopilot_report_blocked",
            "profile_id":"autopilot.blocked_report.v1:autopilot_report_blocked",
            "raw_payload":{"schema":"autopilot.blocked_report.v1","reason_code":"infrastructure","summary":"no launch ack","evidence":[{"kind":"observation","value":"focused fixture"}],"last_attempted_action":"run focused fixture"},
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }
    }});
    let mut malformed = blocked.clone();
    malformed["payload"]["request"]["raw_payload"]["schema"] = json!("wrong");
    let mut unauthorized = blocked.clone();
    unauthorized["payload"]["broker_capability"] = json!("f".repeat(64));
    for frame in [&malformed, &unauthorized, &blocked] {
        let response = seam::handle_line(&frame.to_string(), &mut state).unwrap();
        assert_eq!(response.kind, "child-control");
        assert_eq!(response.payload["response"]["outcome"], "RETRY");
    }
    let durable_root = Path::new(&reporter.binding.carrier_path)
        .parent()
        .and_then(Path::parent)
        .unwrap();
    for directory in [
        "blocked-prepared-transactions",
        "blocked-receipts",
        "blocked-latches",
    ] {
        assert!(
            !durable_root.join(directory).exists(),
            "{directory} must not exist after rejected blocked admission"
        );
    }
    assert!(!fs::read_to_string(event_path).unwrap().contains("blocked:"));
}

#[test]
fn launch_ack_replay_is_exactly_idempotent_and_conflicting_task_ids_reject() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("launch-ack-idempotency");
    fixture.install_transport_with_nonexistent_command_names();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "ACK-");
    let launched = json!({"v":1,"id":68,"kind":"spawn-result","payload":{
        "action_id":issue.receipt_binding.action_id,
        "assignment_id":issue.receipt_binding.assignment_id,
        "status":"launched","task_id":"journal-owned-task","diagnostic":null
    }});
    let first = seam::handle_line(&launched.to_string(), &mut state).unwrap();
    assert_eq!(first.kind, "done");
    let replay = seam::handle_line(&launched.to_string(), &mut state).unwrap();
    assert_eq!(replay.kind, "done");
    assert_eq!(replay.payload, first.payload);
    let mut conflict = launched.clone();
    conflict["payload"]["task_id"] = json!("different-journal-task");
    let rejected = seam::handle_line(&conflict.to_string(), &mut state).unwrap();
    assert_eq!(rejected.kind, "done");
    assert!(
        rejected.payload["status"]
            .as_str()
            .is_some_and(|status| status.contains("acknowledged-task-id-conflict"))
    );
    assert_eq!(
        fs::read_to_string(event_path)
            .unwrap()
            .matches("background:launch-ack")
            .count(),
        1
    );
}

#[test]
fn receipt_v1_orphan_retry_keeps_parent_binding_continuation_after_intervening_rows() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-preconsume-revision");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let submit = json!({"v":1,"id":71,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
        "schema":"autopilot.child_control_request.v1","request_id":"request-71",
        "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
        "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
        "tool_call_id":"tool-call-71","kind":"submit",
        "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
        "raw_payload":serde_json::from_str::<serde_json::Value>(&task_atoms("TE01-A")).unwrap(),
        "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
    }}});
    let accepted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    let issued =
        accepted.payload["response"]["receipt"]["receipt"]["prepared_transition"]["issued_actions"]
            .as_array()
            .unwrap();
    assert!(
        !issued.is_empty(),
        "the first receipt must stage the next wave"
    );

    let receipt = accepted.payload["response"]["receipt"]["receipt"].clone();
    let rooted_rows = fs::read_to_string(&event_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
        .collect::<Vec<_>>();
    let continuation_revision = issue.receipt_binding.run_revision.checked_add(1).unwrap();
    for stored in issued {
        assert_eq!(stored["action"]["run_revision"], continuation_revision);
        let binding_ref = stored["binding_ref"].as_str().unwrap();
        let runner::VersionedRunnerBinding::ReceiptV1(binding) =
            runner::decode_versioned_binding_ref(binding_ref).unwrap()
        else {
            panic!("staged action must retain a receipt_v1 binding");
        };
        assert_eq!(binding.run_revision, continuation_revision);
    }

    // Retain the create-once receipt but discard its roots to model the
    // crash-after-artifacts/receipt window. An unrelated durable row lands
    // before exact retry; it must not select a new action generation.
    let orphan_prefix = rooted_rows
        .into_iter()
        .filter(|row| {
            !matches!(
                row.kind.0.as_str(),
                "submit:accepted" | "submit:accepted-event-ref"
            )
        })
        .map(|row| serde_json::to_string(&row).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&event_path, format!("{orphan_prefix}\n")).unwrap();
    drop(state);

    let mut replayed = CoreState::open(Some(event_path.clone())).unwrap();
    append_ref(
        &mut replayed,
        &Ref("unrelated-durable:orphan-retry".to_owned()),
    );
    let replay = seam::handle_line(&submit.to_string(), &mut replayed).unwrap();
    assert_eq!(replay.payload["response"]["outcome"], "ACCEPT");
    assert_eq!(replay.payload["response"]["receipt"]["receipt"], receipt);
    drop(replayed);

    let mut restarted = CoreState::open(Some(event_path.clone())).unwrap();
    let completed = seam::handle_line(
        &json!({"v":1,"id":72,"kind":"task-completed","payload":{
            "task_id":"task-preconsume","action_id":issue.receipt_binding.action_id,
            "assignment_id":issue.receipt_binding.assignment_id,"status":"completed"
        }})
        .to_string(),
        &mut restarted,
    )
    .unwrap();
    let action = completed.payload["actions"]
        .as_array()
        .and_then(|actions| actions.first())
        .or_else(|| completed.payload.get("action"))
        .unwrap();
    assert_eq!(action["run_revision"], continuation_revision);

    let rows = fs::read_to_string(&event_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
        .collect::<Vec<_>>();
    let consume = rows
        .iter()
        .find(|row| row.kind.0 == "submit:receipt-consumed")
        .unwrap();
    assert!(
        consume.previous_revision > continuation_revision,
        "intervening durable rows must not poison the immutable continuation"
    );
    let mut published_next_binding = false;
    for reference in &consume.artifact_refs {
        if !reference.0.starts_with(runner::ISSUED_BINDING_REF_PREFIX) {
            continue;
        }
        let runner::VersionedRunnerBinding::ReceiptV1(binding) =
            runner::decode_versioned_binding_ref(&reference.0).unwrap()
        else {
            continue;
        };
        if binding.action_id.0 == action["action_id"].as_str().unwrap()
            && binding.assignment_id.0 == action["assignment_id"].as_str().unwrap()
        {
            assert_eq!(binding.run_revision, continuation_revision);
            published_next_binding = true;
        }
    }
    assert!(
        published_next_binding,
        "the consumed receipt must publish the staged next binding"
    );
}

#[test]
fn fresh_planning_projection_rejects_malformed_task_and_transition_refs() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    for (label, malformed_ref, expected) in [
        (
            "task-binding",
            "task-binding:{not-json}",
            "task binding ref JSON",
        ),
        (
            "transition-marker",
            "planning-transition-kind:not-a-closed-planning-kind",
            "planning transition ref corruption",
        ),
    ] {
        let fixture = Fixture::new(&format!("malformed-{label}"));
        fixture.install_transport_with_nonexistent_command_names();
        fixture.write_manifest();
        let mut state = CoreState::open(None).unwrap();
        let issue = fixture.seed_receipt_planning_binding(
            &mut state,
            "planning-ws-task-extractor-01",
            "TE01-",
        );
        let appended = json!({"v":1,"id":81,"kind":"command","payload":{
            "raw":format!("append:test:{malformed_ref}"),
            "background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},
            "background_capability_diagnostic":null
        }});
        seam::handle_line(&appended.to_string(), &mut state).unwrap();
        let spec: kernel::generated::AgentRunSpecV5 =
            serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
        let submit = json!({"v":1,"id":82,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":format!("request-{label}"),
            "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
            "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
            "tool_call_id":format!("tool-{label}"),"kind":"submit",
            "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
            "raw_payload":serde_json::from_str::<serde_json::Value>(&task_atoms("TE01-A")).unwrap(),
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }}});
        let retry = seam::handle_line(&submit.to_string(), &mut state).unwrap();
        assert_eq!(retry.kind, "child-control", "{label}: {retry:?}");
        assert_eq!(
            retry.payload["response"]["outcome"], "RETRY",
            "{label}: {retry:?}"
        );
        assert_eq!(
            retry.payload["response"]["diagnostic"]["errors"][0]["code"],
            "submit.planning_transition",
            "{label}: {retry:?}"
        );
        assert!(
            retry.payload["response"]["diagnostic"]["errors"][0]["actual"]["preview"]
                .as_str()
                .is_some_and(|detail| detail.contains(expected)),
            "{label}: {retry:?}"
        );
    }
}

#[test]
fn rooted_parallel_planning_receipts_close_one_wave_under_either_completion_order() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    for (label, completion_order) in [("a-then-b", ["a", "b"]), ("b-then-a", ["b", "a"])] {
        let fixture = Fixture::new(&format!("parallel-{label}"));
        fixture.install_transport_with_nonexistent_command_names();
        fixture.write_parallel_manifest();
        let event_path = fixture.root.join("events.jsonl");
        let mut state = CoreState::open(Some(event_path.clone())).unwrap();
        let a = fixture.seed_receipt_planning_binding(
            &mut state,
            "planning-ws-task-extractor-01",
            "TE01-",
        );
        let b = fixture.seed_receipt_planning_binding(
            &mut state,
            "planning-ws-task-extractor-02",
            "TE02-",
        );

        // Both siblings become fully rooted semantic ACCEPT authority before
        // either Host task-completed route arrives. A is waiting; B closes
        // P1 and stores the only P2 action set in its immutable receipt.
        let accepted_a =
            fixture.submit_receipt(&mut state, &a, "parallel-a", &task_atoms("TE01-A"));
        assert_eq!(
            accepted_a.payload["response"]["outcome"], "ACCEPT",
            "{label}: {accepted_a:?}"
        );
        let receipt_a = accepted_a.payload["response"]["receipt"]["receipt"].clone();
        let accepted_b =
            fixture.submit_receipt(&mut state, &b, "parallel-b", &task_atoms("TE02-B"));
        assert_eq!(
            accepted_b.payload["response"]["outcome"], "ACCEPT",
            "{label}: {accepted_b:?}"
        );
        let receipt_b = accepted_b.payload["response"]["receipt"]["receipt"].clone();
        assert!(
            receipt_a["prepared_transition"]["issued_actions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let stored_actions = receipt_b["prepared_transition"]["issued_actions"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(stored_actions.len(), 1, "{label}: {receipt_b:?}");
        assert_eq!(
            a.receipt_binding.run_revision,
            b.receipt_binding.run_revision
        );
        assert_eq!(
            stored_actions[0]["action"]["run_revision"],
            b.receipt_binding.run_revision.checked_add(1).unwrap(),
            "{label}: the P2 action is the immutable P1 sibling generation plus one"
        );
        assert_eq!(
            stored_actions[0]["action"]["action_id"],
            "action-planning-ws-repository-scout-01"
        );
        assert_eq!(
            stored_actions[0]["action"]["assignment_id"],
            "planning-ws-repository-scout-01"
        );
        let registry = receipt_b["prepared_transition"]["artifact_refs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| artifact["artifact_schema"] == "autopilot.planning_atom_registry.v1")
            .expect("closing receipt stages an atom registry from both rooted carriers");
        let registry_bytes = fs::read(registry["artifact_ref"].as_str().unwrap()).unwrap();
        let registry_json: serde_json::Value = serde_json::from_slice(&registry_bytes).unwrap();
        assert_eq!(
            registry_json["producer_assignment_ids"],
            json!([
                "planning-ws-task-extractor-01",
                "planning-ws-task-extractor-02"
            ])
        );
        let atom_ids = registry_json["atoms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|atom| atom["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(atom_ids, vec!["TE01-A", "TE02-B"]);

        // Exact response-loss replay preserves the original receipt. Restart
        // after both roots, then add an unrelated durable row before either
        // completion; neither completion may compare against that row's
        // revision or recompute scheduling.
        let replay_a =
            fixture.submit_receipt(&mut state, &a, "parallel-a-replay", &task_atoms("TE01-A"));
        assert_eq!(replay_a.payload["response"]["outcome"], "ACCEPT");
        assert_eq!(
            replay_a.payload["response"]["receipt"]["receipt"],
            receipt_a
        );
        drop(state);
        let mut state = CoreState::open(Some(event_path.clone())).unwrap();
        append_ref(&mut state, &Ref(format!("unrelated-durable:{label}")));

        let mut completions = std::collections::BTreeMap::new();
        for sibling in completion_order {
            let issue = if sibling == "a" { &a } else { &b };
            let completed =
                fixture.task_completed(&mut state, issue, &format!("task-{label}-{sibling}"));
            assert!(
                !completed
                    .payload
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|status| status.starts_with("rejection:")),
                "{label}/{sibling}: {completed:?}"
            );
            completions.insert(sibling, completed);
        }
        let spawned = completions
            .values()
            .filter(|response| !spawned_assignment_ids(response).is_empty())
            .collect::<Vec<_>>();
        assert_eq!(spawned.len(), 1, "{label}: {completions:?}");
        assert_eq!(
            spawned_assignment_ids(spawned[0]),
            vec!["planning-ws-repository-scout-01"]
        );
        let emitted_actions = spawned[0].payload["actions"].as_array().unwrap();
        assert_eq!(
            emitted_actions,
            &stored_actions
                .iter()
                .map(|stored| stored["action"].clone())
                .collect::<Vec<_>>()
        );

        // Completion replay returns only the stored effect. It does not stage
        // a second wave or mutate the parent-selected action/binding revision.
        let replay_b = fixture.task_completed(&mut state, &b, &format!("task-{label}-b-replay"));
        assert_eq!(
            spawned_assignment_ids(&replay_b),
            vec!["planning-ws-repository-scout-01"]
        );

        let rows = fs::read_to_string(&event_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
            .collect::<Vec<_>>();
        let consumed = rows
            .iter()
            .filter(|row| row.kind.0 == "submit:receipt-consumed")
            .collect::<Vec<_>>();
        assert_eq!(
            consumed.len(),
            2,
            "{label}: exactly the two sibling receipts consume"
        );
        let action = &stored_actions[0]["action"];
        let action_id = action["action_id"].as_str().unwrap();
        let assignment_id = action["assignment_id"].as_str().unwrap();
        let selected_revision = action["run_revision"].as_u64().unwrap();
        let b_consume = consumed
            .iter()
            .find(|row| {
                row.artifact_refs.iter().any(|reference| {
                    reference.0
                        == format!(
                            "submit-receipt-consumed:{}",
                            receipt_b["receipt_id"].as_str().unwrap()
                        )
                })
            })
            .unwrap();
        assert!(
            b_consume.previous_revision > selected_revision,
            "{label}: unrelated rows and/or sibling completion must not invalidate the immutable continuation"
        );
        let published = consumed
            .iter()
            .flat_map(|row| row.artifact_refs.iter())
            .filter_map(|reference| runner::decode_versioned_binding_ref(&reference.0).ok())
            .filter_map(|binding| match binding {
                runner::VersionedRunnerBinding::ReceiptV1(binding)
                    if binding.action_id.0 == action_id
                        && binding.assignment_id.0 == assignment_id
                        && binding.run_revision == selected_revision =>
                {
                    Some(binding)
                }
                runner::VersionedRunnerBinding::ReplayV0(_)
                | runner::VersionedRunnerBinding::ReceiptV1(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(published.len(), 1, "{label}: one next-wave binding only");
    }
}

#[test]
fn rooted_receipt_activation_cannot_cross_workstreams_during_private_projection() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("workstream-isolation");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_first_review_manifest("alpha");
    fixture.write_task_then_gated_scout_manifest("bravo");
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();

    // Alpha's rooted, unconsumed first-review receipt carries the real
    // recovery activation. It remains globally verified but must not enter
    // Bravo's private scheduling projection.
    let alpha = fixture.issue_first_review("alpha");
    append_ref(
        &mut state,
        &runner::receipt_binding_ref(&alpha.receipt_binding).unwrap(),
    );
    append_ref(&mut state, &Ref(alpha.binding.assignment_id.0.clone()));
    let alpha_accepted = fixture.submit_receipt(
        &mut state,
        &alpha,
        "alpha-blocked-review",
        &blocked_review_raw(),
    );
    assert_eq!(alpha_accepted.payload["response"]["outcome"], "ACCEPT");

    // Bravo's P2 scout is gated only by its own workstream's recovery ref.
    // A global projection/activation scan would incorrectly stage that scout.
    let bravo = fixture.issue_task_extractor("bravo", "planning-bravo-task-extractor-01", "BR01-");
    append_ref(
        &mut state,
        &runner::receipt_binding_ref(&bravo.receipt_binding).unwrap(),
    );
    append_ref(&mut state, &Ref(bravo.binding.assignment_id.0.clone()));
    let bravo_accepted =
        fixture.submit_receipt(&mut state, &bravo, "bravo-atoms", &task_atoms("BR01-A"));
    assert_eq!(bravo_accepted.payload["response"]["outcome"], "ACCEPT");
    assert!(
        bravo_accepted.payload["response"]["receipt"]["receipt"]["prepared_transition"]
            ["issued_actions"]
            .as_array()
            .unwrap()
            .is_empty(),
        "alpha recovery activation must not stage bravo's gated scout: {bravo_accepted:?}"
    );

    let rooted = fs::read_to_string(event_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
        .filter(|row| row.kind.0 == "submit:accepted")
        .count();
    assert_eq!(rooted, 2, "both workstream receipts must be rooted");
}

#[test]
fn malformed_prior_rooted_receipt_authority_fails_before_a_parallel_accept() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    for corruption in ["receipt", "transition", "root"] {
        let fixture = Fixture::new(&format!("parallel-corrupt-{corruption}"));
        fixture.install_transport_with_nonexistent_command_names();
        fixture.write_parallel_manifest();
        let event_path = fixture.root.join("events.jsonl");
        let mut state = CoreState::open(Some(event_path.clone())).unwrap();
        let a = fixture.seed_receipt_planning_binding(
            &mut state,
            "planning-ws-task-extractor-01",
            "TE01-",
        );
        let b = fixture.seed_receipt_planning_binding(
            &mut state,
            "planning-ws-task-extractor-02",
            "TE02-",
        );
        let accepted_a = fixture.submit_receipt(&mut state, &a, "corrupt-a", &task_atoms("TE01-A"));
        assert_eq!(accepted_a.payload["response"]["outcome"], "ACCEPT");
        let receipt_a = accepted_a.payload["response"]["receipt"]["receipt"].clone();
        match corruption {
            "receipt" => fs::write(fixture.submit_receipt_file(&a), b"{}").unwrap(),
            "transition" => {
                let sidecar = receipt_a["prepared_transition"]["artifact_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|artifact| {
                        artifact["artifact_schema"] == "autopilot.prepared_planning_transition.v1"
                    })
                    .unwrap();
                fs::write(sidecar["artifact_ref"].as_str().unwrap(), b"{}").unwrap();
            }
            "root" => {
                let mut rows = fs::read_to_string(&event_path)
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
                    .collect::<Vec<_>>();
                let accepted = rows
                    .iter_mut()
                    .find(|row| row.kind.0 == "submit:accepted")
                    .unwrap();
                accepted.artifact_refs[0] = Ref("submit-receipt-root:{not-json}".to_owned());
                fs::write(
                    &event_path,
                    format!(
                        "{}\n",
                        rows.iter()
                            .map(serde_json::to_string)
                            .collect::<Result<Vec<_>, _>>()
                            .unwrap()
                            .join("\n")
                    ),
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        drop(state);
        let mut restarted = CoreState::open(Some(event_path.clone())).unwrap();
        let rejected =
            fixture.submit_receipt(&mut restarted, &b, "corrupt-b", &task_atoms("TE02-B"));
        assert_eq!(
            rejected.payload["response"]["outcome"], "RETRY",
            "{corruption}: {rejected:?}"
        );
        let accepted_rows = fs::read_to_string(&event_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
            .filter(|row| row.kind.0 == "submit:accepted")
            .count();
        assert_eq!(
            accepted_rows, 1,
            "{corruption}: malformed prior authority must precede new ACCEPT"
        );
    }
}

#[test]
fn receipt_v1_missing_receipt_never_falls_back_to_legacy_carrier() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-missing-no-legacy");
    fixture.install_transport_with_nonexistent_command_names();
    let mut state = CoreState::open(None).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    fs::create_dir_all(Path::new(&issue.binding.carrier_path).parent().unwrap()).unwrap();
    fs::write(&issue.binding.carrier_path, b"not a receipt-backed carrier").unwrap();
    let completed = seam::handle_line(
        &json!({"v":1,"id":54,"kind":"task-completed","payload":{
            "task_id":"task-missing","action_id":issue.receipt_binding.action_id,
            "assignment_id":issue.receipt_binding.assignment_id,"status":"completed"
        }})
        .to_string(),
        &mut state,
    )
    .unwrap();
    assert_eq!(completed.kind, "done");
    assert_eq!(
        completed.payload["status"],
        "rejection:submit-receipt:missing receipt"
    );
}

#[test]
fn receipt_v1_issuance_replays_exact_v5_token_spec_and_attempt() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-issuance-replay");
    fixture.install_transport_with_nonexistent_command_names();
    let first = fixture.issue_planning("planning-ws-task-extractor-01", "TE01-");
    let first_spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&first.binding.spec_path).unwrap()).unwrap();
    let second = fixture.issue_planning("planning-ws-task-extractor-01", "TE01-");
    let second_bytes = fs::read(&second.binding.spec_path).unwrap();
    let second_spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&second_bytes).unwrap();

    assert_eq!(first_spec, second_spec);
    assert_eq!(first.binding.spec_digest, second.binding.spec_digest);
    assert_eq!(
        first.receipt_binding.run_capability_digest,
        second.receipt_binding.run_capability_digest
    );
    assert_eq!(first_spec.required_pi_version, runner::REQUIRED_PI_VERSION);
    assert_eq!(first_spec.attempt, Some(1));
    assert_eq!(first.receipt_binding.attempt, 1);
}

#[test]
fn receipt_root_uses_actual_event_bytes_and_refuses_duplicate_roots() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-root-hash");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let submit = json!({"v":1,"id":61,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
        "schema":"autopilot.child_control_request.v1","request_id":"request-61",
        "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
        "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
        "tool_call_id":"tool-call-61","kind":"submit",
        "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
        "raw_payload":serde_json::from_str::<serde_json::Value>(&task_atoms("TE01-A")).unwrap(),
        "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
    }}});
    let accepted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    drop(state);
    let mut persisted = CoreState::open(Some(event_path.clone())).unwrap();
    let replay = seam::handle_line(&submit.to_string(), &mut persisted).unwrap();
    assert_eq!(replay.payload["response"]["outcome"], "ACCEPT");
    drop(persisted);

    let mut rows = fs::read_to_string(&event_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
        .collect::<Vec<_>>();
    let accepted_row = rows
        .iter()
        .find(|row| row.kind.0 == "submit:accepted")
        .cloned()
        .unwrap();
    let last = rows.last().unwrap().clone();
    rows.push(EventRow {
        sequence: last.sequence + 1,
        previous_revision: last.new_revision,
        new_revision: last.new_revision + 1,
        kind: EventKind("submit:accepted".to_owned()),
        artifact_refs: accepted_row.artifact_refs,
    });
    let bytes = rows
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    fs::write(&event_path, format!("{bytes}\n")).unwrap();

    let mut replayed = CoreState::open(Some(event_path)).unwrap();
    let retry = seam::handle_line(&submit.to_string(), &mut replayed).unwrap();
    assert_eq!(retry.kind, "child-control");
    assert_eq!(retry.payload["response"]["outcome"], "RETRY");
    assert_eq!(
        retry.payload["response"]["diagnostic"]["errors"][0]["code"],
        "submit.receipt_root"
    );
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let pid = std::process::id();
        loop {
            let root = temp.join(format!(
                "pi-autopilot-w3-h3-{label}-{pid}-{}",
                FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let vcs = GitVcs::new(&temp);
                    vcs.init_fixture(&root).unwrap();
                    fs::write(
                        root.join(".gitignore"),
                        ".pi/autopilot/\n.pi/tasks/\nbin/\n",
                    )
                    .unwrap();
                    vcs.stage_all(&root).unwrap();
                    vcs.snapshot(&root, "fixture root").unwrap();
                    std::env::set_current_dir(&root).unwrap();
                    return Self { root };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture root {root:?}: {error}"),
            }
        }
    }

    fn install_transport_with_nonexistent_command_names(&self) {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let node = bin.join("nonexistent-node-name");
        let wrapper = bin.join("nonexistent-wrapper-name.mjs");
        fs::write(&node, "#!/bin/sh\nexit 127\n").unwrap();
        fs::write(&wrapper, "// nonexistent wrapper fixture\n").unwrap();
        make_executable(&node);
        unsafe {
            std::env::set_var("AUTOPILOT_NODE_EXECUTABLE", &node);
            std::env::set_var("AUTOPILOT_AGENT_RUNNER_WRAPPER", &wrapper);
            std::env::set_var(
                "AUTOPILOT_CHILD_ADDON_PATH",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
            );
            std::env::set_var("AUTOPILOT_CHILD_CONTROL_SOCKET_PATH", broker_socket_path());
            std::env::set_var(
                "AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY",
                self.broker_capability(),
            );
        }
    }

    fn broker_capability(&self) -> &'static str {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }

    fn write_manifest(&self) {
        fs::create_dir_all(self.root.join(".pi/autopilot/ws")).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        fs::write(self.root.join(".pi/autopilot/ws/planning-manifest.json"), serde_json::to_vec_pretty(&json!({
            "workstream":"ws","authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,
            "assignments":[
                {"assignment_id":"planning-ws-task-extractor-01","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":1,"atom_id_prefix":"TE01-"},
                {"assignment_id":"planning-ws-task-extractor-02","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":2,"atom_id_prefix":"TE02-"}
            ],
            "planning_wave_cap":7,"planning_max_attempts":2,
            "planning_waves":[{"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false}]
        })).unwrap()).unwrap();
    }

    fn write_parallel_manifest(&self) {
        fs::create_dir_all(self.root.join(".pi/autopilot/ws")).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        fs::write(self.root.join(".pi/autopilot/ws/planning-manifest.json"), serde_json::to_vec_pretty(&json!({
            "workstream":"ws","authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,
            "assignments":[
                {"assignment_id":"planning-ws-task-extractor-01","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":1,"atom_id_prefix":"TE01-"},
                {"assignment_id":"planning-ws-task-extractor-02","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":2,"atom_id_prefix":"TE02-"},
                {"assignment_id":"planning-ws-repository-scout-01","role":"repository-scout","mode":"initial-grounding","boundary_id":"planning.scout-dossier.v1","ordinal":3,"atom_id_prefix":null}
            ],
            "planning_wave_cap":7,"planning_max_attempts":2,
            "planning_waves":[
                {"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false},
                {"id":"P2.scout","role":"repository-scout","dependencies":["P1.extract"],"ordinals":null,"activation_ref":null,"canonical_output":false}
            ]
        })).unwrap()).unwrap();
    }

    fn write_first_review_manifest(&self, workstream: &str) {
        let directory = self.root.join(".pi/autopilot").join(workstream);
        fs::create_dir_all(&directory).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        fs::write(
            directory.join("planning-manifest.json"),
            serde_json::to_vec_pretty(&json!({
                "workstream":workstream,"authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,
                "assignments":[
                    {"assignment_id":format!("planning-{workstream}-plan-reviewer-01"),"role":"plan-reviewer","mode":"full-review","boundary_id":"planning.plan-review.v1","ordinal":1,"atom_id_prefix":null}
                ],
                "planning_wave_cap":7,"planning_max_attempts":2,
                "planning_waves":[{"id":"P1.review","role":"plan-reviewer","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false}]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn write_task_then_gated_scout_manifest(&self, workstream: &str) {
        let directory = self.root.join(".pi/autopilot").join(workstream);
        fs::create_dir_all(&directory).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        fs::write(
            directory.join("planning-manifest.json"),
            serde_json::to_vec_pretty(&json!({
                "workstream":workstream,"authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,
                "assignments":[
                    {"assignment_id":format!("planning-{workstream}-task-extractor-01"),"role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":1,"atom_id_prefix":"BR01-"},
                    {"assignment_id":format!("planning-{workstream}-repository-scout-01"),"role":"repository-scout","mode":"initial-grounding","boundary_id":"planning.scout-dossier.v1","ordinal":2,"atom_id_prefix":null}
                ],
                "planning_wave_cap":7,"planning_max_attempts":2,
                "planning_waves":[
                    {"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false},
                    {"id":"P2.gated-scout","role":"repository-scout","dependencies":["P1.extract"],"ordinals":null,"activation_ref":"planning-recovery-required","canonical_output":false}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn submit_receipt_file(&self, issue: &runner::IssuedRunnerAction) -> PathBuf {
        let root = Path::new(&issue.binding.carrier_path)
            .parent()
            .and_then(Path::parent)
            .unwrap();
        let mut receipts = fs::read_dir(root.join("submit-receipts"))
            .unwrap()
            .map(Result::unwrap)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.ends_with(".json")
                            && !name.ends_with(".transition.json")
                            && !name.ends_with(".planning-transition.json")
                    })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            receipts.len(),
            1,
            "exactly one receipt file for fixture issue"
        );
        receipts.remove(0)
    }

    fn submit_receipt(
        &self,
        state: &mut CoreState,
        issue: &runner::IssuedRunnerAction,
        request_suffix: &str,
        raw: &str,
    ) -> SeamEnvelope {
        let spec: kernel::generated::AgentRunSpecV5 =
            serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
        let frame = json!({"v":1,"id":91,"kind":"child-control","payload":{"broker_capability":self.broker_capability(),"request":{
            "schema":"autopilot.child_control_request.v1","request_id":format!("request-{request_suffix}"),
            "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
            "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
            "tool_call_id":format!("tool-{request_suffix}"),"kind":"submit",
            "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
            "raw_payload":serde_json::from_str::<serde_json::Value>(raw).unwrap(),
            "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
        }}});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn task_completed(
        &self,
        state: &mut CoreState,
        issue: &runner::IssuedRunnerAction,
        task_id: &str,
    ) -> SeamEnvelope {
        let frame = json!({"v":1,"id":92,"kind":"task-completed","payload":{
            "task_id":task_id,"action_id":issue.receipt_binding.action_id,
            "assignment_id":issue.receipt_binding.assignment_id,"status":"completed"
        }});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn seed_receipt_planning_binding(
        &self,
        state: &mut CoreState,
        assignment_id: &str,
        prefix: &str,
    ) -> runner::IssuedRunnerAction {
        let issue = self.issue_planning(assignment_id, prefix);
        append_ref(
            state,
            &runner::receipt_binding_ref(&issue.receipt_binding).unwrap(),
        );
        append_ref(state, &Ref(assignment_id.to_owned()));
        issue
    }

    fn issue_planning(&self, assignment_id: &str, prefix: &str) -> runner::IssuedRunnerAction {
        self.issue_task_extractor("ws", assignment_id, prefix)
    }

    fn issue_task_extractor(
        &self,
        workstream: &str,
        assignment_id: &str,
        prefix: &str,
    ) -> runner::IssuedRunnerAction {
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let issued = runner::planning_issue(&PlanningRunnerRequest {
            workstream: workstream.to_owned(),
            action_id: Id(format!("action-{assignment_id}")),
            assignment_id: Id(assignment_id.to_owned()),
            role_id: Id("task-extractor".to_owned()),
            mode: ModeId("inventory".to_owned()),
            boundary_id: ContractId("planning.task-atoms.v1".to_owned()),
            attempt: if assignment_id.ends_with("-02") { 2 } else { 1 },
            run_revision: 1,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: first_mode_parameter_for("task-extractor"),
            atom_id_prefix: Some(prefix.to_owned()),
            atom_registry_path: None,
            atom_registry_digest: None,
            terminal_route: None,
            accepted_planning_artifacts: Vec::new(),
        })
        .unwrap();
        assert!(issued.action.bg_run.notify_on_completion);
        assert!(!issued.action.bg_run.trigger_on_completion);
        issued
    }

    fn issue_first_review(&self, workstream: &str) -> runner::IssuedRunnerAction {
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let compiler_route = serde_json::from_value(serde_json::json!({
            "version":"v2",
            "profile_id":"planning.work-map.v2:autopilot_submit_plan_cluster",
            "tool_name":"autopilot_submit_plan_cluster",
            "boundary_id":"planning.work-map.v2",
            "result_contract":"planning.work-map.v2",
            "schema_digest":"4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75"
        }))
        .unwrap();
        let synthesized_route = serde_json::from_value(serde_json::json!({
            "version":"v2",
            "profile_id":"planning.work-map.v2:autopilot_submit_synthesis",
            "tool_name":"autopilot_submit_synthesis",
            "boundary_id":"planning.work-map.v2",
            "result_contract":"planning.work-map.v2",
            "schema_digest":"4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75"
        }))
        .unwrap();
        runner::planning_issue(&PlanningRunnerRequest {
            workstream: workstream.to_owned(),
            action_id: Id(format!("action-planning-{workstream}-plan-reviewer-01")),
            assignment_id: Id(format!("planning-{workstream}-plan-reviewer-01")),
            role_id: Id("plan-reviewer".to_owned()),
            mode: ModeId("full-review".to_owned()),
            boundary_id: ContractId("planning.plan-review.v1".to_owned()),
            attempt: 1,
            run_revision: 1,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: first_mode_parameter_for("plan-reviewer"),
            atom_id_prefix: None,
            atom_registry_path: None,
            atom_registry_digest: None,
            terminal_route: None,
            accepted_planning_artifacts: vec![
                runner::AcceptedPlanningArtifactBinding {
                    category_id: "task-atoms".to_owned(),
                    assignment_id: Id(format!("planning-{workstream}-task-extractor-01")),
                    role_id: Id("task-extractor".to_owned()),
                    boundary_id: ContractId("planning.task-atoms.v1".to_owned()),
                    terminal_route: None,
                    path: format!("/sealed/{workstream}/atoms-carrier.json"),
                    digest: "sealed-atoms-digest".to_owned(),
                },
                runner::AcceptedPlanningArtifactBinding {
                    category_id: "scout-findings".to_owned(),
                    assignment_id: Id(format!("planning-{workstream}-repository-scout-01")),
                    role_id: Id("repository-scout".to_owned()),
                    boundary_id: ContractId("planning.scout-dossier.v1".to_owned()),
                    terminal_route: None,
                    path: format!("/sealed/{workstream}/scout-carrier.json"),
                    digest: "sealed-scout-digest".to_owned(),
                },
                runner::AcceptedPlanningArtifactBinding {
                    category_id: "compiler-work-maps".to_owned(),
                    assignment_id: Id(format!("planning-{workstream}-plan-compiler-01")),
                    role_id: Id("plan-compiler".to_owned()),
                    boundary_id: ContractId("planning.work-map.v2".to_owned()),
                    terminal_route: Some(compiler_route),
                    path: format!("/sealed/{workstream}/compiler-carrier.json"),
                    digest: "sealed-compiler-digest".to_owned(),
                },
                runner::AcceptedPlanningArtifactBinding {
                    category_id: "synthesized-work-map".to_owned(),
                    assignment_id: Id(format!("planning-{workstream}-plan-synthesizer-01")),
                    role_id: Id("plan-synthesizer".to_owned()),
                    boundary_id: ContractId("planning.work-map.v2".to_owned()),
                    terminal_route: Some(synthesized_route),
                    path: format!("/sealed/{workstream}/synthesized-carrier.json"),
                    digest: "sealed-synthesized-digest".to_owned(),
                },
            ],
        })
        .unwrap()
    }
}

fn append_ref(state: &mut CoreState, reference: &Ref) {
    let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":format!("append:test:{}", reference.0),"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},"background_capability_diagnostic":null}});
    let response = seam::handle_line(&frame.to_string(), state).unwrap();
    assert!(
        response
            .payload
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .contains("state:sequence")
    );
}

fn assert_spawn_assignment(response: &SeamEnvelope, assignment_id: &str) {
    assert_machine_only_completion(response);
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "expected spawn response: {response:?}"
    );
    assert!(
        spawned_assignment_ids(response)
            .iter()
            .any(|id| id == assignment_id),
        "spawn should launch {assignment_id}: {response:?}"
    );
}

fn assert_machine_only_completion(response: &SeamEnvelope) {
    let actions = response
        .payload
        .get("actions")
        .and_then(serde_json::Value::as_array);
    let single = response.payload.get("action").into_iter();
    for action in actions.into_iter().flatten().chain(single) {
        assert_eq!(action["bg_run"]["notifyOnCompletion"], true);
        assert_eq!(action["bg_run"]["triggerOnCompletion"], false);
    }
}

fn spawned_assignment_ids(response: &SeamEnvelope) -> Vec<String> {
    let read = |action: &serde_json::Value| {
        action
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    if let Some(actions) = response.payload.get("actions").and_then(|v| v.as_array()) {
        return actions.iter().filter_map(read).collect();
    }
    response
        .payload
        .get("action")
        .and_then(read)
        .into_iter()
        .collect()
}

fn task_atoms(id: &str) -> String {
    json!({"atoms":[{"id":id,"kind":"work","text":"Do the work","sources":[anchor("task.md", "authority", "auth", "Do the work")]}]}).to_string()
}

fn blocked_review_raw() -> String {
    json!({"verdicts": drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA.iter().map(|criterion| {
        json!({"criterion_id":criterion,"verdict":if *criterion == "review.forward-validation" { "blocked" } else { "pass" },"finding":"workstream isolation probe"})
    }).collect::<Vec<_>>()}).to_string()
}

fn runner_doc(path: &str, class: &str, authority_set_id: &str, body: &str) -> RunnerTaskDocument {
    RunnerTaskDocument::new(
        path.to_owned(),
        class.to_owned(),
        task_file_digest(class, authority_set_id, body),
        body.to_owned(),
    )
}

fn runner_doc_json(
    path: &str,
    class: &str,
    authority_set_id: &str,
    body: &str,
) -> serde_json::Value {
    let doc = runner_doc(path, class, authority_set_id, body);
    json!({"path":doc.path,"class":doc.class,"digest":doc.digest,"body_digest":doc.body_digest,"body":doc.body})
}

fn anchor(path: &str, class: &str, authority_set_id: &str, body: &str) -> String {
    format!(
        "task://{}/{}#whole-file",
        task_file_digest(class, authority_set_id, body),
        path
    )
}

fn task_file_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(unix)]
fn broker_socket_path() -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let root = PathBuf::from("/tmp/.pi-ap");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let dir = loop {
        let id = format!("{:010x}", FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed));
        let candidate = root.join(id);
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("broker socket directory {candidate:?}: {error}"),
        }
    };
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.join("s");
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);
    path
}

#[cfg(not(unix))]
fn broker_socket_path() -> PathBuf {
    PathBuf::from("/tmp/.pi-ap/0000000000/s")
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

fn first_mode_parameter_for(role: &str) -> Option<String> {
    let roles = drivers::roles::RoleRegistry::package().expect("role registry");
    let role = roles.get(role).expect("role is registered");
    drivers::roles::allocate_mode_parameters(role, role.mode_parameters.len().max(1))
        .expect("mode parameter allocation")
        .first()
        .cloned()
        .flatten()
}
