use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::planning::{self, TaskAnchorRegistry, TaskDocument, TaskDocumentClass, TaskInputSet};
use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{
    ContractId, Id, ModeId, PlanningAtomKind, Ref, SeamEnvelope, TaskAtom, TaskAtoms,
};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn registered_task_atoms_boundary_admits_matches_generated_contract() {
    let descriptor = kernel::boundary::boundary_by_id("planning.task-atoms.v1").unwrap();

    assert_eq!(descriptor.admits(), kernel::generated::TASK_ATOMS_ADMITS);
}

#[test]
fn runner_child_rejects_atom_outside_runner_namespace() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("namespace");
    fixture.install_transport();
    fixture.install_fake_pi(&[
        task_atoms("SMF-P-001"),
        task_atoms("SMF-P-001"),
        task_atoms("SMF-P-001"),
    ]);
    let issue = fixture.issue_planning(
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        Some("TE01-"),
        None,
    );

    let result =
        drivers::runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()]);

    assert!(
        result.is_err(),
        "outside-prefix atom must exhaust value repair"
    );
    assert!(
        !Path::new(&issue.binding.carrier_path).exists(),
        "rejected output must not create carrier"
    );
    let attempts = fixture.read_attempt_events(&issue.binding);
    assert!(
        has_attempt_event(&attempts, "value-rejected"),
        "attempt events must record value rejection: {attempts:?}"
    );
}

#[test]
fn runner_child_repairs_unknown_links_from_bound_atom_registry() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("links");
    fixture.install_transport();
    let (registry_path, registry_digest) =
        fixture.write_atom_registry(&[("TE01-W-001", "planning-ws-task-extractor-01")]);
    fixture.install_fake_pi(&[work_map(&["A1", "A2", "A3"]), work_map(&["TE01-W-001"])]);
    let issue = fixture.issue_planning(
        "plan-compiler",
        "initial-plan",
        "planning.work-map.v1",
        None,
        Some((registry_path, registry_digest)),
    );

    drivers::runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()]).unwrap();

    let attempts = fixture.read_attempt_events(&issue.binding);
    assert!(
        has_attempt_event(&attempts, "value-rejected"),
        "unknown links must be rejected first: {attempts:?}"
    );
    assert!(
        has_attempt_event(&attempts, "accepted"),
        "second model value must be accepted: {attempts:?}"
    );
    let raw_output = carrier_raw_output(&issue.binding);
    let accepted: serde_json::Value = serde_json::from_str(&raw_output).unwrap();
    assert_eq!(accepted["units"][0]["links"], json!(["TE01-W-001"]));
}

#[test]
fn accepted_registry_rejects_cross_extractor_duplicate_and_is_resume_stable() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let duplicate = Fixture::new("registry-dupe");
    duplicate.install_transport();
    duplicate.write_manifest(&[
        (
            "planning-ws-task-extractor-01",
            "task-extractor",
            Some("TE01-"),
        ),
        (
            "planning-ws-task-extractor-02",
            "task-extractor",
            Some("TE02-"),
        ),
    ]);
    let mut state = CoreState::open(None).unwrap();
    let first = duplicate.seed_planning_binding(
        &mut state,
        PlanningIssueSpec::new(
            "task-extractor",
            "inventory",
            "planning.task-atoms.v1",
            "planning-ws-task-extractor-01",
        )
        .prefix("TE01-"),
        task_atoms("TE01-DUP"),
    );
    let second = duplicate.seed_planning_binding(
        &mut state,
        PlanningIssueSpec::new(
            "task-extractor",
            "inventory",
            "planning.task-atoms.v1",
            "planning-ws-task-extractor-02",
        )
        .prefix("TE02-"),
        task_atoms("TE02-OK"),
    );
    duplicate.overwrite_carrier_raw(&second, task_atoms("TE01-DUP"));
    let ok = duplicate.agent_result(&mut state, &first, task_atoms("TE01-DUP"));
    assert!(
        ok.contains("accepted"),
        "first extractor should be accepted: {ok}"
    );
    let rejected = duplicate.agent_result(&mut state, &second, task_atoms("TE02-OK"));
    // A duplicate atom id across extractors must never be silently absorbed. Under wave
    // scheduling the ambiguous re-issued binding is caught first; either way the result is a
    // loud typed rejection and no registry is written.
    assert!(
        rejected.starts_with("rejection:")
            && (rejected.contains("atom-registry") || rejected.contains("ambiguous")),
        "duplicate registry must fail loudly: {rejected}"
    );

    let stable = Fixture::new("registry-stable");
    stable.install_transport();
    stable.write_manifest(&[
        (
            "planning-ws-task-extractor-01",
            "task-extractor",
            Some("TE01-"),
        ),
        (
            "planning-ws-task-extractor-02",
            "task-extractor",
            Some("TE02-"),
        ),
        ("planning-ws-repository-scout-01", "repository-scout", None),
    ]);
    let event_log = stable.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_log.clone())).unwrap();
    let a = stable.seed_planning_binding(
        &mut state,
        PlanningIssueSpec::new(
            "task-extractor",
            "inventory",
            "planning.task-atoms.v1",
            "planning-ws-task-extractor-01",
        )
        .prefix("TE01-"),
        task_atoms("TE01-A"),
    );
    let next = stable.agent_response(&mut state, &a, task_atoms("TE01-A"));
    assert_spawn_assignment(&next, "planning-ws-task-extractor-02");
    let next = stable.agent_response_from_spec(
        &mut state,
        &stable.planning_spec_path("planning-ws-task-extractor-02"),
        task_atoms("TE02-B"),
    );
    assert_spawn_assignment(&next, "planning-ws-repository-scout-01");
    let registry_path = stable
        .root
        .join(".pi/autopilot/ws/planning/atom-registry.json");
    let before = fs::read(&registry_path).unwrap();
    let mut replayed = CoreState::open(Some(event_log)).unwrap();
    let next = stable.agent_response_from_spec(
        &mut replayed,
        &stable.planning_spec_path("planning-ws-repository-scout-01"),
        scout_dossier(),
    );
    assert!(
        response_status(&next).contains("accepted"),
        "scout result should be accepted after resume: {next:?}"
    );
    let after = fs::read(&registry_path).unwrap();
    assert_eq!(
        before, after,
        "registry recomputation on resume must byte-match"
    );
}

