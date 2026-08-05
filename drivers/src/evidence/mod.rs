//! Attested evidence ingress and closed envelope authority.
//!
//! This module is intentionally separate from source-conflict validation and
//! generic runner transcript replay.  Only Core-issued attested assignments can
//! enter this ingress path; there is no public file-import command.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kernel::boundary::Rejection;
use kernel::generated::{
    AutopilotAttestedAction, AutopilotAttestedAssignment, AutopilotContentRef, AutopilotEventRef,
    AutopilotEvidenceAcceptanceReceipt, AutopilotEvidenceConflictCheck,
    AutopilotEvidenceConflictPolicy, AutopilotEvidenceEnvelopeManifest,
    AutopilotEvidenceFailureReceipt, AutopilotProducerBinding, Base32, ContractId, Digest,
    EvidenceContentKind, EvidenceErrorCode, HostToCoreAttestedTaskObservationPayload, Id,
    Path as ContractPath, Phase2PiAttestedRunRequest, Phase2PiConsumerBinding, Ref, SchemaId,
    ThinkingLevel, UnixMs, Uuidv7,
};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

use crate::roles::kdl::boundary_runtime;
use crate::roster::{self, Roster};
use crate::state_root;

pub mod conflict;
pub mod envelope;
pub mod ingress;
pub mod store;

pub const BOUNDARY_ID: &str = "evidence.ingress.v1";
pub const PURPOSE_PLANNING_REVIEW: &str = "planning.plan-review";
pub const SYSTEM_PROMPT: &str = "You are an attested, no-tools Autopilot planning reviewer. Return exactly the requested plan-review verdict text; do not claim tool, file, provider, session, or payment facts.";
const ASSIGNMENT_SCHEMA: &str = "autopilot.attested_assignment.v1";
const ACTION_SCHEMA: &str = "autopilot.attested_action.v1";
const CONTENT_REF_SCHEMA: &str = "autopilot.content_ref.v1";
const REQUEST_SCHEMA: &str = "phase2.pi_attested_run_request.v2";
const CONSUMER_BINDING_SCHEMA: &str = "phase2.pi_consumer_binding.v1";
const PROVIDER: &str = "openai-codex";
const CHANNEL: &str = "subscription-codex";
const AUTH_CLASS: &str = "pi-codex-oauth";
const CREDENTIAL_KIND: &str = "oauth";
const ROUTE_CLASS: &str = "subscription-agent";
const DIRECT_API_KEY: bool = false;
const TIMEOUT_SECONDS: u32 = 3600;
const REPORT_LIMIT: u64 = 4 * 1024 * 1024;
const SIDECAR_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct EvidenceIdentity {
    pub repo_key: Base32,
    pub run_id: Uuidv7,
    pub workstream: Id,
    pub run_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PlanningReviewIssue {
    pub action: AutopilotAttestedAction,
    pub assignment: AutopilotAttestedAssignment,
    pub prompt_ref: AutopilotContentRef,
    pub assignment_ref: AutopilotContentRef,
    pub action_ref: AutopilotContentRef,
}

#[derive(Debug, Clone)]
pub struct AcceptedEvidence {
    pub receipt: AutopilotEvidenceAcceptanceReceipt,
    pub receipt_ref: AutopilotContentRef,
    pub report: Phase2PiTaskReportV1,
    pub sidecar: Phase2PiTaskAttestationV2,
    pub envelope: Option<(AutopilotEvidenceEnvelopeManifest, AutopilotContentRef)>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum EvidenceError {
    Store(String),
    MissingAssignment,
    BindingConflict,
    TerminalNotCompleted(String),
    SourcePath,
    SourceRead(String),
    Schema(String),
    Hash(String),
    RequestMismatch(String),
    ProviderMismatch(String),
    ModelMismatch(String),
    ChannelForbidden(String),
    MeteredUsage,
    SubjectStale,
    BoundaryRejected(String),
    Envelope(String),
}

impl EvidenceError {
    pub fn code(&self) -> EvidenceErrorCode {
        let code = match self {
            Self::MissingAssignment => "EVIDENCE_ACTION_NOT_ISSUED",
            Self::BindingConflict => "EVIDENCE_TASK_BINDING_CONFLICT",
            Self::TerminalNotCompleted(_) => "EVIDENCE_TERMINAL_NOT_COMPLETED",
            Self::SourcePath => "EVIDENCE_SOURCE_PATH_INVALID",
            Self::SourceRead(_) => "EVIDENCE_SOURCE_MISSING",
            Self::Schema(_) => "EVIDENCE_SCHEMA_UNSUPPORTED",
            Self::Hash(_) => "EVIDENCE_HASH_MISMATCH",
            Self::RequestMismatch(_) => "EVIDENCE_PRODUCER_REQUEST_MISMATCH",
            Self::ProviderMismatch(_) => "EVIDENCE_PROVIDER_MISMATCH",
            Self::ModelMismatch(_) => "EVIDENCE_MODEL_MISMATCH",
            Self::ChannelForbidden(_) => "EVIDENCE_CHANNEL_FORBIDDEN",
            Self::MeteredUsage => "EVIDENCE_METERED_USAGE_OBSERVED",
            Self::SubjectStale => "EVIDENCE_SUBJECT_STALE",
            Self::BoundaryRejected(_) => "EVIDENCE_BOUNDARY_REJECTED",
            Self::Envelope(_) => "EVIDENCE_ENVELOPE_MEMBER_MISMATCH",
            Self::Store(_) => "EVIDENCE_STORE_IO",
        };
        evidence_code_from(code)
    }

    pub fn status(&self) -> String {
        format!(
            "rejection:evidence.ingress.v1:{}:{}",
            evidence_code_str(&self.code()),
            bound_detail(&self.to_string())
        )
    }
}

impl std::fmt::Display for EvidenceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(value)
            | Self::SourceRead(value)
            | Self::Schema(value)
            | Self::Hash(value)
            | Self::RequestMismatch(value)
            | Self::ProviderMismatch(value)
            | Self::ModelMismatch(value)
            | Self::ChannelForbidden(value)
            | Self::BoundaryRejected(value)
            | Self::Envelope(value)
            | Self::TerminalNotCompleted(value) => formatter.write_str(value),
            Self::MissingAssignment => formatter.write_str("assignment/action not issued"),
            Self::BindingConflict => formatter.write_str("producer task binding conflict"),
            Self::SourcePath => formatter.write_str("source path is invalid"),
            Self::MeteredUsage => formatter.write_str("metered usage observed"),
            Self::SubjectStale => formatter.write_str("subject digest is stale"),
        }
    }
}

