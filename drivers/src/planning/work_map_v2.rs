//! Strict V2 work-map parsing, topology, closure, recovery, conversion, and enrichment.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use kernel::generated::{
    Id, PackageProofKindV2, PlanUnitKind, PlanningAtomRegistry, TerminalRoute, WorkMapV2,
};
use sha2::{Digest as ShaDigest, Sha256};

use crate::allocation::{self, validate_plan_unit_command_effect_authority};
use crate::runner;

pub const WORK_MAP_V2_MAX_UNITS: usize = 256;
pub const WORK_MAP_V2_MAX_ITEM_BYTES: usize = 4096;
pub const WORK_MAP_V2_MAX_DERIVED_UNIT_ID_BYTES: usize = 242;
/// A JSON string can escape every raw payload byte. Keep the raw 1 MiB
/// WorkMap budget unchanged while admitting its proven worst-case carrier
/// encoding plus bounded carrier framing.
pub const WORK_MAP_V2_SOURCE_CARRIER_MAX_BYTES: usize =
    2 * kernel::generated::WORK_MAP_V2_MAX_BYTES + 64 * 1024;

/// Exact bounded source carrier used to establish V2 admission provenance.
/// The fields are private so callers can only obtain one by descriptor-safe
/// reading of a versioned external carrier file.
#[derive(Clone, Debug)]
pub struct WorkMapV2SourceCarrier {
    path: PathBuf,
    bytes: Vec<u8>,
    raw_work_map_payload: Vec<u8>,
}

