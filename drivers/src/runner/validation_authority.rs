//! Shared v3 Validator evidence authority and normalization.
//!
//! Issuance, child admission, repair rendering, and the parent seam all use
//! this module. No caller may treat the issuance document as proof without
//! revalidating its canonical bytes, exact Git snapshot, source/diff records,
//! receipt records, and criterion mappings.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
use std::process::{Command, Stdio};

use kernel::generated::{
    CriterionVerdict, FindingEffect, FindingKindV2, GitOid, Id, PackageCheckKind, Ref,
    ValidationAdmissionDiagnostic, ValidationAuthorityCriterion, ValidationCitationRecord,
    ValidationContextV3, ValidationContextV3Criterion, ValidationEvidenceAuthority,
    ValidationReceiptRecord, ValidationSourceRecord, ValidationSubmissionV3, ValidationVerdictV3,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest as ShaDigest, Sha256};

use super::{read_bounded_file, reject_link_components_for_path};

pub const RECEIPT_PREFIXES: &[&str] = &["approved-command-receipt:", "package-check-receipt:"];
const MAX_GIT_STDERR_BYTES: usize = 64 << 10;
const MAX_SOURCE_BLOB_BYTES: usize = 2 << 20;
const MAX_DIFF_BYTES: usize = 2 << 20;
const MAX_LS_TREE_BYTES: usize = 16 << 10;
const MAX_STATUS_BYTES: usize = 1 << 20;
const MAX_CHANGED_PATH_BYTES: usize = 1 << 20;
const MAX_CRITERIA: usize = 256;
const MAX_FINDINGS: usize = 128;
const MAX_CITATIONS: usize = 64;
const MAX_SOURCE_LOCATIONS: usize = 64;
const MAX_DIAGNOSTIC_LIST_ITEMS: usize = 8;
const MAX_DIAGNOSTIC_ROWS: usize = 2048;
const MAX_DIAGNOSTIC_STRING_BYTES: usize = 512;
const DIAGNOSTIC_ORIGINAL_SUMMARIES_KEY: &str = "_package_original_value_summaries";

/// The authority self-field is excluded from its binding digest to avoid a
/// digest cycle. The exact file must still be canonical pretty JSON, and every
/// reader recomputes this material digest.
pub fn authority_digest(value: &Value) -> Result<String, String> {
    let mut value = value.clone();
    value
        .as_object_mut()
        .ok_or_else(|| "authority must be an object".to_owned())?
        .remove("authority_digest");
    canonical_json_bytes(&value).map(|bytes| sha256_hex(&bytes))
}

/// Canonical source/diff record digest. The evidence_ref self-field is omitted
/// from the digest material, then restored as `validation-*:DIGEST`.
pub fn evidence_record_digest(value: &Value) -> Result<String, String> {
    let mut value = value.clone();
    value
        .as_object_mut()
        .ok_or_else(|| "validation evidence record must be an object".to_owned())?
        .remove("evidence_ref");
    canonical_json_bytes(&value).map(|bytes| sha256_hex(&bytes))
}

pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|error| error.to_string())
}

pub fn capture_candidate_diff(
    root: &Path,
    base_commit: &str,
    exact_commit: &str,
) -> Result<Vec<u8>, String> {
    git_bytes_fixed(
        root,
        &[
            "-c",
            "diff.external=",
            "-c",
            "diff.renames=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            "--full-index",
            "--binary",
            base_commit,
            exact_commit,
            "--",
        ],
        MAX_DIFF_BYTES,
    )
}

