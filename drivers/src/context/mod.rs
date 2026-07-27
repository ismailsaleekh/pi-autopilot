use kernel::boundary::{BoundaryDescriptor, BoundaryRuntime, Rejection, boundary_by_id};
use kernel::generated::{
    ContextAnchor, ContextAnchorForm, ContextManifest, ContextManifestBudget,
    ContextManifestFreshness, ContextManifestRole, Digest, Id, Nullable, SchemaId, Sha, Uri,
    Uuidv7,
};
use kernel_macros::acceptance_boundary;

const BOUNDARY_ID: &str = "context.anchor.v1";
const ESTIMATOR: &str = "conservative-utf8-v1";

type AnchorParts<'a> = (&'a str, &'a str);

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BudgetRoute {
    NormalLaunch,
    ReprioritizeOnce,
    SplitAssignment,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct BudgetDecision {
    pub estimated_tokens: u32,
    pub estimated_percent: u8,
    pub route: BudgetRoute,
}

pub fn estimate_tokens(bytes: &[u8], overhead: u32) -> u32 {
    let byte_units = bytes.len().div_ceil(3);
    let base = if byte_units > u32::MAX as usize {
        u32::MAX
    } else {
        byte_units as u32
    };
    let subtotal = base.saturating_add(overhead);
    subtotal.saturating_add(subtotal.saturating_mul(15).div_ceil(100))
}

pub fn route_budget(
    estimated_tokens: u32,
    context_window: u32,
    post_pass_tokens: u32,
) -> BudgetDecision {
    let first = percent(estimated_tokens, context_window);
    let route = if first <= 40 {
        BudgetRoute::NormalLaunch
    } else if percent(post_pass_tokens, context_window) <= 50 {
        BudgetRoute::ReprioritizeOnce
    } else {
        BudgetRoute::SplitAssignment
    };
    BudgetDecision {
        estimated_tokens,
        estimated_percent: first,
        route,
    }
}

pub fn mandatory_pack<T: Clone>(items: &[T], route: BudgetRoute) -> Result<Vec<T>, BudgetRoute> {
    match route {
        BudgetRoute::SplitAssignment => Err(BudgetRoute::SplitAssignment),
        BudgetRoute::NormalLaunch | BudgetRoute::ReprioritizeOnce => Ok(items.to_vec()),
    }
}

pub fn manifest_shell(
    manifest_id: Uuidv7,
    run_id: Uuidv7,
    assignment_id: Id,
    role_id: Id,
    budget: BudgetDecision,
) -> ContextManifest {
    ContextManifest {
        schema: SchemaId("autopilot.context_manifest.v1".to_owned()),
        manifest_id,
        revision: 1,
        run_id,
        assignment_id,
        role: ContextManifestRole {
            id: role_id,
            version: 1,
            mode: kernel::generated::ModeId("lane-delivery".to_owned()),
            mode_version: 1,
        },
        freshness: ContextManifestFreshness {
            task_revision: Digest(String::new()),
            plan_revision: Digest(String::new()),
            dossier_revision: Digest(String::new()),
            runtime_revision: 0,
            git_commit: Sha(String::new()),
        },
        budget: ContextManifestBudget {
            context_window: 0,
            estimated_initial_tokens: budget.estimated_tokens,
            estimated_percent: budget.estimated_percent,
            estimator: ESTIMATOR.to_owned(),
        },
        mandatory_inline: Vec::new(),
        required_reads: Vec::new(),
        on_demand: Vec::new(),
        excluded: Vec::new(),
        gaps: Vec::new(),
        curator_proposal_ref: Nullable(None),
    }
}

#[acceptance_boundary(
    id = "context.anchor.v1",
    producer = Producer::Package,
    visible = true,
    admits = "D76 section 4.1 context anchors must match one of the seven canonical URI forms.",
    mode = BoundaryMode::Enforce
)]
pub fn parse_anchor(raw: &str) -> Result<ContextAnchor, Rejection> {
    let form = if let Some(rest) = raw.strip_prefix("task://") {
        let (body, fragment) = split_hash(rest, raw)?;
        require(body.contains('/'), raw)?;
        require(fragment.strip_prefix("heading=").is_some(), raw)?;
        ContextAnchorForm::Task
    } else if let Some(rest) = raw.strip_prefix("plan://") {
        let (revision, unit) = split_once(rest, "/units/", raw)?;
        require_pair((revision, unit), raw)?;
        ContextAnchorForm::Plan
    } else if let Some(rest) = raw.strip_prefix("dossier://") {
        let (revision, finding) = split_once(rest, "/findings/", raw)?;
        require_pair((revision, finding), raw)?;
        ContextAnchorForm::Dossier
    } else if let Some(rest) = raw.strip_prefix("run://") {
        let (run, finding) = split_once(rest, "/findings/", raw)?;
        require_pair((run, finding), raw)?;
        ContextAnchorForm::Run
    } else if let Some(rest) = raw.strip_prefix("git://") {
        parse_git(rest, raw)?
    } else if let Some(rest) = raw.strip_prefix("json://") {
        let (body, pointer) = split_hash(rest, raw)?;
        require(body.contains('/'), raw)?;
        require(pointer.strip_prefix('/').is_some(), raw)?;
        ContextAnchorForm::Json
    } else {
        rt().reject(raw)?;
        ContextAnchorForm::Json
    };
    Ok(ContextAnchor {
        anchor_form: form,
        uri: Uri(raw.to_owned()),
    })
}