impl WorkMapV2SourceCarrier {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn raw_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub(crate) fn raw_work_map_payload(&self) -> &[u8] {
        &self.raw_work_map_payload
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkMapV2SourceCarrierWire {
    schema: String,
    boundary: String,
    result_contract: String,
    raw_work_map_payload: String,
}

/// The actual V2 carrier is the durable planning carrier written by the child,
/// not the retired source-carrier sidecar. Keeping this complete closed wire
/// type here lets image replay reject unknown fields before payload admission.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkMapV2ActualCarrierAuthority {
    pub(crate) action_id: String,
    pub(crate) assignment_id: String,
    pub(crate) run_revision: u64,
    pub(crate) workstream: String,
    pub(crate) role_id: String,
    pub(crate) mode: String,
    pub(crate) boundary_id: String,
    pub(crate) result_contract: String,
    pub(crate) prompt_path: String,
    pub(crate) prompt_digest: String,
    pub(crate) boundary_digest: String,
    pub(crate) result_contract_digest: String,
    pub(crate) settings_digest: String,
    pub(crate) context_digest: String,
    pub(crate) skills_digest: String,
    pub(crate) subscription_digest: String,
    pub(crate) runtime_extension_digest: String,
    pub(crate) spec_path: String,
    pub(crate) spec_digest: String,
    pub(crate) carrier_path: String,
    pub(crate) carrier_channel: String,
    pub(crate) tool_name: String,
    pub(crate) tool_schema_digest: String,
    pub(crate) carrier_binding: String,
    pub(crate) pi_version: String,
    pub(crate) terminal_route: TerminalRoute,
    pub(crate) atom_registry_path: String,
    pub(crate) atom_registry_digest: String,
}

/// Result of one complete carrier/spec authority replay.  The source bytes are
/// retained exactly as read; callers must never rebuild raw terminal output.
#[derive(Clone, Debug)]
pub(crate) struct VerifiedWorkMapV2ActualCarrier {
    pub(crate) source: WorkMapV2SourceCarrier,
    pub(crate) authority: WorkMapV2ActualCarrierAuthority,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkMapV2ActualCarrierWire {
    schema: String,
    action_id: String,
    assignment_id: String,
    run_revision: u64,
    workstream: String,
    role_id: String,
    mode: String,
    boundary_id: String,
    result_contract: String,
    prompt_path: String,
    prompt_digest: String,
    boundary_digest: String,
    result_contract_digest: String,
    settings_digest: String,
    context_digest: String,
    skills_digest: String,
    subscription_digest: String,
    runtime_extension_digest: String,
    spec_digest: String,
    spec_path: String,
    carrier_path: String,
    carrier_channel: String,
    tool_name: String,
    tool_schema_digest: String,
    carrier_binding: String,
    pi_version: String,
    terminal_route: TerminalRoute,
    atom_registry_path: String,
    atom_registry_digest: String,
    raw_output: String,
}

/// Read the exact durable source carrier before V2 admission. The carrier has
/// no shape-selection fallback and names the source boundary explicitly. This
/// standalone projection is deliberately provisional: the next routing wave
/// must connect it to verified AgentCarrier profile/tool/schema facts instead
/// of treating this reader as a production producer.
/// Read the actual sealed V2 planning carrier for replay. The raw output is
/// Core-normalized terminal payload bytes (after Pi decoded tool parameters),
/// never a claim about provider wire bytes.
pub(crate) fn read_work_map_v2_actual_carrier_authority(
    path: &Path,
) -> Result<(WorkMapV2SourceCarrier, WorkMapV2ActualCarrierAuthority), String> {
    reject_artifact_path(path, "actual carrier")?;
    let bytes = runner::read_bounded_authority_file(path, WORK_MAP_V2_SOURCE_CARRIER_MAX_BYTES)
        .map_err(|error| format!("work-map-v2 actual carrier read: {error}"))?;
    let wire: WorkMapV2ActualCarrierWire = serde_json::from_slice(&bytes)
        .map_err(|error| format!("work-map-v2 actual carrier JSON: {error}"))?;
    let expected_route = exact_v2_terminal_route(
        &wire.role_id,
        &wire.mode,
        &wire.boundary_id,
        &wire.result_contract,
    )?;
    if wire.schema != "autopilot.planning_carrier.v2"
        || wire.carrier_channel != "tool"
        || wire.pi_version.trim().is_empty()
        || wire.terminal_route != expected_route
        || wire.tool_name != expected_route.tool_name.0
        || wire.tool_schema_digest != expected_route.schema_digest.0
        || wire.raw_output.len() > kernel::generated::WORK_MAP_V2_MAX_BYTES
    {
        return Err("work-map-v2 actual carrier route/tuple/size drift".to_owned());
    }
    let authority = WorkMapV2ActualCarrierAuthority {
        action_id: wire.action_id,
        assignment_id: wire.assignment_id,
        run_revision: wire.run_revision,
        workstream: wire.workstream,
        role_id: wire.role_id,
        mode: wire.mode,
        boundary_id: wire.boundary_id,
        result_contract: wire.result_contract,
        prompt_path: wire.prompt_path,
        prompt_digest: wire.prompt_digest,
        boundary_digest: wire.boundary_digest,
        result_contract_digest: wire.result_contract_digest,
        settings_digest: wire.settings_digest,
        context_digest: wire.context_digest,
        skills_digest: wire.skills_digest,
        subscription_digest: wire.subscription_digest,
        runtime_extension_digest: wire.runtime_extension_digest,
        spec_path: wire.spec_path,
        spec_digest: wire.spec_digest,
        carrier_path: wire.carrier_path,
        carrier_channel: wire.carrier_channel,
        tool_name: wire.tool_name,
        tool_schema_digest: wire.tool_schema_digest,
        carrier_binding: wire.carrier_binding,
        pi_version: wire.pi_version,
        terminal_route: wire.terminal_route,
        atom_registry_path: wire.atom_registry_path,
        atom_registry_digest: wire.atom_registry_digest,
    };
    Ok((
        WorkMapV2SourceCarrier {
            path: path.to_path_buf(),
            bytes,
            raw_work_map_payload: wire.raw_output.into_bytes(),
        },
        authority,
    ))
}

/// Re-read one exact carrier and the exact closed spec that it names.  Core
/// admission and durable approved-plan replay use this one path so a
/// re-rooted carrier cannot substitute issuer-selected facts after its outer
/// digest has been recomputed.
pub(crate) fn verify_work_map_v2_actual_carrier_authority(
    carrier_path: &Path,
    run_root: &Path,
    expected_spec_path: &Path,
    expected_spec_digest: &str,
) -> Result<VerifiedWorkMapV2ActualCarrier, String> {
    validate_run_authority_path(carrier_path, run_root, "actual carrier")?;
    validate_run_authority_path(expected_spec_path, run_root, "actual carrier spec")?;
    if !is_lower_sha256(expected_spec_digest) {
        return Err("work-map-v2 actual carrier expected spec digest is malformed".to_owned());
    }
    let (source, authority) = read_work_map_v2_actual_carrier_authority(carrier_path)?;
    if authority.carrier_path != path_string(carrier_path)?
        || authority.spec_path != path_string(expected_spec_path)?
        || authority.spec_digest != expected_spec_digest
    {
        return Err("work-map-v2 actual carrier path/spec authority drift".to_owned());
    }
    let named_spec_path = Path::new(&authority.spec_path);
    validate_run_authority_path(named_spec_path, run_root, "actual carrier named spec")?;
    let spec_bytes = runner::read_bounded_authority_file(named_spec_path, 2 << 20)
        .map_err(|error| format!("work-map-v2 actual carrier spec read: {error}"))?;
    if sha256_hex(&spec_bytes) != authority.spec_digest {
        return Err("work-map-v2 actual carrier spec digest drift".to_owned());
    }
    let spec: kernel::generated::AgentRunSpec = serde_json::from_slice(&spec_bytes)
        .map_err(|error| format!("work-map-v2 actual carrier spec JSON: {error}"))?;
    let expected_cwd = run_root
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "work-map-v2 actual carrier run root has no repository parent".to_owned())?;
    let expected_paths =
        runner::planning_paths(expected_cwd, &spec.workstream.0, &spec.assignment_id);
    if spec.cwd.0 != path_string(expected_cwd)?
        || spec.spec_path.0 != path_string(&expected_paths.spec_path)?
        || spec.prompt_path.0 != path_string(&expected_paths.prompt_path)?
        || spec.carrier_path.0 != path_string(&expected_paths.carrier_path)?
    {
        return Err("work-map-v2 actual carrier generated path authority drift".to_owned());
    }
    if spec.schema.0 != "autopilot.agent_run_spec.v4"
        || spec.assignment_kind != kernel::generated::ValidationAssignmentKind::PlanningReview
        || spec.action_id.0 != authority.action_id
        || spec.assignment_id.0 != authority.assignment_id
        || spec.run_revision != authority.run_revision
        || spec.workstream.0 != authority.workstream
        || spec.role_id.0 != authority.role_id
        || spec.mode.0 != authority.mode
        || spec.boundary_id.0 != authority.boundary_id
        || spec.result_contract.0 != authority.result_contract
        || spec.prompt_path.0 != authority.prompt_path
        || spec.prompt_digest.0 != authority.prompt_digest
        || spec.boundary_digest.0 != authority.boundary_digest
        || spec.result_contract_digest.0 != authority.result_contract_digest
        || spec.settings_digest.0 != authority.settings_digest
        || spec.context_digest.0 != authority.context_digest
        || spec.skills_digest.0 != authority.skills_digest
        || spec.subscription_digest.0 != authority.subscription_digest
        || spec
            .runtime_extension_digest
            .as_ref()
            .map(|value| value.0.as_str())
            != Some(authority.runtime_extension_digest.as_str())
        || spec
            .runtime_extension_digest
            .as_ref()
            .map(|value| value.0.as_str())
            != Some(kernel::generated::CHILD_ADDON_DIGEST)
        || spec.spec_path.0 != authority.spec_path
        || spec.carrier_path.0 != authority.carrier_path
        || spec.terminal_route.as_ref() != Some(&authority.terminal_route)
        || spec.terminal_profile_id.as_deref() != Some(authority.terminal_route.profile_id.as_str())
        || spec
            .atom_registry_path
            .as_ref()
            .map(|value| value.0.as_str())
            != Some(authority.atom_registry_path.as_str())
        || spec
            .atom_registry_digest
            .as_ref()
            .map(|value| value.0.as_str())
            != Some(authority.atom_registry_digest.as_str())
        || spec.session_continuity != kernel::generated::SessionContinuity::Fresh
        || authority.carrier_binding != runner::child::carrier_binding(&spec)
    {
        return Err("work-map-v2 actual carrier/spec authority drift".to_owned());
    }
    Ok(VerifiedWorkMapV2ActualCarrier { source, authority })
}

fn exact_v2_terminal_route(
    role_id: &str,
    mode: &str,
    boundary_id: &str,
    result_contract: &str,
) -> Result<TerminalRoute, String> {
    let expected = runner::terminal_route_for(role_id, boundary_id, result_contract)
        .map_err(|error| format!("work-map-v2 actual carrier terminal route: {error}"))?;
    if !matches!(
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
    ) {
        return Err("work-map-v2 actual carrier role/mode/route drift".to_owned());
    }
    Ok(expected)
}

fn validate_run_authority_path(path: &Path, run_root: &Path, label: &str) -> Result<(), String> {
    reject_artifact_path(path, label)?;
    reject_artifact_path(run_root, "run root")?;
    if path == run_root || !path.starts_with(run_root) {
        return Err(format!(
            "work-map-v2 {label} is outside the exact repository/run authority root"
        ));
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "work-map-v2 authority path is not UTF-8".to_owned())
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn read_work_map_v2_source_carrier(path: &Path) -> Result<WorkMapV2SourceCarrier, String> {
    reject_artifact_path(path, "source carrier")?;
    let bytes = runner::read_bounded_authority_file(path, WORK_MAP_V2_SOURCE_CARRIER_MAX_BYTES)
        .map_err(|error| format!("work-map-v2 source carrier read: {error}"))?;
    let wire: WorkMapV2SourceCarrierWire = serde_json::from_slice(&bytes)
        .map_err(|error| format!("work-map-v2 source carrier JSON: {error}"))?;
    if wire.schema != "autopilot.work_map_v2_source_carrier.v1"
        || wire.boundary != "planning.work-map.v2"
        || wire.result_contract != "planning.work-map.v2"
    {
        return Err("work-map-v2 source carrier has wrong schema or route".to_owned());
    }
    if wire.raw_work_map_payload.len() > kernel::generated::WORK_MAP_V2_MAX_BYTES {
        return Err("work-map-v2 source carrier payload exceeds WorkMap V2 byte cap".to_owned());
    }
    Ok(WorkMapV2SourceCarrier {
        path: path.to_path_buf(),
        bytes,
        raw_work_map_payload: wire.raw_work_map_payload.into_bytes(),
    })
}

/// V2 link admission is bound to a durable atom registry rather than a caller
/// supplied set, so later image replay can perform the same link admission.
pub struct WorkMapV2AdmissionContext<'a> {
    pub atom_registry_path: &'a Path,
    pub atom_registry_digest: &'a str,
    /// Recovery is relative to a prior authenticated Core admission, never a
    /// caller-parsed model map.
    pub recovery_subject: Option<&'a ApprovedWorkMapV2>,
}

/// Strict V2 admission result. Its provenance and authority fields are private:
/// only accessors expose read-only facts to image persistence.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovedWorkMapV2 {
    // Retained only inside the sealed admission result. Recovery comparisons
    // use this authenticated source map rather than a caller-built parse.
    admitted_source_map: WorkMapV2,
    recovery_subject: Option<ApprovedWorkMapV2RecoverySubject>,
    source_carrier_path: PathBuf,
    source_carrier_sha256: String,
    source_raw_work_map_sha256: String,
    /// Present only for the strict actual planning carrier entry point. The old
    /// sidecar reader remains isolated for historical/direct fixture replay.
    source_actual_authority: Option<WorkMapV2ActualCarrierAuthority>,
    atom_registry_path: PathBuf,
    atom_registry_digest: String,
    units: Vec<allocation::ApprovedUnit>,
    vendoring: Vec<allocation::ApprovedUnitVendoringV2>,
    package_authority: Vec<allocation::ApprovedUnitPackageAuthorityV2>,
}

