#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static CWD_LOCK: Mutex<()> = Mutex::new(());

use drivers::planning::{
    self, PlanningError, TaskDocumentClass, TaskInputSet, p1_inventory_from_input_set,
};
use drivers::runner;
use drivers::seam::{self, CoreState};
use kernel::generated::{CoreToHostDonePayload, CoreToHostSpawnPayload, SeamEnvelope};
use sha2::{Digest as ShaDigest, Sha256};

#[test]
fn task_path_classification_exact_three_authority_one_context_pack_passes_and_context_is_not_work()
{
    let root = temp_repo("classification-pass");
    write_pack(
        &root,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-a", "set-a", "set-a", "set-a"],
    );
    let input = classify(&root, pack_paths());

    assert_eq!(input.authority_set_id, "set-a");
    assert_eq!(input.authority_documents.len(), 3);
    assert_eq!(input.context_documents.len(), 1);
    assert!(
        input
            .authority_documents
            .iter()
            .all(|doc| doc.class == TaskDocumentClass::Authority)
    );
    assert_eq!(
        input.context_documents[0].class,
        TaskDocumentClass::ContextNonAuthority
    );

    let inventory = p1_inventory_from_input_set(&input).expect("inventory");
    assert_eq!(inventory.atoms.len(), 3);
    assert!(
        inventory
            .atoms
            .iter()
            .all(|atom| !atom.statement.contains("CONTEXT-SENTINEL-UNIQUE"))
    );
}

#[test]
fn task_path_classification_rejects_count_order_id_header_path_symlink_duplicate_and_forbidden_markers()
 {
    let root = temp_repo("classification-negative");
    write_pack(
        &root,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-a", "set-a", "set-a", "set-a"],
    );

    let no_context = planning::classify_task_file_pack(&root, &pack_paths()[..3])
        .expect_err("missing context rejected");
    assert!(format!("{no_context:?}").contains("no [context/non-authority] document supplied"));
    let context_first = classify(
        &root,
        vec![
            PathBuf::from("CONTEXT.md"),
            PathBuf::from("TASK-A.md"),
            PathBuf::from("TASK-B.md"),
            PathBuf::from("TASK-C.md"),
        ],
    );
    assert_eq!(context_first.authority_documents.len(), 3);
    assert_eq!(context_first.context_documents.len(), 1);
    assert_eq!(context_first.context_documents[0].path, "CONTEXT.md");

    fs::write(root.join("TASK-B.md"), doc("[authority]", "other", "B")).expect("mismatch write");
    let mismatch = classify_err(&root, pack_names());
    assert!(format!("{mismatch:?}").contains("authority_set_id mismatch"));
    fs::write(root.join("TASK-B.md"), doc("[authority]", "set-a", "B")).expect("restore");

    fs::write(
        root.join("TASK-A.md"),
        "\u{feff}[authority]\nauthority_set_id: set-a\n\nA",
    )
    .expect("bom");
    assert!(matches!(
        classify_err(&root, pack_names()),
        PlanningError::TaskHeader(_)
    ));
    fs::write(
        root.join("TASK-A.md"),
        "[authority]\r\nauthority_set_id: set-a\r\n\r\nA",
    )
    .expect("crlf");
    assert!(matches!(
        classify_err(&root, pack_names()),
        PlanningError::TaskHeader(_)
    ));
    fs::write(root.join("TASK-A.md"), doc("[unknown]", "set-a", "A")).expect("unknown marker");
    assert!(matches!(
        classify_err(&root, pack_names()),
        PlanningError::TaskHeader(_)
    ));
    fs::write(root.join("TASK-A.md"), doc("[authority]", "set-a", "")).expect("empty body");
    assert!(matches!(
        classify_err(&root, pack_names()),
        PlanningError::TaskHeader(_)
    ));
    fs::write(root.join("TASK-A.md"), doc("[authority]", "set-a", "A")).expect("restore");

    assert!(matches!(
        classify_err(
            &root,
            vec!["TASK-A.md", "TASK-A.md", "TASK-B.md", "CONTEXT.md"]
        ),
        PlanningError::DuplicateTaskPath(_)
    ));
    assert!(matches!(
        planning::classify_task_file_pack(
            &root,
            &[
                PathBuf::from("../outside.md"),
                PathBuf::from("TASK-B.md"),
                PathBuf::from("TASK-C.md"),
                PathBuf::from("CONTEXT.md")
            ]
        ),
        Err(PlanningError::TaskPath(_))
    ));
    assert!(matches!(
        planning::classify_task_file_pack(
            &root,
            &[
                root.join("TASK-A.md"),
                PathBuf::from("TASK-B.md"),
                PathBuf::from("TASK-C.md"),
                PathBuf::from("CONTEXT.md")
            ]
        ),
        Err(PlanningError::TaskPath(_))
    ));
    assert!(matches!(
        planning::classify_task_file_pack(
            &root,
            &[
                PathBuf::from("bad\\path.md"),
                PathBuf::from("TASK-B.md"),
                PathBuf::from("TASK-C.md"),
                PathBuf::from("CONTEXT.md")
            ]
        ),
        Err(PlanningError::TaskPath(_))
    ));

    fs::remove_file(root.join("TASK-C.md")).expect("remove regular c");
    fs::create_dir(root.join("TASK-C.md")).expect("directory at task path");
    assert!(matches!(
        classify_err(&root, pack_names()),
        PlanningError::TaskPath(_)
    ));
    fs::remove_dir(root.join("TASK-C.md")).expect("remove directory c");
    fs::write(root.join("TASK-C.md"), doc("[authority]", "set-a", "C"))
        .expect("restore c after directory");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::remove_file(root.join("TASK-C.md")).expect("remove c");
        symlink(root.join("TASK-B.md"), root.join("TASK-C.md")).expect("symlink c");
        assert!(matches!(
            classify_err(&root, pack_names()),
            PlanningError::TaskPath(_)
        ));
        fs::remove_file(root.join("TASK-C.md")).expect("remove symlink");
        fs::write(root.join("TASK-C.md"), doc("[authority]", "set-a", "C")).expect("restore c");
    }

    for marker in ["[historical/non-authority]", "[index/non-authority]"] {
        for index in 0..4 {
            write_pack(
                &root,
                [
                    "[authority]",
                    "[authority]",
                    "[authority]",
                    "[context/non-authority]",
                ],
                ["set-a", "set-a", "set-a", "set-a"],
            );
            let names = ["TASK-A.md", "TASK-B.md", "TASK-C.md", "CONTEXT.md"];
            fs::write(root.join(names[index]), doc(marker, "set-a", "forbidden"))
                .expect("forbidden marker");
            let err = classify_err(&root, pack_names());
            match marker {
                "[historical/non-authority]" => {
                    assert!(matches!(err, PlanningError::HistoricalTaskInput(_)))
                }
                "[index/non-authority]" => assert!(matches!(err, PlanningError::IndexTaskInput(_))),
                _ => unreachable!(),
            }
        }
    }
}

