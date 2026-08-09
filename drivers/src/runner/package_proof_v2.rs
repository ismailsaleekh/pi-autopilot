//! Core-owned replay for rooted V2 package proofs.
//!
//! The receipt is deliberately a compact commitment.  It never turns a
//! receipt summary into evidence: Validator admission reconstructs the same
//! subject from the approved image, materialization receipt, and exact candidate tree.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use kernel::generated::{
    Bytes, Digest, GitOid, Id, PackageProofKindV2, Ref, ValidationEvidenceAuthority,
    ValidationReceiptRecord,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};

use crate::allocation::{
    ApprovedPackageProofV2, ApprovedUnit, ApprovedUnitPackageAuthorityV2, ApprovedUnitVendoringV2,
    validate_approved_v2_authority,
};
use crate::seam;

use super::{
    DELIVERY_ASSIGNMENT_MAX_BYTES, DeliveryAssignmentArtifactReader, DeliveryAssignmentArtifactV4,
    RunnerError, ValidationRunnerRequest, authority_git_output_bounded_with_input,
    authority_git_output_bounded_with_limits, materializer_v4, sha256_hex,
};

pub const CORE_V2_PACKAGE_PROOF_RECEIPT_V1_SCHEMA: &str =
    "autopilot.core_v2_package_proof_receipt.v1";
const MAX_GIT_STDERR_BYTES: usize = 64 << 10;
const MAX_LS_TREE_BYTES: usize = 16 << 10;
const MAX_RECEIPT_JSON_BYTES: usize = 16 << 10;

/// Compact Core proof.  Every field is required so a receipt cannot quietly
/// fall back to an older package authority shape.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreV2PackageProofReceiptV1 {
    pub schema: String,
    pub proof_id: Id,
    pub kind: PackageProofKindV2,
    pub criterion_ordinals: Vec<u32>,
    pub criterion_ids: Vec<Id>,
    pub unit_id: Id,
    pub validator_assignment_id: Id,
    pub delivery_producer_assignment_id: Id,
    pub delivery_producer_assignment_digest: String,
    pub delivery_assignment_path: String,
    pub base_commit: String,
    pub package_commit: String,
    pub package_tree: String,
    pub changed_paths: Vec<String>,
    pub approved_plan_binding_path: String,
    pub approved_plan_binding_digest: String,
    pub approved_image_digest: String,
    pub materialization_receipt_path: String,
    pub materialization_receipt_digest: String,
    pub package_scope_files_count: u32,
    pub package_scope_files_digest: String,
    pub vendor_binding_ids_count: u32,
    pub vendor_binding_ids_digest: String,
    pub candidate_vendor_tree_witness_count: u32,
    pub candidate_vendor_tree_witness_digest: String,
    pub candidate_manifest_tree_witness_count: u32,
    pub candidate_manifest_tree_witness_digest: String,
    pub proof_subject_digest: String,
    pub expected_text_digest: String,
}

#[derive(Debug, Clone)]
struct ProofContext {
    validator_assignment_id: Id,
    producer_assignment_ids: Vec<Id>,
    producer_assignment_digest: String,
    base_commit: String,
    package_commit: String,
    package_tree: String,
    candidate_root: PathBuf,
    changed_paths: Vec<String>,
}

/// Evaluates the only V4 package authority path before Validator V3 writes
/// candidate evidence or an issuance document.
pub(crate) fn evaluate_rooted_v4_package_proofs(
    request: &ValidationRunnerRequest,
    artifact: &DeliveryAssignmentArtifactV4,
) -> Result<Vec<ValidationReceiptRecord>, RunnerError> {
    let context = request_context(request)?;
    let receipts = replay_and_evaluate(&context, artifact).map_err(RunnerError::InvalidSpec)?;
    receipts
        .into_iter()
        .map(wrap_receipt)
        .collect::<Result<Vec<_>, _>>()
        .map_err(RunnerError::InvalidSpec)
}

/// Replays a compact V2 receipt against the outer Validator authority.  This
/// is intentionally independent from receipt construction; summaries are
/// recomputed from Git objects and the approved root rather than trusted.
pub(crate) fn verify_receipt_against_validation_authority(
    receipt: &CoreV2PackageProofReceiptV1,
    record: &ValidationReceiptRecord,
    authority: &ValidationEvidenceAuthority,
) -> Result<(), String> {
    validate_receipt_shape_and_subject_digest(receipt)?;
    // The producer assignment digest is rooted by the approved command
    // receipts in the Validator authority.  Never let a package receipt pick
    // a different delivery assignment merely by naming a replacement digest.
    let producer_assignment_digest = authority_producer_assignment_digest(authority)?;
    if receipt.delivery_producer_assignment_digest != producer_assignment_digest {
        return Err(
            "V2 package receipt producer assignment digest is not authority-rooted".to_owned(),
        );
    }
    let context = ProofContext {
        validator_assignment_id: authority.assignment_id.clone(),
        producer_assignment_ids: vec![receipt.delivery_producer_assignment_id.clone()],
        producer_assignment_digest,
        base_commit: authority.base_commit.0.clone(),
        package_commit: authority.exact_commit.0.clone(),
        package_tree: authority.exact_tree.0.clone(),
        candidate_root: PathBuf::from(&authority.candidate_root.0),
        changed_paths: authority
            .changed_paths
            .iter()
            .map(|path| path.0.clone())
            .collect(),
    };
    if receipt.schema != CORE_V2_PACKAGE_PROOF_RECEIPT_V1_SCHEMA
        || receipt.validator_assignment_id != authority.assignment_id
        || receipt.base_commit != authority.base_commit.0
        || receipt.package_commit != authority.exact_commit.0
        || receipt.package_tree != authority.exact_tree.0
        || receipt.changed_paths != context.changed_paths
    {
        return Err("V2 package receipt outer authority binding drift".to_owned());
    }
    let assignment_path = PathBuf::from(&receipt.delivery_assignment_path);
    let artifact = read_rooted_delivery_assignment(
        &assignment_path,
        &receipt.delivery_producer_assignment_digest,
    )?;
    let expected_path = delivery_assignment_path(&context.candidate_root, &artifact)?;
    if assignment_path != expected_path {
        return Err("V2 package receipt delivery assignment path drift".to_owned());
    }
    let receipts = replay_and_evaluate(&context, &artifact)?;
    let expected = receipts
        .into_iter()
        .find(|candidate| candidate.proof_id == receipt.proof_id)
        .ok_or_else(|| "V2 package receipt names no rooted proof".to_owned())?;
    if &expected != receipt {
        return Err("V2 package receipt replay summary or root drift".to_owned());
    }
    let expected_record = wrap_receipt(expected)?;
    if &expected_record != record {
        return Err("V2 package receipt wrapper drift".to_owned());
    }
    Ok(())
}