impl ApprovedWorkMapV2 {
    pub(crate) fn source_carrier_path(&self) -> &Path {
        &self.source_carrier_path
    }
    pub(crate) fn source_carrier_sha256(&self) -> &str {
        &self.source_carrier_sha256
    }
    pub(crate) fn source_raw_work_map_sha256(&self) -> &str {
        &self.source_raw_work_map_sha256
    }
    pub(crate) fn source_actual_authority(&self) -> Option<&WorkMapV2ActualCarrierAuthority> {
        self.source_actual_authority.as_ref()
    }
    pub(crate) fn atom_registry_path(&self) -> &Path {
        &self.atom_registry_path
    }
    pub(crate) fn atom_registry_digest(&self) -> &str {
        &self.atom_registry_digest
    }
    pub(crate) fn units(&self) -> &[allocation::ApprovedUnit] {
        &self.units
    }
    pub(crate) fn vendoring(&self) -> &[allocation::ApprovedUnitVendoringV2] {
        &self.vendoring
    }
    pub(crate) fn package_authority(&self) -> &[allocation::ApprovedUnitPackageAuthorityV2] {
        &self.package_authority
    }
    pub(crate) fn recovery_subject(&self) -> Option<&ApprovedWorkMapV2RecoverySubject> {
        self.recovery_subject.as_ref()
    }
    pub(crate) fn recovery_disposition(&self) -> Option<&kernel::generated::RecoveryDisposition> {
        self.admitted_source_map
            .recovery
            .as_ref()
            .map(|recovery| &recovery.disposition)
    }
}

/// Durable facts needed to replay a non-recursive authenticated recovery
/// subject. This is crate-private so only an admission can produce it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApprovedWorkMapV2RecoverySubject {
    pub(crate) source_carrier_path: PathBuf,
    pub(crate) source_carrier_sha256: String,
    pub(crate) source_raw_work_map_sha256: String,
    pub(crate) atom_registry_path: PathBuf,
    pub(crate) atom_registry_digest: String,
    pub(crate) source_actual_authority: Option<WorkMapV2ActualCarrierAuthority>,
}

/// Strict, non-routing Core consumer for `planning.work-map.v2`. Raw output is
/// accepted only when it byte-exactly matches an externally read carrier.
/// Production entry point after Core has strictly parsed the actual durable
/// planning carrier. `carrier_bytes` are sealed before this function parses
/// the terminal payload; they are not a model-authored sidecar.
/// Integration-only fixture entry point. Runtime promotion never reaches this
/// symbol: Core calls `admit_work_map_v2_verified_carrier` after it has checked
/// the issued binding/spec tuple.
#[doc(hidden)]
pub fn admit_work_map_v2_actual_carrier_for_test_only(
    carrier_path: &Path,
    context: WorkMapV2AdmissionContext<'_>,
) -> Result<ApprovedWorkMapV2, String> {
    let (source, _) = read_work_map_v2_actual_carrier_authority(carrier_path)?;
    let raw = source.raw_work_map_payload().to_vec();
    let bytes = source.raw_bytes().to_vec();
    admit_work_map_v2_verified_carrier(&raw, carrier_path, &bytes, context)
}

pub(crate) fn admit_work_map_v2_verified_carrier(
    raw: &[u8],
    carrier_path: &Path,
    carrier_bytes: &[u8],
    context: WorkMapV2AdmissionContext<'_>,
) -> Result<ApprovedWorkMapV2, String> {
    let (source, authority) = read_work_map_v2_actual_carrier_authority(carrier_path)?;
    if source.raw_bytes() != carrier_bytes || source.raw_work_map_payload() != raw {
        return Err("work-map-v2 actual carrier bytes/payload drift before admission".to_owned());
    }
    let mut approved = admit_work_map_v2(raw, &source, context)?;
    approved.source_actual_authority = Some(authority);
    Ok(approved)
}

