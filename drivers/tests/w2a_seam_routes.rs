use drivers::generated::tables::{self, SeamAdmissionError};
use drivers::seam::{CoreState, handle_line};
use serde_json::json;

#[test]
fn generated_host_routes_distinguish_unknown_unsupported_and_payload_drift() {
    match tables::admit_host_to_core("attested-task-observation", json!({})) {
        Err(SeamAdmissionError::Unsupported(row)) => assert_eq!(
            (row.kind, row.adapter),
            (
                "attested-task-observation",
                "unsupported-attested-observation"
            )
        ),
        _ => panic!("attested observation must be explicit unsupported"),
    }
    match tables::admit_host_to_core("not-a-route", json!({})) {
        Err(SeamAdmissionError::Unknown(kind)) => assert_eq!(kind, "not-a-route"),
        _ => panic!("unknown route must reject separately"),
    }
    match tables::admit_host_to_core("command", json!({"raw":"state"})) {
        Err(SeamAdmissionError::Payload { kind, .. }) => assert_eq!(kind, "command"),
        _ => panic!("generated payload validator must reject missing fields"),
    }
}

#[test]
fn child_control_missing_or_drifted_authority_is_a_closed_retry() {
    let mut state = CoreState::open(None).expect("in-memory state");
    let line = json!({
        "v": 1,
        "id": 41,
        "kind": "child-control",
        "payload": {
            "request": {
                "schema": "autopilot.child_control_request.v1",
                "request_id": "request-41",
                "token": "not-a-capability",
                "run_id": "run-41",
                "assignment_id": "assignment-41",
                "attempt": 1,
                "tool_call_id": "tool-call-41",
                "kind": "submit",
                "tool_name": "autopilot_emit_status",
                "profile_id": "delivery-status.v2",
                "raw_payload": {"unexpected": true}
            }
        }
    });
    let frame = handle_line(&line.to_string(), &mut state).expect("closed retry frame");
    assert_eq!(frame.kind, "child-control");
    assert_eq!(frame.payload["response"]["outcome"], "RETRY");
    assert_eq!(
        frame.payload["response"]["diagnostic"]["schema"],
        "autopilot.submit_diagnostic.v1"
    );
    assert_eq!(frame.payload["blocked_gate"], serde_json::Value::Null);
}

#[test]
fn generated_route_identity_names_current_dispatch_adapters() {
    assert_eq!(
        tables::host_to_core_route("child-control").unwrap().payload,
        "HostToCoreChildControlPayload"
    );
    assert_eq!(
        tables::host_to_core_route("blocked-result-observed")
            .unwrap()
            .adapter,
        "blocked-result-observed"
    );
    assert_eq!(
        tables::host_to_core_route("command").unwrap().adapter,
        "command"
    );
    assert_eq!(
        tables::host_to_core_route("spawn-result").unwrap().payload,
        "HostToCoreSpawnResultPayload"
    );
    assert_eq!(
        tables::core_to_host_effect("spawn-wave").unwrap().effect,
        "spawn-wave"
    );
}