impl std::error::Error for EvidenceError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2PiTaskReportV1 {
    pub schema_version: String,
    pub consumer_binding: Phase2ReportConsumerBinding,
    pub producer_task_id: String,
    pub payload_utf8: String,
    pub payload_sha256: String,
    pub report_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Phase2ReportConsumerBinding {
    pub schema_version: String,
    pub consumer: String,
    pub run_id: String,
    pub repo_key: String,
    pub workstream: String,
    pub purpose_id: String,
    pub action_id: String,
    pub assignment_id: String,
    pub assignment_revision: u32,
    pub run_revision: u64,
    pub boundary_id: String,
    pub subject_digest: String,
    pub binding_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2PiTaskAttestationV2 {
    pub schema_version: String,
    pub producer_request_sha256: String,
    pub consumer_binding: Phase2ReportConsumerBinding,
    pub locator: Phase2Locator,
    pub source_hashes: Phase2SourceHashes,
    pub lifecycle: Phase2Lifecycle,
    pub invocation: Phase2Invocation,
    pub authority: Phase2Authority,
    pub artifacts: Phase2Artifacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Phase2Usage>,
    pub attestation_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Locator {
    pub session_dir: String,
    pub task_id: String,
    pub metadata_ref: String,
    pub output_ref: String,
    pub events_ref: String,
    pub stderr_ref: String,
    pub wrapper_ref: String,
    pub report_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2SourceHashes {
    pub metadata_sha256: String,
    pub output_sha256: String,
    pub events_sha256: String,
    pub stderr_sha256: String,
    pub wrapper_sha256: String,
    pub report_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Lifecycle {
    pub status: String,
    pub is_agent: bool,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
    pub exit_code: i64,
    pub signal: String,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Invocation {
    pub pi_session_id: String,
    pub argv: Vec<String>,
    pub cwd_realpath: String,
    pub provider: String,
    pub model_id: String,
    pub provider_scoped_model_id: String,
    pub api_identity: String,
    pub auth_class: String,
    pub credential_kind: String,
    pub route_class: String,
    pub channel: String,
    pub direct_api_key: bool,
    pub final_stop_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Authority {
    pub repo_root_realpath: String,
    pub start_commit_oid: String,
    pub start_tree_oid: String,
    pub finish_commit_oid: String,
    pub finish_tree_oid: String,
    pub start_status_byte_length: u64,
    pub start_status_sha256: String,
    pub finish_status_byte_length: u64,
    pub finish_status_sha256: String,
    pub status_unchanged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Artifacts {
    pub prompt: Phase2ArtifactBytes,
    pub system_prompt: Phase2ArtifactBytes,
    pub task_output: Phase2ArtifactBytes,
    pub stderr: Phase2ArtifactBytes,
    pub transcript: Phase2ArtifactBytes,
    pub report: Phase2ReportArtifact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2ArtifactBytes {
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2ReportArtifact {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Phase2Usage {
    #[serde(default)]
    pub input: Option<u64>,
    #[serde(default)]
    pub output: Option<u64>,
    #[serde(default)]
    pub cache_read: Option<u64>,
    #[serde(default)]
    pub cache_write: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub cost_total_microusd: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SourcePair {
    pub report_path: PathBuf,
    pub sidecar_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ImportedRefs {
    pub report_ref: AutopilotContentRef,
    pub sidecar_ref: AutopilotContentRef,
}

#[derive(Debug, Clone)]
pub struct BoundProducer {
    pub binding: AutopilotProducerBinding,
    pub binding_ref: AutopilotContentRef,
}

impl EvidenceIdentity {
    /// The durable run identity as a contract `Id`, for use as typed session
    /// identity material. One accessor keeps every consumer reading the same
    /// durable value instead of re-deriving run identity independently.
    #[must_use]
    pub fn run_id_as_id(&self) -> Id {
        Id(self.run_id.0.clone())
    }

    pub fn for_workstream(workstream: &str) -> Result<Self, EvidenceError> {
        let cwd =
            std::env::current_dir().map_err(|error| EvidenceError::Store(error.to_string()))?;
        let repo_key =
            state_root::repo_key(&cwd).map_err(|error| EvidenceError::Store(error.to_string()))?;
        let manifest_path = PathBuf::from(".pi/autopilot")
            .join(workstream)
            .join("run-identity.json");
        if manifest_path.exists() {
            let text = fs::read_to_string(&manifest_path)
                .map_err(|error| EvidenceError::Store(error.to_string()))?;
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct DiskIdentity {
                repo_key: String,
                run_id: String,
                workstream: String,
            }
            let disk: DiskIdentity = serde_json::from_str(&text)
                .map_err(|error| EvidenceError::Store(error.to_string()))?;
            if disk.repo_key != repo_key.0 || disk.workstream != workstream {
                return Err(EvidenceError::Store("run identity mismatch".to_owned()));
            }
            let run_root = run_root_for(&repo_key, &disk.run_id)?;
            return Ok(Self {
                repo_key,
                run_id: Uuidv7(disk.run_id),
                workstream: Id(workstream.to_owned()),
                run_root,
            });
        }
        let run_id = state_root::run_id_from_parts(now_ms()?, random10()?);
        let run_root = run_root_for(&repo_key, &run_id.0)?;
        private_dir(&run_root)?;
        if let Some(parent) = manifest_path.parent() {
            fs::create_dir_all(parent).map_err(|error| EvidenceError::Store(error.to_string()))?;
        }
        #[derive(Serialize)]
        struct DiskIdentity<'a> {
            repo_key: &'a str,
            run_id: &'a str,
            workstream: &'a str,
        }
        create_once_bytes(
            &manifest_path,
            &canonical_json(&DiskIdentity {
                repo_key: &repo_key.0,
                run_id: &run_id.0,
                workstream,
            })?,
        )?;
        Ok(Self {
            repo_key,
            run_id,
            workstream: Id(workstream.to_owned()),
            run_root,
        })
    }
}

pub fn issue_planning_review(
    workstream: &str,
    run_revision: u64,
    planning_manifest_bytes: &[u8],
    work_map_bytes: &[u8],
) -> Result<PlanningReviewIssue, EvidenceError> {
    let identity = EvidenceIdentity::for_workstream(workstream)?;
    let roster =
        Roster::package().map_err(|error| EvidenceError::Store(format!("roster:{error:?}")))?;
    let slot = roster
        .slots()
        .find(|slot| slot.roles.iter().any(|role| role == "plan-reviewer"))
        .ok_or_else(|| EvidenceError::Store("roster missing plan-reviewer".to_owned()))?;
    let route = slot.route();
    roster::guard_route(&route)
        .map_err(|error| EvidenceError::Store(format!("roster:{error:?}")))?;
    if slot.provider != PROVIDER || slot.route != "subscription" {
        return Err(EvidenceError::ChannelForbidden(format!(
            "{} via {}",
            slot.provider, slot.route
        )));
    }
    let subject_digest = planning_subject_digest(planning_manifest_bytes, work_map_bytes)?;
    let assignment_revision = next_assignment_revision(&identity, PURPOSE_PLANNING_REVIEW)?;
    let assignment_id = Id(format!(
        "evi-{}",
        digest_hex(
            format!(
                "autopilot.evidence-assignment-key.v1\0{}\0{}\0{}\0{}",
                identity.run_id.0, PURPOSE_PLANNING_REVIEW, assignment_revision, subject_digest
            )
            .as_bytes()
        )
    ));
    let action_id = Id(format!(
        "eva-{}",
        digest_hex(format!("autopilot.evidence-action-key.v1\0{}", assignment_id.0).as_bytes())
    ));
    let issue_idempotency_key = Id(format!("evidence-issue:v1:{}", assignment_id.0));
    let import_idempotency_key = Id(format!("evidence-import:v1:{}", assignment_id.0));
    let prompt = planning_review_prompt(workstream, planning_manifest_bytes, work_map_bytes);
    let prompt_path = format!("prompts/evidence/{}.md", assignment_id.0);
    let prompt_ref = publish_ref(
        &identity.run_root,
        &prompt_path,
        prompt.as_bytes(),
        EvidenceContentKind::Prompt,
    )?;
    let system_prompt_sha256 = Digest(sha256_tag(SYSTEM_PROMPT.as_bytes()));
    let report_staging_path = format!(
        ".pi/autopilot/{workstream}/evidence-staging/{}.report.v1.json",
        assignment_id.0
    );
    let consumer_binding = consumer_binding_without_hash(
        &identity,
        ConsumerBindingDraft {
            purpose_id: PURPOSE_PLANNING_REVIEW,
            action_id: &action_id,
            assignment_id: &assignment_id,
            assignment_revision,
            run_revision,
            boundary_id: "planning.plan-review.v1",
            subject_digest: &subject_digest,
        },
    );
    let consumer_binding = with_binding_hash(consumer_binding)?;
    let request_without_hash = Phase2PiAttestedRunRequest {
        schema_version: SchemaId(REQUEST_SCHEMA.to_owned()),
        name: format!("Autopilot plan review {workstream}"),
        provider: PROVIDER.to_owned(),
        model: route.model.clone(),
        thinking: ThinkingLevel(route.thinking.clone()),
        system_prompt_utf8: SYSTEM_PROMPT.to_owned(),
        prompt_utf8: prompt.clone(),
        report_path: ContractPath(report_staging_path.clone()),
        timeout_seconds: TIMEOUT_SECONDS,
        idempotency_key: issue_idempotency_key.clone(),
        consumer_binding,
        request_sha256: Digest(String::new()),
    };
    let request_sha256 = canonical_sha256_self(&request_without_hash, "request_sha256")?;
    let request = Phase2PiAttestedRunRequest {
        request_sha256: Digest(request_sha256.clone()),
        ..request_without_hash
    };
    let policy = conflict_policy(Vec::new())?;
    let assignment_without_hash = AutopilotAttestedAssignment {
        schema_version: SchemaId(ASSIGNMENT_SCHEMA.to_owned()),
        run_id: identity.run_id.clone(),
        repo_key: identity.repo_key.clone(),
        workstream: identity.workstream.clone(),
        purpose_id: Id(PURPOSE_PLANNING_REVIEW.to_owned()),
        assignment_id: assignment_id.clone(),
        assignment_revision,
        run_revision,
        action_id: action_id.clone(),
        issue_idempotency_key: issue_idempotency_key.clone(),
        import_idempotency_key: import_idempotency_key.clone(),
        subject_digest: Digest(subject_digest.clone()),
        boundary_id: ContractId("planning.plan-review.v1".to_owned()),
        provider: PROVIDER.to_owned(),
        model: route.model.clone(),
        thinking: ThinkingLevel(route.thinking.clone()),
        required_channel: CHANNEL.to_owned(),
        prompt_ref: prompt_ref.clone(),
        system_prompt_sha256,
        report_staging_path: ContractPath(report_staging_path),
        producer_request_sha256: Digest(request_sha256),
        conflict_policy: policy,
        issued_at_unix_ms: UnixMs(now_ms()?.to_string()),
        supersedes_assignment_id: None,
        assignment_sha256: Digest(String::new()),
    };
    let assignment_sha256 = canonical_sha256_self(&assignment_without_hash, "assignment_sha256")?;
    let assignment = AutopilotAttestedAssignment {
        assignment_sha256: Digest(assignment_sha256),
        ..assignment_without_hash
    };
    let assignment_path = format!("evidence/assignments/{}.json", assignment.assignment_id.0);
    let assignment_ref = publish_json_ref(
        &identity.run_root,
        &assignment_path,
        &assignment,
        EvidenceContentKind::Assignment,
    )?;
    let action_without_hash = AutopilotAttestedAction {
        schema_version: SchemaId(ACTION_SCHEMA.to_owned()),
        action_id: action_id.clone(),
        assignment_id: assignment_id.clone(),
        assignment_revision,
        run_revision,
        assignment_ref: assignment_ref.clone(),
        producer_request: request,
        expires_at_unix_ms: UnixMs(
            (now_ms()? + u64::from(TIMEOUT_SECONDS) * 1000 + 60_000).to_string(),
        ),
        supersession_state: "live".to_owned(),
        action_sha256: Digest(String::new()),
    };
    let action_sha256 = canonical_sha256_self(&action_without_hash, "action_sha256")?;
    let action = AutopilotAttestedAction {
        action_sha256: Digest(action_sha256),
        ..action_without_hash
    };
    let action_path = format!("evidence/actions/{}.json", action.action_id.0);
    let action_ref = publish_json_ref(
        &identity.run_root,
        &action_path,
        &action,
        EvidenceContentKind::Action,
    )?;
    Ok(PlanningReviewIssue {
        action,
        assignment,
        prompt_ref,
        assignment_ref,
        action_ref,
    })
}

pub fn action_ref_for(
    action: &AutopilotAttestedAction,
) -> Result<AutopilotContentRef, EvidenceError> {
    action_content_ref(action)
}

pub fn assignment_ref_from_action(action: &AutopilotAttestedAction) -> AutopilotContentRef {
    action.assignment_ref.clone()
}

pub fn issue_event_refs(issue: &PlanningReviewIssue) -> Vec<Ref> {
    vec![
        content_ref_event(&issue.prompt_ref),
        content_ref_event(&issue.assignment_ref),
        content_ref_event(&issue.action_ref),
        attested_action_ref(&issue.action),
    ]
}

pub fn attested_action_ref(action: &AutopilotAttestedAction) -> Ref {
    Ref(format!(
        "attested-action:{}:{}:{}",
        action.action_id.0, action.assignment_id.0, action.run_revision
    ))
}

pub fn content_ref_event(reference: &AutopilotContentRef) -> Ref {
    Ref(format!(
        "evidence-ref:{}:{}:{}",
        evidence_kind_str(&reference.kind),
        reference.path.0,
        reference.sha256.0
    ))
}

pub fn decode_attested_action_ref(reference: &Ref) -> Option<AutopilotAttestedAction> {
    let rest = reference.0.strip_prefix("attested-action-json:")?;
    serde_json::from_str(rest).ok()
}

pub fn attested_action_json_ref(action: &AutopilotAttestedAction) -> Result<Ref, EvidenceError> {
    Ok(Ref(format!(
        "attested-action-json:{}",
        String::from_utf8(canonical_json(action)?)
            .map_err(|error| EvidenceError::Store(error.to_string()))?
    )))
}

pub fn find_action_from_refs<'a>(
    refs: impl Iterator<Item = &'a Ref>,
    action_id: &str,
    assignment_id: &str,
) -> Result<AutopilotAttestedAction, EvidenceError> {
    let mut found = None;
    for reference in refs {
        if let Some(action) = decode_attested_action_ref(reference)
            && action.action_id.0 == action_id
            && action.assignment_id.0 == assignment_id
        {
            if found.is_some() {
                return Err(EvidenceError::BindingConflict);
            }
            found = Some(action);
        }
    }
    found.ok_or(EvidenceError::MissingAssignment)
}

#[acceptance_boundary(
    id = "evidence.ingress.v1",
    producer = Producer::BackgroundTask,
    visible = true,
    admits = "Only a terminal observation for a Core-issued attested action may import a phase2.pi_task_report.v1 report and phase2.pi_task_attestation.v2 sidecar. Provider/channel must be openai-codex subscription OAuth; v1 sidecars, prose, caller-selected files, and metered/API-key routes are rejected.",
    mode = BoundaryMode::Enforce
)]
pub fn accept_attested_observation(
    action: &AutopilotAttestedAction,
    issue_event_ref: AutopilotEventRef,
    binding_event_ref: AutopilotEventRef,
    observation: &HostToCoreAttestedTaskObservationPayload,
) -> Result<AcceptedEvidence, Rejection> {
    match accept_attested_observation_inner(action, issue_event_ref, binding_event_ref, observation)
    {
        Ok(value) => Ok(value),
        Err(error) => match boundary_runtime(BOUNDARY_ID).reject(error.status()) {
            Err(rejection) => Err(rejection),
            Ok(()) => unreachable!("evidence ingress boundary reject returned ok"),
        },
    }
}

pub fn accept_attested_observation_inner(
    action: &AutopilotAttestedAction,
    issue_event_ref: AutopilotEventRef,
    binding_event_ref: AutopilotEventRef,
    observation: &HostToCoreAttestedTaskObservationPayload,
) -> Result<AcceptedEvidence, EvidenceError> {
    if observation.status != "completed" {
        return Err(EvidenceError::TerminalNotCompleted(
            observation.status.clone(),
        ));
    }
    if observation.action_id != action.action_id
        || observation.assignment_id != action.assignment_id
        || observation.assignment_revision != action.assignment_revision
        || observation.run_revision != action.run_revision
        || observation.producer_request_sha256 != action.producer_request.request_sha256
    {
        return Err(EvidenceError::RequestMismatch(
            "observation/action identity drift".to_owned(),
        ));
    }
    let source = SourcePair {
        report_path: PathBuf::from(&observation.report_source_path.0),
        sidecar_path: PathBuf::from(&observation.sidecar_source_path.0),
    };
    let report_bytes = read_bound_source(&source.report_path, REPORT_LIMIT)?;
    let sidecar_bytes = read_bound_source(&source.sidecar_path, SIDECAR_LIMIT)?;
    let report: Phase2PiTaskReportV1 = serde_json::from_slice(&report_bytes)
        .map_err(|error| EvidenceError::Schema(format!("report:{error}")))?;
    let sidecar: Phase2PiTaskAttestationV2 = serde_json::from_slice(&sidecar_bytes)
        .map_err(|error| EvidenceError::Schema(format!("sidecar:{error}")))?;
    validate_report(action, observation, &report, &report_bytes)?;
    validate_sidecar(action, observation, &report, &sidecar, &sidecar_bytes)?;
    let identity = EvidenceIdentity {
        repo_key: action.producer_request.consumer_binding.repo_key.clone(),
        run_id: action.producer_request.consumer_binding.run_id.clone(),
        workstream: action.producer_request.consumer_binding.workstream.clone(),
        run_root: run_root_for(
            &action.producer_request.consumer_binding.repo_key,
            &action.producer_request.consumer_binding.run_id.0,
        )?,
    };
    let binding = producer_binding(&identity, action, observation, &source)?;
    let binding_ref = publish_json_ref(
        &identity.run_root,
        &format!("evidence/bindings/{}.json", action.assignment_id.0),
        &binding,
        EvidenceContentKind::ProducerBinding,
    )?;
    let report_ref = publish_ref(
        &identity.run_root,
        &format!("evidence/imports/{}/report.v1.json", action.assignment_id.0),
        &report_bytes,
        EvidenceContentKind::Report,
    )?;
    let sidecar_ref = publish_ref(
        &identity.run_root,
        &format!(
            "evidence/imports/{}/producer-attestation.v2.json",
            action.assignment_id.0
        ),
        &sidecar_bytes,
        EvidenceContentKind::ProducerSidecar,
    )?;
    let conflict_check = conflict_check(Vec::new())?;
    let receipt = acceptance_receipt(
        &identity,
        action,
        AcceptanceReceiptRefs {
            producer_binding: &binding_ref,
            report: &report_ref,
            sidecar: &sidecar_ref,
        },
        AcceptanceReceiptArtifacts {
            report: &report,
            sidecar: &sidecar,
        },
        AcceptanceReceiptGate {
            issue_event_ref,
            binding_event_ref,
            conflict_check,
        },
    )?;
    let receipt_ref = publish_json_ref(
        &identity.run_root,
        &format!(
            "evidence/receipts/{}.acceptance.v1.json",
            action.assignment_id.0
        ),
        &receipt,
        EvidenceContentKind::AcceptanceReceipt,
    )?;
    Ok(AcceptedEvidence {
        receipt,
        receipt_ref,
        report,
        sidecar,
        envelope: None,
    })
}

pub fn close_planning_envelope(
    action: &AutopilotAttestedAction,
    receipt_ref: AutopilotContentRef,
    through_sequence: u64,
    event_prefix_bytes: &[u8],
) -> Result<(AutopilotEvidenceEnvelopeManifest, AutopilotContentRef), EvidenceError> {
    let identity = EvidenceIdentity {
        repo_key: action.producer_request.consumer_binding.repo_key.clone(),
        run_id: action.producer_request.consumer_binding.run_id.clone(),
        workstream: action.producer_request.consumer_binding.workstream.clone(),
        run_root: run_root_for(
            &action.producer_request.consumer_binding.repo_key,
            &action.producer_request.consumer_binding.run_id.0,
        )?,
    };
    let mut members = vec![action.assignment_ref.clone(), receipt_ref.clone()];
    members.sort_by(|a, b| {
        (evidence_kind_str(&a.kind), &a.path.0, &a.sha256.0).cmp(&(
            evidence_kind_str(&b.kind),
            &b.path.0,
            &b.sha256.0,
        ))
    });
    let without_hash = AutopilotEvidenceEnvelopeManifest {
        schema_version: SchemaId("autopilot.evidence_envelope_manifest.v1".to_owned()),
        manifest_id: Id(format!("eem-planning-{}", action.assignment_id.0)),
        run_id: identity.run_id.clone(),
        repo_key: identity.repo_key.clone(),
        workstream: identity.workstream.clone(),
        scope: "planning".to_owned(),
        manifest_revision: 1,
        subject_digest: action
            .producer_request
            .consumer_binding
            .subject_digest
            .clone(),
        previous_manifest_ref: None,
        closed_through_event_sequence: through_sequence,
        event_prefix_sha256: Digest(sha256_tag(event_prefix_bytes)),
        members,
        active_acceptance_receipt_refs: vec![receipt_ref],
        supersession_receipt_refs: Vec::new(),
        failure_receipt_refs: Vec::new(),
        excluded_self: true,
        closed_at_unix_ms: UnixMs(now_ms()?.to_string()),
        manifest_sha256: Digest(String::new()),
    };
    let manifest_sha256 = canonical_sha256_self(&without_hash, "manifest_sha256")?;
    let manifest = AutopilotEvidenceEnvelopeManifest {
        manifest_sha256: Digest(manifest_sha256),
        ..without_hash
    };
    let manifest_ref = publish_json_ref(
        &identity.run_root,
        "evidence/envelopes/planning.revision-1.manifest.v1.json",
        &manifest,
        EvidenceContentKind::EnvelopeManifest,
    )?;
    Ok((manifest, manifest_ref))
}

pub fn failure_receipt(
    action: &AutopilotAttestedAction,
    state: &str,
    code: EvidenceErrorCode,
) -> Result<(AutopilotEvidenceFailureReceipt, AutopilotContentRef), EvidenceError> {
    let identity = EvidenceIdentity {
        repo_key: action.producer_request.consumer_binding.repo_key.clone(),
        run_id: action.producer_request.consumer_binding.run_id.clone(),
        workstream: action.producer_request.consumer_binding.workstream.clone(),
        run_root: run_root_for(
            &action.producer_request.consumer_binding.repo_key,
            &action.producer_request.consumer_binding.run_id.0,
        )?,
    };
    let without_hash = AutopilotEvidenceFailureReceipt {
        schema_version: SchemaId("autopilot.evidence_failure_receipt.v1".to_owned()),
        run_id: identity.run_id,
        workstream: identity.workstream,
        purpose_id: Id(PURPOSE_PLANNING_REVIEW.to_owned()),
        assignment_id: action.assignment_id.clone(),
        action_id: action.action_id.clone(),
        assignment_revision: action.assignment_revision,
        run_revision: action.run_revision,
        state: state.to_owned(),
        code,
        expected_refs: vec![action.assignment_ref.clone()],
        observed_hashes: Vec::new(),
        occurred_at_unix_ms: UnixMs(now_ms()?.to_string()),
        failure_sha256: Digest(String::new()),
    };
    let hash = canonical_sha256_self(&without_hash, "failure_sha256")?;
    let receipt = AutopilotEvidenceFailureReceipt {
        failure_sha256: Digest(hash),
        ..without_hash
    };
    let reference = publish_json_ref(
        &identity.run_root,
        &format!(
            "evidence/failures/{}.{}.v1.json",
            action.assignment_id.0,
            evidence_code_str(&receipt.code)
        ),
        &receipt,
        EvidenceContentKind::FailureReceipt,
    )?;
    Ok((receipt, reference))
}

fn validate_report(
    action: &AutopilotAttestedAction,
    observation: &HostToCoreAttestedTaskObservationPayload,
    report: &Phase2PiTaskReportV1,
    bytes: &[u8],
) -> Result<(), EvidenceError> {
    if report.schema_version != "phase2.pi_task_report.v1" {
        return Err(EvidenceError::Schema(report.schema_version.clone()));
    }
    if report.producer_task_id != observation.producer_task_id.0 {
        return Err(EvidenceError::RequestMismatch(
            "report task id drift".to_owned(),
        ));
    }
    if report.payload_utf8.is_empty() {
        return Err(EvidenceError::Schema("empty payload".to_owned()));
    }
    if report.payload_sha256 != sha256_tag(report.payload_utf8.as_bytes()) {
        return Err(EvidenceError::Hash("payload hash mismatch".to_owned()));
    }
    if report.report_sha256 != canonical_sha256_self(report, "report_sha256")? {
        return Err(EvidenceError::Hash("report self hash mismatch".to_owned()));
    }
    if report.report_sha256 != sha256_tag(bytes)
        && report.report_sha256 != canonical_sha256_self(report, "report_sha256")?
    {
        return Err(EvidenceError::Hash("report hash mismatch".to_owned()));
    }
    validate_report_binding(action, &report.consumer_binding)
}

fn validate_sidecar(
    action: &AutopilotAttestedAction,
    observation: &HostToCoreAttestedTaskObservationPayload,
    report: &Phase2PiTaskReportV1,
    sidecar: &Phase2PiTaskAttestationV2,
    bytes: &[u8],
) -> Result<(), EvidenceError> {
    if sidecar.schema_version != "phase2.pi_task_attestation.v2" {
        return Err(EvidenceError::Schema(sidecar.schema_version.clone()));
    }
    if sidecar.producer_request_sha256 != action.producer_request.request_sha256.0 {
        return Err(EvidenceError::RequestMismatch(
            "sidecar request hash drift".to_owned(),
        ));
    }
    if sidecar.locator.task_id != observation.producer_task_id.0
        || sidecar.locator.task_id != report.producer_task_id
    {
        return Err(EvidenceError::RequestMismatch(
            "sidecar task id drift".to_owned(),
        ));
    }
    if sidecar.source_hashes.report_sha256 != report.report_sha256
        || sidecar.artifacts.report.sha256 != report.report_sha256
    {
        return Err(EvidenceError::Hash(
            "sidecar/report hash mismatch".to_owned(),
        ));
    }
    if sidecar.attestation_sha256 != canonical_sha256_self(sidecar, "attestation_sha256")?
        && sidecar.attestation_sha256 != sha256_tag(bytes)
    {
        return Err(EvidenceError::Hash("sidecar self hash mismatch".to_owned()));
    }
    validate_report_binding(action, &sidecar.consumer_binding)?;
    if sidecar.consumer_binding != report.consumer_binding {
        return Err(EvidenceError::RequestMismatch(
            "report/sidecar consumer binding drift".to_owned(),
        ));
    }
    if sidecar.lifecycle.status != "completed"
        || !sidecar.lifecycle.is_agent
        || sidecar.lifecycle.exit_code != 0
        || sidecar.lifecycle.signal != "none"
    {
        return Err(EvidenceError::TerminalNotCompleted(
            "sidecar lifecycle".to_owned(),
        ));
    }
    if sidecar.invocation.provider != PROVIDER {
        return Err(EvidenceError::ProviderMismatch(
            sidecar.invocation.provider.clone(),
        ));
    }
    if sidecar.invocation.model_id != action.producer_request.model {
        return Err(EvidenceError::ModelMismatch(
            sidecar.invocation.model_id.clone(),
        ));
    }
    if sidecar.invocation.auth_class != AUTH_CLASS
        || sidecar.invocation.credential_kind != CREDENTIAL_KIND
        || sidecar.invocation.route_class != ROUTE_CLASS
        || sidecar.invocation.channel != CHANNEL
        || sidecar.invocation.direct_api_key != DIRECT_API_KEY
    {
        return Err(EvidenceError::ChannelForbidden(format!(
            "{}/{}/{}/{}",
            sidecar.invocation.auth_class,
            sidecar.invocation.credential_kind,
            sidecar.invocation.route_class,
            sidecar.invocation.channel
        )));
    }
    if sidecar.invocation.final_stop_reason != "stop" {
        return Err(EvidenceError::TerminalNotCompleted(
            "non-stop final reason".to_owned(),
        ));
    }
    if !sidecar.authority.status_unchanged
        || sidecar.authority.start_commit_oid != sidecar.authority.finish_commit_oid
        || sidecar.authority.start_tree_oid != sidecar.authority.finish_tree_oid
        || sidecar.authority.start_status_sha256 != sidecar.authority.finish_status_sha256
    {
        return Err(EvidenceError::SubjectStale);
    }
    if sidecar.artifacts.prompt.sha256 != action.assignment_ref.sha256.0
        && sidecar.artifacts.prompt.sha256
            != action.producer_request.consumer_binding.subject_digest.0
    {
        // The paired producer hashes the actual prompt; compare against the request's prompt bytes below.
        if sidecar.artifacts.prompt.sha256
            != sha256_tag(action.producer_request.prompt_utf8.as_bytes())
        {
            return Err(EvidenceError::Hash("prompt hash mismatch".to_owned()));
        }
    }
    if sidecar.artifacts.system_prompt.sha256
        != sha256_tag(action.producer_request.system_prompt_utf8.as_bytes())
    {
        return Err(EvidenceError::Hash(
            "system prompt hash mismatch".to_owned(),
        ));
    }
    if let Some(usage) = &sidecar.usage
        && usage.cost_total_microusd.unwrap_or(0) != 0
    {
        return Err(EvidenceError::MeteredUsage);
    }
    Ok(())
}

fn validate_report_binding(
    action: &AutopilotAttestedAction,
    binding: &Phase2ReportConsumerBinding,
) -> Result<(), EvidenceError> {
    let expected = &action.producer_request.consumer_binding;
    if binding.schema_version != CONSUMER_BINDING_SCHEMA
        || binding.consumer != "pi-autopilot"
        || binding.run_id != expected.run_id.0
        || binding.repo_key != expected.repo_key.0
        || binding.workstream != expected.workstream.0
        || binding.purpose_id != expected.purpose_id.0
        || binding.action_id != expected.action_id.0
        || binding.assignment_id != expected.assignment_id.0
        || binding.assignment_revision != expected.assignment_revision
        || binding.run_revision != expected.run_revision
        || binding.boundary_id != expected.boundary_id.0
        || binding.subject_digest != expected.subject_digest.0
        || binding.binding_sha256 != expected.binding_sha256.0
    {
        return Err(EvidenceError::RequestMismatch(
            "consumer binding mismatch".to_owned(),
        ));
    }
    Ok(())
}

fn producer_binding(
    identity: &EvidenceIdentity,
    action: &AutopilotAttestedAction,
    observation: &HostToCoreAttestedTaskObservationPayload,
    source: &SourcePair,
) -> Result<AutopilotProducerBinding, EvidenceError> {
    let without_hash = AutopilotProducerBinding {
        schema_version: SchemaId("autopilot.producer_binding.v1".to_owned()),
        run_id: identity.run_id.clone(),
        workstream: identity.workstream.clone(),
        action_id: action.action_id.clone(),
        assignment_id: action.assignment_id.clone(),
        assignment_revision: action.assignment_revision,
        run_revision: action.run_revision,
        assignment_ref: action.assignment_ref.clone(),
        action_ref: action_content_ref(action)?,
        producer_task_id: observation.producer_task_id.clone(),
        producer_request_sha256: action.producer_request.request_sha256.clone(),
        report_source_path: ContractPath(path_string(&source.report_path)?),
        sidecar_source_path: ContractPath(path_string(&source.sidecar_path)?),
        bound_at_unix_ms: UnixMs(now_ms()?.to_string()),
        binding_sha256: Digest(String::new()),
    };
    let hash = canonical_sha256_self(&without_hash, "binding_sha256")?;
    Ok(AutopilotProducerBinding {
        binding_sha256: Digest(hash),
        ..without_hash
    })
}

struct AcceptanceReceiptRefs<'a> {
    producer_binding: &'a AutopilotContentRef,
    report: &'a AutopilotContentRef,
    sidecar: &'a AutopilotContentRef,
}

struct AcceptanceReceiptArtifacts<'a> {
    report: &'a Phase2PiTaskReportV1,
    sidecar: &'a Phase2PiTaskAttestationV2,
}

struct AcceptanceReceiptGate {
    issue_event_ref: AutopilotEventRef,
    binding_event_ref: AutopilotEventRef,
    conflict_check: AutopilotEvidenceConflictCheck,
}

fn acceptance_receipt(
    identity: &EvidenceIdentity,
    action: &AutopilotAttestedAction,
    refs: AcceptanceReceiptRefs<'_>,
    artifacts: AcceptanceReceiptArtifacts<'_>,
    gate: AcceptanceReceiptGate,
) -> Result<AutopilotEvidenceAcceptanceReceipt, EvidenceError> {
    let receipt_id = Id(format!(
        "ear-{}",
        digest_hex(
            format!(
                "autopilot.evidence-acceptance.v1\0{}\0{}",
                action.assignment_id.0, action.producer_request.request_sha256.0
            )
            .as_bytes()
        )
    ));
    let without_hash = AutopilotEvidenceAcceptanceReceipt {
        schema_version: SchemaId("autopilot.evidence_acceptance_receipt.v1".to_owned()),
        receipt_id,
        run_id: identity.run_id.clone(),
        repo_key: identity.repo_key.clone(),
        workstream: identity.workstream.clone(),
        purpose_id: action.producer_request.consumer_binding.purpose_id.clone(),
        assignment_id: action.assignment_id.clone(),
        action_id: action.action_id.clone(),
        assignment_revision: action.assignment_revision,
        run_revision: action.run_revision,
        subject_digest: action
            .producer_request
            .consumer_binding
            .subject_digest
            .clone(),
        boundary_id: action.producer_request.consumer_binding.boundary_id.clone(),
        assignment_ref: action.assignment_ref.clone(),
        action_ref: action_content_ref(action)?,
        producer_binding_ref: refs.producer_binding.clone(),
        report_ref: refs.report.clone(),
        producer_sidecar_ref: refs.sidecar.clone(),
        producer_task_id: Id(artifacts.report.producer_task_id.clone()),
        producer_request_sha256: action.producer_request.request_sha256.clone(),
        prompt_sha256: Digest(sha256_tag(action.producer_request.prompt_utf8.as_bytes())),
        system_prompt_sha256: Digest(sha256_tag(
            action.producer_request.system_prompt_utf8.as_bytes(),
        )),
        payload_sha256: Digest(artifacts.report.payload_sha256.clone()),
        provider: PROVIDER.to_owned(),
        model: action.producer_request.model.clone(),
        channel: CHANNEL.to_owned(),
        auth_class: AUTH_CLASS.to_owned(),
        credential_kind: CREDENTIAL_KIND.to_owned(),
        direct_api_key: DIRECT_API_KEY,
        pi_session_id: Id(artifacts.sidecar.invocation.pi_session_id.clone()),
        conflict_check: gate.conflict_check,
        issue_idempotency_key: action.producer_request.idempotency_key.clone(),
        import_idempotency_key: Id(format!("evidence-import:v1:{}", action.assignment_id.0)),
        issue_event_ref: gate.issue_event_ref,
        binding_event_ref: gate.binding_event_ref,
        supersession_state_at_acceptance: "active".to_owned(),
        accepted_at_unix_ms: UnixMs(artifacts.sidecar.lifecycle.end_time_ms.to_string()),
        receipt_sha256: Digest(String::new()),
    };
    let hash = canonical_sha256_self(&without_hash, "receipt_sha256")?;
    Ok(AutopilotEvidenceAcceptanceReceipt {
        receipt_sha256: Digest(hash),
        ..without_hash
    })
}

fn action_content_ref(
    action: &AutopilotAttestedAction,
) -> Result<AutopilotContentRef, EvidenceError> {
    let relative = format!("evidence/actions/{}.json", action.action_id.0);
    let bytes = canonical_json(action)?;
    Ok(AutopilotContentRef {
        schema_version: SchemaId(CONTENT_REF_SCHEMA.to_owned()),
        kind: EvidenceContentKind::Action,
        path: ContractPath(relative),
        byte_length: UnixMs(bytes.len().to_string()),
        sha256: Digest(sha256_tag(&bytes)),
    })
}

fn conflict_policy(
    distinct: Vec<AutopilotContentRef>,
) -> Result<AutopilotEvidenceConflictPolicy, EvidenceError> {
    let without_hash = AutopilotEvidenceConflictPolicy {
        schema_version: SchemaId("autopilot.evidence_conflict_policy.v1".to_owned()),
        distinct_from_receipt_refs: distinct,
        forbid_same_assignment: true,
        forbid_same_action: true,
        forbid_same_session: true,
        require_subject_current: true,
        policy_sha256: Digest(String::new()),
    };
    let hash = canonical_sha256_self(&without_hash, "policy_sha256")?;
    Ok(AutopilotEvidenceConflictPolicy {
        policy_sha256: Digest(hash),
        ..without_hash
    })
}

fn conflict_check(
    compared: Vec<AutopilotContentRef>,
) -> Result<AutopilotEvidenceConflictCheck, EvidenceError> {
    let without_hash = AutopilotEvidenceConflictCheck {
        schema_version: SchemaId("autopilot.evidence_conflict_check.v1".to_owned()),
        compared_receipt_refs: compared,
        assignment_conflicts: Vec::new(),
        action_conflicts: Vec::new(),
        session_conflicts: Vec::new(),
        subject_conflicts: Vec::new(),
        provider_channel_conflicts: Vec::new(),
        status: "clear".to_owned(),
        check_sha256: Digest(String::new()),
    };
    let hash = canonical_sha256_self(&without_hash, "check_sha256")?;
    Ok(AutopilotEvidenceConflictCheck {
        check_sha256: Digest(hash),
        ..without_hash
    })
}

struct ConsumerBindingDraft<'a> {
    purpose_id: &'a str,
    action_id: &'a Id,
    assignment_id: &'a Id,
    assignment_revision: u32,
    run_revision: u64,
    boundary_id: &'a str,
    subject_digest: &'a str,
}

fn consumer_binding_without_hash(
    identity: &EvidenceIdentity,
    draft: ConsumerBindingDraft<'_>,
) -> Phase2PiConsumerBinding {
    Phase2PiConsumerBinding {
        schema_version: SchemaId(CONSUMER_BINDING_SCHEMA.to_owned()),
        consumer: "pi-autopilot".to_owned(),
        run_id: identity.run_id.clone(),
        repo_key: identity.repo_key.clone(),
        workstream: identity.workstream.clone(),
        purpose_id: Id(draft.purpose_id.to_owned()),
        action_id: draft.action_id.clone(),
        assignment_id: draft.assignment_id.clone(),
        assignment_revision: draft.assignment_revision,
        run_revision: draft.run_revision,
        boundary_id: ContractId(draft.boundary_id.to_owned()),
        subject_digest: Digest(draft.subject_digest.to_owned()),
        binding_sha256: Digest(String::new()),
    }
}

fn with_binding_hash(
    binding: Phase2PiConsumerBinding,
) -> Result<Phase2PiConsumerBinding, EvidenceError> {
    let hash = canonical_sha256_self(&binding, "binding_sha256")?;
    Ok(Phase2PiConsumerBinding {
        binding_sha256: Digest(hash),
        ..binding
    })
}

fn planning_subject_digest(
    planning_manifest_bytes: &[u8],
    work_map_bytes: &[u8],
) -> Result<String, EvidenceError> {
    #[derive(Serialize)]
    struct Subject<'a> {
        schema_version: &'a str,
        authority_set_id: &'a str,
        planning_manifest_sha256: String,
        work_map_sha256: String,
    }
    let value = Subject {
        schema_version: "autopilot.planning_review_subject.v1",
        authority_set_id: "planning-authority",
        planning_manifest_sha256: sha256_tag(planning_manifest_bytes),
        work_map_sha256: sha256_tag(work_map_bytes),
    };
    Ok(sha256_tag(&canonical_json(&value)?))
}

fn planning_review_prompt(
    workstream: &str,
    planning_manifest_bytes: &[u8],
    work_map_bytes: &[u8],
) -> String {
    format!(
        "Review the Autopilot plan for workstream `{workstream}`.\n\nPlanning manifest SHA-256: {}\nWork map SHA-256: {}\n\nReturn a planning.plan-review.v1 verdict. Overall PASS is required for approval; FAIL, BLOCKED, NEEDS_FIX, advisory-only prose, or unclassified output is not approval.\n\n--- planning manifest ---\n{}\n\n--- work map ---\n{}\n",
        sha256_tag(planning_manifest_bytes),
        sha256_tag(work_map_bytes),
        String::from_utf8_lossy(planning_manifest_bytes),
        String::from_utf8_lossy(work_map_bytes)
    )
}

fn next_assignment_revision(
    identity: &EvidenceIdentity,
    purpose: &str,
) -> Result<u32, EvidenceError> {
    let dir = identity.run_root.join("evidence/assignments");
    if !dir.exists() {
        return Ok(1);
    }
    let mut max_rev = 0_u32;
    for entry in fs::read_dir(&dir).map_err(|error| EvidenceError::Store(error.to_string()))? {
        let path = entry
            .map_err(|error| EvidenceError::Store(error.to_string()))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(|error| {
            EvidenceError::Store(format!(
                "assignment read:{}:{}",
                path.display(),
                bound_detail(&error.to_string())
            ))
        })?;
        let assignment: AutopilotAttestedAssignment =
            serde_json::from_str(&text).map_err(|error| {
                EvidenceError::Schema(format!(
                    "assignment parse:{}:{}",
                    path.display(),
                    bound_detail(&error.to_string())
                ))
            })?;
        if assignment.purpose_id.0 == purpose {
            max_rev = max_rev.max(assignment.assignment_revision);
        }
    }
    max_rev.checked_add(1).ok_or_else(|| {
        EvidenceError::Store(format!(
            "assignment revision overflow:{}:{}",
            dir.display(),
            max_rev
        ))
    })
}

pub fn publish_json_ref<T: Serialize>(
    root: &Path,
    relative: &str,
    value: &T,
    kind: EvidenceContentKind,
) -> Result<AutopilotContentRef, EvidenceError> {
    publish_ref(root, relative, &canonical_json(value)?, kind)
}

pub fn publish_ref(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    kind: EvidenceContentKind,
) -> Result<AutopilotContentRef, EvidenceError> {
    validate_relative_path(relative)?;
    let target = root.join(relative);
    create_once_bytes(&target, bytes)?;
    Ok(AutopilotContentRef {
        schema_version: SchemaId(CONTENT_REF_SCHEMA.to_owned()),
        kind,
        path: ContractPath(relative.to_owned()),
        byte_length: UnixMs(bytes.len().to_string()),
        sha256: Digest(sha256_tag(bytes)),
    })
}

pub fn create_once_bytes(path: &Path, bytes: &[u8]) -> Result<(), EvidenceError> {
    if let Some(parent) = path.parent() {
        private_dir(parent)?;
    }
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
    {
        Ok(mut file) => {
            private_handle(&file)?;
            file.write_all(bytes)
                .map_err(|error| EvidenceError::Store(error.to_string()))?;
            file.sync_all()
                .map_err(|error| EvidenceError::Store(error.to_string()))?;
            if let Some(parent) = path.parent() {
                sync_dir(parent)?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(EvidenceError::Store(
            format!("create-once conflict: {}", path.display()),
        )),
        Err(error) => Err(EvidenceError::Store(error.to_string())),
    }
}

fn read_bound_source(path: &Path, limit: u64) -> Result<Vec<u8>, EvidenceError> {
    if !path.is_relative() {
        return Err(EvidenceError::SourcePath);
    }
    reject_path_components(path)?;
    let display = path.to_string_lossy();
    if !(display.starts_with(".pi/tasks/") || display.starts_with(".pi/autopilot/")) {
        return Err(EvidenceError::SourcePath);
    }
    reject_existing_link_ancestors(path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| EvidenceError::SourceRead(error.to_string()))?;
    if metadata.file_type().is_symlink() {
        return Err(EvidenceError::SourcePath);
    }
    if !metadata.file_type().is_file() {
        return Err(EvidenceError::SourcePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(EvidenceError::SourcePath);
        }
    }
    if metadata.len() > limit {
        return Err(EvidenceError::SourceRead("source too large".to_owned()));
    }
    let mut file =
        fs::File::open(path).map_err(|error| EvidenceError::SourceRead(error.to_string()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| EvidenceError::SourceRead(error.to_string()))?;
    let after = file
        .metadata()
        .map_err(|error| EvidenceError::SourceRead(error.to_string()))?;
    if after.len() != metadata.len() {
        return Err(EvidenceError::SourceRead("source size drift".to_owned()));
    }
    if u64::try_from(bytes.len())
        .map_err(|_| EvidenceError::SourceRead("source too large".to_owned()))?
        != metadata.len()
    {
        return Err(EvidenceError::SourceRead("source size drift".to_owned()));
    }
    Ok(bytes)
}

fn reject_existing_link_ancestors(path: &Path) -> Result<(), EvidenceError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(EvidenceError::SourcePath);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(EvidenceError::SourceRead(error.to_string())),
        }
    }
    Ok(())
}

fn validate_relative_path(relative: &str) -> Result<(), EvidenceError> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.contains('\0')
    {
        return Err(EvidenceError::SourcePath);
    }
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(EvidenceError::SourcePath);
        }
    }
    Ok(())
}

fn reject_path_components(path: &Path) -> Result<(), EvidenceError> {
    for component in path.components() {
        match component {
            Component::ParentDir | Component::CurDir => return Err(EvidenceError::SourcePath),
            Component::Normal(part) if part.to_string_lossy().contains('\0') => {
                return Err(EvidenceError::SourcePath);
            }
            _ => {}
        }
    }
    Ok(())
}

fn run_root_for(repo_key: &Base32, run_id: &str) -> Result<PathBuf, EvidenceError> {
    let home =
        std::env::var_os("HOME").ok_or_else(|| EvidenceError::Store("HOME missing".to_owned()))?;
    Ok(PathBuf::from(home)
        .join(".pi/agent/autopilot/v2/runs")
        .join(&repo_key.0)
        .join(run_id))
}

fn private_dir(path: &Path) -> Result<(), EvidenceError> {
    fs::create_dir_all(path).map_err(|error| EvidenceError::Store(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| EvidenceError::Store(error.to_string()))?;
    }
    Ok(())
}

fn private_handle(_file: &fs::File) -> Result<(), EvidenceError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| EvidenceError::Store(error.to_string()))?;
    }
    Ok(())
}

