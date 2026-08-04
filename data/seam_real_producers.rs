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

type AgentAssignment = planning::PlanningAgentAssignment;
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
struct ApprovedPlanArtifact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repository_authority: Option<ApprovedRepositoryAuthority>,
    units: Vec<ApprovedUnit>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ApprovedRepositoryAuthority {
    manifest_path: String,
    manifest_digest: String,
    head_commit: Sha,
    head_tree: Sha,
}

pub const REQUIRED_PLAN_REVIEW_CRITERIA: [&str; 7] =
    planning::REQUIRED_PLAN_REVIEW_CRITERIA;

fn planning_assignments(workstream: &str) -> Result<Vec<AgentAssignment>, planning::PlanningError> {
    let assignments = planning::planning_assignments_for_workstream(workstream)?;
    validate_assignment_mode_parameters(&assignments)?;
    Ok(assignments)
}
fn validate_assignment_mode_parameters(assignments: &[AgentAssignment]) -> Result<(), planning::PlanningError> {
    let roles = crate::roles::RoleRegistry::package().map_err(|error| planning::PlanningError::BadDeclaration(format!("role registry: {error:?}")))?;
    let mut role_ids = assignments.iter().map(|assignment| assignment.role.as_str()).collect::<Vec<_>>();
    role_ids.sort_unstable();
    role_ids.dedup();
    for role_id in role_ids {
        let role = roles.get(role_id).map_err(|error| planning::PlanningError::BadDeclaration(format!("role lookup: {error:?}")))?;
        let count = assignments.iter().filter(|assignment| assignment.role == role_id).count();
        crate::roles::allocate_mode_parameters(role, count).map_err(|error| planning::PlanningError::BadDeclaration(format!("mode parameter allocation: {error:?}")))?;
    }
    Ok(())
}
fn assignment_mode_parameter(assignments: &[AgentAssignment], assignment: &AgentAssignment) -> Result<Option<String>, runner::RunnerError> {
    let roles = crate::roles::RoleRegistry::package().map_err(|error| runner::RunnerError::InvalidSpec(format!("role registry: {error:?}")))?;
    let role = roles.get(&assignment.role).map_err(|error| runner::RunnerError::InvalidSpec(format!("role lookup: {error:?}")))?;
    let role_assignments = assignments.iter().filter(|item| item.role == assignment.role).collect::<Vec<_>>();
    let allocations = crate::roles::allocate_mode_parameters(role, role_assignments.len()).map_err(|error| runner::RunnerError::InvalidSpec(format!("mode parameter allocation: {error:?}")))?;
    let index = role_assignments.iter().position(|item| item.assignment_id == assignment.assignment_id).ok_or_else(|| runner::RunnerError::InvalidSpec(format!("assignment {} not found in role allocation", assignment.assignment_id)))?;
    Ok(allocations[index].clone())
}
fn planning_bg_action(workstream: &str, assignment: &AgentAssignment, run_revision: u64, input_set: &planning::TaskInputSet, atom_registry: Option<(String, String)>, accepted_planning_artifacts: Vec<runner::AcceptedPlanningArtifactBinding>) -> Result<runner::IssuedRunnerAction, runner::RunnerError> {
    let context = input_set.context_documents.first().ok_or_else(|| runner::RunnerError::InvalidSpec("missing planning context".to_owned()))?;
    let assignments = planning_assignments(workstream).map_err(|error| runner::RunnerError::InvalidSpec(format!("planning assignments: {error:?}")))?;
    let mode_parameter = assignment_mode_parameter(&assignments, assignment)?;
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
        context_documents: input_set.context_documents.iter().map(runner_doc_from_task).collect(),
        mode_parameter,
        atom_id_prefix: assignment.atom_id_prefix.clone(),
        atom_registry_path: atom_registry.as_ref().map(|(path, _)| path.clone()),
        atom_registry_digest: atom_registry.as_ref().map(|(_, digest)| digest.clone()),
        accepted_planning_artifacts,
    })
}

fn planning_wave_actions(
    workstream: &str,
    assignments: &[AgentAssignment],
    state: &mut CoreState,
    input_set: &planning::TaskInputSet,
    atom_registry: Option<(String, String)>,
) -> Result<Vec<BackgroundAction>, AnyError> {
    let run_revision = state.state.revision;
    let accepted_artifacts = accepted_planning_artifacts_for_issue(workstream, state)?;
    let mut actions = Vec::new();
    for assignment in assignments {
        let registry = if assignment.boundary_id.as_deref() == Some("planning.work-map.v1") {
            atom_registry.clone()
        } else {
            None
        };
        let issue = planning_bg_action(
            workstream,
            assignment,
            run_revision,
            input_set,
            registry,
            accepted_artifacts.clone(),
        )?;
        append_runner_invocation(state, &issue.binding)?;
        actions.push(issue.action);
    }
    Ok(actions)
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
fn next_planning_outcome(workstream: &str, state: &CoreState) -> Result<planning::PlanningWaveOutcome, planning::PlanningError> {
    let manifest = read_planning_schedule_manifest(workstream).map_err(planning::PlanningError::ContextGap)?;
    let refs = planning_refs_from_state(workstream, state);
    Ok(planning::next_planning_wave(&manifest, &refs, manifest.planning_wave_cap))
}
fn unacknowledged_planning_actions(state: &mut CoreState, active: &[planning::PlanningActiveRef]) -> Result<Vec<BackgroundAction>, AnyError> {
    let issued = issued_actions(state);
    let mut actions = Vec::new();
    let mut recovered = Vec::new();
    for active_ref in active.iter().filter(|active_ref| !active_ref.launch_acknowledged) {
        match issued_action_for_active_ref(&issued, active_ref)? {
            Some(action) => actions.push(action),
            None => {
                let binding = binding_for_active_ref(state, active_ref)?;
                let action = planning_action_from_binding(&binding)?;
                recovered.push(action.clone());
                actions.push(action);
            }
        }
    }
    if !actions.is_empty() {
        validate_spawn_wave_actions(&actions)?;
    }
    if !recovered.is_empty() {
        record_recovered_planning_control_actions(state, &recovered)?;
    }
    Ok(actions)
}

fn issued_action_for_active_ref(issued: &[BackgroundAction], active_ref: &planning::PlanningActiveRef) -> Result<Option<BackgroundAction>, AnyError> {
    let mut matches = issued.iter().filter(|action| action.assignment_id.0 == active_ref.assignment_id && action.action_id.0 == active_ref.action_id && action.run_revision == active_ref.run_revision).cloned().collect::<Vec<_>>();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches.remove(0))),
        count => Err(format!("CONTEXT_GAP:planning-reemit:ambiguous-control-action:{}:{}:{}:{count}", active_ref.assignment_id, active_ref.action_id, active_ref.run_revision).into()),
    }
}