#[test]
fn task_path_classification_exact_four_path_command_spawns_and_hlo_replacement_does_not_mutate() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("classification-seam");
    write_pack(
        &root,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-smf", "set-smf", "set-smf", "set-smf"],
    );
    git_init(&root);
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("state");
    let ok = send_command(
        &mut state,
        "autopilot-plan main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md",
    );
    assert_eq!(ok.kind, "spawn-wave", "payload={}", ok.payload);
    let spawn = first_wave_action(&ok.payload);
    assert_eq!(
        spawn.action.assignment_id.0,
        "planning-main-task-extractor-01"
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join(".pi/autopilot/main/planning-manifest.json")).expect("manifest"),
    )
    .expect("manifest json");
    assert_eq!(manifest["authority_set_id"], "set-smf");
    assert_eq!(manifest["atoms"], 3);
    assert_eq!(manifest["context"]["path"], "CONTEXT.md");
    let prompt = fs::read_to_string(
        root.join(".pi/autopilot/main/planning/prompts/planning-main-task-extractor-01.md"),
    )
    .expect("planning prompt");
    // The renderer binds task documents as path+digest required-reads instead of inlining
    // bodies, so assert the bindings rather than the body sentinels.
    assert!(prompt.contains("TASK-A.md"), "{prompt}");
    assert!(prompt.contains("TASK-B.md"), "{prompt}");
    assert!(prompt.contains("TASK-C.md"), "{prompt}");
    assert!(prompt.contains("CONTEXT.md"), "{prompt}");
    assert!(prompt.contains("required_reads"), "{prompt}");
    assert!(
        prompt.contains("## Layer 5 — canonical Context Manifest"),
        "{prompt}"
    );
    let spec: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.join(".pi/autopilot/main/planning/specs/planning-main-task-extractor-01.json"),
        )
        .expect("planning spec"),
    )
    .expect("spec json");
    assert_eq!(
        spec["authority_documents"]
            .as_array()
            .expect("authority docs")
            .len(),
        3
    );
    assert_eq!(spec["context_document"]["body"], "CONTEXT-SENTINEL-UNIQUE");
    assert_eq!(spec["context_document"]["class"], "context/non-authority");

    fs::create_dir_all(root.join("_hlo")).expect("hlo dir");
    fs::write(
        root.join("_hlo/LEDGER.md"),
        doc("[historical/non-authority]", "set-smf", "ledger"),
    )
    .expect("ledger");
    let before = fs::read_dir(root.join(".pi/autopilot/main"))
        .expect("main dir")
        .count();
    let blocked = send_command(
        &mut state,
        "autopilot-plan main TASK-A.md TASK-B.md TASK-C.md _hlo/LEDGER.md",
    );
    assert_eq!(blocked.kind, "done");
    assert!(format!("{}", blocked.payload).contains("HistoricalTaskInput"));
    let after = fs::read_dir(root.join(".pi/autopilot/main"))
        .expect("main dir")
        .count();
    assert_eq!(
        before, after,
        "historical replacement must not create a new task"
    );
    std::env::set_current_dir(previous).expect("restore cwd");
}