pub fn derive_source_record(
    root: &Path,
    exact_commit: &GitOid,
    exact_tree: &GitOid,
    source_path: &str,
) -> Result<Option<ValidationSourceRecord>, String> {
    if !safe_repo_path(source_path) {
        return Err(format!("unsafe validation source path: {source_path}"));
    }
    let tree = git_bytes_fixed(
        root,
        &["ls-tree", "-z", &exact_commit.0, "--", source_path],
        MAX_LS_TREE_BYTES,
    )?;
    let Some(row) = parse_ls_tree_optional(&tree, source_path)? else {
        return Ok(None);
    };
    if row.kind != "blob" || !matches!(row.mode.as_str(), "100644" | "100755") {
        return Err(format!(
            "unsupported validation source mode/type: {}/{}:{source_path}",
            row.mode, row.kind
        ));
    }
    git_bytes_fixed(root, &["cat-file", "blob", &row.oid], MAX_SOURCE_BLOB_BYTES)?;
    let bytes = read_source_snapshot(root, source_path)?;
    let line_count = checked_line_count(&bytes)
        .ok_or_else(|| format!("validation source line count overflow: {source_path}"))?;
    let mut value = json!({
        "evidence_ref": "pending",
        "kind": "source-snapshot",
        "exact_commit": exact_commit,
        "exact_tree": exact_tree,
        "source_path": source_path,
        "git_blob_oid": row.oid,
        "blob_digest": sha256_hex(&bytes),
        "mode": row.mode,
        "line_count": line_count,
    });
    let digest = evidence_record_digest(&value)?;
    value["evidence_ref"] = json!(format!("validation-source:{digest}"));
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn read_source_snapshot(root: &Path, source_path: &str) -> Result<Vec<u8>, String> {
    if !safe_repo_path(source_path) {
        return Err(format!("unsafe validation source path: {source_path}"));
    }
    super::read_bounded_file(&root.join(source_path), MAX_SOURCE_BLOB_BYTES)
        .map_err(|error| format!("validation source snapshot read: {error:?}"))
}

pub fn derive_diff_record(
    base_commit: &GitOid,
    exact_commit: &GitOid,
    exact_tree: &GitOid,
    diff_path: &Path,
    diff_bytes: &[u8],
) -> Result<kernel::generated::ValidationDiffRecord, String> {
    if diff_bytes.len() > MAX_DIFF_BYTES {
        return Err(format!("validation diff exceeds {MAX_DIFF_BYTES} bytes"));
    }
    let mut value = json!({
        "evidence_ref": "pending",
        "kind": "candidate-diff",
        "exact_commit": exact_commit,
        "exact_tree": exact_tree,
        "base_commit": base_commit,
        "diff_digest": sha256_hex(diff_bytes),
        "diff_path": diff_path.display().to_string(),
        "byte_length": u64::try_from(diff_bytes.len())
            .map_err(|_| "validation diff length overflow".to_owned())?,
    });
    let digest = evidence_record_digest(&value)?;
    value["evidence_ref"] = json!(format!("validation-diff:{digest}"));
    serde_json::from_value(value).map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
pub struct ValidationAuthorityExpectation<'a> {
    pub validation_id: &'a Id,
    pub assignment_id: &'a Id,
    pub base_commit: &'a GitOid,
    pub exact_commit: &'a GitOid,
    pub exact_tree: &'a GitOid,
    pub candidate_root: &'a Path,
}

#[derive(Debug, Clone)]
pub struct AdmittedValidationV3 {
    pub submission: ValidationSubmissionV3,
    pub verdict: ValidationVerdictV3,
    pub verdict_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct AdmissionFailure {
    pub diagnostic: Value,
    pub fatal_authority: bool,
}

impl AdmissionFailure {
    fn with_trusted_identity(
        mut self,
        expected: &ValidationAuthorityExpectation<'_>,
        expected_digest: &str,
    ) -> Self {
        let Some(object) = self.diagnostic.as_object_mut() else {
            return fatal_expected(
                expected,
                expected_digest,
                "diagnostic-shape",
                "",
                "object diagnostic before identity binding",
                "non-object internal diagnostic",
            );
        };
        object.insert(
            "validation_id".to_owned(),
            Value::String(expected.validation_id.0.clone()),
        );
        object.insert(
            "assignment_id".to_owned(),
            Value::String(expected.assignment_id.0.clone()),
        );
        object.insert(
            "authority_digest".to_owned(),
            Value::String(expected_digest.to_owned()),
        );
        self
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        let bytes = canonical_json_bytes(&self.diagnostic)?;
        if bytes.len() > kernel::generated::VALIDATION_ADMISSION_DIAGNOSTIC_MAX_BYTES {
            return Err(format!(
                "validation admission diagnostic overflow: {} > {}",
                bytes.len(),
                kernel::generated::VALIDATION_ADMISSION_DIAGNOSTIC_MAX_BYTES
            ));
        }
        let typed: ValidationAdmissionDiagnostic = serde_json::from_slice(&bytes)
            .map_err(|error| format!("generated diagnostic contract rejected output: {error}"))?;
        validate_diagnostic_contract(&typed)?;
        Ok(bytes)
    }
}

#[derive(Debug, Clone)]
pub struct ValidationAuthorityIndex {
    authority: ValidationEvidenceAuthority,
    criterion_order: Vec<Id>,
    criteria: BTreeMap<Id, ValidationAuthorityCriterion>,
    model_evidence: BTreeSet<Ref>,
    source_evidence: BTreeMap<Ref, ValidationSourceRecord>,
    command_receipts_by_criterion: BTreeMap<Id, Vec<Ref>>,
    package_receipts_by_criterion: BTreeMap<Id, Vec<Ref>>,
}

impl ValidationAuthorityIndex {
    pub fn load_for(
        path: &Path,
        expected_digest: &str,
        expected: &ValidationAuthorityExpectation<'_>,
    ) -> Result<Self, AdmissionFailure> {
        let bytes = read_bounded_file(
            path,
            kernel::generated::VALIDATION_EVIDENCE_AUTHORITY_MAX_BYTES,
        )
        .map_err(|error| {
            fatal_expected(
                expected,
                expected_digest,
                "authority-read",
                "/authority_path",
                "bounded regular authority",
                &error.to_string(),
            )
        })?;
        let raw: Value = serde_json::from_slice(&bytes).map_err(|error| {
            fatal_expected(
                expected,
                expected_digest,
                "authority-json",
                "",
                "closed validation evidence authority",
                &error.to_string(),
            )
        })?;
        let canonical_file = serde_json::to_vec_pretty(&raw).map_err(|error| {
            fatal_expected(
                expected,
                expected_digest,
                "authority-json",
                "",
                "canonical pretty JSON",
                &error.to_string(),
            )
        })?;
        if canonical_file != bytes {
            return Err(fatal_expected(
                expected,
                expected_digest,
                "authority-canonical-bytes",
                "",
                "exact canonical pretty JSON bytes",
                "noncanonical bytes",
            ));
        }
        let actual_digest = authority_digest(&raw).map_err(|error| {
            fatal_expected(
                expected,
                expected_digest,
                "authority-digest",
                "",
                "canonical authority material",
                &error,
            )
        })?;
        if actual_digest != expected_digest {
            return Err(fatal_expected(
                expected,
                expected_digest,
                "authority-digest",
                "/authority_digest",
                expected_digest,
                &actual_digest,
            ));
        }
        let authority: ValidationEvidenceAuthority =
            serde_json::from_value(raw).map_err(|error| {
                fatal_expected(
                    expected,
                    expected_digest,
                    "authority-json",
                    "",
                    "closed validation evidence authority",
                    &error.to_string(),
                )
            })?;
        let index = Self::from_authority(authority)
            .map_err(|failure| failure.with_trusted_identity(expected, expected_digest))?;
        index
            .validate_expected_identity(path, expected_digest, expected)
            .map_err(|failure| failure.with_trusted_identity(expected, expected_digest))?;
        Ok(index)
    }

    pub fn from_authority(
        authority: ValidationEvidenceAuthority,
    ) -> Result<Self, AdmissionFailure> {
        let mut rows = Vec::new();
        validate_authority_bounds(&authority, &mut rows);
        if authority.schema.0 != "autopilot.validation_evidence_authority.v1"
            || !is_sha256_hex(&authority.authority_digest.0)
            || authority.validation_id.0.trim().is_empty()
            || authority.assignment_id.0.trim().is_empty()
        {
            rows.push(row(
                "authority-identity",
                "/authority",
                None,
                None,
                "exact",
                vec!["complete v1 authority identity".to_owned()],
                vec![authority.schema.0.clone()],
                vec![],
                vec![],
                vec![],
            ));
        }

        let criterion_order = authority
            .criteria
            .iter()
            .map(|criterion| criterion.criterion_id.clone())
            .collect::<Vec<_>>();
        let criteria = authority
            .criteria
            .iter()
            .map(|criterion| (criterion.criterion_id.clone(), criterion.clone()))
            .collect::<BTreeMap<_, _>>();
        if criteria.len() != criterion_order.len() || criteria.is_empty() {
            rows.push(row(
                "authority-duplicate-criterion",
                "/criteria",
                None,
                None,
                "exact",
                vec!["nonempty unique criteria".to_owned()],
                strings(&criterion_order),
                vec![],
                vec![],
                duplicate_rows(&strings(&criterion_order)),
            ));
        }

        let mut ordinals_by_unit = BTreeMap::<Id, Vec<u32>>::new();
        for criterion in &authority.criteria {
            ordinals_by_unit
                .entry(criterion.unit_id.clone())
                .or_default()
                .push(criterion.unit_criterion_ordinal);
        }
        if ordinals_by_unit.iter_mut().any(|(_, ordinals)| {
            ordinals.sort_unstable();
            ordinals.iter().copied().ne(1..=ordinals.len() as u32)
        }) {
            rows.push(simple_row(
                "authority-unit-criterion-ordinals",
                "/criteria",
                "unique contiguous 1-based criterion ordinals per unit",
                "ordinal drift",
            ));
        }

        let receipt_refs = authority
            .command_receipts
            .iter()
            .chain(&authority.package_check_receipts)
            .map(|record| record.evidence_ref.clone())
            .collect::<Vec<_>>();
        let binding_ids = authority
            .command_receipts
            .iter()
            .chain(&authority.package_check_receipts)
            .map(|record| record.binding_id.clone())
            .collect::<Vec<_>>();
        if set(&receipt_refs).len() != receipt_refs.len()
            || set_ids(&binding_ids).len() != binding_ids.len()
        {
            rows.push(row(
                "authority-duplicate-receipt",
                "/command_receipts",
                None,
                None,
                "exact",
                vec!["globally unique receipt refs and binding ids".to_owned()],
                strings(&receipt_refs),
                vec![],
                vec![],
                duplicate_rows(&strings(&receipt_refs)),
            ));
        }

        let source_refs = authority
            .source_records
            .iter()
            .map(|record| record.evidence_ref.clone())
            .collect::<Vec<_>>();
        let diff_refs = authority
            .diff_records
            .iter()
            .map(|record| record.evidence_ref.clone())
            .collect::<Vec<_>>();
        let all_refs = source_refs
            .iter()
            .chain(&diff_refs)
            .chain(&receipt_refs)
            .cloned()
            .collect::<Vec<_>>();
        if set(&all_refs).len() != all_refs.len() {
            rows.push(row(
                "authority-evidence-refs",
                "/source_records",
                None,
                None,
                "exact",
                vec!["globally unique typed evidence refs".to_owned()],
                strings(&all_refs),
                vec![],
                vec![],
                duplicate_rows(&strings(&all_refs)),
            ));
        }

        let source_by_path = authority
            .source_records
            .iter()
            .map(|record| (record.source_path.0.clone(), record))
            .collect::<BTreeMap<_, _>>();
        if source_by_path.len() != authority.source_records.len() {
            rows.push(simple_row(
                "authority-source-paths",
                "/source_records",
                "unique source paths",
                "duplicate source path",
            ));
        }
        let covered_paths = authority
            .criteria
            .iter()
            .flat_map(|criterion| criterion.covered_paths.iter().map(|path| path.0.clone()))
            .collect::<BTreeSet<_>>();
        let deleted_paths = authority
            .deleted_paths
            .iter()
            .map(|path| path.0.clone())
            .collect::<BTreeSet<_>>();
        let represented_paths = source_by_path
            .keys()
            .cloned()
            .chain(deleted_paths.iter().cloned())
            .collect::<BTreeSet<_>>();
        if source_by_path
            .keys()
            .any(|path| deleted_paths.contains(path))
        {
            rows.push(simple_row(
                "authority-deleted-source-overlap",
                "/deleted_paths",
                "deleted and exact-tip source paths are disjoint",
                "overlap",
            ));
        }
        if represented_paths != covered_paths {
            rows.push(row(
                "authority-source-paths",
                "/source_records",
                None,
                None,
                "exact",
                covered_paths.iter().cloned().collect(),
                represented_paths.into_iter().collect(),
                vec![],
                vec![],
                vec![],
            ));
        }

        let all_model = source_refs
            .iter()
            .chain(&diff_refs)
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut command_receipts_by_criterion = BTreeMap::new();
        let mut package_receipts_by_criterion = BTreeMap::new();
        for (criterion_index, criterion) in authority.criteria.iter().enumerate() {
            validate_authority_criterion(
                criterion_index,
                criterion,
                &source_by_path,
                &authority,
                &all_model,
                &mut rows,
            );
            command_receipts_by_criterion.insert(
                criterion.criterion_id.clone(),
                sorted_refs(&criterion.command_receipt_refs),
            );
            package_receipts_by_criterion.insert(
                criterion.criterion_id.clone(),
                sorted_refs(&criterion.package_check_receipt_refs),
            );
        }
        validate_receipts(
            &authority,
            &criteria,
            &command_receipts_by_criterion,
            &package_receipts_by_criterion,
            &mut rows,
        );
        validate_record_bindings(&authority, &mut rows);

        if !rows.is_empty() {
            return Err(diagnostic(
                &authority,
                0,
                "authority",
                "fatal-authority",
                rows,
                true,
            ));
        }
        let source_evidence = authority
            .source_records
            .iter()
            .map(|record| (record.evidence_ref.clone(), record.clone()))
            .collect();
        Ok(Self {
            authority,
            criterion_order,
            criteria,
            model_evidence: all_model,
            source_evidence,
            command_receipts_by_criterion,
            package_receipts_by_criterion,
        })
    }

    fn validate_expected_identity(
        &self,
        authority_path: &Path,
        expected_digest: &str,
        expected: &ValidationAuthorityExpectation<'_>,
    ) -> Result<(), AdmissionFailure> {
        let canonical_root = std::fs::canonicalize(expected.candidate_root).map_err(|error| {
            fatal_expected(
                expected,
                expected_digest,
                "candidate-root",
                "/candidate_root",
                &expected.candidate_root.display().to_string(),
                &error.to_string(),
            )
        })?;
        let mut rows = Vec::new();
        for (code, field, expected_value, actual_value) in [
            (
                "authority-digest-binding",
                "/authority_digest",
                expected_digest,
                self.authority.authority_digest.0.as_str(),
            ),
            (
                "validation-id-binding",
                "/validation_id",
                expected.validation_id.0.as_str(),
                self.authority.validation_id.0.as_str(),
            ),
            (
                "assignment-id-binding",
                "/assignment_id",
                expected.assignment_id.0.as_str(),
                self.authority.assignment_id.0.as_str(),
            ),
            (
                "base-commit-binding",
                "/base_commit",
                expected.base_commit.0.as_str(),
                self.authority.base_commit.0.as_str(),
            ),
            (
                "exact-commit-binding",
                "/exact_commit",
                expected.exact_commit.0.as_str(),
                self.authority.exact_commit.0.as_str(),
            ),
            (
                "exact-tree-binding",
                "/exact_tree",
                expected.exact_tree.0.as_str(),
                self.authority.exact_tree.0.as_str(),
            ),
        ] {
            if actual_value != expected_value {
                rows.push(simple_row(code, field, expected_value, actual_value));
            }
        }
        let canonical_root_text = canonical_root.display().to_string();
        if self.authority.candidate_root.0 != canonical_root_text {
            rows.push(simple_row(
                "candidate-root-binding",
                "/candidate_root",
                &canonical_root_text,
                &self.authority.candidate_root.0,
            ));
        }
        if !authority_path.is_absolute() {
            rows.push(simple_row(
                "authority-path-binding",
                "/authority_path",
                "absolute authority path",
                &authority_path.display().to_string(),
            ));
        }
        let expected_diff_path = authority_path
            .parent()
            .ok_or_else(|| {
                fatal_expected(
                    expected,
                    expected_digest,
                    "authority-path",
                    "/authority_path",
                    "authority path with parent",
                    &authority_path.display().to_string(),
                )
            })?
            .join("candidate.v3.diff");
        if Path::new(&self.authority.diff_path.0) != expected_diff_path {
            rows.push(simple_row(
                "diff-path-binding",
                "/diff_path",
                &expected_diff_path.display().to_string(),
                &self.authority.diff_path.0,
            ));
        }
        rows.extend(verify_live_artifacts(&self.authority));
        if rows.is_empty() {
            Ok(())
        } else {
            Err(diagnostic(
                &self.authority,
                0,
                "authority",
                "fatal-authority",
                rows,
                true,
            ))
        }
    }

    #[must_use]
    pub fn context_projection(&self) -> ValidationContextV3 {
        let criteria = self
            .criterion_order
            .iter()
            .map(|id| {
                let criterion = &self.criteria[id];
                ValidationContextV3Criterion {
                    criterion_id: id.clone(),
                    requirement_text: criterion.requirement_text.clone(),
                    allowed_citation_refs: criterion.allowed_citation_refs.clone(),
                }
            })
            .collect();
        let citation_records = self
            .authority
            .source_records
            .iter()
            .map(|record| ValidationCitationRecord {
                evidence_ref: record.evidence_ref.clone(),
                kind: record.kind.clone(),
                source_path: Some(record.source_path.clone()),
                blob_digest: Some(record.blob_digest.clone()),
                line_count: Some(record.line_count),
                diff_digest: None,
                diff_path: None,
            })
            .chain(
                self.authority
                    .diff_records
                    .iter()
                    .map(|record| ValidationCitationRecord {
                        evidence_ref: record.evidence_ref.clone(),
                        kind: record.kind.clone(),
                        source_path: None,
                        blob_digest: None,
                        line_count: None,
                        diff_digest: Some(record.diff_digest.clone()),
                        diff_path: Some(record.diff_path.clone()),
                    }),
            )
            .collect();
        ValidationContextV3 {
            schema: kernel::generated::SchemaId("autopilot.validation_context.v3".to_owned()),
            validation_id: self.authority.validation_id.clone(),
            assignment_id: self.authority.assignment_id.clone(),
            authority_digest: self.authority.authority_digest.clone(),
            criteria,
            citation_records,
        }
    }

    pub fn admit_raw(
        &self,
        payload: &Value,
        value_attempt: u32,
    ) -> Result<AdmittedValidationV3, AdmissionFailure> {
        let bytes = canonical_json_bytes(payload).map_err(|error| {
            shape_failure(&self.authority, value_attempt, "payload-json", &error)
        })?;
        if bytes.len() > kernel::generated::VALIDATION_SUBMISSION_V3_MAX_BYTES {
            return Err(shape_failure(
                &self.authority,
                value_attempt,
                "payload-bytes",
                &format!(
                    "{} > {}",
                    bytes.len(),
                    kernel::generated::VALIDATION_SUBMISSION_V3_MAX_BYTES
                ),
            ));
        }
        let shape_rows = validate_submission_shape(payload);
        if !shape_rows.is_empty() {
            return Err(diagnostic(
                &self.authority,
                value_attempt,
                "shape",
                "repairable-model-value",
                shape_rows,
                false,
            ));
        }
        let submission: ValidationSubmissionV3 =
            serde_json::from_slice(&bytes).map_err(|error| {
                diagnostic(
                    &self.authority,
                    value_attempt,
                    "shape",
                    "fatal-authority",
                    vec![simple_row(
                        "shape-validator-parity",
                        "",
                        "manual/generated shape validators agree",
                        &error.to_string(),
                    )],
                    true,
                )
            })?;
        self.admit(&submission, value_attempt)
    }

    pub fn admit(
        &self,
        submission: &ValidationSubmissionV3,
        value_attempt: u32,
    ) -> Result<AdmittedValidationV3, AdmissionFailure> {
        let mut rows = Vec::new();
        if submission.schema.0 != "autopilot.validation_submission.v3" {
            rows.push(row(
                "submission-schema",
                "/schema",
                None,
                None,
                "exact",
                vec!["autopilot.validation_submission.v3".to_owned()],
                vec![submission.schema.0.clone()],
                vec!["autopilot.validation_submission.v3".to_owned()],
                vec![submission.schema.0.clone()],
                vec![],
            ));
        }

        let expected_ids = strings(&self.criterion_order);
        let actual_ids = submission
            .criterion_results
            .iter()
            .map(|result| result.criterion_id.0.clone())
            .collect::<Vec<_>>();
        let mismatch = multiset_mismatch(&expected_ids, &actual_ids);
        if mismatch.changed_exact() {
            rows.push(row(
                "criterion-results",
                "/criterion_results",
                None,
                None,
                "exact",
                mismatch.expected,
                mismatch.actual,
                mismatch.missing,
                mismatch.extra,
                mismatch.duplicates,
            ));
        }

        let finding_ids = submission
            .findings
            .iter()
            .map(|finding| finding.finding_id.clone())
            .collect::<BTreeSet<_>>();
        for (result_index, result) in submission.criterion_results.iter().enumerate() {
            let criterion_id = &result.criterion_id;
            let result_path = format!("/criterion_results/{result_index}");
            let linked = result
                .finding_ids
                .iter()
                .map(|id| id.0.clone())
                .collect::<Vec<_>>();
            let unknown = result
                .finding_ids
                .iter()
                .filter(|id| !finding_ids.contains(id))
                .map(|id| id.0.clone())
                .collect::<Vec<_>>();
            if !unknown.is_empty() || has_duplicates(&linked) {
                rows.push(row(
                    "criterion-finding-ids",
                    &format!("{result_path}/finding_ids"),
                    Some(criterion_id),
                    None,
                    "membership",
                    strings(
                        &submission
                            .findings
                            .iter()
                            .map(|finding| finding.finding_id.clone())
                            .collect::<Vec<_>>(),
                    ),
                    linked.clone(),
                    vec![],
                    unknown,
                    duplicate_rows(&linked),
                ));
            }
            let cited = strings(&result.citation_refs);
            let Some(criterion) = self.criteria.get(criterion_id) else {
                let invalid = result
                    .citation_refs
                    .iter()
                    .filter(|reference| {
                        is_receipt_ref(&reference.0) || !self.model_evidence.contains(reference)
                    })
                    .map(|reference| reference.0.clone())
                    .collect::<Vec<_>>();
                if cited.is_empty() || !invalid.is_empty() || has_duplicates(&cited) {
                    rows.push(row(
                        "criterion-citation-refs",
                        &format!("{result_path}/citation_refs"),
                        Some(criterion_id),
                        None,
                        "membership",
                        vec!["known criterion-specific source/diff citations".to_owned()],
                        cited.clone(),
                        vec![],
                        invalid,
                        duplicate_rows(&cited),
                    ));
                }
                continue;
            };
            let allowed = strings(&sorted_refs(&criterion.allowed_citation_refs));
            let comparison = multiset_subset(&allowed, &cited);
            if cited.is_empty()
                || comparison.changed_subset()
                || result.citation_refs.iter().any(|reference| {
                    is_receipt_ref(&reference.0) || !self.model_evidence.contains(reference)
                })
            {
                rows.push(row(
                    "criterion-citation-refs",
                    &format!("{result_path}/citation_refs"),
                    Some(criterion_id),
                    None,
                    "subset-of",
                    allowed,
                    comparison.actual,
                    vec![],
                    comparison.extra,
                    comparison.duplicates,
                ));
            }
        }

        let finding_order = submission
            .findings
            .iter()
            .map(|finding| finding.finding_id.0.clone())
            .collect::<Vec<_>>();
        for (finding_index, finding) in submission.findings.iter().enumerate() {
            let field = format!("/findings/{finding_index}");
            let duplicate_count = finding_order
                .iter()
                .filter(|id| **id == finding.finding_id.0)
                .count();
            if finding.finding_id.0.trim().is_empty() || duplicate_count > 1 {
                rows.push(row(
                    "finding-identity",
                    &format!("{field}/finding_id"),
                    None,
                    Some(&finding.finding_id),
                    "exact",
                    vec!["unique nonempty finding id".to_owned()],
                    vec![finding.finding_id.0.clone()],
                    vec![],
                    vec![],
                    duplicate_rows(&finding_order),
                ));
            }
            if finding.summary.trim().is_empty() {
                rows.push(simple_finding_row(
                    "finding-summary",
                    &format!("{field}/summary"),
                    &finding.finding_id,
                    "nonempty summary",
                    &finding.summary,
                ));
            }
            if finding.detail.trim().is_empty() {
                rows.push(simple_finding_row(
                    "finding-detail",
                    &format!("{field}/detail"),
                    &finding.finding_id,
                    "nonempty detail",
                    &finding.detail,
                ));
            }

            let ids = strings(&finding.criterion_ids);
            let allowed_ids = strings(&self.criterion_order);
            let ids_check = multiset_subset(&allowed_ids, &ids);
            if ids.is_empty() || ids_check.changed_subset() {
                rows.push(row(
                    "finding-criterion-ids",
                    &format!("{field}/criterion_ids"),
                    None,
                    Some(&finding.finding_id),
                    "subset-of",
                    allowed_ids,
                    ids_check.actual,
                    vec![],
                    ids_check.extra,
                    ids_check.duplicates,
                ));
            }

            let allowed_citations =
                allowed_finding_citations(&self.criteria, &finding.criterion_ids);
            let citations = strings(&finding.citation_refs);
            let citations_check = multiset_subset(&allowed_citations, &citations);
            if citations.is_empty()
                || citations_check.changed_subset()
                || finding.citation_refs.iter().any(|reference| {
                    is_receipt_ref(&reference.0) || !self.model_evidence.contains(reference)
                })
            {
                rows.push(row(
                    "finding-citation-refs",
                    &format!("{field}/citation_refs"),
                    None,
                    Some(&finding.finding_id),
                    "subset-of",
                    allowed_citations,
                    citations_check.actual,
                    vec![],
                    citations_check.extra,
                    citations_check.duplicates,
                ));
            }

            let locations = finding
                .source_locations
                .iter()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.citation_ref.0, location.start_line, location.end_line
                    )
                })
                .collect::<Vec<_>>();
            let mut invalid_locations = Vec::new();
            for location in &finding.source_locations {
                let valid = self
                    .source_evidence
                    .get(&location.citation_ref)
                    .is_some_and(|source| {
                        finding.citation_refs.contains(&location.citation_ref)
                            && finding.criterion_ids.iter().all(|criterion_id| {
                                self.criteria.get(criterion_id).is_some_and(|criterion| {
                                    criterion
                                        .allowed_citation_refs
                                        .contains(&location.citation_ref)
                                })
                            })
                            && location.start_line >= 1
                            && location.start_line <= location.end_line
                            && location.end_line <= source.line_count
                    });
                if !valid {
                    invalid_locations.push(format!(
                        "{}:{}:{}",
                        location.citation_ref.0, location.start_line, location.end_line
                    ));
                }
            }
            if !invalid_locations.is_empty() || has_duplicates(&locations) {
                rows.push(row(
                    "finding-source-locations",
                    &format!("{field}/source_locations"),
                    None,
                    Some(&finding.finding_id),
                    "line-bounds",
                    finding
                        .citation_refs
                        .iter()
                        .filter_map(|reference| self.source_evidence.get(reference))
                        .map(|source| format!("{}:1:{}", source.evidence_ref.0, source.line_count))
                        .collect(),
                    locations,
                    vec![],
                    invalid_locations,
                    duplicate_rows(
                        &finding
                            .source_locations
                            .iter()
                            .map(|location| {
                                format!(
                                    "{}:{}:{}",
                                    location.citation_ref.0, location.start_line, location.end_line
                                )
                            })
                            .collect::<Vec<_>>(),
                    ),
                ));
            }
            if finding.kind == FindingKindV2::SourceDefect
                && (finding.source_locations.is_empty()
                    || !finding
                        .citation_refs
                        .iter()
                        .any(|reference| self.source_evidence.contains_key(reference)))
            {
                rows.push(simple_finding_row(
                    "source-defect-location",
                    &format!("{field}/source_locations"),
                    &finding.finding_id,
                    "nonempty in-scope source location",
                    "missing",
                ));
            }
        }

        for (result_index, result) in submission.criterion_results.iter().enumerate() {
            let criterion_id = &result.criterion_id;
            if !self.criteria.contains_key(criterion_id) {
                continue;
            }
            let linked_findings = result
                .finding_ids
                .iter()
                .flat_map(|finding_id| {
                    submission
                        .findings
                        .iter()
                        .filter(move |finding| finding.finding_id == *finding_id)
                })
                .collect::<Vec<_>>();
            let expected_backlinks = strings(&result.finding_ids);
            let actual_backlinks = result
                .finding_ids
                .iter()
                .filter(|finding_id| {
                    submission.findings.iter().any(|finding| {
                        finding.finding_id == **finding_id
                            && finding.criterion_ids.contains(criterion_id)
                    })
                })
                .map(|id| id.0.clone())
                .collect::<Vec<_>>();
            let (missing_backlinks, _) = difference(&expected_backlinks, &actual_backlinks);
            if !missing_backlinks.is_empty() {
                rows.push(row(
                    "criterion-finding-link",
                    &format!("/criterion_results/{result_index}/finding_ids"),
                    Some(criterion_id),
                    None,
                    "membership",
                    expected_backlinks,
                    actual_backlinks,
                    missing_backlinks,
                    vec![],
                    vec![],
                ));
            }
            let blocking = linked_findings
                .iter()
                .copied()
                .filter(|finding| finding.effect == FindingEffect::ForwardBlocking)
                .collect::<Vec<_>>();
            let coherent = match result.verdict {
                CriterionVerdict::PASS => blocking.is_empty(),
                CriterionVerdict::FAIL => blocking.iter().any(|finding| {
                    matches!(
                        finding.kind,
                        FindingKindV2::SourceDefect
                            | FindingKindV2::TestDefect
                            | FindingKindV2::ContractDefect
                    )
                }),
                CriterionVerdict::BLOCKED => blocking.iter().any(|finding| {
                    matches!(
                        finding.kind,
                        FindingKindV2::ContextGap
                            | FindingKindV2::EvidenceGap
                            | FindingKindV2::UnsafeBoundary
                    )
                }),
            };
            if !coherent {
                let expected = match result.verdict {
                    CriterionVerdict::PASS => "PASS with no forward-blocking finding",
                    CriterionVerdict::FAIL => {
                        "FAIL with a source-defect, test-defect, or contract-defect forward blocker"
                    }
                    CriterionVerdict::BLOCKED => {
                        "BLOCKED with a context-gap, evidence-gap, or unsafe-boundary forward blocker"
                    }
                };
                rows.push(row(
                    "criterion-verdict-blocker-coherence",
                    &format!("/criterion_results/{result_index}/verdict"),
                    Some(criterion_id),
                    None,
                    "exact",
                    vec![expected.to_owned()],
                    blocking
                        .iter()
                        .map(|finding| format!("{}:{:?}", finding.finding_id.0, finding.kind))
                        .collect(),
                    vec![],
                    vec![],
                    vec![],
                ));
            }
        }

        for (finding_index, finding) in submission.findings.iter().enumerate() {
            let actual_links = finding
                .criterion_ids
                .iter()
                .filter(|criterion_id| {
                    submission.criterion_results.iter().any(|result| {
                        result.criterion_id == **criterion_id
                            && result.finding_ids.contains(&finding.finding_id)
                    })
                })
                .map(|id| id.0.clone())
                .collect::<Vec<_>>();
            let expected_links = strings(&finding.criterion_ids);
            let (missing_links, _) = difference(&expected_links, &actual_links);
            if !missing_links.is_empty() {
                rows.push(row(
                    "finding-criterion-link",
                    &format!("/findings/{finding_index}/criterion_ids"),
                    None,
                    Some(&finding.finding_id),
                    "membership",
                    expected_links,
                    actual_links,
                    missing_links,
                    vec![],
                    vec![],
                ));
            }
            if finding.effect == FindingEffect::ForwardBlocking
                && finding.criterion_ids.iter().any(|criterion_id| {
                    submission.criterion_results.iter().any(|result| {
                        result.criterion_id == *criterion_id
                            && result.verdict == CriterionVerdict::PASS
                    })
                })
            {
                rows.push(simple_finding_row(
                    "blocking-finding-verdict",
                    &format!("/findings/{finding_index}/effect"),
                    &finding.finding_id,
                    "all linked criteria non-PASS",
                    "linked PASS criterion",
                ));
            }
        }

        if !rows.is_empty() {
            return Err(diagnostic(
                &self.authority,
                value_attempt,
                "value",
                "repairable-model-value",
                rows,
                false,
            ));
        }

        let results = submission
            .criterion_results
            .iter()
            .map(|result| (result.criterion_id.clone(), result))
            .collect::<BTreeMap<_, _>>();
        let mut normalized_criteria = Vec::new();
        let mut failed = false;
        let mut blocked = false;
        for id in &self.criterion_order {
            let result = results[id];
            failed |= result.verdict == CriterionVerdict::FAIL;
            blocked |= result.verdict == CriterionVerdict::BLOCKED;
            let authority = &self.criteria[id];
            normalized_criteria.push(json!({
                "criterion_id": id,
                "verdict": result.verdict,
                "model_citation_refs": sorted_refs(&result.citation_refs),
                "command_receipt_refs": self.command_receipts_by_criterion[id],
                "package_check_receipt_refs": self.package_receipts_by_criterion[id],
                "finding_ids": sorted_ids(&result.finding_ids),
                "covered_paths": sorted_paths(&authority.covered_paths),
                "semantic_surface_ids": sorted_ids(&authority.semantic_surface_ids),
                "forward_edge_ids": sorted_ids(&authority.forward_edge_ids),
            }));
        }
        blocked |= submission.findings.iter().any(|finding| {
            finding.effect == FindingEffect::ForwardBlocking
                && matches!(
                    finding.kind,
                    FindingKindV2::ContextGap
                        | FindingKindV2::EvidenceGap
                        | FindingKindV2::UnsafeBoundary
                )
        });
        failed |= submission.findings.iter().any(|finding| {
            finding.effect == FindingEffect::ForwardBlocking
                && matches!(
                    finding.kind,
                    FindingKindV2::SourceDefect
                        | FindingKindV2::TestDefect
                        | FindingKindV2::ContractDefect
                )
        });
        let outcome = if blocked {
            "BLOCKED"
        } else if failed {
            "FORWARD_BLOCKED"
        } else {
            "FORWARD_READY"
        };
        let mut normalized_findings = submission.findings.clone();
        for finding in &mut normalized_findings {
            finding.criterion_ids = sorted_ids(&finding.criterion_ids);
            finding.citation_refs = sorted_refs(&finding.citation_refs);
            finding.source_locations.sort_by(|left, right| {
                (
                    left.citation_ref.0.as_bytes(),
                    left.start_line,
                    left.end_line,
                )
                    .cmp(&(
                        right.citation_ref.0.as_bytes(),
                        right.start_line,
                        right.end_line,
                    ))
            });
        }
        normalized_findings.sort_by(|left, right| {
            left.finding_id
                .0
                .as_bytes()
                .cmp(right.finding_id.0.as_bytes())
        });
        let canonical_submission = ValidationSubmissionV3 {
            schema: submission.schema.clone(),
            criterion_results: self
                .criterion_order
                .iter()
                .map(|id| {
                    let mut result = results[id].clone();
                    result.citation_refs = sorted_refs(&result.citation_refs);
                    result.finding_ids = sorted_ids(&result.finding_ids);
                    result
                })
                .collect(),
            findings: normalized_findings.clone(),
        };
        let submission_bytes = serde_json::to_vec(&canonical_submission).map_err(|error| {
            diagnostic(
                &self.authority,
                value_attempt,
                "value",
                "fatal-authority",
                vec![simple_row(
                    "canonical-submission-bytes",
                    "",
                    "serializable canonical v3 submission",
                    &error.to_string(),
                )],
                true,
            )
        })?;
        if submission_bytes.len() > kernel::generated::VALIDATION_SUBMISSION_V3_MAX_BYTES {
            return Err(diagnostic(
                &self.authority,
                value_attempt,
                "value",
                "fatal-authority",
                vec![simple_row(
                    "canonical-submission-bytes",
                    "",
                    "bounded canonical v3 submission",
                    &submission_bytes.len().to_string(),
                )],
                true,
            ));
        }
        let verdict_value = json!({
            "schema": "autopilot.validation_verdict.v3",
            "validation_id": self.authority.validation_id,
            "assignment_id": self.authority.assignment_id,
            "exact_commit": self.authority.exact_commit,
            "exact_tree": self.authority.exact_tree,
            "outcome": outcome,
            "criterion_results": normalized_criteria,
            "findings": normalized_findings,
        });
        let verdict: ValidationVerdictV3 =
            serde_json::from_value(verdict_value).map_err(|error| {
                fatal_authority(
                    &self.authority,
                    value_attempt,
                    "normalized-verdict",
                    "/verdict",
                    "closed normalized v3 verdict",
                    &error.to_string(),
                )
            })?;
        let verdict_bytes = serde_json::to_vec(&verdict).map_err(|error| {
            fatal_authority(
                &self.authority,
                value_attempt,
                "normalized-verdict-bytes",
                "/verdict",
                "serializable normalized v3 verdict",
                &error.to_string(),
            )
        })?;
        if verdict_bytes.len() > kernel::generated::VALIDATION_VERDICT_V3_MAX_BYTES {
            return Err(fatal_authority(
                &self.authority,
                value_attempt,
                "normalized-verdict-bytes",
                "/verdict",
                "bounded normalized v3 verdict",
                &verdict_bytes.len().to_string(),
            ));
        }
        Ok(AdmittedValidationV3 {
            submission: canonical_submission,
            verdict,
            verdict_bytes,
        })
    }
}