fn binding_for_active_ref(state: &CoreState, active_ref: &planning::PlanningActiveRef) -> Result<runner::IssuedRunnerBinding, AnyError> {
    let mut matches = state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)).filter(|binding| binding.assignment_id.0 == active_ref.assignment_id && binding.action_id.0 == active_ref.action_id && binding.run_revision == active_ref.run_revision && binding.result_contract.0.starts_with("planning.")).collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!("CONTEXT_GAP:planning-reemit:missing-binding:{}:{}:{}", active_ref.assignment_id, active_ref.action_id, active_ref.run_revision).into()),
        count => Err(format!("CONTEXT_GAP:planning-reemit:ambiguous-binding:{}:{}:{}:{count}", active_ref.assignment_id, active_ref.action_id, active_ref.run_revision).into()),
    }
}

fn planning_action_from_binding(binding: &runner::IssuedRunnerBinding) -> Result<BackgroundAction, AnyError> {
    let spec_path = PathBuf::from(&binding.spec_path);
    let spec_bytes = fs::read(&spec_path).map_err(|error| format!("CONTEXT_GAP:planning-reemit:spec-read:{}:{error}", binding.spec_path))?;
    let digest = sha256_hex_local(&spec_bytes);
    if digest != binding.spec_digest { return Err(format!("CONTEXT_GAP:planning-reemit:spec-digest:{}", binding.assignment_id.0).into()); }
    let spec: kernel::generated::AgentRunSpec = serde_json::from_slice(&spec_bytes).map_err(|error| format!("CONTEXT_GAP:planning-reemit:spec-json:{}:{error}", binding.spec_path))?;
    validate_reemit_spec_binding(&spec, binding)?;
    let facts = runner::RunnerTransportFacts::from_env().map_err(|error| format!("CONTEXT_GAP:planning-reemit:transport:{error:?}"))?;
    Ok(BackgroundAction {
        action_id: binding.action_id.clone(),
        assignment_id: binding.assignment_id.clone(),
        kind: kernel::generated::ActionKind::LaunchBackground,
        bg_run: kernel::generated::BackgroundActionBgRun {
            name: format!("autopilot-agent-run {}", binding.assignment_id.0),
            command: kernel::generated::Bytes(runner::try_command_for_spec(&facts, &spec_path).map_err(|error| format!("CONTEXT_GAP:planning-reemit:command:{error:?}"))?),
            is_agent: true,
            timeout_seconds: Some(3600),
            notify_on_completion: true,
            trigger_on_completion: true,
        },
        run_revision: binding.run_revision,
        expires_at: None,
        supersession_state: kernel::generated::SupersessionState("live".to_owned()),
    })
}

fn validate_reemit_spec_binding(spec: &kernel::generated::AgentRunSpec, binding: &runner::IssuedRunnerBinding) -> Result<(), AnyError> {
    if spec.action_id != binding.action_id || spec.assignment_id != binding.assignment_id || spec.run_revision != binding.run_revision || spec.workstream != binding.workstream || spec.role_id != binding.role_id || spec.mode != binding.mode || spec.boundary_id != binding.boundary_id || spec.result_contract != binding.result_contract || spec.prompt_path.0 != binding.prompt_path || spec.prompt_digest.0 != binding.prompt_digest || spec.spec_path.0 != binding.spec_path || spec.carrier_path.0 != binding.carrier_path || spec.session_id != binding.session_id || spec.boundary_digest.0 != binding.boundary_digest || spec.result_contract_digest.0 != binding.result_contract_digest || spec.settings_digest.0 != binding.settings_digest || spec.context_digest.0 != binding.context_digest || spec.skills_digest.0 != binding.skills_digest || spec.subscription_digest.0 != binding.subscription_digest || spec.assignment_path.as_ref().map(|path| path.0.as_str()) != binding.assignment_path.as_deref() || spec.assignment_digest.as_ref().map(|digest| digest.0.as_str()) != binding.assignment_digest.as_deref() || spec.repository_manifest_path.as_ref().map(|path| path.0.as_str()) != binding.repository_manifest_path.as_deref() || spec.repository_manifest_digest.as_ref().map(|digest| digest.0.as_str()) != binding.repository_manifest_digest.as_deref() || spec.repository_head_commit.as_ref().map(|sha| sha.0.as_str()) != binding.repository_head_commit.as_ref().map(|sha| sha.0.as_str()) || spec.repository_head_tree.as_ref().map(|sha| sha.0.as_str()) != binding.repository_head_tree.as_ref().map(|sha| sha.0.as_str()) {
        return Err(format!("CONTEXT_GAP:planning-reemit:spec-binding-drift:{}:{}:{}", binding.assignment_id.0, binding.action_id.0, binding.run_revision).into());
    }
    Ok(())
}

