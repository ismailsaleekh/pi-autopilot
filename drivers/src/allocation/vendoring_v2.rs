//! Version-isolated approved V2 vendoring, ownership, and package-closure authority.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use kernel::generated::{Id, PackageProofKindV2, Path as ContractPath};
use serde::{Deserialize, Serialize};

use super::ApprovedUnit;

pub const APPROVED_VENDOR_BINDINGS_V2_MAX: usize = 128;
pub const APPROVED_PACKAGE_PROOFS_V2_MAX: usize = 256;

/// Model-approved exact mapping. Core derives all source facts only after the
/// lane worktree exists; no planning-time repository fact is persisted here.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedVendorBindingV2 {
    pub binding_id: Id,
    pub origin_path: ContractPath,
    pub destination: ContractPath,
}

/// A full V2 package proof, deliberately kept outside legacy `ApprovedUnit`.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedPackageProofV2 {
    pub proof_id: Id,
    pub kind: PackageProofKindV2,
    pub criterion_ordinals: Vec<u32>,
    pub expected: String,
    pub vendor_binding_ids: Vec<Id>,
}

/// One vendoring row exists per unit, including a no-vendor row. Proofs do not
/// live here: a final closure may prove bindings owned by several units.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedUnitVendoringV2 {
    pub unit_id: Id,
    pub provenance_manifest_destination: Option<ContractPath>,
    pub vendor_bindings: Vec<ApprovedVendorBindingV2>,
}

/// One package authority row exists per unit, including empty rows.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedUnitPackageAuthorityV2 {
    pub unit_id: Id,
    pub package_scope_files: Vec<ContractPath>,
    pub package_proofs: Vec<ApprovedPackageProofV2>,
}