fn validate_authority_bounds(authority: &ValidationEvidenceAuthority, rows: &mut Vec<Value>) {
    if authority.criteria.is_empty()
        || authority.criteria.len() > MAX_CRITERIA
        || authority.source_records.len() > 256
        || authority.deleted_paths.len() > 256
        || authority.diff_records.len() != 1
        || authority.command_receipts.is_empty()
        || authority.command_receipts.len() > 256
        || authority.package_check_receipts.len() > 256
        || authority.changed_paths.len() > 256
        || authority.unchanged_recovery != authority.changed_paths.is_empty()
    {
        rows.push(simple_row(
            "authority-bounds",
            "/authority",
            "generated authority cardinality and candidate-posture bounds",
            "out of bounds",
        ));
    }
    let changed = authority
        .changed_paths
        .iter()
        .map(|path| path.0.clone())
        .collect::<Vec<_>>();
    if has_duplicates(&changed)
        || !is_sorted(&changed)
        || changed.iter().any(|path| !safe_repo_path(path))
    {
        rows.push(row(
            "authority-changed-paths",
            "/changed_paths",
            None,
            None,
            "exact",
            sorted_strings(changed.clone()),
            changed.clone(),
            vec![],
            vec![],
            duplicate_rows(&changed),
        ));
    }
    let deleted = strings(&authority.deleted_paths);
    if has_duplicates(&deleted)
        || !is_sorted(&deleted)
        || deleted.iter().any(|path| {
            !safe_repo_path(path) || !authority.changed_paths.iter().any(|item| item.0 == *path)
        })
    {
        rows.push(row(
            "authority-deleted-paths",
            "/deleted_paths",
            None,
            None,
            "subset-of",
            changed,
            deleted.clone(),
            vec![],
            vec![],
            duplicate_rows(&deleted),
        ));
    }
}

