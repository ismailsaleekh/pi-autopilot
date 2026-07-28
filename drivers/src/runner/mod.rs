use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use kernel::failure::{Failure, HardBoundary};
use kernel::generated::{
    ActionKind, AgentRunSpec, BackgroundAction, BackgroundActionBgRun, Bytes, ContractId,
    DeliveryResult, Digest, Id, ModeId, Path as ContractPath, Ref, Sha, SupersessionState,
    TaskDocument as ContractTaskDocument, TaskDocumentClass, ToolName, ValidationAssignmentKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};

use crate::roles::kdl::{blocks, boundary_runtime, one, values};
use crate::roster::{self, Roster};
use crate::vcs::GitVcs;

pub mod child;
pub mod rpc;

const ROLES_KDL: &str = include_str!("../../../data/roles.kdl");
const DEFAULT_BG_TIMEOUT_SECONDS: u32 = 3600;
const DEFAULT_REQUIRED_FOCUSED_EVIDENCE: u32 = 2;
const SETTINGS_IDENTITY: &str = "agent-run-settings:session-id,no-extensions,no-skills,no-prompt-templates,no-themes,no-context-files:v1";
const SKILLS_IDENTITY: &str = "agent-run-skills:disabled:v1";
const TASK_ATOMS_ADMITS: &str = kernel::generated::TASK_ATOMS_ADMITS;
const SCOUT_DOSSIER_ADMITS: &str = kernel::generated::SCOUT_DOSSIER_ADMITS;
const QUESTIONS_ADMITS: &str = kernel::generated::QUESTIONS_ADMITS;
const WORK_MAP_ADMITS: &str = kernel::generated::WORK_MAP_ADMITS;
const PLAN_REVIEW_ADMITS: &str = kernel::generated::PLAN_REVIEW_ADMITS;
pub const ISSUED_BINDING_REF_PREFIX: &str = "runner-binding:";

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RunnerTransportFacts {
    pub node_executable: PathBuf,
    pub runner_wrapper: PathBuf,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RunnerError {
    MissingTransport(String),
    InvalidTransport(String),
    Io(String),
    Roster(String),
    Route,
    StaleCarrier(String),
    InvalidSpec(String),
}

impl std::fmt::Display for RunnerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTransport(value) => {
                write!(formatter, "missing runner transport fact {value}")
            }
            Self::InvalidTransport(value) => {
                write!(formatter, "invalid runner transport fact: {value}")
            }
            Self::Io(value) => write!(formatter, "runner I/O error: {value}"),
            Self::Roster(value) => write!(formatter, "runner roster error: {value}"),
            Self::Route => write!(formatter, "runner route rejected"),
            Self::StaleCarrier(value) => write!(formatter, "runner carrier refused: {value}"),
            Self::InvalidSpec(value) => write!(formatter, "runner spec refused: {value}"),
        }
    }
}

impl std::error::Error for RunnerError {}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct RunnerTaskDocument {
    pub path: String,
    pub class: String,
    pub digest: String,
    pub body_digest: String,
    pub body: String,
}

impl RunnerTaskDocument {
    pub fn new(path: String, class: String, digest: String, body: String) -> Self {
        let body_digest = sha256_hex(body.as_bytes());
        Self {
            path,
            class,
            digest,
            body_digest,
            body,
        }
    }