pub fn admit_work_map_v2(
    raw: &[u8],
    source_carrier: &WorkMapV2SourceCarrier,
    context: WorkMapV2AdmissionContext<'_>,
) -> Result<ApprovedWorkMapV2, String> {
    validate_v2_artifact_confinement(source_carrier, &context)?;
    if raw.len() > kernel::generated::WORK_MAP_V2_MAX_BYTES {
        return Err(format!(
            "work-map-v2:raw artifact exceeds {} bytes: got {}",
            kernel::generated::WORK_MAP_V2_MAX_BYTES,
            raw.len()
        ));
    }
    if raw != source_carrier.raw_work_map_payload.as_slice() {
        return Err("work-map-v2 raw payload does not exactly match source carrier".to_owned());
    }
    let text = std::str::from_utf8(raw)
        .map_err(|error| format!("work-map-v2:raw artifact is not UTF-8: {error}"))?;
    let work_map: WorkMapV2 = serde_json::from_str(text)
        .map_err(|error| format!("work-map-v2:strict JSON parse: {error}"))?;
    if work_map.schema.0 != "planning.work-map.v2" {
        return Err(format!("work-map-v2:wrong schema {}", work_map.schema.0));
    }
    let atom_ids =
        load_v2_atom_registry_ids(context.atom_registry_path, context.atom_registry_digest)?;
    validate_work_map_v2_shape(&work_map, &atom_ids)?;
    let recovery_subject = if let Some(subject) = context.recovery_subject {
        validate_authenticated_recovery_subject(subject, &context)?;
        validate_work_map_v2_recovery(&work_map, &subject.admitted_source_map)?;
        Some(ApprovedWorkMapV2RecoverySubject {
            source_carrier_path: subject.source_carrier_path.clone(),
            source_carrier_sha256: subject.source_carrier_sha256.clone(),
            source_raw_work_map_sha256: subject.source_raw_work_map_sha256.clone(),
            atom_registry_path: subject.atom_registry_path.clone(),
            atom_registry_digest: subject.atom_registry_digest.clone(),
            source_actual_authority: subject.source_actual_authority.clone(),
        })
    } else {
        if work_map.recovery.is_some() {
            return Err(
                "work-map-v2:recovery evidence requires an authenticated prior V2 subject"
                    .to_owned(),
            );
        }
        None
    };
    let units = approved_units_from_work_map_v2(&work_map)?;
    let vendoring = vendoring_from_work_map_v2(&work_map)?;
    let package_authority = package_authority_from_work_map_v2(&work_map)?;
    allocation::validate_approved_v2_authority(&units, &vendoring, &package_authority)
        .map_err(|error| format!("work-map-v2:package authority: {error}"))?;
    Ok(ApprovedWorkMapV2 {
        admitted_source_map: work_map,
        recovery_subject,
        source_carrier_path: source_carrier.path.clone(),
        source_carrier_sha256: sha256_hex(&source_carrier.bytes),
        source_raw_work_map_sha256: sha256_hex(raw),
        source_actual_authority: None,
        atom_registry_path: context.atom_registry_path.to_path_buf(),
        atom_registry_digest: context.atom_registry_digest.to_owned(),
        units,
        vendoring,
        package_authority,
    })
}

fn validate_v2_artifact_confinement(
    source_carrier: &WorkMapV2SourceCarrier,
    context: &WorkMapV2AdmissionContext<'_>,
) -> Result<(), String> {
    let run_root = source_carrier
        .path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "work-map-v2 source carrier lacks run root".to_owned())?;
    for (path, label) in [
        (source_carrier.path.as_path(), "source carrier"),
        (context.atom_registry_path, "atom registry"),
    ] {
        if path == run_root || !path.starts_with(run_root) {
            return Err(format!("work-map-v2 {label} is outside the exact run root"));
        }
    }
    Ok(())
}

fn validate_authenticated_recovery_subject(
    subject: &ApprovedWorkMapV2,
    context: &WorkMapV2AdmissionContext<'_>,
) -> Result<(), String> {
    if subject.admitted_source_map.recovery.is_some() || subject.recovery_subject.is_some() {
        return Err(
            "work-map-v2:recovery subject must be an ordinary non-recovery admission".to_owned(),
        );
    }
    if subject.atom_registry_path != context.atom_registry_path
        || subject.atom_registry_digest != context.atom_registry_digest
    {
        return Err(
            "work-map-v2:recovery subject atom-registry authority differs from candidate"
                .to_owned(),
        );
    }
    Ok(())
}