#[cfg(unix)]
#[test]
fn task_path_classification_rejects_root_and_ancestor_symlink_escapes_without_mutation() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    use std::os::unix::fs::symlink;

    let root = temp_repo("classification-symlink");
    write_pack(
        &root,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-a", "set-a", "set-a", "set-a"],
    );
    let link_root = root.with_file_name(format!(
        "{}-link",
        root.file_name().expect("root name").to_string_lossy()
    ));
    symlink(&root, &link_root).expect("root symlink");
    assert!(matches!(
        planning::classify_task_file_pack(&link_root, &pack_paths()),
        Err(PlanningError::TaskPath(_))
    ));

    let outside = temp_repo("classification-outside");
    write_pack(
        &outside,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-a", "set-a", "set-a", "set-a"],
    );
    symlink(&outside, root.join("linked-pack")).expect("ancestor symlink");
    let escaped = vec![
        "linked-pack/TASK-A.md",
        "linked-pack/TASK-B.md",
        "linked-pack/TASK-C.md",
        "linked-pack/CONTEXT.md",
    ];
    assert!(matches!(
        classify_err(&root, escaped.clone()),
        PlanningError::TaskPath(_)
    ));

    git_init(&root);
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("state");
    let blocked = send_command(
        &mut state,
        "autopilot-plan main linked-pack/TASK-A.md linked-pack/TASK-B.md linked-pack/TASK-C.md linked-pack/CONTEXT.md",
    );
    assert_eq!(blocked.kind, "done");
    assert!(format!("{}", blocked.payload).contains("TaskPath"));
    assert!(
        !root
            .join(".pi/autopilot/main/planning-manifest.json")
            .exists()
    );
    std::env::set_current_dir(previous).expect("restore cwd");
}

#[test]
fn task_path_classification_terminal_events_require_core_issued_action_assignment_and_accept_exact_carrier()
 {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("terminal-binding");
    write_pack(
        &root,
        [
            "[authority]",
            "[authority]",
            "[authority]",
            "[context/non-authority]",
        ],
        ["set-a", "set-a", "set-a", "set-a"],
    );
    git_init(&root);
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("state");
    let plan = send_command(
        &mut state,
        "autopilot-plan main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md",
    );
    let spawn = first_wave_action(&plan.payload);
    // One issue event per launched wave member: the P1 extractor wave plus the run event.
    assert!(
        state_status(&mut state).contains("state:sequence=8;revision=8"),
        "{}",
        state_status(&mut state)
    );

    let before_forged = state_status(&mut state);
    let forged = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":9,"kind":"task-completed","payload":{"task_id":"forged-task","action_id":"never-issued-action","assignment_id":"never-issued-assignment","status":"failed"}}),
    );
    assert_eq!(forged.kind, "done");
    assert!(done_status(&forged).contains("terminal-binding"));
    assert_eq!(
        state_status(&mut state),
        before_forged,
        "forged terminal must not mutate state"
    );

    let spec_path =
        root.join(".pi/autopilot/main/planning/specs/planning-main-task-extractor-01.json");
    let spec_text = fs::read_to_string(&spec_path).expect("spec");
    let spec: serde_json::Value = serde_json::from_str(&spec_text).expect("spec json");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":spawn.action.action_id.0,
        "assignment_id":spawn.action.assignment_id.0,
        "run_revision":spawn.action.run_revision,
        "workstream":"main",
        "role_id":"task-extractor",
        "mode":"inventory",
        "boundary_id":"planning.task-atoms.v1",
        "result_contract":"planning.task-atoms.v1",
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "spec_digest":sha256_hex(spec_text.as_bytes()),
        "spec_path":spec_path,
        "carrier_path":carrier_path,
        "raw_output":common::planning_replay_output("planning.task-atoms.v1", &spec, &spec_path, None)
    });
    fs::write(
        carrier_path,
        serde_json::to_vec_pretty(&carrier).expect("carrier json"),
    )
    .expect("carrier write");
    let completed = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":10,"kind":"task-completed","payload":{"task_id":"task-real-1","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}),
    );
    // This harness never sends `spawn-result`, so the sibling P1 members remain
    // unacknowledged and Core re-emits exactly those already-issued actions rather than
    // issuing new bindings. Re-emission must never include the accepted member.
    assert_eq!(completed.kind, "spawn-wave", "{}", completed.payload);
    let reemitted = completed.payload["actions"]
        .as_array()
        .expect("spawn-wave actions")
        .iter()
        .map(|action| {
            action["assignment_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        !reemitted.contains(&"planning-main-task-extractor-01".to_owned()),
        "accepted member must not be re-emitted: {reemitted:?}"
    );
    assert!(
        reemitted.contains(&"planning-main-task-extractor-02".to_owned()),
        "unacknowledged siblings must be re-emitted: {reemitted:?}"
    );

    let accepted = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":12,"kind":"agent-result","payload":{"assignment_id":spawn.action.assignment_id,"carrier":carrier}}),
    );
    assert_eq!(accepted.kind, "done");
    assert!(done_status(&accepted).contains("agent-result:already-accepted"));

    let duplicate = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":11,"kind":"task-completed","payload":{"task_id":"task-real-1","action_id":"action-planning-main-task-extractor-01","assignment_id":"planning-main-task-extractor-01","status":"completed"}}),
    );
    assert_eq!(duplicate.kind, "done");
    assert!(done_status(&duplicate).contains("already-consumed"));
    std::env::set_current_dir(previous).expect("restore cwd");
}

