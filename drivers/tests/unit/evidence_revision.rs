use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

#[test]
fn next_assignment_revision_rejects_corrupt_assignment_json_loudly() {
    let identity = test_identity("corrupt");
    write_assignment(&identity, "evi-existing.json", 9, PURPOSE_PLANNING_REVIEW);
    let corrupt_path = assignments_dir(&identity).join("evi-corrupt.json");
    fs::write(&corrupt_path, b"{").expect("write corrupt assignment");

    let err = next_assignment_revision(&identity, PURPOSE_PLANNING_REVIEW)
        .expect_err("corrupt assignment json must not be skipped");

    let EvidenceError::Schema(detail) = err else {
        panic!("expected schema error for corrupt assignment, got {err:?}");
    };
    assert!(detail.contains("assignment parse:"), "{detail}");
    assert!(detail.contains("evi-corrupt.json"), "{detail}");
    assert!(detail.contains("EOF"), "{detail}");
}

#[test]
fn next_assignment_revision_increments_per_requested_purpose() {
    let identity = test_identity("happy");
    write_assignment(&identity, "evi-planning-1.json", 1, PURPOSE_PLANNING_REVIEW);
    write_assignment(&identity, "evi-planning-2.json", 2, PURPOSE_PLANNING_REVIEW);
    write_assignment(&identity, "evi-other-99.json", 99, "planning.other-review");
    fs::write(assignments_dir(&identity).join("README.txt"), b"not json").expect("write note");

    assert_eq!(
        next_assignment_revision(&identity, PURPOSE_PLANNING_REVIEW).expect("planning revision"),
        3
    );
    assert_eq!(
        next_assignment_revision(&identity, "planning.other-review").expect("other revision"),
        100
    );
}

#[test]
fn next_assignment_revision_rejects_u32_overflow_loudly() {
    let identity = test_identity("overflow");
    write_assignment(
        &identity,
        "evi-overflow.json",
        u32::MAX,
        PURPOSE_PLANNING_REVIEW,
    );

    let err = next_assignment_revision(&identity, PURPOSE_PLANNING_REVIEW)
        .expect_err("u32::MAX revision must not saturate and be reused");

    let EvidenceError::Store(detail) = err else {
        panic!("expected store error for revision overflow, got {err:?}");
    };
    assert!(detail.contains("assignment revision overflow:"), "{detail}");
    assert!(detail.contains(&u32::MAX.to_string()), "{detail}");
}

fn test_identity(label: &str) -> EvidenceIdentity {
    let nonce = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
    let root = PathBuf::from("/private/tmp")
        .join(format!(
            "pa-rev-evidence-{label}-{}-{nonce}",
            std::process::id()
        ))
        .join("run");
    EvidenceIdentity {
        repo_key: Base32("repo-test".to_owned()),
        run_id: Uuidv7("019fa7f1-0000-7000-8000-000000000001".to_owned()),
        workstream: Id("main".to_owned()),
        run_root: root,
    }
}

fn assignments_dir(identity: &EvidenceIdentity) -> PathBuf {
    let dir = identity.run_root.join("evidence/assignments");
    fs::create_dir_all(&dir).expect("create assignments dir");
    dir
}

fn write_assignment(identity: &EvidenceIdentity, file_name: &str, revision: u32, purpose: &str) {
    let path = assignments_dir(identity).join(file_name);
    let assignment = test_assignment(identity, revision, purpose);
    fs::write(
        path,
        serde_json::to_vec(&assignment).expect("serialize assignment"),
    )
    .expect("write assignment");
}

fn test_assignment(
    identity: &EvidenceIdentity,
    revision: u32,
    purpose: &str,
) -> AutopilotAttestedAssignment {
    let assignment_id = Id(format!("evi-test-{revision}"));
    let action_id = Id(format!("eva-test-{revision}"));
    AutopilotAttestedAssignment {
        schema_version: SchemaId(ASSIGNMENT_SCHEMA.to_owned()),
        run_id: identity.run_id.clone(),
        repo_key: identity.repo_key.clone(),
        workstream: identity.workstream.clone(),
        purpose_id: Id(purpose.to_owned()),
        assignment_id: assignment_id.clone(),
        assignment_revision: revision,
        run_revision: 7,
        action_id,
        issue_idempotency_key: Id(format!("evidence-issue:v1:{}", assignment_id.0)),
        import_idempotency_key: Id(format!("evidence-import:v1:{}", assignment_id.0)),
        subject_digest: Digest(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        ),
        boundary_id: ContractId("planning.plan-review.v1".to_owned()),
        provider: PROVIDER.to_owned(),
        model: "gpt-5.5".to_owned(),
        thinking: ThinkingLevel("high".to_owned()),
        required_channel: CHANNEL.to_owned(),
        prompt_ref: AutopilotContentRef {
            schema_version: SchemaId(CONTENT_REF_SCHEMA.to_owned()),
            kind: EvidenceContentKind::Prompt,
            path: ContractPath(format!("prompts/evidence/{}.md", assignment_id.0)),
            byte_length: UnixMs("6".to_owned()),
            sha256: Digest(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_owned(),
            ),
        },
        system_prompt_sha256: Digest(
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
        ),
        report_staging_path: ContractPath(format!(
            ".pi/autopilot/main/evidence-staging/{}.report.v1.json",
            assignment_id.0
        )),
        producer_request_sha256: Digest(
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        ),
        conflict_policy: conflict_policy(Vec::new()).expect("conflict policy"),
        issued_at_unix_ms: UnixMs("1".to_owned()),
        supersedes_assignment_id: None,
        assignment_sha256: Digest(
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_owned(),
        ),
    }
}