fn validate_work_map_v2_shape(work_map: &WorkMapV2, atom_ids: &BTreeSet<Id>) -> Result<(), String> {
    validate_work_map_v2_string(&work_map.schema.0, 64, "schema")?;
    if !(1..=WORK_MAP_V2_MAX_UNITS).contains(&work_map.units.len()) {
        return Err(format!(
            "units must contain 1..={WORK_MAP_V2_MAX_UNITS} units, got {}",
            work_map.units.len()
        ));
    }
    let mut unit_ids = BTreeSet::new();
    let mut proof_ids = BTreeSet::new();
    let mut binding_ids = BTreeSet::new();
    let mut destinations = BTreeSet::new();
    let mut manifests = BTreeSet::new();
    let mut total_proofs = 0_usize;
    let mut total_bindings = 0_usize;
    for unit in &work_map.units {
        validate_work_map_v2_unit_id(&unit.id, "unit id")?;
        if unit.kind != PlanUnitKind::Implementation {
            return Err(format!("unit {} must have kind implementation", unit.id.0));
        }
        if !unit_ids.insert(unit.id.clone()) {
            return Err(format!("duplicate unit id {}", unit.id.0));
        }
        validate_work_map_v2_string(
            &unit.objective,
            WORK_MAP_V2_MAX_ITEM_BYTES,
            "unit objective",
        )?;
        validate_work_map_v2_list(unit.criteria.len(), 1, "criteria")?;
        for criterion in &unit.criteria {
            validate_work_map_v2_string(criterion, WORK_MAP_V2_MAX_ITEM_BYTES, "criterion")?;
        }
        validate_work_map_v2_list(unit.depends_on.len(), 0, "dependencies")?;
        let mut dependencies = BTreeSet::new();
        for dependency in &unit.depends_on {
            validate_work_map_v2_unit_id(dependency, "dependency id")?;
            if !dependencies.insert(dependency.clone()) {
                return Err(format!(
                    "unit {} has duplicate dependency {}",
                    unit.id.0, dependency.0
                ));
            }
        }
        validate_work_map_v2_list(unit.files.len(), 1, "files")?;
        for file in &unit.files {
            validate_work_map_v2_path(file, "unit file")?;
        }
        allocation::validate_exact_unit_file_authority(&unit.files)
            .map_err(|error| format!("unit {} exact file authority: {error}", unit.id.0))?;
        validate_work_map_v2_list(unit.package_scope_files.len(), 0, "package scope files")?;
        validate_work_map_v2_exact_paths(&unit.package_scope_files, true, "package scope file")?;
        validate_work_map_v2_list(unit.commands.len(), 1, "commands")?;
        for command in &unit.commands {
            validate_work_map_v2_command(command)?;
            validate_plan_unit_command_effect_authority(command)
                .map_err(|error| format!("unit {} command authority: {error}", unit.id.0))?;
        }
        validate_work_map_v2_list(unit.links.len(), 1, "links")?;
        let mut links = BTreeSet::new();
        for link in &unit.links {
            validate_work_map_v2_id(link, "atom link")?;
            if !links.insert(link.clone()) {
                return Err(format!(
                    "unit {} has duplicate atom link {}",
                    unit.id.0, link.0
                ));
            }
            if !atom_ids.contains(link) {
                return Err(format!(
                    "unit {} links unknown atom id {}",
                    unit.id.0, link.0
                ));
            }
        }
        validate_work_map_v2_list(unit.package_proofs.len(), 0, "package proofs")?;
        total_proofs = total_proofs
            .checked_add(unit.package_proofs.len())
            .ok_or_else(|| "package proof count overflow".to_owned())?;
        let mut vendor_proof_count = 0_usize;
        for proof in &unit.package_proofs {
            validate_work_map_v2_id(&proof.proof_id, "package proof id")?;
            if !proof_ids.insert(proof.proof_id.clone()) {
                return Err(format!("duplicate package proof id {}", proof.proof_id.0));
            }
            validate_work_map_v2_string(
                &proof.expected,
                WORK_MAP_V2_MAX_ITEM_BYTES,
                "package proof expected",
            )?;
            validate_work_map_v2_list(
                proof.criterion_ordinals.len(),
                1,
                "proof criterion ordinals",
            )?;
            let ordinals = proof
                .criterion_ordinals
                .iter()
                .copied()
                .collect::<BTreeSet<_>>();
            if ordinals.len() != proof.criterion_ordinals.len()
                || ordinals.iter().any(|ordinal| {
                    *ordinal == 0
                        || usize::try_from(*ordinal)
                            .map_or(true, |ordinal| ordinal > unit.criteria.len())
                })
            {
                return Err(format!(
                    "proof {} has duplicate, zero, or out-of-range criterion ordinal",
                    proof.proof_id.0
                ));
            }
            validate_work_map_v2_list(proof.vendor_binding_ids.len(), 0, "proof binding ids")?;
            if proof.vendor_binding_ids.len() > allocation::APPROVED_VENDOR_BINDINGS_V2_MAX {
                return Err(format!(
                    "proof {} vendor binding ids exceeds {}",
                    proof.proof_id.0,
                    allocation::APPROVED_VENDOR_BINDINGS_V2_MAX
                ));
            }
            let proof_binding_ids = proof
                .vendor_binding_ids
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            if proof_binding_ids.len() != proof.vendor_binding_ids.len() {
                return Err(format!(
                    "proof {} has duplicate vendor binding ids",
                    proof.proof_id.0
                ));
            }
            for binding_id in &proof.vendor_binding_ids {
                validate_work_map_v2_id(binding_id, "proof binding id")?;
            }
            match proof.kind {
                PackageProofKindV2::CleanExactPackageTip
                    if !proof.vendor_binding_ids.is_empty() =>
                {
                    return Err(format!(
                        "clean package proof {} must have empty vendor binding ids",
                        proof.proof_id.0
                    ));
                }
                PackageProofKindV2::CleanExactPackageTip => {}
                PackageProofKindV2::VendoredBytesMatchOrigin => vendor_proof_count += 1,
            }
        }
        validate_work_map_v2_list(unit.vendor_bindings.len(), 0, "vendor bindings")?;
        if unit.vendor_bindings.len() > allocation::APPROVED_VENDOR_BINDINGS_V2_MAX {
            return Err(format!(
                "unit {} vendor binding count exceeds {}",
                unit.id.0,
                allocation::APPROVED_VENDOR_BINDINGS_V2_MAX
            ));
        }
        total_bindings = total_bindings
            .checked_add(unit.vendor_bindings.len())
            .ok_or_else(|| "vendor binding count overflow".to_owned())?;
        let mut unit_binding_ids = BTreeSet::new();
        for binding in &unit.vendor_bindings {
            validate_work_map_v2_id(&binding.binding_id, "vendor binding id")?;
            if !unit_binding_ids.insert(binding.binding_id.clone())
                || !binding_ids.insert(binding.binding_id.clone())
            {
                return Err(format!(
                    "duplicate vendor binding id {}",
                    binding.binding_id.0
                ));
            }
            validate_work_map_v2_tsv_path(&binding.origin_path, "vendor origin path")?;
            validate_work_map_v2_tsv_path(&binding.destination, "vendor destination")?;
            if !unit.files.contains(&binding.destination) {
                return Err(format!(
                    "unit {} vendor destination {} is not an exact unit file",
                    unit.id.0, binding.destination.0
                ));
            }
            if !destinations.insert(binding.destination.0.clone()) {
                return Err(format!(
                    "duplicate vendor destination {}",
                    binding.destination.0
                ));
            }
        }
        let manifest = unit.provenance_manifest_destination.0.as_ref();
        if let Some(manifest) = manifest {
            validate_work_map_v2_tsv_path(manifest, "provenance manifest destination")?;
            if !unit.files.contains(manifest) {
                return Err(format!(
                    "unit {} manifest destination {} is not an exact unit file",
                    unit.id.0, manifest.0
                ));
            }
            if !manifests.insert(manifest.0.clone()) {
                return Err(format!(
                    "duplicate provenance manifest destination {}",
                    manifest.0
                ));
            }
        }
        // A vendor proof belongs to the final closure package-authority row,
        // not necessarily to this binding-owning unit. Global closure checks
        // run after source conversion with every row present.
        let _ = (vendor_proof_count, unit_binding_ids);
    }
    if total_proofs > allocation::APPROVED_PACKAGE_PROOFS_V2_MAX {
        return Err(format!(
            "total package proofs exceeds {}",
            allocation::APPROVED_PACKAGE_PROOFS_V2_MAX
        ));
    }
    if let Some(recovery) = &work_map.recovery {
        validate_work_map_v2_recovery_shape(recovery)?;
    }
    if total_bindings > allocation::APPROVED_VENDOR_BINDINGS_V2_MAX {
        return Err(format!(
            "total vendor bindings exceeds {}",
            allocation::APPROVED_VENDOR_BINDINGS_V2_MAX
        ));
    }
    validate_work_map_v2_graph(work_map, &unit_ids)?;
    validate_work_map_v2_raw_ownership_and_topology(work_map)?;
    Ok(())
}