fn request_context(request: &ValidationRunnerRequest) -> Result<ProofContext, RunnerError> {
    let candidate_root = fs::canonicalize(&request.candidate_root)
        .map_err(|error| RunnerError::InvalidSpec(format!("V2 package candidate root: {error}")))?;
    let worktree = fs::canonicalize(&request.worktree)
        .map_err(|error| RunnerError::InvalidSpec(format!("V2 package worktree: {error}")))?;
    if candidate_root != worktree {
        return Err(RunnerError::InvalidSpec(
            "V2 package proof candidate/worktree identity drift".to_owned(),
        ));
    }
    let mut changed_paths = request.changed_paths.clone();
    changed_paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    if changed_paths != request.changed_paths
        || changed_paths.iter().collect::<BTreeSet<_>>().len() != changed_paths.len()
    {
        return Err(RunnerError::InvalidSpec(
            "V2 package proof changed paths are not exact sorted unique bytes".to_owned(),
        ));
    }
    Ok(ProofContext {
        validator_assignment_id: request.assignment_id.clone(),
        producer_assignment_ids: request.producer_assignment_ids.clone(),
        producer_assignment_digest: request.producer_assignment_digest.clone(),
        base_commit: request.base_commit.0.clone(),
        package_commit: request.exact_commit.clone(),
        package_tree: request.exact_tree.clone(),
        candidate_root,
        changed_paths,
    })
}

fn replay_and_evaluate(
    context: &ProofContext,
    artifact: &DeliveryAssignmentArtifactV4,
) -> Result<Vec<CoreV2PackageProofReceiptV1>, String> {
    materializer_v4::validate_delivery_assignment_v4(artifact)?;
    let candidate_root = fs::canonicalize(&context.candidate_root)
        .map_err(|error| format!("V2 package candidate root: {error}"))?;
    if artifact.worktree != candidate_root.display().to_string()
        || artifact.base_commit.0 != context.base_commit
        || context.producer_assignment_ids != [artifact.assignment_id.clone()]
        || artifact
            .ordered_units
            .iter()
            .any(|unit| !unit.package_checks.is_empty())
    {
        return Err("V2 rooted package request/assignment identity drift".to_owned());
    }
    let assignment_path = delivery_assignment_path(&candidate_root, artifact)?;
    let persisted =
        read_rooted_delivery_assignment(&assignment_path, &context.producer_assignment_digest)?;
    if &persisted != artifact {
        return Err("V2 rooted package artifact differs from digest-bound assignment".to_owned());
    }
    materializer_v4::replay_v4_materialization(artifact)?;
    // This is the exact current package-tip verifier, deliberately invoked
    // before any receipt, source/diff, authority, or spec is written.
    super::verify_package_git_state(
        &candidate_root,
        &kernel::generated::Sha(context.base_commit.clone()),
        &kernel::generated::Sha(context.package_commit.clone()),
        &kernel::generated::Sha(context.package_tree.clone()),
        &context.changed_paths,
        true,
    )
    .map_err(|error| format!("V2 clean exact package tip: {error:?}"))?;

    let approved = seam::read_approved_plan_v2(
        Path::new(&artifact.approved_plan_binding_path),
        &artifact.approved_plan_binding_digest,
    )?;
    if artifact.approved_image_digest.is_empty() {
        return Err("V2 rooted approved image is incomplete".to_owned());
    }
    validate_approved_v2_authority(
        &approved.units,
        &approved.vendoring,
        &approved.package_authority,
    )?;
    validate_selected_units(&approved.units, &artifact.ordered_units)?;
    let selected_rows =
        selected_package_rows(&approved.package_authority, &artifact.ordered_units)?;
    validate_final_closure(
        &approved.units,
        &approved.package_authority,
        &approved.vendoring,
    )?;

    let mut receipts = Vec::new();
    for (unit, row) in artifact.ordered_units.iter().zip(selected_rows) {
        for proof in &row.package_proofs {
            let criterion_ids = criterion_ids(unit, &proof.criterion_ordinals)?;
            let scope_files = sorted_strings(
                row.package_scope_files
                    .iter()
                    .map(|path| path.0.clone())
                    .collect(),
            )?;
            let mut summaries = match proof.kind {
                PackageProofKindV2::CleanExactPackageTip => {
                    ProofSummaries::clean(&row.package_scope_files)?
                }
                PackageProofKindV2::VendoredBytesMatchOrigin => vendor_summaries(
                    &candidate_root,
                    &context.package_tree,
                    &approved.vendoring,
                    &artifact.materialization.baseline,
                    proof,
                )?,
            };
            summaries.scope_count = count(&scope_files)?;
            summaries.scope_digest = list_digest(
                "autopilot.core_v2_package_proof.package_scope_files.v1",
                &scope_files,
            );
            let receipt = CoreV2PackageProofReceiptV1 {
                schema: CORE_V2_PACKAGE_PROOF_RECEIPT_V1_SCHEMA.to_owned(),
                proof_id: proof.proof_id.clone(),
                kind: proof.kind.clone(),
                criterion_ordinals: proof.criterion_ordinals.clone(),
                criterion_ids,
                unit_id: unit.id.clone(),
                validator_assignment_id: context.validator_assignment_id.clone(),
                delivery_producer_assignment_id: artifact.assignment_id.clone(),
                delivery_producer_assignment_digest: context.producer_assignment_digest.clone(),
                delivery_assignment_path: assignment_path.display().to_string(),
                base_commit: context.base_commit.clone(),
                package_commit: context.package_commit.clone(),
                package_tree: context.package_tree.clone(),
                changed_paths: context.changed_paths.clone(),
                approved_plan_binding_path: artifact.approved_plan_binding_path.clone(),
                approved_plan_binding_digest: artifact.approved_plan_binding_digest.clone(),
                approved_image_digest: artifact.approved_image_digest.clone(),
                materialization_receipt_path: artifact.materialization.receipt_path.clone(),
                materialization_receipt_digest: artifact.materialization.receipt_digest.clone(),
                package_scope_files_count: summaries.scope_count,
                package_scope_files_digest: summaries.scope_digest,
                vendor_binding_ids_count: summaries.binding_count,
                vendor_binding_ids_digest: summaries.binding_digest,
                candidate_vendor_tree_witness_count: summaries.vendor_count,
                candidate_vendor_tree_witness_digest: summaries.vendor_digest,
                candidate_manifest_tree_witness_count: summaries.manifest_count,
                candidate_manifest_tree_witness_digest: summaries.manifest_digest,
                proof_subject_digest: String::new(),
                expected_text_digest: sha256_hex(proof.expected.as_bytes()),
            };
            let mut receipt = receipt;
            receipt.proof_subject_digest = proof_subject_digest(&receipt)?;
            validate_receipt_shape_and_subject_digest(&receipt)?;
            receipts.push(receipt);
        }
    }
    Ok(receipts)
}

