struct TaskFiles(Vec<PathBuf>);
impl TaskAuthority for TaskFiles { fn input_set(&self) -> Result<planning::TaskInputSet, planning::PlanningError> { let cwd = std::env::current_dir().map_err(|error| planning::PlanningError::ContextGap(format!("cwd:{error}")))?; planning::classify_task_file_pack(&cwd, &self.0) } }
struct InlineTask(String);
impl TaskAuthority for InlineTask { fn input_set(&self) -> Result<planning::TaskInputSet, planning::PlanningError> { planning::inline_task_input(self.0.clone()) } }

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
struct AgentCarrier {
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
    spec_digest: String,
    spec_path: String,
    carrier_path: String,
    raw_output: String,
}
#[derive(Debug, Deserialize, Serialize)]
struct ApprovedPlanArtifact { units: Vec<ApprovedUnit> }

fn planning_assignments(workstream: &str, plan: &planning::AssignmentPlan) -> Vec<AgentAssignment> {
    let mut out = Vec::new();
    push_assignments(&mut out, workstream, "task-extractor", "inventory", Some("planning.task-atoms.v1"), plan.task_extractors);
    push_assignments(&mut out, workstream, "repository-scout", "initial-grounding", Some("planning.scout-dossier.v1"), plan.scout_and_compiler_first_pass / 2);
    push_assignments(&mut out, workstream, "plan-compiler", "initial-plan", Some("planning.work-map.v1"), plan.scout_and_compiler_first_pass - (plan.scout_and_compiler_first_pass / 2));
    push_assignments(&mut out, workstream, "context-curator", "planning-context", Some("planning.scout-dossier.v1"), plan.context_curator);
    push_assignments(&mut out, workstream, "plan-synthesizer", "initial-plan", Some("planning.work-map.v1"), plan.synthesizers);
    push_assignments(&mut out, workstream, "plan-reviewer", "full-review", Some("planning.plan-review.v1"), plan.reviewer);
    push_assignments(&mut out, workstream, "contradiction-resolver", "fact-resolution", Some("planning.questions.v1"), plan.reserved_resolution);
    out
}
fn push_assignments(out: &mut Vec<AgentAssignment>, workstream: &str, role: &str, mode: &str, boundary_id: Option<&str>, count: u8) {
    for index in 1..=count { out.push(AgentAssignment { assignment_id: format!("planning-{workstream}-{role}-{index:02}"), role: role.to_owned(), mode: mode.to_owned(), boundary_id: boundary_id.map(str::to_owned) }); }
}
fn planning_bg_action(workstream: &str, assignment: &AgentAssignment, run_revision: u64, input_set: &planning::TaskInputSet) -> Result<runner::IssuedRunnerAction, runner::RunnerError> {
    let context = input_set.context_documents.first().ok_or_else(|| runner::RunnerError::InvalidSpec("missing planning context".to_owned()))?;
    runner::planning_issue(&runner::PlanningRunnerRequest {
        workstream: workstream.to_owned(),
        action_id: idv(&format!("action-{}", assignment.assignment_id)),
        assignment_id: idv(&assignment.assignment_id),
        role_id: idv(&assignment.role),
        mode: ModeId(assignment.mode.clone()),
        boundary_id: kernel::generated::ContractId(assignment.boundary_id.clone().unwrap_or_else(|| "planning.questions.v1".to_owned())),
        run_revision,
        authority_set_id: input_set.authority_set_id.clone(),
        authority_documents: input_set.authority_documents.iter().map(runner_doc_from_task).collect(),
        context_document: runner_doc_from_task(context),
    })
}
fn append_runner_invocation(state: &mut CoreState, binding: &runner::IssuedRunnerBinding) -> Result<(), AnyError> {
    let mut refs = vec![
        Ref(binding.workstream.0.clone()),
        Ref(binding.assignment_id.0.clone()),
        Ref(binding.action_id.0.clone()),
        Ref(binding.role_id.0.clone()),
        Ref(binding.mode.0.clone()),
        Ref(binding.boundary_id.0.clone()),
        Ref(format!("action-assignment:{}:{}:{}", binding.action_id.0, binding.assignment_id.0, binding.run_revision)),
        runner::binding_ref(binding)?,
    ];
    if let Some(lane_id) = &binding.lane_id { refs.push(Ref(format!("lane:{}", lane_id.0))); }
    state.append(EventKind("agent:spawn".to_owned()), refs)
}
fn runner_doc_from_task(document: &planning::TaskDocument) -> runner::RunnerTaskDocument {
    let class = match document.class {
        planning::TaskDocumentClass::Authority => "authority",
        planning::TaskDocumentClass::ContextNonAuthority => "context/non-authority",
        planning::TaskDocumentClass::HistoricalNonAuthority => "historical/non-authority",
        planning::TaskDocumentClass::IndexNonAuthority => "index/non-authority",
        planning::TaskDocumentClass::InlineTask => "inline-task",
    };
    runner::RunnerTaskDocument::new(document.path.clone(), class.to_owned(), document.digest.clone(), document.body.clone())
}
fn next_planning_assignment(workstream: &str, state: &CoreState) -> Option<AgentAssignment> {
    planning_assignments(workstream, &planning::AssignmentPlan::d72_default()).into_iter().find(|assignment| !state.state.refs.contains_key(&Ref(assignment.assignment_id.clone())))
}
fn validate_agent_output(boundary: &str, raw: &str) -> Result<String, Rejection> { runner::validate_child_boundary(boundary, raw) }
fn write_planning_manifest(workstream: &str, input_set: &planning::TaskInputSet, inventory: &planning::Inventory, dossier: &planning::Dossier, assignments: &[AgentAssignment]) -> Result<(), AnyError> {
    let dir = workstream_dir(workstream); fs::create_dir_all(&dir)?;
    let context = input_set.context_documents.first().ok_or("missing context document")?;
    let authority_docs = input_set.authority_documents.iter().map(runner_doc_from_task).map(|doc| serde_json::to_value(doc).expect("runner doc json")).collect::<Vec<_>>();
    let context_doc = runner_doc_from_task(context);
    let body = serde_json::json!({"workstream":workstream,"authority_set_id":input_set.authority_set_id,"authority_paths":input_set.authority_documents.iter().map(|item| &item.path).collect::<Vec<_>>(),"authority_documents":authority_docs,"context":{"path":context.path,"class":"context/non-authority","digest":context.digest},"context_document":context_doc,"file_digests":input_set.authority_documents.iter().chain(input_set.context_documents.iter()).map(|item| serde_json::json!({"path":item.path,"class":format!("{:?}", item.class),"digest":item.digest})).collect::<Vec<_>>(),"atoms":inventory.atoms.len(),"verified_facts":dossier.verified_facts,"assignments":assignments.iter().map(|item| &item.assignment_id).collect::<Vec<_>>()});
    fs::write(dir.join("planning-manifest.json"), serde_json::to_vec_pretty(&body)?)?;
    Ok(())
}
fn read_planning_input_set(workstream: &str) -> Result<planning::TaskInputSet, String> {
    let text = fs::read_to_string(workstream_dir(workstream).join("planning-manifest.json")).map_err(|error| error.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let authority_set_id = value["authority_set_id"].as_str().ok_or_else(|| "missing authority_set_id".to_owned())?.to_owned();
    let authority_documents = value["authority_documents"].as_array().ok_or_else(|| "missing authority_documents".to_owned())?.iter().enumerate().map(|(index, item)| task_doc_from_manifest(item, planning::TaskDocumentClass::Authority, &authority_set_id, index)).collect::<Result<Vec<_>, _>>()?;
    let context_document = task_doc_from_manifest(&value["context_document"], planning::TaskDocumentClass::ContextNonAuthority, &authority_set_id, 3)?;
    Ok(planning::TaskInputSet { authority_set_id, authority_documents, context_documents: vec![context_document] })
}
fn task_doc_from_manifest(value: &serde_json::Value, class: planning::TaskDocumentClass, authority_set_id: &str, index: usize) -> Result<planning::TaskDocument, String> {
    let path = value["path"].as_str().ok_or_else(|| format!("manifest doc {index} missing path"))?.to_owned();
    let digest = value["digest"].as_str().ok_or_else(|| format!("manifest doc {index} missing digest"))?.to_owned();
    let body = value["body"].as_str().ok_or_else(|| format!("manifest doc {index} missing body"))?.to_owned();
    Ok(planning::TaskDocument { id: path.clone(), path, class, authority_set_id: authority_set_id.to_owned(), body, digest })
}
fn write_work_map(workstream: &str, raw: &str) -> Result<(), AnyError> { let path = work_map_path(workstream); if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; } fs::write(path, raw)?; Ok(()) }
fn read_work_map(workstream: &str) -> Result<String, String> { fs::read_to_string(work_map_path(workstream)).map_err(|error| error.to_string()) }
fn write_approved_plan(workstream: &str, units: &[ApprovedUnit]) -> Result<(), AnyError> { let path = plan_path(workstream); if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; } fs::write(path, serde_json::to_vec_pretty(&ApprovedPlanArtifact { units: units.to_vec() })?)?; Ok(()) }
fn read_approved_plan(workstream: &str) -> Result<Vec<ApprovedUnit>, String> { let text = fs::read_to_string(plan_path(workstream)).map_err(|error| error.to_string())?; let artifact: ApprovedPlanArtifact = serde_json::from_str(&text).map_err(|error| error.to_string())?; if artifact.units.is_empty() { return Err("empty approved plan".to_owned()); } Ok(artifact.units) }
fn parse_approved_units(raw: &str) -> Result<Vec<ApprovedUnit>, String> {
    if raw.trim_start().starts_with('{') {
        let work_map: kernel::generated::WorkMap = serde_json::from_str(raw).map_err(|error| error.to_string())?;
        return approved_units_from_work_map(&work_map);
    }
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
fn approved_units_from_work_map(work_map: &kernel::generated::WorkMap) -> Result<Vec<ApprovedUnit>, String> {
    if work_map.units.len() < 3 { return Err(format!("expected at least 3 approved units, got {}", work_map.units.len())); }
    work_map.units.iter().enumerate().map(|(index, unit)| {
        if unit.id.0.trim().is_empty() || unit.objective.trim().is_empty() || unit.criteria.is_empty() { return Err(format!("unit {} missing criteria/objective", unit.id.0)); }
        let order = index as u32 + 1;
        Ok(ApprovedUnit { id: unit.id.clone(), operator_order: order, decisions: Vec::new(), criteria: unit.criteria.iter().enumerate().map(|(criterion_index, _)| idv(&format!("AC-{}-{}", unit.id.0, criterion_index + 1))).collect(), dependencies: if index == 0 { Vec::new() } else { vec![work_map.units[index - 1].id.clone()] }, predecessor_forward_criteria: if order <= 1 { Vec::new() } else { vec![idv(&format!("FC{}", order - 1))] }, downstream_release_edges: vec![idv(&format!("EDGE{order}"))] })
    }).collect()
}
fn plan_unit(name: &str, order: u32, criteria: &[String]) -> ApprovedUnit { ApprovedUnit { id: idv(name), operator_order: order, decisions: Vec::new(), criteria: criteria.iter().map(|item| idv(item)).collect(), dependencies: if order <= 1 { Vec::new() } else { vec![idv(&format!("U{}", order - 1))] }, predecessor_forward_criteria: if order <= 1 { Vec::new() } else { vec![idv(&format!("FC{}", order - 1))] }, downstream_release_edges: vec![idv(&format!("EDGE{order}"))] } }
fn allocation_submission_from_plan(workstream: &str, approved: &[ApprovedUnit]) -> Result<AllocationSubmission, String> {
    if approved.len() < 3 { return Err(format!("expected 3-6 approved units, got {}", approved.len())); }
    let lanes = approved.iter().take(6).enumerate().map(|(index, unit)| AllocationLaneProposal { lane_id: idv(&format!("L{}", index + 1)), objective: format!("deliver approved unit {}", unit.id.0), ordered_unit_ids: vec![unit.id.clone()], rationale: format!("unit {} from approved plan", unit.id.0), delivery_boundary: DeliveryBoundary("approved-plan-unit".to_owned()), predecessor_forward_criteria: unit.predecessor_forward_criteria.clone(), downstream_release_edges: unit.downstream_release_edges.clone(), context_family_id: idv(&format!("approved-plan:{workstream}")), context_estimate: 100, focused_tests: vec![TestId("cargo test -q".to_owned())], launch_wave: index as u32, continue_existing_logical_lane: None }).collect();
    Ok(AllocationSubmission { lanes, future_units: approved.iter().skip(6).map(|unit| FutureUnit { unit_id: unit.id.clone(), reason: "parallel cap lane limit; retained for future allocation".to_owned() }).collect(), authority_echo: approved.to_vec(), ownership_claims: Vec::new(), overlap_blocks: Vec::new() })
}
fn lane_readiness_from_events(lanes: &[AllocationLaneProposal], approved: &[ApprovedUnit], state: &CoreState) -> Vec<LaneReadiness> {
    lanes.iter().map(|lane| { let units = lane.ordered_unit_ids.iter().filter_map(|id| approved.iter().find(|unit| unit.id == *id)).collect::<Vec<_>>(); LaneReadiness { lane_id: lane.lane_id.clone(), predecessor_gates_met: units.iter().flat_map(|unit| &unit.predecessor_forward_criteria).all(|gate| state.state.refs.contains_key(&Ref(format!("gate:{}", gate.0))) || unit_has_no_predecessor(gate, approved)), blockers_clear: !state.state.refs.contains_key(&Ref(format!("blocker:{}", lane.lane_id.0))), unit_free: lane.ordered_unit_ids.iter().all(|unit| !state.state.refs.contains_key(&Ref(format!("unit-active:{}", unit.0)))), route_ready: true, preflight_passed: git_stdout(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")), &["rev-parse", "--verify", "HEAD"]).is_ok(), pressure_delay: false } }).collect()
}
fn unit_has_no_predecessor(_gate: &Id, _approved: &[ApprovedUnit]) -> bool { false }
fn active_implementers(state: &CoreState) -> usize { state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)).filter(|binding| binding.role_id.0 == "implementer" && !terminal_consumed(state, binding)).count() }
fn assignment(workstream: &str, lane_id: &Id) -> Result<RunnerAssignment, AnyError> {
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    let base = git_stdout(&cwd, &["rev-parse", "--verify", "HEAD^{commit}"]).map_err(|error| format!("CONTEXT_GAP:base-commit:{error}"))?;
    let base = Sha(base.trim().to_owned());
    let worktree = prepare_delivery_worktree(&cwd, workstream, lane_id, &base).map_err(|error| format!("CONTEXT_GAP:worktree:{error}"))?;
    Ok(RunnerAssignment {
        workstream: idv(workstream),
        action_id: idv(&format!("action-{workstream}-{}", lane_id.0)),
        assignment_id: idv(&format!("assignment-{workstream}-{}", lane_id.0)),
        role_id: idv("implementer"),
        mode: ModeId("lane-delivery".to_owned()),
        run_revision: 1,
        lane_id: lane_id.clone(),
        attempt: 1,
        base_commit: base,
        worktree,
        session_file: PathBuf::from(format!(".pi/autopilot/{workstream}/session.json")),
        roster_assignment: "openai-codex/gpt-subscription".to_owned(),
    })
}
fn prepare_delivery_worktree(repo: &Path, workstream: &str, lane_id: &Id, base: &Sha) -> Result<PathBuf, String> {
    let worktree = repo.join(".pi/autopilot").join(workstream).join("worktrees").join(&lane_id.0);
    let branch = lane_branch_ref(workstream, lane_id, 1);
    runner::reject_link_components_for_path(&worktree).map_err(|error| error.to_string())?;
    if git_stdout(repo, &["rev-parse", "--verify", &branch]).is_err() { git_status(repo, &["update-ref", &branch, &base.0])?; }
    if !worktree.exists() {
        if let Some(parent) = worktree.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        let checkout = branch.strip_prefix("refs/heads/").ok_or_else(|| format!("lane branch is not under refs/heads: {branch}"))?;
        let output = Command::new("git")
            .current_dir(repo)
            .args(["worktree", "add"])
            .arg(&worktree)
            .arg(checkout)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(format!("git worktree add failed: {}", String::from_utf8_lossy(&output.stderr))); }
    }
    let canonical = fs::canonicalize(&worktree).map_err(|error| error.to_string())?;
    let repo = fs::canonicalize(repo).map_err(|error| error.to_string())?;
    if canonical == repo { return Err("delivery worktree must be distinct from operator checkout".to_owned()); }
    let marker = canonical.join(".git");
    runner::reject_link_components_for_path(&marker).map_err(|error| error.to_string())?;
    let marker_metadata = fs::symlink_metadata(&marker).map_err(|error| error.to_string())?;
    if !marker_metadata.file_type().is_file() { return Err("delivery path is not a linked git worktree".to_owned()); }
    let symref = git_stdout(&canonical, &["symbolic-ref", "-q", "HEAD"])?;
    if symref.trim() != branch { return Err(format!("delivery worktree branch drift: expected {branch}, got {}", symref.trim())); }
    let head = git_stdout(&canonical, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let branch_tip = git_stdout(repo.as_path(), &["rev-parse", "--verify", &branch])?;
    if head.trim() != branch_tip.trim() { return Err(format!("delivery worktree head drift: expected {}, got {}", branch_tip.trim(), head.trim())); }
    let status = git_stdout(&canonical, &["status", "--porcelain"])?;
    if !status.trim().is_empty() { return Err("delivery worktree is dirty before launch".to_owned()); }
    Ok(canonical)
}
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