fn record_recovered_planning_control_actions(state: &mut CoreState, actions: &[BackgroundAction]) -> Result<(), AnyError> {
    validate_spawn_wave_actions(actions)?;
    for action in actions {
        crate::control::admit_exact_bg_run((action, &action.bg_run)).map_err(|error| format!("control:bg-run:{}", error.actual()))?;
    }
    let policy = crate::control::ControlPolicy::package().map_err(|error| format!("control:policy:{error:?}"))?;
    let ordered_ids = actions.iter().map(|action| action.action_id.0.as_str()).collect::<Vec<_>>().join("\n");
    let frame = crate::control::ControlFrameDocument::build(crate::control::FrameInput {
        frame_id: kernel::generated::Uuidv7(format!("control-frame-{}-planning-reemit-{}", state.state.revision + 1, sha256_hex_local(ordered_ids.as_bytes()))),
        run_id: kernel::generated::Uuidv7(format!("run-{}", actions[0].run_revision)),
        run_revision: actions[0].run_revision,
        trigger_kind: kernel::generated::TriggerKind("planning-reemit".to_owned()),
        trigger_refs: actions.iter().map(|action| Ref(action.action_id.0.clone())).collect(),
        counts: kernel::generated::ControlFrameCounts { implementers: active_implementers(state) as u32, validators: active_validators(state) as u32, fixers: 0, deterministic_jobs: 0, queued_candidates: queued_candidates(state) as u32 },
        observations: Vec::new(),
        actions: actions.to_vec(),
        next_watchdog_at: kernel::generated::Nullable(None),
    });
    let mut refs = control_refs(state, "planning-reemit", &policy, &frame, actions)?;
    for action in actions {
        refs.extend(record_context_prompt_for_action(state, action));
    }
    state.append(EventKind("control:frame".to_owned()), refs)
}
fn planning_waiting_status(wave_id: &str, active: &[planning::PlanningActiveRef], state: &CoreState) -> String {
    let active_ids = active.iter().map(|item| item.assignment_id.clone()).collect::<Vec<_>>().join(",");
    let acknowledged = active.iter().filter(|item| item.launch_acknowledged).count();
    let unacknowledged = active.len().saturating_sub(acknowledged);
    format!("planning:waiting-on-in-flight:wave={wave_id};active={active_ids};launch_acked={acknowledged};unacknowledged={unacknowledged};{}", state.summary())
}
fn planning_blocked_status(blocked: &planning::PlanningWaveBlocked, state: &CoreState) -> String {
    format!("planning:blocked:wave={};failed={};completed={};{}", blocked.wave_id, blocked.failed_assignments.join(","), blocked.completed_assignments.join(","), state.summary())
}
fn validate_agent_output(binding: &runner::IssuedRunnerBinding, raw: &str) -> Result<String, Rejection> {
    let spec = read_runner_spec_for_binding(binding).map_err(|detail| {
        let mut runtime = boundary_runtime("planning.questions.v1");
        runtime.flip_to_enforce();
        match runtime.reject(format!("boundary_id={}; field=spec_path; expected=readable runner spec; got={detail}; hint=refuse unbound planning carrier", binding.boundary_id.0)) {
            Err(rejection) => rejection,
            Ok(()) => panic!("planning validation runtime unexpectedly allowed spec read failure"),
        }
    })?;
    runner::validate_child_boundary(&spec, raw)
}
fn write_planning_manifest(workstream: &str, input_set: &planning::TaskInputSet, inventory: &planning::Inventory, dossier: &planning::Dossier, assignments: &[AgentAssignment]) -> Result<(), AnyError> {
    let dir = workstream_dir(workstream); fs::create_dir_all(&dir)?;
    let policy = planning::planning_policy().map_err(|error| context_status("planning-policy", error))?;
    let schedule = planning::PlanningManifest::from_policy(workstream, &policy).map_err(|error| context_status("planning-policy", error))?;
    if assignments != schedule.assignments.as_slice() { return Err("CONTEXT_GAP:planning-manifest:assignment schedule drift".into()); }
    let context = input_set.context_documents.first().ok_or("missing context document")?;
    let authority_docs = input_set.authority_documents.iter().map(runner_doc_from_task).map(|doc| serde_json::to_value(doc).expect("runner doc json")).collect::<Vec<_>>();
    let context_docs = input_set.context_documents.iter().map(runner_doc_from_task).map(|doc| serde_json::to_value(doc).expect("runner doc json")).collect::<Vec<_>>();
    let context_doc = runner_doc_from_task(context);
    let assignment_rows = assignments.iter().map(|item| {
        assignment_mode_parameter(assignments, item)
            .map(|mode_parameter| serde_json::json!({"assignment_id":item.assignment_id,"role":item.role,"mode":item.mode,"mode_parameter":mode_parameter,"boundary_id":item.boundary_id,"ordinal":item.ordinal,"atom_id_prefix":item.atom_id_prefix}))
    }).collect::<Result<Vec<_>, _>>()?;
    let body = serde_json::json!({"workstream":workstream,"authority_set_id":input_set.authority_set_id,"authority_paths":input_set.authority_documents.iter().map(|item| &item.path).collect::<Vec<_>>(),"authority_documents":authority_docs,"context_documents":context_docs,"context":{"path":context.path,"class":"context/non-authority","digest":context.digest},"context_document":context_doc,"file_digests":input_set.authority_documents.iter().chain(input_set.context_documents.iter()).map(|item| serde_json::json!({"path":item.path,"class":format!("{:?}", item.class),"digest":item.digest})).collect::<Vec<_>>(),"atoms":inventory.atoms.len(),"verified_facts":dossier.verified_facts,"planning_wave_cap":schedule.planning_wave_cap,"planning_max_attempts":schedule.planning_max_attempts,"planning_waves":schedule.waves,"assignments":assignment_rows});
    let bytes = serde_json::to_vec_pretty(&body)?;
    let path = dir.join("planning-manifest.json");
    match fs::read(&path) {
        Ok(existing) if existing == bytes => {}
        Ok(_) => return Err("CONTEXT_GAP:planning-manifest:digest drift".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::write(path, bytes)?,
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
fn read_planning_manifest_value(workstream: &str) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(workstream_dir(workstream).join("planning-manifest.json")).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn read_planning_input_set(workstream: &str) -> Result<planning::TaskInputSet, String> {
    let value = read_planning_manifest_value(workstream)?;
    let authority_set_id = value["authority_set_id"].as_str().ok_or_else(|| "missing authority_set_id".to_owned())?.to_owned();
    let authority_documents = value["authority_documents"].as_array().ok_or_else(|| "missing authority_documents".to_owned())?.iter().enumerate().map(|(index, item)| task_doc_from_manifest(item, planning::TaskDocumentClass::Authority, &authority_set_id, index)).collect::<Result<Vec<_>, _>>()?;
    let context_documents = match value.get("context_documents").and_then(|item| item.as_array()) {
        Some(items) => items.iter().enumerate().map(|(index, item)| task_doc_from_manifest(item, planning::TaskDocumentClass::ContextNonAuthority, &authority_set_id, authority_documents.len() + index)).collect::<Result<Vec<_>, _>>()?,
        None => vec![task_doc_from_manifest(&value["context_document"], planning::TaskDocumentClass::ContextNonAuthority, &authority_set_id, authority_documents.len())?],
    };
    Ok(planning::TaskInputSet { authority_set_id, authority_documents, context_documents })
}

fn manifest_assignments(workstream: &str) -> Result<Vec<AgentAssignment>, String> {
    Ok(read_planning_schedule_manifest(workstream)?.assignments)
}

fn read_planning_schedule_manifest(workstream: &str) -> Result<planning::PlanningManifest, String> {
    let value = read_planning_manifest_value(workstream)?;
    let items = value["assignments"].as_array().ok_or_else(|| "manifest missing assignments".to_owned())?;
    let mut assignments = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if item.as_str().is_some() { return Err(format!("manifest assignment {index} uses legacy string form without wave data")); }
        assignments.push(AgentAssignment {
            assignment_id: item["assignment_id"].as_str().ok_or_else(|| format!("manifest assignment {index} missing assignment_id"))?.to_owned(),
            role: item["role"].as_str().ok_or_else(|| format!("manifest assignment {index} missing role"))?.to_owned(),
            mode: item["mode"].as_str().ok_or_else(|| format!("manifest assignment {index} missing mode"))?.to_owned(),
            boundary_id: item.get("boundary_id").and_then(|value| value.as_str()).map(str::to_owned),
            ordinal: item.get("ordinal").and_then(|value| value.as_u64()).and_then(|value| u8::try_from(value).ok()).ok_or_else(|| format!("manifest assignment {index} missing ordinal"))?,
            atom_id_prefix: item.get("atom_id_prefix").and_then(|value| value.as_str()).map(str::to_owned),
        });
    }
    let waves_value = value.get("planning_waves").ok_or_else(|| "manifest missing planning_waves".to_owned())?.clone();
    let waves = serde_json::from_value::<Vec<planning::PlanningWaveDeclaration>>(waves_value).map_err(|error| format!("manifest planning_waves: {error}"))?;
    let planning_wave_cap = value.get("planning_wave_cap").and_then(|item| item.as_u64()).and_then(|item| usize::try_from(item).ok()).ok_or_else(|| "manifest missing planning_wave_cap".to_owned())?;
    let planning_max_attempts = value.get("planning_max_attempts").and_then(|item| item.as_u64()).and_then(|item| u8::try_from(item).ok()).ok_or_else(|| "manifest missing planning_max_attempts".to_owned())?;
    Ok(planning::PlanningManifest { workstream: workstream.to_owned(), planning_wave_cap, planning_max_attempts, assignments, waves })
}

fn planning_refs_from_state(workstream: &str, state: &CoreState) -> planning::PlanningRefs {
    let mut refs = planning::PlanningRefs::default();
    for binding in state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)) {
        if binding.workstream.0 != workstream || !binding.result_contract.0.starts_with("planning.") { continue; }
        let issued = planning::PlanningIssuedRef { assignment_id: binding.assignment_id.0.clone(), action_id: binding.action_id.0.clone(), run_revision: binding.run_revision };
        refs.issued.push(issued.clone());
        if let Some(task_id) = launch_ack_task_id(state, &binding) {
            refs.launch_acks.insert(planning::PlanningLaunchAckRef { assignment_id: issued.assignment_id.clone(), action_id: issued.action_id.clone(), run_revision: issued.run_revision, task_id });
        }
        if planning_result_consumed(state, &binding) {
            refs.accepted.insert(planning::PlanningAcceptedRef { assignment_id: issued.assignment_id.clone(), action_id: issued.action_id.clone(), run_revision: issued.run_revision });
        } else if terminal_consumed(state, &binding) {
            refs.terminal_failures.insert(planning::PlanningTerminalFailureRef { assignment_id: issued.assignment_id.clone(), action_id: issued.action_id.clone(), run_revision: issued.run_revision, status: "terminal-without-planning-result".to_owned() });
        } else if launch_failure_consumed(state, &binding) {
            refs.terminal_failures.insert(planning::PlanningTerminalFailureRef { assignment_id: issued.assignment_id.clone(), action_id: issued.action_id.clone(), run_revision: issued.run_revision, status: "launch-failed".to_owned() });
        }
    }
    for reference in state.state.refs.keys() {
        if reference.0 == "planning-resolution-required" || reference.0.starts_with("planning-resolution-required:") {
            refs.activation_refs.insert("planning-resolution-required".to_owned());
        }
    }
    refs
}