fn validate_authority_criterion(
    criterion_index: usize,
    criterion: &ValidationAuthorityCriterion,
    source_by_path: &BTreeMap<String, &ValidationSourceRecord>,
    authority: &ValidationEvidenceAuthority,
    all_model: &BTreeSet<Ref>,
    rows: &mut Vec<Value>,
) {
    let path = format!("/criteria/{criterion_index}");
    let paths = criterion
        .covered_paths
        .iter()
        .map(|value| value.0.clone())
        .collect::<Vec<_>>();
    let surfaces = strings(&criterion.semantic_surface_ids);
    let edges = strings(&criterion.forward_edge_ids);
    if criterion.criterion_id.0.trim().is_empty()
        || criterion.unit_id.0.trim().is_empty()
        || criterion.unit_criterion_ordinal == 0
        || criterion.requirement_text.trim().is_empty()
        || paths.is_empty()
        || has_duplicates(&paths)
        || has_duplicates(&surfaces)
        || has_duplicates(&edges)
        || paths.iter().any(|source_path| !safe_repo_path(source_path))
    {
        rows.push(simple_row(
            "authority-criterion-shape",
            &path,
            "complete duplicate-free criterion authority",
            "malformed",
        ));
    }
    let mut exact_allowed = paths
        .iter()
        .filter_map(|source_path| source_by_path.get(source_path))
        .map(|record| record.evidence_ref.clone())
        .collect::<Vec<_>>();
    exact_allowed.push(authority.diff_ref.clone());
    let allowed = sorted_refs(&criterion.allowed_citation_refs);
    if allowed != sorted_refs(&exact_allowed)
        || criterion
            .allowed_citation_refs
            .iter()
            .any(|reference| !all_model.contains(reference))
        || set(&criterion.allowed_citation_refs).len() != criterion.allowed_citation_refs.len()
    {
        rows.push(row(
            "authority-criterion-citations",
            &format!("{path}/allowed_citation_refs"),
            Some(&criterion.criterion_id),
            None,
            "exact",
            strings(&exact_allowed),
            strings(&criterion.allowed_citation_refs),
            vec![],
            vec![],
            duplicate_rows(&strings(&criterion.allowed_citation_refs)),
        ));
    }
    if criterion.command_receipt_refs.is_empty()
        || set(&criterion.command_receipt_refs).len() != criterion.command_receipt_refs.len()
        || criterion.command_receipt_refs.iter().any(|reference| {
            !authority
                .command_receipts
                .iter()
                .any(|record| record.evidence_ref == *reference)
        })
        || set(&criterion.package_check_receipt_refs).len()
            != criterion.package_check_receipt_refs.len()
        || criterion
            .package_check_receipt_refs
            .iter()
            .any(|reference| {
                !authority
                    .package_check_receipts
                    .iter()
                    .any(|record| record.evidence_ref == *reference)
            })
    {
        rows.push(simple_row(
            "authority-criterion-receipts",
            &path,
            "exact typed receipt references",
            "receipt mapping drift",
        ));
    }
}

fn validate_record_bindings(authority: &ValidationEvidenceAuthority, rows: &mut Vec<Value>) {
    for (source_index, source) in authority.source_records.iter().enumerate() {
        let value = serde_json::to_value(source);
        let digest = value
            .as_ref()
            .map_err(|error| error.to_string())
            .and_then(evidence_record_digest);
        let expected_ref = digest
            .ok()
            .map(|digest| format!("validation-source:{digest}"));
        if source.kind != "source-snapshot"
            || source.exact_commit != authority.exact_commit
            || source.exact_tree != authority.exact_tree
            || !matches!(source.mode.as_str(), "100644" | "100755")
            || expected_ref.as_deref() != Some(source.evidence_ref.0.as_str())
        {
            rows.push(simple_row(
                "source-record-binding",
                &format!("/source_records/{source_index}"),
                "canonical exact-tip source record",
                "binding drift",
            ));
        }
    }
    if authority.diff_records.len() == 1 {
        let diff = &authority.diff_records[0];
        let digest = serde_json::to_value(diff)
            .map_err(|error| error.to_string())
            .and_then(|value| evidence_record_digest(&value));
        let expected_ref = digest
            .ok()
            .map(|digest| format!("validation-diff:{digest}"));
        if diff.kind != "candidate-diff"
            || diff.exact_commit != authority.exact_commit
            || diff.exact_tree != authority.exact_tree
            || diff.base_commit != authority.base_commit
            || diff.diff_digest != authority.diff_digest
            || diff.diff_path != authority.diff_path
            || diff.evidence_ref != authority.diff_ref
            || expected_ref.as_deref() != Some(diff.evidence_ref.0.as_str())
        {
            rows.push(simple_row(
                "diff-record-binding",
                "/diff_records/0",
                "canonical exact candidate diff record",
                "binding drift",
            ));
        }
    }
}

fn validate_receipts(
    authority: &ValidationEvidenceAuthority,
    criteria: &BTreeMap<Id, ValidationAuthorityCriterion>,
    command_by_criterion: &BTreeMap<Id, Vec<Ref>>,
    package_by_criterion: &BTreeMap<Id, Vec<Ref>>,
    rows: &mut Vec<Value>,
) {
    let mut execution_ids = BTreeSet::new();
    let mut command_scope_digests = BTreeSet::new();
    for (record_index, record) in authority.command_receipts.iter().enumerate() {
        let parsed: Result<ApprovedCommandReceiptV3, _> =
            serde_json::from_str(&record.receipt_json.0);
        let Ok(receipt) = parsed else {
            rows.push(simple_row(
                "command-receipt-json",
                &format!("/command_receipts/{record_index}/receipt_json"),
                "closed command receipt JSON",
                "malformed",
            ));
            continue;
        };
        let canonical = serde_json::from_str::<Value>(&record.receipt_json.0)
            .ok()
            .and_then(|value| canonical_json_bytes(&value).ok());
        let digest = sha256_hex(record.receipt_json.0.as_bytes());
        let expected_ref = format!("approved-command-receipt:{}:{digest}", record.binding_id.0);
        let criterion_ids = sorted_ids(&record.criterion_ids);
        if canonical.as_deref() != Some(record.receipt_json.0.as_bytes())
            || record.receipt_digest.0 != digest
            || record.evidence_ref.0 != expected_ref
            || record.kind != "delivery-approved-command"
            || record.binding_id != receipt.command_id
            || record.unit_id != receipt.unit_id
            || record.exact_commit.0 != receipt.package_commit
            || record.exact_tree.0 != receipt.package_tree
            || receipt.schema != "autopilot.approved_command_receipt.v1"
            || receipt.criterion_ids != criterion_ids
            || receipt.package_commit != authority.exact_commit.0
            || receipt.package_tree != authority.exact_tree.0
            || !is_sha256_hex(&receipt.producer_assignment_digest)
            || !is_sha256_hex(&receipt.command_digest)
            || !is_sha256_hex(&receipt.result_digest)
            || !is_sha256_hex(&receipt.scope_snapshot_digest)
            || receipt.execution_id.trim().is_empty()
            || !execution_ids.insert(receipt.execution_id)
        {
            rows.push(simple_row(
                "command-receipt-binding",
                &format!("/command_receipts/{record_index}"),
                "canonical globally unique exact command receipt",
                "binding drift",
            ));
        }
        let expected_unit_criteria = criteria
            .values()
            .filter(|criterion| criterion.unit_id == record.unit_id)
            .map(|criterion| criterion.criterion_id.clone())
            .collect::<Vec<_>>();
        if sorted_ids(&record.criterion_ids) != sorted_ids(&expected_unit_criteria) {
            rows.push(simple_row(
                "command-receipt-unit-mapping",
                &format!("/command_receipts/{record_index}/criterion_ids"),
                "all and only criteria owned by the command unit",
                "unit mapping drift",
            ));
        }
        command_scope_digests.insert(receipt.scope_snapshot_digest);
        validate_receipt_inverse_mapping(
            record,
            criteria,
            command_by_criterion,
            &format!("/command_receipts/{record_index}/criterion_ids"),
            "command",
            rows,
        );
    }
    if command_scope_digests.len() != 1 {
        rows.push(simple_row(
            "command-receipt-snapshot",
            "/command_receipts",
            "one exact final source snapshot digest",
            "mixed scope snapshots",
        ));
    }

    for (record_index, record) in authority.package_check_receipts.iter().enumerate() {
        let parsed: Result<PackageCheckReceiptV3, _> = serde_json::from_str(&record.receipt_json.0);
        let Ok(receipt) = parsed else {
            rows.push(simple_row(
                "package-receipt-json",
                &format!("/package_check_receipts/{record_index}/receipt_json"),
                "closed package-check receipt JSON",
                "malformed",
            ));
            continue;
        };
        let canonical = serde_json::from_str::<Value>(&record.receipt_json.0)
            .ok()
            .and_then(|value| canonical_json_bytes(&value).ok());
        let digest = sha256_hex(record.receipt_json.0.as_bytes());
        let expected_ref = format!("package-check-receipt:{}:{digest}", record.binding_id.0);
        let criterion_ids = sorted_ids(&record.criterion_ids);
        let mut ordinals = receipt.criterion_ordinals.clone();
        ordinals.sort_unstable();
        ordinals.dedup();
        if canonical.as_deref() != Some(record.receipt_json.0.as_bytes())
            || record.receipt_digest.0 != digest
            || record.evidence_ref.0 != expected_ref
            || record.kind != "delivery-package-check"
            || record.binding_id != receipt.check_id
            || record.unit_id != receipt.unit_id
            || record.exact_commit.0 != receipt.package_commit
            || record.exact_tree.0 != receipt.package_tree
            || receipt.schema != "autopilot.package_check_receipt.v1"
            || !matches!(receipt.kind, PackageCheckKind::CleanExactPackageTip)
            || receipt.criterion_ids != criterion_ids
            || receipt.assignment_id != authority.assignment_id
            || receipt.base_commit != authority.base_commit.0
            || receipt.package_commit != authority.exact_commit.0
            || receipt.package_tree != authority.exact_tree.0
            || receipt.changed_paths != strings(&authority.changed_paths)
            || receipt.criterion_ordinals.is_empty()
            || ordinals != receipt.criterion_ordinals
        {
            rows.push(simple_row(
                "package-receipt-binding",
                &format!("/package_check_receipts/{record_index}"),
                "canonical exact package-check receipt",
                "binding drift",
            ));
        }
        let expected_mapped_criteria = criteria
            .values()
            .filter(|criterion| {
                criterion.unit_id == record.unit_id
                    && receipt
                        .criterion_ordinals
                        .contains(&criterion.unit_criterion_ordinal)
            })
            .map(|criterion| criterion.criterion_id.clone())
            .collect::<Vec<_>>();
        if sorted_ids(&record.criterion_ids) != sorted_ids(&expected_mapped_criteria) {
            rows.push(simple_row(
                "package-receipt-ordinal-mapping",
                &format!("/package_check_receipts/{record_index}/criterion_ids"),
                "exact unit criterion-ordinal mapping",
                "ordinal mapping drift",
            ));
        }
        validate_receipt_inverse_mapping(
            record,
            criteria,
            package_by_criterion,
            &format!("/package_check_receipts/{record_index}/criterion_ids"),
            "package",
            rows,
        );
    }
}