#[test]
fn approved_units_preserve_atom_links() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("approved-links");
    fixture.install_transport();
    fs::create_dir_all(fixture.root.join(".pi/autopilot/ws")).unwrap();
    fs::write(
        fixture.root.join(".pi/autopilot/ws/work-map.md"),
        work_map(&["TE01-W-001", "TE02-C-002"]),
    )
    .unwrap();
    let mut state = CoreState::open(None).unwrap();
    let binding = fixture.seed_planning_binding(
        &mut state,
        PlanningIssueSpec::new(
            "plan-reviewer",
            "full-review",
            "planning.plan-review.v1",
            "planning-ws-plan-reviewer-01",
        ),
        plan_review(),
    );

    let status = fixture.agent_result(&mut state, &binding, plan_review());

    assert!(
        status.contains("ready-to-execute"),
        "plan review should approve via seam: {status}"
    );
    let approved =
        fs::read_to_string(fixture.root.join(".pi/autopilot/ws/approved-plan.json")).unwrap();
    assert!(
        approved.contains("TE01-W-001"),
        "approved unit decisions must retain work-map links: {approved}"
    );
    assert!(
        approved.contains("TE02-C-002"),
        "approved unit decisions must retain all work-map links: {approved}"
    );
}

#[test]
fn task_anchor_registry_accepts_real_section_and_rejects_unverified_sources() {
    let registry = TaskAnchorRegistry::from_input_set(&task_input_set(&[
        planning_doc(
            "TASK.md",
            TaskDocumentClass::Authority,
            "# Fixture Task\n\n## 3. Work Breakdown\n\nImplement it.\n\n## 4. Constraints and Banned Shapes\n\nNo silent fallback.\n\n## 5. Definition of Done\n\nFocused tests pass.\n",
        ),
        planning_doc(
            "context.md",
            TaskDocumentClass::ContextNonAuthority,
            "# Context\n\nRepository facts.\n",
        ),
    ]))
    .expect("valid task anchor input");

    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("task://TASK.md#3-work-breakdown"),
        "TE01-",
        &registry,
    )
    .expect("exact recorded transcript section source must be admitted when the heading exists");
    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("TASK.md §3"),
        "TE01-",
        &registry,
    )
    .expect("prose section source must be admitted only when the section number exists");
    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("TASK.md#3-work-breakdown"),
        "TE01-",
        &registry,
    )
    .expect("bare path section source must be admitted when the path and heading exist");

    assert_source_rejected(&registry, "task://TASK.md#does-not-exist");
    assert_source_rejected(&registry, "task://NOT-A-DOC.md");

    let ambiguous = TaskAnchorRegistry::from_input_set(&task_input_set(&[
        planning_doc(
            "alpha/TASK.md",
            TaskDocumentClass::Authority,
            "# Alpha\n\n## 3. Work Breakdown\n\nAlpha.\n",
        ),
        planning_doc(
            "beta/TASK.md",
            TaskDocumentClass::Authority,
            "# Beta\n\n## 3. Work Breakdown\n\nBeta.\n",
        ),
        planning_doc(
            "context.md",
            TaskDocumentClass::ContextNonAuthority,
            "# Context\n\nRepository facts.\n",
        ),
    ]))
    .expect("valid ambiguous-basename input");
    assert_source_rejected(&ambiguous, "task://TASK.md#3-work-breakdown");
}

#[test]
fn task_anchor_registry_renders_canonical_manifest_for_all_docs_deterministically() {
    let docs = [
        planning_doc(
            "z-context.md",
            TaskDocumentClass::ContextNonAuthority,
            "CTX-Z",
        ),
        planning_doc("b-task.md", TaskDocumentClass::Authority, "AUTH-B"),
        planning_doc("a-task.md", TaskDocumentClass::Authority, "AUTH-A"),
    ];
    let input = task_input_set(&docs);
    let registry = TaskAnchorRegistry::from_input_set(&input).expect("valid task source input");
    let manifest = registry.canonical_source_manifest();
    assert!(
        manifest.contains("Package-authoritative source manifest for planning.task-atoms.v1"),
        "canonical manifest heading missing: {manifest}"
    );
    assert!(
        manifest.contains("decoded JSON `sources[].source` string exactly"),
        "decoded JSON copy instruction missing: {manifest}"
    );
    assert!(
        manifest.contains("json://...#/body` Context Manifest addresses are context-read addresses, not legal atoms[].sources"),
        "json address warning missing: {manifest}"
    );
    let manifest_json = extract_task_source_manifest_json(manifest);
    assert_eq!(
        manifest_json.as_bytes(),
        registry.canonical_source_manifest_json_bytes(),
        "rendered manifest must reuse registry-owned serialized JSON bytes"
    );
    let parsed: serde_json::Value = serde_json::from_str(&manifest_json).expect("manifest json");
    let expected_sources = input
        .authority_documents
        .iter()
        .chain(input.context_documents.iter())
        .map(|document| format!("task://{}/{}#whole-file", document.digest, document.path))
        .collect::<Vec<_>>();
    let parsed_sources = parsed["sources"].as_array().expect("sources array");
    for source in &expected_sources {
        assert!(
            registry.has(&Ref(source.clone())),
            "canonical source not admitted: {source}"
        );
        assert!(
            parsed_sources
                .iter()
                .any(|row| row["source"].as_str() == Some(source)),
            "manifest JSON missing {source}: {manifest_json}"
        );
    }
    assert_eq!(registry.canonical_sources().len(), expected_sources.len());
    let reordered = task_input_set(&[docs[2].clone(), docs[1].clone(), docs[0].clone()]);
    assert_eq!(
        manifest,
        TaskAnchorRegistry::from_input_set(&reordered)
            .expect("valid reordered task source input")
            .canonical_source_manifest(),
        "input order must not change canonical source manifest bytes"
    );
    assert!(
        manifest_json.find("a-task.md").unwrap() < manifest_json.find("b-task.md").unwrap(),
        "manifest order should be deterministic by class/path/digest JSON: {manifest_json}"
    );
}

