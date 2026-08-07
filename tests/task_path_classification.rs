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
fn task_path_classification_delivery_runtime_packages_uncommitted_lane_changes_for_clean_v3_validation()
 {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo("delivery-runtime-package");
    fs::write(root.join("README.md"), "delivery terminal fixture\n").expect("fixture file");
    fs::write(root.join("obsolete.txt"), "approved deletion fixture\n").expect("deleted fixture");
    git_init(&root);
    let repo_authority =
        runner::repository_authority_binding(&root, "main").expect("repo authority");
    fs::create_dir_all(root.join(".pi/autopilot/main")).expect("plan dir");
    fs::write(root.join(".pi/autopilot/main/approved-plan.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "repository_authority": {"manifest_path": repo_authority.path, "manifest_digest": repo_authority.digest, "head_commit": repo_authority.manifest.head_commit, "head_tree": repo_authority.manifest.head_tree},
        "units":[
            {"id":"U1","kind":"implementation","objective":"deliver U1","operator_order":1,"decisions":[],"criteria":["AC1"],"criterion_text":[{"id":"AC1","text":"criterion text AC1"}],"dependencies":[],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE1"],"files":["README.md",".gitignore","obsolete.txt"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"package_checks":[]}
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
    fs::remove_file(worktree.join("obsolete.txt")).expect("approved file deletion");
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
        serde_json::to_vec_pretty(&delivery_carrier_without_package_paths(
            &spec,
            2,
            &["README.md", "obsolete.txt"],
        ))
        .expect("delivery carrier"),
    )
    .expect("carrier write");

    let accepted = send_frame(
        &mut state,
        serde_json::json!({"v":1,"id":30,"kind":"task-completed","payload":{"task_id":"task-delivery-runtime","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}),
    );
    assert_eq!(accepted.kind, "spawn", "accepted response: {accepted:?}");
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
        "validation-status.v3"
    );
    assert_eq!(
        validation_spec["boundary_id"],
        "autopilot.validation_submission.v3"
    );
    assert_eq!(
        validation_spec["result_contract"],
        "autopilot.validation_result.v3"
    );
    assert_eq!(
        validation_spec["allowed_tools"],
        serde_json::json!(["read", "autopilot_emit_status"])
    );
    assert_eq!(
        validation_spec["unavailable_tools"],
        serde_json::json!(["autopilot_request_test"])
    );
    assert!(
        validation_spec["model_submission_path"]
            .as_str()
            .expect("model submission path")
            .ends_with("model-submission.v3.json")
    );
    let assignment_bytes = fs::read(
        validation_spec["assignment_path"]
            .as_str()
            .expect("assignment path"),
    )
    .expect("v3 assignment");
    let assignment: kernel::generated::ValidationAssignmentV3 =
        serde_json::from_slice(&assignment_bytes).expect("v3 assignment json");
    let context_bytes = fs::read(
        validation_spec["context_manifest_path"]
            .as_str()
            .expect("context path"),
    )
    .expect("v3 validation context");
    let context: kernel::generated::ValidationContextV3 =
        serde_json::from_slice(&context_bytes).expect("v3 context json");
    let authority_bytes = fs::read(&assignment.authority_path.0).expect("v3 authority");
    let authority: kernel::generated::ValidationEvidenceAuthority =
        serde_json::from_slice(&authority_bytes).expect("v3 authority json");
    assert_eq!(
        authority.exact_commit.0,
        git_out(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"])
    );
    assert_eq!(
        authority
            .changed_paths
            .iter()
            .map(|path| path.0.as_str())
            .collect::<Vec<_>>(),
        ["README.md", "obsolete.txt"]
    );
    assert!(!authority.unchanged_recovery);
    assert_eq!(
        authority
            .deleted_paths
            .iter()
            .map(|path| path.0.as_str())
            .collect::<Vec<_>>(),
        ["obsolete.txt"]
    );
    assert!(
        authority
            .source_records
            .iter()
            .all(|record| record.source_path.0 != "obsolete.txt")
    );
    assert_eq!(authority.criteria.len(), 1);
    assert_eq!(authority.criteria[0].unit_id.0, "U1");
    assert_eq!(authority.criteria[0].unit_criterion_ordinal, 1);
    assert_eq!(authority.criteria[0].requirement_text, "criterion text AC1");
    assert_eq!(
        authority.criteria[0]
            .covered_paths
            .iter()
            .map(|path| path.0.as_str())
            .collect::<Vec<_>>(),
        [".gitignore", "README.md", "obsolete.txt"],
        "v3 authority must retain complete approved scope including deletions"
    );
    assert_eq!(authority.command_receipts.len(), 1);
    assert_eq!(authority.command_receipts[0].unit_id.0, "U1");
    let command_receipt: serde_json::Value =
        serde_json::from_str(&authority.command_receipts[0].receipt_json.0)
            .expect("closed v3 command receipt");
    assert_eq!(command_receipt["unit_id"], "U1");
    assert_eq!(authority.criteria[0].command_receipt_refs.len(), 1);
    assert!(
        authority.criteria[0].command_receipt_refs[0]
            .0
            .starts_with("approved-command-receipt:CMD-U1-1:")
    );
    assert!(authority.package_check_receipts.is_empty());
    assert!(authority.criteria[0].package_check_receipt_refs.is_empty());
    assert_eq!(context.criteria.len(), 1);
    assert_eq!(
        context.citation_records.len(),
        authority.source_records.len() + 1
    );
    let diff_citation = context
        .citation_records
        .iter()
        .find(|record| record.kind == "candidate-diff")
        .expect("readable candidate diff citation");
    let diff_path = diff_citation
        .diff_path
        .as_ref()
        .expect("candidate diff path must be model-visible");
    assert_eq!(
        sha256_hex(&fs::read(&diff_path.0).expect("candidate diff bytes")),
        diff_citation
            .diff_digest
            .as_ref()
            .expect("candidate diff digest")
            .0
    );
    let rendered_prompt = fs::read_to_string(
        validation_spec["prompt_path"]
            .as_str()
            .expect("v3 prompt path"),
    )
    .expect("v3 rendered prompt");
    assert!(!rendered_prompt.contains(&assignment.authority_path.0));
    assert!(!rendered_prompt.contains("approved-command-receipt:"));
    assert!(!rendered_prompt.contains("package-check-receipt:"));
    assert!(
        !rendered_prompt.contains("attach evidence refs, finding refs, covered paths"),
        "legacy validation_verdict instructions leaked into v3: {rendered_prompt}"
    );
    assert!(
        !rendered_prompt.contains("For each material issue, record one effect"),
        "legacy finding instructions leaked into v3: {rendered_prompt}"
    );
    assert!(
        !rendered_prompt.contains("terminal result must name the role/mode/assignment"),
        "legacy identity-echo instruction leaked into v3: {rendered_prompt}"
    );
    assert!(rendered_prompt.contains(&context.criteria[0].allowed_citation_refs[0].0));

    let citation = context.criteria[0]
        .allowed_citation_refs
        .first()
        .expect("allowed citation")
        .clone();
    let submission_value = serde_json::json!({
        "schema":"autopilot.validation_submission.v3",
        "criterion_results":[{
            "criterion_id":context.criteria[0].criterion_id,
            "verdict":"PASS",
            "citation_refs":[citation],
            "finding_ids":[]
        }],
        "findings":[]
    });
    assert!(submission_value.get("validation_id").is_none());
    assert!(submission_value.get("outcome").is_none());
    assert!(submission_value.to_string().find("receipt").is_none());
    let valid_submission: kernel::generated::ValidationSubmissionV3 =
        serde_json::from_value(submission_value.clone()).expect("typed v3 submission");
    let (verdict, _) = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &valid_submission,
        1,
    )
    .expect("issued v3 validation submission");
    assert_eq!(
        verdict.outcome,
        kernel::generated::ValidationOutcomeV2::FORWARDREADY
    );
    assert_eq!(
        verdict.criterion_results[0].command_receipt_refs,
        authority.criteria[0].command_receipt_refs
    );
    assert_eq!(
        verdict.criterion_results[0].package_check_receipt_refs,
        authority.criteria[0].package_check_receipt_refs
    );

    let mut unordered_citations = valid_submission.clone();
    unordered_citations.criterion_results[0].citation_refs = authority.criteria[0]
        .allowed_citation_refs
        .iter()
        .rev()
        .cloned()
        .collect();
    let (unordered_verdict, _) = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &unordered_citations,
        1,
    )
    .expect("Core must canonicalize an unordered duplicate-free citation subset");
    assert_eq!(
        unordered_verdict.criterion_results[0].model_citation_refs,
        authority.criteria[0].allowed_citation_refs,
        "normalized verdict owns canonical citation order"
    );
    let mut ordered_citations = valid_submission.clone();
    ordered_citations.criterion_results[0].citation_refs =
        authority.criteria[0].allowed_citation_refs.clone();
    let (ordered_verdict, _) = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &ordered_citations,
        1,
    )
    .expect("ordered complete citation set");
    assert_eq!(unordered_verdict, ordered_verdict);
    let (canonical_original, original_bytes) =
        drivers::runner::child::canonical_validation_submission_v3(
            &assignment,
            &context,
            &ordered_citations,
            1,
        )
        .expect("canonical original submission");
    let (canonical_unordered, unordered_bytes) =
        drivers::runner::child::canonical_validation_submission_v3(
            &assignment,
            &context,
            &unordered_citations,
            1,
        )
        .expect("canonical unordered submission");
    assert_eq!(canonical_unordered, canonical_original);
    assert_eq!(
        unordered_bytes, original_bytes,
        "model order must not alter admitted submission bytes"
    );

    let mut unknown_citation = valid_submission.clone();
    unknown_citation.criterion_results[0].citation_refs = vec![kernel::generated::Ref(
        "validation-source:unknown".to_owned(),
    )];
    assert!(
        drivers::runner::child::normalize_validation_submission_v3(
            &assignment,
            &context,
            &unknown_citation,
            1,
        )
        .is_err(),
        "unknown v3 citation must fail"
    );
    let mut receipt_citation = valid_submission.clone();
    receipt_citation.criterion_results[0].citation_refs =
        authority.criteria[0].command_receipt_refs.clone();
    let receipt_error = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &receipt_citation,
        1,
    )
    .expect_err("model must never echo a Core receipt as a citation");
    for receipt in &authority.criteria[0].command_receipt_refs {
        assert!(
            !receipt_error.contains(&receipt.0),
            "repair diagnostic leaked receipt authority: {receipt_error}"
        );
    }
    assert!(receipt_error.contains("@rejected-receipt-reference"));

    let mut pass_with_blocker = valid_submission.clone();
    pass_with_blocker.criterion_results[0].finding_ids =
        vec![kernel::generated::Id("finding-pass-blocker".to_owned())];
    pass_with_blocker.findings = serde_json::from_value(serde_json::json!([{
        "finding_id":"finding-pass-blocker",
        "kind":"source-defect",
        "effect":"forward-blocking",
        "summary":"blocking source defect",
        "detail":"PASS may not retain a forward blocker",
        "criterion_ids":[context.criteria[0].criterion_id],
        "citation_refs":[context.criteria[0].allowed_citation_refs[0]],
        "source_locations":[]
    }]))
    .expect("typed PASS blocker");
    let pass_error = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &pass_with_blocker,
        1,
    )
    .expect_err("PASS with a blocker must fail");
    assert!(
        pass_error.contains("PASS with no forward-blocking finding"),
        "{pass_error}"
    );
    let mut duplicate_citation = valid_submission.clone();
    let duplicate_ref = duplicate_citation.criterion_results[0].citation_refs[0].clone();
    duplicate_citation.criterion_results[0]
        .citation_refs
        .push(duplicate_ref);
    let duplicate_error = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &duplicate_citation,
        1,
    )
    .expect_err("duplicate v3 citation must fail");
    assert!(duplicate_error.contains("duplicates"), "{duplicate_error}");

    let mut all_at_once = valid_submission.clone();
    let valid_ref = all_at_once.criterion_results[0].citation_refs[0].clone();
    all_at_once.criterion_results[0].citation_refs = vec![
        valid_ref,
        kernel::generated::Ref("validation-source:unknown".to_owned()),
        kernel::generated::Ref("validation-source:unknown".to_owned()),
    ];
    all_at_once.criterion_results[0].finding_ids = vec![
        kernel::generated::Id("missing-finding".to_owned()),
        kernel::generated::Id("missing-finding".to_owned()),
    ];
    all_at_once.findings = serde_json::from_value(serde_json::json!([
        {
            "finding_id":"duplicate-finding",
            "kind":"source-defect",
            "effect":"forward-blocking",
            "summary":"",
            "detail":"",
            "criterion_ids":["unknown-criterion"],
            "citation_refs":["validation-source:unknown"],
            "source_locations":[{
                "citation_ref":"validation-source:unknown",
                "start_line":0,
                "end_line":999
            }]
        },
        {
            "finding_id":"duplicate-finding",
            "kind":"source-defect",
            "effect":"advisory",
            "summary":"duplicate",
            "detail":"duplicate identity remains independently inspectable",
            "criterion_ids":[context.criteria[0].criterion_id],
            "citation_refs":[context.criteria[0].allowed_citation_refs[0]],
            "source_locations":[]
        }
    ]))
    .expect("malformed-but-typed duplicate findings");
    let diagnostic_text = drivers::runner::child::normalize_validation_submission_v3(
        &assignment,
        &context,
        &all_at_once,
        2,
    )
    .expect_err("all v3 mismatches must be aggregated");
    let diagnostic: serde_json::Value =
        serde_json::from_str(&diagnostic_text).expect("canonical aggregate diagnostic JSON");
    let mismatches = diagnostic["mismatches"]
        .as_array()
        .expect("diagnostic mismatches");
    assert_eq!(
        diagnostic["mismatch_count"].as_u64(),
        Some(mismatches.len() as u64)
    );
    assert_eq!(diagnostic["value_attempt"], 2);
    let citation_row = mismatches
        .iter()
        .find(|row| row["code"] == "criterion-citation-refs")
        .expect("citation mismatch row");
    assert_eq!(
        citation_row["extra"],
        serde_json::json!(["validation-source:unknown", "validation-source:unknown"])
    );
    assert_eq!(
        citation_row["duplicates"],
        serde_json::json!([{"value":"validation-source:unknown","count":2}])
    );
    assert_eq!(citation_row["missing"], serde_json::json!([]));
    let finding_row = mismatches
        .iter()
        .find(|row| row["code"] == "criterion-finding-ids")
        .expect("finding mismatch row");
    assert_eq!(
        finding_row["actual"],
        serde_json::json!(["missing-finding", "missing-finding"])
    );
    let criterion_backlink_row = mismatches
        .iter()
        .find(|row| row["code"] == "criterion-finding-link")
        .expect("criterion backlink mismatch row");
    assert_eq!(
        criterion_backlink_row["expected"],
        serde_json::json!(["missing-finding", "missing-finding"])
    );
    assert_eq!(criterion_backlink_row["actual"], serde_json::json!([]));
    assert_eq!(
        criterion_backlink_row["missing"],
        serde_json::json!(["missing-finding", "missing-finding"])
    );
    assert_eq!(criterion_backlink_row["extra"], serde_json::json!([]));
    let backlink_row = mismatches
        .iter()
        .find(|row| {
            row["code"] == "finding-criterion-link"
                && row["missing"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item.as_str() == Some(context.criteria[0].criterion_id.0.as_str())
                    })
                })
        })
        .expect("finding backlink mismatch row");
    assert_eq!(backlink_row["actual"], serde_json::json!([]));
    assert_eq!(
        backlink_row["missing"],
        serde_json::json!([context.criteria[0].criterion_id.0])
    );
    for code in [
        "finding-identity",
        "finding-summary",
        "finding-detail",
        "finding-criterion-ids",
        "finding-citation-refs",
        "finding-source-locations",
        "source-defect-location",
    ] {
        assert!(
            mismatches.iter().any(|row| row["code"] == code),
            "complete diagnostic omitted independently knowable {code}: {mismatches:?}"
        );
    }
    assert!(
        mismatches.iter().all(|row| {
            let pointer = row["field"].as_str().expect("JSON pointer field");
            pointer.is_empty() || pointer.starts_with('/')
        }),
        "every diagnostic field must be a root or absolute JSON pointer"
    );
    let keys = mismatches
        .iter()
        .map(|row| {
            (
                row["field"].as_str().unwrap_or("").to_owned(),
                row["criterion_id"].as_str().unwrap_or("").to_owned(),
                row["finding_id"].as_str().unwrap_or("").to_owned(),
                row["code"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    assert!(keys.windows(2).all(|pair| pair[0] <= pair[1]));
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
        "README.md\nobsolete.txt"
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

fn successful_command_execution_ledger(
    typed: &kernel::generated::AgentRunSpec,
) -> serde_json::Value {
    let artifact: runner::DeliveryAssignmentArtifact = serde_json::from_slice(
        &fs::read(&typed.assignment_path.as_ref().expect("assignment path").0)
            .expect("assignment artifact"),
    )
    .expect("typed assignment artifact");
    let snapshot =
        runner::delivery_scope_snapshot_digest(Path::new(&typed.cwd.0), &artifact.ordered_units)
            .expect("delivery scope snapshot");
    serde_json::json!({
        "schema":"autopilot.approved_command_executions.v1",
        "overflowed":false,
        "entries":artifact.approved_commands.iter().enumerate().map(|(index, binding)| serde_json::json!({
            "execution_id":format!("execution-{}", index + 1),
            "command_id":binding.command_id,
            "command_digest":binding.command_digest,
            "outcome":"succeeded",
            "result_digest":"a".repeat(64),
            "scope_snapshot_digest":snapshot,
        })).collect::<Vec<_>>()
    })
}

fn delivery_carrier_without_package(
    spec: &serde_json::Value,
    evidence_count: usize,
) -> serde_json::Value {
    delivery_carrier_without_package_paths(spec, evidence_count, &["README.md"])
}

fn delivery_carrier_without_package_paths(
    spec: &serde_json::Value,
    evidence_count: usize,
    changed_paths: &[&str],
) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("spec");
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|row| row.0 == "delivery-status.v2")
        .expect("profile");
    let submission = serde_json::json!({
        "actual_changed_paths":changed_paths,
        "execution_audit_ref":"audit:delivery",
        "focused_evidence_refs":(0..evidence_count).map(|index| serde_json::json!(format!("evidence:{index}"))).collect::<Vec<_>>(),
        "terminal_status":"succeeded",
        "hard_boundary_violations":[]
    });
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let binding = drivers::runner::child::carrier_binding(&typed);
    let tool_call_id = "delivery-tool-call-1";
    let command_executions = successful_command_execution_ledger(&typed);
    let audit = serde_json::json!({"schema":"autopilot.tool_audit.v2","tool_call_id":tool_call_id,"profile_id":profile.0,"tool_name":profile.1,"boundary_id":profile.2,"result_contract":profile.3,"schema_digest":profile.4,"binding":binding,"submission_digest":submission_digest,"delivery_policy":{"version":drivers::runner::DELIVERY_POLICY_VERSION,"assignment_path":typed.assignment_path.as_ref().expect("assignment path").0.clone(),"assignment_digest":typed.assignment_digest.as_ref().expect("assignment digest").0.clone(),"worktree":typed.worktree.as_ref().expect("worktree").0.clone(),"cwd":typed.cwd.0.clone(),"policy_digest":drivers::runner::delivery_policy_digest(&typed.assignment_path.as_ref().expect("assignment path").0,&typed.assignment_digest.as_ref().expect("assignment digest").0,&typed.worktree.as_ref().expect("worktree").0,&typed.cwd.0),"active_overrides":[drivers::runner::APPROVED_COMMAND_TOOL,"edit","write"],"denials":{"schema":"autopilot.delivery_policy_denials.v2","overflowed":false,"entries":[]},"command_executions":command_executions}});
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
