use std::collections::{BTreeMap, BTreeSet};

use kernel::generated::PlanningAtomKind;

pub(crate) mod kdl;

use kdl::{blocks, one, values};

pub const ROLE_REGISTRY_KDL: &str = include_str!("../../../data/roles.kdl");
const DRIVER_TABLES_KDL: &str = include_str!("../../../data/driver-tables.kdl");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Role {
    pub id: String,
    pub version: u32,
    pub modes: Vec<String>,
    pub mode_parameters: Vec<String>,
    pub model_slot: String,
    pub thinking: String,
    pub tools: Vec<String>,
    pub repository: String,
    pub git: String,
    pub network: String,
    pub package_state: String,
    pub operator_checkout: String,
    pub context_policy: String,
    pub result_contract: String,
    pub checkpoint_contract: String,
    pub terminal_path: String,
    pub boundary_prompts: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleRegistry {
    roles: BTreeMap<String, Role>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleError {
    Malformed(String),
    Duplicate(String),
    Missing(String),
    EmptyModeParameter { role_id: String },
    DuplicateModeParameter { role_id: String, value: String },
    UnknownModeParameterMapping { parameter: String },
    MissingModeParameterMapping { parameter: String },
    InvalidPlanningAtomKind { parameter: String, value: String },
    ContextPolicy(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModeParameterAllocationError {
    ModeParameterCardinality {
        role_id: String,
        parameter_count: usize,
        assignment_count: usize,
    },
}

impl RoleRegistry {
    pub fn package() -> Result<Self, RoleError> {
        let registry = Self::parse(ROLE_REGISTRY_KDL)?;
        crate::context::policy::ContextPolicyRegistry::package()
            .map_err(|error| RoleError::ContextPolicy(format!("{error:?}")))?;
        Ok(registry)
    }

    pub fn parse(text: &str) -> Result<Self, RoleError> {
        let mut roles = BTreeMap::new();
        for block in blocks(text, "role").map_err(RoleError::Malformed)? {
            if one(&block.fields, "schema").map_err(RoleError::Malformed)? != "autopilot.role.v1" {
                return Err(RoleError::Malformed(format!("{}: bad schema", block.id)));
            }
            let role = Role {
                id: block.id.clone(),
                version: one(&block.fields, "version")
                    .map_err(RoleError::Malformed)?
                    .parse::<u32>()
                    .map_err(|_| RoleError::Malformed(format!("{}: bad version", block.id)))?,
                modes: values(&block.fields, "modes"),
                mode_parameters: values(&block.fields, "mode_parameters"),
                model_slot: one(&block.fields, "model_slot").map_err(RoleError::Malformed)?,
                thinking: one(&block.fields, "thinking").map_err(RoleError::Malformed)?,
                tools: values(&block.fields, "tools"),
                repository: one(&block.fields, "repository").map_err(RoleError::Malformed)?,
                git: one(&block.fields, "git").map_err(RoleError::Malformed)?,
                network: one(&block.fields, "network").map_err(RoleError::Malformed)?,
                package_state: one(&block.fields, "package_state").map_err(RoleError::Malformed)?,
                operator_checkout: one(&block.fields, "operator_checkout")
                    .map_err(RoleError::Malformed)?,
                context_policy: one(&block.fields, "context_policy")
                    .map_err(RoleError::Malformed)?,
                result_contract: one(&block.fields, "result_contract")
                    .map_err(RoleError::Malformed)?,
                checkpoint_contract: one(&block.fields, "checkpoint_contract")
                    .map_err(RoleError::Malformed)?,
                terminal_path: one(&block.fields, "terminal_path").map_err(RoleError::Malformed)?,
                boundary_prompts: values(&block.fields, "boundary_prompts"),
            };
            if role.version == 0 || role.modes.is_empty() {
                return Err(RoleError::Missing(role.id));
            }
            validate_mode_parameters(&role)?;
            if roles.insert(block.id.clone(), role).is_some() {
                return Err(RoleError::Duplicate(block.id));
            }
        }
        if roles.is_empty() {
            return Err(RoleError::Missing("roles".to_owned()));
        }
        let registry = Self { roles };
        validate_mode_parameter_atom_kind_table(&registry)?;
        Ok(registry)
    }

    pub fn get(&self, id: &str) -> Result<&Role, RoleError> {
        self.roles
            .get(id)
            .ok_or_else(|| RoleError::Missing(id.to_owned()))
    }

    pub fn roles(&self) -> impl Iterator<Item = &Role> {
        self.roles.values()
    }
}

pub fn allocate_mode_parameters(
    role: &Role,
    assignment_count: usize,
) -> Result<Vec<Option<String>>, ModeParameterAllocationError> {
    let parameter_count = role.mode_parameters.len();
    if parameter_count == 0 {
        return Ok(vec![None; assignment_count]);
    }
    if parameter_count == assignment_count {
        return Ok(role.mode_parameters.iter().cloned().map(Some).collect());
    }
    Err(ModeParameterAllocationError::ModeParameterCardinality {
        role_id: role.id.clone(),
        parameter_count,
        assignment_count,
    })
}

fn validate_mode_parameters(role: &Role) -> Result<(), RoleError> {
    let mut seen = BTreeSet::new();
    for value in &role.mode_parameters {
        if value.trim().is_empty() {
            return Err(RoleError::EmptyModeParameter {
                role_id: role.id.clone(),
            });
        }
        if !seen.insert(value.as_str()) {
            return Err(RoleError::DuplicateModeParameter {
                role_id: role.id.clone(),
                value: value.clone(),
            });
        }
    }
    Ok(())
}

fn validate_mode_parameter_atom_kind_table(registry: &RoleRegistry) -> Result<(), RoleError> {
    let mappings = parse_parameter_atom_kind_rows()?;
    let declared: BTreeSet<&str> = registry
        .roles()
        .flat_map(|role| role.mode_parameters.iter().map(String::as_str))
        .collect();
    for parameter in &declared {
        if !mappings.contains_key(*parameter) {
            return Err(RoleError::MissingModeParameterMapping {
                parameter: (*parameter).to_owned(),
            });
        }
    }
    for parameter in mappings.keys() {
        if !declared.contains(parameter.as_str()) {
            return Err(RoleError::UnknownModeParameterMapping {
                parameter: parameter.clone(),
            });
        }
    }
    Ok(())
}

fn parse_parameter_atom_kind_rows() -> Result<BTreeMap<String, PlanningAtomKind>, RoleError> {
    let mut rows = BTreeMap::new();
    let mut in_table = false;
    for raw in DRIVER_TABLES_KDL.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if !in_table {
            if line == "table \"planning.mode-parameter-atom-kind\" {" {
                in_table = true;
            }
            continue;
        }
        if line == "}" {
            break;
        }
        if !line.starts_with("row ") {
            return Err(RoleError::Malformed(format!(
                "planning.mode-parameter-atom-kind: expected row, got {line}"
            )));
        }
        let attrs = parse_row_attrs(line.trim_start_matches("row "))?;
        let parameter = attrs.get("parameter").cloned().ok_or_else(|| {
            RoleError::Malformed("mode parameter row missing parameter".to_owned())
        })?;
        let value = attrs.get("planning_atom_kind").cloned().ok_or_else(|| {
            RoleError::Malformed("mode parameter row missing planning_atom_kind".to_owned())
        })?;
        let encoded = serde_json::Value::String(value.clone()).to_string();
        let atom_kind = serde_json::from_str::<PlanningAtomKind>(&encoded).map_err(|_| {
            RoleError::InvalidPlanningAtomKind {
                parameter: parameter.clone(),
                value: value.clone(),
            }
        })?;
        if rows.insert(parameter.clone(), atom_kind).is_some() {
            return Err(RoleError::DuplicateModeParameter {
                role_id: "planning.mode-parameter-atom-kind".to_owned(),
                value: parameter,
            });
        }
    }
    if rows.is_empty() {
        return Err(RoleError::Malformed(
            "missing table planning.mode-parameter-atom-kind".to_owned(),
        ));
    }
    Ok(rows)
}

fn parse_row_attrs(text: &str) -> Result<BTreeMap<String, String>, RoleError> {
    let mut attrs = BTreeMap::new();
    for part in text.split_whitespace() {
        let (key, raw_value) = part
            .split_once('=')
            .ok_or_else(|| RoleError::Malformed(format!("bad row attribute {part}")))?;
        let value = raw_value.trim_matches('"');
        if value.is_empty() {
            return Err(RoleError::Malformed(format!("empty row attribute {key}")));
        }
        if attrs.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(RoleError::Malformed(format!(
                "duplicate row attribute {key}"
            )));
        }
    }
    Ok(attrs)
}