#[test]
fn task_path_classification_delivery_runtime_packages_uncommitted_lane_changes_and_ignores_unclaimed_residue()
 {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("delivery-runtime-package");
    fs::write(root.join("README.md"), "delivery terminal fixture\n").expect("fixture file");
    git_init(&root);
    let repo_authority =
        runner::repository_authority_binding(&root, "main").expect("repo authority");
    fs::create_dir_all(root.join(".pi/autopilot/main")).expect("plan dir");
    fs::write(root.join(".pi/autopilot/main/approved-plan.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "repository_authority": {"manifest_path": repo_authority.path, "manifest_digest": repo_authority.digest, "head_commit": repo_authority.manifest.head_commit, "head_tree": repo_authority.manifest.head_tree},
        "units":[
            {"id":"U1","kind":"implementation","objective":"deliver U1","operator_order":1,"decisions":[],"criteria":["AC1"],"criterion_text":[{"id":"AC1","text":"criterion text AC1"}],"dependencies":[],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE1"],"files":["README.md",".gitignore"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]}
        ]
    })).expect("approved json")).expect("approved plan");
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
        std::env::set_var(
            "AUTOPILOT_VALIDATOR_COMMAND",
            std::env::current_exe().expect("exe"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let event_path = root.join(".pi/autopilot/events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).expect("state");
    let launch = send_command(&mut state, "autopilot main");
    assert_eq!(launch.kind, "spawn");
    let spawn: CoreToHostSpawnPayload =
        serde_json::from_value(launch.payload).expect("delivery spawn");
    let spec_path = root
        .join(".pi/autopilot/main/worktrees/L1/.pi/autopilot/runner/specs/assignment-main-L1.json");
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).expect("delivery spec"))
            .expect("delivery spec json");
    assert_eq!(spec["schema"], "autopilot.agent_run_spec.v4");
    assert_eq!(spec["assignment_kind"], "delivery");
    assert_eq!(spec["terminal_profile_id"], "delivery-status.v2");
    assert_eq!(spec["boundary_id"], "autopilot.delivery_submission.v2");
    assert_eq!(spec["result_contract"], "autopilot.delivery_result.v2");
    assert!(
        spec["allowed_tools"]
            .as_array()
            .expect("delivery tools")
            .iter()
            .any(|tool| tool == "autopilot_emit_status")
    );
    assert!(spec["runtime_extension_path"].as_str().is_some());
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let worktree = PathBuf::from(spec["worktree"].as_str().expect("worktree path"));
    let base_commit = git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]);
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    fs::write(worktree.join("Cargo.lock"), "# build residue\n").expect("cargo residue");
    fs::create_dir_all(worktree.join(".pi/autopilot/runner/attempt-events"))
        .expect("attempt-events dir");
    fs::create_dir_all(worktree.join(".pi/autopilot/runner/carriers")).expect("carriers dir");
    fs::write(
        worktree.join(".pi/autopilot/runner/attempt-events/assignment-main-L1.jsonl"),
        "{}\n",
    )
    .expect("attempt event artifact");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_without_package(&spec, 2))
            .expect("delivery carrier"),
    )
    .expect("carrier write");

    let accepted = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":30,"kind":"task-completed","payload":{"task_id":"task-delivery-runtime","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}),
    );
    assert_eq!(accepted.kind, "spawn");
    let validation: CoreToHostSpawnPayload =
        serde_json::from_value(accepted.payload).expect("validation spawn");
    assert_eq!(
        validation.action.assignment_id.0,
        "validator-assignment-main-L1"
    );
    assert!(validation.action.bg_run.command.0.contains(" --spec "));
    assert!(
        !validation
            .action
            .bg_run
            .command
            .0
            .contains("pi --mode json")
    );
    let validation_spec_path = worktree
        .join(".pi/autopilot/main/validation/validator-assignment-main-L1/agent-run-spec.json");
    let validation_spec: serde_json::Value = serde_json::from_slice(
        &fs::read(&validation_spec_path).expect("validation agent-run spec"),
    )
    .expect("validation spec json");
    assert_eq!(validation_spec["schema"], "autopilot.agent_run_spec.v4");
    assert_eq!(validation_spec["assignment_kind"], "validation");
    assert_eq!(
        validation_spec["terminal_profile_id"],
        "validation-status.v2"
    );
    assert_eq!(
        validation_spec["boundary_id"],
        "autopilot.validation_submission.v2"
    );
    assert_eq!(
        validation_spec["result_contract"],
        "autopilot.validation_result.v2"
    );
    assert_eq!(
        validation_spec["allowed_tools"],
        serde_json::json!(["read", "grep", "find", "ls", "autopilot_emit_status"])
    );
    assert_eq!(
        validation_spec["unavailable_tools"],
        serde_json::json!(["autopilot_request_test"])
    );
    let validation_context: serde_json::Value = serde_json::from_slice(
        &fs::read(
            validation_spec["context_manifest_path"]
                .as_str()
                .expect("context path"),
        )
        .expect("validation context"),
    )
    .expect("context json");
    assert_eq!(
        validation_context["exact_commit"],
        git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"])
    );
    assert_eq!(
        validation_context["candidate"]["actual_changed_paths"],
        serde_json::json!(["README.md"])
    );
    assert_eq!(
        validation_context["criteria"]
            .as_array()
            .expect("criteria")
            .len(),
        1
    );
    assert_eq!(
        validation_context["evidence"]
            .as_array()
            .expect("evidence")
            .len(),
        2
    );
    let criterion = &validation_context["criteria"][0];
    assert_eq!(criterion["requirement_text"], "criterion text AC1");
    assert_eq!(
        criterion["covered_paths"],
        serde_json::json!(["README.md", ".gitignore"]),
        "validation criteria must retain complete approved scope, not fall back to changed paths"
    );
    assert_eq!(
        criterion["commands"],
        serde_json::json!([{
            "command_id":"CMD-U1-1",
            "command":"cargo test -q",
            "expected":"pass",
            "effect":"no-effect",
            "generated_paths":[],
            "handling":"none",
            "scope_preservation":"Final Git-visible state remains limited to the approved unit files."
        }])
    );
    let evidence_ref = validation_context["evidence"][0]["evidence_ref"]
        .as_str()
        .expect("evidence ref");
    let submission_value = serde_json::json!({
        "schema":"autopilot.validation_submission.v2",
        "validation_id":validation_context["validation_id"],
        "assignment_id":validation_context["assignment_id"],
        "scope":"forward",
        "exact_commit":validation_context["exact_commit"],
        "exact_tree":validation_context["exact_tree"],
        "outcome":"FORWARD_READY",
        "criterion_results":[{
            "criterion_id":criterion["criterion_id"],
            "verdict":"PASS",
            "evidence_refs":[evidence_ref],
            "finding_ids":[],
            "covered_paths":criterion["covered_paths"],
            "semantic_surface_ids":criterion["semantic_surface_ids"],
            "forward_edge_ids":criterion["forward_edge_ids"]
        }],
        "findings":[]
    });
    let typed_spec: kernel::generated::AgentRunSpec =
        serde_json::from_value(validation_spec.clone()).expect("typed validation spec");
    let valid_submission: kernel::generated::ValidationSubmissionV2 =
        serde_json::from_value(submission_value.clone()).expect("typed submission");
    drivers::runner::child::admit_validation_submission(&typed_spec, &valid_submission)
        .expect("issued validation submission");
    for (label, mutate) in [
        (
            "forged-commit",
            serde_json::json!("0000000000000000000000000000000000000000"),
        ),
        ("unknown-evidence", serde_json::json!("evidence:unknown")),
    ] {
        let mut forged = submission_value.clone();
        if label == "forged-commit" {
            forged["exact_commit"] = mutate;
        } else {
            forged["criterion_results"][0]["evidence_refs"][0] = mutate;
        }
        let forged: kernel::generated::ValidationSubmissionV2 =
            serde_json::from_value(forged).expect("typed forged submission");
        assert!(
            drivers::runner::child::admit_validation_submission(&typed_spec, &forged).is_err(),
            "{label} must be rejected"
        );
    }
    for (field, invented) in [
        ("covered_paths", "outside-approved-scope.txt"),
        ("semantic_surface_ids", "invented-surface"),
        ("forward_edge_ids", "invented-edge"),
    ] {
        let mut forged = submission_value.clone();
        forged["criterion_results"][0][field]
            .as_array_mut()
            .expect("coverage array")
            .push(serde_json::json!(invented));
        let forged: kernel::generated::ValidationSubmissionV2 =
            serde_json::from_value(forged).expect("typed invented coverage submission");
        assert!(
            drivers::runner::child::admit_validation_submission(&typed_spec, &forged).is_err(),
            "validator must not invent extra {field} authority"
        );
    }
    let mut blocked_with_finding = submission_value.clone();
    blocked_with_finding["outcome"] = serde_json::json!("BLOCKED");
    blocked_with_finding["criterion_results"][0]["verdict"] = serde_json::json!("FAIL");
    blocked_with_finding["criterion_results"][0]["finding_ids"] =
        serde_json::json!(["finding-validation-1"]);
    blocked_with_finding["findings"] = serde_json::json!([{
        "finding_id":"finding-validation-1",
        "kind":"source-defect",
        "effect":"forward-blocking",
        "summary":"issued scope defect",
        "detail":"the exact issued criterion is not satisfied",
        "criterion_ids":[criterion["criterion_id"].clone()],
        "edge_ids":criterion["forward_edge_ids"].clone(),
        "evidence_refs":[evidence_ref],
        "covered_paths":criterion["covered_paths"].clone(),
        "semantic_surface_ids":criterion["semantic_surface_ids"].clone()
    }]);
    let typed_blocked: kernel::generated::ValidationSubmissionV2 =
        serde_json::from_value(blocked_with_finding.clone()).expect("typed blocked finding");
    drivers::runner::child::admit_validation_submission(&typed_spec, &typed_blocked)
        .expect("finding bound to exact issued authority");
    for (field, invented) in [
        ("criterion_ids", "invented-criterion"),
        ("edge_ids", "invented-edge"),
        ("evidence_refs", "invented-evidence"),
        ("covered_paths", "invented-path"),
        ("semantic_surface_ids", "invented-surface"),
    ] {
        let mut forged = blocked_with_finding.clone();
        forged["findings"][0][field] = serde_json::json!([invented]);
        let forged: kernel::generated::ValidationSubmissionV2 =
            serde_json::from_value(forged).expect("typed forged finding scope");
        assert!(
            drivers::runner::child::admit_validation_submission(&typed_spec, &forged).is_err(),
            "validator finding must not invent {field} authority"
        );
    }
    let mut unknown_finding_link = blocked_with_finding.clone();
    unknown_finding_link["criterion_results"][0]["finding_ids"] =
        serde_json::json!(["invented-finding"]);
    let unknown_finding_link: kernel::generated::ValidationSubmissionV2 =
        serde_json::from_value(unknown_finding_link).expect("typed unknown finding link");
    assert!(
        drivers::runner::child::admit_validation_submission(&typed_spec, &unknown_finding_link)
            .is_err()
    );
    let mut omitted = valid_submission.clone();
    omitted.criterion_results.clear();
    assert!(drivers::runner::child::admit_validation_submission(&typed_spec, &omitted).is_err());
    let mut false_ready = valid_submission.clone();
    false_ready.criterion_results[0].verdict = kernel::generated::CriterionVerdict::FAIL;
    assert!(
        drivers::runner::child::admit_validation_submission(&typed_spec, &false_ready).is_err()
    );
    let package_commit = git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]);
    assert_ne!(
        package_commit, base_commit,
        "runtime must create a delivery commit"
    );
    assert_eq!(
        git_out(
            &worktree,
            &["diff", "--name-only", &base_commit, &package_commit, "--"]
        ),
        "README.md"
    );
    assert!(
        worktree.join("Cargo.lock").exists(),
        "residue is not packaged"
    );
    let events = fs::read_to_string(&event_path).expect("event log");
    assert!(events.contains("agent:delivery-accepted"));
    assert!(events.contains(&package_commit));
    std::env::set_current_dir(previous).expect("restore cwd");
}

