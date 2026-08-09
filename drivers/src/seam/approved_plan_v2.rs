//! Durable V2 approved-plan image and external-binding persistence/replay.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use kernel::generated::{Id, Nullable, PlanUnitKind, TerminalRoute};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::allocation::{
    self, ApprovedUnit, ApprovedUnitPackageAuthorityV2, ApprovedUnitVendoringV2,
};
use crate::planning::{self, ApprovedWorkMapV2, WorkMapV2AdmissionContext};
use crate::runner;

pub const APPROVED_PLAN_V2_SCHEMA: &str = "autopilot.approved_plan.v2";
pub const APPROVED_PLAN_V2_BINDING_SCHEMA: &str = "autopilot.approved_plan_v2_binding.v1";
pub const APPROVED_PLAN_V2_BOUNDARY: &str = "planning.work-map.v2";
pub const APPROVED_PLAN_V2_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const APPROVED_PLAN_V2_BINDING_MAX_BYTES: usize = 64 * 1024;

/// Version-isolated image. Construction is crate-confined to strict V2
/// admission; external callers can only obtain images through the reader.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedPlanArtifactV2 {
    pub schema: String,
    pub source_boundary: String,
    pub result_contract: String,
    pub source_raw_work_map_sha256: String,
    pub units: Vec<ApprovedUnit>,
    pub vendoring: Vec<ApprovedUnitVendoringV2>,
    pub package_authority: Vec<ApprovedUnitPackageAuthorityV2>,
}

