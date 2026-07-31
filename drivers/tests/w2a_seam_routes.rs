use drivers::generated::tables::{self, SeamAdmissionError};
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
fn generated_route_identity_names_current_dispatch_adapters() {
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