#[test]
fn task_path_classification_delivery_runtime_adopts_existing_agent_commit_without_duplicate_package_commit()
 {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("delivery-runtime-adopt");
    fs::write(root.join("README.md"), "delivery terminal fixture\n").expect("fixture file");
    git_init(&root);
    let repo_authority =
        runner::repository_authority_binding(&root, "main").expect("repo authority");
    fs::create_dir_all(root.join(".pi/autopilot/main")).expect("plan dir");
    fs::write(root.join(".pi/autopilot/main/approved-plan.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "repository_authority": {"manifest_path": repo_authority.path, "manifest_digest": repo_authority.digest, "head_commit": repo_authority.manifest.head_commit, "head_tree": repo_authority.manifest.head_tree},
        "units":[
            {"id":"U1","kind":"implementation","objective":"deliver U1","operator_order":1,"decisions":[],"criteria":["AC1"],"criterion_text":[{"id":"AC1","text":"criterion text AC1"}],"dependencies":[],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE1"],"files":["README.md"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]}
        ]
    })).expect("approved json")).expect("approved plan");
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
        std::env::set_var(
            "AUTOPILOT_VALIDATOR_COMMAND",
            std::env::current_exe().expect("exe"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("state");
    let launch = send_command(&mut state, "autopilot main");
    assert_eq!(launch.kind, "spawn");
    let spawn: CoreToHostSpawnPayload =
        serde_json::from_value(launch.payload).expect("delivery spawn");
    let spec_path = root
        .join(".pi/autopilot/main/worktrees/L1/.pi/autopilot/runner/specs/assignment-main-L1.json");
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).expect("delivery spec"))
            .expect("delivery spec json");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let worktree = PathBuf::from(spec["worktree"].as_str().expect("worktree path"));
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    run(&worktree, &["add", "README.md"]);
    run(
        &worktree,
        &["commit", "-m", "agent-created delivery commit"],
    );
    let agent_commit = git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let before_count = git_out(&worktree, &["rev-list", "--count", "HEAD"]);
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_without_package(&spec, 2))
            .expect("delivery carrier"),
    )
    .expect("carrier write");

    let accepted = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":31,"kind":"task-completed","payload":{"task_id":"task-delivery-adopt","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}),
    );
    assert_eq!(accepted.kind, "spawn");
    assert_eq!(
        git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]),
        agent_commit,
        "runtime must adopt the existing package commit"
    );
    assert_eq!(
        git_out(&worktree, &["rev-list", "--count", "HEAD"]),
        before_count,
        "runtime must not create a duplicate commit"
    );
    std::env::set_current_dir(previous).expect("restore cwd");
}