/// Performs the V2-only ownership pass on raw vectors.  It intentionally runs
/// before any BTreeSet conversion so duplicate claims cannot disappear.
fn validate_work_map_v2_raw_ownership_and_topology(work_map: &WorkMapV2) -> Result<(), String> {
    let mut core_owner = BTreeMap::<&str, &Id>::new();
    let mut destinations = Vec::<(&Id, &str)>::new();
    let mut manifests = Vec::<(&Id, &str)>::new();
    let mut origins = Vec::<(&Id, &str)>::new();
    let mut generated = Vec::<(&Id, &str)>::new();
    for unit in &work_map.units {
        for binding in &unit.vendor_bindings {
            core_owner.insert(binding.destination.0.as_str(), &unit.id);
            destinations.push((&unit.id, binding.destination.0.as_str()));
            origins.push((&unit.id, binding.origin_path.0.as_str()));
        }
        if let Some(manifest) = &unit.provenance_manifest_destination.0 {
            core_owner.insert(manifest.0.as_str(), &unit.id);
            manifests.push((&unit.id, manifest.0.as_str()));
        }
        for command in &unit.commands {
            for path in &command.generated_paths {
                generated.push((&unit.id, path.0.as_str()));
            }
        }
    }

    let mut files = Vec::<(&Id, &str)>::new();
    for unit in &work_map.units {
        for file in &unit.files {
            for (owner, prior) in &files {
                if *owner == &unit.id {
                    continue;
                }
                if file.0 == *prior {
                    if core_owner
                        .get(file.0.as_str())
                        .is_some_and(|core| *core != &unit.id)
                    {
                        return Err(format!(
                            "unit {} claims Core-owned destination or manifest {} owned by unit {}",
                            unit.id.0,
                            file.0,
                            core_owner
                                .get(file.0.as_str())
                                .expect("Core owner was checked")
                                .0
                        ));
                    }
                    return Err(format!(
                        "duplicate exact V2 file ownership {} by units {} and {}",
                        file.0, owner.0, unit.id.0
                    ));
                }
                if allocation::path_authority_collides(&file.0, prior) {
                    return Err(format!(
                        "V2 file ownership ancestor collision {} (unit {}) and {} (unit {})",
                        file.0, unit.id.0, prior, owner.0
                    ));
                }
            }
            if let Some(core) = core_owner.get(file.0.as_str())
                && *core != &unit.id
            {
                return Err(format!(
                    "unit {} claims Core-owned destination or manifest {} owned by unit {}",
                    unit.id.0, file.0, core.0
                ));
            }
            files.push((&unit.id, file.0.as_str()));
        }
    }

    for (index, (_, path)) in generated.iter().enumerate() {
        if files
            .iter()
            .any(|(_, owner)| allocation::path_authority_collides(path, owner))
        {
            return Err(format!(
                "command generated path {path} overlaps implementation owner authority"
            ));
        }
        if generated
            .iter()
            .skip(index + 1)
            .any(|(_, other)| allocation::path_authority_collides(path, other))
        {
            return Err(format!(
                "command generated path {path} overlaps another generated path"
            ));
        }
    }

    for (_, destination) in &destinations {
        for (_, origin) in &origins {
            if allocation::path_authority_collides(destination, origin) {
                return Err(format!(
                    "vendor destination {destination} collides with origin {origin}"
                ));
            }
        }
        for (_, other) in &destinations {
            if destination != other && allocation::path_authority_collides(destination, other) {
                return Err(format!(
                    "vendor destinations collide: {destination} and {other}"
                ));
            }
        }
        for (_, manifest) in &manifests {
            if allocation::path_authority_collides(destination, manifest) {
                return Err(format!(
                    "vendor destination {destination} collides with provenance manifest {manifest}"
                ));
            }
        }
    }
    for (_, manifest) in &manifests {
        for (_, origin) in &origins {
            if allocation::path_authority_collides(manifest, origin) {
                return Err(format!(
                    "provenance manifest {manifest} collides with origin {origin}"
                ));
            }
        }
    }
    for (_, path) in &generated {
        for (_, protected) in destinations
            .iter()
            .chain(manifests.iter())
            .chain(origins.iter())
        {
            if allocation::path_authority_collides(path, protected) {
                return Err(format!(
                    "command generated path {path} overlaps Core-owned vendor, manifest, or origin path {protected}"
                ));
            }
        }
    }
    Ok(())
}

fn validate_work_map_v2_recovery_shape(
    recovery: &kernel::generated::WorkMapRecoveryV2,
) -> Result<(), String> {
    validate_work_map_v2_list(recovery.diagnosis_refs.len(), 0, "recovery diagnosis refs")?;
    validate_work_map_v2_string(
        &recovery.root_cause,
        WORK_MAP_V2_MAX_ITEM_BYTES,
        "recovery root cause",
    )?;
    validate_work_map_v2_list(
        recovery.affected_unit_ids.len(),
        0,
        "recovery affected unit ids",
    )?;
    validate_work_map_v2_list(recovery.actions.len(), 0, "recovery actions")?;
    validate_work_map_v2_list(
        recovery.preserved_authority.len(),
        0,
        "recovery preserved authority",
    )?;
    validate_work_map_v2_list(
        recovery.repair_evidence_refs.len(),
        0,
        "recovery repair evidence refs",
    )?;
    for reference in recovery
        .diagnosis_refs
        .iter()
        .chain(recovery.repair_evidence_refs.iter())
    {
        validate_work_map_v2_string(
            &reference.0,
            WORK_MAP_V2_MAX_ITEM_BYTES,
            "recovery evidence ref",
        )?;
    }
    for unit_id in &recovery.affected_unit_ids {
        validate_work_map_v2_id(unit_id, "recovery affected unit id")?;
    }
    for action in &recovery.actions {
        validate_work_map_v2_string(action, WORK_MAP_V2_MAX_ITEM_BYTES, "recovery action")?;
    }
    for preserved in &recovery.preserved_authority {
        validate_work_map_v2_string(
            preserved,
            WORK_MAP_V2_MAX_ITEM_BYTES,
            "recovery preserved authority",
        )?;
    }
    Ok(())
}