fn read_rooted_delivery_assignment(
    path: &Path,
    expected_digest: &str,
) -> Result<DeliveryAssignmentArtifactV4, String> {
    let bytes = super::read_bounded_file(path, DELIVERY_ASSIGNMENT_MAX_BYTES)
        .map_err(|error| format!("V2 delivery assignment read: {error}"))?;
    if sha256_hex(&bytes) != expected_digest {
        return Err("V2 delivery assignment digest drift".to_owned());
    }
    match super::read_delivery_assignment_artifact(&bytes)? {
        DeliveryAssignmentArtifactReader::V4(artifact) => Ok(artifact),
        DeliveryAssignmentArtifactReader::V3(_) => {
            Err("V2 package proof requires V4 assignment".to_owned())
        }
    }
}

fn delivery_assignment_path(
    candidate_root: &Path,
    artifact: &DeliveryAssignmentArtifactV4,
) -> Result<PathBuf, String> {
    let paths = super::delivery_paths(candidate_root, &artifact.assignment_id);
    paths
        .spec_path
        .parent()
        .and_then(Path::parent)
        .map(|base| {
            base.join("assignments")
                .join(format!("{}.json", artifact.assignment_id.0))
        })
        .ok_or_else(|| "V2 delivery assignment path has no runner base".to_owned())
}

fn validate_selected_units(all: &[ApprovedUnit], selected: &[ApprovedUnit]) -> Result<(), String> {
    let selected_ids = selected
        .iter()
        .map(|unit| unit.id.clone())
        .collect::<BTreeSet<_>>();
    if selected_ids.len() != selected.len() {
        return Err("V2 selected units duplicate ids".to_owned());
    }
    let expected = all
        .iter()
        .filter(|unit| selected_ids.contains(&unit.id))
        .cloned()
        .collect::<Vec<_>>();
    if expected != selected {
        return Err("V2 selected units are not exact approved-image lane order".to_owned());
    }
    Ok(())
}

fn selected_package_rows(
    all: &[ApprovedUnitPackageAuthorityV2],
    units: &[ApprovedUnit],
) -> Result<Vec<ApprovedUnitPackageAuthorityV2>, String> {
    let by_id = all
        .iter()
        .map(|row| (row.unit_id.clone(), row))
        .collect::<BTreeMap<_, _>>();
    units
        .iter()
        .map(|unit| {
            by_id
                .get(&unit.id)
                .cloned()
                .cloned()
                .ok_or_else(|| format!("V2 approved image lacks package row {}", unit.id.0))
        })
        .collect()
}