#[test]
fn task_anchor_registry_json_round_trips_adversarial_legal_paths() {
    let adversarial_path = format!(
        "dir with spaces/line\nbreak/quote\" equals= source= ticks ``` and ```` marker {}.md",
        planning::CANONICAL_TASK_SOURCE_MANIFEST_JSON_END
    );
    let doc = planning_doc(
        &adversarial_path,
        TaskDocumentClass::Authority,
        "adversarial body",
    );
    let input = task_input_set(std::slice::from_ref(&doc));
    let registry = TaskAnchorRegistry::from_input_set(&input).expect("legal UTF-8 path accepted");
    let manifest_json = extract_task_source_manifest_json(registry.canonical_source_manifest());
    let parsed: serde_json::Value = serde_json::from_str(&manifest_json).expect("manifest json");
    assert_eq!(
        parsed["sources"][0]["path"].as_str(),
        Some(adversarial_path.as_str()),
        "JSON round-trip must preserve legal path data exactly"
    );
    let expected_source = format!("task://{}/{adversarial_path}#whole-file", doc.digest);
    assert_eq!(
        parsed["sources"][0]["source"].as_str(),
        Some(expected_source.as_str()),
        "JSON round-trip must preserve decoded source exactly"
    );
    assert!(
        registry.has(&Ref(expected_source)),
        "canonical adversarial source remains accepted"
    );
}

#[test]
fn task_anchor_registry_accepts_same_digest_at_distinct_paths_and_rejects_duplicate_identities() {
    let first = planning_doc("same-a.md", TaskDocumentClass::Authority, "same body");
    let mut second = first.clone();
    second.id = "same-b.md".to_owned();
    second.path = "same-b.md".to_owned();
    let registry = TaskAnchorRegistry::from_input_set(&TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: vec![first.clone(), second.clone()],
        context_documents: Vec::new(),
    })
    .expect("same content digest at two distinct paths is unambiguous");
    assert!(registry.has(&Ref(format!(
        "task://{}/{}#whole-file",
        first.digest, first.path
    ))));
    assert!(registry.has(&Ref(format!(
        "task://{}/{}#whole-file",
        second.digest, second.path
    ))));
    assert_eq!(registry.canonical_sources().len(), 2);

    let duplicate = TaskAnchorRegistry::from_input_set(&TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: vec![first.clone(), first],
        context_documents: Vec::new(),
    })
    .expect_err("exact duplicate identity must fail loudly");
    assert!(
        matches!(&duplicate, planning::PlanningError::TaskInputInvariant(message) if message.contains("duplicate task document identity")),
        "unexpected duplicate error: {duplicate:?}"
    );
}

#[test]
fn task_anchor_registry_rejects_illegal_source_suffixes_and_conflicting_identities() {
    let document = planning_doc("TASK.md", TaskDocumentClass::Authority, "# Task\n\nBody\n");
    let context = planning_doc(
        "context.md",
        TaskDocumentClass::ContextNonAuthority,
        "Context\n",
    );
    let registry =
        TaskAnchorRegistry::from_input_set(&task_input_set(&[document.clone(), context]))
            .expect("valid task source input");
    let canonical = format!("task://{}/{}#whole-file", document.digest, document.path);
    for bad in [
        format!("task://{}/{}#/body", document.digest, document.path),
        format!("task://{}/{}#L5-L6", document.digest, document.path),
        format!("task://{}/{}:5-6", document.digest, document.path),
        format!(
            "task://{}/{}#does-not-exist",
            document.digest, document.path
        ),
        format!("{canonical}-suffix"),
    ] {
        assert_source_rejected(&registry, &bad);
    }

    let mut duplicate_class = document.clone();
    duplicate_class.class = TaskDocumentClass::ContextNonAuthority;
    let class_error = TaskAnchorRegistry::from_input_set(&TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: vec![document.clone()],
        context_documents: vec![duplicate_class],
    })
    .expect_err("same path/digest with conflicting class must fail loudly");
    assert!(
        matches!(&class_error, planning::PlanningError::TaskInputInvariant(message) if message.contains("conflicting task document path identity")),
        "unexpected class conflict error: {class_error:?}"
    );

    let mut duplicate_path = document.clone();
    duplicate_path.digest = "different-digest".to_owned();
    let error = TaskAnchorRegistry::from_input_set(&TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: vec![document, duplicate_path],
        context_documents: Vec::new(),
    })
    .expect_err("conflicting path/digest must fail loudly");
    assert!(
        matches!(&error, planning::PlanningError::TaskInputInvariant(message) if message.contains("conflicting task document path identity")),
        "unexpected error: {error:?}"
    );
}

#[test]
fn task_extractor_prompt_contains_manifest_and_non_task_roles_do_not() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("task-source-manifest");
    fixture.install_transport();
    let issue = fixture.issue_planning(
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        Some("TE01-"),
        None,
    );
    let prompt = fs::read_to_string(&issue.binding.prompt_path).expect("task prompt");
    assert!(
        prompt.contains("Package-authoritative source manifest for planning.task-atoms.v1"),
        "task extractor prompt lost canonical source manifest: {prompt}"
    );
    assert!(
        prompt.contains("json://...#/body` Context Manifest addresses are context-read addresses, not legal atoms[].sources"),
        "task extractor prompt lost JSON-address warning: {prompt}"
    );
    assert!(
        prompt.contains(&anchor("task.md", "authority", "auth", "Do the work")),
        "task extractor prompt missing canonical authority source: {prompt}"
    );
    assert!(
        prompt.contains(&anchor(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context"
        )),
        "task extractor prompt missing canonical context source: {prompt}"
    );

    let atom_registry =
        fixture.write_atom_registry(&[("TE01-W-001", "planning-ws-task-extractor-01")]);
    let compiler = fixture.issue_planning(
        "plan-compiler",
        "initial-plan",
        "planning.work-map.v1",
        None,
        Some(atom_registry),
    );
    let compiler_prompt =
        fs::read_to_string(&compiler.binding.prompt_path).expect("compiler prompt");
    assert!(
        !compiler_prompt
            .contains("Package-authoritative source manifest for planning.task-atoms.v1"),
        "non-task planning role received task-atom-only source instructions: {compiler_prompt}"
    );
}

#[test]
fn rendered_planning_prompt_embeds_complete_prompt_budget_estimate() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("prompt-budget-equality");
    fixture.install_transport();
    let issue = fixture.issue_planning(
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        Some("TE01-"),
        None,
    );
    let prompt = fs::read_to_string(&issue.binding.prompt_path).expect("rendered prompt");
    let context_manifest_text = extract_data_layer(&prompt, 5, "canonical Context Manifest");
    let context_manifest: serde_json::Value =
        serde_json::from_str(&context_manifest_text).expect("context manifest json");
    let independent_tokens = drivers::context::estimate_tokens(prompt.as_bytes(), 512);
    let independent_budget = drivers::context::route_budget(
        independent_tokens,
        200_000,
        drivers::context::estimate_tokens(prompt.as_bytes(), 0),
    );
    assert_eq!(
        context_manifest["budget"]["estimated_initial_tokens"].as_u64(),
        Some(u64::from(independent_budget.estimated_tokens)),
        "embedded budget must estimate the exact final rendered prompt"
    );
    assert_eq!(
        context_manifest["budget"]["estimated_percent"].as_u64(),
        Some(u64::from(independent_budget.estimated_percent)),
        "embedded budget percent must match independent final prompt route estimate"
    );
}

