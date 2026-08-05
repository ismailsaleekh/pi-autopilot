use std::collections::{BTreeMap, BTreeSet};

use crate::roles::{ROLE_REGISTRY_KDL, RoleError, RoleRegistry};

pub const CONTEXT_POLICY_KDL: &str = include_str!("../../../data/context-policy.kdl");

const SCHEMA: &str = "autopilot.context_policy.v1";
const REVISION: u32 = 3;
const TIERS: [&str; 4] = [
    "mandatory_inline",
    "required_reads",
    "on_demand",
    "excluded",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPolicyCategory {
    pub id: String,
    pub source: String,
    pub class: String,
    pub boundary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPolicyMode {
    pub id: String,
    pub mandatory_inline: Vec<String>,
    pub required_reads: Vec<String>,
    pub on_demand: Vec<String>,
    pub excluded: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPolicy {
    pub id: String,
    pub role_id: String,
    pub modes: BTreeMap<String, ContextPolicyMode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPolicyRegistry {
    categories: BTreeMap<String, ContextPolicyCategory>,
    policies: BTreeMap<String, ContextPolicy>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextPolicyError {
    Malformed(String),
    Role(RoleError),
    DuplicateCategory(String),
    DuplicatePolicy(String),
    DuplicateMode {
        policy_id: String,
        mode_id: String,
    },
    DuplicateTierEntry {
        policy_id: String,
        mode_id: String,
        tier: String,
        category_id: String,
    },
    UnknownCategory {
        policy_id: String,
        mode_id: String,
        tier: String,
        category_id: String,
    },
    MissingPolicy(String),
    UnknownRole {
        policy_id: String,
        role_id: String,
    },
    RoleMismatch {
        policy_id: String,
        expected_role: String,
        actual_role: String,
    },
    MissingMode {
        policy_id: String,
        mode_id: String,
    },
    UnknownMode {
        policy_id: String,
        mode_id: String,
    },
}

impl ContextPolicyRegistry {
    pub fn package() -> Result<Self, ContextPolicyError> {
        let roles = RoleRegistry::parse(ROLE_REGISTRY_KDL).map_err(ContextPolicyError::Role)?;
        Self::package_for_roles(&roles)
    }

    pub(crate) fn package_for_roles(roles: &RoleRegistry) -> Result<Self, ContextPolicyError> {
        let registry = Self::parse(CONTEXT_POLICY_KDL)?;
        registry.validate_roles(roles)?;
        Ok(registry)
    }

    pub fn parse(text: &str) -> Result<Self, ContextPolicyError> {
        let lines = parse_lines(text);
        let header = lines.first().ok_or_else(|| {
            ContextPolicyError::Malformed("missing context_policy root".to_owned())
        })?;
        if !header.starts_with("context_policy ") || !header.ends_with('{') {
            return Err(ContextPolicyError::Malformed(
                "root must be context_policy ... {".to_owned(),
            ));
        }
        let root_attrs = parse_attrs(
            header
                .trim_start_matches("context_policy")
                .trim_end_matches('{'),
        )?;
        require_attr(&root_attrs, "schema", SCHEMA)?;
        let revision = attr_required(&root_attrs, "revision")?
            .parse::<u32>()
            .map_err(|_| ContextPolicyError::Malformed("revision must be a u32".to_owned()))?;
        if revision != REVISION {
            return Err(ContextPolicyError::Malformed(format!(
                "unsupported revision {revision}; expected {REVISION}"
            )));
        }

        let mut categories = BTreeMap::new();
        let mut policies = BTreeMap::new();
        let mut index = 1;
        while index < lines.len() {
            let line = &lines[index];
            if line == "}" {
                if index + 1 == lines.len() {
                    break;
                }
                return Err(ContextPolicyError::Malformed(
                    "content after context_policy close".to_owned(),
                ));
            }
            if line.starts_with("category ") {
                let category = parse_category(line)?;
                if categories.insert(category.id.clone(), category).is_some() {
                    return Err(ContextPolicyError::DuplicateCategory(attr_required(
                        &parse_attrs(line.trim_start_matches("category"))?,
                        "id",
                    )?));
                }
                index += 1;
            } else if line.starts_with("policy ") {
                let (policy, next) = parse_policy(&lines, index, &categories)?;
                if policies.insert(policy.id.clone(), policy).is_some() {
                    return Err(ContextPolicyError::DuplicatePolicy(attr_required(
                        &parse_attrs(line.trim_start_matches("policy").trim_end_matches('{'))?,
                        "id",
                    )?));
                }
                index = next;
            } else {
                return Err(ContextPolicyError::Malformed(format!(
                    "unexpected line in registry: {line}"
                )));
            }
        }
        if categories.is_empty() {
            return Err(ContextPolicyError::Malformed(
                "no context categories declared".to_owned(),
            ));
        }
        if policies.is_empty() {
            return Err(ContextPolicyError::Malformed(
                "no context policies declared".to_owned(),
            ));
        }
        Ok(Self {
            categories,
            policies,
        })
    }

    pub fn validate_roles(&self, roles: &RoleRegistry) -> Result<(), ContextPolicyError> {
        for role in roles.roles() {
            let policy = self
                .policies
                .get(&role.context_policy)
                .ok_or_else(|| ContextPolicyError::MissingPolicy(role.context_policy.clone()))?;
            if policy.role_id != role.id {
                return Err(ContextPolicyError::RoleMismatch {
                    policy_id: policy.id.clone(),
                    expected_role: role.id.clone(),
                    actual_role: policy.role_id.clone(),
                });
            }
            let mut seen = BTreeSet::new();
            for mode in &role.modes {
                if !policy.modes.contains_key(mode) {
                    return Err(ContextPolicyError::MissingMode {
                        policy_id: policy.id.clone(),
                        mode_id: mode.clone(),
                    });
                }
                seen.insert(mode.as_str());
            }
            for mode_id in policy.modes.keys() {
                if !seen.contains(mode_id.as_str()) {
                    return Err(ContextPolicyError::UnknownMode {
                        policy_id: policy.id.clone(),
                        mode_id: mode_id.clone(),
                    });
                }
            }
        }
        let role_ids: BTreeSet<&str> = roles.roles().map(|role| role.id.as_str()).collect();
        for policy in self.policies.values() {
            if !role_ids.contains(policy.role_id.as_str()) {
                return Err(ContextPolicyError::UnknownRole {
                    policy_id: policy.id.clone(),
                    role_id: policy.role_id.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn policy(&self, id: &str) -> Result<&ContextPolicy, ContextPolicyError> {
        self.policies
            .get(id)
            .ok_or_else(|| ContextPolicyError::MissingPolicy(id.to_owned()))
    }

    pub fn category(&self, id: &str) -> Result<&ContextPolicyCategory, ContextPolicyError> {
        self.categories
            .get(id)
            .ok_or_else(|| ContextPolicyError::UnknownCategory {
                policy_id: "<lookup>".to_owned(),
                mode_id: "<lookup>".to_owned(),
                tier: "<lookup>".to_owned(),
                category_id: id.to_owned(),
            })
    }
}

fn parse_policy(
    lines: &[String],
    start: usize,
    categories: &BTreeMap<String, ContextPolicyCategory>,
) -> Result<(ContextPolicy, usize), ContextPolicyError> {
    let header = &lines[start];
    if !header.ends_with('{') {
        return Err(ContextPolicyError::Malformed(format!(
            "policy header must end with '{{': {header}"
        )));
    }
    let attrs = parse_attrs(header.trim_start_matches("policy").trim_end_matches('{'))?;
    let policy_id = attr_required(&attrs, "id")?;
    let role_id = attr_required(&attrs, "role")?;
    let mut modes = BTreeMap::new();
    let mut index = start + 1;
    while index < lines.len() {
        let line = &lines[index];
        if line == "}" {
            if modes.is_empty() {
                return Err(ContextPolicyError::Malformed(format!(
                    "policy {policy_id}: no modes"
                )));
            }
            return Ok((
                ContextPolicy {
                    id: policy_id,
                    role_id,
                    modes,
                },
                index + 1,
            ));
        }
        if !line.starts_with("mode ") {
            return Err(ContextPolicyError::Malformed(format!(
                "policy {policy_id}: expected mode, got {line}"
            )));
        }
        let (mode, next) = parse_mode(lines, index, &policy_id, categories)?;
        if modes.insert(mode.id.clone(), mode).is_some() {
            return Err(ContextPolicyError::DuplicateMode {
                policy_id: policy_id.clone(),
                mode_id: attr_required(
                    &parse_attrs(line.trim_start_matches("mode").trim_end_matches('{'))?,
                    "id",
                )?,
            });
        }
        index = next;
    }
    Err(ContextPolicyError::Malformed(format!(
        "policy {policy_id}: missing close"
    )))
}

fn parse_mode(
    lines: &[String],
    start: usize,
    policy_id: &str,
    categories: &BTreeMap<String, ContextPolicyCategory>,
) -> Result<(ContextPolicyMode, usize), ContextPolicyError> {
    let header = &lines[start];
    if !header.ends_with('{') {
        return Err(ContextPolicyError::Malformed(format!(
            "mode header must end with '{{': {header}"
        )));
    }
    let attrs = parse_attrs(header.trim_start_matches("mode").trim_end_matches('{'))?;
    let mode_id = attr_required(&attrs, "id")?;
    let mut mandatory_inline = Vec::new();
    let mut required_reads = Vec::new();
    let mut on_demand = Vec::new();
    let mut excluded = Vec::new();
    let mut seen = BTreeSet::new();
    let mut index = start + 1;
    while index < lines.len() {
        let line = &lines[index];
        if line == "}" {
            return Ok((
                ContextPolicyMode {
                    id: mode_id,
                    mandatory_inline,
                    required_reads,
                    on_demand,
                    excluded,
                },
                index + 1,
            ));
        }
        let (tier, category_id) = parse_tier_line(line)?;
        if !TIERS.contains(&tier.as_str()) {
            return Err(ContextPolicyError::Malformed(format!(
                "unknown context tier {tier}"
            )));
        }
        if !categories.contains_key(&category_id) {
            return Err(ContextPolicyError::UnknownCategory {
                policy_id: policy_id.to_owned(),
                mode_id: mode_id.clone(),
                tier,
                category_id,
            });
        }
        if !seen.insert((tier.clone(), category_id.clone())) {
            return Err(ContextPolicyError::DuplicateTierEntry {
                policy_id: policy_id.to_owned(),
                mode_id: mode_id.clone(),
                tier,
                category_id,
            });
        }
        match tier.as_str() {
            "mandatory_inline" => mandatory_inline.push(category_id),
            "required_reads" => required_reads.push(category_id),
            "on_demand" => on_demand.push(category_id),
            "excluded" => excluded.push(category_id),
            _ => unreachable!("tier membership checked above"),
        }
        index += 1;
    }
    Err(ContextPolicyError::Malformed(format!(
        "policy {policy_id} mode {mode_id}: missing close"
    )))
}

fn parse_category(line: &str) -> Result<ContextPolicyCategory, ContextPolicyError> {
    let attrs = parse_attrs(line.trim_start_matches("category"))?;
    Ok(ContextPolicyCategory {
        id: attr_required(&attrs, "id")?,
        source: attr_required(&attrs, "source")?,
        class: attr_required(&attrs, "class")?,
        boundary: attrs.get("boundary").cloned(),
    })
}

fn parse_tier_line(line: &str) -> Result<(String, String), ContextPolicyError> {
    let (tier, rest) = line
        .split_once(' ')
        .ok_or_else(|| ContextPolicyError::Malformed(format!("tier line has no value: {line}")))?;
    let values = quoted(rest);
    if values.len() != 1 {
        return Err(ContextPolicyError::Malformed(format!(
            "tier line must have exactly one quoted category: {line}"
        )));
    }
    Ok((tier.to_owned(), values[0].clone()))
}

fn parse_lines(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|raw| raw.split("//").next())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_attrs(text: &str) -> Result<BTreeMap<String, String>, ContextPolicyError> {
    let mut attrs = BTreeMap::new();
    for part in text.split_whitespace() {
        if part.is_empty() {
            continue;
        }
        let (key, raw_value) = part
            .split_once('=')
            .ok_or_else(|| ContextPolicyError::Malformed(format!("bad attribute {part}")))?;
        let value = raw_value.trim_matches('"');
        if value.is_empty() {
            return Err(ContextPolicyError::Malformed(format!(
                "empty attribute {key}"
            )));
        }
        if attrs.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(ContextPolicyError::Malformed(format!(
                "duplicate attribute {key}"
            )));
        }
    }
    Ok(attrs)
}

fn attr_required(
    attrs: &BTreeMap<String, String>,
    name: &str,
) -> Result<String, ContextPolicyError> {
    attrs
        .get(name)
        .cloned()
        .ok_or_else(|| ContextPolicyError::Malformed(format!("missing attribute {name}")))
}

fn require_attr(
    attrs: &BTreeMap<String, String>,
    name: &str,
    expected: &str,
) -> Result<(), ContextPolicyError> {
    let actual = attr_required(attrs, name)?;
    if actual == expected {
        Ok(())
    } else {
        Err(ContextPolicyError::Malformed(format!(
            "{name} {actual} != {expected}"
        )))
    }
}

fn quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut open = false;
    let mut buf = String::new();
    for c in text.chars() {
        if c == '"' {
            if open {
                out.push(buf.clone());
                buf.clear();
            }
            open = !open;
        } else if open {
            buf.push(c);
        }
    }
    out
}