fn validate_final_closure(
    units: &[ApprovedUnit],
    rows: &[ApprovedUnitPackageAuthorityV2],
    vendoring: &[ApprovedUnitVendoringV2],
) -> Result<(), String> {
    let complete_files = units
        .iter()
        .flat_map(|unit| unit.files.iter().map(|path| path.0.clone()))
        .collect::<BTreeSet<_>>();
    let complete_bindings = vendoring
        .iter()
        .flat_map(|row| {
            row.vendor_bindings
                .iter()
                .map(|binding| binding.binding_id.clone())
        })
        .collect::<BTreeSet<_>>();
    for row in rows.iter().filter(|row| !row.package_proofs.is_empty()) {
        let scope = row
            .package_scope_files
            .iter()
            .map(|path| path.0.clone())
            .collect::<BTreeSet<_>>();
        if scope != complete_files {
            return Err(
                "V2 final closure package scope is not complete implementation union".to_owned(),
            );
        }
        for proof in &row.package_proofs {
            if proof.kind == PackageProofKindV2::VendoredBytesMatchOrigin
                && proof
                    .vendor_binding_ids
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    != complete_bindings
            {
                return Err("V2 vendor proof ids are not complete approved binding ids".to_owned());
            }
        }
    }
    Ok(())
}

fn criterion_ids(unit: &ApprovedUnit, ordinals: &[u32]) -> Result<Vec<Id>, String> {
    if ordinals.is_empty() || ordinals.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("V2 package proof ordinals are not exact ascending unique values".to_owned());
    }
    let mut ids = ordinals
        .iter()
        .map(|ordinal| {
            ordinal
                .checked_sub(1)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| unit.criterion_text.get(index))
                .map(|criterion| criterion.id.clone())
                .ok_or_else(|| "V2 package proof criterion ordinal drift".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err("V2 package proof criterion ids are duplicate".to_owned());
    }
    Ok(ids)
}

#[derive(Debug)]
struct ProofSummaries {
    scope_count: u32,
    scope_digest: String,
    binding_count: u32,
    binding_digest: String,
    vendor_count: u32,
    vendor_digest: String,
    manifest_count: u32,
    manifest_digest: String,
}

impl ProofSummaries {
    fn clean(scope: &[kernel::generated::Path]) -> Result<Self, String> {
        let scope = sorted_strings(scope.iter().map(|path| path.0.clone()).collect())?;
        Ok(Self {
            scope_count: count(&scope)?,
            scope_digest: list_digest(
                "autopilot.core_v2_package_proof.package_scope_files.v1",
                &scope,
            ),
            binding_count: 0,
            binding_digest: list_digest(
                "autopilot.core_v2_package_proof.vendor_binding_ids.v1",
                &[],
            ),
            vendor_count: 0,
            vendor_digest: list_digest(
                "autopilot.core_v2_package_proof.candidate_vendor_tree_witnesses.v1",
                &[],
            ),
            manifest_count: 0,
            manifest_digest: list_digest(
                "autopilot.core_v2_package_proof.candidate_manifest_tree_witnesses.v1",
                &[],
            ),
        })
    }
}

fn vendor_summaries(
    root: &Path,
    exact_tree: &str,
    vendoring: &[ApprovedUnitVendoringV2],
    baseline: &[materializer_v4::CoreBaselineLeafV1],
    proof: &ApprovedPackageProofV2,
) -> Result<ProofSummaries, String> {
    let mut bindings = vendoring
        .iter()
        .flat_map(|row| {
            row.vendor_bindings
                .iter()
                .map(move |binding| (row, binding))
        })
        .collect::<Vec<_>>();
    bindings.sort_by(|(_, left), (_, right)| {
        left.destination
            .0
            .as_bytes()
            .cmp(right.destination.0.as_bytes())
            .then_with(|| {
                left.origin_path
                    .0
                    .as_bytes()
                    .cmp(right.origin_path.0.as_bytes())
            })
            .then_with(|| {
                left.binding_id
                    .0
                    .as_bytes()
                    .cmp(right.binding_id.0.as_bytes())
            })
    });
    let ids = bindings
        .iter()
        .map(|(_, binding)| binding.binding_id.0.clone())
        .collect::<Vec<_>>();
    let expected_ids = proof
        .vendor_binding_ids
        .iter()
        .map(|id| id.0.clone())
        .collect::<BTreeSet<_>>();
    if ids.iter().cloned().collect::<BTreeSet<_>>() != expected_ids
        || ids.len() != expected_ids.len()
    {
        return Err("V2 vendor proof does not enumerate every approved binding".to_owned());
    }
    let mut by_binding = BTreeMap::new();
    for leaf in baseline {
        if let Some(id) = &leaf.binding_id {
            by_binding.insert(id, leaf);
        }
    }
    let candidate_destinations = bindings
        .iter()
        .map(|(_, binding)| binding.destination.0.clone())
        .collect::<Vec<_>>();
    let candidates = candidate_blobs(root, exact_tree, &candidate_destinations)?;
    if candidates.len() != bindings.len() {
        return Err("V2 candidate vendor batch cardinality drift".to_owned());
    }
    let mut vendor_rows = Vec::new();
    for ((_, binding), candidate) in bindings.iter().zip(candidates) {
        let source = by_binding
            .get(&binding.binding_id)
            .ok_or_else(|| "V2 materialization baseline lacks binding".to_owned())?;
        let candidate_digest = sha256_hex(&candidate.bytes);
        if source.kind != "vendor"
            || source.destination != binding.destination
            || source.origin_path.as_ref() != Some(&binding.origin_path)
            || candidate.destination != binding.destination.0
            || candidate.mode != source.mode
            || candidate_digest != source.bytes_sha256
            || candidate.bytes != read_materialized_baseline(root, source)?
        {
            return Err(format!(
                "V2 candidate vendor bytes/mode drift: {}",
                binding.binding_id.0
            ));
        }
        vendor_rows.push(canonical_row(&[
            "vendor",
            &binding.binding_id.0,
            &binding.origin_path.0,
            &binding.destination.0,
            &source.mode,
            &candidate.mode,
            &candidate_digest,
        ]));
    }
    let mut manifest_rows = Vec::new();
    for row in vendoring
        .iter()
        .filter(|row| !row.vendor_bindings.is_empty())
    {
        let destination = row
            .provenance_manifest_destination
            .as_ref()
            .ok_or_else(|| "V2 vendor row lacks manifest destination".to_owned())?;
        let leaf = baseline
            .iter()
            .find(|leaf| leaf.destination == *destination && leaf.kind == "manifest")
            .ok_or_else(|| "V2 materialization baseline lacks manifest".to_owned())?;
        let candidate = candidate_blob(root, exact_tree, &destination.0)?;
        if leaf.unit_id != row.unit_id
            || candidate.mode != leaf.mode
            || sha256_hex(&candidate.bytes) != leaf.bytes_sha256
            || candidate.bytes != read_materialized_baseline(root, leaf)?
        {
            return Err(format!(
                "V2 candidate provenance manifest drift: {}",
                destination.0
            ));
        }
        manifest_rows.push(canonical_row(&[
            "manifest",
            &destination.0,
            &candidate.mode,
            &leaf.bytes_sha256,
        ]));
    }
    vendor_rows.sort();
    manifest_rows.sort();
    Ok(ProofSummaries {
        scope_count: 0,
        scope_digest: String::new(),
        binding_count: count(&ids)?,
        binding_digest: list_digest(
            "autopilot.core_v2_package_proof.vendor_binding_ids.v1",
            &ids,
        ),
        vendor_count: count(&vendor_rows)?,
        vendor_digest: list_digest(
            "autopilot.core_v2_package_proof.candidate_vendor_tree_witnesses.v1",
            &vendor_rows,
        ),
        manifest_count: count(&manifest_rows)?,
        manifest_digest: list_digest(
            "autopilot.core_v2_package_proof.candidate_manifest_tree_witnesses.v1",
            &manifest_rows,
        ),
    })
}