fn parse_git(rest: &str, raw: &str) -> Result<ContextAnchorForm, Rejection> {
    let (body, fragment) = split_hash(rest, raw)?;
    require(body.contains('/'), raw)?;
    if fragment == "whole-file" {
        return Ok(ContextAnchorForm::VersionControlWholeFile);
    }
    let range = match fragment.strip_prefix('L') {
        Some(value) => value,
        None => {
            rt().reject(raw)?;
            ""
        }
    };
    let (left, right) = split_once(range, "-L", raw)?;
    require_u32(left, raw)?;
    require_u32(right, raw)?;
    Ok(ContextAnchorForm::VersionControlLines)
}

fn split_hash<'a>(value: &'a str, raw: &str) -> Result<AnchorParts<'a>, Rejection> {
    split_once(value, "#", raw)
}

fn split_once<'a>(value: &'a str, needle: &str, raw: &str) -> Result<AnchorParts<'a>, Rejection> {
    match value.split_once(needle) {
        Some(parts) => Ok(parts),
        None => {
            rt().reject(raw)?;
            Ok(("", ""))
        }
    }
}

fn require_pair(parts: AnchorParts<'_>, raw: &str) -> Result<(), Rejection> {
    require(!parts.0.is_empty() && !parts.1.is_empty(), raw)
}

fn require(ok: bool, raw: &str) -> Result<(), Rejection> {
    if ok { Ok(()) } else { rt().reject(raw) }
}

fn require_u32(value: &str, raw: &str) -> Result<(), Rejection> {
    require(value.parse::<u32>().is_ok(), raw)
}

fn percent(tokens: u32, window: u32) -> u8 {
    if window == 0 {
        return 100;
    }
    let pct = u64::from(tokens)
        .saturating_mul(100)
        .div_ceil(u64::from(window));
    if pct > u64::from(u8::MAX) {
        u8::MAX
    } else {
        pct as u8
    }
}

fn rt() -> BoundaryRuntime {
    let descriptor: &'static BoundaryDescriptor = match boundary_by_id(BOUNDARY_ID) {
        Some(descriptor) => descriptor,
        None => panic!("missing boundary {BOUNDARY_ID}"),
    };
    match BoundaryRuntime::new(descriptor) {
        Ok(runtime) => runtime,
        Err(error) => panic!("runtime missing for {BOUNDARY_ID}: {error}"),
    }
}
