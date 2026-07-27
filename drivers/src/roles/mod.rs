use std::collections::BTreeMap;

pub(crate) mod kdl;

use kdl::{blocks, one, values};

pub const ROLE_REGISTRY_KDL: &str = include_str!("../../../data/roles.kdl");

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
}

impl RoleRegistry {
    pub fn package() -> Result<Self, RoleError> {
        Self::parse(ROLE_REGISTRY_KDL)
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
            if roles.insert(block.id.clone(), role).is_some() {
                return Err(RoleError::Duplicate(block.id));
            }
        }
        if roles.is_empty() {
            return Err(RoleError::Missing("roles".to_owned()));
        }
        Ok(Self { roles })
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