fn read_materialized_baseline(
    root: &Path,
    leaf: &materializer_v4::CoreBaselineLeafV1,
) -> Result<Vec<u8>, String> {
    let mode = match leaf.mode.as_str() {
        "100644" => 0o644,
        "100755" => 0o755,
        _ => return Err("V2 materialization baseline mode malformed".to_owned()),
    };
    super::read_binary_leaf_exact_mode(
        &root.join(&leaf.destination.0),
        super::MAX_AUTHORITY_SOURCE_BYTES,
        mode,
    )
    .map_err(|error| error.to_string())
}

const MAX_CAT_FILE_BATCH_FRAMING_BYTES_PER_BLOB: usize = 128;
const MAX_CAT_FILE_BATCH_INPUT_BYTES_PER_BLOB: usize = 65;

struct CandidateTreeBlob {
    destination: String,
    mode: String,
    oid: String,
}

struct CandidateBlob {
    destination: String,
    mode: String,
    bytes: Vec<u8>,
}

fn candidate_blobs(
    root: &Path,
    tree: &str,
    destinations: &[String],
) -> Result<Vec<CandidateBlob>, String> {
    if destinations.is_empty()
        || destinations
            .windows(2)
            .any(|pair| pair[0].as_bytes() >= pair[1].as_bytes())
    {
        return Err("V2 candidate tree destinations are not exact sorted unique bytes".to_owned());
    }
    let maximum = destinations
        .len()
        .checked_mul(MAX_LS_TREE_BYTES)
        .ok_or_else(|| "V2 candidate tree batch byte bound overflow".to_owned())?;
    let output = authority_git_output_bounded_with_limits(
        root,
        &["ls-tree", "-z", tree, "--"],
        destinations,
        maximum,
        MAX_GIT_STDERR_BYTES,
    )?;
    if !output.status.success() {
        return Err("V2 candidate tree batch cannot be read".to_owned());
    }
    let rows = parse_candidate_tree_rows(&output.stdout, destinations)?;
    let mut input = Vec::new();
    for row in &rows {
        input.extend_from_slice(row.oid.as_bytes());
        input.push(b'\n');
    }
    let input_limit = rows
        .len()
        .checked_mul(MAX_CAT_FILE_BATCH_INPUT_BYTES_PER_BLOB)
        .ok_or_else(|| "V2 candidate blob batch input bound overflow".to_owned())?;
    if input.len() > input_limit {
        return Err("V2 candidate blob batch input exceeds bound".to_owned());
    }
    // Bound every candidate payload collectively, rather than trusting OID
    // equality to avoid reading it.  Git's --batch header/trailer is bounded
    // separately for every requested object.
    let blob_limit = super::MAX_VENDORED_SOURCE_BYTES
        .checked_add(
            rows.len()
                .checked_mul(MAX_CAT_FILE_BATCH_FRAMING_BYTES_PER_BLOB)
                .ok_or_else(|| "V2 candidate blob batch output bound overflow".to_owned())?,
        )
        .ok_or_else(|| "V2 candidate blob batch output bound overflow".to_owned())?;
    let output = authority_git_output_bounded_with_input(
        root,
        &["cat-file", "--batch"],
        &[],
        &input,
        blob_limit,
        MAX_GIT_STDERR_BYTES,
    )?;
    if !output.status.success() {
        return Err("V2 candidate tree blob batch cannot be read".to_owned());
    }
    parse_candidate_blob_batch(&output.stdout, &rows)
}