fn launch_ack_task_id(state: &CoreState, binding: &runner::IssuedRunnerBinding) -> Option<String> {
    if !launch_ack_consumed(state, binding) {
        return None;
    }
    state.state.refs.keys().find_map(|reference| {
        let rest = reference.0.strip_prefix("task-binding:")?;
        let value = serde_json::from_str::<serde_json::Value>(rest).ok()?;
        let action_id = value.get("action_id").and_then(|item| item.as_str())?;
        let assignment_id = value.get("assignment_id").and_then(|item| item.as_str())?;
        let run_revision = value.get("run_revision").and_then(|item| item.as_u64())?;
        let task_id = value.get("task_id").and_then(|item| item.as_str())?;
        (action_id == binding.action_id.0 && assignment_id == binding.assignment_id.0 && run_revision == binding.run_revision).then(|| task_id.to_owned())
    })
}

fn read_runner_spec_for_binding(binding: &runner::IssuedRunnerBinding) -> Result<kernel::generated::AgentRunSpec, String> {
    let text = fs::read_to_string(&binding.spec_path).map_err(|error| format!("{}:{error}", binding.spec_path))?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn task_doc_from_manifest(value: &serde_json::Value, class: planning::TaskDocumentClass, authority_set_id: &str, index: usize) -> Result<planning::TaskDocument, String> {
    let path = value["path"].as_str().ok_or_else(|| format!("manifest doc {index} missing path"))?.to_owned();
    let digest = value["digest"].as_str().ok_or_else(|| format!("manifest doc {index} missing digest"))?.to_owned();
    let body = value["body"].as_str().ok_or_else(|| format!("manifest doc {index} missing body"))?.to_owned();
    Ok(planning::TaskDocument { id: path.clone(), path, class, authority_set_id: authority_set_id.to_owned(), body, digest })
}
fn ensure_atom_registry_after_task_atoms(workstream: &str, state: &CoreState) -> Result<(), AnyError> {
    let assignments = manifest_assignments(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let task_extractors = assignments.iter().filter(|assignment| assignment.role == "task-extractor").collect::<Vec<_>>();
    if task_extractors.is_empty() {
        return Ok(());
    }
    let all_accepted = task_extractors.iter().all(|assignment| accepted_binding_for_assignment(state, &assignment.assignment_id).is_some());
    if all_accepted {
        let _ = ensure_atom_registry(workstream, state)?;
    }
    Ok(())
}

fn ensure_atom_registry(workstream: &str, state: &CoreState) -> Result<(String, String), AnyError> {
    let manifest = read_planning_manifest_value(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let authority_set_id = manifest["authority_set_id"].as_str().ok_or("CONTEXT_GAP:planning-manifest:missing authority_set_id")?.to_owned();
    let assignments = manifest_assignments(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let anchors = planning::TaskAnchorRegistry::from_input_set(&read_planning_input_set(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?)
        .map_err(|error| format!("CONTEXT_GAP:planning-manifest:task-source-manifest:{error:?}"))?;
    let mut records = Vec::new();
    let mut producer_ids = Vec::new();
    for (assignment_order, assignment) in assignments.iter().enumerate().filter(|(_, assignment)| assignment.role == "task-extractor") {
        let binding = accepted_binding_for_assignment(state, &assignment.assignment_id)
            .ok_or_else(|| format!("CONTEXT_GAP:atom-registry:unaccepted {}", assignment.assignment_id))?;
        let carrier_text = fs::read_to_string(&binding.carrier_path).map_err(|error| format!("CONTEXT_GAP:atom-registry-carrier:{}:{error}", binding.carrier_path))?;
        let carrier: AgentCarrier = serde_json::from_str(&carrier_text).map_err(|error| format!("CONTEXT_GAP:atom-registry-carrier-json:{}:{error}", binding.carrier_path))?;
        let spec = read_runner_spec_for_binding(&binding).map_err(|error| format!("CONTEXT_GAP:atom-registry-spec:{error}"))?;
        let prefix = spec.atom_id_prefix.as_deref().ok_or_else(|| format!("CONTEXT_GAP:atom-registry-prefix:{}", binding.assignment_id.0))?;
        let atoms: kernel::generated::TaskAtoms = serde_json::from_str(&carrier.raw_output).map_err(|error| format!("CONTEXT_GAP:atom-registry-atoms:{}:{error}", binding.assignment_id.0))?;
        planning::validate_task_atoms_for_assignment(&atoms, prefix, &anchors)
            .map_err(|error| format!("CONTEXT_GAP:atom-registry-boundary:{}", boundary_status(&error)))?;
        producer_ids.push(binding.assignment_id.clone());
        records.push((assignment_order, 0usize, binding.assignment_id.clone(), atoms));
    }
    let atoms = planning::sorted_registry_atoms(records).map_err(|error| context_status("atom-registry", error))?;
    let bytes = planning::atom_registry_bytes(workstream, &authority_set_id, producer_ids, atoms).map_err(|error| context_status("atom-registry", error))?;
    let digest = sha256_hex_local(&bytes);
    let path = std::env::current_dir()?.join(atom_registry_path(workstream));
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    match fs::read(&path) {
        Ok(existing) if existing == bytes => Ok((path.display().to_string(), digest)),
        Ok(_) => Err("CONTEXT_GAP:atom-registry:digest drift".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok((path.display().to_string(), digest))
        }
        Err(error) => Err(error.into()),
    }
}

fn accepted_binding_for_assignment(state: &CoreState, assignment_id: &str) -> Option<runner::IssuedRunnerBinding> {
    state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)).find(|binding| binding.assignment_id.0 == assignment_id && planning_result_consumed(state, binding))
}

fn accepted_planning_artifacts_for_issue(workstream: &str, state: &CoreState) -> Result<Vec<runner::AcceptedPlanningArtifactBinding>, AnyError> {
    let manifest = read_planning_schedule_manifest(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let mut assignments = std::collections::BTreeMap::new();
    for (order, assignment) in manifest.assignments.iter().enumerate() {
        assignments.insert(assignment.assignment_id.as_str(), (order, assignment));
    }
    let mut rows: Vec<(String, usize, runner::AcceptedPlanningArtifactBinding)> = Vec::new();
    for binding in state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)) {
        if binding.workstream.0 != workstream || !planning_result_consumed(state, &binding) { continue; }
        let Some((order, assignment)) = assignments.get(binding.assignment_id.0.as_str()) else {
            return Err(format!("CONTEXT_GAP:accepted-artifact:unknown assignment {}", binding.assignment_id.0).into());
        };
        let expected = assignment.boundary_id.as_deref().unwrap_or("planning.questions.v1");
        if expected != binding.result_contract.0 {
            return Err(format!("CONTEXT_GAP:accepted-artifact:boundary drift {} expected {expected} got {}", binding.assignment_id.0, binding.result_contract.0).into());
        }
        let categories = accepted_artifact_categories_for_role(&assignment.role, &binding.result_contract.0)?;
        if categories.is_empty() { continue; }
        let carrier_bytes = fs::read(&binding.carrier_path).map_err(|error| format!("CONTEXT_GAP:accepted-artifact-carrier:{}:{error}", binding.carrier_path))?;
        let digest = sha256_hex_local(&carrier_bytes);
        for category_id in categories {
            rows.push((
                (*category_id).to_owned(),
                *order,
                runner::AcceptedPlanningArtifactBinding {
                    category_id: (*category_id).to_owned(),
                    assignment_id: binding.assignment_id.clone(),
                    role_id: binding.role_id.clone(),
                    boundary_id: binding.result_contract.clone(),
                    path: binding.carrier_path.clone(),
                    digest: digest.clone(),
                },
            ));
        }
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    Ok(rows.into_iter().map(|(_, _, artifact)| artifact).collect())
}

fn accepted_artifact_categories_for_role(role: &str, boundary_id: &str) -> Result<&'static [&'static str], AnyError> {
    let categories = match (role, boundary_id) {
        ("task-extractor", "planning.task-atoms.v1") => &["task-atoms"][..],
        ("repository-scout" | "context-curator", "planning.scout-dossier.v1") => &["scout-findings"][..],
        ("plan-compiler", "planning.work-map.v1") => &["compiler-work-maps"][..],
        ("plan-synthesizer", "planning.work-map.v1") => &["synthesized-work-map"][..],
        ("plan-reviewer", "planning.plan-review.v1") => &["review-verdicts"][..],
        ("contradiction-resolver", "planning.questions.v1") => &["contradiction-bundle"][..],
        _ if boundary_id.starts_with("planning.") => {
            return Err(format!("CONTEXT_GAP:accepted-artifact:unmapped role/boundary {role}/{boundary_id}").into());
        }
        _ => &[][..],
    };
    Ok(categories)
}

fn write_work_map(workstream: &str, raw: &str) -> Result<(), AnyError> { let path = work_map_path(workstream); if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; } fs::write(path, raw)?; Ok(()) }
fn read_work_map(workstream: &str) -> Result<String, String> { fs::read_to_string(work_map_path(workstream)).map_err(|error| error.to_string()) }
fn write_approved_plan(workstream: &str, repository_authority: ApprovedRepositoryAuthority, units: &[ApprovedUnit]) -> Result<(), AnyError> {
    validate_approved_units(units)?;
    let artifact = ApprovedPlanArtifact { repository_authority: Some(repository_authority), units: units.to_vec() };
    let bytes = serde_json::to_vec_pretty(&artifact)?;
    let path = plan_path(workstream);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => { file.write_all(&bytes)?; file.sync_all()?; Ok(()) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = fs::read(&path)?;
            if existing == bytes { Ok(()) } else { Err("CONTEXT_GAP:approved-plan:digest drift".into()) }
        }
        Err(error) => Err(error.into()),
    }
}
fn read_approved_plan_artifact(workstream: &str) -> Result<ApprovedPlanArtifact, String> {
    let text = fs::read_to_string(plan_path(workstream)).map_err(|error| error.to_string())?;
    let artifact: ApprovedPlanArtifact = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    validate_approved_units(&artifact.units).map_err(|error| error.to_string())?;
    Ok(artifact)
}
fn read_approved_plan(workstream: &str) -> Result<Vec<ApprovedUnit>, String> { Ok(read_approved_plan_artifact(workstream)?.units) }
fn approved_repository_authority_for_carrier(carrier: &AgentCarrier) -> Result<ApprovedRepositoryAuthority, String> {
    let spec_bytes = fs::read(&carrier.spec_path).map_err(|error| format!("spec-read:{}:{error}", carrier.spec_path))?;
    let spec_digest = sha256_hex_local(&spec_bytes);
    if spec_digest != carrier.spec_digest { return Err(format!("spec-digest:expected={} got={spec_digest}", carrier.spec_digest)); }
    let spec: kernel::generated::AgentRunSpec = serde_json::from_slice(&spec_bytes).map_err(|error| format!("spec-json:{error}"))?;
    let path = spec.repository_manifest_path.as_ref().ok_or_else(|| "missing repository_manifest_path".to_owned())?;
    let digest = spec.repository_manifest_digest.as_ref().ok_or_else(|| "missing repository_manifest_digest".to_owned())?;
    let head_commit = spec.repository_head_commit.as_ref().ok_or_else(|| "missing repository_head_commit".to_owned())?;
    let head_tree = spec.repository_head_tree.as_ref().ok_or_else(|| "missing repository_head_tree".to_owned())?;
    let binding = runner::read_repository_authority_binding(Path::new(&path.0), &digest.0).map_err(|error| error.to_string())?;
    if binding.manifest.head_commit != head_commit.0 || binding.manifest.head_tree != head_tree.0 {
        return Err(format!("repository manifest head/tree drift: manifest {}/{} spec {}/{}", binding.manifest.head_commit, binding.manifest.head_tree, head_commit.0, head_tree.0));
    }
    Ok(ApprovedRepositoryAuthority { manifest_path: binding.path, manifest_digest: binding.digest, head_commit: Sha(binding.manifest.head_commit), head_tree: Sha(binding.manifest.head_tree) })
}
fn apply_planning_side_effects(carrier: &AgentCarrier) -> Result<(), String> {
    if carrier.boundary_id == "planning.work-map.v1" && is_canonical_output_assignment(&carrier.workstream, &carrier.assignment_id, &carrier.boundary_id)? { write_work_map(&carrier.workstream, &carrier.raw_output).map_err(|error| format!("CONTEXT_GAP:work-map:{error}"))?; }
    if carrier.boundary_id == "planning.plan-review.v1" {
        review_approves_execution(&carrier.raw_output)?;
        let work_map = read_work_map(&carrier.workstream).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        let units = parse_approved_units(&work_map).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        let repository_authority = approved_repository_authority_for_carrier(carrier).map_err(|error| format!("CONTEXT_GAP:approved-plan:repository-authority:{error}"))?;
        write_approved_plan(&carrier.workstream, repository_authority, &units).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    }
    Ok(())
}