fn sync_dir(_path: &Path) -> Result<(), EvidenceError> {
    #[cfg(unix)]
    {
        let dir = fs::File::open(_path).map_err(|error| EvidenceError::Store(error.to_string()))?;
        dir.sync_all()
            .map_err(|error| EvidenceError::Store(error.to_string()))?;
    }
    Ok(())
}

pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, EvidenceError> {
    let json =
        serde_json::to_value(value).map_err(|error| EvidenceError::Store(error.to_string()))?;
    let mut out = Vec::new();
    write_canonical(&json, &mut out)?;
    Ok(out)
}

fn canonical_sha256_self<T: Serialize>(
    value: &T,
    self_field: &str,
) -> Result<String, EvidenceError> {
    let mut json =
        serde_json::to_value(value).map_err(|error| EvidenceError::Store(error.to_string()))?;
    if let Value::Object(map) = &mut json {
        map.remove(self_field);
    }
    let mut out = Vec::new();
    write_canonical(&json, &mut out)?;
    Ok(sha256_tag(&out))
}

fn write_canonical(value: &Value, out: &mut Vec<u8>) -> Result<(), EvidenceError> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(v) => out.extend_from_slice(if *v { b"true" } else { b"false" }),
        Value::Number(number) => out.extend_from_slice(number.to_string().as_bytes()),
        Value::String(text) => serde_json::to_writer(out, text)
            .map_err(|error| EvidenceError::Store(error.to_string()))?,
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_canonical(item, out)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let sorted = map.iter().collect::<BTreeMap<_, _>>();
            out.push(b'{');
            for (index, (key, item)) in sorted.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key)
                    .map_err(|error| EvidenceError::Store(error.to_string()))?;
                out.push(b':');
                write_canonical(item, out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

pub fn sha256_tag(bytes: &[u8]) -> String {
    format!("sha256:{}", digest_hex(bytes))
}
fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(hex(byte >> 4));
        out.push(hex(byte & 0x0f));
    }
    out
}