#[test]
fn task_path_classification_delivery_terminal_carrier_is_core_accepted_and_incomplete_delivery_is_rejected_without_mutation()
 {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("delivery-terminal");
    fs::write(root.join("README.md"), "delivery terminal fixture\n").expect("fixture file");
    git_init(&root);
    let repo_authority =
        runner::repository_authority_binding(&root, "main").expect("repo authority");
    fs::create_dir_all(root.join(".pi/autopilot/main")).expect("plan dir");
    fs::write(root.join(".pi/autopilot/main/approved-plan.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "repository_authority": {"manifest_path": repo_authority.path, "manifest_digest": repo_authority.digest, "head_commit": repo_authority.manifest.head_commit, "head_tree": repo_authority.manifest.head_tree},
        "units":[
            {"id":"U1","kind":"implementation","objective":"deliver U1","operator_order":1,"decisions":[],"criteria":["AC1"],"criterion_text":[{"id":"AC1","text":"criterion text AC1"}],"dependencies":[],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE1"],"files":["README.md"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]},
            {"id":"U2","kind":"implementation","objective":"deliver U2","operator_order":2,"decisions":[],"criteria":["AC2"],"criterion_text":[{"id":"AC2","text":"criterion text AC2"}],"dependencies":["U1"],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE2"],"files":["README.md"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]},
            {"id":"U3","kind":"implementation","objective":"deliver U3","operator_order":3,"decisions":[],"criteria":["AC3"],"criterion_text":[{"id":"AC3","text":"criterion text AC3"}],"dependencies":["U2"],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE3"],"files":["README.md"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]}
        ]
    })).expect("approved json")).expect("approved plan");
    let previous = std::env::current_dir().expect("cwd");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
        std::env::set_var(
            "AUTOPILOT_VALIDATOR_COMMAND",
            std::env::current_exe().expect("exe"),
        );
    }
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("state");
    let launch = send_command(&mut state, "autopilot main");
    assert_eq!(launch.kind, "spawn");
    let spawn: CoreToHostSpawnPayload =
        serde_json::from_value(launch.payload).expect("delivery spawn");
    assert_eq!(spawn.action.assignment_id.0, "assignment-main-L1");
    let spec_path = root
        .join(".pi/autopilot/main/worktrees/L1/.pi/autopilot/runner/specs/assignment-main-L1.json");
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).expect("delivery spec"))
            .expect("delivery spec json");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let worktree = PathBuf::from(spec["worktree"].as_str().expect("worktree path"));
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    run(&worktree, &["add", "README.md"]);
    run(&worktree, &["commit", "-m", "delivery terminal package"]);
    let package_commit = git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let package_tree = git_out(&worktree, &["rev-parse", "--verify", "HEAD^{tree}"]);
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier(&spec, &package_commit, &package_tree, 1))
            .expect("bad delivery"),
    )
    .expect("bad carrier");
    let before = state_status(&mut state);
    let rejected = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":20,"kind":"task-completed","payload":{"task_id":"task-delivery-1","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}),
    );
    assert_eq!(rejected.kind, "done");
    let rejected_status = done_status(&rejected);
    assert!(
        rejected_status
            .contains("delivery submission requires at least 2 nonempty focused evidence refs"),
        "unexpected delivery rejection status: {rejected_status}"
    );
    assert_eq!(
        state_status(&mut state),
        before,
        "bad delivery must not mutate state"
    );

    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier(&spec, &package_commit, &package_tree, 2))
            .expect("good delivery"),
    )
    .expect("good carrier");
    let accepted = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":21,"kind":"task-completed","payload":{"task_id":"task-delivery-1","action_id":"action-main-L1","assignment_id":"assignment-main-L1","status":"completed"}}),
    );
    assert_eq!(accepted.kind, "spawn");
    let validation: CoreToHostSpawnPayload =
        serde_json::from_value(accepted.payload).expect("validation spawn");
    assert_eq!(
        validation.action.assignment_id.0,
        "validator-assignment-main-L1"
    );
    std::env::set_current_dir(previous).expect("restore cwd");
}