#[test]
fn oversized_planning_prompt_refuses_before_prompt_spec_or_carrier_write() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("oversized-pre-spawn");
    fixture.install_transport();
    let assignment_id = Id("planning-ws-task-extractor-oversized".to_owned());
    let huge_path = format!("context-{}.md", "x".repeat(900_000));
    let context_document = runner_doc(&huge_path, "context/non-authority", "auth", "huge context");
    let request = PlanningRunnerRequest {
        workstream: "ws".to_owned(),
        action_id: Id("action-planning-ws-task-extractor-oversized".to_owned()),
        assignment_id: assignment_id.clone(),
        role_id: Id("task-extractor".to_owned()),
        mode: ModeId("inventory".to_owned()),
        boundary_id: ContractId("planning.task-atoms.v1".to_owned()),
        run_revision: 1,
        authority_set_id: "auth".to_owned(),
        authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
        context_document: context_document.clone(),
        context_documents: vec![context_document],
        mode_parameter: first_mode_parameter_for("task-extractor"),
        atom_id_prefix: Some("TE01-".to_owned()),
        atom_registry_path: None,
        atom_registry_digest: None,
        accepted_planning_artifacts: Vec::new(),
    };
    let paths = runner::planning_paths(&fixture.root, "ws", &assignment_id);
    let error = runner::planning_issue(&request).expect_err("oversized prompt must refuse");
    assert!(
        matches!(&error, runner::RunnerError::InvalidSpec(message) if message.contains("rendered planning prompt requires")),
        "unexpected oversized refusal: {error:?}"
    );
    assert!(!paths.prompt_path.exists(), "oversized prompt was written");
    assert!(!paths.spec_path.exists(), "oversized spec was written");
    assert!(
        !paths.carrier_path.exists(),
        "oversized carrier was written"
    );
}

#[test]
fn real_initial_and_repair_prompts_reuse_identical_manifest_json_bytes() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("real-prompt-manifest-equality");
    fixture.install_transport();
    let bad = json!({"atoms":[{"id":"TE01-BAD","kind":"work","text":"bad source","sources":[anchor("task.md", "authority", "auth", "Do the work").replace("#whole-file", "#/body")]}]}).to_string();
    let accepted = task_atoms("TE01-OK");
    fixture.install_fake_pi(&[bad, accepted]);
    let issue = fixture.issue_planning(
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        Some("TE01-"),
        None,
    );
    let initial_rendered_prompt =
        fs::read_to_string(&issue.binding.prompt_path).expect("initial rendered prompt");

    drivers::runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()])
        .expect("repair recovers with canonical source");

    let prompts = user_prompts_from_spec_session(&issue.binding.spec_path);
    assert_eq!(prompts.len(), 2, "expected initial plus repair prompts");
    assert_eq!(
        prompts[0], initial_rendered_prompt,
        "first child prompt must be the real initially rendered prompt"
    );
    let initial_json = extract_task_source_manifest_json(&prompts[0]);
    let repair_json = extract_task_source_manifest_json(&prompts[1]);
    assert_eq!(
        initial_json.as_bytes(),
        repair_json.as_bytes(),
        "real initial rendered prompt and real repair prompt canonical manifest JSON bytes must be identical"
    );
}

struct PlanningIssueSpec<'a> {
    role: &'a str,
    mode: &'a str,
    boundary: &'a str,
    assignment_id: &'a str,
    prefix: Option<&'a str>,
    registry: Option<(String, String)>,
    run_revision: u64,
}

impl<'a> PlanningIssueSpec<'a> {
    fn new(role: &'a str, mode: &'a str, boundary: &'a str, assignment_id: &'a str) -> Self {
        Self {
            role,
            mode,
            boundary,
            assignment_id,
            prefix: None,
            registry: None,
            run_revision: 1,
        }
    }