/// Canonical external trust root. It deliberately has no self digest: the
/// caller supplies and roots the raw binding-file digest independently.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedPlanV2BindingV1 {
    pub schema: String,
    pub workstream: String,
    pub approved_plan_path: String,
    pub approved_plan_sha256: String,
    pub source_carrier_path: String,
    pub source_carrier_sha256: String,
    pub source_raw_work_map_sha256: String,
    pub source_spec_path: String,
    pub source_spec_digest: String,
    pub source_role_id: String,
    pub source_mode: String,
    pub source_terminal_route: TerminalRoute,
    pub source_carrier_binding: String,
    pub source_pi_version: String,
    pub source_boundary: String,
    pub result_contract: String,
    pub atom_registry_path: String,
    pub atom_registry_digest: String,
    /// Required explicit null for an ordinary plan, or a tagged, complete
    /// non-recursive subject binding for a recovered plan. `Nullable` is not
    /// an `Option` field, so serde mechanically rejects a missing key while
    /// accepting an explicit JSON null.
    pub recovery_subject: Nullable<ApprovedPlanV2RecoverySubjectBindingV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedPlanV2RecoverySubjectBindingV1 {
    pub schema: String,
    pub source_carrier_path: String,
    pub source_carrier_sha256: String,
    pub source_raw_work_map_sha256: String,
    pub source_spec_path: String,
    pub source_spec_digest: String,
    pub source_role_id: String,
    pub source_mode: String,
    pub source_terminal_route: TerminalRoute,
    pub source_carrier_binding: String,
    pub source_pi_version: String,
    pub atom_registry_path: String,
    pub atom_registry_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovedPlanV2Promotion {
    pub binding_path: PathBuf,
    pub binding_sha256: String,
    pub approved_plan_sha256: String,
}

/// Persist the canonical image followed by a separate canonical binding file.
/// The binding digest returned here is the only value a future Core event must
/// root. An image orphan has no reader API and is therefore unusable.
/// Core-only production writer. It accepts only a strict actual-carrier
/// admission and is intentionally not re-exported as a public seam API.
pub(crate) fn write_approved_plan_v2(
    workstream: &str,
    approved_plan_path: &Path,
    binding_path: &Path,
    admitted: &ApprovedWorkMapV2,
) -> Result<ApprovedPlanV2Promotion, String> {
    validate_workstream(workstream)?;
    reject_artifact_path(approved_plan_path, "approved plan")?;
    reject_artifact_path(binding_path, "approved-plan binding")?;
    let run_root = lexical_run_root_from_binding_path(binding_path, workstream)?;
    validate_run_artifact_path(approved_plan_path, &run_root, "approved plan")?;
    validate_run_artifact_path(binding_path, &run_root, "approved-plan binding")?;
    if matches!(
        admitted.recovery_disposition(),
        Some(
            kernel::generated::RecoveryDisposition::RequiresNewAuthority
                | kernel::generated::RecoveryDisposition::InfrastructureBlocked
                | kernel::generated::RecoveryDisposition::UnsafeBlocked
        )
    ) {
        return Err(
            "approved-plan-v2 blocked recovery disposition is not promotable as an executable plan"
                .to_owned(),
        );
    }
    // Production promotion has one source: the exact, sealed child carrier
    // admitted by Core. The retired sidecar remains usable only in isolated
    // admission tests and can never become approved-plan authority.
    let admitted_actual = admitted.source_actual_authority().ok_or_else(|| {
        "approved-plan-v2 promotion requires an actual V2 planning carrier admission".to_owned()
    })?;
    let verified = planning::work_map_v2::verify_work_map_v2_actual_carrier_authority(
        admitted.source_carrier_path(),
        &run_root,
        Path::new(&admitted_actual.spec_path),
        &admitted_actual.spec_digest,
    )?;
    if sha256_hex(verified.source.raw_bytes()) != admitted.source_carrier_sha256()
        || sha256_hex(verified.source.raw_work_map_payload())
            != admitted.source_raw_work_map_sha256()
        || verified.authority != *admitted_actual
    {
        return Err("approved-plan-v2 promotion source carrier/payload authority drift".to_owned());
    }
    let atoms = runner::read_bounded_authority_file(
        admitted.atom_registry_path(),
        planning::ATOM_REGISTRY_MAX_BYTES,
    )
    .map_err(|error| format!("approved-plan-v2 promotion atom registry: {error}"))?;
    if sha256_hex(&atoms) != admitted.atom_registry_digest() {
        return Err("approved-plan-v2 promotion atom registry drift".to_owned());
    }
    let artifact = artifact_from_admitted(admitted);
    validate_approved_plan_v2_image(&artifact)?;
    let image = crate::evidence::canonical_json(&artifact).map_err(|error| error.to_string())?;
    if image.len() > APPROVED_PLAN_V2_MAX_BYTES {
        return Err("approved-plan-v2 image exceeds byte ceiling".to_owned());
    }
    runner::write_bounded_file_create_once(approved_plan_path, &image, APPROVED_PLAN_V2_MAX_BYTES)
        .map_err(|error| format!("approved-plan-v2 image write: {error}"))?;
    let binding = ApprovedPlanV2BindingV1 {
        schema: APPROVED_PLAN_V2_BINDING_SCHEMA.to_owned(),
        workstream: workstream.to_owned(),
        approved_plan_path: path_string(approved_plan_path)?,
        approved_plan_sha256: sha256_hex(&image),
        source_carrier_path: path_string(admitted.source_carrier_path())?,
        source_carrier_sha256: admitted.source_carrier_sha256().to_owned(),
        source_raw_work_map_sha256: admitted.source_raw_work_map_sha256().to_owned(),
        source_spec_path: admitted_actual.spec_path.clone(),
        source_spec_digest: admitted_actual.spec_digest.clone(),
        source_role_id: admitted_actual.role_id.clone(),
        source_mode: admitted_actual.mode.clone(),
        source_terminal_route: admitted_actual.terminal_route.clone(),
        source_carrier_binding: admitted_actual.carrier_binding.clone(),
        source_pi_version: admitted_actual.pi_version.clone(),
        source_boundary: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
        result_contract: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
        atom_registry_path: path_string(admitted.atom_registry_path())?,
        atom_registry_digest: admitted.atom_registry_digest().to_owned(),
        recovery_subject: Nullable(
            admitted
                .recovery_subject()
                .map(recovery_subject_binding_from_admitted)
                .transpose()?,
        ),
    };
    validate_binding_shape(&binding)?;
    let binding_bytes =
        crate::evidence::canonical_json(&binding).map_err(|error| error.to_string())?;
    if binding_bytes.len() > APPROVED_PLAN_V2_BINDING_MAX_BYTES {
        return Err("approved-plan-v2 binding exceeds byte ceiling".to_owned());
    }
    runner::write_bounded_file_create_once(
        binding_path,
        &binding_bytes,
        APPROVED_PLAN_V2_BINDING_MAX_BYTES,
    )
    .map_err(|error| format!("approved-plan-v2 binding write: {error}"))?;
    Ok(ApprovedPlanV2Promotion {
        binding_path: binding_path.to_path_buf(),
        binding_sha256: sha256_hex(&binding_bytes),
        approved_plan_sha256: sha256_hex(&image),
    })
}

/// Isolated integration-fixture writer. Its name deliberately prevents a
/// runtime caller from treating it as a production promotion API; it still
/// enforces the same actual-carrier admission requirement as Core.
#[doc(hidden)]
pub fn write_approved_plan_v2_for_test_only(
    workstream: &str,
    approved_plan_path: &Path,
    binding_path: &Path,
    admitted: &ApprovedWorkMapV2,
) -> Result<ApprovedPlanV2Promotion, String> {
    write_approved_plan_v2(workstream, approved_plan_path, binding_path, admitted)
}

/// Replays only an externally rooted binding. It hashes the binding before
/// reading any pointed-to field, then replays the exact source admission and
/// compares the complete enriched image byte-for-byte in authority terms.
pub fn read_approved_plan_v2(
    binding_path: &Path,
    expected_binding_sha256: &str,
) -> Result<ApprovedPlanArtifactV2, String> {
    reject_artifact_path(binding_path, "approved-plan binding")?;
    if !is_lower_sha256(expected_binding_sha256) {
        return Err("approved-plan-v2 expected binding digest is malformed".to_owned());
    }
    let binding_bytes =
        runner::read_bounded_authority_file(binding_path, APPROVED_PLAN_V2_BINDING_MAX_BYTES)
            .map_err(|error| format!("approved-plan-v2 binding read: {error}"))?;
    let binding_digest = sha256_hex(&binding_bytes);
    if binding_digest != expected_binding_sha256 {
        return Err(format!(
            "approved-plan-v2 external binding digest mismatch: expected {expected_binding_sha256}, got {binding_digest}"
        ));
    }
    let binding: ApprovedPlanV2BindingV1 = serde_json::from_slice(&binding_bytes)
        .map_err(|error| format!("approved-plan-v2 binding JSON: {error}"))?;
    if crate::evidence::canonical_json(&binding).map_err(|error| error.to_string())?
        != binding_bytes
    {
        return Err("approved-plan-v2 binding bytes are not canonical JSON".to_owned());
    }
    validate_binding_shape(&binding)?;

    let expected_run_root = lexical_run_root_from_binding_path(binding_path, &binding.workstream)?;
    let image_path = Path::new(&binding.approved_plan_path);
    for (path, label) in [
        (binding_path, "approved-plan binding"),
        (image_path, "approved plan"),
        (Path::new(&binding.source_carrier_path), "source carrier"),
        (Path::new(&binding.source_spec_path), "source spec"),
        (Path::new(&binding.atom_registry_path), "atom registry"),
    ] {
        validate_run_artifact_path(path, &expected_run_root, label)?;
    }
    if let Some(subject) = &binding.recovery_subject.0 {
        for (path, label) in [
            (
                Path::new(&subject.source_carrier_path),
                "recovery subject source carrier",
            ),
            (
                Path::new(&subject.source_spec_path),
                "recovery subject source spec",
            ),
            (
                Path::new(&subject.atom_registry_path),
                "recovery subject atom registry",
            ),
        ] {
            validate_run_artifact_path(path, &expected_run_root, label)?;
        }
    }

    let run_root = expected_run_root;

    let image = runner::read_bounded_authority_file(image_path, APPROVED_PLAN_V2_MAX_BYTES)
        .map_err(|error| format!("approved-plan-v2 image read: {error}"))?;
    if sha256_hex(&image) != binding.approved_plan_sha256 {
        return Err("approved-plan-v2 image digest mismatch".to_owned());
    }
    let artifact: ApprovedPlanArtifactV2 = serde_json::from_slice(&image)
        .map_err(|error| format!("approved-plan-v2 image JSON: {error}"))?;
    if crate::evidence::canonical_json(&artifact).map_err(|error| error.to_string())? != image {
        return Err("approved-plan-v2 image bytes are not canonical JSON".to_owned());
    }

    let verified_source = planning::work_map_v2::verify_work_map_v2_actual_carrier_authority(
        Path::new(&binding.source_carrier_path),
        &run_root,
        Path::new(&binding.source_spec_path),
        &binding.source_spec_digest,
    )?;
    let source = &verified_source.source;
    let source_actual = &verified_source.authority;
    if sha256_hex(source.raw_bytes()) != binding.source_carrier_sha256
        || sha256_hex(source.raw_work_map_payload()) != binding.source_raw_work_map_sha256
        || source_actual.role_id != binding.source_role_id
        || source_actual.mode != binding.source_mode
        || source_actual.terminal_route != binding.source_terminal_route
        || source_actual.carrier_binding != binding.source_carrier_binding
        || source_actual.spec_path != binding.source_spec_path
        || source_actual.spec_digest != binding.source_spec_digest
        || source_actual.pi_version != binding.source_pi_version
    {
        return Err("approved-plan-v2 source carrier authority digest/field mismatch".to_owned());
    }
    let recovery_subject = if let Some(subject_binding) = &binding.recovery_subject.0 {
        validate_run_artifact_path(
            Path::new(&subject_binding.source_carrier_path),
            &run_root,
            "recovery subject source carrier",
        )?;
        validate_run_artifact_path(
            Path::new(&subject_binding.atom_registry_path),
            &run_root,
            "recovery subject atom registry",
        )?;
        let verified_subject = planning::work_map_v2::verify_work_map_v2_actual_carrier_authority(
            Path::new(&subject_binding.source_carrier_path),
            &run_root,
            Path::new(&subject_binding.source_spec_path),
            &subject_binding.source_spec_digest,
        )?;
        let subject_source = &verified_subject.source;
        let subject_actual = &verified_subject.authority;
        if sha256_hex(subject_source.raw_bytes()) != subject_binding.source_carrier_sha256
            || sha256_hex(subject_source.raw_work_map_payload())
                != subject_binding.source_raw_work_map_sha256
            || subject_actual.role_id != subject_binding.source_role_id
            || subject_actual.mode != subject_binding.source_mode
            || subject_actual.terminal_route != subject_binding.source_terminal_route
            || subject_actual.carrier_binding != subject_binding.source_carrier_binding
            || subject_actual.spec_path != subject_binding.source_spec_path
            || subject_actual.spec_digest != subject_binding.source_spec_digest
            || subject_actual.pi_version != subject_binding.source_pi_version
        {
            return Err("approved-plan-v2 recovery subject carrier authority mismatch".to_owned());
        }
        let subject = planning::admit_work_map_v2(
            subject_source.raw_work_map_payload(),
            &subject_source,
            WorkMapV2AdmissionContext {
                atom_registry_path: Path::new(&subject_binding.atom_registry_path),
                atom_registry_digest: &subject_binding.atom_registry_digest,
                recovery_subject: None,
            },
        )
        .map_err(|error| format!("approved-plan-v2 recovery subject replay: {error}"))?;
        Some(subject)
    } else {
        None
    };
    let replay = planning::admit_work_map_v2(
        source.raw_work_map_payload(),
        &source,
        WorkMapV2AdmissionContext {
            atom_registry_path: Path::new(&binding.atom_registry_path),
            atom_registry_digest: &binding.atom_registry_digest,
            recovery_subject: recovery_subject.as_ref(),
        },
    )
    .map_err(|error| format!("approved-plan-v2 source replay: {error}"))?;
    let expected = artifact_from_admitted(&replay);
    if artifact != expected {
        return Err(
            "approved-plan-v2 image does not exactly equal strict source admission".to_owned(),
        );
    }
    validate_approved_plan_v2_image(&artifact)?;
    Ok(artifact)
}

fn artifact_from_admitted(admitted: &ApprovedWorkMapV2) -> ApprovedPlanArtifactV2 {
    ApprovedPlanArtifactV2 {
        schema: APPROVED_PLAN_V2_SCHEMA.to_owned(),
        source_boundary: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
        result_contract: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
        source_raw_work_map_sha256: admitted.source_raw_work_map_sha256().to_owned(),
        units: admitted.units().to_vec(),
        vendoring: admitted.vendoring().to_vec(),
        package_authority: admitted.package_authority().to_vec(),
    }
}

fn recovery_subject_binding_from_admitted(
    subject: &planning::work_map_v2::ApprovedWorkMapV2RecoverySubject,
) -> Result<ApprovedPlanV2RecoverySubjectBindingV1, String> {
    Ok(ApprovedPlanV2RecoverySubjectBindingV1 {
        schema: "autopilot.approved_plan_v2_recovery_subject.v1".to_owned(),
        source_carrier_path: path_string(&subject.source_carrier_path)?,
        source_carrier_sha256: subject.source_carrier_sha256.clone(),
        source_raw_work_map_sha256: subject.source_raw_work_map_sha256.clone(),
        source_spec_path: subject
            .source_actual_authority
            .as_ref()
            .ok_or_else(|| {
                "approved-plan-v2 recovery subject lacks actual carrier authority".to_owned()
            })?
            .spec_path
            .clone(),
        source_spec_digest: subject
            .source_actual_authority
            .as_ref()
            .expect("checked actual recovery authority")
            .spec_digest
            .clone(),
        source_role_id: subject
            .source_actual_authority
            .as_ref()
            .ok_or_else(|| {
                "approved-plan-v2 recovery subject lacks actual carrier authority".to_owned()
            })?
            .role_id
            .clone(),
        source_mode: subject
            .source_actual_authority
            .as_ref()
            .expect("checked actual recovery authority")
            .mode
            .clone(),
        source_terminal_route: subject
            .source_actual_authority
            .as_ref()
            .ok_or_else(|| {
                "approved-plan-v2 recovery subject lacks actual carrier authority".to_owned()
            })?
            .terminal_route
            .clone(),
        source_carrier_binding: subject
            .source_actual_authority
            .as_ref()
            .expect("checked actual recovery authority")
            .carrier_binding
            .clone(),
        source_pi_version: subject
            .source_actual_authority
            .as_ref()
            .expect("checked actual recovery authority")
            .pi_version
            .clone(),
        atom_registry_path: path_string(&subject.atom_registry_path)?,
        atom_registry_digest: subject.atom_registry_digest.clone(),
    })
}

fn validate_binding_shape(binding: &ApprovedPlanV2BindingV1) -> Result<(), String> {
    if binding.schema != APPROVED_PLAN_V2_BINDING_SCHEMA
        || binding.source_boundary != APPROVED_PLAN_V2_BOUNDARY
        || binding.result_contract != APPROVED_PLAN_V2_BOUNDARY
        || !is_lower_sha256(&binding.approved_plan_sha256)
        || !is_lower_sha256(&binding.source_carrier_sha256)
        || !is_lower_sha256(&binding.source_raw_work_map_sha256)
        || !is_lower_sha256(&binding.source_spec_digest)
        || !actual_source_authority_is_well_formed(
            &binding.source_role_id,
            &binding.source_mode,
            &binding.source_terminal_route,
            &binding.source_carrier_binding,
            &binding.source_pi_version,
        )
        || !is_lower_sha256(&binding.atom_registry_digest)
    {
        return Err("approved-plan-v2 binding is malformed".to_owned());
    }
    validate_workstream(&binding.workstream)?;
    for (path, label) in [
        (&binding.approved_plan_path, "approved plan"),
        (&binding.source_carrier_path, "source carrier"),
        (&binding.source_spec_path, "source spec"),
        (&binding.atom_registry_path, "atom registry"),
    ] {
        reject_artifact_path(Path::new(path), label)?;
    }
    if let Some(subject) = &binding.recovery_subject.0 {
        validate_recovery_subject_binding(binding, subject)?;
    }
    Ok(())
}

fn actual_source_authority_is_well_formed(
    role_id: &str,
    mode: &str,
    route: &TerminalRoute,
    carrier_binding: &str,
    pi_version: &str,
) -> bool {
    let expected = match runner::terminal_route_for(
        role_id,
        APPROVED_PLAN_V2_BOUNDARY,
        APPROVED_PLAN_V2_BOUNDARY,
    ) {
        Ok(route) => route,
        Err(_) => return false,
    };
    matches!(
        (role_id, mode, expected.profile_id.as_str()),
        (
            "plan-compiler",
            "initial-plan",
            "planning.work-map.v2:autopilot_submit_plan_cluster"
        ) | (
            "plan-synthesizer",
            "initial-plan",
            "planning.work-map.v2:autopilot_submit_synthesis"
        ) | (
            "recovery-engineer",
            "planning-repair",
            "recovery-work-map.v2"
        )
    ) && *route == expected
        && !carrier_binding.trim().is_empty()
        && !pi_version.trim().is_empty()
}

fn validate_recovery_subject_binding(
    binding: &ApprovedPlanV2BindingV1,
    subject: &ApprovedPlanV2RecoverySubjectBindingV1,
) -> Result<(), String> {
    if subject.schema != "autopilot.approved_plan_v2_recovery_subject.v1"
        || !is_lower_sha256(&subject.source_carrier_sha256)
        || !is_lower_sha256(&subject.source_raw_work_map_sha256)
        || !is_lower_sha256(&subject.source_spec_digest)
        || !actual_source_authority_is_well_formed(
            &subject.source_role_id,
            &subject.source_mode,
            &subject.source_terminal_route,
            &subject.source_carrier_binding,
            &subject.source_pi_version,
        )
        || !is_lower_sha256(&subject.atom_registry_digest)
    {
        return Err("approved-plan-v2 recovery subject binding is malformed".to_owned());
    }
    for (path, label) in [
        (
            &subject.source_carrier_path,
            "recovery subject source carrier",
        ),
        (&subject.source_spec_path, "recovery subject source spec"),
        (
            &subject.atom_registry_path,
            "recovery subject atom registry",
        ),
    ] {
        reject_artifact_path(Path::new(path), label)?;
    }
    if subject.atom_registry_path != binding.atom_registry_path
        || subject.atom_registry_digest != binding.atom_registry_digest
    {
        return Err(
            "approved-plan-v2 recovery subject authority differs from candidate".to_owned(),
        );
    }
    Ok(())
}

fn validate_approved_plan_v2_image(artifact: &ApprovedPlanArtifactV2) -> Result<(), String> {
    if artifact.schema != APPROVED_PLAN_V2_SCHEMA
        || artifact.source_boundary != APPROVED_PLAN_V2_BOUNDARY
        || artifact.result_contract != APPROVED_PLAN_V2_BOUNDARY
        || !is_lower_sha256(&artifact.source_raw_work_map_sha256)
    {
        return Err("approved-plan-v2 image schema/route/source digest is malformed".to_owned());
    }
    let mut ids = BTreeSet::new();
    for (index, unit) in artifact.units.iter().enumerate() {
        validate_unit(unit, index)?;
        if !ids.insert(unit.id.clone()) {
            return Err(format!("approved-plan-v2 duplicate unit id {}", unit.id.0));
        }
    }
    validate_graph(&artifact.units, &ids)?;
    allocation::validate_approved_v2_authority(
        &artifact.units,
        &artifact.vendoring,
        &artifact.package_authority,
    )
    .map_err(|error| format!("approved-plan-v2 package authority: {error}"))
}

fn validate_unit(unit: &ApprovedUnit, index: usize) -> Result<(), String> {
    if unit.kind != PlanUnitKind::Implementation
        || unit.id.0.len() > planning::WORK_MAP_V2_MAX_DERIVED_UNIT_ID_BYTES
        || !authority_id(&unit.id.0)
        || unit.operator_order
            != u32::try_from(index + 1).map_err(|_| "approved-plan-v2 operator order overflow")?
        || !unit.package_checks.is_empty()
    {
        return Err(format!(
            "approved-plan-v2 malformed implementation unit {}",
            unit.id.0
        ));
    }
    if !bounded_utf8_text(&unit.objective, planning::WORK_MAP_V2_MAX_ITEM_BYTES)
        || unit.criteria.len() != unit.criterion_text.len()
        || unit.criteria.is_empty()
        || unit.decisions.is_empty()
    {
        return Err(format!(
            "approved-plan-v2 unit {} criterion/link drift",
            unit.id.0
        ));
    }
    for (ordinal, (id, criterion)) in unit.criteria.iter().zip(&unit.criterion_text).enumerate() {
        let expected = Id(format!("AC-{}-{}", unit.id.0, ordinal + 1));
        if *id != expected
            || criterion.id != expected
            || !authority_id(&expected.0)
            || !bounded_utf8_text(&criterion.text, planning::WORK_MAP_V2_MAX_ITEM_BYTES)
        {
            return Err(format!(
                "approved-plan-v2 derived criterion drift for {}",
                unit.id.0
            ));
        }
    }
    let predecessor = unit
        .dependencies
        .iter()
        .map(|dependency| Id(format!("unit-complete:{}", dependency.0)))
        .collect::<Vec<_>>();
    let release = vec![Id(format!("unit:{}", unit.id.0))];
    if unit.predecessor_forward_criteria != predecessor || unit.downstream_release_edges != release
    {
        return Err(format!(
            "approved-plan-v2 derived dependency authority drift for {}",
            unit.id.0
        ));
    }
    for id in unit
        .decisions
        .iter()
        .chain(unit.dependencies.iter())
        .chain(predecessor.iter())
        .chain(release.iter())
    {
        if !authority_id(&id.0) {
            return Err(format!("approved-plan-v2 malformed authority id {}", id.0));
        }
    }
    for path in &unit.files {
        if path.0.len() > planning::WORK_MAP_V2_MAX_ITEM_BYTES
            || !path.0.is_ascii()
            || path.0.chars().any(char::is_control)
            || !allocation::approved_path_is_safe(path)
        {
            return Err(format!("approved-plan-v2 malformed unit file {}", path.0));
        }
    }
    for command in &unit.commands {
        if !bounded_utf8_text(&command.command, 16 * 1024)
            || !bounded_utf8_text(&command.expected, planning::WORK_MAP_V2_MAX_ITEM_BYTES)
            || !bounded_utf8_text(
                &command.scope_preservation,
                planning::WORK_MAP_V2_MAX_ITEM_BYTES,
            )
        {
            return Err("approved-plan-v2 malformed command text".to_owned());
        }
        for path in &command.generated_paths {
            if path.0.len() > planning::WORK_MAP_V2_MAX_ITEM_BYTES
                || !path.0.is_ascii()
                || path.0.chars().any(char::is_control)
                || !allocation::approved_path_is_safe(path)
            {
                return Err("approved-plan-v2 malformed generated path".to_owned());
            }
        }
        allocation::validate_plan_unit_command_effect_authority(command)
            .map_err(|error| format!("approved-plan-v2 command authority: {error}"))?;
    }
    Ok(())
}

fn validate_graph(units: &[ApprovedUnit], ids: &BTreeSet<Id>) -> Result<(), String> {
    let by_id = units
        .iter()
        .map(|unit| (unit.id.clone(), unit))
        .collect::<BTreeMap<_, _>>();
    fn visit(
        id: &Id,
        by_id: &BTreeMap<Id, &ApprovedUnit>,
        ids: &BTreeSet<Id>,
        active: &mut BTreeSet<Id>,
        done: &mut BTreeSet<Id>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !active.insert(id.clone()) {
            return Err(format!("approved-plan-v2 dependency cycle at {}", id.0));
        }
        let unit = by_id
            .get(id)
            .ok_or_else(|| format!("approved-plan-v2 missing unit {}", id.0))?;
        for dep in &unit.dependencies {
            if dep == id || !ids.contains(dep) {
                return Err(format!(
                    "approved-plan-v2 unknown/self dependency {}",
                    dep.0
                ));
            }
            visit(dep, by_id, ids, active, done)?;
        }
        active.remove(id);
        done.insert(id.clone());
        Ok(())
    }
    let mut active = BTreeSet::new();
    let mut done = BTreeSet::new();
    for unit in units {
        visit(&unit.id, &by_id, ids, &mut active, &mut done)?;
    }
    Ok(())
}

fn bounded_utf8_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes
}