fn validate_work_map_v2_recovery(
    candidate: &WorkMapV2,
    original: &WorkMapV2,
) -> Result<(), String> {
    let recovery = candidate.recovery.as_ref().ok_or_else(|| {
        "recovery subject was supplied but candidate has no recovery evidence".to_owned()
    })?;
    if recovery.diagnosis_refs.is_empty()
        || recovery.root_cause.trim().is_empty()
        || recovery.actions.is_empty()
        || recovery.actions.iter().any(|value| value.trim().is_empty())
        || recovery.preserved_authority.is_empty()
        || recovery
            .preserved_authority
            .iter()
            .any(|value| value.trim().is_empty())
        || recovery.repair_evidence_refs.is_empty()
    {
        return Err(
            "recovery evidence has incomplete diagnosis/action/preservation fields".to_owned(),
        );
    }
    if candidate.units.len() != original.units.len() {
        return Err("recovery changed the V2 unit count".to_owned());
    }
    let declared = recovery
        .affected_unit_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if declared.len() != recovery.affected_unit_ids.len() {
        return Err("recovery duplicates affected unit ids".to_owned());
    }
    let mut changed = BTreeSet::new();
    for (before, after) in original.units.iter().zip(&candidate.units) {
        if before.id != after.id {
            return Err("recovery reordered or replaced V2 unit identity".to_owned());
        }
        if before != after {
            let mut objective_only = before.clone();
            objective_only.objective = after.objective.clone();
            if objective_only != *after {
                return Err(format!(
                    "recovery changed non-objective V2 authority for unit {}",
                    before.id.0
                ));
            }
            changed.insert(before.id.clone());
        }
    }
    use kernel::generated::RecoveryDisposition;
    match &recovery.disposition {
        RecoveryDisposition::Repaired if !changed.is_empty() && changed == declared => Ok(()),
        RecoveryDisposition::NoDefect
        | RecoveryDisposition::RequiresNewAuthority
        | RecoveryDisposition::InfrastructureBlocked
        | RecoveryDisposition::UnsafeBlocked
            if changed.is_empty() && declared.is_empty() =>
        {
            Ok(())
        }
        _ => Err("recovery disposition does not match exactly changed V2 units".to_owned()),
    }
}

fn validate_work_map_v2_graph(work_map: &WorkMapV2, unit_ids: &BTreeSet<Id>) -> Result<(), String> {
    let by_id = work_map
        .units
        .iter()
        .map(|unit| (unit.id.clone(), unit))
        .collect::<BTreeMap<_, _>>();
    for unit in &work_map.units {
        for dependency in &unit.depends_on {
            if dependency == &unit.id {
                return Err(format!("unit {} depends on itself", unit.id.0));
            }
            if !unit_ids.contains(dependency) {
                return Err(format!(
                    "unit {} depends on unknown unit {}",
                    unit.id.0, dependency.0
                ));
            }
        }
    }
    fn visit(
        id: &Id,
        by_id: &BTreeMap<Id, &kernel::generated::PlanUnitV2>,
        visiting: &mut BTreeSet<Id>,
        done: &mut BTreeSet<Id>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.clone()) {
            return Err(format!("work-map V2 dependency cycle at {}", id.0));
        }
        let unit = by_id
            .get(id)
            .ok_or_else(|| format!("unit {} missing during V2 graph walk", id.0))?;
        for dependency in &unit.depends_on {
            visit(dependency, by_id, visiting, done)?;
        }
        visiting.remove(id);
        done.insert(id.clone());
        Ok(())
    }
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for unit in &work_map.units {
        visit(&unit.id, &by_id, &mut visiting, &mut done)?;
    }
    Ok(())
}

fn approved_units_from_work_map_v2(
    work_map: &WorkMapV2,
) -> Result<Vec<allocation::ApprovedUnit>, String> {
    work_map
        .units
        .iter()
        .enumerate()
        .map(|(index, unit)| {
            let criteria = unit
                .criteria
                .iter()
                .enumerate()
                .map(|(criterion_index, _)| Id(format!("AC-{}-{}", unit.id.0, criterion_index + 1)))
                .collect::<Vec<_>>();
            for criterion in &criteria {
                validate_work_map_v2_id(criterion, "derived criterion id")?;
            }
            let criterion_text = criteria
                .iter()
                .cloned()
                .zip(unit.criteria.iter().cloned())
                .map(|(id, text)| allocation::ApprovedCriterion { id, text })
                .collect();
            // V2 package proofs are represented only in the explicit package
            // authority table; legacy ApprovedUnit.package_checks stays empty.
            let package_checks = Vec::new();
            let predecessor_forward_criteria = unit
                .depends_on
                .iter()
                .map(|dependency| Id(format!("unit-complete:{}", dependency.0)))
                .collect::<Vec<_>>();
            let downstream_release_edges = vec![Id(format!("unit:{}", unit.id.0))];
            for id in predecessor_forward_criteria
                .iter()
                .chain(downstream_release_edges.iter())
            {
                validate_work_map_v2_id(id, "derived V2 authority id")?;
            }
            Ok(allocation::ApprovedUnit {
                id: unit.id.clone(),
                kind: unit.kind.clone(),
                objective: unit.objective.clone(),
                operator_order: u32::try_from(index + 1)
                    .map_err(|_| "V2 operator order overflow".to_owned())?,
                decisions: unit.links.clone(),
                criteria,
                criterion_text,
                dependencies: unit.depends_on.clone(),
                predecessor_forward_criteria,
                downstream_release_edges,
                files: unit.files.clone(),
                commands: unit.commands.clone(),
                package_checks,
            })
        })
        .collect()
}