    fn prefix(mut self, prefix: &'a str) -> Self {
        self.prefix = Some(prefix);
        self
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let pid = std::process::id();
        loop {
            let nonce = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = temp.join(format!("pi-autopilot-impl1-{label}-{pid}-{nonce}"));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let vcs = GitVcs::new(&temp);
                    vcs.init_fixture(&root).unwrap();
                    fs::write(
                        root.join(".gitignore"),
                        ".pi/autopilot/\n.pi/tasks/\nbin/\nout/\naccepted/\nfake-pi/\nfake-pi-count\nevents.jsonl\n",
                    )
                    .unwrap();
                    vcs.stage_all(&root).unwrap();
                    vcs.snapshot(&root, "fixture root").unwrap();
                    std::env::set_current_dir(&root).unwrap();
                    return Self { root };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture root {root:?}: {error}"),
            }
        }
    }

    fn install_transport(&self) {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        let wrapper = bin.join("wrapper.mjs");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::write(&wrapper, "// wrapper\n").unwrap();
        make_executable(&node);
        unsafe {
            std::env::set_var("AUTOPILOT_NODE_EXECUTABLE", &node);
            std::env::set_var("AUTOPILOT_AGENT_RUNNER_WRAPPER", &wrapper);
            std::env::set_var(
                "AUTOPILOT_CHILD_ADDON_PATH",
                Path::new(env!("CARGO_MANIFEST_DIR")).join(concat!(
                    "../src/generated/child-",
                    "ext",
                    "ension.ts"
                )),
            );
            let mut path_entries = vec![bin.clone()];
            if let Some(existing) = std::env::var_os("PATH") {
                path_entries.extend(std::env::split_paths(&existing));
            }
            std::env::set_var(
                "PATH",
                std::env::join_paths(path_entries).expect("join PATH"),
            );
        }
    }

    fn install_fake_pi(&self, outputs: &[String]) {
        let bin = self.root.join("bin");
        let pi = bin.join("pi");
        let out_dir = self.root.join("fake-pi");
        fs::create_dir_all(&out_dir).unwrap();
        for (index, output) in outputs.iter().enumerate() {
            fs::write(out_dir.join(format!("{}.txt", index + 1)), output).unwrap();
        }
        let count_file =
            serde_json::to_string(&self.root.join("fake-pi-count").display().to_string()).unwrap();
        let out_dir_text = serde_json::to_string(&out_dir.display().to_string()).unwrap();
        let submit_bindings = submit_bindings_py();
        // Interpolated from the codegen-emitted entry so this fixture cannot
        // disagree with production about where the child runtime lives, and so
        // the literal path does not appear in scanned static source.
        let runtime_entry = serde_json::to_string(kernel::generated::CHILD_RUNTIME_ENTRY).unwrap();
        fs::write(&pi, format!(r#"#!/usr/bin/env python3
import hashlib
import json
import os
import sys

COUNT_FILE = {count_file}
OUT_DIR = {out_dir_text}


def arg_value(name):
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return ""


def next_output():
    count = 0
    if os.path.exists(COUNT_FILE):
        with open(COUNT_FILE, "r", encoding="utf-8") as handle:
            count = int(handle.read() or "0")
    count += 1
    with open(COUNT_FILE, "w", encoding="utf-8") as handle:
        handle.write(str(count))
    with open(os.path.join(OUT_DIR, f"{{count}}.txt"), "r", encoding="utf-8") as handle:
        return handle.read()


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


provider = arg_value("--provider")
model = arg_value("--model")
thinking = arg_value("--thinking")
session_id = arg_value("--session-id")
mode = arg_value("--mode")
session_dir = arg_value("--session-dir")
addon_path = arg_value("-e")
active_tools = sorted(filter(None, arg_value("--tools").split(",")))
submit_tools = [tool for tool in active_tools if tool.startswith("autopilot_submit_")]
bindings = {submit_bindings}
if not session_dir:
    sys.stderr.write("fake pi: --session-dir is required\n")
    sys.exit(64)
# Model real Pi's store: a session file keyed by (session_dir, session_id) is
# reopened when present, and its retained messages become model context.
session_path = os.path.join(session_dir, session_id + ".jsonl")
try:
    with open(session_path, "r", encoding="utf-8") as handle:
        stored_messages = [line for line in handle.read().split("\n") if line.strip()]
except OSError:
    stored_messages = []

with open(addon_path, "rb") as handle:
    addon_bytes = handle.read()
runtime_path = os.path.normpath(os.path.join(os.path.dirname(addon_path), "..", "..", {runtime_entry}))
with open(runtime_path, "rb") as handle:
    runtime_bytes = handle.read()
addon_digest = hashlib.sha256(addon_bytes + b"\x00" + runtime_bytes).hexdigest()
terminal_tool = next((tool for tool in active_tools if tool.startswith("autopilot_submit_")), "")
boundary, result_contract, schema_digest = bindings.get(terminal_tool, ("", "", ""))
profile_id = os.environ.get("AUTOPILOT_TERMINAL_PROFILE", "")
receipt = {{"type":"custom","customType":"pi-autopilot:child-tools","data":{{"self_digest":addon_digest,"profile_id":profile_id,"tool_name":terminal_tool,"boundary_id":boundary,"result_contract":result_contract,"schema_digest":schema_digest,"binding":os.environ.get("AUTOPILOT_CARRIER_BINDING", ""),"active_tools":active_tools}},"id":"receipt-1","parentId":None}}

if mode == "rpc":
    emit({{"type":"entry_appended","entry":receipt}})
    for line in sys.stdin:
        command = json.loads(line)
        command_id = command["id"]
        command_type = command["type"]
        if command_type == "set_auto_compaction":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
        elif command_type == "get_state":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True,"data":{{"sessionId":session_id,"model":{{"provider":provider,"id":model}},"thinkingLevel":thinking,"autoCompactionEnabled":False,"messageCount":len(stored_messages)}}}})
        elif command_type == "get_entries":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True,"data":{{"entries":[receipt],"leafId":"receipt-1"}}}})
        elif command_type == "prompt":
            content = next_output()
            entry = json.dumps({{"role":"user","content":command.get("message")}}, separators=(",", ":"))
            stored_messages.append(entry)
            os.makedirs(session_dir, exist_ok=True)
            with open(session_path, "a", encoding="utf-8") as handle:
                handle.write(entry + "\n")
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
            tool = submit_tools[0]
            boundary, result_contract, schema_digest = bindings[tool]
            details = {{"profile_id":os.environ.get("AUTOPILOT_TERMINAL_PROFILE", ""),"tool_name":tool,"boundary_id":boundary,"result_contract":result_contract,"schema_digest":schema_digest,"binding":os.environ.get("AUTOPILOT_CARRIER_BINDING", ""),"payload":json.loads(content)}}
            call_id = "call_fake_submit"
            emit({{"type":"agent_start"}})
            emit({{"type":"turn_start"}})
            emit({{"type":"message_start"}})
            emit({{"type":"message_end","message":{{"role":"assistant","provider":provider,"model":model,"stopReason":"toolUse","content":[{{"type":"toolCall","id":call_id,"name":tool,"arguments":details["payload"]}}]}}}})
            emit({{"type":"tool_execution_start","toolCallId":call_id,"toolName":tool,"args":details["payload"]}})
            emit({{"type":"tool_execution_end","toolCallId":call_id,"toolName":tool,"result":{{"content":[{{"type":"text","text":"submitted"}}],"details":details,"terminate":True}},"isError":False}})
            emit({{"type":"message_start"}})
            emit({{"type":"message_end","message":{{"role":"toolResult","toolCallId":call_id,"toolName":tool,"content":[{{"type":"text","text":"submitted"}}],"details":details,"isError":False}}}})
            emit({{"type":"turn_end"}})
            emit({{"type":"agent_end","willRetry":False}})
            emit({{"type":"agent_settled"}})
        elif command_type == "get_session_stats":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True,"data":{{"contextUsage":{{"percent":10.0}}}}}})
        elif command_type in ("abort", "steer", "compact"):
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
        else:
            emit({{"type":"response","id":command_id,"command":command_type,"success":False,"error":"unexpected command"}})
else:
    content = next_output()
    emit({{"type":"agent_end","willRetry":False,"messages":[{{"role":"assistant","content":content,"provider":provider,"model":model,"stopReason":"stop"}}]}})