fn hex(nibble: u8) -> char {
    char::from(if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + (nibble - 10)
    })
}

fn now_ms() -> Result<u64, EvidenceError> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| EvidenceError::Store(error.to_string()))?
        .as_millis();
    u64::try_from(ms).map_err(|_| EvidenceError::Store("time overflow".to_owned()))
}

fn random10() -> Result<[u8; 10], EvidenceError> {
    let mut bytes = [0_u8; 10];
    fs::File::open("/dev/urandom")
        .map_err(|error| EvidenceError::Store(error.to_string()))?
        .read_exact(&mut bytes)
        .map_err(|error| EvidenceError::Store(error.to_string()))?;
    Ok(bytes)
}

fn path_string(path: &Path) -> Result<String, EvidenceError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(EvidenceError::SourcePath)
}

fn evidence_kind_str(kind: &EvidenceContentKind) -> &'static str {
    match kind {
        EvidenceContentKind::AcceptanceReceipt => "acceptance-receipt",
        EvidenceContentKind::Action => "action",
        EvidenceContentKind::Assignment => "assignment",
        EvidenceContentKind::EnvelopeManifest => "envelope-manifest",
        EvidenceContentKind::FailureReceipt => "failure-receipt",
        EvidenceContentKind::ProducerBinding => "producer-binding",
        EvidenceContentKind::ProducerSidecar => "producer-sidecar",
        EvidenceContentKind::Prompt => "prompt",
        EvidenceContentKind::Report => "report",
        EvidenceContentKind::SupersessionReceipt => "supersession-receipt",
        EvidenceContentKind::Transcript => "transcript",
    }
}