fn validate_receipt_inverse_mapping(
    record: &ValidationReceiptRecord,
    criteria: &BTreeMap<Id, ValidationAuthorityCriterion>,
    by_criterion: &BTreeMap<Id, Vec<Ref>>,
    field: &str,
    kind: &str,
    rows: &mut Vec<Value>,
) {
    let actual = by_criterion
        .iter()
        .filter(|(_, refs)| refs.contains(&record.evidence_ref))
        .map(|(criterion_id, _)| criterion_id.clone())
        .collect::<Vec<_>>();
    let expected = sorted_ids(&record.criterion_ids);
    if expected.is_empty()
        || expected != sorted_ids(&actual)
        || expected.iter().any(|id| !criteria.contains_key(id))
        || set_ids(&record.criterion_ids).len() != record.criterion_ids.len()
    {
        rows.push(row(
            &format!("{kind}-receipt-criterion-mapping"),
            field,
            None,
            None,
            "exact",
            strings(&expected),
            strings(&actual),
            vec![],
            vec![],
            duplicate_rows(&strings(&record.criterion_ids)),
        ));
    }
}

fn verify_live_artifacts(authority: &ValidationEvidenceAuthority) -> Vec<Value> {
    let mut rows = Vec::new();
    let root = Path::new(&authority.candidate_root.0);
    if reject_link_components_for_path(root).is_err()
        || std::fs::canonicalize(root).ok().as_deref() != Some(root)
        || git_text(root, &["rev-parse", "--show-toplevel"], 4096)
            .ok()
            .and_then(|value| std::fs::canonicalize(value.trim()).ok())
            .as_deref()
            != Some(root)
        || git_text(root, &["rev-parse", "--verify", "HEAD^{commit}"], 128)
            .ok()
            .as_deref()
            .map(str::trim)
            != Some(&authority.exact_commit.0)
        || git_text(root, &["rev-parse", "--verify", "HEAD^{tree}"], 128)
            .ok()
            .as_deref()
            .map(str::trim)
            != Some(&authority.exact_tree.0)
        || !git_success(
            root,
            &[
                "merge-base",
                "--is-ancestor",
                &authority.base_commit.0,
                &authority.exact_commit.0,
            ],
        )
    {
        rows.push(simple_row(
            "candidate-snapshot",
            "/candidate_root",
            "exact canonical candidate root/base/tip/tree",
            "snapshot drift",
        ));
        return rows;
    }
    if !git_oid(&authority.base_commit.0)
        || !git_oid(&authority.exact_commit.0)
        || !git_oid(&authority.exact_tree.0)
    {
        rows.push(simple_row(
            "candidate-git-oids",
            "/exact_commit",
            "lowercase Git object ids",
            "malformed oid",
        ));
    }

    let status = git_bytes_fixed(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        MAX_STATUS_BYTES,
    );
    if status.as_ref().map_or(true, |bytes| {
        bytes
            .split(|byte| *byte == 0)
            .filter(|row| !row.is_empty())
            .any(|row| {
                !(row.starts_with(b"?? .pi/autopilot/") || row.starts_with(b"?? .pi/tasks/"))
            })
    }) {
        rows.push(simple_row(
            "candidate-cleanliness",
            "/candidate_root",
            "strictly clean candidate except package runtime artifacts",
            "dirty or malformed status",
        ));
    }

    let changed = git_bytes_fixed(
        root,
        &[
            "-c",
            "diff.external=",
            "-c",
            "diff.renames=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            &authority.base_commit.0,
            &authority.exact_commit.0,
            "--",
        ],
        MAX_CHANGED_PATH_BYTES,
    )
    .ok()
    .and_then(|bytes| nul_paths(&bytes).ok());
    let expected_changed = strings(&authority.changed_paths);
    if changed.as_ref().map(|paths| sorted_strings(paths.clone()))
        != Some(sorted_strings(expected_changed.clone()))
    {
        let actual_changed = match changed {
            Some(paths) => paths,
            None => vec!["<fixed-argv changed-path capture failed>".to_owned()],
        };
        rows.push(row(
            "candidate-changed-paths",
            "/changed_paths",
            None,
            None,
            "exact",
            expected_changed,
            actual_changed,
            vec![],
            vec![],
            vec![],
        ));
    }

    for (deleted_index, deleted) in authority.deleted_paths.iter().enumerate() {
        let exact = git_bytes_fixed(
            root,
            &["ls-tree", "-z", &authority.exact_commit.0, "--", &deleted.0],
            MAX_LS_TREE_BYTES,
        )
        .and_then(|bytes| parse_ls_tree_optional(&bytes, &deleted.0));
        let base = git_bytes_fixed(
            root,
            &["ls-tree", "-z", &authority.base_commit.0, "--", &deleted.0],
            MAX_LS_TREE_BYTES,
        )
        .and_then(|bytes| parse_ls_tree_exact(&bytes, &deleted.0));
        if !matches!(exact, Ok(None)) {
            rows.push(simple_row(
                "deleted-path-exact-tip",
                &format!("/deleted_paths/{deleted_index}"),
                "path absent at exact candidate tip",
                "present or unreadable",
            ));
        }
        if !matches!(
            base,
            Ok(row) if row.kind == "blob"
                && matches!(row.mode.as_str(), "100644" | "100755")
        ) {
            rows.push(simple_row(
                "deleted-path-base",
                &format!("/deleted_paths/{deleted_index}"),
                "regular tracked source at base commit",
                "absent, unreadable, or unsupported",
            ));
        }
    }

    for (source_index, source) in authority.source_records.iter().enumerate() {
        let tree = git_bytes_fixed(
            root,
            &[
                "ls-tree",
                "-z",
                &authority.exact_commit.0,
                "--",
                &source.source_path.0,
            ],
            MAX_LS_TREE_BYTES,
        )
        .and_then(|bytes| parse_ls_tree_exact(&bytes, &source.source_path.0));
        let git_blob = git_bytes_fixed(
            root,
            &["cat-file", "blob", &source.git_blob_oid.0],
            MAX_SOURCE_BLOB_BYTES,
        );
        let snapshot = read_source_snapshot(root, &source.source_path.0);
        match tree {
            Ok(tree) => {
                for (code, field, expected, actual) in [
                    (
                        "source-mode",
                        "mode",
                        source.mode.as_str(),
                        tree.mode.as_str(),
                    ),
                    ("source-kind", "kind", "blob", tree.kind.as_str()),
                    (
                        "source-oid",
                        "git_blob_oid",
                        source.git_blob_oid.0.as_str(),
                        tree.oid.as_str(),
                    ),
                    (
                        "source-path",
                        "source_path",
                        source.source_path.0.as_str(),
                        tree.path.as_str(),
                    ),
                ] {
                    if actual != expected {
                        rows.push(simple_row(
                            code,
                            &format!("/source_records/{source_index}/{field}"),
                            expected,
                            actual,
                        ));
                    }
                }
            }
            Err(error) => rows.push(simple_row(
                "source-tree-read",
                &format!("/source_records/{source_index}/source_path"),
                "exact bounded ls-tree record",
                &error,
            )),
        }
        if let Err(error) = git_blob {
            rows.push(simple_row(
                "source-blob-read",
                &format!("/source_records/{source_index}/git_blob_oid"),
                "bounded blob bytes",
                &error,
            ));
        }
        match snapshot {
            Ok(bytes) => {
                let actual_digest = sha256_hex(&bytes);
                if actual_digest != source.blob_digest.0 {
                    rows.push(simple_row(
                        "source-snapshot-digest",
                        &format!("/source_records/{source_index}/blob_digest"),
                        &source.blob_digest.0,
                        &actual_digest,
                    ));
                }
                let actual_count = checked_line_count(&bytes);
                if actual_count != Some(source.line_count) {
                    rows.push(simple_row(
                        "source-line-count",
                        &format!("/source_records/{source_index}/line_count"),
                        &source.line_count.to_string(),
                        &actual_count
                            .map_or_else(|| "overflow".to_owned(), |count| count.to_string()),
                    ));
                }
            }
            Err(error) => rows.push(simple_row(
                "source-snapshot-read",
                &format!("/source_records/{source_index}/source_path"),
                "bounded no-follow worktree snapshot bytes",
                &error,
            )),
        }
    }

    for (diff_index, diff) in authority.diff_records.iter().enumerate() {
        let stored = read_bounded_file(Path::new(&diff.diff_path.0), MAX_DIFF_BYTES);
        let produced = git_bytes_fixed(
            root,
            &[
                "-c",
                "diff.external=",
                "-c",
                "diff.renames=false",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--no-color",
                "--full-index",
                "--binary",
                &diff.base_commit.0,
                &diff.exact_commit.0,
                "--",
            ],
            MAX_DIFF_BYTES,
        );
        match &stored {
            Ok(bytes) => {
                let actual_digest = sha256_hex(bytes);
                if actual_digest != diff.diff_digest.0 {
                    rows.push(simple_row(
                        "diff-stored-digest",
                        &format!("/diff_records/{diff_index}/diff_digest"),
                        &diff.diff_digest.0,
                        &actual_digest,
                    ));
                }
                let actual_length = u64::try_from(bytes.len());
                if actual_length.as_ref().ok() != Some(&diff.byte_length) {
                    rows.push(simple_row(
                        "diff-byte-length",
                        &format!("/diff_records/{diff_index}/byte_length"),
                        &diff.byte_length.to_string(),
                        &actual_length
                            .map_or_else(|_| "overflow".to_owned(), |length| length.to_string()),
                    ));
                }
            }
            Err(error) => rows.push(simple_row(
                "diff-stored-read",
                &format!("/diff_records/{diff_index}/diff_path"),
                &diff.diff_path.0,
                &error.to_string(),
            )),
        }
        match produced {
            Ok(bytes) => {
                let actual_digest = sha256_hex(&bytes);
                if actual_digest != diff.diff_digest.0 {
                    rows.push(simple_row(
                        "diff-produced-digest",
                        &format!("/diff_records/{diff_index}/diff_digest"),
                        &diff.diff_digest.0,
                        &actual_digest,
                    ));
                }
                if stored
                    .as_ref()
                    .is_ok_and(|stored| stored.as_slice() != bytes.as_slice())
                {
                    rows.push(simple_row(
                        "diff-byte-parity",
                        &format!("/diff_records/{diff_index}/diff_path"),
                        "stored bytes equal fixed-argv Git diff bytes",
                        "byte mismatch",
                    ));
                }
            }
            Err(error) => rows.push(simple_row(
                "diff-produced-read",
                &format!("/diff_records/{diff_index}"),
                "bounded fixed-argv Git diff bytes",
                &error,
            )),
        }
    }
    rows
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovedCommandReceiptV3 {
    schema: String,
    producer_assignment_digest: String,
    execution_id: String,
    command_id: Id,
    command_digest: String,
    result_digest: String,
    scope_snapshot_digest: String,
    package_commit: String,
    package_tree: String,
    unit_id: Id,
    criterion_ids: Vec<Id>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageCheckReceiptV3 {
    schema: String,
    check_id: Id,
    kind: PackageCheckKind,
    criterion_ordinals: Vec<u32>,
    criterion_ids: Vec<Id>,
    unit_id: Id,
    assignment_id: Id,
    base_commit: String,
    package_commit: String,
    package_tree: String,
    changed_paths: Vec<String>,
}

fn validate_submission_shape(payload: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    let Some(root) = shape_object(payload, "", "submission", &mut rows) else {
        return rows;
    };
    shape_keys(
        root,
        "",
        &["schema", "criterion_results", "findings"],
        &mut rows,
    );
    shape_string(
        root.get("schema"),
        "/schema",
        64,
        Some(&["autopilot.validation_submission.v3"]),
        &mut rows,
    );
    if let Some(results) = shape_array(
        root.get("criterion_results"),
        "/criterion_results",
        1,
        MAX_CRITERIA,
        &mut rows,
    ) {
        for (index, value) in results.iter().take(MAX_CRITERIA).enumerate() {
            let pointer = format!("/criterion_results/{index}");
            let Some(result) = shape_object(value, &pointer, "criterion result", &mut rows) else {
                continue;
            };
            shape_keys(
                result,
                &pointer,
                &["criterion_id", "verdict", "citation_refs", "finding_ids"],
                &mut rows,
            );
            shape_string(
                result.get("criterion_id"),
                &format!("{pointer}/criterion_id"),
                256,
                None,
                &mut rows,
            );
            shape_generated_enum::<CriterionVerdict>(
                result.get("verdict"),
                &format!("{pointer}/verdict"),
                16,
                "generated criterion_verdict enum",
                &mut rows,
            );
            shape_string_array(
                result.get("citation_refs"),
                &format!("{pointer}/citation_refs"),
                1,
                MAX_CITATIONS,
                512,
                &mut rows,
            );
            shape_string_array(
                result.get("finding_ids"),
                &format!("{pointer}/finding_ids"),
                0,
                MAX_FINDINGS,
                256,
                &mut rows,
            );
        }
    }
    if let Some(findings) = shape_array(
        root.get("findings"),
        "/findings",
        0,
        MAX_FINDINGS,
        &mut rows,
    ) {
        for (index, value) in findings.iter().take(MAX_FINDINGS).enumerate() {
            let pointer = format!("/findings/{index}");
            let Some(finding) = shape_object(value, &pointer, "finding", &mut rows) else {
                continue;
            };
            shape_keys(
                finding,
                &pointer,
                &[
                    "finding_id",
                    "kind",
                    "effect",
                    "summary",
                    "detail",
                    "criterion_ids",
                    "citation_refs",
                    "source_locations",
                ],
                &mut rows,
            );
            shape_string(
                finding.get("finding_id"),
                &format!("{pointer}/finding_id"),
                256,
                None,
                &mut rows,
            );
            shape_generated_enum::<FindingKindV2>(
                finding.get("kind"),
                &format!("{pointer}/kind"),
                32,
                "generated finding_kind_v2 enum",
                &mut rows,
            );
            shape_generated_enum::<FindingEffect>(
                finding.get("effect"),
                &format!("{pointer}/effect"),
                32,
                "generated finding_effect enum",
                &mut rows,
            );
            shape_string(
                finding.get("summary"),
                &format!("{pointer}/summary"),
                512,
                None,
                &mut rows,
            );
            shape_string(
                finding.get("detail"),
                &format!("{pointer}/detail"),
                4096,
                None,
                &mut rows,
            );
            shape_string_array(
                finding.get("criterion_ids"),
                &format!("{pointer}/criterion_ids"),
                1,
                MAX_CRITERIA,
                256,
                &mut rows,
            );
            shape_string_array(
                finding.get("citation_refs"),
                &format!("{pointer}/citation_refs"),
                1,
                MAX_CITATIONS,
                512,
                &mut rows,
            );
            if let Some(locations) = shape_array(
                finding.get("source_locations"),
                &format!("{pointer}/source_locations"),
                0,
                MAX_SOURCE_LOCATIONS,
                &mut rows,
            ) {
                for (location_index, value) in
                    locations.iter().take(MAX_SOURCE_LOCATIONS).enumerate()
                {
                    let location_pointer = format!("{pointer}/source_locations/{location_index}");
                    let Some(location) =
                        shape_object(value, &location_pointer, "source location", &mut rows)
                    else {
                        continue;
                    };
                    shape_keys(
                        location,
                        &location_pointer,
                        &["citation_ref", "start_line", "end_line"],
                        &mut rows,
                    );
                    shape_string(
                        location.get("citation_ref"),
                        &format!("{location_pointer}/citation_ref"),
                        512,
                        None,
                        &mut rows,
                    );
                    shape_u32(
                        location.get("start_line"),
                        &format!("{location_pointer}/start_line"),
                        &mut rows,
                    );
                    shape_u32(
                        location.get("end_line"),
                        &format!("{location_pointer}/end_line"),
                        &mut rows,
                    );
                }
            }
        }
    }
    rows
}

fn shape_object<'a>(
    value: &'a Value,
    pointer: &str,
    label: &str,
    rows: &mut Vec<Value>,
) -> Option<&'a serde_json::Map<String, Value>> {
    value.as_object().or_else(|| {
        rows.push(simple_row(
            "shape-object",
            pointer,
            &format!("{label} object"),
            &shape_actual(value),
        ));
        None
    })
}