/// Legacy generic callers retain this helper. V2 callers additionally require
/// ASCII and no control characters through `validate_v2_path`.
pub fn approved_path_is_safe(path: &ContractPath) -> bool {
    let raw = path.0.as_str();
    !raw.is_empty()
        && raw.trim() == raw
        && !raw
            .chars()
            .any(|character| matches!(character, '\0' | '\\' | '*' | '?' | '[' | ']' | '{' | '}'))
        && !Path::new(raw).is_absolute()
        && raw.split('/').all(|component| {
            !component.is_empty()
                && component != "."
                && component != ".."
                && component != ".git"
                && component != ".pi"
        })
        && Path::new(raw)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

pub fn path_authority_collides(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// The common V2 source/image closure algorithm. It is intentionally run
/// against converted source rows and the persisted approved-image rows.
pub fn validate_approved_v2_authority(
    units: &[ApprovedUnit],
    vendoring: &[ApprovedUnitVendoringV2],
    package_authority: &[ApprovedUnitPackageAuthorityV2],
) -> Result<(), String> {
    if !(1..=256).contains(&units.len()) {
        return Err(format!(
            "V2 unit count must be 1..=256, got {}",
            units.len()
        ));
    }
    if vendoring.len() != units.len() || package_authority.len() != units.len() {
        return Err(
            "V2 vendoring and package-authority tables must each have one row per unit".to_owned(),
        );
    }
    let units_by_id = units
        .iter()
        .map(|unit| (unit.id.clone(), unit))
        .collect::<BTreeMap<_, _>>();
    if units_by_id.len() != units.len() {
        return Err("approved V2 units have duplicate ids".to_owned());
    }

    let mut owner_files = Vec::<(&Id, &str)>::new();
    for (index, unit) in units.iter().enumerate() {
        validate_common_approved_unit(unit, index, &units_by_id)?;
        for file in &unit.files {
            for (prior_owner, prior) in &owner_files {
                if file.0 == *prior || path_authority_collides(&file.0, prior) {
                    return Err(format!(
                        "V2 implementation ownership collision {} (unit {}) and {} (unit {})",
                        file.0, unit.id.0, prior, prior_owner.0
                    ));
                }
            }
            owner_files.push((&unit.id, &file.0));
        }
    }

    let mut vendor_rows = BTreeSet::new();
    let mut binding_ids = BTreeSet::new();
    let mut total_vendor_bindings = 0_usize;
    let mut destinations = Vec::<(&Id, &str)>::new();
    let mut manifests = Vec::<(&Id, &str)>::new();
    let mut origins = Vec::<(&Id, &str)>::new();
    for (row_index, row) in vendoring.iter().enumerate() {
        if row.unit_id != units[row_index].id {
            return Err("V2 vendoring rows must be in exact unit operator order".to_owned());
        }
        validate_v2_unit_id(&row.unit_id, "vendoring unit id")?;
        let unit = units_by_id
            .get(&row.unit_id)
            .ok_or_else(|| format!("vendoring row names unknown unit {}", row.unit_id.0))?;
        if !vendor_rows.insert(row.unit_id.clone()) {
            return Err(format!(
                "duplicate vendoring row for unit {}",
                row.unit_id.0
            ));
        }
        if row.vendor_bindings.len() > APPROVED_VENDOR_BINDINGS_V2_MAX {
            return Err(format!(
                "vendoring binding count exceeds {APPROVED_VENDOR_BINDINGS_V2_MAX}"
            ));
        }
        total_vendor_bindings = total_vendor_bindings
            .checked_add(row.vendor_bindings.len())
            .ok_or_else(|| "total V2 vendor binding count overflow".to_owned())?;
        match (
            &row.vendor_bindings[..],
            &row.provenance_manifest_destination,
        ) {
            ([], None) => {}
            ([], Some(_)) => {
                return Err("empty vendor bindings require null manifest destination".to_owned());
            }
            (_, None) => {
                return Err("nonempty vendor bindings require a manifest destination".to_owned());
            }
            (_, Some(manifest)) => {
                validate_v2_path(manifest, "provenance manifest destination")?;
                if !unit.files.contains(manifest) {
                    return Err(format!(
                        "unit {} manifest destination is not an exact implementation file",
                        unit.id.0
                    ));
                }
                if manifests.iter().any(|(_, other)| *other == manifest.0) {
                    return Err(format!(
                        "duplicate provenance manifest destination {}",
                        manifest.0
                    ));
                }
                manifests.push((&unit.id, &manifest.0));
            }
        }
        let mut previous = None::<(&[u8], &[u8], &[u8])>;
        for binding in &row.vendor_bindings {
            validate_v2_id(&binding.binding_id, "vendor binding id")?;
            validate_v2_path(&binding.origin_path, "vendor origin path")?;
            validate_v2_path(&binding.destination, "vendor destination")?;
            if !binding_ids.insert(binding.binding_id.clone()) {
                return Err(format!(
                    "duplicate vendor binding id {}",
                    binding.binding_id.0
                ));
            }
            if !unit.files.contains(&binding.destination) {
                return Err(format!(
                    "unit {} vendor destination is not an exact implementation file",
                    unit.id.0
                ));
            }
            let current = (
                binding.destination.0.as_bytes(),
                binding.origin_path.0.as_bytes(),
                binding.binding_id.0.as_bytes(),
            );
            if previous.is_some_and(|prior| prior > current) {
                return Err(
                    "vendor bindings are not in canonical destination/origin/id byte order"
                        .to_owned(),
                );
            }
            previous = Some(current);
            if destinations
                .iter()
                .any(|(_, other)| *other == binding.destination.0)
            {
                return Err(format!(
                    "duplicate vendor destination {}",
                    binding.destination.0
                ));
            }
            destinations.push((&unit.id, &binding.destination.0));
            origins.push((&unit.id, &binding.origin_path.0));
        }
    }
    if vendor_rows.len() != units.len() {
        return Err("vendoring rows are not one-to-one with approved units".to_owned());
    }
    if total_vendor_bindings > APPROVED_VENDOR_BINDINGS_V2_MAX {
        return Err(format!(
            "total vendor bindings exceeds {APPROVED_VENDOR_BINDINGS_V2_MAX}"
        ));
    }

    let mut package_rows = BTreeSet::new();
    let mut proofs = Vec::<(&Id, &ApprovedPackageProofV2)>::new();
    for (row_index, row) in package_authority.iter().enumerate() {
        if row.unit_id != units[row_index].id {
            return Err(
                "V2 package-authority rows must be in exact unit operator order".to_owned(),
            );
        }
        validate_v2_unit_id(&row.unit_id, "package-authority unit id")?;
        let unit = units_by_id
            .get(&row.unit_id)
            .ok_or_else(|| format!("package-authority row names unknown unit {}", row.unit_id.0))?;
        if !package_rows.insert(row.unit_id.clone()) {
            return Err(format!(
                "duplicate package-authority row for unit {}",
                row.unit_id.0
            ));
        }
        validate_exact_v2_paths(&row.package_scope_files, true, "package scope file")?;
        validate_canonical_path_order(&row.package_scope_files, "package scope files")?;
        validate_canonical_proof_order(&row.package_proofs)?;
        if row.package_proofs.len() > APPROVED_PACKAGE_PROOFS_V2_MAX {
            return Err(format!(
                "package proof count exceeds {APPROVED_PACKAGE_PROOFS_V2_MAX}"
            ));
        }
        for proof in &row.package_proofs {
            validate_proof(proof, unit.criterion_text.len())?;
            proofs.push((&row.unit_id, proof));
        }
    }
    if package_rows.len() != units.len() {
        return Err("package-authority rows are not one-to-one with approved units".to_owned());
    }
    if proofs.len() > APPROVED_PACKAGE_PROOFS_V2_MAX {
        return Err(format!(
            "total package proofs exceeds {APPROVED_PACKAGE_PROOFS_V2_MAX}"
        ));
    }
    let mut proof_ids = BTreeSet::new();
    for (_, proof) in &proofs {
        if !proof_ids.insert(proof.proof_id.clone()) {
            return Err(format!("duplicate package proof id {}", proof.proof_id.0));
        }
    }

    validate_approved_graph(units)?;
    validate_closure(units, package_authority, &proofs, &binding_ids)?;
    validate_core_and_origin_collisions(
        units,
        vendoring,
        package_authority,
        &destinations,
        &manifests,
        &origins,
    )?;
    Ok(())
}

fn validate_common_approved_unit(
    unit: &ApprovedUnit,
    index: usize,
    units_by_id: &BTreeMap<Id, &ApprovedUnit>,
) -> Result<(), String> {
    validate_v2_unit_id(&unit.id, "unit id")?;
    if unit.kind != kernel::generated::PlanUnitKind::Implementation
        || unit.operator_order
            != u32::try_from(index + 1).map_err(|_| "V2 operator order overflow".to_owned())?
        || !unit.package_checks.is_empty()
    {
        return Err(format!("malformed V2 implementation unit {}", unit.id.0));
    }
    validate_free_text(&unit.objective, 4096, "unit objective")?;
    validate_id_list(&unit.decisions, 1, "unit atom links")?;
    if unit.criteria.is_empty()
        || unit.criteria.len() > 256
        || unit.criteria.len() != unit.criterion_text.len()
    {
        return Err(format!("unit {} has malformed V2 criteria", unit.id.0));
    }
    for (ordinal, (criterion_id, criterion)) in
        unit.criteria.iter().zip(&unit.criterion_text).enumerate()
    {
        let expected = Id(format!("AC-{}-{}", unit.id.0, ordinal + 1));
        if *criterion_id != expected || criterion.id != expected {
            return Err(format!("unit {} has derived criterion id drift", unit.id.0));
        }
        validate_v2_id(criterion_id, "derived criterion id")?;
        validate_free_text(&criterion.text, 4096, "criterion text")?;
    }
    if unit.dependencies.len() > 256 {
        return Err(format!("unit {} has too many dependencies", unit.id.0));
    }
    let mut dependencies = BTreeSet::new();
    for dependency in &unit.dependencies {
        validate_v2_unit_id(dependency, "dependency id")?;
        if dependency == &unit.id
            || !units_by_id.contains_key(dependency)
            || !dependencies.insert(dependency)
        {
            return Err(format!(
                "unit {} has duplicate, self, or unknown dependency",
                unit.id.0
            ));
        }
    }
    let expected_predecessors = unit
        .dependencies
        .iter()
        .map(|dependency| Id(format!("unit-complete:{}", dependency.0)))
        .collect::<Vec<_>>();
    let expected_release = vec![Id(format!("unit:{}", unit.id.0))];
    if unit.predecessor_forward_criteria != expected_predecessors
        || unit.downstream_release_edges != expected_release
    {
        return Err(format!(
            "unit {} has derived dependency authority drift",
            unit.id.0
        ));
    }
    for id in expected_predecessors.iter().chain(expected_release.iter()) {
        validate_v2_id(id, "derived dependency authority id")?;
    }
    validate_exact_v2_paths(&unit.files, false, "unit file")?;
    if unit.commands.is_empty() || unit.commands.len() > 256 {
        return Err(format!("unit {} has malformed V2 commands", unit.id.0));
    }
    for command in &unit.commands {
        validate_free_text(&command.command, 16 * 1024, "command")?;
        validate_free_text(&command.expected, 4096, "command expected")?;
        validate_free_text(
            &command.scope_preservation,
            4096,
            "command scope preservation",
        )?;
        if command.generated_paths.len() > 256 {
            return Err("command generated path count exceeds 256".to_owned());
        }
        validate_exact_v2_paths(&command.generated_paths, true, "command generated path")?;
        super::validate_plan_unit_command_effect_authority(command)?;
    }
    Ok(())
}

fn validate_id_list(ids: &[Id], minimum: usize, label: &str) -> Result<(), String> {
    if ids.len() < minimum || ids.len() > 256 {
        return Err(format!("{label} cardinality is malformed"));
    }
    let mut seen = BTreeSet::new();
    for id in ids {
        validate_v2_id(id, label)?;
        if !seen.insert(id) {
            return Err(format!("{label} contains duplicate id {}", id.0));
        }
    }
    Ok(())
}

fn validate_canonical_path_order(paths: &[ContractPath], label: &str) -> Result<(), String> {
    if paths
        .windows(2)
        .any(|pair| pair[0].0.as_bytes() >= pair[1].0.as_bytes())
    {
        return Err(format!("{label} are not in canonical byte order"));
    }
    Ok(())
}

fn validate_canonical_proof_order(proofs: &[ApprovedPackageProofV2]) -> Result<(), String> {
    if proofs
        .windows(2)
        .any(|pair| pair[0].proof_id.0.as_bytes() >= pair[1].proof_id.0.as_bytes())
    {
        return Err("package proofs are not in canonical proof-id byte order".to_owned());
    }
    for proof in proofs {
        if proof
            .criterion_ordinals
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        {
            return Err(format!(
                "proof {} criterion ordinals are not canonical",
                proof.proof_id.0
            ));
        }
        if proof
            .vendor_binding_ids
            .windows(2)
            .any(|pair| pair[0].0.as_bytes() >= pair[1].0.as_bytes())
        {
            return Err(format!(
                "proof {} binding ids are not canonical",
                proof.proof_id.0
            ));
        }
    }
    Ok(())
}

fn validate_approved_graph(units: &[ApprovedUnit]) -> Result<(), String> {
    let by_id = units
        .iter()
        .map(|unit| (unit.id.clone(), unit))
        .collect::<BTreeMap<_, _>>();
    fn visit(
        id: &Id,
        by_id: &BTreeMap<Id, &ApprovedUnit>,
        active: &mut BTreeSet<Id>,
        done: &mut BTreeSet<Id>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !active.insert(id.clone()) {
            return Err(format!("approved V2 dependency cycle at {}", id.0));
        }
        let unit = by_id
            .get(id)
            .ok_or_else(|| format!("approved V2 unknown unit {}", id.0))?;
        for dependency in &unit.dependencies {
            visit(dependency, by_id, active, done)?;
        }
        active.remove(id);
        done.insert(id.clone());
        Ok(())
    }
    let mut active = BTreeSet::new();
    let mut done = BTreeSet::new();
    for unit in units {
        visit(&unit.id, &by_id, &mut active, &mut done)?;
    }
    Ok(())
}

fn validate_closure(
    units: &[ApprovedUnit],
    package_rows: &[ApprovedUnitPackageAuthorityV2],
    proofs: &[(&Id, &ApprovedPackageProofV2)],
    global_binding_ids: &BTreeSet<Id>,
) -> Result<(), String> {
    let has_vendor = !global_binding_ids.is_empty();
    if proofs.is_empty() && !has_vendor {
        if package_rows
            .iter()
            .any(|row| !row.package_scope_files.is_empty())
        {
            return Err("zero-closure V2 maps require every package scope to be empty".to_owned());
        }
        return Ok(());
    }
    let closure_ids = package_rows
        .iter()
        .filter(|row| !row.package_proofs.is_empty())
        .map(|row| row.unit_id.clone())
        .collect::<Vec<_>>();
    if closure_ids.len() != 1 {
        return Err("proof or vendor binding requires exactly one closure unit".to_owned());
    }
    let closure_id = &closure_ids[0];
    let closure = package_rows
        .iter()
        .find(|row| &row.unit_id == closure_id)
        .expect("closure id came from package rows");
    let owners = units
        .iter()
        .flat_map(|unit| unit.files.iter().map(|path| path.0.as_str()))
        .collect::<BTreeSet<_>>();
    let scope = closure
        .package_scope_files
        .iter()
        .map(|path| path.0.as_str())
        .collect::<BTreeSet<_>>();
    if scope != owners {
        return Err(
            "closure package scope must exactly equal global implementation owner leaves"
                .to_owned(),
        );
    }
    if package_rows
        .iter()
        .any(|row| row.unit_id != *closure_id && !row.package_scope_files.is_empty())
    {
        return Err("every nonclosure package scope must be empty".to_owned());
    }
    let closure_unit = units
        .iter()
        .find(|unit| unit.id == *closure_id)
        .expect("package row unit was checked");
    let reachable = transitive_dependencies(closure_unit, units)?;
    if units
        .iter()
        .any(|unit| unit.id != *closure_id && !reachable.contains(&unit.id))
    {
        return Err(format!(
            "closure unit {} does not transitively depend on every other unit",
            closure_id.0
        ));
    }
    let vendor_proofs = closure
        .package_proofs
        .iter()
        .filter(|proof| proof.kind == PackageProofKindV2::VendoredBytesMatchOrigin)
        .collect::<Vec<_>>();
    match (has_vendor, vendor_proofs.as_slice()) {
        (false, []) => {}
        (false, _) => return Err("vendor proof exists without global vendor bindings".to_owned()),
        (true, [proof]) => {
            let ids = proof
                .vendor_binding_ids
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            if ids != *global_binding_ids || ids.len() != proof.vendor_binding_ids.len() {
                return Err(
                    "global vendor proof binding ids must exactly equal all vendor bindings"
                        .to_owned(),
                );
            }
        }
        (true, _) => {
            return Err(
                "global vendor bindings require exactly one vendor proof on closure unit"
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn transitive_dependencies(
    unit: &ApprovedUnit,
    units: &[ApprovedUnit],
) -> Result<BTreeSet<Id>, String> {
    let by_id = units
        .iter()
        .map(|item| (item.id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    let mut found = BTreeSet::new();
    let mut todo = unit.dependencies.clone();
    while let Some(id) = todo.pop() {
        if !found.insert(id.clone()) {
            continue;
        }
        let dependency = by_id
            .get(&id)
            .ok_or_else(|| format!("unit {} depends on unknown unit {}", unit.id.0, id.0))?;
        todo.extend(dependency.dependencies.iter().cloned());
    }
    Ok(found)
}

fn validate_core_and_origin_collisions(
    units: &[ApprovedUnit],
    vendoring: &[ApprovedUnitVendoringV2],
    package_rows: &[ApprovedUnitPackageAuthorityV2],
    destinations: &[(&Id, &str)],
    manifests: &[(&Id, &str)],
    origins: &[(&Id, &str)],
) -> Result<(), String> {
    let owner_files = units
        .iter()
        .flat_map(|unit| {
            unit.files
                .iter()
                .map(move |file| (&unit.id, file.0.as_str()))
        })
        .collect::<Vec<_>>();
    let generated = units
        .iter()
        .flat_map(|unit| {
            unit.commands.iter().flat_map(move |command| {
                command
                    .generated_paths
                    .iter()
                    .map(move |path| (&unit.id, path.0.as_str()))
            })
        })
        .collect::<Vec<_>>();
    for (index, (unit, path)) in generated.iter().enumerate() {
        if owner_files
            .iter()
            .any(|(_, owner)| path_authority_collides(path, owner))
        {
            return Err(format!(
                "command generated path {path} overlaps implementation owner authority"
            ));
        }
        if generated
            .iter()
            .skip(index + 1)
            .any(|(_, other)| path_authority_collides(path, other))
        {
            return Err(format!(
                "command generated path {path} overlaps another generated path"
            ));
        }
        let _ = unit;
    }
    for unit in units {
        for command in &unit.commands {
            for generated in &command.generated_paths {
                validate_v2_path(generated, "command generated path")?;
                if origins
                    .iter()
                    .chain(destinations)
                    .chain(manifests)
                    .any(|(_, protected)| path_authority_collides(&generated.0, protected))
                {
                    return Err(format!(
                        "command generated path {} overlaps Core-owned vendor, manifest, or origin path",
                        generated.0
                    ));
                }
            }
        }
        for file in &unit.files {
            for (_, origin) in origins {
                if path_authority_collides(&file.0, origin) {
                    return Err(format!(
                        "ordinary file {} collides with immutable origin {origin}",
                        file.0
                    ));
                }
            }
            for (owner, destination) in destinations.iter().chain(manifests) {
                if path_authority_collides(&file.0, destination) && *owner != &unit.id {
                    return Err(format!(
                        "unit {} claims Core-owned destination or manifest {} owned by unit {}",
                        unit.id.0, file.0, owner.0
                    ));
                }
            }
        }
    }
    for row in package_rows {
        for file in &row.package_scope_files {
            for (_, origin) in origins {
                if path_authority_collides(&file.0, origin) {
                    return Err(format!(
                        "package scope file {} collides with immutable origin {origin}",
                        file.0
                    ));
                }
            }
        }
    }
    for (_, destination) in destinations {
        for (_, origin) in origins {
            if path_authority_collides(destination, origin) {
                return Err(format!(
                    "vendor destination {destination} collides with origin {origin}"
                ));
            }
        }
        for (_, manifest) in manifests {
            if path_authority_collides(destination, manifest) {
                return Err(format!(
                    "vendor destination {destination} collides with provenance manifest {manifest}"
                ));
            }
        }
    }
    for (_, manifest) in manifests {
        for (_, origin) in origins {
            if path_authority_collides(manifest, origin) {
                return Err(format!(
                    "provenance manifest {manifest} collides with origin {origin}"
                ));
            }
        }
    }
    // Retain the argument in the signature to make the ownership source clear
    // to reviewers and prevent an accidental validation split.
    let _ = vendoring;
    Ok(())
}

fn validate_proof(proof: &ApprovedPackageProofV2, criterion_count: usize) -> Result<(), String> {
    validate_v2_id(&proof.proof_id, "package proof id")?;
    validate_free_text(&proof.expected, 4096, "package proof expected")?;
    if proof.criterion_ordinals.is_empty()
        || proof.criterion_ordinals.len() > 256
        || proof
            .criterion_ordinals
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .len()
            != proof.criterion_ordinals.len()
        || proof.criterion_ordinals.iter().any(|ordinal| {
            *ordinal == 0 || usize::try_from(*ordinal).map_or(true, |value| value > criterion_count)
        })
    {
        return Err(format!(
            "proof {} has duplicate, zero, or out-of-range criterion ordinal",
            proof.proof_id.0
        ));
    }
    if proof.vendor_binding_ids.len() > APPROVED_VENDOR_BINDINGS_V2_MAX
        || proof
            .vendor_binding_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .len()
            != proof.vendor_binding_ids.len()
    {
        return Err(format!(
            "proof {} has duplicate or excessive vendor binding ids",
            proof.proof_id.0
        ));
    }
    for id in &proof.vendor_binding_ids {
        validate_v2_id(id, "proof binding id")?;
    }
    if proof.kind == PackageProofKindV2::CleanExactPackageTip
        && !proof.vendor_binding_ids.is_empty()
    {
        return Err(format!(
            "clean package proof {} must have empty vendor binding ids",
            proof.proof_id.0
        ));
    }
    Ok(())
}

fn validate_exact_v2_paths(
    paths: &[ContractPath],
    allow_empty: bool,
    label: &str,
) -> Result<(), String> {
    if paths.is_empty() && !allow_empty {
        return Err(format!("{label} authority must not be empty"));
    }
    if paths.len() > 256 {
        return Err(format!("{label} authority exceeds 256 exact paths"));
    }
    let mut exact = BTreeSet::new();
    for path in paths {
        validate_v2_path(path, label)?;
        if !exact.insert(path.0.as_str()) {
            return Err(format!("{label} has duplicate exact path {}", path.0));
        }
    }
    for path in &exact {
        for (separator, _) in path.match_indices('/') {
            if exact.contains(&path[..separator]) {
                return Err(format!(
                    "{label} has same-unit ancestor authority {} and {}",
                    &path[..separator],
                    path
                ));
            }
        }
    }
    Ok(())
}

fn validate_v2_unit_id(id: &Id, label: &str) -> Result<(), String> {
    validate_v2_text(&id.0, 242, label)
}

fn validate_v2_id(id: &Id, label: &str) -> Result<(), String> {
    validate_v2_text(&id.0, 256, label)
}

fn validate_v2_path(path: &ContractPath, label: &str) -> Result<(), String> {
    if path.0.len() > 4096
        || !path.0.is_ascii()
        || path.0.chars().any(char::is_control)
        || !approved_path_is_safe(path)
    {
        return Err(format!(
            "{label} is not an ASCII, control-free exact normalized path"
        ));
    }
    Ok(())
}

fn validate_v2_text(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > maximum
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{label} must be nonempty ASCII/control-free and at most {maximum} UTF-8 bytes"
        ));
    }
    Ok(())
}

fn validate_free_text(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > maximum {
        return Err(format!(
            "{label} must be nonempty and at most {maximum} UTF-8 bytes"
        ));
    }
    Ok(())
}