pub fn review_approves_execution(raw: &str) -> Result<(), String> {
    let review: kernel::generated::PlanReview = serde_json::from_str(raw).map_err(|error| format!("plan-review-json:{error}"))?;
    let required = REQUIRED_PLAN_REVIEW_CRITERIA.iter().copied().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut missing = required.clone();
    let mut duplicate = Vec::new();
    let mut unknown = Vec::new();
    let mut non_pass = Vec::new();
    for verdict in &review.verdicts {
        let id = verdict.criterion_id.0.as_str();
        if !required.contains(id) { unknown.push(id.to_owned()); continue; }
        if !seen.insert(id.to_owned()) { duplicate.push(id.to_owned()); }
        missing.remove(id);
        if verdict.verdict != kernel::generated::PlanningReviewVerdict::Pass {
            non_pass.push(format!("{}={:?}", verdict.criterion_id.0, verdict.verdict));
        }
    }
    if !unknown.is_empty() || !duplicate.is_empty() || !missing.is_empty() {
        return Err(format!(
            "plan-review:criteria-set-drift:missing=[{}];duplicate=[{}];unknown=[{}];required=[{}]",
            missing.into_iter().collect::<Vec<_>>().join(","),
            duplicate.join(","),
            unknown.join(","),
            REQUIRED_PLAN_REVIEW_CRITERIA.join(",")
        ));
    }
    if !non_pass.is_empty() { return Err(format!("plan-review:blocked:{}", non_pass.join(","))); }
    Ok(())
}