fn delivery_carrier(
    spec: &serde_json::Value,
    package_commit: &str,
    package_tree: &str,
    evidence_count: usize,
) -> serde_json::Value {
    let _ = (package_commit, package_tree);
    delivery_carrier_without_package(spec, evidence_count)
}

fn delivery_carrier_without_package(
    spec: &serde_json::Value,
    evidence_count: usize,
) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("spec");
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|row| row.0 == "delivery-status.v2")
        .expect("profile");
    let submission = serde_json::json!({
        "actual_changed_paths":["README.md"],
        "execution_audit_ref":"audit:delivery",
        "focused_evidence_refs":(0..evidence_count).map(|index| serde_json::json!(format!("evidence:{index}"))).collect::<Vec<_>>(),
        "terminal_status":"succeeded",
        "hard_boundary_violations":[]
    });
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let binding = drivers::runner::child::carrier_binding(&typed);
    let tool_call_id = "delivery-tool-call-1";
    let audit = serde_json::json!({"schema":"autopilot.tool_audit.v1","tool_call_id":tool_call_id,"profile_id":profile.0,"tool_name":profile.1,"boundary_id":profile.2,"result_contract":profile.3,"schema_digest":profile.4,"binding":binding,"submission_digest":submission_digest,"delivery_policy":{"version":drivers::runner::DELIVERY_POLICY_VERSION,"assignment_path":typed.assignment_path.as_ref().expect("assignment path").0.clone(),"assignment_digest":typed.assignment_digest.as_ref().expect("assignment digest").0.clone(),"worktree":typed.worktree.as_ref().expect("worktree").0.clone(),"cwd":typed.cwd.0.clone(),"policy_digest":drivers::runner::delivery_policy_digest(&typed.assignment_path.as_ref().expect("assignment path").0,&typed.assignment_digest.as_ref().expect("assignment digest").0,&typed.worktree.as_ref().expect("worktree").0,&typed.cwd.0),"active_overrides":["bash","edit","write"],"denials":{"schema":"autopilot.delivery_policy_denials.v1","overflowed":false,"entries":[]}}});
    let audit_bytes = serde_json::to_vec_pretty(&audit).expect("audit");
    let audit_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier"))
        .with_extension("tool-audit.json");
    fs::write(&audit_path, &audit_bytes).expect("audit write");
    let spec_bytes =
        fs::read_to_string(spec["spec_path"].as_str().expect("spec path")).expect("spec bytes");
    serde_json::json!({
        "schema":"autopilot.delivery_result.v2","assignment_id":spec["assignment_id"],"role_id":spec["role_id"],"mode":spec["mode"],"run_revision":spec["run_revision"],"workstream":spec["workstream"],"lane_id":spec["lane_id"],"attempt":spec["attempt"],"base_commit":spec["base_commit"],"worktree":spec["worktree"],"action_id":spec["action_id"],"prompt_path":spec["prompt_path"],"prompt_digest":spec["prompt_digest"],"spec_path":spec["spec_path"],"spec_digest":sha256_hex(spec_bytes.as_bytes()),"spec_bytes":spec_bytes,"carrier_path":spec["carrier_path"],"boundary_id":spec["boundary_id"],"boundary_digest":spec["boundary_digest"],"result_contract":spec["result_contract"],"result_contract_digest":spec["result_contract_digest"],"settings_digest":spec["settings_digest"],"context_digest":spec["context_digest"],"skills_digest":spec["skills_digest"],"subscription_digest":spec["subscription_digest"],"runtime_extension_digest":spec["runtime_extension_digest"],"terminal_profile_id":profile.0,"tool_name":profile.1,"tool_schema_digest":profile.4,"carrier_binding":binding,"tool_call_id":tool_call_id,"tool_audit_ref":audit_path.display().to_string(),"tool_audit_digest":sha256_hex(&audit_bytes),"submission_digest":submission_digest,"submission":submission
    })
}