fn shape_keys(
    object: &serde_json::Map<String, Value>,
    pointer: &str,
    expected: &[&str],
    rows: &mut Vec<Value>,
) {
    let expected = expected
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let actual = object.keys().cloned().collect::<Vec<_>>();
    let mismatch = multiset_mismatch(&expected, &actual);
    if mismatch.changed_exact() {
        rows.push(row(
            "shape-object-fields",
            pointer,
            None,
            None,
            "exact",
            mismatch.expected,
            mismatch.actual,
            mismatch.missing,
            mismatch.extra,
            mismatch.duplicates,
        ));
    }
}

fn shape_array<'a>(
    value: Option<&'a Value>,
    pointer: &str,
    minimum: usize,
    maximum: usize,
    rows: &mut Vec<Value>,
) -> Option<&'a Vec<Value>> {
    let value = value?;
    let Some(array) = value.as_array() else {
        rows.push(simple_row(
            "shape-array",
            pointer,
            "array",
            &shape_actual(value),
        ));
        return None;
    };
    if array.len() < minimum || array.len() > maximum {
        rows.push(row(
            "shape-array-cardinality",
            pointer,
            None,
            None,
            "exact",
            vec![format!("{minimum}..={maximum}")],
            vec![array.len().to_string()],
            vec![],
            vec![],
            vec![],
        ));
    }
    Some(array)
}

fn shape_string(
    value: Option<&Value>,
    pointer: &str,
    maximum_bytes: usize,
    allowed: Option<&[&str]>,
    rows: &mut Vec<Value>,
) {
    let Some(value) = value else { return };
    let valid = value.as_str().is_some_and(|text| {
        text.len() <= maximum_bytes && allowed.is_none_or(|values| values.contains(&text))
    });
    if !valid {
        rows.push(row(
            "shape-string",
            pointer,
            None,
            None,
            "exact",
            allowed.map_or_else(
                || vec![format!("string <= {maximum_bytes} bytes")],
                |values| values.iter().map(|value| (*value).to_owned()).collect(),
            ),
            vec![shape_actual(value)],
            vec![],
            vec![],
            vec![],
        ));
    }
}

fn shape_generated_enum<T: DeserializeOwned>(
    value: Option<&Value>,
    pointer: &str,
    maximum_bytes: usize,
    label: &str,
    rows: &mut Vec<Value>,
) {
    let Some(value) = value else { return };
    let valid = value
        .as_str()
        .is_some_and(|text| text.len() <= maximum_bytes)
        && serde_json::from_value::<T>(value.clone()).is_ok();
    if !valid {
        rows.push(row(
            "shape-enum",
            pointer,
            None,
            None,
            "exact",
            vec![label.to_owned()],
            vec![shape_actual(value)],
            vec![],
            vec![],
            vec![],
        ));
    }
}

fn shape_string_array(
    value: Option<&Value>,
    pointer: &str,
    minimum: usize,
    maximum: usize,
    maximum_item_bytes: usize,
    rows: &mut Vec<Value>,
) {
    let Some(array) = shape_array(value, pointer, minimum, maximum, rows) else {
        return;
    };
    for (index, item) in array.iter().take(maximum).enumerate() {
        if item
            .as_str()
            .is_none_or(|text| text.len() > maximum_item_bytes)
        {
            rows.push(simple_row(
                "shape-array-item",
                &format!("{pointer}/{index}"),
                &format!("string <= {maximum_item_bytes} bytes"),
                &shape_actual(item),
            ));
        }
    }
}

fn shape_u32(value: Option<&Value>, pointer: &str, rows: &mut Vec<Value>) {
    let Some(value) = value else { return };
    if value
        .as_u64()
        .is_none_or(|number| number > u64::from(u32::MAX))
    {
        rows.push(simple_row(
            "shape-u32",
            pointer,
            "unsigned 32-bit integer",
            &shape_actual(value),
        ));
    }
}

fn shape_actual(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => bounded_diagnostic_string(value),
        Value::Array(value) => format!("array(len={})", value.len()),
        Value::Object(value) => format!("object(keys={})", value.len()),
    }
}

fn validate_diagnostic_contract(value: &ValidationAdmissionDiagnostic) -> Result<(), String> {
    let mismatch_count = usize::try_from(value.mismatch_count).ok();
    let summary_count = value
        .mismatches
        .iter()
        .filter(|row| row.code == "diagnostic-row-summary")
        .count();
    if value.schema.0 != "autopilot.validation_admission_diagnostic.v1"
        || value.boundary_id.0 != "autopilot.validation_submission.v3"
        || !value.complete
        || mismatch_count.is_none_or(|count| count < value.mismatches.len())
        || mismatch_count.is_some_and(|count| {
            (count == value.mismatches.len() && summary_count != 0)
                || (count > value.mismatches.len() && summary_count != 1)
        })
        || value.mismatches.is_empty()
        || value.mismatches.len() > MAX_DIAGNOSTIC_ROWS
    {
        return Err("generated diagnostic identity/count invariant failed".to_owned());
    }
    let mut keys = Vec::new();
    for mismatch in &value.mismatches {
        if mismatch.code == "diagnostic-row-summary"
            && (!mismatch.field.is_empty()
                || mismatch.actual.len() != 1
                || mismatch.actual[0].strip_prefix("@summary count=").is_none())
        {
            return Err("generated diagnostic row summary invariant failed".to_owned());
        }
        if mismatch.code.is_empty()
            || mismatch.code.len() > 128
            || mismatch.field.len() > 1024
            || mismatch.expected.len() > 256
            || mismatch.actual.len() > 256
            || mismatch.missing.len() > 256
            || mismatch.extra.len() > 256
            || mismatch.duplicates.len() > 256
            || mismatch
                .expected
                .iter()
                .chain(&mismatch.actual)
                .chain(&mismatch.missing)
                .chain(&mismatch.extra)
                .any(|item| item.len() > 4096)
            || mismatch
                .duplicates
                .iter()
                .any(|item| item.count < 2 || item.value.len() > 4096)
        {
            return Err("generated diagnostic row bound/invariant failed".to_owned());
        }
        for values in [
            &mismatch.expected,
            &mismatch.actual,
            &mismatch.missing,
            &mismatch.extra,
        ] {
            if !is_sorted(values) {
                return Err("generated diagnostic values are not canonical".to_owned());
            }
        }
        keys.push((
            mismatch.field.clone(),
            mismatch
                .criterion_id
                .as_ref()
                .map_or_else(String::new, |id| id.0.clone()),
            mismatch
                .finding_id
                .as_ref()
                .map_or_else(String::new, |id| id.0.clone()),
            mismatch.code.clone(),
        ));
    }
    if !keys.windows(2).all(|pair| pair[0] <= pair[1]) {
        return Err("generated diagnostic rows are not canonical".to_owned());
    }
    Ok(())
}

struct LsTreeRow {
    mode: String,
    kind: String,
    oid: String,
    path: String,
}

fn parse_ls_tree_optional(bytes: &[u8], expected_path: &str) -> Result<Option<LsTreeRow>, String> {
    let rows = bytes
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() != 1 {
        return Err(format!(
            "git ls-tree expected at most one row, got {}",
            rows.len()
        ));
    }
    let row = std::str::from_utf8(rows[0]).map_err(|error| error.to_string())?;
    let (header, path) = row
        .split_once('\t')
        .ok_or_else(|| "git ls-tree row lacks tab separator".to_owned())?;
    let parts = header.split(' ').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| part.is_empty())
        || path != expected_path
        || path.is_empty()
    {
        return Err("git ls-tree row is malformed or path-mismatched".to_owned());
    }
    Ok(Some(LsTreeRow {
        mode: parts[0].to_owned(),
        kind: parts[1].to_owned(),
        oid: parts[2].to_owned(),
        path: path.to_owned(),
    }))
}

fn parse_ls_tree_exact(bytes: &[u8], expected_path: &str) -> Result<LsTreeRow, String> {
    parse_ls_tree_optional(bytes, expected_path)?
        .ok_or_else(|| "git ls-tree expected one row, got 0".to_owned())
}

fn git_bytes_fixed(root: &Path, args: &[&str], max_stdout: usize) -> Result<Vec<u8>, String> {
    let output =
        super::git_output_bounded_with_limits(root, args, &[], max_stdout, MAX_GIT_STDERR_BYTES)?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output.stdout)
}

fn git_text(root: &Path, args: &[&str], max_stdout: usize) -> Result<String, String> {
    String::from_utf8(git_bytes_fixed(root, args, max_stdout)?).map_err(|error| error.to_string())
}