fn vendoring_from_work_map_v2(
    work_map: &WorkMapV2,
) -> Result<Vec<allocation::ApprovedUnitVendoringV2>, String> {
    let mut rows = Vec::with_capacity(work_map.units.len());
    for unit in &work_map.units {
        let mut bindings = unit
            .vendor_bindings
            .iter()
            .map(|binding| allocation::ApprovedVendorBindingV2 {
                binding_id: binding.binding_id.clone(),
                origin_path: binding.origin_path.clone(),
                destination: binding.destination.clone(),
            })
            .collect::<Vec<_>>();
        bindings.sort_by(|left, right| {
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
        rows.push(allocation::ApprovedUnitVendoringV2 {
            unit_id: unit.id.clone(),
            provenance_manifest_destination: unit.provenance_manifest_destination.0.clone(),
            vendor_bindings: bindings,
        });
    }
    Ok(rows)
}

fn package_authority_from_work_map_v2(
    work_map: &WorkMapV2,
) -> Result<Vec<allocation::ApprovedUnitPackageAuthorityV2>, String> {
    work_map
        .units
        .iter()
        .map(|unit| {
            let mut package_proofs = unit
                .package_proofs
                .iter()
                .cloned()
                .map(|proof| allocation::ApprovedPackageProofV2 {
                    proof_id: proof.proof_id,
                    kind: proof.kind,
                    criterion_ordinals: proof.criterion_ordinals,
                    expected: proof.expected,
                    vendor_binding_ids: proof.vendor_binding_ids,
                })
                .collect::<Vec<_>>();
            // Raw rows are validated for duplicate identities before this
            // point. Canonicalization is Core work, not an undocumented model
            // input-order requirement.
            package_proofs
                .sort_by(|left, right| left.proof_id.0.as_bytes().cmp(right.proof_id.0.as_bytes()));
            for proof in &mut package_proofs {
                proof.criterion_ordinals.sort_unstable();
                proof
                    .vendor_binding_ids
                    .sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            }
            let mut package_scope_files = unit.package_scope_files.clone();
            package_scope_files.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            Ok(allocation::ApprovedUnitPackageAuthorityV2 {
                unit_id: unit.id.clone(),
                package_scope_files,
                package_proofs,
            })
        })
        .collect()
}

fn load_v2_atom_registry_ids(path: &Path, expected_digest: &str) -> Result<BTreeSet<Id>, String> {
    reject_artifact_path(path, "atom registry")?;
    if expected_digest.len() != 64
        || !expected_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("work-map-v2 atom registry digest is malformed".to_owned());
    }
    let bytes = runner::read_bounded_authority_file(path, super::ATOM_REGISTRY_MAX_BYTES)
        .map_err(|error| format!("work-map-v2 atom registry read: {error}"))?;
    let actual = sha256_hex(&bytes);
    if actual != expected_digest {
        return Err(format!(
            "work-map-v2 atom registry digest drift: expected {expected_digest}, got {actual}"
        ));
    }
    let registry: PlanningAtomRegistry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("work-map-v2 atom registry JSON: {error}"))?;
    if registry.schema.0 != "autopilot.planning_atom_registry.v1" {
        return Err("work-map-v2 atom registry schema drift".to_owned());
    }
    let mut ids = BTreeSet::new();
    for atom in registry.atoms {
        validate_work_map_v2_id(&atom.id, "atom registry id")?;
        if !ids.insert(atom.id) {
            return Err("work-map-v2 atom registry has duplicate atom id".to_owned());
        }
    }
    Ok(ids)
}

fn reject_artifact_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "work-map-v2 {label} path must be absolute and contain no parent/current component"
        ));
    }
    Ok(())
}

fn validate_work_map_v2_exact_paths(
    paths: &[kernel::generated::Path],
    allow_empty: bool,
    label: &str,
) -> Result<(), String> {
    if paths.is_empty() && !allow_empty {
        return Err(format!("{label} authority is empty"));
    }
    let mut exact = BTreeSet::new();
    for path in paths {
        validate_work_map_v2_path(path, label)?;
        if !exact.insert(path.0.as_str()) {
            return Err(format!("duplicate {label} {}", path.0));
        }
    }
    for path in &exact {
        for (separator, _) in path.match_indices('/') {
            if exact.contains(&path[..separator]) {
                return Err(format!(
                    "{label} same-unit ancestor {} and {}",
                    &path[..separator],
                    path
                ));
            }
        }
    }
    Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_work_map_v2_list(length: usize, minimum: usize, label: &str) -> Result<(), String> {
    if length < minimum || length > WORK_MAP_V2_MAX_UNITS {
        return Err(format!(
            "{label} cardinality must be {minimum}..={WORK_MAP_V2_MAX_UNITS}, got {length}"
        ));
    }
    Ok(())
}

fn validate_work_map_v2_id(value: &Id, label: &str) -> Result<(), String> {
    validate_work_map_v2_authority_text(value.0.as_str(), 256, label)
}

fn validate_work_map_v2_unit_id(value: &Id, label: &str) -> Result<(), String> {
    validate_work_map_v2_authority_text(
        value.0.as_str(),
        WORK_MAP_V2_MAX_DERIVED_UNIT_ID_BYTES,
        label,
    )
}

fn validate_work_map_v2_path(value: &kernel::generated::Path, label: &str) -> Result<(), String> {
    if value.0.len() > WORK_MAP_V2_MAX_ITEM_BYTES
        || !value.0.is_ascii()
        || value.0.chars().any(char::is_control)
        || !allocation::approved_path_is_safe(value)
    {
        return Err(format!(
            "{label} must be a byte-bounded exact normalized path"
        ));
    }
    Ok(())
}

fn validate_work_map_v2_tsv_path(
    value: &kernel::generated::Path,
    label: &str,
) -> Result<(), String> {
    validate_work_map_v2_path(value, label)?;
    if value.0.contains('\t') || value.0.contains('\r') || value.0.contains('\n') {
        return Err(format!(
            "{label} contains TAB, CR, or LF and cannot be emitted in canonical TSV"
        ));
    }
    Ok(())
}

fn validate_work_map_v2_command(
    command: &kernel::generated::PlanUnitCommand,
) -> Result<(), String> {
    validate_work_map_v2_string(&command.command, 16 * 1024, "command")?;
    validate_work_map_v2_string(
        &command.expected,
        WORK_MAP_V2_MAX_ITEM_BYTES,
        "command expected",
    )?;
    validate_work_map_v2_string(
        &command.scope_preservation,
        WORK_MAP_V2_MAX_ITEM_BYTES,
        "command scope preservation",
    )?;
    validate_work_map_v2_list(command.generated_paths.len(), 0, "command generated paths")?;
    for path in &command.generated_paths {
        validate_work_map_v2_path(path, "command generated path")?;
    }
    Ok(())
}

fn validate_work_map_v2_authority_text(
    value: &str,
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > max_bytes
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{label} must be nonempty ASCII/control-free and at most {max_bytes} UTF-8 bytes"
        ));
    }
    Ok(())
}

fn validate_work_map_v2_string(value: &str, max_bytes: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(format!(
            "{label} must be nonempty and at most {max_bytes} UTF-8 bytes"
        ));
    }
    Ok(())
}
