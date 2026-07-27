struct TaskFiles(Vec<PathBuf>);
impl TaskAuthority for TaskFiles { fn documents(&self) -> Result<Vec<TaskDocument>, planning::PlanningError> { let mut out = Vec::new(); for path in &self.0 { let body = fs::read_to_string(path).map_err(|error| planning::PlanningError::ContextGap(format!("task-file:{}:{error}", path.display())))?; out.push(TaskDocument { id: path.display().to_string(), body }); } Ok(out) } }
struct InlineTask(String);
impl TaskAuthority for InlineTask { fn documents(&self) -> Result<Vec<TaskDocument>, planning::PlanningError> { Ok(vec![TaskDocument { id: "operator-request".to_owned(), body: self.0.clone() }]) } }

struct RepoGrounding { repo: PathBuf }
impl planning::RepositoryEvidence for RepoGrounding {
    fn facts_for_atoms(&self, atoms: &[planning::Atom]) -> Result<Vec<String>, planning::PlanningError> {
        let tip = git_stdout(&self.repo, &["rev-parse", "--verify", "HEAD"]).map_err(planning::PlanningError::ContextGap)?;
        let files = git_stdout(&self.repo, &["ls-files"]).map_err(planning::PlanningError::ContextGap)?;
        let mut facts = Vec::new();
        for file in files.lines().filter(|line| !line.trim().is_empty()).take(64) {
            let path = self.repo.join(file);
            let body = fs::read_to_string(&path).map_err(|error| planning::PlanningError::ContextGap(format!("read:{}:{error}", path.display())))?;
            let summary = body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
            if !summary.is_empty() { facts.push(format!("repo-file:{file}:head={}:line={summary}", tip.trim())); }
        }
        if facts.is_empty() || atoms.is_empty() { return Err(planning::PlanningError::NoRepositoryEvidence); }
        Ok(facts)
    }
}

#[derive(Clone, Debug)]
struct AgentAssignment { assignment_id: String, role: String, mode: String, boundary_id: Option<String> }
#[derive(Debug, Deserialize)]
struct AgentCarrier { workstream: String, boundary_id: String, raw_output: String }
#[derive(Debug, Deserialize, Serialize)]
struct ApprovedPlanArtifact { units: Vec<ApprovedUnit> }