fn git_success(root: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            std::str::from_utf8(path)
                .map(str::to_owned)
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn checked_line_count(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() {
        return Some(0);
    }
    let lines = bytes
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        .checked_add(usize::from(bytes.last() != Some(&b'\n')))?;
    u32::try_from(lines).ok()
}

fn allowed_finding_citations(
    criteria: &BTreeMap<Id, ValidationAuthorityCriterion>,
    criterion_ids: &[Id],
) -> Vec<String> {
    let mut iterator = criterion_ids.iter().filter_map(|id| criteria.get(id));
    let Some(first) = iterator.next() else {
        return Vec::new();
    };
    let mut allowed = first
        .allowed_citation_refs
        .iter()
        .map(|reference| reference.0.clone())
        .collect::<BTreeSet<_>>();
    for criterion in iterator {
        let next = criterion
            .allowed_citation_refs
            .iter()
            .map(|reference| reference.0.clone())
            .collect::<BTreeSet<_>>();
        allowed = allowed.intersection(&next).cloned().collect();
    }
    allowed.into_iter().collect()
}

fn safe_repo_path(value: &str) -> bool {
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || Path::new(value).is_absolute()
    {
        return false;
    }
    let mut saw = false;
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) if part != ".git" && part != ".pi" => saw = true,
            _ => return false,
        }
    }
    saw
}

fn git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sorted_refs(values: &[Ref]) -> Vec<Ref> {
    let mut out = values.to_vec();
    out.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    out
}

fn sorted_ids(values: &[Id]) -> Vec<Id> {
    let mut out = values.to_vec();
    out.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    out
}

fn sorted_paths(values: &[kernel::generated::Path]) -> Vec<kernel::generated::Path> {
    let mut out = values.to_vec();
    out.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    out
}

fn strings<T: AsRefString>(values: &[T]) -> Vec<String> {
    values.iter().map(AsRefString::as_ref_string).collect()
}

trait AsRefString {
    fn as_ref_string(&self) -> String;
}
impl AsRefString for Id {
    fn as_ref_string(&self) -> String {
        self.0.clone()
    }
}
impl AsRefString for Ref {
    fn as_ref_string(&self) -> String {
        self.0.clone()
    }
}
impl AsRefString for kernel::generated::Path {
    fn as_ref_string(&self) -> String {
        self.0.clone()
    }
}

fn set(values: &[Ref]) -> BTreeSet<Ref> {
    values.iter().cloned().collect()
}
fn set_ids(values: &[Id]) -> BTreeSet<Id> {
    values.iter().cloned().collect()
}
fn sorted_strings(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    values
}
fn is_sorted(values: &[String]) -> bool {
    values
        .windows(2)
        .all(|pair| pair[0].as_bytes() <= pair[1].as_bytes())
}
pub(crate) fn is_receipt_ref(value: &str) -> bool {
    RECEIPT_PREFIXES
        .iter()
        .any(|prefix| value.starts_with(prefix))
}
fn has_duplicates(values: &[String]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() != values.len()
}

struct Mismatch {
    expected: Vec<String>,
    actual: Vec<String>,
    missing: Vec<String>,
    extra: Vec<String>,
    duplicates: Vec<Value>,
}
impl Mismatch {
    fn changed_exact(&self) -> bool {
        !self.missing.is_empty() || !self.extra.is_empty() || !self.duplicates.is_empty()
    }
    fn changed_subset(&self) -> bool {
        !self.extra.is_empty() || !self.duplicates.is_empty()
    }
}
fn multiset_mismatch(expected: &[String], actual: &[String]) -> Mismatch {
    let expected = sorted_strings(expected.to_vec());
    let actual = sorted_strings(actual.to_vec());
    let (missing, extra) = difference(&expected, &actual);
    Mismatch {
        duplicates: duplicate_rows(&actual),
        expected,
        actual,
        missing,
        extra,
    }
}
fn multiset_subset(expected: &[String], actual: &[String]) -> Mismatch {
    let expected = sorted_strings(expected.to_vec());
    let actual = sorted_strings(actual.to_vec());
    let (_, extra) = difference(&expected, &actual);
    Mismatch {
        duplicates: duplicate_rows(&actual),
        expected,
        actual,
        missing: Vec::new(),
        extra,
    }
}
fn difference(expected: &[String], actual: &[String]) -> (Vec<String>, Vec<String>) {
    let e = counts(expected);
    let a = counts(actual);
    let mut missing = Vec::new();
    let mut extra = Vec::new();
    for (value, count) in &e {
        for _ in 0..count.saturating_sub(*a.get(value).unwrap_or(&0)) {
            missing.push(value.clone());
        }
    }
    for (value, count) in &a {
        for _ in 0..count.saturating_sub(*e.get(value).unwrap_or(&0)) {
            extra.push(value.clone());
        }
    }
    (missing, extra)
}
fn counts(values: &[String]) -> BTreeMap<String, u32> {
    let mut out = BTreeMap::new();
    for value in values {
        *out.entry(value.clone()).or_default() += 1;
    }
    out
}
fn duplicate_rows(values: &[String]) -> Vec<Value> {
    let raw = counts(values)
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(value, count)| json!({"value": value, "count": count}))
        .collect::<Vec<_>>();
    let mut rows = raw
        .iter()
        .map(|row| {
            json!({
                "value": bounded_diagnostic_string(row["value"].as_str().unwrap_or("")),
                "count": row["count"],
            })
        })
        .collect::<Vec<_>>();
    if rows.len() > MAX_DIAGNOSTIC_LIST_ITEMS {
        let count = raw
            .iter()
            .filter_map(|row| row["count"].as_u64())
            .sum::<u64>()
            .max(2);
        rows = vec![json!({
            "value": diagnostic_value_summary(&Value::Array(raw)),
            "count": u32::try_from(count).unwrap_or(u32::MAX),
        })];
    }
    rows
}

fn bounded_diagnostic_string(value: &str) -> String {
    if is_receipt_ref(value) {
        return format!(
            "@rejected-receipt-reference bytes={} sha256={}",
            value.len(),
            sha256_hex(value.as_bytes())
        );
    }
    if value.len() <= MAX_DIAGNOSTIC_STRING_BYTES {
        return value.to_owned();
    }
    let suffix = format!(
        "… bytes={} sha256={}",
        value.len(),
        sha256_hex(value.as_bytes())
    );
    let mut end = MAX_DIAGNOSTIC_STRING_BYTES.saturating_sub(suffix.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], suffix)
}

fn diagnostic_value_summary(value: &Value) -> String {
    let count = value.as_array().map_or(1, Vec::len);
    match canonical_json_bytes(value) {
        Ok(bytes) => format!("@summary count={count} sha256={}", sha256_hex(&bytes)),
        Err(error) => format!(
            "@summary count={count} canonicalization-error-sha256={}",
            sha256_hex(error.as_bytes())
        ),
    }
}

fn diagnostic_string_list_summary(values: &[String]) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let originals = sorted_strings(values.to_vec());
    Some(diagnostic_value_summary(&Value::Array(
        originals.into_iter().map(Value::String).collect(),
    )))
}

fn bounded_diagnostic_values(values: Vec<String>) -> Vec<String> {
    let originals = sorted_strings(values);
    let full = Value::Array(originals.iter().cloned().map(Value::String).collect());
    let mut bounded = originals
        .iter()
        .map(|value| bounded_diagnostic_string(value))
        .collect::<Vec<_>>();
    if bounded.len() > MAX_DIAGNOSTIC_LIST_ITEMS {
        bounded.truncate(MAX_DIAGNOSTIC_LIST_ITEMS - 1);
        bounded.push(diagnostic_value_summary(&full));
    }
    bounded.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    bounded
}

#[expect(
    clippy::too_many_arguments,
    reason = "the canonical diagnostic row fields remain explicit at every call site"
)]
fn row(
    code: &str,
    field: &str,
    criterion_id: Option<&Id>,
    finding_id: Option<&Id>,
    comparison: &str,
    expected: Vec<String>,
    actual: Vec<String>,
    missing: Vec<String>,
    extra: Vec<String>,
    mut duplicates: Vec<Value>,
) -> Value {
    duplicates.sort_by(|left, right| {
        left["value"]
            .as_str()
            .unwrap_or("")
            .as_bytes()
            .cmp(right["value"].as_str().unwrap_or("").as_bytes())
    });
    let summaries = json!({
        "expected": diagnostic_string_list_summary(&expected),
        "actual": diagnostic_string_list_summary(&actual),
        "missing": diagnostic_string_list_summary(&missing),
        "extra": diagnostic_string_list_summary(&extra),
        "duplicates": if duplicates.is_empty() {
            None
        } else {
            Some(diagnostic_value_summary(&Value::Array(duplicates.clone())))
        },
    });
    json!({
        "code": code,
        "field": field,
        "criterion_id": criterion_id.map(|id| bounded_diagnostic_string(&id.0)),
        "finding_id": finding_id.map(|id| bounded_diagnostic_string(&id.0)),
        "comparison": comparison,
        "expected": bounded_diagnostic_values(expected),
        "actual": bounded_diagnostic_values(actual),
        "missing": bounded_diagnostic_values(missing),
        "extra": bounded_diagnostic_values(extra),
        "duplicates": duplicates,
        DIAGNOSTIC_ORIGINAL_SUMMARIES_KEY: summaries,
    })
}

fn simple_row(code: &str, field: &str, expected: &str, actual: &str) -> Value {
    row(
        code,
        field,
        None,
        None,
        "exact",
        vec![expected.to_owned()],
        vec![actual.to_owned()],
        vec![],
        vec![],
        vec![],
    )
}

fn simple_finding_row(
    code: &str,
    field: &str,
    finding_id: &Id,
    expected: &str,
    actual: &str,
) -> Value {
    row(
        code,
        field,
        None,
        Some(finding_id),
        "exact",
        vec![expected.to_owned()],
        vec![actual.to_owned()],
        vec![],
        vec![],
        vec![],
    )
}

fn fatal_expected(
    identity: &ValidationAuthorityExpectation<'_>,
    authority_digest: &str,
    code: &str,
    field: &str,
    expected: &str,
    actual: &str,
) -> AdmissionFailure {
    diagnostic_raw(
        &identity.validation_id.0,
        &identity.assignment_id.0,
        authority_digest,
        0,
        "authority",
        "fatal-authority",
        vec![simple_row(code, field, expected, actual)],
        true,
    )
}

fn fatal_authority(
    authority: &ValidationEvidenceAuthority,
    attempt: u32,
    code: &str,
    field: &str,
    expected: &str,
    actual: &str,
) -> AdmissionFailure {
    diagnostic(
        authority,
        attempt,
        "authority",
        "fatal-authority",
        vec![simple_row(code, field, expected, actual)],
        true,
    )
}

fn shape_failure(
    authority: &ValidationEvidenceAuthority,
    attempt: u32,
    code: &str,
    actual: &str,
) -> AdmissionFailure {
    diagnostic(
        authority,
        attempt,
        "shape",
        "repairable-model-value",
        vec![simple_row(
            code,
            "",
            "closed bounded autopilot.validation_submission.v3",
            actual,
        )],
        false,
    )
}

fn diagnostic(
    authority: &ValidationEvidenceAuthority,
    attempt: u32,
    phase: &str,
    disposition: &str,
    mut rows: Vec<Value>,
    fatal_authority: bool,
) -> AdmissionFailure {
    rows.sort_by_key(diagnostic_row_key);
    diagnostic_raw(
        &authority.validation_id.0,
        &authority.assignment_id.0,
        &authority.authority_digest.0,
        attempt,
        phase,
        disposition,
        rows,
        fatal_authority,
    )
}

fn diagnostic_row_key(value: &Value) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let bytes = |key: &str| value[key].as_str().unwrap_or("").as_bytes().to_vec();
    (
        bytes("field"),
        bytes("criterion_id"),
        bytes("finding_id"),
        bytes("code"),
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "raw parse failures bind every diagnostic identity field explicitly"
)]
fn diagnostic_raw(
    validation_id: &str,
    assignment_id: &str,
    authority_digest: &str,
    attempt: u32,
    phase: &str,
    disposition: &str,
    mut rows: Vec<Value>,
    fatal_authority: bool,
) -> AdmissionFailure {
    rows.sort_by_key(diagnostic_row_key);
    let mismatch_count = u32::try_from(rows.len()).unwrap_or(u32::MAX);
    if rows.len() > MAX_DIAGNOSTIC_ROWS {
        let omitted = rows.split_off(MAX_DIAGNOSTIC_ROWS - 1);
        let public_omitted = public_diagnostic_rows(&omitted);
        rows.push(row(
            "diagnostic-row-summary",
            "",
            None,
            None,
            "exact",
            vec!["digest-bound omitted mismatch rows".to_owned()],
            vec![diagnostic_value_summary(&Value::Array(public_omitted))],
            vec![],
            vec![],
            vec![],
        ));
        rows.sort_by_key(diagnostic_row_key);
    }
    let build = |rows: &[Value]| {
        json!({
            "schema": "autopilot.validation_admission_diagnostic.v1",
            "boundary_id": "autopilot.validation_submission.v3",
            "validation_id": validation_id,
            "assignment_id": assignment_id,
            "authority_digest": authority_digest,
            "value_attempt": attempt,
            "phase": phase,
            "disposition": disposition,
            "complete": true,
            "mismatch_count": mismatch_count,
            "mismatches": public_diagnostic_rows(rows),
        })
    };
    let mut value = build(&rows);
    if canonical_json_bytes(&value).map_or(true, |bytes| {
        bytes.len() > kernel::generated::VALIDATION_ADMISSION_DIAGNOSTIC_MAX_BYTES
    }) {
        compact_diagnostic_rows(&mut rows);
        value = build(&rows);
    }
    AdmissionFailure {
        diagnostic: value,
        fatal_authority,
    }
}

