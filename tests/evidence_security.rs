#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use drivers::evidence::{self, EvidenceError};
use kernel::generated::{
    AutopilotAttestedAction, AutopilotContentRef, AutopilotEventRef, ContractId,
    Digest, EventKind, EvidenceContentKind, HostToCoreAttestedTaskObservationPayload, Id,
    Path as ContractPath, Phase2PiAttestedRunRequest, Phase2PiConsumerBinding, SchemaId,
    ThinkingLevel, UnixMs, Uuidv7, Base32,
};

#[test]
fn attested_receipts_bind_action_ref_not_assignment_ref() {
    let action = issued_action();
    let action_ref = evidence::action_ref_for(&action).expect("action ref");
    assert_eq!(action_ref.kind, EvidenceContentKind::Action);
    assert_eq!(action_ref.path.0, "evidence/actions/eva-test.json");
    assert_ne!(action_ref.sha256, action.assignment_ref.sha256);
}

#[test]
fn attested_ingress_rejects_absolute_or_unowned_source_paths_before_read() {
    let action = issued_action();
    let err = evidence::accept_attested_observation_inner(
        &action,
        event_ref(1, "evidence.assignment-issued.v1"),
        event_ref(2, "evidence.task-bound.v1"),
        &HostToCoreAttestedTaskObservationPayload {
            action_id: action.action_id.clone(),
            assignment_id: action.assignment_id.clone(),
            assignment_revision: action.assignment_revision,
            run_revision: action.run_revision,
            producer_task_id: Id("b00000000000000000000000000000000".to_owned()),
            producer_request_sha256: action.producer_request.request_sha256.clone(),
            status: "completed".to_owned(),
            report_source_path: ContractPath(PathBuf::from("/tmp/forged-report.json").display().to_string()),
            sidecar_source_path: ContractPath(".pi/tasks/session/b00000000000000000000000000000000.attestation.json".to_owned()),
        },
    )
    .expect_err("absolute source path must reject");
    assert!(matches!(err, EvidenceError::SourcePath));

    let err = evidence::accept_attested_observation_inner(
        &action,
        event_ref(1, "evidence.assignment-issued.v1"),
        event_ref(2, "evidence.task-bound.v1"),
        &HostToCoreAttestedTaskObservationPayload {
            action_id: action.action_id.clone(),
            assignment_id: action.assignment_id.clone(),
            assignment_revision: action.assignment_revision,
            run_revision: action.run_revision,
            producer_task_id: Id("b00000000000000000000000000000000".to_owned()),
            producer_request_sha256: action.producer_request.request_sha256.clone(),
            status: "completed".to_owned(),
            report_source_path: ContractPath("tmp/forged-report.json".to_owned()),
            sidecar_source_path: ContractPath(".pi/tasks/session/b00000000000000000000000000000000.attestation.json".to_owned()),
        },
    )
    .expect_err("unowned relative source path must reject");
    assert!(matches!(err, EvidenceError::SourcePath));
}

fn issued_action() -> AutopilotAttestedAction {
    let assignment_ref = AutopilotContentRef {
        schema_version: SchemaId("autopilot.content_ref.v1".to_owned()),
        kind: EvidenceContentKind::Assignment,
        path: ContractPath("evidence/assignments/evi-test.json".to_owned()),
        byte_length: UnixMs("2".to_owned()),
        sha256: Digest("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()),
    };
    let consumer_binding = Phase2PiConsumerBinding {
        schema_version: SchemaId("phase2.pi_consumer_binding.v1".to_owned()),
        consumer: "pi-autopilot".to_owned(),
        run_id: Uuidv7("019fa7f1-0000-7000-8000-000000000001".to_owned()),
        repo_key: Base32("repo".to_owned()),
        workstream: Id("main".to_owned()),
        purpose_id: Id("planning.plan-review".to_owned()),
        action_id: Id("eva-test".to_owned()),
        assignment_id: Id("evi-test".to_owned()),
        assignment_revision: 1,
        run_revision: 7,
        boundary_id: ContractId("planning.plan-review.v1".to_owned()),
        subject_digest: Digest("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned()),
        binding_sha256: Digest("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned()),
    };
    AutopilotAttestedAction {
        schema_version: SchemaId("autopilot.attested_action.v1".to_owned()),
        action_id: Id("eva-test".to_owned()),
        assignment_id: Id("evi-test".to_owned()),
        assignment_revision: 1,
        run_revision: 7,
        assignment_ref,
        producer_request: Phase2PiAttestedRunRequest {
            schema_version: SchemaId("phase2.pi_attested_run_request.v2".to_owned()),
            name: "test".to_owned(),
            provider: "openai-codex".to_owned(),
            model: "gpt-5.5".to_owned(),
            thinking: ThinkingLevel("high".to_owned()),
            system_prompt_utf8: "system".to_owned(),
            prompt_utf8: "prompt".to_owned(),
            report_path: ContractPath(".pi/autopilot/main/evidence-staging/evi-test.report.v1.json".to_owned()),
            timeout_seconds: 60,
            idempotency_key: Id("evidence-issue:v1:evi-test".to_owned()),
            consumer_binding,
            request_sha256: Digest("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned()),
        },
        expires_at_unix_ms: UnixMs("9007199254740991".to_owned()),
        supersession_state: "live".to_owned(),
        action_sha256: Digest("sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_owned()),
    }
}

fn event_ref(sequence: u64, kind: &str) -> AutopilotEventRef {
    AutopilotEventRef {
        schema_version: SchemaId("autopilot.event_ref.v1".to_owned()),
        sequence,
        kind: EventKind(kind.to_owned()),
        row_sha256: Digest("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned()),
    }
}