fn authority_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && !value.chars().any(char::is_control)
}

fn lexical_run_root_from_binding_path(
    binding_path: &Path,
    workstream: &str,
) -> Result<PathBuf, String> {
    validate_workstream(workstream)?;
    let components = binding_path.components().collect::<Vec<_>>();
    let mut matches = Vec::new();
    for index in 0..components.len().saturating_sub(2) {
        if matches!(components[index], Component::Normal(name) if name == ".pi")
            && matches!(components[index + 1], Component::Normal(name) if name == "autopilot")
            && matches!(components[index + 2], Component::Normal(name) if name == workstream)
        {
            matches.push(index);
        }
    }
    let [index] = matches.as_slice() else {
        return Err(
            "approved-plan-v2 binding path does not have one exact .pi/autopilot/workstream shape"
                .to_owned(),
        );
    };
    let index = *index;
    if components[index + 3..].is_empty()
        || components[index + 3..]
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(
            "approved-plan-v2 binding path has no confined artifact leaf after its run root"
                .to_owned(),
        );
    }
    let mut run_root = PathBuf::new();
    for component in &components[..=index + 2] {
        run_root.push(component.as_os_str());
    }
    Ok(run_root)
}

fn validate_run_artifact_path(path: &Path, run_root: &Path, label: &str) -> Result<(), String> {
    if path == run_root || !path.starts_with(run_root) {
        return Err(format!(
            "approved-plan-v2 {label} is outside the exact repository/run authority root"
        ));
    }
    Ok(())
}