fn parse_candidate_tree_rows(
    bytes: &[u8],
    destinations: &[String],
) -> Result<Vec<CandidateTreeBlob>, String> {
    let rows = bytes
        .strip_suffix(&[0])
        .ok_or_else(|| "V2 candidate tree batch lacks final NUL terminator".to_owned())?;
    if rows.is_empty() || rows.split(|byte| *byte == 0).any(|row| row.is_empty()) {
        return Err("V2 candidate tree batch has empty or trailing rows".to_owned());
    }
    let parsed = rows
        .split(|byte| *byte == 0)
        .map(|row| {
            let tab = row
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| "V2 candidate tree row lacks TAB".to_owned())?;
            let destination = std::str::from_utf8(&row[tab + 1..])
                .map_err(|_| "V2 candidate tree destination is not UTF-8".to_owned())?;
            let header = std::str::from_utf8(&row[..tab])
                .map_err(|_| "V2 candidate tree header is not UTF-8".to_owned())?;
            let mut parts = header.split_whitespace();
            let (Some(mode), Some(kind), Some(oid)) = (parts.next(), parts.next(), parts.next())
            else {
                return Err("V2 candidate tree row incomplete".to_owned());
            };
            if parts.next().is_some()
                || kind != "blob"
                || !matches!(mode, "100644" | "100755")
                || !is_git_oid(oid)
            {
                return Err("V2 candidate tree row is malformed".to_owned());
            }
            Ok(CandidateTreeBlob {
                destination: destination.to_owned(),
                mode: mode.to_owned(),
                oid: oid.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.len() != destinations.len()
        || parsed
            .iter()
            .zip(destinations)
            .any(|(row, destination)| row.destination != *destination)
    {
        return Err(
            "V2 candidate tree batch omitted, added, or reordered a destination".to_owned(),
        );
    }
    Ok(parsed)
}

fn parse_candidate_blob_batch(
    bytes: &[u8],
    rows: &[CandidateTreeBlob],
) -> Result<Vec<CandidateBlob>, String> {
    let mut cursor = 0_usize;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let header_end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .ok_or_else(|| "V2 candidate blob batch header missing".to_owned())?;
        let header = std::str::from_utf8(&bytes[cursor..header_end])
            .map_err(|_| "V2 candidate blob batch header is not UTF-8".to_owned())?;
        let mut parts = header.split_whitespace();
        let (Some(oid), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            return Err("V2 candidate blob batch header is incomplete".to_owned());
        };
        let size = size
            .parse::<usize>()
            .map_err(|_| "V2 candidate blob batch size is malformed".to_owned())?;
        if parts.next().is_some()
            || oid != row.oid
            || kind != "blob"
            || !is_git_oid(oid)
            || size > super::MAX_AUTHORITY_SOURCE_BYTES
        {
            return Err("V2 candidate blob batch header differs from tree".to_owned());
        }
        let payload_start = header_end
            .checked_add(1)
            .ok_or_else(|| "V2 candidate blob batch size overflow".to_owned())?;
        let payload_end = payload_start
            .checked_add(size)
            .ok_or_else(|| "V2 candidate blob batch size overflow".to_owned())?;
        if payload_end >= bytes.len() || bytes[payload_end] != b'\n' {
            return Err("V2 candidate blob batch payload is truncated".to_owned());
        }
        candidates.push(CandidateBlob {
            destination: row.destination.clone(),
            mode: row.mode.clone(),
            bytes: bytes[payload_start..payload_end].to_vec(),
        });
        cursor = payload_end + 1;
    }
    if cursor != bytes.len() {
        return Err("V2 candidate blob batch has trailing or missing rows".to_owned());
    }
    Ok(candidates)
}

fn candidate_blob(root: &Path, tree: &str, destination: &str) -> Result<CandidateBlob, String> {
    let output = authority_git_output_bounded_with_limits(
        root,
        &["ls-tree", "-z", tree, "--", destination],
        &[],
        MAX_LS_TREE_BYTES,
        MAX_GIT_STDERR_BYTES,
    )?;
    if !output.status.success() {
        return Err(format!("V2 candidate tree cannot read {destination}"));
    }
    let row = output
        .stdout
        .strip_suffix(&[0])
        .ok_or_else(|| "V2 candidate ls-tree lacks NUL terminator".to_owned())?;
    if row.is_empty() || row.contains(&0) {
        return Err("V2 candidate ls-tree did not return exactly one row".to_owned());
    }
    let tab = row
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| "V2 candidate ls-tree row lacks TAB".to_owned())?;
    if &row[tab + 1..] != destination.as_bytes() {
        return Err("V2 candidate ls-tree destination drift".to_owned());
    }
    let header = std::str::from_utf8(&row[..tab])
        .map_err(|error| format!("V2 candidate ls-tree header UTF-8: {error}"))?;
    let mut parts = header.split_whitespace();
    let (Some(mode), Some(kind), Some(oid)) = (parts.next(), parts.next(), parts.next()) else {
        return Err("V2 candidate ls-tree row incomplete".to_owned());
    };
    if parts.next().is_some()
        || kind != "blob"
        || !matches!(mode, "100644" | "100755")
        || !is_git_oid(oid)
    {
        return Err("V2 candidate tree leaf is not a regular exact blob".to_owned());
    }
    let output = authority_git_output_bounded_with_limits(
        root,
        &["cat-file", "blob", oid],
        &[],
        super::MAX_AUTHORITY_SOURCE_BYTES,
        MAX_GIT_STDERR_BYTES,
    )?;
    if !output.status.success() {
        return Err("V2 candidate tree blob cannot be read".to_owned());
    }
    Ok(CandidateBlob {
        destination: destination.to_owned(),
        mode: mode.to_owned(),
        bytes: output.stdout,
    })
}

fn wrap_receipt(receipt: CoreV2PackageProofReceiptV1) -> Result<ValidationReceiptRecord, String> {
    let value = serde_json::to_value(&receipt).map_err(|error| error.to_string())?;
    let bytes = super::validation_authority::canonical_json_bytes(&value)?;
    if bytes.len() > MAX_RECEIPT_JSON_BYTES {
        return Err(format!(
            "V2 package proof receipt exceeds {MAX_RECEIPT_JSON_BYTES} bytes"
        ));
    }
    let digest = sha256_hex(&bytes);
    Ok(ValidationReceiptRecord {
        evidence_ref: Ref(format!(
            "v2-package-proof-receipt:{}:{digest}",
            receipt.proof_id.0
        )),
        receipt_digest: Digest(digest),
        receipt_json: Bytes(String::from_utf8(bytes).map_err(|error| error.to_string())?),
        kind: "delivery-v2-package-proof".to_owned(),
        exact_commit: GitOid(receipt.package_commit),
        exact_tree: GitOid(receipt.package_tree),
        binding_id: receipt.proof_id,
        unit_id: receipt.unit_id,
        criterion_ids: receipt.criterion_ids,
    })
}

/// Hash the complete canonical receipt while its self-field is empty.  Do not
/// hand-maintain a list here: new required receipt fields must be bound by
/// default, and verifier/construction use this exact operation.
fn proof_subject_digest(receipt: &CoreV2PackageProofReceiptV1) -> Result<String, String> {
    let mut value = serde_json::to_value(receipt).map_err(|error| error.to_string())?;
    value
        .as_object_mut()
        .ok_or_else(|| "V2 package receipt is not an object".to_owned())?
        .insert(
            "proof_subject_digest".to_owned(),
            serde_json::Value::String(String::new()),
        );
    let canonical = super::validation_authority::canonical_json_bytes(&value)?;
    let mut hash = Sha256::new();
    hash.update(b"autopilot.core_v2_package_proof.subject.v1\0");
    hash.update((canonical.len() as u64).to_be_bytes());
    hash.update(canonical);
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Validate fields which are compact commitments before replaying objects.
/// Replay below additionally proves every count/list/witness against the
/// externally rooted image, materialization pair, origin, and candidate tree.
pub(crate) fn validate_receipt_shape_and_subject_digest(
    receipt: &CoreV2PackageProofReceiptV1,
) -> Result<(), String> {
    let digests = [
        &receipt.delivery_producer_assignment_digest,
        &receipt.approved_plan_binding_digest,
        &receipt.approved_image_digest,
        &receipt.materialization_receipt_digest,
        &receipt.package_scope_files_digest,
        &receipt.vendor_binding_ids_digest,
        &receipt.candidate_vendor_tree_witness_digest,
        &receipt.candidate_manifest_tree_witness_digest,
        &receipt.proof_subject_digest,
        &receipt.expected_text_digest,
    ];
    if receipt.schema != CORE_V2_PACKAGE_PROOF_RECEIPT_V1_SCHEMA
        || receipt.proof_id.0.trim().is_empty()
        || receipt.unit_id.0.trim().is_empty()
        || receipt.validator_assignment_id.0.trim().is_empty()
        || receipt.delivery_producer_assignment_id.0.trim().is_empty()
        || !digests.iter().all(|digest| is_lower_sha256(digest))
        || ![
            &receipt.base_commit,
            &receipt.package_commit,
            &receipt.package_tree,
        ]
        .iter()
        .all(|oid| is_git_oid(oid))
        || receipt.criterion_ordinals.is_empty()
        || receipt
            .criterion_ordinals
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || receipt.criterion_ids.is_empty()
        || receipt
            .criterion_ids
            .windows(2)
            .any(|pair| pair[0].0.as_bytes() >= pair[1].0.as_bytes())
        || receipt
            .changed_paths
            .windows(2)
            .any(|pair| pair[0].as_bytes() >= pair[1].as_bytes())
        || receipt.changed_paths.iter().any(|path| path.is_empty())
        || receipt.proof_subject_digest != proof_subject_digest(receipt)?
    {
        return Err(
            "V2 package receipt shape, lowercase digest, or subject binding drift".to_owned(),
        );
    }
    Ok(())
}

fn authority_producer_assignment_digest(
    authority: &ValidationEvidenceAuthority,
) -> Result<String, String> {
    let digests = authority
        .command_receipts
        .iter()
        .map(|record| {
            let value: serde_json::Value = serde_json::from_str(&record.receipt_json.0)
                .map_err(|_| "V2 package authority command receipt is malformed".to_owned())?;
            value
                .get("producer_assignment_digest")
                .and_then(serde_json::Value::as_str)
                .filter(|digest| is_lower_sha256(digest))
                .map(str::to_owned)
                .ok_or_else(|| "V2 package authority command digest is malformed".to_owned())
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    match digests.into_iter().collect::<Vec<_>>().as_slice() {
        [digest] => Ok(digest.clone()),
        _ => Err("V2 package authority has no single producer assignment digest".to_owned()),
    }
}

fn sorted_strings(mut values: Vec<String>) -> Result<Vec<String>, String> {
    values.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    if values.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("V2 proof summary input has duplicate rows".to_owned());
    }
    Ok(values)
}

fn count(values: &[String]) -> Result<u32, String> {
    u32::try_from(values.len()).map_err(|_| "V2 proof summary count overflow".to_owned())
}

fn canonical_row(fields: &[&str]) -> String {
    let mut bytes = Vec::new();
    for field in fields {
        bytes.extend_from_slice(&(field.len() as u64).to_be_bytes());
        bytes.extend_from_slice(field.as_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn list_digest(domain: &str, rows: &[String]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update((rows.len() as u64).to_be_bytes());
    for row in rows {
        hash.update((row.len() as u64).to_be_bytes());
        hash.update(row.as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> CoreV2PackageProofReceiptV1 {
        let digest = "a".repeat(64);
        let oid = "b".repeat(40);
        let mut receipt = CoreV2PackageProofReceiptV1 {
            schema: CORE_V2_PACKAGE_PROOF_RECEIPT_V1_SCHEMA.to_owned(),
            proof_id: Id("proof".to_owned()),
            kind: PackageProofKindV2::CleanExactPackageTip,
            criterion_ordinals: vec![1, 2],
            criterion_ids: vec![Id("AC-U1-1".to_owned()), Id("AC-U1-2".to_owned())],
            unit_id: Id("U1".to_owned()),
            validator_assignment_id: Id("validator".to_owned()),
            delivery_producer_assignment_id: Id("delivery".to_owned()),
            delivery_producer_assignment_digest: digest.clone(),
            delivery_assignment_path: "/tmp/assignment.json".to_owned(),
            base_commit: oid.clone(),
            package_commit: oid.clone(),
            package_tree: oid.clone(),
            changed_paths: vec!["a.rs".to_owned(), "b.rs".to_owned()],
            approved_plan_binding_path: "/tmp/binding.json".to_owned(),
            approved_plan_binding_digest: digest.clone(),
            approved_image_digest: digest.clone(),
            materialization_receipt_path: "/tmp/receipt.json".to_owned(),
            materialization_receipt_digest: digest.clone(),
            package_scope_files_count: 2,
            package_scope_files_digest: digest.clone(),
            vendor_binding_ids_count: 0,
            vendor_binding_ids_digest: digest.clone(),
            candidate_vendor_tree_witness_count: 0,
            candidate_vendor_tree_witness_digest: digest.clone(),
            candidate_manifest_tree_witness_count: 0,
            candidate_manifest_tree_witness_digest: digest.clone(),
            proof_subject_digest: String::new(),
            expected_text_digest: digest,
        };
        receipt.proof_subject_digest = proof_subject_digest(&receipt).unwrap();
        receipt
    }

    #[test]
    fn complete_subject_binds_every_receipt_field_and_rejects_uppercase_oids() {
        let receipt = receipt();
        assert!(validate_receipt_shape_and_subject_digest(&receipt).is_ok());
        let mut changed_count = receipt.clone();
        changed_count.package_scope_files_count += 1;
        assert!(validate_receipt_shape_and_subject_digest(&changed_count).is_err());
        let mut changed_path = receipt.clone();
        changed_path.changed_paths.swap(0, 1);
        changed_path.proof_subject_digest = proof_subject_digest(&changed_path).unwrap();
        assert!(validate_receipt_shape_and_subject_digest(&changed_path).is_err());
        let mut upper_digest = receipt.clone();
        upper_digest.expected_text_digest = "A".repeat(64);
        upper_digest.proof_subject_digest = proof_subject_digest(&upper_digest).unwrap();
        assert!(validate_receipt_shape_and_subject_digest(&upper_digest).is_err());
        let mut upper_oid = receipt;
        upper_oid.package_tree = "B".repeat(40);
        upper_oid.proof_subject_digest = proof_subject_digest(&upper_oid).unwrap();
        assert!(validate_receipt_shape_and_subject_digest(&upper_oid).is_err());
    }

    #[test]
    fn candidate_batch_keeps_repeated_oids_and_binary_payloads_without_oid_substitution() {
        let oid = "b".repeat(40);
        let destinations = vec!["vendor/a.bin".to_owned(), "vendor/a.bin".to_owned()];
        let tree = format!("100644 blob {oid}\tvendor/a.bin\0100644 blob {oid}\tvendor/a.bin\0");
        let rows = parse_candidate_tree_rows(tree.as_bytes(), &destinations).unwrap();
        assert_eq!(rows.len(), 2, "repeated destinations retain both tree rows");
        let payload = [0_u8, 0xff, b'x', b'\n'];
        let mut batch = Vec::new();
        for _ in &rows {
            batch.extend_from_slice(format!("{oid} blob {}\n", payload.len()).as_bytes());
            batch.extend_from_slice(&payload);
            batch.push(b'\n');
        }
        let candidates = parse_candidate_blob_batch(&batch, &rows).unwrap();
        assert_eq!(
            candidates.len(),
            2,
            "repeated OIDs retain both destinations"
        );
        assert_eq!(candidates[0].destination, "vendor/a.bin");
        assert_eq!(candidates[1].destination, "vendor/a.bin");
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.bytes == payload)
        );
        assert!(parse_candidate_blob_batch(&batch[..batch.len() - 1], &rows).is_err());
    }
}