fn send_command(state: &mut CoreState, raw: &str) -> SeamEnvelope {
    let frame = serde_json::json!({"v":1,"id":1,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}});
    send_frame(state, frame)
}

fn send_frame(state: &mut CoreState, frame: serde_json::Value) -> SeamEnvelope {
    seam::handle_line(&frame.to_string(), state).expect("handle line")
}

fn state_status(state: &mut CoreState) -> String {
    done_status(&send_command(state, "state"))
}

fn done_status(envelope: &SeamEnvelope) -> String {
    let payload: CoreToHostDonePayload =
        serde_json::from_value(envelope.payload.clone()).expect("done payload");
    payload.status
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn classify(root: &Path, paths: Vec<PathBuf>) -> TaskInputSet {
    planning::classify_task_file_pack(root, &paths).expect("classified")
}

fn classify_err(root: &Path, names: Vec<&str>) -> PlanningError {
    planning::classify_task_file_pack(
        root,
        &names.into_iter().map(PathBuf::from).collect::<Vec<_>>(),
    )
    .expect_err("classification rejected")
}

fn pack_paths() -> Vec<PathBuf> {
    pack_names().into_iter().map(PathBuf::from).collect()
}

fn pack_names() -> Vec<&'static str> {
    vec!["TASK-A.md", "TASK-B.md", "TASK-C.md", "CONTEXT.md"]
}

fn write_pack(root: &Path, markers: [&str; 4], ids: [&str; 4]) {
    let names = ["TASK-A.md", "TASK-B.md", "TASK-C.md", "CONTEXT.md"];
    let bodies = ["A", "B", "C", "CONTEXT-SENTINEL-UNIQUE"];
    for index in 0..4 {
        fs::write(
            root.join(names[index]),
            doc(markers[index], ids[index], bodies[index]),
        )
        .expect("write pack file");
    }
}

fn doc(marker: &str, id: &str, body: &str) -> String {
    format!("{marker}\nauthority_set_id: {id}\n\n{body}")
}

fn git_init(root: &Path) {
    run(root, &["init"]);
    run(
        root,
        &[
            "config",
            "user.email",
            "task-classification@example.invalid",
        ],
    );
    run(root, &["config", "user.name", "Task Classification"]);
    fs::write(root.join(".gitignore"), ".pi/autopilot/\n.pi/tasks/\n").expect("gitignore");
    run(root, &["add", "."]);
    run(root, &["commit", "-m", "task pack"]);
}

fn run(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .status()
        .expect("git");
    assert!(status.success(), "git {:?} failed", args);
}

fn git_out(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git output");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8(output.stdout)
        .expect("git utf8")
        .trim()
        .to_owned()
}

fn temp_repo(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("pi-autopilot-{name}-{nanos}"));
    fs::create_dir_all(&root).expect("temp root");
    fs::canonicalize(&root).expect("canonical temp root")
}

/// First action of a batched planning `spawn-wave`, as a singular payload view.
fn first_wave_action(payload: &serde_json::Value) -> CoreToHostSpawnPayload {
    let actions = payload["actions"].as_array().expect("spawn-wave actions");
    assert!(
        !actions.is_empty(),
        "spawn-wave must launch at least one action"
    );
    serde_json::from_value(serde_json::json!({ "action": actions[0] })).expect("wave action")
}