"#)).unwrap();
        make_executable(&pi);
    }

    fn issue_planning(
        &self,
        role: &str,
        mode: &str,
        boundary: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
    ) -> runner::IssuedRunnerAction {
        self.issue_planning_with_assignment(
            role,
            mode,
            boundary,
            &format!("planning-ws-{role}-01"),
            prefix,
            registry,
        )
    }

    fn accepted_artifacts_for_role(
        &self,
        role: &str,
    ) -> Vec<runner::AcceptedPlanningArtifactBinding> {
        let categories: &[(&str, &str, &str, &str)] = match role {
            "plan-compiler" => &[
                (
                    "task-atoms",
                    "planning.task-atoms.v1",
                    "task-extractor",
                    "planning-ws-task-extractor-01",
                ),
                (
                    "scout-findings",
                    "planning.scout-dossier.v1",
                    "repository-scout",
                    "planning-ws-repository-scout-01",
                ),
            ],
            "plan-reviewer" => &[
                (
                    "task-atoms",
                    "planning.task-atoms.v1",
                    "task-extractor",
                    "planning-ws-task-extractor-01",
                ),
                (
                    "scout-findings",
                    "planning.scout-dossier.v1",
                    "repository-scout",
                    "planning-ws-repository-scout-01",
                ),
                (
                    "compiler-work-maps",
                    "planning.work-map.v1",
                    "plan-compiler",
                    "planning-ws-plan-compiler-01",
                ),
                (
                    "synthesized-work-map",
                    "planning.work-map.v1",
                    "plan-synthesizer",
                    "planning-ws-plan-synthesizer-02",
                ),
            ],
            _ => &[],
        };
        categories
            .iter()
            .map(|(category_id, boundary_id, role_id, assignment_id)| {
                let path = self
                    .root
                    .join("accepted")
                    .join(format!("{category_id}.json"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let bytes = serde_json::to_vec_pretty(&json!({
                    "category_id": category_id,
                    "boundary_id": boundary_id,
                    "assignment_id": assignment_id,
                }))
                .unwrap();
                fs::write(&path, &bytes).unwrap();
                runner::AcceptedPlanningArtifactBinding {
                    category_id: (*category_id).to_owned(),
                    assignment_id: Id((*assignment_id).to_owned()),
                    role_id: Id((*role_id).to_owned()),
                    boundary_id: ContractId((*boundary_id).to_owned()),
                    path: path.display().to_string(),
                    digest: sha256_hex(&bytes),
                }
            })
            .collect()
    }

    fn write_atom_registry(&self, atoms: &[(&str, &str)]) -> (String, String) {
        let path = self
            .root
            .join(".pi/autopilot/ws/planning/atom-registry.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let value = json!({
            "schema":"autopilot.planning_atom_registry.v1",
            "workstream":"ws",
            "authority_set_id":"auth",
            "producer_assignment_ids": atoms.iter().map(|(_, producer)| *producer).collect::<Vec<_>>(),
            "atoms": atoms.iter().map(|(id, producer)| json!({"id":id,"producer_assignment_id":producer,"kind":"work","text":"atom","sources":[anchor("task.md", "authority", "auth", "Do the work")]})).collect::<Vec<_>>()
        });
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&path, &bytes).unwrap();
        (path.display().to_string(), sha256_hex(&bytes))
    }

    fn write_manifest(&self, assignments: &[(&str, &str, Option<&str>)]) {
        fs::create_dir_all(self.root.join(".pi/autopilot/ws")).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let rows = assignments.iter().enumerate().map(|(index, (id, role, prefix))| {
            let (mode, boundary_id) = match *role {
                "task-extractor" => ("inventory", "planning.task-atoms.v1"),
                "repository-scout" => ("initial-grounding", "planning.scout-dossier.v1"),
                other => panic!("unsupported manifest role in fixture: {other}"),
            };
            json!({"assignment_id":id,"role":role,"mode":mode,"boundary_id":boundary_id,"ordinal":index + 1,"atom_id_prefix":prefix})
        }).collect::<Vec<_>>();
        let mut waves = vec![
            json!({"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false}),
        ];
        if assignments
            .iter()
            .any(|(_, role, _)| *role == "repository-scout")
        {
            waves.push(json!({"id":"P2.scout","role":"repository-scout","dependencies":["P1.extract"],"ordinals":null,"activation_ref":null,"canonical_output":false}));
        }
        fs::write(self.root.join(".pi/autopilot/ws/planning-manifest.json"), serde_json::to_vec_pretty(&json!({"workstream":"ws","authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,"assignments":rows,"planning_wave_cap":7,"planning_max_attempts":2,"planning_waves":waves})).unwrap()).unwrap();
    }

    fn seed_planning_binding(
        &self,
        state: &mut CoreState,
        spec: PlanningIssueSpec<'_>,
        raw: String,
    ) -> runner::IssuedRunnerBinding {
        let assignment_id = spec.assignment_id.to_owned();
        let issue = self.issue_planning_from_spec(spec);
        self.overwrite_carrier_raw(&issue.binding, raw);
        self.append_ref(state, &runner::binding_ref(&issue.binding).unwrap());
        self.append_ref(state, &Ref(assignment_id));
        issue.binding
    }

    fn issue_planning_with_assignment(
        &self,
        role: &str,
        mode: &str,
        boundary: &str,
        assignment_id: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
    ) -> runner::IssuedRunnerAction {
        self.issue_planning_from_spec(PlanningIssueSpec {
            role,
            mode,
            boundary,
            assignment_id,
            prefix,
            registry,
            run_revision: 1,
        })
    }

    fn issue_planning_from_spec(&self, spec: PlanningIssueSpec<'_>) -> runner::IssuedRunnerAction {
        let (registry_path, registry_digest) = match spec.registry {
            Some((p, d)) => (Some(p), Some(d)),
            None => (None, None),
        };
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let request = PlanningRunnerRequest {
            workstream: "ws".to_owned(),
            action_id: Id(format!("action-{}", spec.assignment_id)),
            assignment_id: Id(spec.assignment_id.to_owned()),
            role_id: Id(spec.role.to_owned()),
            mode: ModeId(spec.mode.to_owned()),
            boundary_id: ContractId(spec.boundary.to_owned()),
            run_revision: spec.run_revision,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: first_mode_parameter_for(spec.role),
            atom_id_prefix: spec.prefix.map(str::to_owned),
            atom_registry_path: registry_path,
            atom_registry_digest: registry_digest,
            accepted_planning_artifacts: self.accepted_artifacts_for_role(spec.role),
        };
        runner::planning_issue(&request).unwrap()
    }

    fn overwrite_carrier_raw(&self, binding: &runner::IssuedRunnerBinding, raw: String) {
        fs::create_dir_all(Path::new(&binding.carrier_path).parent().unwrap()).unwrap();
        fs::write(
            &binding.carrier_path,
            serde_json::to_vec_pretty(&carrier_value(binding, &raw)).unwrap(),
        )
        .unwrap();
    }

    fn agent_response(
        &self,
        state: &mut CoreState,
        binding: &runner::IssuedRunnerBinding,
        raw: String,
    ) -> SeamEnvelope {
        let carrier = carrier_value(binding, &raw);
        let frame = json!({"v":1,"id":1,"kind":"agent-result","payload":{"assignment_id":binding.assignment_id,"carrier":carrier}});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn agent_response_from_spec(
        &self,
        state: &mut CoreState,
        spec_path: &Path,
        raw: String,
    ) -> SeamEnvelope {
        let carrier = carrier_value_from_spec(spec_path, &raw);
        let carrier_path = carrier
            .get("carrier_path")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        fs::create_dir_all(Path::new(carrier_path).parent().unwrap()).unwrap();
        fs::write(carrier_path, serde_json::to_vec_pretty(&carrier).unwrap()).unwrap();
        let assignment_id = carrier
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let frame = json!({"v":1,"id":1,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":carrier}});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn planning_spec_path(&self, assignment_id: &str) -> PathBuf {
        self.root
            .join(".pi/autopilot/ws/planning/specs")
            .join(format!("{assignment_id}.json"))
    }

    fn agent_result(
        &self,
        state: &mut CoreState,
        binding: &runner::IssuedRunnerBinding,
        raw: String,
    ) -> String {
        let response = self.agent_response(state, binding, raw);
        response_status(&response)
    }

    fn append_ref(&self, state: &mut CoreState, reference: &Ref) {
        let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":format!("append:test:{}", reference.0),"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},"background_capability_diagnostic":null}});
        let response = seam::handle_line(&frame.to_string(), state).unwrap();
        let status = response
            .payload
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| panic!("non-status response: {response:?}"));
        assert!(
            status.contains("state:sequence"),
            "append ref failed: {status}"
        );
    }

    fn attempt_event_path(&self, binding: &runner::IssuedRunnerBinding) -> PathBuf {
        let spec: serde_json::Value =
            serde_json::from_slice(&fs::read(&binding.spec_path).unwrap()).unwrap();
        let cwd = spec.get("cwd").and_then(serde_json::Value::as_str).unwrap();
        let assignment_id = spec
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        Path::new(cwd)
            .join(".pi/autopilot/runner/attempt-events")
            .join(format!("{assignment_id}.jsonl"))
    }

    fn read_attempt_events(&self, binding: &runner::IssuedRunnerBinding) -> Vec<serde_json::Value> {
        let path = self.attempt_event_path(binding);
        fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("attempt events missing at {}: {error}", path.display()))
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

/// Terminal status text, or a synthetic `accepted:` marker when the seam responded by
/// launching the next planning wave (which only happens after the prior result was accepted).
fn response_status(response: &SeamEnvelope) -> String {
    if let Some(status) = response
        .payload
        .get("status")
        .and_then(|value| value.as_str())
    {
        return status.to_owned();
    }
    let launched = spawned_assignment_ids(response);
    assert!(
        !launched.is_empty(),
        "non-status response launched nothing: {response:?}"
    );
    format!("accepted:next-wave={}", launched.join(","))
}

fn assert_spawn_assignment(response: &SeamEnvelope, assignment_id: &str) {
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "expected spawn response: {response:?}"
    );
    assert!(
        spawned_assignment_ids(response)
            .iter()
            .any(|id| id == assignment_id),
        "spawn should launch {assignment_id}: {response:?}"
    );
}

/// Assignment ids launched by either a singular `spawn` or a batched `spawn-wave`.
fn spawned_assignment_ids(response: &SeamEnvelope) -> Vec<String> {
    let read = |action: &serde_json::Value| {
        action
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    if let Some(actions) = response.payload.get("actions").and_then(|v| v.as_array()) {
        return actions.iter().filter_map(read).collect();
    }
    response
        .payload
        .get("action")
        .and_then(read)
        .into_iter()
        .collect()
}

fn has_attempt_event(events: &[serde_json::Value], event: &str) -> bool {
    events
        .iter()
        .any(|row| row.get("event").and_then(serde_json::Value::as_str) == Some(event))
}

fn carrier_raw_output(binding: &runner::IssuedRunnerBinding) -> String {
    let carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding.carrier_path).unwrap()).unwrap();
    carrier
        .get("raw_output")
        .and_then(serde_json::Value::as_str)
        .unwrap()
        .to_owned()
}

fn carrier_value_from_spec(spec_path: &Path, raw: &str) -> serde_json::Value {
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(spec_path).unwrap()).unwrap();
    json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":spec["action_id"],
        "assignment_id":spec["assignment_id"],
        "run_revision":spec["run_revision"],
        "workstream":spec["workstream"],
        "role_id":spec["role_id"],
        "mode":spec["mode"],
        "boundary_id":spec["boundary_id"],
        "result_contract":spec["result_contract"],
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "spec_digest":sha256_hex(&fs::read(spec_path).unwrap()),
        "spec_path":spec["spec_path"],
        "carrier_path":spec["carrier_path"],
        "raw_output":raw,
    })
}

