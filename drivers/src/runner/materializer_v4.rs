//! Core-owned V4 vendoring materialization. Sources are read once from the
//! selected lane worktree after it exists; planning never authorizes a repository snapshot.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use kernel::generated::{Id, Path as ContractPath, Sha};
use serde::{Deserialize, Serialize};

use crate::allocation::{ApprovedUnit, ApprovedUnitVendoringV2};
use crate::seam::{self, ApprovedPlanArtifactV2, ApprovedPlanV2BindingV1};

use super::{
    MAX_AUTHORITY_SOURCE_BYTES, MAX_VENDORED_SOURCE_BYTES, RunnerError,
    read_binary_leaf_exact_mode, read_binary_leaf_with_allowed_mode, read_bounded_authority_file,
    sha256_hex, write_binary_leaf_create_once_exact_mode, write_bounded_file_create_once,
};

pub const DELIVERY_ASSIGNMENT_V4_SCHEMA: &str = "autopilot.delivery_assignment.v4";
pub const CORE_MATERIALIZATION_INTENTION_V1_SCHEMA: &str =
    "autopilot.core_materialization_intention.v1";
pub const CORE_MATERIALIZATION_RECEIPT_V1_SCHEMA: &str =
    "autopilot.core_materialization_receipt.v1";
pub const CORE_MATERIALIZATION_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreBaselineLeafV1 {
    pub destination: ContractPath,
    pub unit_id: Id,
    pub kind: String,
    pub binding_id: Option<Id>,
    pub mode: String,
    pub bytes_sha256: String,
    pub origin_path: Option<ContractPath>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreMaterializationIntentionV1 {
    pub schema: String,
    pub workstream: Id,
    pub assignment_id: Id,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: String,
    pub approved_plan_binding_path: String,
    pub approved_plan_binding_digest: String,
    pub approved_image_digest: String,
    pub selected_vendoring: Vec<ApprovedUnitVendoringV2>,
    pub intended_baseline: Vec<CoreBaselineLeafV1>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreMaterializationReceiptV1 {
    pub schema: String,
    pub intention_path: String,
    pub intention_digest: String,
    pub workstream: Id,
    pub assignment_id: Id,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: String,
    pub completed_baseline: Vec<CoreBaselineLeafV1>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreMaterializationBindingV1 {
    pub intention_path: String,
    pub intention_digest: String,
    pub receipt_path: String,
    pub receipt_digest: String,
    pub baseline: Vec<CoreBaselineLeafV1>,
}

/// The V4-only tail attached to a delivery assignment.  Identity and unit
/// fields live in `RunnerAssignmentV4`; this tail is deliberately complete so
/// an assignment is never its own vendoring oracle.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreMaterializationRequestV4 {
    pub workstream: Id,
    pub assignment_id: Id,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: PathBuf,
    pub approved_plan_binding_path: String,
    pub approved_plan_binding_digest: String,
    pub approved_image_digest: String,
    pub selected_units: Vec<ApprovedUnit>,
    pub selected_vendoring: Vec<ApprovedUnitVendoringV2>,
}

#[derive(Debug, Clone)]
struct PlannedLeaf {
    leaf: CoreBaselineLeafV1,
    bytes: Vec<u8>,
}

pub fn materialize_v4(
    request: &CoreMaterializationRequestV4,
    approved: &ApprovedPlanArtifactV2,
) -> Result<CoreMaterializationBindingV1, RunnerError> {
    materialize_v4_inner(request, approved, true)
}

/// `materialize_v4` is the only path that may start a new pair. Replayers use
/// the external approved root and durable receipt without reopening origins.
fn materialize_v4_inner(
    request: &CoreMaterializationRequestV4,
    approved: &ApprovedPlanArtifactV2,
    allow_create: bool,
) -> Result<CoreMaterializationBindingV1, RunnerError> {
    validate_request(request, approved)?;
    let worktree = canonical_worktree(&request.worktree)?;
    let (intention_path, receipt_path) = materialization_paths(&worktree, &request.assignment_id);

    match (intention_path.exists(), receipt_path.exists()) {
        (false, false) => {
            if !allow_create {
                return Err(RunnerError::InvalidSpec(
                    "V4 Core materialization pair is absent during replay".to_owned(),
                ));
            }
            // Open only the exact selected origins. Unrelated repository state
            // is neither enumerated nor promoted into materialization authority.
            let plan = planned_leaves(request, &worktree)?;
            let intention = CoreMaterializationIntentionV1 {
                schema: CORE_MATERIALIZATION_INTENTION_V1_SCHEMA.to_owned(),
                workstream: request.workstream.clone(),
                assignment_id: request.assignment_id.clone(),
                lane_id: request.lane_id.clone(),
                attempt: request.attempt,
                base_commit: request.base_commit.clone(),
                worktree: path_text(&worktree)?,
                approved_plan_binding_path: request.approved_plan_binding_path.clone(),
                approved_plan_binding_digest: request.approved_plan_binding_digest.clone(),
                approved_image_digest: request.approved_image_digest.clone(),
                selected_vendoring: request.selected_vendoring.clone(),
                intended_baseline: plan.iter().map(|item| item.leaf.clone()).collect(),
            };
            validate_intention(&intention)?;
            validate_baseline_rows(&intention.selected_vendoring, &intention.intended_baseline)
                .map_err(RunnerError::InvalidSpec)?;
            let intention_bytes = canonical_bytes(&intention)?;
            let intention_digest = sha256_hex(&intention_bytes);
            let receipt = CoreMaterializationReceiptV1 {
                schema: CORE_MATERIALIZATION_RECEIPT_V1_SCHEMA.to_owned(),
                intention_path: path_text(&intention_path)?,
                intention_digest: intention_digest.clone(),
                workstream: request.workstream.clone(),
                assignment_id: request.assignment_id.clone(),
                lane_id: request.lane_id.clone(),
                attempt: request.attempt,
                base_commit: request.base_commit.clone(),
                worktree: path_text(&worktree)?,
                completed_baseline: intention.intended_baseline.clone(),
            };
            validate_receipt(&receipt, &intention)?;
            let receipt_bytes = canonical_bytes(&receipt)?;
            let receipt_digest = sha256_hex(&receipt_bytes);
            write_bounded_file_create_once(
                &intention_path,
                &intention_bytes,
                CORE_MATERIALIZATION_MAX_BYTES,
            )?;
            for item in &plan {
                write_leaf(&worktree, item)?;
            }
            write_bounded_file_create_once(
                &receipt_path,
                &receipt_bytes,
                CORE_MATERIALIZATION_MAX_BYTES,
            )?;
            Ok(CoreMaterializationBindingV1 {
                intention_path: path_text(&intention_path)?,
                intention_digest,
                receipt_path: path_text(&receipt_path)?,
                receipt_digest,
                baseline: receipt.completed_baseline,
            })
        }
        (true, false) => Err(RunnerError::InvalidSpec(
            "core materialization intention exists without receipt; crash is permanently blocked"
                .to_owned(),
        )),
        (false, true) => Err(RunnerError::InvalidSpec(
            "core materialization receipt exists without intention".to_owned(),
        )),
        (true, true) => replay_complete_materialization(
            request,
            approved,
            &worktree,
            &intention_path,
            &receipt_path,
        ),
    }
}

/// Replays the external approved root and the materialization pair.  Package,
/// recovery, and terminal consumers call this rather than trusting the V4
/// assignment's copied rows.
pub fn admit_delivery_submission_v4(
    submission: &kernel::generated::DeliverySubmissionV2,
    artifact: &DeliveryAssignmentArtifactV4,
    required_focused_evidence: usize,
) -> Result<super::DeliverySubmissionOutcome, String> {
    validate_delivery_assignment_v4(artifact)?;
    // The assignment copies are only transport.  Reconstructing the approved
    // root and durable pair prevents a public caller from admitting a shaped
    // but fabricated baseline/receipt.
    replay_v4_materialization(artifact)?;
    let protected = artifact
        .materialization
        .baseline
        .iter()
        .map(|leaf| leaf.destination.0.as_str())
        .collect::<BTreeSet<_>>();
    let mutable = artifact
        .ordered_units
        .iter()
        .flat_map(|unit| unit.files.iter().map(|path| path.0.as_str()))
        .filter(|path| !protected.contains(path))
        .collect::<BTreeSet<_>>();
    if mutable.is_empty() {
        return Err("V4 delivery ownership has no mutable authored leaves".to_owned());
    }
    match (&artifact.recovery, &submission.recovery_disposition) {
        (None, None) => super::admit_delivery_submission_against_allowed_paths(
            submission,
            &mutable,
            required_focused_evidence,
        ),
        (None, Some(_)) => Err("ordinary V4 delivery cannot claim recovery disposition".to_owned()),
        (Some(_), None) => Err("V4 recovery delivery requires recovery disposition".to_owned()),
        (Some(_), Some(disposition)) => {
            let outcome = super::admit_delivery_submission_against_allowed_paths_with_policy(
                submission,
                &mutable,
                required_focused_evidence,
                matches!(
                    disposition,
                    kernel::generated::RecoveryDisposition::NoDefect
                ),
            )?;
            use kernel::generated::{DeliveryBlockerClass, RecoveryDisposition};
            match (disposition, &submission.blocker_class, outcome) {
                (
                    RecoveryDisposition::Repaired,
                    None,
                    super::DeliverySubmissionOutcome::Succeeded,
                ) if !submission.actual_changed_paths.is_empty() => Ok(outcome),
                (
                    RecoveryDisposition::NoDefect,
                    None,
                    super::DeliverySubmissionOutcome::Succeeded,
                ) => Ok(outcome),
                (
                    RecoveryDisposition::RequiresNewAuthority,
                    Some(DeliveryBlockerClass::RequiresNewAuthority),
                    super::DeliverySubmissionOutcome::Blocked,
                )
                | (
                    RecoveryDisposition::InfrastructureBlocked,
                    Some(DeliveryBlockerClass::Infrastructure),
                    super::DeliverySubmissionOutcome::Blocked,
                )
                | (
                    RecoveryDisposition::UnsafeBlocked,
                    Some(DeliveryBlockerClass::Unsafe),
                    super::DeliverySubmissionOutcome::Blocked,
                ) => Ok(outcome),
                _ => Err("V4 recovery disposition conflicts with delivery outcome".to_owned()),
            }
        }
    }
}

pub fn replay_v4_materialization(artifact: &DeliveryAssignmentArtifactV4) -> Result<(), String> {
    validate_delivery_assignment_v4(artifact)?;
    let approved = seam::read_approved_plan_v2(
        Path::new(&artifact.approved_plan_binding_path),
        &artifact.approved_plan_binding_digest,
    )?;
    let intention: CoreMaterializationIntentionV1 = canonical_read(
        Path::new(&artifact.materialization.intention_path),
        CORE_MATERIALIZATION_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    let intention_bytes = canonical_bytes(&intention).map_err(|error| error.to_string())?;
    if sha256_hex(&intention_bytes) != artifact.materialization.intention_digest
        || intention.workstream != artifact.workstream
        || intention.lane_id != artifact.lane_id
        || intention.attempt != artifact.attempt
        || intention.worktree != artifact.worktree
        || intention.approved_plan_binding_path != artifact.approved_plan_binding_path
        || intention.approved_plan_binding_digest != artifact.approved_plan_binding_digest
        || intention.approved_image_digest != artifact.approved_image_digest
        || intention.selected_vendoring != artifact.selected_vendoring
        || (artifact.recovery.is_none()
            && (intention.assignment_id != artifact.assignment_id
                || intention.base_commit != artifact.base_commit))
        || (artifact.recovery.is_some()
            && (artifact.assignment_id == intention.assignment_id
                || artifact.base_commit == intention.base_commit))
    {
        return Err("V4 materialization intention/assignment authority drift".to_owned());
    }
    let request = CoreMaterializationRequestV4 {
        workstream: intention.workstream.clone(),
        assignment_id: intention.assignment_id.clone(),
        lane_id: intention.lane_id.clone(),
        attempt: intention.attempt,
        base_commit: intention.base_commit.clone(),
        worktree: PathBuf::from(&intention.worktree),
        approved_plan_binding_path: intention.approved_plan_binding_path.clone(),
        approved_plan_binding_digest: intention.approved_plan_binding_digest.clone(),
        approved_image_digest: intention.approved_image_digest.clone(),
        selected_units: artifact.ordered_units.clone(),
        selected_vendoring: intention.selected_vendoring.clone(),
    };
    let binding =
        materialize_v4_inner(&request, &approved, false).map_err(|error| error.to_string())?;
    if binding != artifact.materialization {
        return Err("V4 materialization binding/baseline drift".to_owned());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAssignmentArtifactV4 {
    pub schema: String,
    pub workstream: Id,
    pub assignment_id: Id,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: String,
    pub ordered_units: Vec<ApprovedUnit>,
    pub approved_commands: Vec<super::ApprovedCommandBinding>,
    pub recovery: Option<super::RecoveryDirective>,
    pub approved_plan_binding_path: String,
    pub approved_plan_binding_digest: String,
    pub approved_image_digest: String,
    pub selected_vendoring: Vec<ApprovedUnitVendoringV2>,
    pub materialization: CoreMaterializationBindingV1,
}

/// Rejects unknown or absent nested V4 JSON fields before shared V3-compatible
/// Rust row types deserialize them.  V3 never calls this checker.
pub fn validate_delivery_assignment_v4_json(value: &serde_json::Value) -> Result<(), String> {
    let assignment = exact_object(
        value,
        &[
            "schema",
            "workstream",
            "assignment_id",
            "lane_id",
            "attempt",
            "base_commit",
            "worktree",
            "ordered_units",
            "approved_commands",
            "recovery",
            "approved_plan_binding_path",
            "approved_plan_binding_digest",
            "approved_image_digest",
            "selected_vendoring",
            "materialization",
        ],
        "assignment",
    )?;
    array_objects(
        assignment.get("ordered_units"),
        &[
            "id",
            "kind",
            "objective",
            "operator_order",
            "decisions",
            "criteria",
            "criterion_text",
            "dependencies",
            "predecessor_forward_criteria",
            "downstream_release_edges",
            "files",
            "commands",
            "package_checks",
        ],
        "unit",
    )?;
    if let Some(units) = assignment
        .get("ordered_units")
        .and_then(serde_json::Value::as_array)
    {
        for unit in units {
            let object = unit
                .as_object()
                .ok_or_else(|| "V4 unit is not object".to_owned())?;
            array_objects(object.get("criterion_text"), &["id", "text"], "criterion")?;
            array_objects(
                object.get("commands"),
                &[
                    "command",
                    "expected",
                    "effect",
                    "generated_paths",
                    "handling",
                    "scope_preservation",
                ],
                "command",
            )?;
            array_objects(
                object.get("package_checks"),
                &["check_id", "kind", "criterion_ordinals", "expected"],
                "package check",
            )?;
        }
    }
    array_objects(
        assignment.get("approved_commands"),
        &["command_id", "unit_id", "command_ordinal", "command_digest"],
        "approved command",
    )?;
    if assignment
        .get("recovery")
        .is_some_and(|value| !value.is_null())
    {
        exact_object(
            assignment.get("recovery").expect("checked"),
            &[
                "schema",
                "trigger_phase",
                "repair_mode",
                "trigger_assignment_id",
                "diagnosis_refs",
                "diagnosis_ids",
                "diagnosis_details",
                "original_gate",
                "attempt_budget",
            ],
            "recovery",
        )?;
    }
    array_objects(
        assignment.get("selected_vendoring"),
        &[
            "unit_id",
            "provenance_manifest_destination",
            "vendor_bindings",
        ],
        "vendoring row",
    )?;
    if let Some(rows) = assignment
        .get("selected_vendoring")
        .and_then(serde_json::Value::as_array)
    {
        for row in rows {
            array_objects(
                row.as_object().and_then(|row| row.get("vendor_bindings")),
                &["binding_id", "origin_path", "destination"],
                "vendor binding",
            )?;
        }
    }
    let materialization = exact_object(
        assignment
            .get("materialization")
            .ok_or_else(|| "V4 materialization absent".to_owned())?,
        &[
            "intention_path",
            "intention_digest",
            "receipt_path",
            "receipt_digest",
            "baseline",
        ],
        "materialization",
    )?;
    array_objects(
        materialization.get("baseline"),
        &[
            "destination",
            "unit_id",
            "kind",
            "binding_id",
            "mode",
            "bytes_sha256",
            "origin_path",
        ],
        "baseline leaf",
    )?;
    Ok(())
}

fn exact_object<'a>(
    value: &'a serde_json::Value,
    keys: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("V4 {label} is not object"))?;
    if object.len() != keys.len()
        || keys.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !keys.contains(&key.as_str()))
    {
        return Err(format!("V4 {label} has unknown/missing fields"));
    }
    Ok(object)
}

fn array_objects(
    value: Option<&serde_json::Value>,
    keys: &[&str],
    label: &str,
) -> Result<(), String> {
    let values = value
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("V4 {label} array absent"))?;
    for value in values {
        exact_object(value, keys, label)?;
    }
    Ok(())
}

pub fn validate_delivery_assignment_v4(
    artifact: &DeliveryAssignmentArtifactV4,
) -> Result<(), String> {
    if artifact.schema != DELIVERY_ASSIGNMENT_V4_SCHEMA
        || artifact.workstream.0.trim().is_empty()
        || artifact.assignment_id.0.trim().is_empty()
        || artifact.lane_id.0.trim().is_empty()
        || artifact.attempt == 0
        || !is_sha256(&artifact.approved_plan_binding_digest)
        || !is_sha256(&artifact.approved_image_digest)
        || artifact.approved_plan_binding_path.trim().is_empty()
        || artifact.ordered_units.is_empty()
    {
        return Err("V4 delivery assignment identity/root is malformed".to_owned());
    }
    super::validate_approved_command_bindings_v4(
        &artifact.ordered_units,
        &artifact.approved_commands,
    )?;
    validate_selected_rows(&artifact.ordered_units, &artifact.selected_vendoring)
        .map_err(|error| format!("V4 selected vendoring: {error}"))?;
    validate_materialization_binding(&artifact.materialization)?;
    validate_baseline_rows(
        &artifact.selected_vendoring,
        &artifact.materialization.baseline,
    )?;
    Ok(())
}

fn validate_request(
    request: &CoreMaterializationRequestV4,
    approved: &ApprovedPlanArtifactV2,
) -> Result<(), RunnerError> {
    if request.attempt == 0 || request.selected_units.is_empty() {
        return Err(RunnerError::InvalidSpec(
            "V4 materialization missing identity or selected units".to_owned(),
        ));
    }
    let binding_bytes =
        read_bounded_authority_file(Path::new(&request.approved_plan_binding_path), 64 * 1024)?;
    if sha256_hex(&binding_bytes) != request.approved_plan_binding_digest {
        return Err(RunnerError::InvalidSpec(
            "V4 approved-plan binding digest drift".to_owned(),
        ));
    }
    let binding: ApprovedPlanV2BindingV1 =
        serde_json::from_slice(&binding_bytes).map_err(|error| {
            RunnerError::InvalidSpec(format!("V4 approved-plan binding JSON: {error}"))
        })?;
    if binding.approved_plan_sha256 != request.approved_image_digest
        || binding.workstream != request.workstream.0
    {
        return Err(RunnerError::InvalidSpec(
            "V4 approved-plan binding/image/base authority drift".to_owned(),
        ));
    }
    let replay = seam::read_approved_plan_v2(
        Path::new(&request.approved_plan_binding_path),
        &request.approved_plan_binding_digest,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if &replay != approved {
        return Err(RunnerError::InvalidSpec(
            "V4 approved-plan replay differs from accepted image".to_owned(),
        ));
    }
    if request
        .selected_units
        .iter()
        .any(|unit| !approved.units.iter().any(|candidate| candidate == unit))
    {
        return Err(RunnerError::InvalidSpec(
            "V4 selected unit is not in approved image".to_owned(),
        ));
    }
    validate_selected_rows(&request.selected_units, &request.selected_vendoring)
        .map_err(RunnerError::InvalidSpec)?;
    let expected = selected_rows(&approved.vendoring, &request.selected_units)
        .map_err(RunnerError::InvalidSpec)?;
    if expected != request.selected_vendoring {
        return Err(RunnerError::InvalidSpec(
            "V4 selected vendoring rows differ from approved image".to_owned(),
        ));
    }
    Ok(())
}

fn planned_leaves(
    request: &CoreMaterializationRequestV4,
    worktree: &Path,
) -> Result<Vec<PlannedLeaf>, RunnerError> {
    let mut leaves = Vec::new();
    // Several destinations may deliberately copy one exact origin. Retain the
    // descriptor-read fact by origin path so a lane source is opened once,
    // then copy those same bytes to each approved destination.
    let mut sources = BTreeMap::<String, (Vec<u8>, String)>::new();
    let mut materialized_source_bytes = 0_usize;
    for row in &request.selected_vendoring {
        let mut manifest_rows = Vec::new();
        for binding in &row.vendor_bindings {
            let (source_bytes, source_mode) = if let Some(source) =
                sources.get(&binding.origin_path.0)
            {
                source.clone()
            } else {
                let source_path = worktree.join(&binding.origin_path.0);
                if !source_path.starts_with(worktree) {
                    return Err(RunnerError::InvalidSpec(
                        "V4 vendor origin escaped lane worktree".to_owned(),
                    ));
                }
                let source =
                    read_binary_leaf_with_allowed_mode(&source_path, MAX_AUTHORITY_SOURCE_BYTES)?;
                sources.insert(binding.origin_path.0.clone(), source.clone());
                source
            };
            materialized_source_bytes = materialized_source_bytes
                .checked_add(source_bytes.len())
                .ok_or_else(|| {
                RunnerError::InvalidSpec("V4 vendored source byte total overflow".to_owned())
            })?;
            if materialized_source_bytes > MAX_VENDORED_SOURCE_BYTES {
                return Err(RunnerError::InvalidSpec(format!(
                    "V4 vendored source bytes exceed {MAX_VENDORED_SOURCE_BYTES}"
                )));
            }
            let bytes_sha256 = sha256_hex(&source_bytes);
            manifest_rows.push((
                binding.destination.0.clone(),
                format!(
                    "{}\t{}\tsha256:{}\n",
                    binding.origin_path.0, binding.destination.0, bytes_sha256
                )
                .into_bytes(),
            ));
            leaves.push(PlannedLeaf {
                leaf: CoreBaselineLeafV1 {
                    destination: binding.destination.clone(),
                    unit_id: row.unit_id.clone(),
                    kind: "vendor".to_owned(),
                    binding_id: Some(binding.binding_id.clone()),
                    mode: source_mode,
                    bytes_sha256,
                    origin_path: Some(binding.origin_path.clone()),
                },
                bytes: source_bytes,
            });
        }
        if let Some(destination) = &row.provenance_manifest_destination {
            manifest_rows.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            let bytes = manifest_rows
                .into_iter()
                .flat_map(|(_, row)| row)
                .collect::<Vec<_>>();
            leaves.push(PlannedLeaf {
                leaf: CoreBaselineLeafV1 {
                    destination: destination.clone(),
                    unit_id: row.unit_id.clone(),
                    kind: "manifest".to_owned(),
                    binding_id: None,
                    mode: "100644".to_owned(),
                    bytes_sha256: sha256_hex(&bytes),
                    origin_path: None,
                },
                bytes,
            });
        }
    }
    leaves.sort_by(|left, right| {
        left.leaf
            .destination
            .0
            .as_bytes()
            .cmp(right.leaf.destination.0.as_bytes())
    });
    if leaves
        .windows(2)
        .any(|pair| pair[0].leaf.destination == pair[1].leaf.destination)
    {
        return Err(RunnerError::InvalidSpec(
            "V4 Core baseline has duplicate destination".to_owned(),
        ));
    }
    Ok(leaves)
}

fn write_leaf(worktree: &Path, item: &PlannedLeaf) -> Result<(), RunnerError> {
    let path = worktree.join(&item.leaf.destination.0);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(RunnerError::InvalidSpec(
                "V4 first materialization refuses a preexisting protected leaf".to_owned(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(RunnerError::Io(error.to_string())),
    }
    let mode = match item.leaf.mode.as_str() {
        "100644" => 0o644,
        "100755" => 0o755,
        _ => {
            return Err(RunnerError::InvalidSpec(
                "V4 baseline mode drift".to_owned(),
            ));
        }
    };
    write_binary_leaf_create_once_exact_mode(&path, &item.bytes, mode, MAX_AUTHORITY_SOURCE_BYTES)
}

fn replay_complete_materialization(
    request: &CoreMaterializationRequestV4,
    approved: &ApprovedPlanArtifactV2,
    worktree: &Path,
    intention_path: &Path,
    receipt_path: &Path,
) -> Result<CoreMaterializationBindingV1, RunnerError> {
    let intention = canonical_read::<CoreMaterializationIntentionV1>(
        intention_path,
        CORE_MATERIALIZATION_MAX_BYTES,
    )?;
    let receipt = canonical_read::<CoreMaterializationReceiptV1>(
        receipt_path,
        CORE_MATERIALIZATION_MAX_BYTES,
    )?;
    validate_intention(&intention)?;
    validate_receipt(&receipt, &intention)?;
    let intention_bytes = canonical_bytes(&intention)?;
    let receipt_bytes = canonical_bytes(&receipt)?;
    let intention_digest = sha256_hex(&intention_bytes);
    let receipt_digest = sha256_hex(&receipt_bytes);
    if receipt.intention_path != path_text(intention_path)?
        || receipt.intention_digest != intention_digest
        || intention.workstream != request.workstream
        || intention.assignment_id != request.assignment_id
        || intention.lane_id != request.lane_id
        || intention.attempt != request.attempt
        || intention.base_commit != request.base_commit
        || intention.worktree != path_text(worktree)?
        || intention.approved_plan_binding_path != request.approved_plan_binding_path
        || intention.approved_plan_binding_digest != request.approved_plan_binding_digest
        || intention.approved_image_digest != request.approved_image_digest
        || intention.selected_vendoring != request.selected_vendoring
    {
        return Err(RunnerError::InvalidSpec(
            "V4 Core materialization intention/receipt authority drift".to_owned(),
        ));
    }
    // Re-read the approved root, but never origins: the durable receipt's
    // baseline is the sole materialization source after creation.
    validate_request(request, approved)?;
    validate_baseline_rows(&intention.selected_vendoring, &receipt.completed_baseline)
        .map_err(RunnerError::InvalidSpec)?;
    for leaf in &receipt.completed_baseline {
        validate_materialized_leaf(worktree, leaf)?;
    }
    Ok(CoreMaterializationBindingV1 {
        intention_path: path_text(intention_path)?,
        intention_digest,
        receipt_path: path_text(receipt_path)?,
        receipt_digest,
        baseline: receipt.completed_baseline,
    })
}

fn validate_materialized_leaf(
    worktree: &Path,
    leaf: &CoreBaselineLeafV1,
) -> Result<(), RunnerError> {
    let expected_mode = match leaf.mode.as_str() {
        "100644" => 0o644,
        "100755" => 0o755,
        _ => {
            return Err(RunnerError::InvalidSpec(
                "V4 Core baseline mode drift".to_owned(),
            ));
        }
    };
    let path = worktree.join(&leaf.destination.0);
    // No metadata/read split: the final leaf is opened O_NOFOLLOW relative to
    // the capability-rooted parent, type/mode checked, and bounded-read on the
    // one held descriptor.
    let bytes = read_binary_leaf_exact_mode(&path, MAX_AUTHORITY_SOURCE_BYTES, expected_mode)?;
    if sha256_hex(&bytes) != leaf.bytes_sha256 {
        return Err(RunnerError::InvalidSpec(
            "V4 Core baseline leaf byte drift".to_owned(),
        ));
    }
    Ok(())
}

fn validate_selected_rows(
    units: &[ApprovedUnit],
    rows: &[ApprovedUnitVendoringV2],
) -> Result<(), String> {
    if rows.len() != units.len()
        || rows
            .iter()
            .zip(units)
            .any(|(row, unit)| row.unit_id != unit.id)
    {
        return Err(
            "rows must include exactly one selected unit-order row, including empties".to_owned(),
        );
    }
    let mut seen = BTreeSet::new();
    for row in rows {
        if !seen.insert(row.unit_id.clone()) {
            return Err("duplicate selected V4 vendoring row".to_owned());
        }
    }
    Ok(())
}

fn selected_rows(
    all: &[ApprovedUnitVendoringV2],
    units: &[ApprovedUnit],
) -> Result<Vec<ApprovedUnitVendoringV2>, String> {
    let by_id = all
        .iter()
        .map(|row| (row.unit_id.clone(), row))
        .collect::<BTreeMap<_, _>>();
    let rows = units
        .iter()
        .map(|unit| {
            by_id.get(&unit.id).cloned().cloned().ok_or_else(|| {
                format!(
                    "approved image lacks vendoring row for selected unit {}",
                    unit.id.0
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_selected_rows(units, &rows)?;
    Ok(rows)
}

fn validate_baseline_rows(
    rows: &[ApprovedUnitVendoringV2],
    baseline: &[CoreBaselineLeafV1],
) -> Result<(), String> {
    // Partition coverage is deliberately only destination/unit/kind. Mode,
    // digest, binding, and origin-path facts are validated below by the
    // baseline/materialization checks; they are not placeholder tuple values.
    let mut expected = Vec::new();
    for row in rows {
        expected.extend(row.vendor_bindings.iter().map(|binding| {
            (
                binding.destination.0.as_str(),
                row.unit_id.0.as_str(),
                "vendor",
            )
        }));
        if let Some(path) = &row.provenance_manifest_destination {
            expected.push((path.0.as_str(), row.unit_id.0.as_str(), "manifest"));
        }
    }
    expected.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let actual = baseline
        .iter()
        .map(|leaf| {
            (
                leaf.destination.0.as_str(),
                leaf.unit_id.0.as_str(),
                leaf.kind.as_str(),
            )
        })
        .collect::<Vec<_>>();
    if actual.len() != expected.len()
        || actual
            .iter()
            .zip(expected)
            .any(|(actual, expected)| actual != &expected)
    {
        return Err(
            "V4 materialization baseline does not exactly partition selected vendor/manifests"
                .to_owned(),
        );
    }
    for leaf in baseline {
        validate_baseline_leaf(leaf)?;
        match leaf.kind.as_str() {
            "vendor" => {
                let (_, binding) = rows
                    .iter()
                    .flat_map(|row| {
                        row.vendor_bindings
                            .iter()
                            .map(move |binding| (row, binding))
                    })
                    .find(|(_, binding)| binding.destination == leaf.destination)
                    .ok_or_else(|| {
                        "V4 materialization vendor baseline destination is unbound".to_owned()
                    })?;
                if leaf.binding_id.as_ref() != Some(&binding.binding_id)
                    || leaf.origin_path.as_ref() != Some(&binding.origin_path)
                {
                    return Err(
                        "V4 materialization vendor baseline binding/origin drift".to_owned()
                    );
                }
            }
            "manifest" => {}
            _ => unreachable!("baseline leaf kind was checked"),
        }
    }
    Ok(())
}

fn validate_baseline_leaf(leaf: &CoreBaselineLeafV1) -> Result<(), String> {
    if !crate::allocation::approved_path_is_safe(&leaf.destination)
        || leaf.unit_id.0.trim().is_empty()
        || !is_sha256(&leaf.bytes_sha256)
    {
        return Err("V4 materialization baseline leaf path/id/SHA is malformed".to_owned());
    }
    match leaf.kind.as_str() {
        "vendor"
            if leaf
                .binding_id
                .as_ref()
                .is_some_and(|id| !id.0.trim().is_empty())
                && leaf
                    .origin_path
                    .as_ref()
                    .is_some_and(crate::allocation::approved_path_is_safe)
                && matches!(leaf.mode.as_str(), "100644" | "100755") =>
        {
            Ok(())
        }
        "manifest"
            if leaf.binding_id.is_none() && leaf.origin_path.is_none() && leaf.mode == "100644" =>
        {
            Ok(())
        }
        _ => Err("V4 materialization baseline leaf kind/fact drift".to_owned()),
    }
}

fn validate_intention(value: &CoreMaterializationIntentionV1) -> Result<(), RunnerError> {
    if value.schema != CORE_MATERIALIZATION_INTENTION_V1_SCHEMA
        || !is_sha256(&value.approved_plan_binding_digest)
        || !is_sha256(&value.approved_image_digest)
        || value
            .intended_baseline
            .windows(2)
            .any(|pair| pair[0].destination.0.as_bytes() >= pair[1].destination.0.as_bytes())
        || value
            .intended_baseline
            .iter()
            .any(|leaf| validate_baseline_leaf(leaf).is_err())
    {
        return Err(RunnerError::InvalidSpec(
            "V4 Core materialization intention malformed".to_owned(),
        ));
    }
    Ok(())
}

fn validate_receipt(
    receipt: &CoreMaterializationReceiptV1,
    intention: &CoreMaterializationIntentionV1,
) -> Result<(), RunnerError> {
    if receipt.schema != CORE_MATERIALIZATION_RECEIPT_V1_SCHEMA
        || receipt.workstream != intention.workstream
        || receipt.assignment_id != intention.assignment_id
        || receipt.lane_id != intention.lane_id
        || receipt.attempt != intention.attempt
        || receipt.base_commit != intention.base_commit
        || receipt.worktree != intention.worktree
        || receipt.completed_baseline != intention.intended_baseline
        || receipt
            .completed_baseline
            .iter()
            .any(|leaf| validate_baseline_leaf(leaf).is_err())
        || !is_sha256(&receipt.intention_digest)
    {
        return Err(RunnerError::InvalidSpec(
            "V4 Core materialization receipt malformed".to_owned(),
        ));
    }
    Ok(())
}

fn validate_materialization_binding(binding: &CoreMaterializationBindingV1) -> Result<(), String> {
    if binding.intention_path.trim().is_empty()
        || binding.receipt_path.trim().is_empty()
        || !is_sha256(&binding.intention_digest)
        || !is_sha256(&binding.receipt_digest)
        || binding
            .baseline
            .windows(2)
            .any(|pair| pair[0].destination.0.as_bytes() >= pair[1].destination.0.as_bytes())
        || binding
            .baseline
            .iter()
            .any(|leaf| validate_baseline_leaf(leaf).is_err())
    {
        return Err("V4 materialization binding malformed".to_owned());
    }
    Ok(())
}

fn canonical_read<T: for<'a> Deserialize<'a> + Serialize>(
    path: &Path,
    max: usize,
) -> Result<T, RunnerError> {
    let bytes = read_bounded_authority_file(path, max)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| RunnerError::InvalidSpec(format!("V4 materialization JSON: {error}")))?;
    if canonical_bytes(&value)? != bytes {
        return Err(RunnerError::InvalidSpec(
            "V4 materialization bytes are not canonical".to_owned(),
        ));
    }
    Ok(value)
}

fn canonical_bytes(value: &impl Serialize) -> Result<Vec<u8>, RunnerError> {
    crate::evidence::canonical_json(value)
        .map_err(|error| RunnerError::InvalidSpec(error.to_string()))
}

fn materialization_paths(worktree: &Path, assignment_id: &Id) -> (PathBuf, PathBuf) {
    let root = worktree.join(".pi/autopilot/runner/core-materialization");
    (
        root.join(format!("{}.intention.v1.json", assignment_id.0)),
        root.join(format!("{}.receipt.v1.json", assignment_id.0)),
    )
}

fn canonical_worktree(path: &Path) -> Result<PathBuf, RunnerError> {
    let worktree = fs::canonicalize(path).map_err(|error| RunnerError::Io(error.to_string()))?;
    if !worktree.is_absolute() || !worktree.is_dir() {
        return Err(RunnerError::InvalidSpec(
            "V4 materialization worktree is not an absolute directory".to_owned(),
        ));
    }
    Ok(worktree)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn path_text(path: &Path) -> Result<String, RunnerError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| RunnerError::InvalidSpec("V4 materialization path is not UTF-8".to_owned()))
}