pub(crate) fn bound_detail(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= 160 {
        normalized
    } else {
        format!("{}…", normalized.chars().take(159).collect::<String>())
    }
}

fn evidence_code_from(value: &str) -> EvidenceErrorCode {
    serde_json::from_str(&format!("\"{}\"", value)).expect("known evidence error code")
}

fn evidence_code_str(code: &EvidenceErrorCode) -> &'static str {
    match code {
        EvidenceErrorCode::EVIDENCEACTIONEXPIRED => "EVIDENCE_ACTION_EXPIRED",
        EvidenceErrorCode::EVIDENCEACTIONNOTISSUED => "EVIDENCE_ACTION_NOT_ISSUED",
        EvidenceErrorCode::EVIDENCEACTIONSUPERSEDED => "EVIDENCE_ACTION_SUPERSEDED",
        EvidenceErrorCode::EVIDENCEASSIGNMENTCONFLICT => "EVIDENCE_ASSIGNMENT_CONFLICT",
        EvidenceErrorCode::EVIDENCEBOUNDARYREJECTED => "EVIDENCE_BOUNDARY_REJECTED",
        EvidenceErrorCode::EVIDENCECHANNELFORBIDDEN => "EVIDENCE_CHANNEL_FORBIDDEN",
        EvidenceErrorCode::EVIDENCEENVELOPEMEMBERMISMATCH => "EVIDENCE_ENVELOPE_MEMBER_MISMATCH",
        EvidenceErrorCode::EVIDENCEENVELOPEOPEN => "EVIDENCE_ENVELOPE_OPEN",
        EvidenceErrorCode::EVIDENCEEVENTLOGCORRUPT => "EVIDENCE_EVENT_LOG_CORRUPT",
        EvidenceErrorCode::EVIDENCEHASHMISMATCH => "EVIDENCE_HASH_MISMATCH",
        EvidenceErrorCode::EVIDENCEIDEMPOTENCYCONFLICT => "EVIDENCE_IDEMPOTENCY_CONFLICT",
        EvidenceErrorCode::EVIDENCEMETEREDUSAGEOBSERVED => "EVIDENCE_METERED_USAGE_OBSERVED",
        EvidenceErrorCode::EVIDENCEMODELMISMATCH => "EVIDENCE_MODEL_MISMATCH",
        EvidenceErrorCode::EVIDENCEPRODUCERREQUESTMISMATCH => "EVIDENCE_PRODUCER_REQUEST_MISMATCH",
        EvidenceErrorCode::EVIDENCEPRODUCERUNAVAILABLE => "EVIDENCE_PRODUCER_UNAVAILABLE",
        EvidenceErrorCode::EVIDENCEPROSENOTCONTRACT => "EVIDENCE_PROSE_NOT_CONTRACT",
        EvidenceErrorCode::EVIDENCEPROVIDERMISMATCH => "EVIDENCE_PROVIDER_MISMATCH",
        EvidenceErrorCode::EVIDENCESCHEMAUNSUPPORTED => "EVIDENCE_SCHEMA_UNSUPPORTED",
        EvidenceErrorCode::EVIDENCESESSIONCONFLICT => "EVIDENCE_SESSION_CONFLICT",
        EvidenceErrorCode::EVIDENCESOURCEMISSING => "EVIDENCE_SOURCE_MISSING",
        EvidenceErrorCode::EVIDENCESOURCENOTREGULAR => "EVIDENCE_SOURCE_NOT_REGULAR",
        EvidenceErrorCode::EVIDENCESOURCEPATHINVALID => "EVIDENCE_SOURCE_PATH_INVALID",
        EvidenceErrorCode::EVIDENCESOURCESYMLINK => "EVIDENCE_SOURCE_SYMLINK",
        EvidenceErrorCode::EVIDENCESTOREIO => "EVIDENCE_STORE_IO",
        EvidenceErrorCode::EVIDENCESUBJECTSTALE => "EVIDENCE_SUBJECT_STALE",
        EvidenceErrorCode::EVIDENCESUPERSESSIONINVALID => "EVIDENCE_SUPERSESSION_INVALID",
        EvidenceErrorCode::EVIDENCETASKBINDINGCONFLICT => "EVIDENCE_TASK_BINDING_CONFLICT",
        EvidenceErrorCode::EVIDENCETERMINALNOTCOMPLETED => "EVIDENCE_TERMINAL_NOT_COMPLETED",
        EvidenceErrorCode::EVIDENCEUNDECLAREDINPUT => "EVIDENCE_UNDECLARED_INPUT",
    }
}

#[cfg(test)]
#[path = "../../tests/unit/evidence_revision.rs"]
mod revision_tests;