fn carrier_value(binding: &runner::IssuedRunnerBinding, raw: &str) -> serde_json::Value {
    json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":binding.action_id.0,
        "assignment_id":binding.assignment_id.0,
        "run_revision":binding.run_revision,
        "workstream":binding.workstream.0,
        "role_id":binding.role_id.0,
        "mode":binding.mode.0,
        "boundary_id":binding.boundary_id.0,
        "result_contract":binding.result_contract.0,
        "prompt_path":binding.prompt_path,
        "prompt_digest":binding.prompt_digest,
        "boundary_digest":binding.boundary_digest,
        "result_contract_digest":binding.result_contract_digest,
        "settings_digest":binding.settings_digest,
        "context_digest":binding.context_digest,
        "skills_digest":binding.skills_digest,
        "subscription_digest":binding.subscription_digest,
        "spec_digest":binding.spec_digest,
        "spec_path":binding.spec_path,
        "carrier_path":binding.carrier_path,
        "raw_output":raw,
    })
}

fn task_atoms(id: &str) -> String {
    json!({"atoms":[{"id":id,"kind":"work","text":"Do the work","sources":[anchor("task.md", "authority", "auth", "Do the work")]}]}).to_string()
}

fn atoms_with_source(source: &str) -> TaskAtoms {
    TaskAtoms {
        atoms: vec![TaskAtom {
            id: Id("TE01-W1".to_owned()),
            kind: PlanningAtomKind::Work,
            text: "Do the work".to_owned(),
            sources: vec![Ref(source.to_owned())],
        }],
    }
}