    fn as_contract(&self) -> ContractTaskDocument {
        ContractTaskDocument {
            path: ContractPath(self.path.clone()),
            class: TaskDocumentClass(self.class.clone()),
            digest: Digest(self.digest.clone()),
            body_digest: Digest(self.body_digest.clone()),
            body: self.body.clone(),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct PlanningRunnerRequest {
    pub workstream: String,
    pub action_id: Id,
    pub assignment_id: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub boundary_id: ContractId,
    pub run_revision: u64,
    pub authority_set_id: String,
    pub authority_documents: Vec<RunnerTaskDocument>,
    pub context_document: RunnerTaskDocument,
    pub atom_id_prefix: Option<String>,
    pub atom_registry_path: Option<String>,
    pub atom_registry_digest: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RunnerAssignment {
    pub workstream: Id,
    pub action_id: Id,
    pub assignment_id: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub run_revision: u64,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: PathBuf,
    pub session_file: PathBuf,
    pub roster_assignment: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DeliveryExpectation {
    pub assignment_id: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub run_revision: u64,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: PathBuf,
    pub required_focused_evidence: usize,
    pub binding: Option<DeliveryBindingExpectation>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DeliveryBindingExpectation {
    pub action_id: Id,
    pub prompt_path: String,
    pub prompt_digest: String,
    pub spec_path: String,
    pub spec_digest: String,
    pub carrier_path: String,
    pub boundary_digest: String,
    pub result_contract_digest: String,
    pub settings_digest: String,
    pub context_digest: String,
    pub skills_digest: String,
    pub subscription_digest: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AcceptedDelivery {
    pub package_commit: Sha,
    pub package_tree: Sha,
    pub changed_paths: Vec<String>,
    pub audit_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct PackageFacts {
    pub package_commit: Sha,
    pub package_tree: Sha,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum DeliveryRejection {
    CarrierCount,
    Identity,
    BaseOrWorktree,
    MissingPackageCommit,
    MissingChangedPaths,
    MissingAudit,
    MissingFocusedEvidence,
    HardBoundaryViolation,
    AgentGitMutation,
    GitState,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct IssuedRunnerBinding {
    pub action_id: Id,
    pub assignment_id: Id,
    pub run_revision: u64,
    pub workstream: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub boundary_id: ContractId,
    pub result_contract: ContractId,
    pub prompt_path: String,
    pub prompt_digest: String,
    pub spec_path: String,
    pub spec_digest: String,
    pub carrier_path: String,
    pub session_id: Id,
    pub boundary_digest: String,
    pub result_contract_digest: String,
    pub settings_digest: String,
    pub context_digest: String,
    pub skills_digest: String,
    pub subscription_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<Sha>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub required_focused_evidence: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IssuedRunnerAction {
    pub action: BackgroundAction,
    pub binding: IssuedRunnerBinding,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RoleRuntime {
    pub role_id: String,
    pub modes: Vec<String>,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub route: String,
    pub built_in_tools: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RunnerPaths {
    pub prompt_path: PathBuf,
    pub spec_path: PathBuf,
    pub carrier_path: PathBuf,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BindingDigests {
    pub boundary_digest: String,
    pub result_contract_digest: String,
    pub settings_digest: String,
    pub context_digest: String,
    pub skills_digest: String,
    pub subscription_digest: String,
}

impl RunnerTransportFacts {
    pub fn from_env() -> Result<Self, RunnerError> {
        let node = env::var_os("AUTOPILOT_NODE_EXECUTABLE")
            .ok_or_else(|| RunnerError::MissingTransport("AUTOPILOT_NODE_EXECUTABLE".to_owned()))?;
        let wrapper = env::var_os("AUTOPILOT_AGENT_RUNNER_WRAPPER").ok_or_else(|| {
            RunnerError::MissingTransport("AUTOPILOT_AGENT_RUNNER_WRAPPER".to_owned())
        })?;
        Self::new(PathBuf::from(node), PathBuf::from(wrapper))
    }

    pub fn new(node_executable: PathBuf, runner_wrapper: PathBuf) -> Result<Self, RunnerError> {
        if !node_executable.is_absolute() {
            return Err(RunnerError::InvalidTransport(format!(
                "node executable is not absolute: {:?}",
                node_executable
            )));
        }
        if !runner_wrapper.is_absolute() {
            return Err(RunnerError::InvalidTransport(format!(
                "runner wrapper is not absolute: {:?}",
                runner_wrapper
            )));
        }
        reject_link_components_for_path(&node_executable)?;
        reject_link_components_for_path(&runner_wrapper)?;
        require_regular_file(&node_executable)?;
        require_regular_file(&runner_wrapper)?;
        let _ = path_to_string(&node_executable)?;
        let _ = path_to_string(&runner_wrapper)?;
        Ok(Self {
            node_executable,
            runner_wrapper,
        })
    }
}

pub fn planning_bg_action(
    request: &PlanningRunnerRequest,
) -> Result<BackgroundAction, RunnerError> {
    planning_issue(request).map(|issue| issue.action)
}

pub fn planning_issue(request: &PlanningRunnerRequest) -> Result<IssuedRunnerAction, RunnerError> {
    validate_planning_request(request)?;
    let facts = RunnerTransportFacts::from_env()?;
    let route = route_for_role(&request.role_id.0)?;
    let cwd = canonical_current_dir()?;
    let paths = planning_paths(&cwd, &request.workstream, &request.assignment_id);
    reject_link_components_for_path(&paths.carrier_path)?;
    let session_id = session_id_for(
        &Id(request.workstream.clone()),
        &request.assignment_id,
        &request.role_id,
        &request.mode,
        &request.boundary_id,
    );
    let prompt = planning_prompt(request, &route);
    write_parent_file(&paths.prompt_path, prompt.as_bytes())?;
    let prompt_digest = sha256_hex(prompt.as_bytes());
    let binding_digests = planning_binding_digests(request, &route)?;
    let spec = AgentRunSpec {
        schema: kernel::generated::SchemaId("autopilot.agent_run_spec.v1".to_owned()),
        assignment_kind: ValidationAssignmentKind::PlanningReview,
        action_id: request.action_id.clone(),
        assignment_id: request.assignment_id.clone(),
        run_revision: request.run_revision,
        workstream: Id(request.workstream.clone()),
        role_id: request.role_id.clone(),
        mode: request.mode.clone(),
        provider: route.provider.clone(),
        model: route.model.clone(),
        thinking: kernel::generated::ThinkingLevel(route.thinking.clone()),
        route: "subscription".to_owned(),
        cwd: to_contract_path(&cwd)?,
        allowed_tools: role_builtin_tool_names(&request.role_id.0)?
            .into_iter()
            .map(ToolName)
            .collect(),
        spec_path: to_contract_path(&paths.spec_path)?,
        prompt_path: to_contract_path(&paths.prompt_path)?,
        prompt_digest: Digest(prompt_digest.clone()),
        boundary_id: request.boundary_id.clone(),
        boundary_digest: Digest(binding_digests.boundary_digest.clone()),
        result_contract: request.boundary_id.clone(),
        result_contract_digest: Digest(binding_digests.result_contract_digest.clone()),
        carrier_path: to_contract_path(&paths.carrier_path)?,
        session_id: session_id.clone(),
        settings_digest: Digest(binding_digests.settings_digest.clone()),
        context_digest: Digest(binding_digests.context_digest.clone()),
        skills_digest: Digest(binding_digests.skills_digest.clone()),
        subscription_digest: Digest(binding_digests.subscription_digest.clone()),
        lane_id: None,
        attempt: None,
        base_commit: None,
        worktree: None,
        required_focused_evidence: None,
        authority_set_id: Some(request.authority_set_id.clone()),
        authority_documents: Some(
            request
                .authority_documents
                .iter()
                .map(RunnerTaskDocument::as_contract)
                .collect(),
        ),
        context_document: Some(request.context_document.as_contract()),
        assignment_path: None,
        assignment_digest: None,
        context_manifest_path: None,
        context_manifest_digest: None,
        runtime_extension_path: None,
        runtime_extension_digest: None,
        producer_assignment_ids: None,
        validation_id: None,
        validation_attempt: None,
        semantic_round: None,
        model_submission_path: None,
        atom_id_prefix: request.atom_id_prefix.clone(),
        atom_registry_path: request
            .atom_registry_path
            .as_ref()
            .map(|path| ContractPath(path.clone())),
        atom_registry_digest: request
            .atom_registry_digest
            .as_ref()
            .map(|digest| Digest(digest.clone())),
        planning_inputs_path: None,
        planning_inputs_digest: None,
    };
    let spec_digest = write_spec_document(&paths.spec_path, &spec)?;
    let binding = IssuedRunnerBinding {
        action_id: request.action_id.clone(),
        assignment_id: request.assignment_id.clone(),
        run_revision: request.run_revision,
        workstream: Id(request.workstream.clone()),
        role_id: request.role_id.clone(),
        mode: request.mode.clone(),
        boundary_id: request.boundary_id.clone(),
        result_contract: request.boundary_id.clone(),
        prompt_path: path_to_string(&paths.prompt_path)?,
        prompt_digest,
        spec_path: path_to_string(&paths.spec_path)?,
        spec_digest,
        carrier_path: path_to_string(&paths.carrier_path)?,
        session_id,
        boundary_digest: binding_digests.boundary_digest,
        result_contract_digest: binding_digests.result_contract_digest,
        settings_digest: binding_digests.settings_digest,
        context_digest: binding_digests.context_digest,
        skills_digest: binding_digests.skills_digest,
        subscription_digest: binding_digests.subscription_digest,
        lane_id: None,
        attempt: None,
        base_commit: None,
        worktree: None,
        required_focused_evidence: 0,
    };
    let action = action_from_doc(
        &facts,
        &paths.spec_path,
        &spec,
        Some(DEFAULT_BG_TIMEOUT_SECONDS),
    )?;
    Ok(IssuedRunnerAction { action, binding })
}

pub fn bg_action(assignment: &RunnerAssignment) -> Result<BackgroundAction, RunnerError> {
    let facts = RunnerTransportFacts::from_env()?;
    delivery_bg_action_with_facts(assignment, &facts)
}

pub fn delivery_bg_action_with_facts(
    assignment: &RunnerAssignment,
    facts: &RunnerTransportFacts,
) -> Result<BackgroundAction, RunnerError> {
    delivery_issue_with_facts(assignment, facts).map(|issue| issue.action)
}

pub fn delivery_issue_with_facts(
    assignment: &RunnerAssignment,
    facts: &RunnerTransportFacts,
) -> Result<IssuedRunnerAction, RunnerError> {
    validate_delivery_assignment(assignment)?;
    let route = route_for_role(&assignment.role_id.0)?;
    let worktree = absolute_path(&assignment.worktree)?;
    reject_link_components_for_path(&worktree)?;
    verify_distinct_git_worktree(&worktree, &assignment.base_commit)?;
    let delivery_contract = delivery_contract_id();
    let paths = delivery_paths(&worktree, &assignment.assignment_id);
    reject_link_components_for_path(&paths.carrier_path)?;
    let worktree_text = path_to_string(&worktree)?;
    let session_id = session_id_for(
        &assignment.workstream,
        &assignment.assignment_id,
        &assignment.role_id,
        &assignment.mode,
        &delivery_contract,
    );
    let prompt = delivery_prompt(assignment, &route, &worktree_text);
    write_parent_file(&paths.prompt_path, prompt.as_bytes())?;
    let prompt_digest = sha256_hex(prompt.as_bytes());
    let binding_digests = delivery_binding_digests(assignment, &route, &worktree_text)?;
    let spec = AgentRunSpec {
        schema: kernel::generated::SchemaId("autopilot.agent_run_spec.v1".to_owned()),
        assignment_kind: ValidationAssignmentKind::Delivery,
        action_id: assignment.action_id.clone(),
        assignment_id: assignment.assignment_id.clone(),
        run_revision: assignment.run_revision,
        workstream: assignment.workstream.clone(),
        role_id: assignment.role_id.clone(),
        mode: assignment.mode.clone(),
        provider: route.provider.clone(),
        model: route.model.clone(),
        thinking: kernel::generated::ThinkingLevel(route.thinking.clone()),
        route: "subscription".to_owned(),
        cwd: ContractPath(worktree_text.clone()),
        allowed_tools: role_builtin_tool_names(&assignment.role_id.0)?
            .into_iter()
            .map(ToolName)
            .collect(),
        spec_path: to_contract_path(&paths.spec_path)?,
        prompt_path: to_contract_path(&paths.prompt_path)?,
        prompt_digest: Digest(prompt_digest.clone()),
        boundary_id: delivery_contract.clone(),
        boundary_digest: Digest(binding_digests.boundary_digest.clone()),
        result_contract: delivery_contract.clone(),
        result_contract_digest: Digest(binding_digests.result_contract_digest.clone()),
        carrier_path: to_contract_path(&paths.carrier_path)?,
        session_id: session_id.clone(),
        settings_digest: Digest(binding_digests.settings_digest.clone()),
        context_digest: Digest(binding_digests.context_digest.clone()),
        skills_digest: Digest(binding_digests.skills_digest.clone()),
        subscription_digest: Digest(binding_digests.subscription_digest.clone()),
        lane_id: Some(assignment.lane_id.clone()),
        attempt: Some(assignment.attempt),
        base_commit: Some(assignment.base_commit.clone()),
        worktree: Some(ContractPath(worktree_text.clone())),
        required_focused_evidence: Some(DEFAULT_REQUIRED_FOCUSED_EVIDENCE),
        authority_set_id: None,
        authority_documents: None,
        context_document: None,
        assignment_path: None,
        assignment_digest: None,
        context_manifest_path: None,
        context_manifest_digest: None,
        runtime_extension_path: None,
        runtime_extension_digest: None,
        producer_assignment_ids: None,
        validation_id: None,
        validation_attempt: None,
        semantic_round: None,
        model_submission_path: None,
        atom_id_prefix: None,
        atom_registry_path: None,
        atom_registry_digest: None,
        planning_inputs_path: None,
        planning_inputs_digest: None,
    };
    let spec_digest = write_spec_document(&paths.spec_path, &spec)?;
    let binding = IssuedRunnerBinding {
        action_id: assignment.action_id.clone(),
        assignment_id: assignment.assignment_id.clone(),
        run_revision: assignment.run_revision,
        workstream: assignment.workstream.clone(),
        role_id: assignment.role_id.clone(),
        mode: assignment.mode.clone(),
        boundary_id: delivery_contract.clone(),
        result_contract: delivery_contract,
        prompt_path: path_to_string(&paths.prompt_path)?,
        prompt_digest,
        spec_path: path_to_string(&paths.spec_path)?,
        spec_digest,
        carrier_path: path_to_string(&paths.carrier_path)?,
        session_id,
        boundary_digest: binding_digests.boundary_digest,
        result_contract_digest: binding_digests.result_contract_digest,
        settings_digest: binding_digests.settings_digest,
        context_digest: binding_digests.context_digest,
        skills_digest: binding_digests.skills_digest,
        subscription_digest: binding_digests.subscription_digest,
        lane_id: Some(assignment.lane_id.clone()),
        attempt: Some(assignment.attempt),
        base_commit: Some(assignment.base_commit.clone()),
        worktree: Some(worktree_text),
        required_focused_evidence: DEFAULT_REQUIRED_FOCUSED_EVIDENCE,
    };
    let action = action_from_doc(
        facts,
        &paths.spec_path,
        &spec,
        Some(DEFAULT_BG_TIMEOUT_SECONDS),
    )?;
    Ok(IssuedRunnerAction { action, binding })
}

pub fn command_for_spec(facts: &RunnerTransportFacts, spec_path: &Path) -> String {
    try_command_for_spec(facts, spec_path).expect("runner command paths must have been validated")
}

pub fn try_command_for_spec(
    facts: &RunnerTransportFacts,
    spec_path: &Path,
) -> Result<String, RunnerError> {
    Ok(format!(
        "{} {} --spec {}",
        shell_quote(&path_to_string(&facts.node_executable)?),
        shell_quote(&path_to_string(&facts.runner_wrapper)?),
        shell_quote(&path_to_string(spec_path)?)
    ))
}

pub fn planning_paths(cwd: &Path, workstream: &str, assignment_id: &Id) -> RunnerPaths {
    let base = cwd.join(".pi/autopilot").join(workstream).join("planning");
    RunnerPaths {
        prompt_path: base.join("prompts").join(format!("{}.md", assignment_id.0)),
        spec_path: base.join("specs").join(format!("{}.json", assignment_id.0)),
        carrier_path: base
            .join("carriers")
            .join(format!("{}.json", assignment_id.0)),
    }
}

pub fn delivery_paths(cwd: &Path, assignment_id: &Id) -> RunnerPaths {
    let base = cwd.join(".pi/autopilot/runner");
    RunnerPaths {
        prompt_path: base.join("prompts").join(format!("{}.md", assignment_id.0)),
        spec_path: base.join("specs").join(format!("{}.json", assignment_id.0)),
        carrier_path: base
            .join("carriers")
            .join(format!("{}.json", assignment_id.0)),
    }
}

pub fn role_runtime(role_id: &str) -> Result<RoleRuntime, RunnerError> {
    let roster = Roster::package().map_err(|error| RunnerError::Roster(format!("{error:?}")))?;
    for block in blocks(ROLES_KDL, "role").map_err(RunnerError::Roster)? {
        if block.id != role_id {
            continue;
        }
        let model_slot = one(&block.fields, "model_slot").map_err(RunnerError::Roster)?;
        let slot = roster
            .get(&model_slot)
            .map_err(|error| RunnerError::Roster(format!("{error:?}")))?;
        if !slot.roles.iter().any(|role| role == role_id) {
            return Err(RunnerError::Roster(format!(
                "role {role_id} absent from roster slot {model_slot}"
            )));
        }
        let route = slot.route();
        roster::guard_route(&route).map_err(|_| RunnerError::Route)?;
        let role_thinking = one(&block.fields, "thinking").map_err(RunnerError::Roster)?;
        if role_thinking != slot.thinking {
            return Err(RunnerError::Roster(format!(
                "role {role_id} thinking drift"
            )));
        }
        return Ok(RoleRuntime {
            role_id: role_id.to_owned(),
            modes: values(&block.fields, "modes"),
            provider: slot.provider.clone(),
            model: slot.model.clone(),
            thinking: slot.thinking.clone(),
            route: slot.route.clone(),
            built_in_tools: values(&block.fields, "tools")
                .into_iter()
                .filter(|tool| is_builtin_tool(tool))
                .collect(),
        });
    }
    Err(RunnerError::Roster(format!("missing role {role_id}")))
}

pub fn role_builtin_tool_names(role_id: &str) -> Result<Vec<String>, RunnerError> {
    let runtime = role_runtime(role_id)?;
    if runtime.built_in_tools.is_empty() {
        return Err(RunnerError::Roster(format!(
            "role {role_id} has no Pi built-in tools"
        )));
    }
    Ok(runtime.built_in_tools)
}

pub fn expected_boundary_for_role(role_id: &str) -> Option<&'static str> {
    match role_id {
        "task-extractor" => Some("planning.task-atoms.v1"),
        "repository-scout" | "context-curator" => Some("planning.scout-dossier.v1"),
        "plan-compiler" | "plan-synthesizer" => Some("planning.work-map.v1"),
        "plan-reviewer" => Some("planning.plan-review.v1"),
        "contradiction-resolver" => Some("planning.questions.v1"),
        "implementer" | "fixer-integrator" => Some("autopilot.delivery_result.v1"),
        _ => None,
    }
}

pub fn session_id_for(
    workstream: &Id,
    assignment_id: &Id,
    role_id: &Id,
    mode: &ModeId,
    boundary_id: &ContractId,
) -> Id {
    let material = format!(
        "autopilot.pi-session.v1\0{}\0{}\0{}\0{}\0{}",
        workstream.0, assignment_id.0, role_id.0, mode.0, boundary_id.0
    );
    let digest = sha256_hex(material.as_bytes());
    Id(format!("autopilot-{}-{}", assignment_id.0, &digest[..16]))
}

fn delivery_contract_id() -> ContractId {
    ContractId("autopilot.delivery_result.v1".to_owned())
}

pub fn binding_ref(binding: &IssuedRunnerBinding) -> Result<Ref, RunnerError> {
    let json =
        serde_json::to_string(binding).map_err(|error| RunnerError::Io(error.to_string()))?;
    Ok(Ref(format!("{ISSUED_BINDING_REF_PREFIX}{json}")))
}

pub fn decode_binding_ref(value: &str) -> Option<IssuedRunnerBinding> {
    serde_json::from_str(value.strip_prefix(ISSUED_BINDING_REF_PREFIX)?).ok()
}

fn action_from_doc(
    facts: &RunnerTransportFacts,
    spec_path: &Path,
    spec: &AgentRunSpec,
    timeout_seconds: Option<u32>,
) -> Result<BackgroundAction, RunnerError> {
    Ok(BackgroundAction {
        action_id: spec.action_id.clone(),
        assignment_id: spec.assignment_id.clone(),
        kind: ActionKind::LaunchBackground,
        bg_run: BackgroundActionBgRun {
            name: format!("autopilot-agent-run {}", spec.assignment_id.0),
            command: Bytes(try_command_for_spec(facts, spec_path)?),
            is_agent: true,
            timeout_seconds,
            notify_on_completion: true,
            trigger_on_completion: true,
        },
        run_revision: spec.run_revision,
        expires_at: None,
        supersession_state: SupersessionState("live".to_owned()),
    })
}

fn route_for_role(role_id: &str) -> Result<roster::Route, RunnerError> {
    let runtime = role_runtime(role_id)?;
    let route = roster::Route {
        provider: runtime.provider,
        model: runtime.model,
        thinking: runtime.thinking,
        subscription: runtime.route == "subscription",
    };
    roster::guard_route(&route).map_err(|_| RunnerError::Route)
}

fn validate_planning_request(request: &PlanningRunnerRequest) -> Result<(), RunnerError> {
    let runtime = role_runtime(&request.role_id.0)?;
    if !runtime.modes.iter().any(|mode| mode == &request.mode.0) {
        return Err(RunnerError::InvalidSpec(format!(
            "role/mode drift: {}/{}",
            request.role_id.0, request.mode.0
        )));
    }
    let expected = expected_boundary_for_role(&request.role_id.0).ok_or_else(|| {
        RunnerError::InvalidSpec(format!(
            "role has no planning boundary: {}",
            request.role_id.0
        ))
    })?;
    if expected == "autopilot.delivery_result.v1" || request.boundary_id.0 != expected {
        return Err(RunnerError::InvalidSpec(format!(
            "boundary drift: expected {expected}, got {}",
            request.boundary_id.0
        )));
    }
    if request.authority_documents.is_empty()
        || request.context_document.class != "context/non-authority"
    {
        return Err(RunnerError::InvalidSpec(
            "planning input pack drift".to_owned(),
        ));
    }
    for document in &request.authority_documents {
        validate_runner_task_document(document, "authority", &request.authority_set_id)?;
    }
    validate_runner_task_document(
        &request.context_document,
        "context/non-authority",
        &request.authority_set_id,
    )?;
    match request.boundary_id.0.as_str() {
        "planning.task-atoms.v1" => {
            let Some(prefix) = &request.atom_id_prefix else {
                return Err(RunnerError::InvalidSpec(
                    "task atom assignment missing atom_id_prefix".to_owned(),
                ));
            };
            if prefix.trim().is_empty() {
                return Err(RunnerError::InvalidSpec(
                    "task atom assignment empty atom_id_prefix".to_owned(),
                ));
            }
            if request.atom_registry_path.is_some() || request.atom_registry_digest.is_some() {
                return Err(RunnerError::InvalidSpec(
                    "task atom assignment cannot bind an atom registry".to_owned(),
                ));
            }
        }
        "planning.work-map.v1" => {
            if request.atom_registry_path.as_deref().is_none_or(str::is_empty)
                || request.atom_registry_digest.as_deref().is_none_or(str::is_empty)
            {
                return Err(RunnerError::InvalidSpec(
                    "work-map assignment missing atom registry binding".to_owned(),
                ));
            }
            if request.atom_id_prefix.is_some() {
                return Err(RunnerError::InvalidSpec(
                    "work-map assignment cannot bind an atom id prefix".to_owned(),
                ));
            }
        }
        _ => {
            if request.atom_id_prefix.is_some()
                || request.atom_registry_path.is_some()
                || request.atom_registry_digest.is_some()
            {
                return Err(RunnerError::InvalidSpec(
                    "non atom/work-map planning assignment has atom bindings".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_delivery_assignment(assignment: &RunnerAssignment) -> Result<(), RunnerError> {
    let runtime = role_runtime(&assignment.role_id.0)?;
    if !runtime.modes.iter().any(|mode| mode == &assignment.mode.0) {
        return Err(RunnerError::InvalidSpec(format!(
            "role/mode drift: {}/{}",
            assignment.role_id.0, assignment.mode.0
        )));
    }
    if expected_boundary_for_role(&assignment.role_id.0) != Some("autopilot.delivery_result.v1") {
        return Err(RunnerError::InvalidSpec(format!(
            "delivery role drift: {}",
            assignment.role_id.0
        )));
    }
    if assignment.lane_id.0.trim().is_empty()
        || assignment.attempt == 0
        || assignment.base_commit.0.trim().is_empty()
    {
        return Err(RunnerError::InvalidSpec(
            "delivery lane/attempt/base drift".to_owned(),
        ));
    }
    Ok(())
}

fn validate_runner_task_document(
    document: &RunnerTaskDocument,
    expected_class: &str,
    authority_set_id: &str,
) -> Result<(), RunnerError> {
    if document.class != expected_class
        || document.path.trim().is_empty()
        || document.body.trim().is_empty()
    {
        return Err(RunnerError::InvalidSpec(format!(
            "planning document drift for {expected_class}"
        )));
    }
    let body_digest = sha256_hex(document.body.as_bytes());
    if body_digest != document.body_digest {
        return Err(RunnerError::InvalidSpec(format!(
            "planning document body digest drift: {}",
            document.path
        )));
    }
    let file_digest = task_document_digest(expected_class, authority_set_id, &document.body);
    if file_digest != document.digest {
        return Err(RunnerError::InvalidSpec(format!(
            "planning document file digest drift: {}",
            document.path
        )));
    }
    Ok(())
}

fn planning_binding_digests(
    request: &PlanningRunnerRequest,
    route: &roster::Route,
) -> Result<BindingDigests, RunnerError> {
    let context_digest = sha_json(&serde_json::json!({
        "authority_set_id": request.authority_set_id,
        "authority_documents": request.authority_documents,
        "context_document": request.context_document,
    }))?;
    Ok(BindingDigests {
        boundary_digest: contract_digest(&request.boundary_id.0)?,
        result_contract_digest: contract_digest(&request.boundary_id.0)?,
        settings_digest: sha256_hex(SETTINGS_IDENTITY.as_bytes()),
        context_digest,
        skills_digest: sha256_hex(SKILLS_IDENTITY.as_bytes()),
        subscription_digest: subscription_digest(route),
    })
}

fn delivery_binding_digests(
    assignment: &RunnerAssignment,
    route: &roster::Route,
    worktree: &str,
) -> Result<BindingDigests, RunnerError> {
    let context_digest = sha_json(&serde_json::json!({
        "workstream": assignment.workstream,
        "lane_id": assignment.lane_id,
        "attempt": assignment.attempt,
        "base_commit": assignment.base_commit,
        "worktree": worktree,
        "required_focused_evidence": DEFAULT_REQUIRED_FOCUSED_EVIDENCE,
    }))?;
    let contract = "autopilot.delivery_result.v1";
    Ok(BindingDigests {
        boundary_digest: contract_digest(contract)?,
        result_contract_digest: contract_digest(contract)?,
        settings_digest: sha256_hex(SETTINGS_IDENTITY.as_bytes()),
        context_digest,
        skills_digest: sha256_hex(SKILLS_IDENTITY.as_bytes()),
        subscription_digest: subscription_digest(route),
    })
}

pub(crate) fn contract_digest(contract_id: &str) -> Result<String, RunnerError> {
    let text = match contract_id {
        "planning.task-atoms.v1" => TASK_ATOMS_ADMITS,
        "planning.scout-dossier.v1" => SCOUT_DOSSIER_ADMITS,
        "planning.questions.v1" => QUESTIONS_ADMITS,
        "planning.work-map.v1" => WORK_MAP_ADMITS,
        "planning.plan-review.v1" => PLAN_REVIEW_ADMITS,
        "autopilot.delivery_result.v1" => kernel::generated::DELIVERY_RESULT_ADMITS,
        other => {
            return Err(RunnerError::InvalidSpec(format!(
                "unknown contract digest: {other}"
            )));
        }
    };
    Ok(sha256_hex(format!("{contract_id}\0{text}").as_bytes()))
}

pub(crate) fn settings_digest() -> String {
    sha256_hex(SETTINGS_IDENTITY.as_bytes())
}

pub(crate) fn skills_digest() -> String {
    sha256_hex(SKILLS_IDENTITY.as_bytes())
}

pub(crate) fn subscription_digest(route: &roster::Route) -> String {
    sha256_hex(
        format!(
            "provider={}\0model={}\0thinking={}\0route=subscription",
            route.provider, route.model, route.thinking
        )
        .as_bytes(),
    )
}

fn task_document_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn sha_json(value: &impl Serialize) -> Result<String, RunnerError> {
    let data = serde_json::to_vec(value).map_err(|error| RunnerError::Io(error.to_string()))?;
    Ok(sha256_hex(&data))
}

fn planning_prompt(request: &PlanningRunnerRequest, route: &roster::Route) -> String {
    let mut out = format!(
        "Autopilot planning child assignment.\nassignment_id: {}\naction_id: {}\nworkstream: {}\nrole: {}\nmode: {}\nboundary: {}\nprovider: {}\nmodel: {}\nthinking: {}\nroute: subscription\nauthority_set_id: {}\n\nReturn exactly one final assistant result satisfying the boundary.\nContext may ground work but must not create or override an atom.\n\n## Core authority documents\n",
        request.assignment_id.0,
        request.action_id.0,
        request.workstream,
        request.role_id.0,
        request.mode.0,
        request.boundary_id.0,
        route.provider,
        route.model,
        route.thinking,
        request.authority_set_id,
    );
    if let Some(prefix) = &request.atom_id_prefix {
        out.push_str(&format!(
            "\n## Runner-issued atom namespace\nEvery atoms[].id you submit must begin with this exact prefix and must add a non-empty local suffix: `{prefix}`\nDo not rewrite the prefix, do not omit it, and do not use another extractor's prefix.\n"
        ));
    }
    if let (Some(path), Some(digest)) = (&request.atom_registry_path, &request.atom_registry_digest) {
        out.push_str(&format!(
            "\n## Bound atom registry\nUse only atom ids from this package-created registry for units[].links.\npath: {path}\ndigest: {digest}\nPlaceholder links such as A1/A2/A3 are invalid unless they are exact registry ids.\n"
        ));
    }
    for (index, document) in request.authority_documents.iter().enumerate() {
        out.push_str(&format!(
            "\n### AUTHORITY {}\npath: {}\ndigest: {}\nbody_digest: {}\n```text\n{}\n```\n",
            index + 1,
            document.path,
            document.digest,
            document.body_digest,
            document.body
        ));
    }
    out.push_str(&format!(
        "\n## Grounding context document (non-authority)\npath: {}\ndigest: {}\nbody_digest: {}\nThis document is context only; do not emit it as a Work atom.\n```text\n{}\n```\n",
        request.context_document.path,
        request.context_document.digest,
        request.context_document.body_digest,
        request.context_document.body
    ));
    out
}

fn delivery_prompt(assignment: &RunnerAssignment, route: &roster::Route, worktree: &str) -> String {
    format!(
        "Autopilot delivery child assignment.\nassignment_id: {}\naction_id: {}\nworkstream: {}\nlane_id: {}\nattempt: {}\nrole: {}\nmode: {}\nrun_revision: {}\nbase_commit: {}\nworktree: {}\nprovider: {}\nmodel: {}\nthinking: {}\nroute: subscription\nrequired_focused_evidence: {}\n\nReturn exactly one autopilot.delivery_result.v1 carrier matching every identity field above.",
        assignment.assignment_id.0,
        assignment.action_id.0,
        assignment.workstream.0,
        assignment.lane_id.0,
        assignment.attempt,
        assignment.role_id.0,
        assignment.mode.0,
        assignment.run_revision,
        assignment.base_commit.0,
        worktree,
        route.provider,
        route.model,
        route.thinking,
        DEFAULT_REQUIRED_FOCUSED_EVIDENCE,
    )
}

fn write_spec_document(path: &Path, spec: &AgentRunSpec) -> Result<String, RunnerError> {
    let data =
        serde_json::to_vec_pretty(spec).map_err(|error| RunnerError::Io(error.to_string()))?;
    let digest = sha256_hex(&data);
    write_parent_file(path, &data)?;
    Ok(digest)
}

fn write_parent_file(path: &Path, data: &[u8]) -> Result<(), RunnerError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    fs::write(path, data).map_err(io_error)
}

pub(crate) fn reject_link_components_for_path(path: &Path) -> Result<(), RunnerError> {
    let mut probe = PathBuf::new();
    for component in path.components() {
        probe.push(component.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(RunnerError::InvalidTransport(format!(
                    "path link component refused: {:?}",
                    probe
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

pub(crate) fn require_regular_file(path: &Path) -> Result<(), RunnerError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.file_type().is_file() {
        return Err(RunnerError::InvalidTransport(format!(
            "path is not a regular file: {:?}",
            path
        )));
    }
    Ok(())
}

pub(crate) fn path_to_string(path: &Path) -> Result<String, RunnerError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| RunnerError::InvalidTransport(format!("path is not UTF-8: {:?}", path)))
}

fn to_contract_path(path: &Path) -> Result<ContractPath, RunnerError> {
    Ok(ContractPath(path_to_string(path)?))
}

fn canonical_current_dir() -> Result<PathBuf, RunnerError> {
    fs::canonicalize(env::current_dir().map_err(io_error)?).map_err(io_error)
}

fn absolute_path(path: &Path) -> Result<PathBuf, RunnerError> {
    if path.is_absolute() {
        match fs::canonicalize(path) {
            Ok(real) => Ok(real),
            Err(_) => Ok(path.to_path_buf()),
        }
    } else {
        let joined = canonical_current_dir()?.join(path);
        match fs::canonicalize(&joined) {
            Ok(real) => Ok(real),
            Err(_) => Ok(joined),
        }
    }
}

fn is_builtin_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write"
    )
}

fn shell_quote(value: &str) -> String {
    if cfg!(windows) {
        windows_shell_quote(value)
    } else if value.is_empty() {
        "''".to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn windows_shell_quote(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '%' => out.push_str("^%"),
            '!' => out.push_str("^^!"),
            '^' => out.push_str("^^"),
            '&' => out.push_str("^&"),
            '|' => out.push_str("^|"),
            '<' => out.push_str("^<"),
            '>' => out.push_str("^>"),
            '(' => out.push_str("^("),
            ')' => out.push_str("^)"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn io_error(error: std::io::Error) -> RunnerError {
    RunnerError::Io(error.to_string())
}

pub fn package_delivery_commit(
    vcs: &GitVcs,
    worktree: &Path,
    message: &str,
) -> Result<Sha, Failure> {
    vcs.stage_all(worktree)?;
    vcs.snapshot(worktree, message).map(Sha)
}

pub fn refuse_agent_git_mutation(vcs: &GitVcs) -> Result<(), DeliveryRejection> {
    match vcs.mutate_as_agent() {
        Err(Failure::Unsafe {
            boundary: HardBoundary::AgentVersionMutation,
        }) => Err(DeliveryRejection::AgentGitMutation),
        Ok(()) => Ok(()),
        Err(_) => Err(DeliveryRejection::AgentGitMutation),
    }
}

pub fn establish_delivery_package(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<PackageFacts, DeliveryRejection> {
    validate_delivery_pre_package(result, expected)?;
    let worktree = canonical_delivery_worktree(result, expected)?;
    verify_distinct_git_worktree(&worktree, &expected.base_commit)
        .map_err(|_| DeliveryRejection::GitState)?;
    let head = git_stdout_checked(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map_err(|_| DeliveryRejection::GitState)?;
    let head = head.trim().to_owned();
    if head != expected.base_commit.0 {
        return package_facts_for_head(&worktree, head);
    }
    let claimed = claimed_changed_paths(result)?;
    git_status_checked(&worktree, &["reset", "--mixed", "HEAD"])
        .map_err(|_| DeliveryRejection::GitState)?;
    git_status_checked_with_paths(&worktree, &["add", "--"], &claimed)
        .map_err(|_| DeliveryRejection::GitState)?;
    let staged = git_stdout_bytes_checked(
        &worktree,
        &["diff", "--cached", "--name-only", "-z", "HEAD", "--"],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    let mut staged_paths = git_nul_paths(&staged);
    let mut sorted_claimed = path_bytes(&claimed);
    staged_paths.sort();
    sorted_claimed.sort();
    if staged_paths != sorted_claimed {
        git_status_checked(&worktree, &["reset", "--mixed", "HEAD"])
            .map_err(|_| DeliveryRejection::GitState)?;
        return Err(DeliveryRejection::GitState);
    }
    git_status_checked(
        &worktree,
        &[
            "commit",
            "--no-gpg-sign",
            "-m",
            "autopilot delivery package",
        ],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    let package_commit = git_stdout_checked(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map_err(|_| DeliveryRejection::GitState)?;
    package_facts_for_head(&worktree, package_commit.trim().to_owned())
}

pub fn accept_delivery_with_package_facts(
    carriers: &[DeliveryResult],
    expected: &DeliveryExpectation,
    package: &PackageFacts,
) -> Result<AcceptedDelivery, DeliveryRejection> {
    if carriers.len() != 1 {
        return Err(DeliveryRejection::CarrierCount);
    }
    let result = &carriers[0];
    validate_delivery_pre_package(result, expected)?;
    verify_delivery_git_state(
        result,
        expected,
        &package.package_commit,
        &package.package_tree,
    )?;
    Ok(accepted_delivery_from(result, package.clone()))
}

pub fn accept_delivery(
    carriers: &[DeliveryResult],
    expected: &DeliveryExpectation,
) -> Result<AcceptedDelivery, DeliveryRejection> {
    if carriers.len() != 1 {
        return Err(DeliveryRejection::CarrierCount);
    }
    let result = &carriers[0];
    validate_delivery_identity(result, expected)?;
    if !result.hard_boundary_violations.is_empty() {
        return Err(DeliveryRejection::HardBoundaryViolation);
    }
    let package_commit = match &result.package_commit {
        Some(value) if !value.0.trim().is_empty() => value.clone(),
        _ => return Err(DeliveryRejection::MissingPackageCommit),
    };
    let package_tree = match &result.package_tree {
        Some(value) if !value.0.trim().is_empty() => value.clone(),
        _ => return Err(DeliveryRejection::MissingPackageCommit),
    };
    validate_delivery_claims(result, expected)?;
    verify_delivery_binding(result, expected)?;
    let package = PackageFacts {
        package_commit,
        package_tree,
    };
    verify_delivery_git_state(
        result,
        expected,
        &package.package_commit,
        &package.package_tree,
    )?;
    Ok(accepted_delivery_from(result, package))
}

fn validate_delivery_pre_package(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<(), DeliveryRejection> {
    validate_delivery_identity(result, expected)?;
    if !result.hard_boundary_violations.is_empty() {
        return Err(DeliveryRejection::HardBoundaryViolation);
    }
    validate_delivery_claims(result, expected)?;
    verify_delivery_binding(result, expected)
}

fn validate_delivery_identity(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<(), DeliveryRejection> {
    if result.assignment_id != expected.assignment_id
        || result.role_id != expected.role_id
        || result.mode != expected.mode
        || result.run_revision != expected.run_revision
        || result.lane_id != expected.lane_id
        || result.attempt != expected.attempt
    {
        return Err(DeliveryRejection::Identity);
    }
    if result.base_commit != expected.base_commit
        || Path::new(&result.worktree.0) != expected.worktree
    {
        return Err(DeliveryRejection::BaseOrWorktree);
    }
    Ok(())
}

fn validate_delivery_claims(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<(), DeliveryRejection> {
    claimed_changed_paths(result)?;
    if result.execution_audit_ref.0.trim().is_empty() {
        return Err(DeliveryRejection::MissingAudit);
    }
    if result.focused_evidence_refs.len() < expected.required_focused_evidence {
        return Err(DeliveryRejection::MissingFocusedEvidence);
    }
    Ok(())
}

fn claimed_changed_paths(result: &DeliveryResult) -> Result<Vec<String>, DeliveryRejection> {
    if result.actual_changed_paths.is_empty() {
        return Err(DeliveryRejection::MissingChangedPaths);
    }
    let mut paths = Vec::with_capacity(result.actual_changed_paths.len());
    for path in &result.actual_changed_paths {
        if !claimed_path_is_safe(&path.0) {
            return Err(DeliveryRejection::GitState);
        }
        paths.push(path.0.clone());
    }
    Ok(paths)
}

fn claimed_path_is_safe(path: &str) -> bool {
    if path.trim().is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with(".pi/autopilot/runner/")
        || Path::new(path).is_absolute()
    {
        return false;
    }
    let mut saw_normal = false;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(value) if value != ".git" => saw_normal = true,
            _ => return false,
        }
    }
    saw_normal
}

fn canonical_delivery_worktree(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<PathBuf, DeliveryRejection> {
    let worktree = Path::new(&result.worktree.0);
    reject_link_components_for_path(worktree).map_err(|_| DeliveryRejection::GitState)?;
    let actual_worktree = fs::canonicalize(worktree).map_err(|_| DeliveryRejection::GitState)?;
    let expected_worktree =
        fs::canonicalize(&expected.worktree).map_err(|_| DeliveryRejection::GitState)?;
    if actual_worktree != expected_worktree {
        return Err(DeliveryRejection::BaseOrWorktree);
    }
    Ok(actual_worktree)
}

fn package_facts_for_head(
    worktree: &Path,
    head: String,
) -> Result<PackageFacts, DeliveryRejection> {
    let tree = git_stdout_checked(worktree, &["rev-parse", "--verify", "HEAD^{tree}"])
        .map_err(|_| DeliveryRejection::GitState)?;
    Ok(PackageFacts {
        package_commit: Sha(head),
        package_tree: Sha(tree.trim().to_owned()),
    })
}

fn accepted_delivery_from(result: &DeliveryResult, package: PackageFacts) -> AcceptedDelivery {
    AcceptedDelivery {
        package_commit: package.package_commit,
        package_tree: package.package_tree,
        changed_paths: result
            .actual_changed_paths
            .iter()
            .map(|path| path.0.clone())
            .collect(),
        audit_ref: result.execution_audit_ref.clone(),
    }
}

fn verify_delivery_binding(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
) -> Result<(), DeliveryRejection> {
    let Some(binding) = &expected.binding else {
        return Ok(());
    };
    if result.action_id.as_ref() != Some(&binding.action_id)
        || result.prompt_path.as_ref().map(|path| path.0.as_str())
            != Some(binding.prompt_path.as_str())
        || result
            .prompt_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.prompt_digest.as_str())
        || result.spec_path.as_ref().map(|path| path.0.as_str()) != Some(binding.spec_path.as_str())
        || result.spec_digest.as_ref().map(|digest| digest.0.as_str())
            != Some(binding.spec_digest.as_str())
        || result.carrier_path.as_ref().map(|path| path.0.as_str())
            != Some(binding.carrier_path.as_str())
        || result
            .boundary_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.boundary_digest.as_str())
        || result
            .result_contract_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.result_contract_digest.as_str())
        || result
            .settings_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.settings_digest.as_str())
        || result
            .context_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.context_digest.as_str())
        || result
            .skills_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.skills_digest.as_str())
        || result
            .subscription_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding.subscription_digest.as_str())
    {
        return Err(DeliveryRejection::Identity);
    }
    Ok(())
}

fn verify_delivery_git_state(
    result: &DeliveryResult,
    expected: &DeliveryExpectation,
    package_commit: &Sha,
    package_tree: &Sha,
) -> Result<(), DeliveryRejection> {
    let actual_worktree = canonical_delivery_worktree(result, expected)?;
    verify_distinct_git_worktree(&actual_worktree, &expected.base_commit)
        .map_err(|_| DeliveryRejection::GitState)?;
    let head = git_stdout_checked(
        &actual_worktree,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    if head.trim() != package_commit.0 {
        return Err(DeliveryRejection::GitState);
    }
    let tree = git_stdout_checked(&actual_worktree, &["rev-parse", "--verify", "HEAD^{tree}"])
        .map_err(|_| DeliveryRejection::GitState)?;
    if tree.trim() != package_tree.0 {
        return Err(DeliveryRejection::GitState);
    }
    git_status_checked(
        &actual_worktree,
        &[
            "merge-base",
            "--is-ancestor",
            &expected.base_commit.0,
            &package_commit.0,
        ],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    let status = git_stdout_bytes_checked(
        &actual_worktree,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    if status_records_block_delivery(&status) {
        return Err(DeliveryRejection::GitState);
    }
    let diff = git_stdout_bytes_checked(
        &actual_worktree,
        &[
            "diff",
            "--name-only",
            "-z",
            &expected.base_commit.0,
            &package_commit.0,
            "--",
        ],
    )
    .map_err(|_| DeliveryRejection::GitState)?;
    let mut actual = git_nul_paths(&diff);
    let claimed_paths = result
        .actual_changed_paths
        .iter()
        .map(|path| path.0.clone())
        .collect::<Vec<_>>();
    let mut claimed = path_bytes(&claimed_paths);
    actual.sort();
    claimed.sort();
    if actual != claimed {
        return Err(DeliveryRejection::GitState);
    }
    Ok(())
}

fn status_records_block_delivery(status: &[u8]) -> bool {
    git_nul_paths(status)
        .iter()
        .any(|record| record.get(..2) != Some(b"??"))
}

fn path_bytes(paths: &[String]) -> Vec<Vec<u8>> {
    paths.iter().map(|path| path.as_bytes().to_vec()).collect()
}

fn git_nul_paths(output: &[u8]) -> Vec<Vec<u8>> {
    output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| path.to_vec())
        .collect()
}

fn verify_distinct_git_worktree(worktree: &Path, base_commit: &Sha) -> Result<(), RunnerError> {
    let canonical = fs::canonicalize(worktree).map_err(io_error)?;
    let marker = canonical.join(".git");
    reject_link_components_for_path(&marker)?;
    let marker_metadata = fs::symlink_metadata(&marker).map_err(io_error)?;
    if !marker_metadata.file_type().is_file() {
        return Err(RunnerError::InvalidSpec(format!(
            "delivery worktree is not a distinct git worktree: {}",
            canonical.display()
        )));
    }
    let inside = git_stdout_checked(&canonical, &["rev-parse", "--is-inside-work-tree"])
        .map_err(RunnerError::Io)?;
    if inside.trim() != "true" {
        return Err(RunnerError::InvalidSpec(format!(
            "delivery worktree is not a git worktree: {}",
            canonical.display()
        )));
    }
    let top = git_stdout_checked(&canonical, &["rev-parse", "--show-toplevel"])
        .map_err(RunnerError::Io)?;
    let top = fs::canonicalize(top.trim()).map_err(io_error)?;
    if top != canonical {
        return Err(RunnerError::InvalidSpec(format!(
            "delivery worktree top drift: expected {}, got {}",
            canonical.display(),
            top.display()
        )));
    }
    let base = git_stdout_checked(
        &canonical,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", base_commit.0),
        ],
    )
    .map_err(RunnerError::Io)?;
    if base.trim() != base_commit.0 {
        return Err(RunnerError::InvalidSpec(
            "delivery base commit is not present in worktree".to_owned(),
        ));
    }
    Ok(())
}

fn git_stdout_checked(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output_checked(cwd, args)?;
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn git_stdout_bytes_checked(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    Ok(git_output_checked(cwd, args)?.stdout)
}

fn git_output_checked(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("git {:?} failed", args));
    }
    Ok(output)
}

fn git_status_checked(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure_message(args, &output, None))
    }
}

fn git_status_checked_with_paths(
    cwd: &Path,
    args: &[&str],
    paths: &[String],
) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .args(paths)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure_message(args, &output, Some(paths.len())))
    }
}

fn git_failure_message(
    args: &[&str],
    output: &std::process::Output,
    path_count: Option<usize>,
) -> String {
    let mut message = match path_count {
        Some(count) => format!("git {:?} with {count} delivery paths failed", args),
        None => format!("git {:?} failed", args),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.trim().is_empty() {
        message.push_str("; stdout=");
        message.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        message.push_str("; stderr=");
        message.push_str(stderr.trim());
    }
    message
}

pub(crate) fn validate_child_boundary(
    spec: &AgentRunSpec,
    raw: &str,
) -> Result<String, kernel::boundary::Rejection> {
    let boundary = spec.boundary_id.0.as_str();
    let mut runtime = boundary_runtime(match boundary {
        "planning.task-atoms.v1" => "planning.task-atoms.v1",
        "planning.scout-dossier.v1" => "planning.scout-dossier.v1",
        "planning.questions.v1" => "planning.questions.v1",
        "planning.work-map.v1" => "planning.work-map.v1",
        "planning.plan-review.v1" => "planning.plan-review.v1",
        _ => "planning.questions.v1",
    });
    runtime.flip_to_enforce();
    match boundary {
        "planning.task-atoms.v1" => {
            let Some(prefix) = spec.atom_id_prefix.as_deref() else {
                runtime.reject("boundary_id=planning.task-atoms.v1; field=atoms.id; expected=runner-issued atom id prefix; got=missing; hint=refuse unbound task atom assignment".to_owned())?;
                return Ok(raw.to_owned());
            };
            let anchors = task_anchor_registry_from_spec(spec, &mut runtime)?;
            crate::planning::accept_task_atoms_for_assignment(raw, &runtime, prefix, &anchors)
        }
        "planning.scout-dossier.v1" => crate::planning::accept_scout_dossier(raw, &runtime),
        "planning.questions.v1" => crate::planning::accept_questions(raw, &runtime),
        "planning.work-map.v1" => {
            let (path, digest) = atom_registry_binding_from_spec(spec, &mut runtime)?;
            let atom_ids = match crate::planning::load_atom_registry_ids(Path::new(path), digest) {
                Ok(ids) => ids,
                Err(error) => {
                    runtime.reject(format!(
                        "boundary_id=planning.work-map.v1; field=atom_registry; expected=spec-bound atom registry {digest}; got={error:?}; hint=repair package registry binding before accepting work-map"
                    ))?;
                    return Ok(raw.to_owned());
                }
            };
            crate::planning::accept_work_map_for_atoms(raw, &runtime, &atom_ids, digest)
        }
        "planning.plan-review.v1" => crate::planning::accept_plan_review(raw, &runtime),
        other => {
            runtime.reject(format!("unknown-boundary:{other}"))?;
            Ok(raw.to_owned())
        }
    }
}

pub(crate) fn task_anchor_registry_from_spec(
    spec: &AgentRunSpec,
    runtime: &mut kernel::boundary::BoundaryRuntime,
) -> Result<crate::planning::TaskAnchorRegistry, kernel::boundary::Rejection> {
    let Some(authority_set_id) = spec.authority_set_id.as_ref() else {
        runtime.reject("boundary_id=planning.task-atoms.v1; field=authority_set_id; expected=runner-issued task authority; got=missing; hint=refuse unbound task atom assignment".to_owned())?;
        unreachable!("runtime.reject returns Err in enforce mode")
    };
    let Some(authority_documents) = spec.authority_documents.as_ref() else {
        runtime.reject("boundary_id=planning.task-atoms.v1; field=authority_documents; expected=runner-issued task documents; got=missing; hint=refuse unbound task atom assignment".to_owned())?;
        unreachable!("runtime.reject returns Err in enforce mode")
    };
    let Some(context_document) = spec.context_document.as_ref() else {
        runtime.reject("boundary_id=planning.task-atoms.v1; field=context_document; expected=runner-issued context document; got=missing; hint=refuse unbound task atom assignment".to_owned())?;
        unreachable!("runtime.reject returns Err in enforce mode")
    };
    let authority_documents = authority_documents
        .iter()
        .map(|document| planning_task_document_from_contract(document, crate::planning::TaskDocumentClass::Authority, authority_set_id))
        .collect::<Vec<_>>();
    let context_documents = vec![planning_task_document_from_contract(
        context_document,
        crate::planning::TaskDocumentClass::ContextNonAuthority,
        authority_set_id,
    )];
    Ok(crate::planning::TaskAnchorRegistry::from_input_set(
        &crate::planning::TaskInputSet {
            authority_set_id: authority_set_id.clone(),
            authority_documents,
            context_documents,
        },
    ))
}

fn planning_task_document_from_contract(
    document: &ContractTaskDocument,
    class: crate::planning::TaskDocumentClass,
    authority_set_id: &str,
) -> crate::planning::TaskDocument {
    crate::planning::TaskDocument {
        id: document.path.0.clone(),
        path: document.path.0.clone(),
        class,
        authority_set_id: authority_set_id.to_owned(),
        body: document.body.clone(),
        digest: document.digest.0.clone(),
    }
}

pub(crate) fn atom_registry_binding_from_spec<'a>(
    spec: &'a AgentRunSpec,
    runtime: &mut kernel::boundary::BoundaryRuntime,
) -> Result<(&'a str, &'a str), kernel::boundary::Rejection> {
    let Some(path) = spec.atom_registry_path.as_ref().map(|path| path.0.as_str()) else {
        runtime.reject("boundary_id=planning.work-map.v1; field=atom_registry_path; expected=spec-bound atom registry path; got=missing; hint=refuse unbound work-map assignment".to_owned())?;
        unreachable!("runtime.reject returns Err in enforce mode")
    };
    let Some(digest) = spec.atom_registry_digest.as_ref().map(|digest| digest.0.as_str()) else {
        runtime.reject("boundary_id=planning.work-map.v1; field=atom_registry_digest; expected=spec-bound atom registry digest; got=missing; hint=refuse unbound work-map assignment".to_owned())?;
        unreachable!("runtime.reject returns Err in enforce mode")
    };
    Ok((path, digest))
}