fn public_diagnostic_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .cloned()
        .map(|mut row| {
            if let Some(object) = row.as_object_mut() {
                object.remove(DIAGNOSTIC_ORIGINAL_SUMMARIES_KEY);
            }
            row
        })
        .collect()
}

fn compact_diagnostic_rows(rows: &mut [Value]) {
    for row in rows {
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        if object.get("code").and_then(Value::as_str) == Some("diagnostic-row-summary") {
            continue;
        }
        let summaries = object
            .get(DIAGNOSTIC_ORIGINAL_SUMMARIES_KEY)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in ["expected", "actual", "missing", "extra"] {
            let Some(values) = object.get_mut(key).and_then(Value::as_array_mut) else {
                continue;
            };
            if !values.is_empty() {
                let summary = summaries
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| diagnostic_value_summary(&Value::Array(values.clone())));
                *values = vec![Value::String(summary)];
            }
        }
        let Some(duplicates) = object.get_mut("duplicates").and_then(Value::as_array_mut) else {
            continue;
        };
        if !duplicates.is_empty() {
            let count = duplicates
                .iter()
                .filter_map(|value| value["count"].as_u64())
                .sum::<u64>()
                .max(2);
            let summary = summaries
                .get("duplicates")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| diagnostic_value_summary(&Value::Array(duplicates.clone())));
            *duplicates = vec![json!({
                "value": summary,
                "count": u32::try_from(count).unwrap_or(u32::MAX),
            })];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic_authority() -> ValidationEvidenceAuthority {
        serde_json::from_value(json!({
            "schema": "autopilot.validation_evidence_authority.v1",
            "validation_id": "validation-test",
            "assignment_id": "validator-assignment-test",
            "exact_commit": "0000000000000000000000000000000000000000",
            "exact_tree": "0000000000000000000000000000000000000000",
            "base_commit": "0000000000000000000000000000000000000000",
            "candidate_root": "/tmp/validation-test",
            "unchanged_recovery": false,
            "changed_paths": ["src/main.rs"],
            "deleted_paths": [],
            "diff_ref": "validation-diff:test",
            "diff_digest": "0000000000000000000000000000000000000000000000000000000000000000",
            "diff_path": "/tmp/validation-test/candidate.v3.diff",
            "source_records": [],
            "diff_records": [],
            "command_receipts": [],
            "package_check_receipts": [],
            "criteria": [],
            "authority_digest": "0000000000000000000000000000000000000000000000000000000000000000"
        }))
        .expect("diagnostic authority shape")
    }

    #[test]
    fn model_shape_failure_is_repairable_and_root_pointer_is_exact() {
        let failure = shape_failure(
            &diagnostic_authority(),
            2,
            "payload-shape",
            "unknown field receipt_refs",
        );
        assert!(!failure.fatal_authority);
        let diagnostic: ValidationAdmissionDiagnostic =
            serde_json::from_slice(&failure.canonical_bytes().expect("canonical diagnostic"))
                .expect("typed diagnostic");
        assert_eq!(
            diagnostic.phase,
            kernel::generated::ValidationAdmissionPhase::Shape
        );
        assert_eq!(
            diagnostic.disposition,
            kernel::generated::ValidationAdmissionDisposition::RepairableModelValue
        );
        assert_eq!(diagnostic.value_attempt, 2);
        assert_eq!(diagnostic.mismatch_count, 1);
        assert_eq!(diagnostic.mismatches[0].field, "");
        assert_eq!(
            diagnostic.mismatches[0].actual,
            ["unknown field receipt_refs"]
        );
    }

    #[test]
    fn shape_validator_aggregates_real_indexed_pointers() {
        let payload = json!({
            "schema": 7,
            "receipt_refs": ["package-check-receipt:forbidden"],
            "criterion_results": [{
                "criterion_id": 9,
                "verdict": "MAYBE",
                "citation_refs": [],
                "finding_ids": [false],
                "extra": true
            }],
            "findings": [{
                "finding_id": "finding-1",
                "kind": "unknown-kind",
                "effect": "unknown-effect",
                "summary": 1,
                "detail": 2,
                "criterion_ids": [],
                "citation_refs": [3],
                "source_locations": [{"citation_ref": 4, "start_line": -1}]
            }]
        });
        let rows = validate_submission_shape(&payload);
        let pointers = rows
            .iter()
            .map(|row| row["field"].as_str().unwrap_or(""))
            .collect::<BTreeSet<_>>();
        for pointer in [
            "",
            "/schema",
            "/criterion_results/0",
            "/criterion_results/0/criterion_id",
            "/criterion_results/0/verdict",
            "/criterion_results/0/citation_refs",
            "/criterion_results/0/finding_ids/0",
            "/findings/0/kind",
            "/findings/0/effect",
            "/findings/0/summary",
            "/findings/0/detail",
            "/findings/0/criterion_ids",
            "/findings/0/citation_refs/0",
            "/findings/0/source_locations/0",
            "/findings/0/source_locations/0/citation_ref",
            "/findings/0/source_locations/0/start_line",
        ] {
            assert!(pointers.contains(pointer), "missing {pointer}: {rows:?}");
        }
    }

    #[test]
    fn generated_finding_enums_are_the_manual_shape_authority() {
        let payload = json!({
            "schema": "autopilot.validation_submission.v3",
            "criterion_results": [{
                "criterion_id": "criterion-1",
                "verdict": "FAIL",
                "citation_refs": ["validation-diff:1"],
                "finding_ids": ["finding-1"]
            }],
            "findings": [{
                "finding_id": "finding-1",
                "kind": "advisory",
                "effect": "closure-blocking-forward-safe",
                "summary": "generated enum coverage",
                "detail": "manual shape admission delegates enum membership to generated types",
                "criterion_ids": ["criterion-1"],
                "citation_refs": ["validation-diff:1"],
                "source_locations": []
            }]
        });
        assert!(validate_submission_shape(&payload).is_empty());
    }

    #[test]
    fn bounded_diagnostic_values_resort_after_digest_truncation() {
        let prefix = "x".repeat(430);
        let values = vec![
            format!("{prefix}0000{}", "a".repeat(100)),
            format!("{prefix}0003{}", "a".repeat(100)),
        ];
        let bounded = bounded_diagnostic_values(values);
        assert!(is_sorted(&bounded), "bounded values must remain canonical");
    }

    #[test]
    fn excessive_shape_rows_are_digest_summarized_without_becoming_fatal() {
        let rows = (0..2112)
            .map(|index| {
                simple_row(
                    "shape-array-item",
                    &format!("/findings/{index}/criterion_ids/0"),
                    "string",
                    "false",
                )
            })
            .collect();
        let failure = diagnostic(
            &diagnostic_authority(),
            1,
            "shape",
            "repairable-model-value",
            rows,
            false,
        );
        assert!(!failure.fatal_authority);
        let bytes = failure
            .canonical_bytes()
            .expect("summarized shape diagnostic remains canonical");
        let value: ValidationAdmissionDiagnostic =
            serde_json::from_slice(&bytes).expect("typed summarized diagnostic");
        assert_eq!(value.mismatch_count, 2112);
        assert_eq!(value.mismatches.len(), MAX_DIAGNOSTIC_ROWS);
        assert_eq!(
            value
                .mismatches
                .iter()
                .filter(|row| row.code == "diagnostic-row-summary")
                .count(),
            1
        );
    }

    #[test]
    fn bounded_model_diagnostics_compact_without_becoming_fatal() {
        let large = "x".repeat(512);
        let rows = (0..1900)
            .map(|index| {
                row(
                    "bounded-stress",
                    &format!("/findings/{index}/citation_refs"),
                    None,
                    Some(&Id(format!("finding-{index}-{}", "y".repeat(220)))),
                    "subset-of",
                    vec![large.clone(); 9],
                    vec![large.clone(); 9],
                    vec![],
                    vec![large.clone(); 9],
                    vec![],
                )
            })
            .collect();
        let failure = diagnostic(
            &diagnostic_authority(),
            1,
            "value",
            "repairable-model-value",
            rows,
            false,
        );
        assert!(!failure.fatal_authority);
        let bytes = failure
            .canonical_bytes()
            .expect("bounded canonical diagnostic");
        assert!(bytes.len() <= kernel::generated::VALIDATION_ADMISSION_DIAGNOSTIC_MAX_BYTES);
        let value: ValidationAdmissionDiagnostic =
            serde_json::from_slice(&bytes).expect("typed compact diagnostic");
        assert_eq!(value.mismatch_count, 1900);
        assert!(value.complete);
        let original_values = vec![large; 9];
        let original_summary =
            diagnostic_string_list_summary(&original_values).expect("nonempty original summary");
        assert_eq!(value.mismatches[0].expected, [original_summary]);
        assert!(
            !String::from_utf8(bytes)
                .expect("diagnostic utf8")
                .contains(DIAGNOSTIC_ORIGINAL_SUMMARIES_KEY)
        );
    }

    #[test]
    fn rejected_receipt_references_are_digest_redacted_from_repair_diagnostics() {
        let forbidden = "package-check-receipt:secret-authority";
        let failure = diagnostic(
            &diagnostic_authority(),
            1,
            "value",
            "repairable-model-value",
            vec![row(
                "criterion-citation-refs",
                "/criterion_results/0/citation_refs",
                None,
                Some(&Id(forbidden.to_owned())),
                "subset-of",
                vec!["validation-source:allowed".to_owned()],
                vec![forbidden.to_owned()],
                vec![],
                vec![forbidden.to_owned()],
                duplicate_rows(&[forbidden.to_owned(), forbidden.to_owned()]),
            )],
            false,
        );
        let text = String::from_utf8(failure.canonical_bytes().expect("canonical diagnostic"))
            .expect("diagnostic utf8");
        assert!(
            !text.contains(forbidden),
            "receipt authority leaked: {text}"
        );
        assert!(text.contains("@rejected-receipt-reference"), "{text}");
    }

    #[test]
    fn source_record_binds_clean_filtered_worktree_snapshot_bytes() {
        let root = std::env::temp_dir().join(format!(
            "pi-autopilot-validation-filtered-source-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture root");
        let root = std::fs::canonicalize(root).expect("canonical fixture root");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .expect("git");
            assert!(output.status.success(), "git {args:?} failed");
            output.stdout
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "validation@example.invalid"]);
        git(&["config", "user.name", "Validation Fixture"]);
        std::fs::write(root.join(".gitattributes"), "filtered.txt text eol=crlf\n")
            .expect("attributes");
        std::fs::write(root.join("filtered.txt"), "line one\nline two\n").expect("source");
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "fixture"]);
        std::fs::remove_file(root.join("filtered.txt")).expect("remove source");
        git(&["checkout", "--", "filtered.txt"]);

        let mut worktree_bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::fs::File::open(root.join("filtered.txt")).expect("worktree source"),
            &mut worktree_bytes,
        )
        .expect("worktree bytes");
        let blob_bytes = git(&["cat-file", "blob", "HEAD:filtered.txt"]);
        assert_ne!(worktree_bytes, blob_bytes, "fixture must exercise a filter");
        assert!(git(&["status", "--porcelain=v1"]).is_empty());
        let text = |bytes: Vec<u8>| {
            String::from_utf8(bytes)
                .expect("git utf8")
                .trim()
                .to_owned()
        };
        let exact_commit = GitOid(text(git(&["rev-parse", "HEAD^{commit}"])));
        let exact_tree = GitOid(text(git(&["rev-parse", "HEAD^{tree}"])));
        let record = derive_source_record(&root, &exact_commit, &exact_tree, "filtered.txt")
            .expect("source authority")
            .expect("source record");
        assert_eq!(record.blob_digest.0, sha256_hex(&worktree_bytes));
        assert_ne!(record.blob_digest.0, sha256_hex(&blob_bytes));
        assert_eq!(
            record.git_blob_oid.0,
            text(git(&["rev-parse", "HEAD:filtered.txt"]))
        );
        std::fs::remove_dir_all(&root).expect("remove filtered fixture");
    }

    #[test]
    fn early_authority_failure_keeps_trusted_identity_and_root_pointer() {
        let identity = ValidationAuthorityExpectation {
            validation_id: &Id("validation-known".to_owned()),
            assignment_id: &Id("assignment-known".to_owned()),
            base_commit: &GitOid("0".repeat(40)),
            exact_commit: &GitOid("1".repeat(40)),
            exact_tree: &GitOid("2".repeat(40)),
            candidate_root: Path::new("/tmp/known"),
        };
        let mut untrusted = diagnostic_authority();
        untrusted.validation_id = Id("validation-untrusted".to_owned());
        untrusted.assignment_id = Id("assignment-untrusted".to_owned());
        untrusted.authority_digest = kernel::generated::Digest("b".repeat(64));
        let failure = diagnostic(
            &untrusted,
            0,
            "authority",
            "fatal-authority",
            vec![simple_row(
                "authority-identity",
                "",
                "trusted identity",
                "drift",
            )],
            true,
        )
        .with_trusted_identity(&identity, &"a".repeat(64));
        let diagnostic: ValidationAdmissionDiagnostic =
            serde_json::from_slice(&failure.canonical_bytes().expect("canonical diagnostic"))
                .expect("typed diagnostic");
        assert_eq!(diagnostic.validation_id.0, "validation-known");
        assert_eq!(diagnostic.assignment_id.0, "assignment-known");
        assert_eq!(diagnostic.authority_digest.0, "a".repeat(64));
        assert_eq!(diagnostic.mismatches[0].field, "");
    }
}