fn extract_data_layer(prompt: &str, number: u8, name: &str) -> String {
    let heading = format!("## Layer {number} — {name}");
    let after_heading = prompt
        .split_once(&heading)
        .unwrap_or_else(|| panic!("missing {heading}"))
        .1;
    let fence_line = after_heading
        .lines()
        .find(|line| line.starts_with("```") && line.ends_with("text"))
        .expect("opening data fence");
    let fence = fence_line.trim_end_matches("text");
    let body_start = after_heading.find(fence_line).expect("fence line") + fence_line.len() + 1;
    let after_open = &after_heading[body_start..];
    let close = after_open
        .find(&format!("\n{fence}\n"))
        .expect("closing data fence");
    after_open[..close].to_owned()
}

fn user_prompts_from_spec_session(spec_path: &str) -> Vec<String> {
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(spec_path).expect("runner spec")).expect("spec json");
    let session_dir = spec["session_dir"].as_str().expect("session_dir");
    let session_id = spec["session_id"].as_str().expect("session_id");
    let session_path = Path::new(session_dir).join(format!("{session_id}.jsonl"));
    fs::read_to_string(session_path)
        .expect("fake pi session log")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("session line json"))
        .filter(|entry| entry["role"].as_str() == Some("user"))
        .map(|entry| {
            entry["content"]
                .as_str()
                .expect("prompt content")
                .to_owned()
        })
        .collect()
}

fn extract_task_source_manifest_json(text: &str) -> String {
    let begin = planning::CANONICAL_TASK_SOURCE_MANIFEST_JSON_BEGIN;
    let end = planning::CANONICAL_TASK_SOURCE_MANIFEST_JSON_END;
    let begin_line = format!("\n{begin}\n");
    let start = text
        .find(&begin_line)
        .map(|index| index + begin_line.len())
        .or_else(|| {
            text.starts_with(&format!("{begin}\n"))
                .then(|| begin.len() + 1)
        })
        .expect("manifest JSON begin marker line");
    let rest = &text[start..];
    let end_line = format!("\n{end}\n");
    let stop = rest.find(&end_line).expect("manifest JSON end marker line");
    rest[..stop].to_owned()
}

fn assert_source_rejected(registry: &TaskAnchorRegistry, source: &str) {
    let rejection =
        planning::validate_task_atoms_for_assignment(&atoms_with_source(source), "TE01-", registry)
            .expect_err("unverified source must reject");
    assert_eq!(rejection.boundary_id(), "planning.task-atoms.v1");
    assert!(
        rejection.actual().contains("field=atoms.sources"),
        "rejection must name atoms.sources: {}",
        rejection.actual()
    );
    assert!(
        rejection.actual().contains(&format!("got={source}")),
        "rejection must name offending source: {}",
        rejection.actual()
    );
}

fn task_input_set(documents: &[TaskDocument]) -> TaskInputSet {
    TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: documents
            .iter()
            .filter(|document| document.class == TaskDocumentClass::Authority)
            .cloned()
            .collect(),
        context_documents: documents
            .iter()
            .filter(|document| document.class == TaskDocumentClass::ContextNonAuthority)
            .cloned()
            .collect(),
    }
}

fn planning_doc(path: &str, class: TaskDocumentClass, body: &str) -> TaskDocument {
    TaskDocument {
        id: path.to_owned(),
        path: path.to_owned(),
        class,
        authority_set_id: "auth".to_owned(),
        body: body.to_owned(),
        digest: sha256_hex(body.as_bytes()),
    }
}

fn work_map(links: &[&str]) -> String {
    json!({"units":[{"id":"U1","kind":"implementation","objective":"Implement unit","criteria":["done"],"depends_on":[],"files":["src/lib.rs"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":links}]})
        .to_string()
}

fn scout_dossier() -> String {
    json!({"findings":[{"path":"Cargo.toml","observation":"exists","evidence_ref":"repo://Cargo.toml"}]}).to_string()
}

fn plan_review() -> String {
    json!({"verdicts": drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA.iter().map(|criterion| json!({"criterion_id": criterion, "verdict": "pass"})).collect::<Vec<_>>()}).to_string()
}

fn runner_doc(path: &str, class: &str, authority_set_id: &str, body: &str) -> RunnerTaskDocument {
    RunnerTaskDocument::new(
        path.to_owned(),
        class.to_owned(),
        task_file_digest(class, authority_set_id, body),
        body.to_owned(),
    )
}

fn runner_doc_json(
    path: &str,
    class: &str,
    authority_set_id: &str,
    body: &str,
) -> serde_json::Value {
    let doc = runner_doc(path, class, authority_set_id, body);
    json!({"path":doc.path,"class":doc.class,"digest":doc.digest,"body_digest":doc.body_digest,"body":doc.body})
}

fn anchor(path: &str, class: &str, authority_set_id: &str, body: &str) -> String {
    format!(
        "task://{}/{}#whole-file",
        task_file_digest(class, authority_set_id, body),
        path
    )
}

fn task_file_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn submit_bindings_py() -> String {
    let rows = kernel::generated::TERMINAL_PROFILES
        .iter()
        .filter(|(_, tool_name, boundary_id, _, _)| {
            boundary_id.get(..9) == Some("planning.")
                && tool_name.get(..17) == Some("autopilot_submit_")
        })
        .map(|(_, tool_name, boundary_id, result_contract, digest)| {
            format!("    {tool_name:?}: ({boundary_id:?}, {result_contract:?}, {digest:?})")
        })
        .collect::<Vec<_>>()
        .join(",\n");
    format!("{{\n{rows}\n}}")
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

/// Derive the lens the package itself would bind for the first assignment of `role`.
/// Uses the real allocator so this fixture can never drift from production behavior.
fn first_mode_parameter_for(role: &str) -> Option<String> {
    let roles = drivers::roles::RoleRegistry::package().expect("role registry");
    let role = roles.get(role).expect("role is registered");
    drivers::roles::allocate_mode_parameters(role, role.mode_parameters.len().max(1))
        .expect("mode parameter allocation")
        .first()
        .cloned()
        .flatten()
}