fn planning_assignments(workstream: &str, plan: &planning::AssignmentPlan) -> Vec<AgentAssignment> {
    let mut out = Vec::new();
    push_assignments(&mut out, workstream, "extractor", "planning-extract", Some("planning.task-atoms.v1"), plan.task_extractors);
    push_assignments(&mut out, workstream, "scout", "planning-ground", Some("planning.scout-dossier.v1"), plan.scout_and_compiler_first_pass / 2);
    push_assignments(&mut out, workstream, "compiler", "planning-compile", Some("planning.work-map.v1"), plan.scout_and_compiler_first_pass - (plan.scout_and_compiler_first_pass / 2));
    push_assignments(&mut out, workstream, "curator", "planning-curate", Some("planning.scout-dossier.v1"), plan.context_curator);
    push_assignments(&mut out, workstream, "synthesizer", "planning-synthesize", Some("planning.work-map.v1"), plan.synthesizers);
    push_assignments(&mut out, workstream, "reviewer", "planning-review", Some("planning.plan-review.v1"), plan.reviewer);
    push_assignments(&mut out, workstream, "resolver", "planning-resolve", Some("planning.questions.v1"), plan.reserved_resolution);
    out
}
fn push_assignments(out: &mut Vec<AgentAssignment>, workstream: &str, role: &str, mode: &str, boundary_id: Option<&str>, count: u8) {
    for index in 1..=count { out.push(AgentAssignment { assignment_id: format!("planning-{workstream}-{role}-{index:02}"), role: role.to_owned(), mode: mode.to_owned(), boundary_id: boundary_id.map(str::to_owned) }); }
}
fn planning_bg_action(assignment: &AgentAssignment, run_revision: u64) -> BackgroundAction {
    let boundary = assignment.boundary_id.as_deref().unwrap_or("none");
    BackgroundAction { action_id: idv(&format!("action-{}", assignment.assignment_id)), assignment_id: idv(&assignment.assignment_id), kind: kernel::generated::ActionKind::LaunchBackground, command_bytes: kernel::generated::Bytes(format!("autopilot-agent-run --assignment {} --session .pi/autopilot/planning/{}.json --no-auto-compact --role {} --mode {} --boundary {} --roster openai-codex/gpt-subscription", assignment.assignment_id, assignment.assignment_id, assignment.role, assignment.mode, boundary)), display_name: "autopilot-agent-run".to_owned(), is_agent: true, timeout: None, notify_on_completion: true, trigger_on_completion: true, run_revision, expires_at: None, supersession_state: kernel::generated::SupersessionState("live".to_owned()) }
}
fn append_agent_invocation(state: &mut CoreState, workstream: &str, assignment: &AgentAssignment) -> Result<(), AnyError> {
    let mut refs = vec![Ref(workstream.to_owned()), Ref(assignment.assignment_id.clone()), Ref(assignment.role.clone()), Ref(assignment.mode.clone())];
    if let Some(boundary) = &assignment.boundary_id { refs.push(Ref(boundary.clone())); }
    state.append(EventKind("agent:spawn".to_owned()), refs)
}
fn next_planning_assignment(workstream: &str, state: &CoreState) -> Option<AgentAssignment> {
    planning_assignments(workstream, &planning::AssignmentPlan::d72_default()).into_iter().find(|assignment| !state.state.refs.contains_key(&Ref(assignment.assignment_id.clone())))
}
fn validate_agent_output(boundary: &str, raw: &str) -> Result<String, Rejection> {
    let mut runtime = planning::boundary_runtime(match boundary { "planning.task-atoms.v1" => "planning.task-atoms.v1", "planning.scout-dossier.v1" => "planning.scout-dossier.v1", "planning.questions.v1" => "planning.questions.v1", "planning.work-map.v1" => "planning.work-map.v1", "planning.plan-review.v1" => "planning.plan-review.v1", _ => "planning.questions.v1" });
    runtime.flip_to_enforce();
    match boundary {
        "planning.task-atoms.v1" => planning::accept_task_atoms(raw, &runtime),
        "planning.scout-dossier.v1" => planning::accept_scout_dossier(raw, &runtime),
        "planning.questions.v1" => planning::accept_questions(raw, &runtime),
        "planning.work-map.v1" => planning::accept_work_map(raw, &runtime),
        "planning.plan-review.v1" => planning::accept_plan_review(raw, &runtime),
        other => { runtime.reject(format!("unknown-boundary:{other}"))?; Ok(raw.to_owned()) },
    }
}
fn write_planning_manifest(workstream: &str, inventory: &planning::Inventory, dossier: &planning::Dossier, assignments: &[AgentAssignment]) -> Result<(), AnyError> {
    let dir = workstream_dir(workstream); fs::create_dir_all(&dir)?;
    let body = serde_json::json!({"workstream":workstream,"atoms":inventory.atoms.len(),"verified_facts":dossier.verified_facts,"assignments":assignments.iter().map(|item| &item.assignment_id).collect::<Vec<_>>()});
    fs::write(dir.join("planning-manifest.json"), serde_json::to_vec_pretty(&body)?)?;
    Ok(())
}
fn write_work_map(workstream: &str, raw: &str) -> Result<(), AnyError> { let path = work_map_path(workstream); if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; } fs::write(path, raw)?; Ok(()) }
fn read_work_map(workstream: &str) -> Result<String, String> { fs::read_to_string(work_map_path(workstream)).map_err(|error| error.to_string()) }
fn write_approved_plan(workstream: &str, units: &[ApprovedUnit]) -> Result<(), AnyError> { let path = plan_path(workstream); if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; } fs::write(path, serde_json::to_vec_pretty(&ApprovedPlanArtifact { units: units.to_vec() })?)?; Ok(()) }
fn read_approved_plan(workstream: &str) -> Result<Vec<ApprovedUnit>, String> { let text = fs::read_to_string(plan_path(workstream)).map_err(|error| error.to_string())?; let artifact: ApprovedPlanArtifact = serde_json::from_str(&text).map_err(|error| error.to_string())?; if artifact.units.is_empty() { return Err("empty approved plan".to_owned()); } Ok(artifact.units) }
fn parse_approved_units(raw: &str) -> Result<Vec<ApprovedUnit>, String> {
    let mut units = Vec::new(); let mut current_id: Option<String> = None; let mut current_criteria = Vec::new(); let mut current_objective = String::new();
    for line in raw.lines().chain(std::iter::once("### unit")) {
        let trimmed = line.trim();
        if trimmed.starts_with("### unit") { if let Some(name) = current_id.take() { if current_criteria.is_empty() || current_objective.is_empty() { return Err(format!("unit {name} missing criteria/objective")); } units.push(plan_unit(&name, units.len() as u32 + 1, &current_criteria)); current_criteria.clear(); current_objective.clear(); } continue; }
        let normalized = trimmed.trim_start_matches(['-', '*']).trim().trim_matches('*');
        if let Some((field, value)) = normalized.split_once(':') {
            let field = field.trim().trim_matches('*').to_ascii_lowercase(); let value = value.trim().trim_matches('*').trim();
            if field == "id" { current_id = Some(value.to_owned()); }
            if field == "objective" { current_objective = value.to_owned(); }
            if field.contains("acceptance criteria") { current_criteria.push(format!("AC-{}", current_id.as_deref().unwrap_or("unit"))); }
        } else if current_id.is_some() && !trimmed.is_empty() && (trimmed.starts_with('-') || trimmed.starts_with('*')) { current_criteria.push(format!("AC-{}-{}", current_id.as_deref().unwrap_or("unit"), current_criteria.len() + 1)); }
    }
    if units.len() < 3 { return Err(format!("expected at least 3 approved units, got {}", units.len())); }
    Ok(units)
}
fn plan_unit(name: &str, order: u32, criteria: &[String]) -> ApprovedUnit { ApprovedUnit { id: idv(name), operator_order: order, decisions: Vec::new(), criteria: criteria.iter().map(|item| idv(item)).collect(), dependencies: if order <= 1 { Vec::new() } else { vec![idv(&format!("U{}", order - 1))] }, predecessor_forward_criteria: if order <= 1 { Vec::new() } else { vec![idv(&format!("FC{}", order - 1))] }, downstream_release_edges: vec![idv(&format!("EDGE{order}"))] } }
fn allocation_submission_from_plan(workstream: &str, approved: &[ApprovedUnit]) -> Result<AllocationSubmission, String> {
    if approved.len() < 3 { return Err(format!("expected 3-6 approved units, got {}", approved.len())); }
    let lanes = approved.iter().take(6).enumerate().map(|(index, unit)| AllocationLaneProposal { lane_id: idv(&format!("L{}", index + 1)), objective: format!("deliver approved unit {}", unit.id.0), ordered_unit_ids: vec![unit.id.clone()], rationale: format!("unit {} from approved plan", unit.id.0), delivery_boundary: DeliveryBoundary("approved-plan-unit".to_owned()), predecessor_forward_criteria: unit.predecessor_forward_criteria.clone(), downstream_release_edges: unit.downstream_release_edges.clone(), context_family_id: idv(&format!("approved-plan:{workstream}")), context_estimate: 100, focused_tests: vec![TestId("cargo test -q".to_owned())], launch_wave: index as u32, continue_existing_logical_lane: None }).collect();
    Ok(AllocationSubmission { lanes, future_units: approved.iter().skip(6).map(|unit| FutureUnit { unit_id: unit.id.clone(), reason: "parallel cap lane limit; retained for future allocation".to_owned() }).collect(), authority_echo: approved.to_vec(), ownership_claims: Vec::new(), overlap_blocks: Vec::new() })
}
fn lane_readiness_from_events(lanes: &[AllocationLaneProposal], approved: &[ApprovedUnit], state: &CoreState) -> Vec<LaneReadiness> {
    lanes.iter().map(|lane| { let units = lane.ordered_unit_ids.iter().filter_map(|id| approved.iter().find(|unit| unit.id == *id)).collect::<Vec<_>>(); LaneReadiness { lane_id: lane.lane_id.clone(), predecessor_gates_met: units.iter().flat_map(|unit| &unit.predecessor_forward_criteria).all(|gate| state.state.refs.contains_key(&Ref(format!("gate:{}", gate.0))) || unit_has_no_predecessor(gate, approved)), blockers_clear: !state.state.refs.contains_key(&Ref(format!("blocker:{}", lane.lane_id.0))), unit_free: lane.ordered_unit_ids.iter().all(|unit| !state.state.refs.contains_key(&Ref(format!("unit-active:{}", unit.0)))), route_ready: plan_path_from_lane(lane).is_some_and(|path| path.exists()), preflight_passed: git_stdout(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")), &["rev-parse", "--verify", "HEAD"]).is_ok(), pressure_delay: false } }).collect()
}
fn unit_has_no_predecessor(_gate: &Id, _approved: &[ApprovedUnit]) -> bool { false }
fn plan_path_from_lane(lane: &AllocationLaneProposal) -> Option<PathBuf> { let workstream_ref = lane.context_family_id.0.strip_prefix("approved-plan:")?; Some(plan_path(workstream_ref)) }
fn active_implementers(state: &CoreState) -> usize { state.state.refs.keys().filter(|reference| reference.0.starts_with("unit-active:")).count() }
fn assignment(workstream: &str, lane_id: &Id) -> Result<RunnerAssignment, AnyError> { let cwd = std::env::current_dir()?; let base = git_stdout(&cwd, &["rev-parse", "--verify", "HEAD"]).map_err(|error| format!("CONTEXT_GAP:base-commit:{error}"))?; Ok(RunnerAssignment { action_id: idv(&format!("action-{workstream}-{}", lane_id.0)), assignment_id: idv(&format!("assignment-{workstream}-{}", lane_id.0)), role_id: idv("implementer"), mode: ModeId("lane-delivery".to_owned()), run_revision: 1, lane_id: lane_id.clone(), attempt: 1, base_commit: Sha(base.trim().to_owned()), worktree: PathBuf::from(format!(".pi/autopilot/{workstream}/worktrees/{}", lane_id.0)), session_file: PathBuf::from(format!(".pi/autopilot/{workstream}/session.json")), roster_assignment: "openai-codex/gpt-subscription".to_owned() }) }
fn host_resource_facts() -> Result<ResourceFacts, String> { Ok(ResourceFacts { free_storage_bytes: df_available_bytes(std::env::current_dir().map_err(|error| error.to_string())?)?, projected_storage_bytes: 1, available_memory_bytes: available_memory_bytes()?, physical_memory_bytes: physical_memory_bytes()? }) }
fn df_available_bytes(path: PathBuf) -> Result<u64, String> { let output = Command::new("df").arg("-k").arg(path).output().map_err(|error| error.to_string())?; if !output.status.success() { return Err("df failed".to_owned()); } let text = String::from_utf8(output.stdout).map_err(|error| error.to_string())?; let line = text.lines().nth(1).ok_or_else(|| "df missing data".to_owned())?; let blocks = line.split_whitespace().nth(3).ok_or_else(|| "df missing available column".to_owned())?.parse::<u64>().map_err(|error| error.to_string())?; Ok(blocks.saturating_mul(1024)) }
fn physical_memory_bytes() -> Result<u64, String> { if let Ok(text) = fs::read_to_string("/proc/meminfo") { for line in text.lines() { if let Some(value) = line.strip_prefix("MemTotal:") { return value.split_whitespace().next().ok_or_else(|| "MemTotal missing".to_owned())?.parse::<u64>().map(|kb| kb.saturating_mul(1024)).map_err(|error| error.to_string()); } } } let output = Command::new("sysctl").args(["-n", "hw.memsize"]).output().map_err(|error| error.to_string())?; if !output.status.success() { return Err("sysctl hw.memsize failed".to_owned()); } String::from_utf8(output.stdout).map_err(|error| error.to_string())?.trim().parse::<u64>().map_err(|error| error.to_string()) }
fn available_memory_bytes() -> Result<u64, String> { if let Ok(text) = fs::read_to_string("/proc/meminfo") { for line in text.lines() { if let Some(value) = line.strip_prefix("MemAvailable:") { return value.split_whitespace().next().ok_or_else(|| "MemAvailable missing".to_owned())?.parse::<u64>().map(|kb| kb.saturating_mul(1024)).map_err(|error| error.to_string()); } } } physical_memory_bytes() }
fn git_stdout(repo: &Path, args: &[&str]) -> Result<String, String> { let output = Command::new("git").current_dir(repo).args(args).output().map_err(|error| error.to_string())?; if !output.status.success() { return Err(format!("git {:?} failed", args)); } String::from_utf8(output.stdout).map_err(|error| error.to_string()) }
fn workstream_dir(workstream: &str) -> PathBuf { PathBuf::from(".pi/autopilot").join(workstream) }
fn work_map_path(workstream: &str) -> PathBuf { workstream_dir(workstream).join("work-map.md") }
fn plan_path(workstream: &str) -> PathBuf { workstream_dir(workstream).join("approved-plan.json") }
fn context_status(scope: &str, error: planning::PlanningError) -> String { match error { planning::PlanningError::ContextGap(detail) => format!("CONTEXT_GAP:{scope}:{detail}"), other => format!("{scope}:{other:?}") } }
fn idv(value: &str) -> Id { Id(value.to_owned()) }
fn routes() -> Result<Vec<Route>, String> {
    let mut out = Vec::new();
    for raw in COMMANDS_KDL.lines() {
        let line = match raw.split_once("//") { Some((head, _)) => head.trim(), None => raw.trim() };
        if line.is_empty() || begins(line, "schema ") || begins(line, "version ") { continue; }
        if !begins(line, "command ") { return Err(format!("expected command: {line}")); }
        let name = quoted(line).ok_or_else(|| format!("missing command name: {line}"))?;
        out.push(Route { name, driver: need_attr(line, "driver=")?, args: need_attr(line, "args=")?, expects: need_attr(line, "expects=")? });
    }
    if out.is_empty() { Err("no commands".to_owned()) } else { Ok(out) }
}
fn need_attr(line: &str, key: &str) -> Result<String, String> { let at = line.find(key).ok_or_else(|| format!("missing {key}: {line}"))?; let rest = &line[at + key.len()..]; let quoted = rest.strip_prefix('"').ok_or_else(|| format!("unquoted {key}: {line}"))?; let end = quoted.find('"').ok_or_else(|| format!("unterminated {key}: {line}"))?; Ok(quoted[..end].to_owned()) }
fn begins(value: &str, prefix: &str) -> bool { value.get(..prefix.len()) == Some(prefix) }
fn quoted(line: &str) -> Option<String> { let mut parts = line.split('"'); let _before = parts.next()?; parts.next().map(str::to_owned) }
fn valid(routes: &[Route]) -> String { routes.iter().map(|route| format!("/{}", route.name)).collect::<Vec<_>>().join(", ") }