fn validate_workstream(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err("approved-plan-v2 workstream is not one safe component".to_owned())
    }
}

fn reject_artifact_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "approved-plan-v2 {label} path must be absolute and contain no parent/current component"
        ));
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "approved-plan-v2 path is not UTF-8".to_owned())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allocation::{ApprovedCriterion, ApprovedPackageProofV2, ApprovedVendorBindingV2};
    use kernel::generated::{Path as ContractPath, PlanUnitCommand};

    fn unit(id: &str, order: u32, files: Vec<ContractPath>) -> ApprovedUnit {
        let criterion = Id(format!("AC-{id}-1"));
        let command: PlanUnitCommand = serde_json::from_value(serde_json::json!({
            "command":"true","expected":"passes","effect":"no-effect",
            "generated_paths":[],"handling":"none","scope_preservation":"clean"
        }))
        .unwrap();
        ApprovedUnit {
            id: Id(id.to_owned()),
            kind: PlanUnitKind::Implementation,
            objective: "objective".to_owned(),
            operator_order: order,
            decisions: vec![Id("atom".to_owned())],
            criteria: vec![criterion.clone()],
            criterion_text: vec![ApprovedCriterion {
                id: criterion,
                text: "criterion".to_owned(),
            }],
            dependencies: vec![],
            predecessor_forward_criteria: vec![],
            downstream_release_edges: vec![Id(format!("unit:{id}"))],
            files,
            commands: vec![command],
            package_checks: vec![],
        }
    }

    fn artifact(units: Vec<ApprovedUnit>) -> ApprovedPlanArtifactV2 {
        ApprovedPlanArtifactV2 {
            schema: APPROVED_PLAN_V2_SCHEMA.to_owned(),
            source_boundary: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
            result_contract: APPROVED_PLAN_V2_BOUNDARY.to_owned(),
            source_raw_work_map_sha256: "d".repeat(64),
            units,
            vendoring: vec![],
            package_authority: vec![],
        }
    }

    fn complete_vendor_artifact() -> ApprovedPlanArtifactV2 {
        let mut image = artifact(vec![unit(
            "vendor",
            1,
            vec![
                ContractPath("manifests/provenance.json".to_owned()),
                ContractPath("vendor/a.bin".to_owned()),
                ContractPath("vendor/b.bin".to_owned()),
            ],
        )]);
        image.vendoring = vec![ApprovedUnitVendoringV2 {
            unit_id: Id("vendor".to_owned()),
            provenance_manifest_destination: Some(ContractPath(
                "manifests/provenance.json".to_owned(),
            )),
            vendor_bindings: vec![
                ApprovedVendorBindingV2 {
                    binding_id: Id("binding-a".to_owned()),
                    origin_path: ContractPath("upstream/a.bin".to_owned()),
                    destination: ContractPath("vendor/a.bin".to_owned()),
                },
                ApprovedVendorBindingV2 {
                    binding_id: Id("binding-b".to_owned()),
                    origin_path: ContractPath("upstream/b.bin".to_owned()),
                    destination: ContractPath("vendor/b.bin".to_owned()),
                },
            ],
        }];
        image.package_authority = vec![ApprovedUnitPackageAuthorityV2 {
            unit_id: Id("vendor".to_owned()),
            package_scope_files: vec![
                ContractPath("manifests/provenance.json".to_owned()),
                ContractPath("vendor/a.bin".to_owned()),
                ContractPath("vendor/b.bin".to_owned()),
            ],
            package_proofs: vec![ApprovedPackageProofV2 {
                proof_id: Id("vendor-proof".to_owned()),
                kind: kernel::generated::PackageProofKindV2::VendoredBytesMatchOrigin,
                criterion_ordinals: vec![1],
                expected: "bytes match".to_owned(),
                vendor_binding_ids: vec![Id("binding-a".to_owned()), Id("binding-b".to_owned())],
            }],
        }];
        image
    }

    #[test]
    fn approved_image_complete_validator_reaches_enrichment_order_and_closure_branches() {
        let image = complete_vendor_artifact();
        assert!(validate_approved_plan_v2_image(&image).is_ok());

        let mut binding_order = image.clone();
        binding_order.vendoring[0].vendor_bindings.swap(0, 1);
        assert_eq!(
            validate_approved_plan_v2_image(&binding_order).unwrap_err(),
            "approved-plan-v2 package authority: vendor bindings are not in canonical destination/origin/id byte order"
        );
        let mut scope_order = image.clone();
        scope_order.package_authority[0]
            .package_scope_files
            .swap(0, 1);
        assert_eq!(
            validate_approved_plan_v2_image(&scope_order).unwrap_err(),
            "approved-plan-v2 package authority: package scope files are not in canonical byte order"
        );
        let mut binding_id_order = image.clone();
        binding_id_order.package_authority[0].package_proofs[0]
            .vendor_binding_ids
            .swap(0, 1);
        assert_eq!(
            validate_approved_plan_v2_image(&binding_id_order).unwrap_err(),
            "approved-plan-v2 package authority: proof vendor-proof binding ids are not canonical"
        );
        let mut duplicate_ordinal = image.clone();
        duplicate_ordinal.package_authority[0].package_proofs[0].criterion_ordinals = vec![1, 1];
        assert_eq!(
            validate_approved_plan_v2_image(&duplicate_ordinal).unwrap_err(),
            "approved-plan-v2 package authority: proof vendor-proof criterion ordinals are not canonical"
        );
        let mut out_of_range_ordinal = image.clone();
        out_of_range_ordinal.package_authority[0].package_proofs[0].criterion_ordinals = vec![2];
        assert_eq!(
            validate_approved_plan_v2_image(&out_of_range_ordinal).unwrap_err(),
            "approved-plan-v2 package authority: proof vendor-proof has duplicate, zero, or out-of-range criterion ordinal"
        );
        let mut incomplete_coverage = image;
        incomplete_coverage.package_authority[0].package_proofs[0].vendor_binding_ids =
            vec![Id("binding-a".to_owned())];
        assert_eq!(
            validate_approved_plan_v2_image(&incomplete_coverage).unwrap_err(),
            "approved-plan-v2 package authority: global vendor proof binding ids must exactly equal all vendor bindings"
        );
    }

    #[test]
    fn approved_image_complete_validator_reaches_row_owner_and_core_path_branches() {
        let units = vec![
            unit("one", 1, vec![ContractPath("src/one.rs".to_owned())]),
            unit("two", 2, vec![ContractPath("src/two.rs".to_owned())]),
        ];
        let mut rows = artifact(units.clone());
        rows.vendoring = units
            .iter()
            .map(|unit| ApprovedUnitVendoringV2 {
                unit_id: unit.id.clone(),
                provenance_manifest_destination: None,
                vendor_bindings: vec![],
            })
            .collect();
        rows.package_authority = units
            .iter()
            .map(|unit| ApprovedUnitPackageAuthorityV2 {
                unit_id: unit.id.clone(),
                package_scope_files: vec![],
                package_proofs: vec![],
            })
            .collect();
        assert!(validate_approved_plan_v2_image(&rows).is_ok());
        let mut vendor_rows = rows.clone();
        vendor_rows.vendoring.swap(0, 1);
        assert_eq!(
            validate_approved_plan_v2_image(&vendor_rows).unwrap_err(),
            "approved-plan-v2 package authority: V2 vendoring rows must be in exact unit operator order"
        );
        let mut package_rows = rows.clone();
        package_rows.package_authority.swap(0, 1);
        assert_eq!(
            validate_approved_plan_v2_image(&package_rows).unwrap_err(),
            "approved-plan-v2 package authority: V2 package-authority rows must be in exact unit operator order"
        );
        let mut equal_owner = rows.clone();
        equal_owner.units[1].files = vec![ContractPath("src/one.rs".to_owned())];
        assert_eq!(
            validate_approved_plan_v2_image(&equal_owner).unwrap_err(),
            "approved-plan-v2 package authority: V2 implementation ownership collision src/one.rs (unit two) and src/one.rs (unit one)"
        );
        let mut ancestor_owner = rows;
        ancestor_owner.units[1].files = vec![ContractPath("src".to_owned())];
        assert_eq!(
            validate_approved_plan_v2_image(&ancestor_owner).unwrap_err(),
            "approved-plan-v2 package authority: V2 implementation ownership collision src (unit two) and src/one.rs (unit one)"
        );

        let mut destination_origin = complete_vendor_artifact();
        destination_origin.vendoring[0].vendor_bindings[0].origin_path =
            ContractPath("vendor/a.bin".to_owned());
        assert_eq!(
            validate_approved_plan_v2_image(&destination_origin).unwrap_err(),
            "approved-plan-v2 package authority: ordinary file vendor/a.bin collides with immutable origin vendor/a.bin"
        );
        let mut manifest_origin = complete_vendor_artifact();
        manifest_origin.vendoring[0].vendor_bindings[0].origin_path =
            ContractPath("manifests/provenance.json".to_owned());
        assert_eq!(
            validate_approved_plan_v2_image(&manifest_origin).unwrap_err(),
            "approved-plan-v2 package authority: ordinary file manifests/provenance.json collides with immutable origin manifests/provenance.json"
        );
        let mut generated_origin = complete_vendor_artifact();
        generated_origin.units[0].commands = vec![
            serde_json::from_value(serde_json::json!({
                "command":"generate","expected":"generated","effect":"declared-predictable",
                "generated_paths":["upstream"],"handling":"block-if-created",
                "scope_preservation":"clean"
            }))
            .unwrap(),
        ];
        assert_eq!(
            validate_approved_plan_v2_image(&generated_origin).unwrap_err(),
            "approved-plan-v2 package authority: command generated path upstream overlaps Core-owned vendor, manifest, or origin path"
        );
    }

    #[test]
    fn approved_image_global_bounds_and_enrichment_reach_complete_validator() {
        let units = vec![
            unit("one", 1, vec![ContractPath("src/one.rs".to_owned())]),
            unit("two", 2, vec![ContractPath("src/two.rs".to_owned())]),
        ];
        let mut exact = artifact(units.clone());
        exact.vendoring = units
            .iter()
            .map(|unit| ApprovedUnitVendoringV2 {
                unit_id: unit.id.clone(),
                provenance_manifest_destination: None,
                vendor_bindings: vec![],
            })
            .collect();
        exact.package_authority = [128_usize, 128]
            .into_iter()
            .enumerate()
            .map(|(row, count)| ApprovedUnitPackageAuthorityV2 {
                unit_id: units[row].id.clone(),
                package_scope_files: vec![],
                package_proofs: (0..count)
                    .map(|index| ApprovedPackageProofV2 {
                        proof_id: Id(format!("exact-proof-{row}-{index:03}")),
                        kind: kernel::generated::PackageProofKindV2::CleanExactPackageTip,
                        criterion_ordinals: vec![1],
                        expected: "clean".to_owned(),
                        vendor_binding_ids: vec![],
                    })
                    .collect(),
            })
            .collect();
        let exact_error = validate_approved_plan_v2_image(&exact).unwrap_err();
        assert!(
            !exact_error.contains("total package proofs exceeds 256"),
            "{exact_error}"
        );

        let mut image = artifact(units.clone());
        image.vendoring = units
            .iter()
            .map(|unit| ApprovedUnitVendoringV2 {
                unit_id: unit.id.clone(),
                provenance_manifest_destination: None,
                vendor_bindings: vec![],
            })
            .collect();
        image.package_authority = [129_usize, 128]
            .into_iter()
            .enumerate()
            .map(|(row, count)| ApprovedUnitPackageAuthorityV2 {
                unit_id: units[row].id.clone(),
                package_scope_files: vec![],
                package_proofs: (0..count)
                    .map(|index| ApprovedPackageProofV2 {
                        proof_id: Id(format!("proof-{row}-{index:03}")),
                        kind: kernel::generated::PackageProofKindV2::CleanExactPackageTip,
                        criterion_ordinals: vec![1],
                        expected: "clean".to_owned(),
                        vendor_binding_ids: vec![],
                    })
                    .collect(),
            })
            .collect();
        assert!(
            validate_approved_plan_v2_image(&image)
                .unwrap_err()
                .contains("total package proofs exceeds 256")
        );

        let units = [65_usize, 64]
            .into_iter()
            .enumerate()
            .map(|(row, count)| {
                let start = row * 65;
                let mut files = (start..start + count)
                    .map(|index| ContractPath(format!("vendor/{index:03}.bin")))
                    .collect::<Vec<_>>();
                files.push(ContractPath(format!("manifests/{row}.json")));
                unit(
                    &format!("bindings-{row}"),
                    u32::try_from(row + 1).unwrap(),
                    files,
                )
            })
            .collect::<Vec<_>>();
        let mut image = artifact(units.clone());
        image.vendoring = units
            .iter()
            .enumerate()
            .map(|(row, unit)| {
                let start = row * 65;
                let count = if row == 0 { 65 } else { 64 };
                ApprovedUnitVendoringV2 {
                    unit_id: unit.id.clone(),
                    provenance_manifest_destination: Some(ContractPath(format!(
                        "manifests/{row}.json"
                    ))),
                    vendor_bindings: (start..start + count)
                        .map(|index| ApprovedVendorBindingV2 {
                            binding_id: Id(format!("binding-{index:03}")),
                            origin_path: ContractPath(format!("upstream/{index:03}.bin")),
                            destination: ContractPath(format!("vendor/{index:03}.bin")),
                        })
                        .collect(),
                }
            })
            .collect();
        image.package_authority = units
            .into_iter()
            .map(|unit| ApprovedUnitPackageAuthorityV2 {
                unit_id: unit.id,
                package_scope_files: vec![],
                package_proofs: vec![],
            })
            .collect();
        assert!(
            validate_approved_plan_v2_image(&image)
                .unwrap_err()
                .contains("total vendor bindings exceeds 128")
        );
    }

    #[test]
    fn approved_image_preserves_bounded_unicode_free_text() {
        let mut image = artifact(vec![unit(
            "unicode",
            1,
            vec![ContractPath("src/unicode.rs".to_owned())],
        )]);
        image.units[0].objective = "目的は完全な検証です".to_owned();
        image.units[0].criterion_text[0].text = "基準が満たされる".to_owned();
        image.units[0].commands[0].command = "真実を検査する".to_owned();
        image.units[0].commands[0].expected = "成功する".to_owned();
        image.units[0].commands[0].scope_preservation = "状態を保存する".to_owned();
        image.vendoring = vec![ApprovedUnitVendoringV2 {
            unit_id: Id("unicode".to_owned()),
            provenance_manifest_destination: None,
            vendor_bindings: vec![],
        }];
        image.package_authority = vec![ApprovedUnitPackageAuthorityV2 {
            unit_id: Id("unicode".to_owned()),
            package_scope_files: vec![],
            package_proofs: vec![],
        }];
        assert!(validate_approved_plan_v2_image(&image).is_ok());
    }

    #[test]
    fn approved_image_keeps_authority_ids_ascii_while_text_is_unicode() {
        let mut image = artifact(vec![unit(
            "unicode",
            1,
            vec![ContractPath("src/unicode.rs".to_owned())],
        )]);
        image.units[0].id = Id("識別子".to_owned());
        image.vendoring = vec![ApprovedUnitVendoringV2 {
            unit_id: Id("識別子".to_owned()),
            provenance_manifest_destination: None,
            vendor_bindings: vec![],
        }];
        image.package_authority = vec![ApprovedUnitPackageAuthorityV2 {
            unit_id: Id("識別子".to_owned()),
            package_scope_files: vec![],
            package_proofs: vec![],
        }];
        let error = validate_approved_plan_v2_image(&image).unwrap_err();
        assert!(error.contains("malformed implementation unit"), "{error}");
    }
}