fn is_canonical_output_assignment(workstream: &str, assignment_id: &str, boundary_id: &str) -> Result<bool, String> {
    let manifest = read_planning_schedule_manifest(workstream).map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let assignment = manifest.assignments.iter().find(|assignment| assignment.assignment_id == assignment_id).ok_or_else(|| format!("CONTEXT_GAP:planning-manifest:unknown assignment {assignment_id}"))?;
    let canonical = manifest.waves.iter().any(|wave| wave.canonical_output && wave.role == assignment.role && wave.ordinals.as_ref().is_none_or(|ordinals| ordinals.contains(&assignment.ordinal)));
    if canonical && assignment.boundary_id.as_deref() != Some(boundary_id) { return Err(format!("CONTEXT_GAP:planning-manifest:canonical boundary mismatch for {assignment_id}")); }
    Ok(canonical)
}
fn parse_approved_units(raw: &str) -> Result<Vec<ApprovedUnit>, String> {
    let work_map: kernel::generated::WorkMap = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    approved_units_from_work_map(&work_map)
}
fn approved_units_from_work_map(work_map: &kernel::generated::WorkMap) -> Result<Vec<ApprovedUnit>, String> {
    validate_work_map_graph(work_map)?;
    work_map.units.iter().enumerate().map(|(index, unit)| {
        if unit.id.0.trim().is_empty() || unit.objective.trim().is_empty() || unit.criteria.is_empty() { return Err(format!("unit {} missing criteria/objective", unit.id.0)); }
        if unit.files.is_empty() { return Err(format!("unit {} missing files", unit.id.0)); }
        let mut file_paths = BTreeSet::new();
        if unit.files.iter().any(|path| !allocation::approved_path_is_safe(path) || !file_paths.insert(path.0.as_str())) { return Err(format!("unit {} has unsafe or duplicate files", unit.id.0)); }
        if unit.commands.is_empty() { return Err(format!("unit {} missing commands", unit.id.0)); }
        for command in &unit.commands { allocation::validate_plan_unit_command_effect_authority(command).map_err(|error| format!("unit {} has incomplete command authority: {error}", unit.id.0))?; }
        let order = index as u32 + 1;
        let criteria = unit.criteria.iter().enumerate().map(|(criterion_index, _)| idv(&format!("AC-{}-{}", unit.id.0, criterion_index + 1))).collect::<Vec<_>>();
        let criterion_text = criteria.iter().cloned().zip(unit.criteria.iter().cloned()).map(|(id, text)| allocation::ApprovedCriterion { id, text }).collect::<Vec<_>>();
        Ok(ApprovedUnit { id: unit.id.clone(), kind: unit.kind.clone(), objective: unit.objective.clone(), operator_order: order, decisions: unit.links.clone(), criteria, criterion_text, dependencies: unit.depends_on.clone(), predecessor_forward_criteria: unit.depends_on.iter().map(|dep| idv(&format!("unit-complete:{}", dep.0))).collect(), downstream_release_edges: vec![idv(&format!("unit:{}", unit.id.0))], files: unit.files.clone(), commands: unit.commands.clone() })
    }).collect()
}
fn validate_work_map_graph(work_map: &kernel::generated::WorkMap) -> Result<(), String> {
    if work_map.units.is_empty() { return Err("expected at least 1 approved unit, got 0".to_owned()); }
    let mut ids = BTreeSet::new();
    for unit in &work_map.units {
        if !ids.insert(unit.id.clone()) { return Err(format!("duplicate unit id {}", unit.id.0)); }
    }
    let by_id = work_map.units.iter().map(|unit| (unit.id.clone(), unit)).collect::<BTreeMap<_, _>>();
    for unit in &work_map.units {
        for dep in &unit.depends_on {
            if dep == &unit.id { return Err(format!("unit {} depends on itself", unit.id.0)); }
            if !ids.contains(dep) { return Err(format!("unit {} depends on unknown unit {}", unit.id.0, dep.0)); }
        }
    }
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for unit in &work_map.units { visit_work_map_unit(&unit.id, &by_id, &mut visiting, &mut done)?; }
    Ok(())
}
fn visit_work_map_unit(id: &Id, by_id: &BTreeMap<Id, &kernel::generated::PlanUnit>, visiting: &mut BTreeSet<Id>, done: &mut BTreeSet<Id>) -> Result<(), String> {
    if done.contains(id) { return Ok(()); }
    if !visiting.insert(id.clone()) { return Err(format!("work-map dependency cycle at {}", id.0)); }
    let unit = by_id.get(id).ok_or_else(|| format!("unit {} missing during graph walk", id.0))?;
    for dep in &unit.depends_on { visit_work_map_unit(dep, by_id, visiting, done)?; }
    visiting.remove(id);
    done.insert(id.clone());
    Ok(())
}
fn validate_approved_units(units: &[ApprovedUnit]) -> Result<(), AnyError> {
    if units.is_empty() { return Err("empty approved plan".into()); }
    let mut ids = BTreeSet::new();
    for unit in units {
        if !ids.insert(unit.id.clone()) { return Err(format!("approved plan duplicate unit {}", unit.id.0).into()); }
        if unit.kind != kernel::generated::PlanUnitKind::Implementation || unit.objective.trim().is_empty() || unit.criteria.is_empty() || unit.criterion_text.is_empty() || unit.files.is_empty() || unit.commands.is_empty() {
            return Err(format!("approved unit {} incomplete", unit.id.0).into());
        }
        let mut file_paths = BTreeSet::new();
        if unit.files.iter().any(|path| !allocation::approved_path_is_safe(path) || !file_paths.insert(path.0.as_str())) { return Err(format!("approved unit {} has unsafe or duplicate files", unit.id.0).into()); }
        let criterion_ids = unit.criterion_text.iter().map(|criterion| criterion.id.clone()).collect::<Vec<_>>();
        if criterion_ids != unit.criteria { return Err(format!("approved unit {} criteria/criterion_text drift", unit.id.0).into()); }
        let mut criterion_seen = BTreeSet::new();
        for criterion in &unit.criterion_text {
            if criterion.text.trim().is_empty() || !criterion_seen.insert(criterion.id.clone()) { return Err(format!("approved unit {} malformed criterion {}", unit.id.0, criterion.id.0).into()); }
        }
        for dep in &unit.dependencies { if dep == &unit.id { return Err(format!("approved unit {} self dependency", unit.id.0).into()); } }
        for command in &unit.commands { allocation::validate_plan_unit_command_effect_authority(command).map_err(|error| -> AnyError { format!("approved unit {} has malformed command authority: {error}", unit.id.0).into() })?; }
    }
    for unit in units { for dep in &unit.dependencies { if !ids.contains(dep) { return Err(format!("approved unit {} depends on unknown unit {}", unit.id.0, dep.0).into()); } } }
    let by_id = units.iter().map(|unit| (unit.id.clone(), unit)).collect::<BTreeMap<_, _>>();
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for unit in units { visit_approved_unit(&unit.id, &by_id, &mut visiting, &mut done).map_err(|error| -> AnyError { error.into() })?; }
    Ok(())
}
fn visit_approved_unit(id: &Id, by_id: &BTreeMap<Id, &ApprovedUnit>, visiting: &mut BTreeSet<Id>, done: &mut BTreeSet<Id>) -> Result<(), String> {
    if done.contains(id) { return Ok(()); }
    if !visiting.insert(id.clone()) { return Err(format!("approved plan dependency cycle at {}", id.0)); }
    let unit = by_id.get(id).ok_or_else(|| format!("approved unit {} missing during graph walk", id.0))?;
    for dep in &unit.dependencies { visit_approved_unit(dep, by_id, visiting, done)?; }
    visiting.remove(id);
    done.insert(id.clone());
    Ok(())
}
fn approved_lane_id(index: usize) -> Id { idv(&format!("L{}", index + 1)) }
fn allocation_submission_from_plan(workstream: &str, approved: &[ApprovedUnit], state: &CoreState) -> Result<AllocationSubmission, String> {
    validate_approved_units(approved).map_err(|error| error.to_string())?;
    let mut open = approved.iter().enumerate().filter(|(index, _)| !lane_closed(state, &approved_lane_id(*index))).collect::<Vec<_>>();
    open.sort_by_key(|(index, unit)| {
        let lane_id = approved_lane_id(*index);
        let live = lane_has_live_delivery(state, &lane_id);
        let blocked = unit.predecessor_forward_criteria.iter().any(|gate| !state.state.refs.contains_key(&Ref(format!("gate:{}", gate.0))));
        (!live, blocked, *index)
    });
    let scheduled = open.into_iter().take(6).collect::<Vec<_>>();
    let scheduled_ids = scheduled.iter().map(|(_, unit)| unit.id.clone()).collect::<BTreeSet<_>>();
    let lanes = scheduled.into_iter().map(|(index, unit)| {
        let focused_tests = unit.commands.iter().map(|command| TestId(command.command.clone())).collect::<Vec<_>>();
        let lane_id = approved_lane_id(index);
        let continuation = lane_has_live_delivery(state, &lane_id).then_some(true);
        AllocationLaneProposal { lane_id, objective: unit.objective.clone(), ordered_unit_ids: vec![unit.id.clone()], rationale: format!("unit {} from approved plan", unit.id.0), delivery_boundary: DeliveryBoundary("approved-plan-unit".to_owned()), predecessor_forward_criteria: unit.predecessor_forward_criteria.clone(), downstream_release_edges: unit.downstream_release_edges.clone(), context_family_id: idv(&format!("approved-plan:{workstream}")), context_estimate: 100, focused_tests, launch_wave: index as u32, continue_existing_logical_lane: continuation }
    }).collect();
    let future_units = approved.iter().enumerate().filter(|(_, unit)| !scheduled_ids.contains(&unit.id)).map(|(index, unit)| FutureUnit {
        unit_id: unit.id.clone(),
        reason: if lane_closed(state, &approved_lane_id(index)) { "unit already closed; retained as approved authority outside the active allocation window".to_owned() } else { "parallel allocation window is six lanes; retained for the next deterministic allocation window".to_owned() },
    }).collect();
    Ok(AllocationSubmission { lanes, future_units, authority_echo: approved.to_vec(), ownership_claims: Vec::new(), overlap_blocks: Vec::new() })
}
fn lane_readiness_from_events(lanes: &[AllocationLaneProposal], approved: &[ApprovedUnit], state: &CoreState) -> Vec<LaneReadiness> {
    lanes.iter().map(|lane| { let units = lane.ordered_unit_ids.iter().filter_map(|id| approved.iter().find(|unit| unit.id == *id)).collect::<Vec<_>>(); LaneReadiness { lane_id: lane.lane_id.clone(), predecessor_gates_met: units.iter().flat_map(|unit| &unit.predecessor_forward_criteria).all(|gate| state.state.refs.contains_key(&Ref(format!("gate:{}", gate.0)))), blockers_clear: !state.state.refs.contains_key(&Ref(format!("blocker:{}", lane.lane_id.0))), unit_free: lane.ordered_unit_ids.iter().all(|unit| !state.state.refs.contains_key(&Ref(format!("unit-active:{}", unit.0)))), route_ready: true, preflight_passed: git_stdout(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")), &["rev-parse", "--verify", "HEAD"]).is_ok(), pressure_delay: false } }).collect()
}
fn active_implementers(state: &CoreState) -> usize { state.state.refs.keys().filter_map(|reference| runner::decode_binding_ref(&reference.0)).filter(|binding| binding.role_id.0 == "implementer" && !terminal_consumed(state, binding)).count() }
fn assignment(workstream: &str, lane_id: &Id, approved: &[ApprovedUnit], submission: &AllocationSubmission) -> Result<RunnerAssignment, AnyError> {
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    let base = selected_delivery_base(&cwd, workstream).map_err(|error| format!("CONTEXT_GAP:base-commit:{error}"))?;
    let worktree = prepare_delivery_worktree(&cwd, workstream, lane_id, &base).map_err(|error| format!("CONTEXT_GAP:worktree:{error}"))?;
    let lane = submission.lanes.iter().find(|lane| lane.lane_id == *lane_id).ok_or_else(|| format!("CONTEXT_GAP:assignment:unknown lane {}", lane_id.0))?;
    let approved_units = lane.ordered_unit_ids.iter().map(|unit_id| approved.iter().find(|unit| unit.id == *unit_id).cloned().ok_or_else(|| format!("CONTEXT_GAP:assignment:unknown unit {}", unit_id.0))).collect::<Result<Vec<_>, _>>()?;
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
        approved_units,
    })
}
fn selected_delivery_base(repo: &Path, workstream: &str) -> Result<Sha, String> {
    let run_main = run_main_ref(workstream);
    let first = git_stdout(repo, &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")])
        .map_err(|error| format!("run-main missing or malformed: {run_main}: {error}"))?;
    let second = git_stdout(repo, &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")])
        .map_err(|error| format!("run-main moved while reading: {run_main}: {error}"))?;
    let first = first.trim();
    let second = second.trim();
    if first != second { return Err(format!("run-main moved while selecting base: first={first} second={second}")); }
    Ok(Sha(first.to_owned()))
}
fn prepare_delivery_worktree(repo: &Path, workstream: &str, lane_id: &Id, base: &Sha) -> Result<PathBuf, String> {
    let worktree = repo.join(".pi/autopilot").join(workstream).join("worktrees").join(&lane_id.0);
    let branch = lane_branch_ref(workstream, lane_id, 1);
    runner::reject_link_components_for_path(&worktree).map_err(|error| error.to_string())?;
    let peeled_base = git_stdout(repo, &["rev-parse", "--verify", &format!("{}^{{commit}}", base.0)])?;
    let peeled_base = peeled_base.trim().to_owned();
    if peeled_base != base.0 { return Err(format!("selected base did not peel exactly: expected {}, got {peeled_base}", base.0)); }
    match git_stdout(repo, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")]) {
        Ok(existing) if existing.trim() != base.0 => return Err(format!("lane branch base drift: expected {}, got {}", base.0, existing.trim())),
        Ok(_) => {}
        Err(_) => { git_status(repo, &["update-ref", &branch, &base.0, ""])?; }
    }
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
    let branch_tip = git_stdout(repo.as_path(), &["rev-parse", "--verify", &format!("{branch}^{{commit}}")])?;
    if branch_tip.trim() != base.0 { return Err(format!("delivery branch tip drift: expected {}, got {}", base.0, branch_tip.trim())); }
    if head.trim() != base.0 { return Err(format!("delivery worktree head drift: expected {}, got {}", base.0, head.trim())); }
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
fn atom_registry_path(workstream: &str) -> PathBuf { workstream_dir(workstream).join("planning/atom-registry.json") }
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
