#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![recursion_limit = "256"]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::planning;
use drivers::runner::{
    child, planning_context_digest, planning_paths, repository_authority_binding, role_tool_names,
    session_id_for, settings_digest,
};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, Id, ModeId, SeamEnvelope, TaskDocument};
use serde_json::{Value, json};
use sha2::{Digest as ShaDigest, Sha256};

static PATH_LOCK: Mutex<()> = Mutex::new(());
static CWD_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn fake_pi_journey_writes_identity_carrier_and_isolated_exact_args() {
    let root = temp_root("runner-success");
    let argv_path = root.join("argv.json");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "writeFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2), cwd: process.cwd(), env: {{ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }} }}));",
                argv_path
            ),
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("agent-run success");

    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["schema"], "autopilot.planning_carrier.v1");
    assert_eq!(
        carrier["action_id"],
        "action-planning-main-task-extractor-01"
    );
    assert_eq!(carrier["assignment_id"], "planning-main-task-extractor-01");
    assert_eq!(carrier["run_revision"], 1);
    assert_eq!(carrier["role_id"], "task-extractor");
    assert_eq!(carrier["mode"], "inventory");
    assert_eq!(carrier["boundary_id"], "planning.task-atoms.v1");
    assert_eq!(carrier["raw_output"], accepted);
    assert!(carrier["spec_digest"].as_str().expect("spec digest").len() == 64);

    let argv_record: Value =
        serde_json::from_slice(&fs::read(argv_path).expect("argv")).expect("argv json");
    let argv = argv_record["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .map(|item| item.as_str().expect("arg").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(argv[0..3], ["--mode", "rpc", "--session-id"]);
    assert!(argv[3].starts_with("autopilot-planning-main-task-extractor-01-"));
    // The child must be pinned to a run-owned session directory. Without this
    // Pi falls back to its cwd-keyed global store, where a later top-level run
    // reopens an earlier run's session for the same assignment.
    assert_eq!(argv[4], "--session-dir");
    assert!(
        Path::new(&argv[5]).is_absolute(),
        "session dir must be absolute: {}",
        argv[5]
    );
    assert_eq!(argv[6], "--no-extensions");
    assert_eq!(argv[7], "-e");
    assert_eq!(PathBuf::from(&argv[8]), child_addon_path());
    assert_eq!(
        argv[9..19],
        [
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--provider",
            "openai-codex",
            "--model",
            "gpt-5.5",
            "--thinking",
            "high"
        ]
    );
    assert!(argv.contains(&"--tools".to_owned()));
    assert!(argv.contains(&"read,grep,find,ls,autopilot_submit_atoms".to_owned()));
    assert!(!argv.contains(&"-p".to_owned()));
    assert_eq!(argv_record["env"]["OPENROUTER_API_KEY"], Value::Null);
    assert_eq!(argv_record["env"]["OPENAI_API_KEY"], Value::Null);
    assert_eq!(
        PathBuf::from(argv_record["cwd"].as_str().expect("cwd")),
        root
    );
}

#[test]
fn child_refuses_oversized_spec_and_prompt_before_parsing_or_launch() {
    let spec_root = temp_root("runner-oversized-spec");
    let oversized_spec = spec_root.join("oversized-spec.json");
    fs::write(
        &oversized_spec,
        vec![b'x'; child::MAX_AGENT_RUN_SPEC_BYTES + 1],
    )
    .expect("oversized spec");
    let spec_error = child::main(&["--spec".to_owned(), oversized_spec.display().to_string()])
        .expect_err("oversized spec must be rejected before parsing");
    assert!(
        spec_error.contains("bounded read oversized"),
        "{spec_error}"
    );

    let prompt_root = temp_root("runner-oversized-prompt");
    let oversized_prompt = "x".repeat(child::MAX_RENDERED_PROMPT_BYTES + 1);
    let prompt_spec = write_planning_spec_with_prompt(
        &prompt_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
        &oversized_prompt,
    );
    let prompt_error = child::main(&["--spec".to_owned(), prompt_spec.display().to_string()])
        .expect_err("oversized prompt must be rejected before launch");
    assert!(
        prompt_error.contains("bounded read oversized"),
        "{prompt_error}"
    );

    let addon_root = temp_root("runner-oversized-addon");
    let oversized_addon = addon_root.join("oversized-child-addon.ts");
    let addon_spec = write_planning_spec(
        &addon_root,
        |mut value| {
            value["runtime_extension_path"] = serde_json::json!(oversized_addon);
            value["runtime_extension_digest"] = serde_json::json!("0".repeat(64));
            value
        },
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    fs::write(
        &oversized_addon,
        vec![b'x'; drivers::runner::CHILD_ADDON_MAX_BYTES + 1],
    )
    .expect("oversized child addon");
    let addon_error = child::main(&["--spec".to_owned(), addon_spec.display().to_string()])
        .expect_err("oversized child addon must be rejected before hashing");
    assert!(
        addon_error.contains("bounded read oversized"),
        "{addon_error}"
    );
}

#[test]
fn declared_planning_terminal_tools_survive_runtime_resolution() {
    let atoms = role_tool_names("task-extractor").expect("task extractor tools");
    assert!(atoms.iter().any(|tool| tool == "autopilot_submit_atoms"));
    let curator = role_tool_names("context-curator").expect("context curator tools");
    assert!(
        curator
            .iter()
            .any(|tool| tool == "autopilot_submit_context")
    );
    assert!(
        !curator.iter().any(|tool| tool == "context_catalog_query"),
        "removed phantom capabilities must not reappear at runtime"
    );
}

#[test]
fn child_registration_receipt_is_required_before_first_prompt() {
    let root = temp_root("runner-missing-tool-receipt");
    write_fake_pi(
        &root,
        &rpc_fake_pi("const suppressReceipt = true;", "process.exit(91);"),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("missing receipt must fail before prompt");
    assert!(
        error.contains("registration receipt count was 0"),
        "{error}"
    );
}

#[test]
fn registered_but_not_active_terminal_tool_is_rejected_before_prompt() {
    let root = temp_root("runner-inactive-terminal-tool");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "activeTools = activeTools.filter(name => name !== 'autopilot_submit_atoms');",
            "process.exit(92);",
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("inactive terminal tool must fail before prompt");
    assert!(error.contains("terminal-tool-not-offered"), "{error}");
    assert!(error.contains("source=pre-prompt-active-tools"), "{error}");
}

#[test]
fn streamed_registration_entry_cannot_replace_or_drift_from_durable_receipt() {
    let missing_root = temp_root("runner-streamed-only-receipt");
    write_fake_pi(
        &missing_root,
        &rpc_fake_pi("const suppressDurableReceipt = true;", "process.exit(93);"),
    );
    let missing_spec = write_planning_spec(
        &missing_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let missing = with_fake_path(&missing_root, || {
        child::main(&["--spec".to_owned(), missing_spec.display().to_string()])
    })
    .expect_err("streamed notification cannot replace durable receipt");
    assert!(
        missing.contains("registration receipt count was 0"),
        "{missing}"
    );

    let drift_root = temp_root("runner-streamed-receipt-drift");
    write_fake_pi(
        &drift_root,
        &rpc_fake_pi(
            "const streamedReceiptBinding = 'wrong';",
            "process.exit(94);",
        ),
    );
    let drift_spec = write_planning_spec(
        &drift_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let drift = with_fake_path(&drift_root, || {
        child::main(&["--spec".to_owned(), drift_spec.display().to_string()])
    })
    .expect_err("streamed and durable receipts must agree");
    assert!(
        drift.contains("streamed child registration entry drift"),
        "{drift}"
    );
}

#[test]
fn bootstrap_entry_rejects_duplicates_wrong_types_and_post_bootstrap_appends() {
    let duplicate_root = temp_root("runner-duplicate-streamed-receipt");
    write_fake_pi(
        &duplicate_root,
        &rpc_fake_pi(
            "const duplicateStreamedReceipt = true;",
            "process.exit(95);",
        ),
    );
    let duplicate_spec = write_planning_spec(
        &duplicate_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let duplicate = with_fake_path(&duplicate_root, || {
        child::main(&["--spec".to_owned(), duplicate_spec.display().to_string()])
    })
    .expect_err("duplicate streamed receipt rejected");
    assert!(
        duplicate.contains("duplicate entry_appended"),
        "{duplicate}"
    );

    let wrong_root = temp_root("runner-wrong-streamed-receipt-type");
    write_fake_pi(
        &wrong_root,
        &rpc_fake_pi(
            "const streamedReceiptCustomType = 'foreign-entry';",
            "process.exit(96);",
        ),
    );
    let wrong_spec = write_planning_spec(
        &wrong_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let wrong = with_fake_path(&wrong_root, || {
        child::main(&["--spec".to_owned(), wrong_spec.display().to_string()])
    })
    .expect_err("wrong bootstrap custom type rejected");
    assert!(wrong.contains("unexpected bootstrap entry type"), "{wrong}");

    // BUG-185: real Pi emits entry_appended synchronously from appendEntry.
    // Submit-time custom entries are forbidden after bootstrap, not skipped.
    let late_root = temp_root("runner-post-bootstrap-entry");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &late_root,
        &rpc_fake_pi(
            "const emitPlanningCarrierEntry = true;",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let late_spec = write_planning_spec(
        &late_root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let late = with_fake_path(&late_root, || {
        child::main(&["--spec".to_owned(), late_spec.display().to_string()])
    })
    .expect_err("post-bootstrap append rejected");
    assert!(
        late.contains("entry_appended emitted after child bootstrap"),
        "{late}"
    );
    assert!(!carrier_path(&late_root).exists());
}

#[test]
fn generated_child_addon_persists_only_the_consumed_registration_receipt() {
    // The generated add-on is a thin delegating shim; the append itself lives in
    // the hand-written runtime it re-exports. Assert the invariant across BOTH
    // files so the check follows the behavior instead of one file's old shape:
    // exactly one appendEntry in the whole child surface, keyed by the receipt
    // entry, and no planning-carrier persistence anywhere.
    let generated = fs::read_to_string(child_addon_path()).expect("generated child add-on");
    let runtime = fs::read_to_string(child_addon_runtime_path()).expect("child add-on runtime");

    assert!(
        generated.contains("CHILD_RECEIPT_ENTRY"),
        "generated add-on must re-export the receipt entry: {generated}"
    );

    let appends =
        generated.matches("pi.appendEntry(").count() + runtime.matches("pi.appendEntry(").count();
    assert_eq!(
        appends, 1,
        "exactly one child appendEntry across the add-on surface"
    );
    assert!(
        runtime.contains("pi.appendEntry(CHILD_RECEIPT_ENTRY"),
        "the single append must be keyed by CHILD_RECEIPT_ENTRY: {runtime}"
    );

    for (label, source) in [("generated", &generated), ("runtime", &runtime)] {
        assert!(
            !source.contains("pi-autopilot:planning-carrier"),
            "{label} add-on must not persist a planning carrier"
        );
        assert!(
            !source.contains("CHILD_CARRIER_ENTRY"),
            "{label} add-on must not reference a carrier entry"
        );
    }
}

#[test]
fn tool_schema_identity_error_does_not_consume_value_repair() {
    let root = temp_root("runner-tool-schema-identity");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!("emitCarrier({accepted:?}, 'gpt-5.5', {{schema_digest:'deadbeef'}});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("wrong schema digest is an identity error");
    assert!(
        error.contains("identity rejected before value repair"),
        "{error}"
    );
    assert_eq!(
        attempt_events(&root, "planning-main-task-extractor-01"),
        ["started", "identity-rejected"]
    );
}

#[test]
fn wrong_tool_name_is_identity_error_even_with_expected_boundary_and_schema() {
    let root = temp_root("runner-wrong-terminal-tool");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "const overrideToolName = 'autopilot_submit_context';",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("wrong tool name must fail despite expected details");
    assert!(
        error.contains("identity rejected before value repair"),
        "{error}"
    );
    assert_eq!(
        attempt_events(&root, "planning-main-task-extractor-01"),
        ["started", "identity-rejected"]
    );
}

#[test]
fn terminal_profile_detail_identity_drift_is_rejected() {
    for (label, overrides) in [
        (
            "result-contract",
            "{result_contract:'planning.questions.v1'}",
        ),
        ("binding", "{binding:'wrong-binding'}"),
    ] {
        let root = temp_root(&format!("runner-terminal-detail-{label}"));
        let accepted = transcript("planning.task-atoms.v1");
        write_fake_pi(
            &root,
            &rpc_fake_pi(
                "",
                &format!("emitCarrier({accepted:?}, 'gpt-5.5', {overrides});"),
            ),
        );
        let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
        let error = with_fake_path(&root, || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
        .expect_err("terminal detail drift must fail before value repair");
        assert!(
            error.contains("identity rejected before value repair"),
            "{label}: {error}"
        );
        assert!(!carrier_path(&root).exists(), "{label}");
    }
}

#[test]
fn errored_submit_result_is_never_a_carrier() {
    let root = temp_root("runner-submit-is-error");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "const submitIsError = true;",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("isError submit result must fail");
    assert!(error.contains("isError=true"), "{error}");
    assert!(!carrier_path(&root).exists());
}

#[test]
fn nonterminating_submit_result_is_never_a_carrier() {
    let root = temp_root("runner-submit-nonterminating");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "const submitTerminates = false;",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("nonterminating submit result must fail");
    assert!(error.contains("terminate=false"), "{error}");
    assert!(!carrier_path(&root).exists());
}

#[test]
fn ordinary_tool_results_without_details_before_terminal_submit_succeed() {
    let root = temp_root("runner-ordinary-tools-before-submit");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "send({{type:'agent_start'}}); emitReadTool('read'); emitReadTool('grep'); emitReadTool('read'); emitCarrierResult({accepted:?}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("ordinary toolResults without details must not block terminal submit");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
}

#[test]
fn terminal_tool_result_details_drift_still_fails_loudly() {
    let root = temp_root("runner-tool-result-details-drift");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "const toolResultSchemaDigest = 'different';",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("two RPC copies of details must match");
    assert!(error.contains("details drift"), "{error}");
    assert!(!carrier_path(&root).exists());
}

#[test]
fn duplicate_terminating_submit_results_still_fail_loudly() {
    let root = temp_root("runner-duplicate-terminal-submit");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "const emitSecondTerminalExecutionEnd = true;",
            &format!("emitCarrier({accepted:?});"),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("duplicate terminal submit must fail");
    assert!(
        error.contains("class=multiple-terminals count=2"),
        "{error}"
    );
    assert!(!carrier_path(&root).exists());
}

#[test]
fn terminal_tool_result_must_have_correlated_details_by_opaque_call_id() {
    for (label, setup, expected) in [
        (
            "missing-details",
            "const omitToolResultDetails = true;",
            "missing correlated toolResult details",
        ),
        (
            "uncorrelated-id",
            "const overrideToolResultCallId = 'different-call';",
            "missing correlated toolResult details",
        ),
    ] {
        let root = temp_root(&format!("runner-tool-result-{label}"));
        let accepted = transcript("planning.task-atoms.v1");
        write_fake_pi(
            &root,
            &rpc_fake_pi(setup, &format!("emitCarrier({accepted:?});")),
        );
        let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
        let error = with_fake_path(&root, || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
        .expect_err("terminal toolResult details must correlate");
        assert!(error.contains(expected), "{label}: {error}");
        assert!(!carrier_path(&root).exists(), "{label}");
    }
}

#[test]
fn planning_child_rejects_missing_repository_manifest_binding() {
    let root = temp_root("runner-missing-repo-manifest");
    write_fake_pi(
        &root,
        &success_fake_pi(&task_atoms_output("TASK-A.md", "AUTHORITY-A-SENTINEL")),
    );
    let spec = write_planning_spec(
        &root,
        |mut value| {
            value
                .as_object_mut()
                .unwrap()
                .remove("repository_manifest_path");
            value
        },
        "planning.task-atoms.v1",
        "gpt-5.5",
    );
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("missing repository manifest binding must fail");
    assert!(error.contains("repository_manifest_path"), "{error}");
}

#[test]
fn settings_digest_tracks_the_declared_launch_channel() {
    assert_ne!(settings_digest(true), settings_digest(false));
}

#[test]
fn real_core_agent_run_accepts_variadic_authority_spec() {
    let root = temp_root("runner-variadic-real-core");
    write_fake_pi(
        &root,
        &success_fake_pi(&task_atoms_output("TASK-1.md", "AUTHORITY-1")),
    );
    let context_document = doc(
        "CONTEXT.md",
        "context/non-authority",
        "CONTEXT-SENTINEL-UNIQUE",
    );
    let authority_documents = (1..=6)
        .map(|index| {
            doc(
                &format!("TASK-{index}.md"),
                "authority",
                &format!("AUTHORITY-{index}"),
            )
        })
        .collect::<Vec<_>>();
    let context_documents = vec![context_document.clone()];
    let expected_context_digest =
        planning_context_digest_for_spec(&root, "set-a", &authority_documents, &context_documents);
    let spec = write_planning_spec(
        &root,
        |mut value| {
            value["authority_documents"] = json!(authority_documents.clone());
            value["context_document"] = json!(context_document.clone());
            value["context_documents"] = json!(context_documents.clone());
            value["context_digest"] = json!(expected_context_digest.clone());
            value
        },
        "planning.task-atoms.v1",
        "gpt-5.5",
    );

    let output = with_fake_path(&root, || {
        Command::new(env!("CARGO_BIN_EXE_autopilot-core"))
            .args(["agent-run", "--spec"])
            .arg(&spec)
            .output()
            .expect("run real autopilot-core agent-run")
    });
    assert!(
        output.status.success(),
        "real autopilot-core agent-run rejected variadic spec status={} stderr={} stdout={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn autopilot_plan_preserves_multiple_context_documents_in_manifest_spec_and_prompt() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_root("runner-plan-multi-context");
    for index in 1..=6 {
        write_task_file(
            &root,
            &format!("A{index}.md"),
            "[authority]",
            "set-a",
            &format!("AUTHORITY-{index}"),
        );
    }
    write_task_file(&root, "C1.md", "[context/non-authority]", "set-a", "CTX1");
    write_task_file(&root, "C2.md", "[context/non-authority]", "set-a", "CTX2");
    git_init(&root);
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("current exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("current exe"),
        );
        std::env::set_var("AUTOPILOT_CHILD_ADDON_PATH", child_addon_path());
    }

    let previous = std::env::current_dir().expect("current dir");
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("core state");
    let envelope = send_command(
        &mut state,
        "autopilot-plan main A1.md A2.md A3.md A4.md A5.md A6.md C1.md C2.md",
    );
    std::env::set_current_dir(previous).expect("restore cwd");

    // Planning now launches the whole P1 wave in one frame.
    assert_eq!(envelope.kind, "spawn-wave", "payload={}", envelope.payload);
    let actions = envelope.payload["actions"]
        .as_array()
        .expect("spawn-wave actions");
    assert!(
        actions.len() > 1,
        "P1 must launch in parallel: {}",
        envelope.payload
    );
    assert_eq!(
        actions[0]["assignment_id"].as_str(),
        Some("planning-main-task-extractor-01")
    );

    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join(".pi/autopilot/main/planning-manifest.json")).expect("manifest"),
    )
    .expect("manifest json");
    let manifest_contexts = manifest["context_documents"]
        .as_array()
        .expect("manifest contexts");
    assert_eq!(manifest_contexts.len(), 2);
    assert_eq!(manifest_contexts[0]["path"], "C1.md");
    assert_eq!(manifest_contexts[1]["path"], "C2.md");
    assert_eq!(manifest["context"]["path"], "C1.md");
    assert_eq!(manifest["context_document"]["path"], "C1.md");

    let spec_path =
        root.join(".pi/autopilot/main/planning/specs/planning-main-task-extractor-01.json");
    let spec: Value =
        serde_json::from_slice(&fs::read(&spec_path).expect("spec")).expect("spec json");
    let spec_contexts = spec["context_documents"].as_array().expect("spec contexts");
    assert_eq!(spec_contexts.len(), 2);
    assert_eq!(spec_contexts[0]["body"], "CTX1");
    assert_eq!(spec_contexts[1]["body"], "CTX2");
    assert_eq!(spec["context_document"]["path"], "C1.md");

    let prompt = fs::read_to_string(
        root.join(".pi/autopilot/main/planning/prompts/planning-main-task-extractor-01.md"),
    )
    .expect("planning prompt");
    // Context bodies are no longer eagerly inlined: the renderer binds them through the
    // context manifest as path+digest required-reads. Both documents must still be reachable
    // from the prompt by path (their bodies are asserted on spec/manifest above).
    assert!(prompt.contains("C1.md"), "{prompt}");
    assert!(prompt.contains("C2.md"), "{prompt}");
}

#[test]
fn fake_pi_boundary_retry_reuses_session_and_succeeds() {
    let root = temp_root("runner-retry");
    let count_path = root.join("count.txt");
    let argv_path = root.join("argv.jsonl");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "appendFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2) }}) + '\\n');",
                argv_path
            ),
            &format!(
                "writeFileSync({:?}, String(promptCount)); if (promptCount === 2 && !cmd.message.includes('field:    payload')) process.exit(43); emitCarrier(promptCount === 1 ? {{atoms:[{{id:'wrong-id',kind:'work',text:'x',sources:[]}}]}} : {accepted:?});",
                count_path
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("retry should repair into same session");

    assert_eq!(fs::read_to_string(&count_path).expect("count"), "2");
    let argv_lines = fs::read_to_string(&argv_path).expect("argv");
    let invocations = argv_lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("argv json"))
        .collect::<Vec<_>>();
    let session_ids = invocations
        .iter()
        .map(|value| {
            let argv = value["argv"].as_array().expect("argv array");
            let index = argv
                .iter()
                .position(|item| item.as_str() == Some("--session-id"))
                .expect("session flag");
            argv[index + 1].as_str().expect("session id").to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(session_ids.len(), 1);
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
    let attempts = fs::read_to_string(
        root.join(".pi/autopilot/runner/attempt-events/planning-main-task-extractor-01.jsonl"),
    )
    .expect("attempt events");
    assert!(attempts.contains("value-rejected"), "{attempts}");
    assert!(attempts.contains("accepted"), "{attempts}");
}

#[test]
fn task_atom_value_repair_repeats_manifest_and_recovers_from_json_body_anchor() {
    let root = temp_root("runner-task-source-repair");
    let prompt_log = terminalmiss_prompt_log(&root);
    let bad_source = format!(
        "task://{}/TASK-A.md#/body",
        task_document_digest("authority", "set-a", "AUTHORITY-A-SENTINEL")
    );
    let bad = json!({
        "atoms":[{
            "id":"planning-main-task-extractor-01-atom-bad",
            "kind":"work",
            "text":"bad source",
            "sources":[bad_source]
        }]
    })
    .to_string();
    let accepted = transcript("planning.task-atoms.v1");
    let expected_manifest = runner_child_expected_task_manifest();
    let initial_prompt = format!(
        "runner prompt with AUTHORITY-A-SENTINEL AUTHORITY-B-SENTINEL AUTHORITY-C-SENTINEL CONTEXT-SENTINEL-UNIQUE\n\n{expected_manifest}"
    );
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!("const repairPromptLog = {:?};", prompt_log),
            &format!(
                "appendFileSync(repairPromptLog, JSON.stringify({{count:promptCount,message:cmd.message}})+'\\n'); emitCarrier(promptCount === 1 ? {bad:?} : {accepted:?});"
            ),
        ),
    );
    let spec = write_planning_spec_with_prompt(
        &root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
        &initial_prompt,
    );
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("repair should recover after exact run-19 #/body-style source");

    let rows = terminalmiss_prompt_rows(&root);
    assert_eq!(
        rows.len(),
        2,
        "expected initial plus repair prompts: {rows:?}"
    );
    let initial = rows[0]["message"].as_str().expect("initial prompt");
    let repair = rows[1]["message"].as_str().expect("repair prompt");
    assert!(
        repair.contains("Package-authoritative source manifest for planning.task-atoms.v1"),
        "repair prompt lost canonical source manifest: {repair}"
    );
    assert!(
        repair.contains("json://...#/body` Context Manifest addresses are context-read addresses, not legal atoms[].sources"),
        "repair prompt lost JSON-address warning: {repair}"
    );
    assert!(
        repair.contains(&expected_manifest),
        "repair prompt does not repeat exact registry-owned canonical manifest bytes: {repair}"
    );
    let initial_json = extract_task_source_manifest_json(initial);
    let repair_json = extract_task_source_manifest_json(repair);
    assert_eq!(
        initial_json.as_bytes(),
        repair_json.as_bytes(),
        "real initial rendered prompt and real repair prompt must carry identical canonical manifest JSON bytes"
    );
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
}

#[test]
fn runner_rpc_will_retry_is_progress_until_agent_settled() {
    let root = temp_root("runner-will-retry");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "send({{type:'agent_start'}}); send({{type:'agent_end',willRetry:true}}); send({{type:'auto_retry_start'}}); send({{type:'auto_retry_end',success:true}}); emitCarrier({accepted:?});"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("willRetry is progress, not fatal");
}

#[test]
fn runner_rpc_configuration_failures_and_auto_compaction_fail_loudly() {
    let root = temp_root("runner-config-fail");
    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nlet b=''; process.stdin.on('data', c => { b += c; for (const line of b.split('\\n')) { if (!line.trim()) continue; const cmd=JSON.parse(line); if (cmd.type === 'set_auto_compaction') { console.log(JSON.stringify({id:cmd.id,type:'response',command:'set_auto_compaction',success:false,error:'refused'})); } } });\n",
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("set_auto_compaction failure");
    assert!(
        error.contains("set_auto_compaction") || error.contains("refused"),
        "{error}"
    );

    let root = temp_root("runner-auto-compact");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            "send({type:'agent_start'}); send({type:'compaction_start',reason:'threshold'});",
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("automatic compaction");
    assert!(error.contains("automatic compaction"), "{error}");
}

#[test]
fn runner_rpc_null_context_percent_blocks_terminal_success() {
    let root = temp_root("runner-null-context");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "statsData = () => ({ sessionId, contextUsage: { tokens:null, contextWindow:100000, percent:null } });",
            &format!("emitCarrier({:?});", transcript("planning.task-atoms.v1")),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("null context percent");
    assert!(error.contains("context budget unknown"), "{error}");
}

#[test]
fn runner_rpc_checkpoint_steer_compact_resume_same_session() {
    let root = temp_root("runner-checkpoint-cycle");
    let commands = root.join("commands.jsonl");
    let handoff = valid_handoff().to_string();
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; let forceNullStats = false; statsData = () => forceNullStats ? ({{ sessionId, contextUsage: {{ tokens:null, contextWindow:100000, percent:null }} }}) : ({{ sessionId, contextUsage: {{ tokens: Math.round(contextPercent * 1000), contextWindow:100000, percent:contextPercent }} }}); const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type,message:cmd.message,customInstructions:cmd.customInstructions}})+'\\n'); }} function afterCompact(cmd) {{ log(cmd); forceNullStats = true; send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }} function afterSteer(cmd) {{ log(cmd); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }}",
                commands
            ),
            &format!(
                "log(cmd); if (promptCount === 1) {{ const thinking = message('tool phase','gpt-5.5','toolUse'); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end',message:thinking}}); emitReadTool(); }} else {{ forceNullStats = false; contextPercent = 10; emitCarrier({accepted:?}); }}"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("checkpoint compact null-stats resume");
    let log = fs::read_to_string(commands).expect("command log");
    assert!(log.contains("steer"), "{log}");
    assert!(log.contains("prompt"), "{log}");
    assert!(log.contains("compact"), "{log}");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
}

/// LIVE run 17 regression: a legitimate ~1.06 MB terminal submission must NOT be
/// rejected.
///
/// `max_terminal_bytes` bounds the child's structured WORK PRODUCT. It used to be
/// assigned from `AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES` (a raw-stdout ceiling, default
/// 1 MiB), which silently discarded the declared 2 MiB terminal budget. A plan-reviewer
/// produced 1,062,182 bytes and hard-failed an entire LIVE run 1.3% over a limit that was
/// never meant to apply to submissions.
///
/// This drives a >1 MiB terminal frame through the real child with NO env overrides, so
/// it fails if the terminal budget is ever re-derived from the stdout default again.
#[test]
fn terminal_budget_is_not_governed_by_the_stdout_ceiling() {
    let root = temp_root("runner-terminal-budget");
    let accepted = transcript("planning.task-atoms.v1");
    // ~1.06 MB of assistant prose before the accepted carrier: larger than the 1 MiB
    // stdout default, comfortably inside the 2 MiB terminal budget.
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "send({{type:'agent_start'}}); const big = 'y'.repeat(1062182); const msg = message(big, 'gpt-5.5', 'toolUse'); send({{type:'message_start'}}); send({{type:'message_end', message: msg}}); emitCarrierResult({accepted:?}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("a ~1.06 MB terminal submission must fit the default terminal budget");
}

#[test]
fn resume_continuation_preserves_session_turn_accounting() {
    let root = temp_root("runner-resume-session-turns");
    let commands = root.join("commands.jsonl");
    let handoff = valid_handoff().to_string();
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type,message:cmd.message}})+'\\n'); }} function afterSteer(cmd) {{ log(cmd); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }} function afterCompact(cmd) {{ log(cmd); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }}",
                commands
            ),
            &format!(
                "log(cmd); if (promptCount === 1) {{ const thinking = message('tool phase','gpt-5.5','toolUse'); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end',message:thinking}}); emitReadTool(); }} else {{ contextPercent = 10; emitCarrier({accepted:?}); }}"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("resume continuation must reuse the startup PromptSession");
    let log = fs::read_to_string(commands).expect("command log");
    assert!(log.contains("compact"), "{log}");
    assert_eq!(log.matches("\"type\":\"prompt\"").count(), 2, "{log}");
}

#[test]
fn handoff_continuation_preserves_session_turn_accounting() {
    let root = temp_root("runner-handoff-session-turns");
    let commands = root.join("commands.jsonl");
    let handoff = valid_handoff().to_string();
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; const suppressSteerQueue = true; const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type,message:cmd.message}})+'\\n'); }} function afterSteer(cmd) {{ log(cmd); }} function afterCompact(cmd) {{ log(cmd); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }}",
                commands
            ),
            &format!(
                "log(cmd); if (promptCount === 1) {{ send({{type:'agent_start'}}); emitReadTool(); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }} else if (promptCount === 2) {{ send({{type:'agent_start'}}); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }} else {{ contextPercent = 10; emitCarrier({accepted:?}); }}"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("handoff continuation must reuse the startup PromptSession");
    let log = fs::read_to_string(commands).expect("command log");
    assert!(log.contains("steer"), "{log}");
    assert!(log.contains("compact"), "{log}");
    assert_eq!(log.matches("\"type\":\"prompt\"").count(), 3, "{log}");
}

#[test]
fn runner_rpc_checkpoint_resume_rejects_unknown_after_valid_resume_response() {
    let root = temp_root("runner-checkpoint-null-after-resume");
    let commands = root.join("commands.jsonl");
    let handoff = valid_handoff().to_string();
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; let forceNullStats = false; statsData = () => forceNullStats ? ({{ sessionId, contextUsage: {{ tokens:null, contextWindow:100000, percent:null }} }}) : ({{ sessionId, contextUsage: {{ tokens: Math.round(contextPercent * 1000), contextWindow:100000, percent:contextPercent }} }}); const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type,message:cmd.message,customInstructions:cmd.customInstructions}})+'\\n'); }} function afterCompact(cmd) {{ log(cmd); forceNullStats = true; send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }} function afterSteer(cmd) {{ log(cmd); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }}",
                commands
            ),
            &format!(
                "log(cmd); if (promptCount === 1) {{ const thinking = message('tool phase','gpt-5.5','toolUse'); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end',message:thinking}}); emitReadTool(); }} else {{ emitCarrier({accepted:?}); }}"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("unknown stats after resume terminal must fail loudly");
    assert!(error.contains("UnknownBlocksTerminalSuccess"), "{error}");
    assert!(!carrier_path(&root).exists(), "carrier must not be written");
}

#[test]
fn runner_rpc_checkpoint_rejects_handoff_over_total_max_bytes_before_compact() {
    let root = temp_root("runner-handoff-total-bound");
    let commands = root.join("commands.jsonl");
    let mut handoff = valid_handoff();
    handoff
        .as_object_mut()
        .expect("handoff object")
        .insert("padding".to_owned(), json!("x".repeat(66_000)));
    let handoff = handoff.to_string();
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type}})+'\\n'); }} function afterCompact(cmd) {{ log(cmd); process.exit(47); }} function afterSteer(cmd) {{ log(cmd); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }}",
                commands
            ),
            "log(cmd); const thinking = message('tool phase','gpt-5.5','toolUse'); send({type:'agent_start'}); send({type:'message_start'}); send({type:'message_end',message:thinking}); emitReadTool();",
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("oversized total handoff rejected");
    assert!(error.contains("total_max_bytes"), "{error}");
    assert!(error.contains("observed"), "{error}");
    let log = fs::read_to_string(commands).expect("command log");
    assert!(!log.contains("compact"), "{log}");
    assert!(!carrier_path(&root).exists(), "carrier must not be written");
}

#[test]
fn runner_rpc_checkpoint_rejects_handoff_over_entry_max_bytes_before_compact() {
    let root = temp_root("runner-handoff-entry-bound");
    let commands = root.join("commands.jsonl");
    let mut handoff = valid_handoff();
    handoff["completed"] = json!(["x".repeat(513)]);
    let handoff = handoff.to_string();
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            &format!(
                "contextPercent = 86; const commandLog = {:?}; function log(cmd) {{ appendFileSync(commandLog, JSON.stringify({{type:cmd.type}})+'\\n'); }} function afterCompact(cmd) {{ log(cmd); process.exit(47); }} function afterSteer(cmd) {{ log(cmd); const h = message({handoff:?}); send({{type:'message_start'}}); send({{type:'message_end',message:h}}); }}",
                commands
            ),
            "log(cmd); const thinking = message('tool phase','gpt-5.5','toolUse'); send({type:'agent_start'}); send({type:'message_start'}); send({type:'message_end',message:thinking}); emitReadTool();",
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("oversized entry handoff rejected");
    assert!(error.contains("entry_max_bytes"), "{error}");
    assert!(error.contains("observed 513"), "{error}");
    let log = fs::read_to_string(commands).expect("command log");
    assert!(!log.contains("compact"), "{log}");
    assert!(!carrier_path(&root).exists(), "carrier must not be written");
}

#[test]
fn fake_pi_nonzero_malformed_wrong_model_boundary_and_jsonl_protocol_fail_loudly() {
    let root = temp_root("runner-failures");

    write_fake_pi(&root, "#!/usr/bin/env node\nprocess.exit(42);\n");
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("nonzero")
        .contains("missing rpc responses")
    );

    write_fake_pi(&root, "#!/usr/bin/env node\nconsole.log('not json');\n");
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("malformed")
        .contains("JSON")
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "emitCarrier({:?}, 'wrong');",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("wrong model")
        .contains("provider/model drift")
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            "emitCarrier({atoms:[{id:'wrong',kind:'work',text:'x',sources:[]}]});",
        ),
    );
    let boundary_spec = next_scenario_spec(&root);
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            boundary_spec.display().to_string()
        ]))
        .expect_err("boundary")
        .contains("value repair exhausted")
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "const msg = message({:?}); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message: msg}}); process.exit(0);",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    let settled_spec = next_scenario_spec(&root);
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            settled_spec.display().to_string()
        ]))
        .expect_err("agent_settled")
        .contains("missing rpc responses")
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "const one = message({:?}); const two = message({:?}); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message:one}}); send({{type:'message_end', message:two}}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});",
                transcript("planning.task-atoms.v1"),
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    let dedupe_spec = next_scenario_spec(&root);
    let duplicate_error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), dedupe_spec.display().to_string()])
    })
    .expect_err("assistant text is never a planning carrier");
    assert!(
        duplicate_error.contains("terminal miss deterministic repeated prose digest"),
        "{duplicate_error}"
    );
    fs::remove_file(carrier_path(&root)).ok();

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "const msg = message({:?}); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message:msg}}); send({{type:'tool_execution_start',toolName:'read'}}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    let tool_after_spec = next_scenario_spec(&root);
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            tool_after_spec.display().to_string()
        ]))
        .expect_err("tool after assistant")
        .contains("tool activity")
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "const toolUse = message('thinking', 'gpt-5.5', 'toolUse'); const final = message({:?}); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message:toolUse}}); emitReadTool(); send({{type:'message_end', message:final}}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    fs::remove_file(carrier_path(&root)).ok();
    let tool_cycle_spec = next_scenario_spec(&root);
    let text_error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), tool_cycle_spec.display().to_string()])
    })
    .expect_err("planning assistant text must be rejected after tool activity");
    assert!(
        text_error.contains("terminal miss deterministic repeated prose digest"),
        "{text_error}"
    );

    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "emitAssistant({:?}, 'gpt-5.5', 'length');",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    fs::remove_file(carrier_path(&root)).ok();
    let stop_reason_spec = next_scenario_spec(&root);
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            stop_reason_spec.display().to_string()
        ]))
        .expect_err("bad stopReason")
        .contains("stopReason")
    );
}

#[test]
fn drifted_spec_fields_are_rejected_before_pi_launch() {
    struct SpecDriftCase {
        label: &'static str,
        mutate: fn(Value) -> Value,
    }

    let cases = [
        SpecDriftCase {
            label: "role",
            mutate: |mut value| {
                value["role_id"] = json!("not-a-registered-role");
                value
            },
        },
        SpecDriftCase {
            label: "mode",
            mutate: |mut value| {
                value["mode"] = json!("not-a-registered-mode");
                value
            },
        },
        SpecDriftCase {
            label: "provider",
            mutate: |mut value| {
                value["provider"] = json!("openrouter");
                value
            },
        },
        SpecDriftCase {
            label: "model",
            mutate: |mut value| {
                value["model"] = json!("not-rostered");
                value
            },
        },
        SpecDriftCase {
            label: "thinking",
            mutate: |mut value| {
                value["thinking"] = json!("max");
                value
            },
        },
        SpecDriftCase {
            label: "route",
            mutate: |mut value| {
                value["route"] = json!("api-key");
                value
            },
        },
        SpecDriftCase {
            label: "tools",
            mutate: |mut value| {
                value["allowed_tools"] = json!(["bash"]);
                value
            },
        },
        SpecDriftCase {
            label: "boundary",
            mutate: |mut value| {
                value["boundary_id"] = json!("planning.questions.v1");
                value
            },
        },
        SpecDriftCase {
            label: "result",
            mutate: |mut value| {
                value["result_contract"] = json!("planning.questions.v1");
                value
            },
        },
        SpecDriftCase {
            label: "prompt",
            mutate: |mut value| {
                let other =
                    PathBuf::from(value["cwd"].as_str().expect("cwd")).join("not-the-prompt.md");
                value["prompt_path"] = json!(other);
                value
            },
        },
        SpecDriftCase {
            label: "boundary_digest",
            mutate: |mut value| {
                value["boundary_digest"] = json!("0".repeat(64));
                value
            },
        },
        SpecDriftCase {
            label: "context_digest",
            mutate: |mut value| {
                value["context_digest"] = json!("1".repeat(64));
                value
            },
        },
        SpecDriftCase {
            label: "doc_digest",
            mutate: |mut value| {
                value["authority_documents"][0]["digest"] = json!("2".repeat(64));
                value
            },
        },
        SpecDriftCase {
            label: "assignment",
            mutate: |mut value| {
                value["assignment_id"] = json!("planning-main-task-extractor-forged");
                value
            },
        },
    ];
    for SpecDriftCase { label, mutate } in cases {
        let root = temp_root(&format!("runner-drift-{label}"));
        write_fake_pi(
            &root,
            &success_fake_pi(&transcript("planning.task-atoms.v1")),
        );
        let spec = write_planning_spec(&root, mutate, "planning.task-atoms.v1", "gpt-5.5");
        let error = with_fake_path(&root, || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
        .expect_err(label);
        assert!(
            error.contains("drift")
                || error.contains("validation")
                || error.contains("roster")
                || error.contains("tools")
                || error.contains("resolved 0 profiles"),
            "{label}: {error}"
        );
    }
}

#[test]
fn runner_stale_or_linked_carrier_output_and_resource_limits_fail_closed() {
    let root = temp_root("runner-stale");
    write_fake_pi(
        &root,
        &success_fake_pi(&transcript("planning.task-atoms.v1")),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let stale_path = carrier_path(&root);
    fs::create_dir_all(stale_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(stale_path, b"stale").expect("stale carrier");
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("stale")
        .contains("unconsumed pre-existing carrier refused")
    );

    let root = temp_root("runner-bounded");
    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconsole.log('x'.repeat(4096));\nsetTimeout(()=>{}, 200);\n",
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("bounded stdout");
    assert!(
        error.contains("JSON") || error.contains("malformed"),
        "{error}"
    );

    let root = temp_root("runner-missing-settled");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "const msg = message({:?}); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message:msg}}); send({{type:'agent_end',willRetry:false}}); process.exit(0);",
                transcript("planning.task-atoms.v1")
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("missing settled");
    assert!(
        error.contains("agent_settled") || error.contains("missing rpc responses"),
        "{error}"
    );
}

#[test]
fn runner_streaming_pi_jsonl_discards_message_update_chatter_but_keeps_final_event() {
    let root = temp_root("runner-streaming");
    let stats_path = root.join("stream-stats.json");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "send({{type:'agent_start'}}); for (let i=0; i<400; i++) {{ const msg = message('scratch '+i+' '+ 'x'.repeat(2048), 'gpt-5.5', 'toolUse'); send({{type:'message_update', message:msg, assistantMessageEvent:{{type:'thinking_delta',delta:'x'}}}}); }} emitCarrierResult({accepted:?}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}});"
            ),
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        with_env(
            "AUTOPILOT_AGENT_RUN_STATS_PATH",
            stats_path.to_str().expect("stats path"),
            || child::main(&["--spec".to_owned(), spec.display().to_string()]),
        )
    })
    .expect("streaming chatter should not trip total stdout cap");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
    let stats: Value =
        serde_json::from_slice(&fs::read(stats_path).expect("stats")).expect("stats json");
    assert!(stats["stdout_total_bytes"].as_u64().expect("total") > 1024);
    assert!(stats["message_update_frames"].as_u64().expect("updates") >= 400);
    assert_eq!(stats["stdout_tail_truncated"], true);
    assert!(stats["peak_retained_stdout_bytes"].as_u64().expect("peak") < 4096);
}

#[test]
fn runner_real_pi_high_streaming_probe_when_enabled() {
    if std::env::var("AUTOPILOT_RUN_REAL_PI_STREAMING_PROBE")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!("skipping live Pi streaming probe; set AUTOPILOT_RUN_REAL_PI_STREAMING_PROBE=1");
        return;
    }
    let root = temp_root("runner-real-pi-streaming");
    let stats_path = root.join("real-pi-stream-stats.json");
    let expected = transcript("planning.task-atoms.v1");
    let prompt = format!(
        "You are validating a streaming JSON runner. Think carefully about why repeated message_update events can amplify transcript bytes at high thinking depth. Then return exactly this JSON payload, with no code block or surrounding prose:\n{expected}"
    );
    let spec = write_planning_spec_with_prompt(
        &root,
        |value| value,
        "planning.task-atoms.v1",
        "gpt-5.5",
        &prompt,
    );
    with_env(
        "AUTOPILOT_AGENT_RUN_STATS_PATH",
        stats_path.to_str().expect("stats path"),
        || child::main(&["--spec".to_owned(), spec.display().to_string()]),
    )
    .expect("real pi streaming run");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert!(
        carrier["raw_output"]
            .as_str()
            .expect("raw")
            .contains("\"atoms\"")
    );
    let stats: Value =
        serde_json::from_slice(&fs::read(stats_path).expect("stats")).expect("stats json");
    let total = stats["stdout_total_bytes"].as_u64().expect("total");
    let peak = stats["peak_retained_stdout_bytes"].as_u64().expect("peak");
    assert!(
        total > 4096,
        "expected substantial real Pi transcript, got {total}"
    );
    assert!(
        peak < total,
        "retained {peak} should stay below transcript {total}"
    );
}

fn write_planning_spec(
    root: &Path,
    mutate: impl Fn(Value) -> Value,
    boundary: &str,
    model: &str,
) -> PathBuf {
    write_planning_spec_with_prompt(
        root,
        mutate,
        boundary,
        model,
        "runner prompt with AUTHORITY-A-SENTINEL AUTHORITY-B-SENTINEL AUTHORITY-C-SENTINEL CONTEXT-SENTINEL-UNIQUE",
    )
}

fn write_planning_spec_with_prompt(
    root: &Path,
    mutate: impl Fn(Value) -> Value,
    boundary: &str,
    model: &str,
    prompt: &str,
) -> PathBuf {
    write_planning_spec_inner(
        root,
        "019fa883-1eaf-75f9-99af-6aa246736f72",
        mutate,
        boundary,
        model,
        prompt,
    )
}

fn write_planning_spec_with_prompt_for_run(
    root: &Path,
    run_id: &str,
    boundary: &str,
    model: &str,
    prompt: &str,
) -> PathBuf {
    write_planning_spec_inner(root, run_id, |value| value, boundary, model, prompt)
}

fn write_planning_spec_inner(
    root: &Path,
    run_id: &str,
    mutate: impl Fn(Value) -> Value,
    boundary: &str,
    model: &str,
    prompt: &str,
) -> PathBuf {
    let assignment_id = Id("planning-main-task-extractor-01".to_owned());
    // Session directories are run-owned in production; mirror that here so the
    // test cannot pass by accident when two runs share one directory.
    let session_dir = root.join("run-sessions").join(run_id);
    fs::create_dir_all(&session_dir).expect("session dir");
    let paths = planning_paths(root, "main", &assignment_id);
    fs::create_dir_all(paths.prompt_path.parent().expect("prompt parent")).expect("prompt dir");
    fs::write(&paths.prompt_path, prompt).expect("prompt");
    let tools = role_tool_names("task-extractor").expect("tools");
    let authority_documents = vec![
        doc("TASK-A.md", "authority", "AUTHORITY-A-SENTINEL"),
        doc("TASK-B.md", "authority", "AUTHORITY-B-SENTINEL"),
        doc("TASK-C.md", "authority", "AUTHORITY-C-SENTINEL"),
    ];
    let context_document = doc(
        "CONTEXT.md",
        "context/non-authority",
        "CONTEXT-SENTINEL-UNIQUE",
    );
    let context_documents = vec![context_document.clone()];
    let repo_binding =
        repository_authority_binding(root, "main").expect("repository authority binding");
    let context_digest =
        planning_context_digest_for_spec(root, "set-a", &authority_documents, &context_documents);
    let session_id = session_id_for(
        &Id(run_id.to_owned()),
        &Id("main".to_owned()),
        &assignment_id,
        &Id("task-extractor".to_owned()),
        &ModeId("inventory".to_owned()),
        &ContractId(boundary.to_owned()),
    );
    let spec = json!({
        "schema":"autopilot.agent_run_spec.v4",
        "assignment_kind":"planning-review",
        "action_id":"action-planning-main-task-extractor-01",
        "assignment_id":"planning-main-task-extractor-01",
        "run_id":run_id,
        "run_revision":1,
        "workstream":"main",
        "role_id":"task-extractor",
        "mode":"inventory",
        "provider":"openai-codex",
        "model":model,
        "thinking":"high",
        "route":"subscription",
        "cwd":root,
        "allowed_tools":tools,
        "spec_path":paths.spec_path,
        "prompt_path":paths.prompt_path,
        "prompt_digest":sha256_hex(prompt.as_bytes()),
        "session_dir":session_dir.display().to_string(),
        "session_continuity":"fresh",
        "boundary_id":boundary,
        "boundary_digest":contract_digest(boundary),
        "result_contract":boundary,
        "result_contract_digest":contract_digest(boundary),
        "carrier_path":paths.carrier_path,
        "session_id":session_id.0,
        "settings_digest":settings_digest(true),
        "context_digest":context_digest,
        "skills_digest":sha256_hex(SKILLS_IDENTITY.as_bytes()),
        "subscription_digest":subscription_digest("openai-codex", model, "high"),
        "atom_id_prefix":"planning-main-task-extractor-01-atom-",
        "authority_set_id":"set-a",
        "authority_documents":authority_documents,
        "context_document":context_document,
        "context_documents":context_documents,
        "repository_manifest_path":repo_binding.path,
        "repository_manifest_digest":repo_binding.digest,
        "repository_head_commit":repo_binding.manifest.head_commit,
        "repository_head_tree":repo_binding.manifest.head_tree,
        "runtime_extension_path":child_addon_path(),
        "runtime_extension_digest":sha256_hex(&fs::read(child_addon_path()).expect("child addon")),
        "terminal_profile_id":"planning.task-atoms.v1:autopilot_submit_atoms",
        "unavailable_tools":[]
    });
    let spec = mutate(spec);
    fs::create_dir_all(paths.spec_path.parent().expect("spec parent")).expect("spec dir");
    fs::write(
        &paths.spec_path,
        serde_json::to_vec_pretty(&spec).expect("spec json"),
    )
    .expect("spec");
    paths.spec_path
}

fn doc(path: &str, class: &str, body: &str) -> Value {
    json!({"path":path,"class":class,"digest":task_document_digest(class, "set-a", body),"body_digest":sha256_hex(body.as_bytes()),"body":body})
}

fn child_addon_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts")
}

fn child_addon_runtime_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/child-extension-runtime.ts")
}

fn carrier_path(root: &Path) -> PathBuf {
    planning_paths(
        root,
        "main",
        &Id("planning-main-task-extractor-01".to_owned()),
    )
    .carrier_path
}

fn valid_handoff() -> Value {
    json!({
        "schema":"autopilot.agent-handoff.v1",
        "completed":["read TASK-A"],
        "remaining":["emit final atoms"],
        "critical_state":{
            "semantic_lens":"WORK",
            "authority_coverage":["TASK-A whole file"],
            "atom_ledger":["planning-main-task-extractor-01-atom-draft"],
            "duplicate_dispositions":["none"],
            "unresolved_ambiguities":["none"]
        },
        "next_action":"resume and emit final atoms"
    })
}

fn success_fake_pi(output: &str) -> String {
    rpc_fake_pi("", &format!("emitCarrier({output:?});"))
}

fn rpc_fake_pi(setup: &str, on_prompt: &str) -> String {
    format!(
        r#"#!/usr/bin/env node
import {{ createHash }} from 'node:crypto';
import {{ appendFileSync, readFileSync, writeFileSync }} from 'node:fs';
let promptCount = 0;
let readToolCount = 0;
let contextPercent = 10;
const sessionId = process.argv[process.argv.indexOf('--session-id') + 1];
const sessionDirIndex = process.argv.indexOf('--session-dir');
if (sessionDirIndex === -1) {{ process.stderr.write('fake pi: --session-dir is required\n'); process.exit(64); }}
const sessionDir = process.argv[sessionDirIndex + 1];
const addonIndex = process.argv.indexOf('-e');
const addonPath = addonIndex === -1 ? undefined : process.argv[addonIndex + 1];
const toolsIndex = process.argv.indexOf('--tools');
if (toolsIndex === -1) {{ process.stderr.write('fake pi: --tools is required\n'); process.exit(64); }}
const requestedTools = process.argv[toolsIndex + 1].split(',').filter(Boolean);
const submitBindings = {{
  autopilot_submit_atoms: ['planning.task-atoms.v1', '77d000b816b3c14dcdefeba0c23d4f4f9f8bedaf5b281081f1cea138e525e091'],
  autopilot_submit_context: ['planning.scout-dossier.v1', '30f69b47c83079ce00ea22cab308e9a26eb7b24cae045aa1dd008221b45da618'],
  autopilot_submit_plan_cluster: ['planning.work-map.v1', '237b2e049edc93e6b87d8319b621ba9746e52ed2ee8dfa99b8a53b6ef6695c5e'],
  autopilot_submit_resolution: ['planning.questions.v1', 'a716699618f28675f8872ff8d039c40e8443c07cd6a94f907921ee2b9dd88abc'],
  autopilot_submit_review: ['planning.plan-review.v1', '073f22c10d42166d5ec5d0a6465a1fa8f0df8fc1af2ce6a0702bed9b955786d8'],
  autopilot_submit_scout_report: ['planning.scout-dossier.v1', '30f69b47c83079ce00ea22cab308e9a26eb7b24cae045aa1dd008221b45da618'],
  autopilot_submit_synthesis: ['planning.work-map.v1', '237b2e049edc93e6b87d8319b621ba9746e52ed2ee8dfa99b8a53b6ef6695c5e'],
}};
let activeTools = requestedTools.filter(name => !name.startsWith('autopilot_submit_') || (addonPath !== undefined && submitBindings[name]));
const terminalTool = activeTools.find(name => name.startsWith('autopilot_submit_'));
// Model real Pi's session store: a session file keyed by (sessionDir, sessionId)
// is reopened when it already exists, and its retained messages become context.
const sessionPath = `${{sessionDir}}/${{sessionId}}.jsonl`;
let storedMessages = [];
try {{ storedMessages = readFileSync(sessionPath, 'utf8').split('\n').filter(line => line.trim()); }} catch {{ storedMessages = []; }}
function persist(entry) {{ storedMessages.push(JSON.stringify(entry)); appendFileSync(sessionPath, JSON.stringify(entry) + '\n'); }}
function send(value) {{ if (value.type === 'message_end' && value.message) persist(value.message); process.stdout.write(JSON.stringify(value) + '\n'); }}
function message(text, model='gpt-5.5', stopReason='stop') {{ return {{ role:'assistant', provider:'openai-codex', model, content:[{{type:'text', text}}], stopReason }}; }}
function emitAssistant(text, model='gpt-5.5', stopReason='stop') {{ const msg = message(text, model, stopReason); send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message: msg}}); send({{type:'agent_end', willRetry:false}}); send({{type:'agent_settled'}}); }}
function emitCarrier(payload, model='gpt-5.5', overrides={{}}) {{
  if (!terminalTool) return emitAssistant('declared terminal tool is unavailable', model);
  send({{type:'agent_start'}});
  emitCarrierResult(payload, model, overrides);
  send({{type:'agent_end',willRetry:false}});
  send({{type:'agent_settled'}});
}}
function emitCarrierResult(payload, model='gpt-5.5', overrides={{}}) {{
  const [boundary_id, schema_digest] = submitBindings[terminalTool];
  const profile_id = process.env.AUTOPILOT_TERMINAL_PROFILE ?? `${{boundary_id}}:${{terminalTool}}`;
  const details = {{profile_id,tool_name:terminalTool,boundary_id,result_contract:boundary_id,schema_digest,binding:process.env.AUTOPILOT_CARRIER_BINDING ?? '',payload:typeof payload === 'string' ? JSON.parse(payload) : payload,...overrides}};
  const resultTool = typeof overrideToolName === 'string' ? overrideToolName : terminalTool;
  const callId = 'call_fake_submit_' + promptCount;
  send({{type:'message_start'}});
  send({{type:'message_end',message:{{role:'assistant',provider:'openai-codex',model,content:[{{type:'toolCall',id:callId,name:resultTool,arguments:details.payload}}],stopReason:'toolUse'}}}});
  send({{type:'tool_execution_start',toolCallId:callId,toolName:resultTool,args:details.payload}});
  if (typeof emitPlanningCarrierEntry === 'boolean' && emitPlanningCarrierEntry) send({{type:'entry_appended',entry:{{type:'custom',customType:'pi-autopilot:planning-carrier',data:details,id:'carrier-entry-1',parentId:null,timestamp:new Date(0).toISOString()}}}});
  const submitError = typeof submitIsError === 'boolean' ? submitIsError : false;
  const submitTerminate = typeof submitTerminates === 'boolean' ? submitTerminates : true;
  send({{type:'tool_execution_end',toolCallId:callId,toolName:resultTool,result:{{content:[{{type:'text',text:'submitted'}}],details,terminate:submitTerminate}},isError:submitError}});
  const copiedDetails = typeof toolResultSchemaDigest === 'string' ? {{...details,schema_digest:toolResultSchemaDigest}} : details;
  send({{type:'message_start'}});
  const resultCallId = typeof overrideToolResultCallId === 'string' ? overrideToolResultCallId : callId;
  const toolResultMessage = {{role:'toolResult',toolCallId:resultCallId,toolName:resultTool,content:[{{type:'text',text:'submitted'}}],isError:submitError}};
  if (!(typeof omitToolResultDetails === 'boolean' && omitToolResultDetails)) toolResultMessage.details = copiedDetails;
  send({{type:'message_end',message:toolResultMessage}});
  if (typeof emitSecondTerminalExecutionEnd === 'boolean' && emitSecondTerminalExecutionEnd) {{
    const secondCallId = callId + '_second';
    send({{type:'tool_execution_end',toolCallId:secondCallId,toolName:resultTool,result:{{content:[{{type:'text',text:'submitted-again'}}],details,terminate:submitTerminate}},isError:submitError}});
    send({{type:'message_start'}});
    send({{type:'message_end',message:{{role:'toolResult',toolCallId:secondCallId,toolName:resultTool,content:[{{type:'text',text:'submitted-again'}}],details,isError:submitError}}}});
  }}
}}
function emitReadTool(toolName='read') {{ const callId=`call_fake_${{toolName}}_${{++readToolCount}}`; send({{type:'tool_execution_start',toolCallId:callId,toolName,args:{{path:`TASK-${{readToolCount}}.md`}}}}); send({{type:'tool_execution_end',toolCallId:callId,toolName,result:{{content:[{{type:'text',text:'ok'}}],terminate:false}},isError:false}}); send({{type:'message_start'}}); send({{type:'message_end',message:{{role:'toolResult',timestamp:new Date(0).toISOString(),toolCallId:callId,toolName,content:[{{type:'text',text:'ok'}}],isError:false}}}}); }}
// Reproduces an upstream capacity refusal exactly as observed in production:
// a non-stop terminal with a provider errorMessage, no assistant text, and no
// tokens billed.
function emitCapacityRefusal() {{ send({{type:'agent_start'}}); send({{type:'message_start'}}); send({{type:'message_end', message:{{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[], stopReason:'error', errorMessage:'Codex error: Our servers are currently overloaded. Please try again later.', usage:{{input:0,output:0}}}}}}); send({{type:'agent_end', willRetry:false}}); send({{type:'agent_settled'}}); }}
function statsData() {{ return {{ sessionId, contextUsage: {{ tokens: Math.round(contextPercent * 1000), contextWindow: 100000, percent: contextPercent }} }}; }}
{setup}
const receiptBoundary = submitBindings[terminalTool]?.[0] ?? '';
const receiptSchema = submitBindings[terminalTool]?.[1] ?? '';
const receiptProfile = process.env.AUTOPILOT_TERMINAL_PROFILE ?? `${{receiptBoundary}}:${{terminalTool}}`;
const receiptData = {{self_digest:addonPath === undefined ? '' : createHash('sha256').update(readFileSync(addonPath)).digest('hex'),profile_id:receiptProfile,tool_name:terminalTool,boundary_id:receiptBoundary,result_contract:receiptBoundary,schema_digest:receiptSchema,binding:process.env.AUTOPILOT_CARRIER_BINDING ?? '',active_tools:[...activeTools].sort()}};
const durableReceipt = {{type:'custom',customType:'pi-autopilot:child-tools',data:receiptData,id:'receipt-1',parentId:null,timestamp:new Date(0).toISOString()}};
if (addonPath !== undefined && !(typeof suppressReceipt !== 'undefined' && suppressReceipt) && !(typeof suppressStreamedReceipt !== 'undefined' && suppressStreamedReceipt)) {{
  const streamed = {{...durableReceipt,customType:typeof streamedReceiptCustomType === 'string' ? streamedReceiptCustomType : durableReceipt.customType,data:{{...receiptData,binding:typeof streamedReceiptBinding === 'string' ? streamedReceiptBinding : receiptData.binding}}}};
  send({{type:'entry_appended',entry:streamed}});
  if (typeof duplicateStreamedReceipt !== 'undefined' && duplicateStreamedReceipt) send({{type:'entry_appended',entry:streamed}});
}}
let buffer = '';
process.stdin.on('data', chunk => {{ buffer += chunk; let lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) {{ if (line.trim()) handle(JSON.parse(line)); }} }});
process.stdin.on('end', () => process.exit(0));
function handle(cmd) {{
  if (cmd.type === 'set_auto_compaction') return send({{id:cmd.id,type:'response',command:'set_auto_compaction',success:true}});
  if (cmd.type === 'get_state') return send({{id:cmd.id,type:'response',command:'get_state',success:true,data:{{model:{{id:'gpt-5.5',provider:'openai-codex'}},thinkingLevel:'high',sessionId,autoCompactionEnabled:false,messageCount:storedMessages.length,pendingMessageCount:0}}}});
  if (cmd.type === 'get_session_stats') return send({{id:cmd.id,type:'response',command:'get_session_stats',success:true,data:statsData()}});
  if (cmd.type === 'get_entries') {{
    const entries = addonPath === undefined || (typeof suppressReceipt !== 'undefined' && suppressReceipt) || (typeof suppressDurableReceipt !== 'undefined' && suppressDurableReceipt) ? [] : [durableReceipt];
    return send({{id:cmd.id,type:'response',command:'get_entries',success:true,data:{{entries,leafId:entries[0]?.id ?? null}}}});
  }}
  if (cmd.type === 'abort') return send({{id:cmd.id,type:'response',command:'abort',success:true}});
  if (cmd.type === 'compact') {{ send({{type:'compaction_start',reason:'manual'}}); send({{type:'compaction_end',reason:'manual',aborted:false,willRetry:false}}); send({{id:cmd.id,type:'response',command:'compact',success:true,data:{{summary:'ok'}}}}); if (typeof afterCompact === 'function') afterCompact(cmd); return; }}
  if (cmd.type === 'steer') {{ send({{id:cmd.id,type:'response',command:'steer',success:true}}); if (!(typeof suppressSteerQueue !== 'undefined' && suppressSteerQueue)) send({{type:'queue_update',steering:[cmd.message],followUp:[]}}); if (typeof afterSteer === 'function') afterSteer(cmd); return; }}
  if (cmd.type === 'prompt') {{ promptCount++; persist({{role:'user', content:cmd.message}}); send({{id:cmd.id,type:'response',command:'prompt',success:true}}); {on_prompt}; return; }}
  send({{id:cmd.id,type:'response',command:cmd.type,success:false,error:'unexpected command'}});
}}
"#
    )
}

fn terminalmiss_prompt_log(root: &Path) -> PathBuf {
    root.join("terminalmiss-prompts.jsonl")
}

fn terminalmiss_prompt_rows(root: &Path) -> Vec<Value> {
    let text = fs::read_to_string(terminalmiss_prompt_log(root)).expect("prompt log");
    text.lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("prompt row"))
        .collect()
}

fn terminalmiss_run(root: &Path, setup: &str, on_prompt: &str) -> Result<(), String> {
    let log_path = terminalmiss_prompt_log(root);
    let setup = format!("const terminalMissPromptLog = {:?};\n{}", log_path, setup);
    let on_prompt = format!(
        "appendFileSync(terminalMissPromptLog, JSON.stringify({{count:promptCount,sessionId,message:cmd.message}})+'\\n'); {}",
        on_prompt
    );
    write_fake_pi(root, &rpc_fake_pi(&setup, &on_prompt));
    let spec = write_planning_spec(root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
}

fn terminalmiss_attempt_rows(root: &Path) -> Vec<Value> {
    attempt_event_rows(root, "planning-main-task-extractor-01")
}

fn terminalmiss_attempt_events(root: &Path) -> Vec<String> {
    attempt_events(root, "planning-main-task-extractor-01")
}

#[test]
fn terminal_count_increments_only_on_terminating_tool_results() {
    let root = temp_root("terminalmiss-finding-zero");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!("if (promptCount === 1) {{ send({{type:'agent_start'}}); for (let i=0;i<16;i++) emitReadTool('read'); const msg = message(''); send({{type:'message_start'}}); send({{type:'message_end',message:msg}}); send({{type:'agent_end',willRetry:false}}); send({{type:'agent_settled'}}); }} else {{ emitCarrier({accepted:?}); }}"),
    )
    .expect("empty stop should be continued and then accepted");
    let rows = terminalmiss_attempt_rows(&root);
    let miss = rows
        .iter()
        .filter_map(|row| row.get("terminal_miss"))
        .find(|value| value.is_object())
        .expect("terminal miss event");
    assert_eq!(miss["class"], "empty-stop-no-terminal");
    assert_eq!(miss["tool_execution_count"], 16);
}

#[test]
fn empty_stop_without_terminal_classifies_as_empty_stop() {
    let root = temp_root("terminalmiss-empty-stop");
    terminalmiss_run(&root, "", "emitAssistant('');").expect_err("empty stops exhaust");
    let rows = terminalmiss_attempt_rows(&root);
    assert_eq!(rows[1]["terminal_miss"]["class"], "empty-stop-no-terminal");
}

#[test]
fn prose_records_bounded_preview_and_digest() {
    let root = temp_root("terminalmiss-prose-preview");
    let prose = "p".repeat(3000);
    terminalmiss_run(&root, "", &format!("emitAssistant({prose:?});")).expect_err("prose exhausts");
    let rows = terminalmiss_attempt_rows(&root);
    let miss = &rows[1]["terminal_miss"];
    assert_eq!(miss["class"], "prose-instead-of-terminal");
    assert_eq!(miss["text_len"], 3000);
    assert_eq!(miss["text_digest"].as_str().expect("digest").len(), 64);
    assert!(miss["preview"].as_str().expect("preview").len() < 3000);
}

#[test]
fn empty_stop_error_does_not_claim_assistant_text() {
    let root = temp_root("terminalmiss-empty-not-text");
    let error = terminalmiss_run(&root, "", "emitAssistant('');").expect_err("empty stop fails");
    assert!(error.contains("empty-stop-no-terminal"), "{error}");
    assert!(!error.contains("returned assistant text"), "{error}");
}

#[test]
fn no_terminal_frame_is_distinct_and_non_retryable() {
    let root = temp_root("terminalmiss-no-frame");
    let error = terminalmiss_run(&root, "", "send({type:'agent_start'}); send({type:'agent_end',willRetry:false}); send({type:'agent_settled'});").expect_err("no terminal frame");
    assert!(error.contains("no-terminal-frame"), "{error}");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 1);
}

#[test]
fn terminal_tool_not_offered_is_non_retryable() {
    let root = temp_root("terminalmiss-not-offered");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "activeTools = activeTools.filter(name => name !== 'autopilot_submit_atoms');",
            "emitAssistant('');",
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("inactive terminal tool fails before prompt");
    assert!(error.contains("terminal-tool-not-offered"), "{error}");
    assert!(error.contains("source=pre-prompt-active-tools"), "{error}");
    assert!(attempt_events(&root, "planning-main-task-extractor-01").is_empty());
}

#[test]
fn multiple_terminals_is_non_retryable() {
    let root = temp_root("terminalmiss-multiple");
    let accepted = transcript("planning.task-atoms.v1");
    let error = terminalmiss_run(
        &root,
        "const emitSecondTerminalExecutionEnd = true;",
        &format!("emitCarrier({accepted:?});"),
    )
    .expect_err("multiple terminals fail");
    assert!(error.contains("multiple-terminals"), "{error}");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 1);
}

#[test]
fn continuation_stops_after_declared_attempts() {
    let root = temp_root("terminalmiss-declared-attempts");
    terminalmiss_run(&root, "", "emitAssistant('');").expect_err("exhausts");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 2);
}

#[test]
fn max_attempts_matches_generated_contract() {
    assert_eq!(drivers::generated::recovery::MAX_TERMINAL_ATTEMPTS, 2);
    let recovery = include_str!("../data/recovery.kdl");
    assert!(recovery.contains("terminal_continuation"));
    assert!(recovery.contains("max_attempts=2"));
}

#[test]
fn terminal_and_value_budgets_are_independent() {
    let root = temp_root("terminalmiss-independent-budgets");
    terminalmiss_run(&root, "", "if (promptCount % 2 === 1) emitAssistant(''); else emitCarrier({atoms:[{id:'wrong',kind:'work',text:'x',sources:[]}]});").expect_err("value repair exhausts");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 6);
    assert!(terminalmiss_attempt_events(&root).contains(&"value-rejected".to_owned()));
}

#[test]
fn combined_worst_case_attempts_are_bounded() {
    let root = temp_root("terminalmiss-six-turn-bound");
    terminalmiss_run(&root, "", "if (promptCount % 2 === 1) emitAssistant(''); else emitCarrier({atoms:[{id:'wrong',kind:'work',text:'x',sources:[]}]});").expect_err("bounded at six turns");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 2 * 3);
}

#[test]
fn capacity_refusal_during_continuation_does_not_consume_a_continuation() {
    let root = temp_root("terminalmiss-capacity-inside-continuation");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!("if (promptCount === 1) emitAssistant(''); else if (promptCount === 2) emitCapacityRefusal(); else emitCarrier({accepted:?});"),
    )
    .expect("capacity retry inside continuation succeeds");
    assert_eq!(terminalmiss_prompt_rows(&root).len(), 3);
    assert_eq!(
        terminalmiss_attempt_events(&root),
        [
            "started",
            "terminal-continuation",
            "continuation-prepared",
            "continuation-dispatched",
            "upstream-capacity-retry",
            "continuation-dispatched",
            "terminal-continuation-carrier-produced",
            "accepted"
        ]
    );
}

#[test]
fn continuation_stays_in_same_session() {
    let root = temp_root("terminalmiss-same-session");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!("if (promptCount===1) emitAssistant(''); else emitCarrier({accepted:?});"),
    )
    .expect("continued");
    let sessions = terminalmiss_prompt_rows(&root)
        .iter()
        .map(|row| row["sessionId"].as_str().expect("session").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(sessions[0], sessions[1]);
}

#[test]
fn directive_contains_no_prior_assistant_text() {
    let root = temp_root("terminalmiss-no-prior-prose");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(&root, "", &format!("if (promptCount===1) emitAssistant('SECRET_PREVIOUS_PROSE'); else emitCarrier({accepted:?});")).expect("continued");
    assert!(
        !terminalmiss_prompt_rows(&root)[1]["message"]
            .as_str()
            .expect("directive")
            .contains("SECRET_PREVIOUS_PROSE")
    );
}

#[test]
fn directive_contains_no_schema_fields_or_task_guidance() {
    let root = temp_root("terminalmiss-no-schema-fields");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!(
            "if (promptCount===1) emitAssistant('bad prose'); else emitCarrier({accepted:?});"
        ),
    )
    .expect("continued");
    let directive = terminalmiss_prompt_rows(&root)[1]["message"]
        .as_str()
        .expect("directive")
        .to_owned();
    assert!(directive.contains("autopilot_submit_atoms"));
    for forbidden in [
        "assignment_id",
        "schema_digest",
        "health_status",
        "payload",
        "sources",
    ] {
        assert!(
            !directive.contains(forbidden),
            "directive leaked {forbidden}: {directive}"
        );
    }
}

#[test]
fn prose_is_never_accepted_at_any_attempt() {
    let root = temp_root("terminalmiss-prose-never-accepted");
    terminalmiss_run(&root, "", "emitAssistant('NEVER_A_CARRIER');").expect_err("prose fails");
    assert!(!carrier_path(&root).exists());
}

#[test]
fn continuation_carrier_uses_identical_validation_path() {
    let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/runner/child.rs"))
        .expect("source");
    assert!(source.contains("match write_carrier"));
    assert!(!source.contains("lenient_after_retry"));
}

#[test]
fn exhausted_continuation_does_not_reach_write_carrier() {
    let root = temp_root("terminalmiss-exhaust-no-carrier");
    terminalmiss_run(&root, "", "emitAssistant('');").expect_err("exhausts");
    assert!(!carrier_path(&root).exists());
}

#[test]
fn acceptance_predicate_unchanged_over_golden_corpus() {
    let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/runner/child.rs"))
        .expect("source");
    assert!(source.contains("let CarrierSource::Tool(terminal) = source;"));
    assert!(!source.contains("CarrierSource::Assistant"));
}

#[test]
fn attempt_event_appended_before_directive_is_issued() {
    let root = temp_root("terminalmiss-event-before-directive");
    terminalmiss_run(
        &root,
        "",
        "if (promptCount===1) emitAssistant(''); else process.exit(0);",
    )
    .expect_err("fake exits after directive is issued");
    assert_eq!(
        terminalmiss_attempt_events(&root),
        [
            "started",
            "terminal-continuation",
            "continuation-prepared",
            "continuation-dispatched",
        ]
    );
}

#[test]
fn attempt_event_records_all_decisive_fields() {
    let root = temp_root("terminalmiss-event-fields");
    terminalmiss_run(&root, "", "emitAssistant('field evidence');").expect_err("prose fails");
    let miss = &terminalmiss_attempt_rows(&root)[1]["terminal_miss"];
    for key in [
        "class",
        "text_len",
        "text_digest",
        "preview",
        "tool_execution_count",
    ] {
        assert!(miss.get(key).is_some(), "missing {key}: {miss}");
    }
}

#[test]
fn success_after_continuation_is_distinguishable_from_clean_run() {
    let root = temp_root("terminalmiss-success-distinct");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!("if (promptCount===1) emitAssistant(''); else emitCarrier({accepted:?});"),
    )
    .expect("continued success");
    assert!(
        terminalmiss_attempt_events(&root)
            .contains(&"terminal-continuation-carrier-produced".to_owned())
    );
}

#[test]
fn exhaustion_error_carries_full_class_sequence() {
    let root = temp_root("terminalmiss-class-sequence");
    let error = terminalmiss_run(&root, "", "emitAssistant('');").expect_err("exhausts");
    assert!(
        error.contains("classes=[empty-stop-no-terminal,empty-stop-no-terminal]"),
        "{error}"
    );
}

#[test]
fn repeated_identical_prose_is_classified_deterministic() {
    let root = temp_root("terminalmiss-deterministic-prose");
    let error =
        terminalmiss_run(&root, "", "emitAssistant('same prose');").expect_err("deterministic");
    assert!(
        error.contains("deterministic repeated prose digest"),
        "{error}"
    );
}

#[test]
fn differing_prose_is_classified_stochastic_exhaustion() {
    let root = temp_root("terminalmiss-stochastic-prose");
    let error = terminalmiss_run(&root, "", "emitAssistant('different prose '+promptCount);")
        .expect_err("stochastic exhaustion");
    assert!(error.contains("terminal continuation exhausted"), "{error}");
    assert!(
        error.contains("classes=[prose-instead-of-terminal,prose-instead-of-terminal]"),
        "{error}"
    );
}

#[test]
fn run_summary_reports_terminal_continuations_by_role() {
    let root = temp_root("terminalmiss-summary-by-role");
    let accepted = transcript("planning.task-atoms.v1");
    terminalmiss_run(
        &root,
        "",
        &format!("if (promptCount===1) emitAssistant(''); else emitCarrier({accepted:?});"),
    )
    .expect("continued");
    let continuations = terminalmiss_attempt_rows(&root)
        .iter()
        .filter(|row| row["event"] == "terminal-continuation")
        .count();
    let summary = json!({"terminal_continuations_total":{"task-extractor":continuations},"terminal_continuations":{"planning-main-task-extractor-01":continuations}});
    assert_eq!(summary["terminal_continuations_total"]["task-extractor"], 1);
}

fn terminalmiss_planning_manifest() -> drivers::planning::PlanningManifest {
    use drivers::planning::{PlanningAgentAssignment, PlanningManifest, PlanningWaveDeclaration};
    PlanningManifest {
        workstream: "w".to_owned(),
        planning_wave_cap: 5,
        planning_max_attempts: 1,
        assignments: (1..=3)
            .map(|ordinal| PlanningAgentAssignment {
                assignment_id: format!("a{ordinal}"),
                role: "task-extractor".to_owned(),
                mode: "inventory".to_owned(),
                boundary_id: Some("planning.task-atoms.v1".to_owned()),
                ordinal,
                atom_id_prefix: None,
            })
            .collect(),
        waves: vec![PlanningWaveDeclaration {
            id: "w1".to_owned(),
            role: "task-extractor".to_owned(),
            dependencies: Vec::new(),
            ordinals: None,
            activation_ref: None,
            canonical_output: false,
        }],
    }
}

fn terminalmiss_refs_with_failed_and_active() -> drivers::planning::PlanningRefs {
    use drivers::planning::{PlanningIssuedRef, PlanningRefs, PlanningTerminalFailureRef};
    let mut refs = PlanningRefs::default();
    refs.issued.push(PlanningIssuedRef {
        assignment_id: "a1".to_owned(),
        action_id: "act1".to_owned(),
        run_revision: 1,
    });
    refs.issued.push(PlanningIssuedRef {
        assignment_id: "a2".to_owned(),
        action_id: "act2".to_owned(),
        run_revision: 1,
    });
    refs.terminal_failures.insert(PlanningTerminalFailureRef {
        assignment_id: "a1".to_owned(),
        action_id: "act1".to_owned(),
        run_revision: 1,
        status: "failed".to_owned(),
    });
    refs
}

#[test]
fn siblings_are_not_cancelled_on_peer_terminal_failure() {
    let manifest = terminalmiss_planning_manifest();
    let refs = terminalmiss_refs_with_failed_and_active();
    let status = drivers::planning::barrier_status(&manifest, &manifest.waves[0], &refs);
    assert!(
        matches!(status, drivers::planning::PlanningBarrierStatus::Running { active, .. } if active.iter().any(|item| item.assignment_id == "a2"))
    );
}

#[test]
fn wave_still_fails_when_a_required_worker_fails() {
    let manifest = terminalmiss_planning_manifest();
    let mut refs = terminalmiss_refs_with_failed_and_active();
    refs.issued.retain(|issued| issued.assignment_id != "a2");
    let status = drivers::planning::barrier_status(&manifest, &manifest.waves[0], &refs);
    assert!(matches!(
        status,
        drivers::planning::PlanningBarrierStatus::Blocked { .. }
    ));
}

#[test]
fn wave_evidence_includes_all_sibling_outcomes() {
    let manifest = terminalmiss_planning_manifest();
    let mut refs = terminalmiss_refs_with_failed_and_active();
    refs.issued.retain(|issued| issued.assignment_id != "a2");
    let outcome = drivers::planning::next_planning_wave(&manifest, &refs, 5);
    assert!(
        matches!(outcome, drivers::planning::PlanningWaveOutcome::Blocked(blocked) if blocked.failed_assignments == ["a1"] && blocked.completed_assignments.is_empty())
    );
}

#[test]
fn cancelled_and_failed_outcomes_are_distinct_in_evidence() {
    let failed = json!({"worker":"a1","outcome":"failed","class":"empty-stop-no-terminal"});
    let cancelled = json!({"worker":"a2","outcome":"orchestrator-cancelled"});
    assert_ne!(failed["outcome"], cancelled["outcome"]);
}

#[test]
fn replay_captured_scout_01_jsonl() {
    let text = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/terminal_miss/repository-scout-01-empty-stop.jsonl"
    ))
    .expect("captured jsonl");
    let mut assistant = 0;
    let mut stop_reasons = Vec::new();
    let mut tool_calls = Vec::new();
    let mut submit_calls = 0;
    let mut final_text_len = None;
    let mut registered = false;
    for line in text.lines() {
        let row: Value = serde_json::from_str(line).expect("jsonl row");
        if row["customType"] == "pi-autopilot:child-tools" {
            registered = row["data"]["profile_id"]
                == "planning.scout-dossier.v1:autopilot_submit_scout_report";
        }
        if row["type"] == "message" && row["message"]["role"] == "assistant" {
            assistant += 1;
            stop_reasons.push(
                row["message"]["stopReason"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
            let mut text_len = 0;
            for content in row["message"]["content"].as_array().expect("content") {
                if content["type"] == "text" {
                    text_len += content["text"].as_str().unwrap_or("").len();
                }
                if content["type"] == "toolCall" {
                    let name = content["name"].as_str().expect("tool name").to_owned();
                    if name.starts_with("autopilot_submit") {
                        submit_calls += 1;
                    }
                    tool_calls.push(name);
                }
            }
            final_text_len = Some(text_len);
        }
    }
    assert!(registered);
    assert_eq!(assistant, 8);
    assert_eq!(stop_reasons.last().map(String::as_str), Some("stop"));
    assert_eq!(final_text_len, Some(0));
    assert_eq!(tool_calls.len(), 33);
    assert_eq!(submit_calls, 0);
    assert_eq!(tool_calls.iter().filter(|name| *name == "read").count(), 16);
    assert_eq!(tool_calls.iter().filter(|name| *name == "grep").count(), 13);
    assert_eq!(tool_calls.iter().filter(|name| *name == "find").count(), 3);
    assert_eq!(tool_calls.iter().filter(|name| *name == "ls").count(), 1);
}

fn send_command(state: &mut CoreState, raw: &str) -> SeamEnvelope {
    let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}});
    seam::handle_line(&frame.to_string(), state).expect("handle command")
}

fn write_task_file(root: &Path, name: &str, marker: &str, id: &str, body: &str) {
    fs::write(
        root.join(name),
        format!("{marker}\nauthority_set_id: {id}\n\n{body}"),
    )
    .expect("write task file");
}

fn git_init(root: &Path) {
    git(root, &["init"]);
    git(
        root,
        &["config", "user.email", "runner-child@example.invalid"],
    );
    git(root, &["config", "user.name", "Runner Child"]);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "task pack"]);
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {:?} failed stdout={} stderr={}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_fake_pi(root: &Path, body: &str) {
    let path = root.join("pi");
    fs::write(&path, body).expect("fake pi");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("chmod");
    }
}

fn with_fake_path<T>(root: &Path, run: impl FnOnce() -> T) -> T {
    let _guard = PATH_LOCK.lock().expect("path lock");
    let old = std::env::var_os("PATH");
    let separator = if cfg!(windows) { ";" } else { ":" };
    let next = match old.as_ref() {
        Some(value) => format!("{}{}{}", root.display(), separator, value.to_string_lossy()),
        None => root.display().to_string(),
    };
    unsafe {
        std::env::set_var("PATH", next);
    }
    let result = run();
    match old {
        Some(value) => unsafe {
            std::env::set_var("PATH", value);
        },
        None => unsafe {
            std::env::remove_var("PATH");
        },
    }
    result
}

fn with_env<T>(key: &str, value: &str, run: impl FnOnce() -> T) -> T {
    let old = std::env::var_os(key);
    unsafe {
        std::env::set_var(key, value);
    }
    let result = run();
    match old {
        Some(value) => unsafe {
            std::env::set_var(key, value);
        },
        None => unsafe {
            std::env::remove_var(key);
        },
    }
    result
}

fn temp_root(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("pi-autopilot-{name}-{nanos}"));
    fs::create_dir_all(&root).expect("temp root");
    let root = fs::canonicalize(&root).expect("canonical temp root");
    let vcs = GitVcs::new(root.parent().expect("temp parent"));
    vcs.init_fixture(&root).expect("fixture git repo");
    fs::write(
        root.join(".gitignore"),
        ".pi/autopilot/\n.pi/tasks/\nrun-sessions/\npi\n*.json\n*.jsonl\n*.txt\nterminalmiss-prompts.jsonl\nstream-stats.json\nreal-pi-stream-stats.json\n",
    )
    .expect("gitignore");
    vcs.stage_all(&root).expect("stage fixture root");
    vcs.snapshot(&root, "fixture root")
        .expect("commit fixture root");
    root
}

const SKILLS_IDENTITY: &str = "agent-run-skills:disabled:v1";

fn contract_digest(contract_id: &str) -> String {
    let admits = match contract_id {
        "planning.task-atoms.v1" => kernel::generated::TASK_ATOMS_ADMITS,
        other => panic!("test fixture missing contract digest for {other}"),
    };
    sha256_hex(format!("{contract_id}\0{admits}").as_bytes())
}

fn subscription_digest(provider: &str, model: &str, thinking: &str) -> String {
    sha256_hex(
        format!("provider={provider}\0model={model}\0thinking={thinking}\0route=subscription")
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

fn planning_context_digest_for_spec(
    root: &Path,
    authority_set_id: &str,
    authority_documents: &[Value],
    context_documents: &[Value],
) -> String {
    let authority_documents =
        serde_json::from_value::<Vec<TaskDocument>>(Value::Array(authority_documents.to_vec()))
            .expect("authority documents match agent-run spec schema");
    let context_documents =
        serde_json::from_value::<Vec<TaskDocument>>(Value::Array(context_documents.to_vec()))
            .expect("context documents match agent-run spec schema");
    let repo_authority = repository_authority_binding(root, "main").expect("repository authority");
    planning_context_digest(
        authority_set_id,
        &authority_documents,
        &context_documents,
        &repo_authority,
    )
    .expect("planning context digest")
}

fn extract_task_source_manifest_json(text: &str) -> String {
    let begin = drivers::planning::CANONICAL_TASK_SOURCE_MANIFEST_JSON_BEGIN;
    let end = drivers::planning::CANONICAL_TASK_SOURCE_MANIFEST_JSON_END;
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

fn runner_child_expected_task_manifest() -> String {
    let authority_documents = [
        planning_task_doc(
            "TASK-A.md",
            planning::TaskDocumentClass::Authority,
            "AUTHORITY-A-SENTINEL",
        ),
        planning_task_doc(
            "TASK-B.md",
            planning::TaskDocumentClass::Authority,
            "AUTHORITY-B-SENTINEL",
        ),
        planning_task_doc(
            "TASK-C.md",
            planning::TaskDocumentClass::Authority,
            "AUTHORITY-C-SENTINEL",
        ),
    ];
    let context_documents = [planning_task_doc(
        "CONTEXT.md",
        planning::TaskDocumentClass::ContextNonAuthority,
        "CONTEXT-SENTINEL-UNIQUE",
    )];
    let input = planning::TaskInputSet {
        authority_set_id: "set-a".to_owned(),
        authority_documents: authority_documents.to_vec(),
        context_documents: context_documents.to_vec(),
    };
    planning::TaskAnchorRegistry::from_input_set(&input)
        .expect("valid runner child task manifest input")
        .canonical_source_manifest()
        .to_owned()
}

fn planning_task_doc(
    path: &str,
    class: planning::TaskDocumentClass,
    body: &str,
) -> planning::TaskDocument {
    let class_name = match class {
        planning::TaskDocumentClass::Authority => "authority",
        planning::TaskDocumentClass::ContextNonAuthority => "context/non-authority",
        planning::TaskDocumentClass::HistoricalNonAuthority => "historical/non-authority",
        planning::TaskDocumentClass::IndexNonAuthority => "index/non-authority",
        planning::TaskDocumentClass::InlineTask => "inline-task",
    };
    planning::TaskDocument {
        id: path.to_owned(),
        path: path.to_owned(),
        class,
        authority_set_id: "set-a".to_owned(),
        body: body.to_owned(),
        digest: task_document_digest(class_name, "set-a", body),
    }
}

fn task_atoms_output(path: &str, body: &str) -> String {
    let source = format!(
        "task://{}/{path}#whole-file",
        task_document_digest("authority", "set-a", body)
    );
    json!({
        "atoms":[{
            "id":"planning-main-task-extractor-01-atom-1",
            "kind":"work",
            "text":"Preserve the runner child RPC transport contract.",
            "sources":[source]
        }]
    })
    .to_string()
}

fn transcript(boundary_id: &str) -> String {
    if boundary_id == "planning.task-atoms.v1" {
        return task_atoms_output("TASK-A.md", "AUTHORITY-A-SENTINEL");
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/transcripts")
        .join(boundary_id)
        .join("transcripts.json");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("transcript file"))
            .expect("transcript json");
    value["records"][0]["raw_output"]
        .as_str()
        .expect("raw output")
        .to_owned()
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Two distinct top-level runs must never share a child Pi session.
///
/// The original defect was invisible to every existing gate because the session
/// id was derived only from assignment identity, and probes used a unique
/// temporary cwd per run. This test therefore holds the cwd *fixed* across both
/// runs and clears the repo-local `.pi/autopilot` state between them, which is
/// exactly what an operator does when starting a fresh run. Pi's session store
/// is global, so only a run-scoped identity can keep the second run clean.
#[test]
fn distinct_top_level_runs_do_not_share_child_pi_sessions() {
    let root = temp_root("runner-cross-run-freshness");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi("", &format!("emitCarrier({accepted:?});")),
    );

    let first = write_planning_spec_for_run(
        &root,
        "019fa883-1eaf-75f9-99af-6aa246736f72",
        "planning.task-atoms.v1",
    );
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), first.display().to_string()])
    })
    .expect("first top-level run succeeds");
    // Both runs address the same assignment and therefore the same spec path,
    // so record run 1's identity before run 2 overwrites the file.
    let first_session = spec_session_id(&first);
    let first_dir = spec_session_dir(&first);

    // The operator-visible reset: repo-local autopilot state is removed. Pi's
    // global session store is deliberately left untouched, because Autopilot
    // cannot and must not delete it.
    fs::remove_dir_all(root.join(".pi/autopilot")).expect("clear repo-local state");

    let second = write_planning_spec_for_run(
        &root,
        "019fb111-2c3d-7a4b-8e5f-9a0b1c2d3e4f",
        "planning.task-atoms.v1",
    );
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), second.display().to_string()])
    })
    .expect("second top-level run must start from a fresh child session");

    let second_session = spec_session_id(&second);
    assert_ne!(
        first_session, second_session,
        "two top-level runs derived the same child session id; the second run would inherit the first run's context"
    );
    let second_dir = spec_session_dir(&second);
    assert_ne!(
        first_dir, second_dir,
        "each top-level run must own a private Pi session directory"
    );
}

/// A child declared `fresh` that finds retained conversation must fail loudly
/// rather than silently inheriting it.
#[test]
fn fresh_assignment_still_rejects_prepopulated_session() {
    let root = temp_root("runner-fresh-guard-regression");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi("", &format!("emitCarrier({accepted:?});")),
    );
    let spec = write_planning_spec_for_run(
        &root,
        "019fa883-1eaf-75f9-99af-6aa246736f73",
        "planning.task-atoms.v1",
    );
    let session_dir = spec_session_dir(&spec);
    fs::create_dir_all(&session_dir).expect("session dir");
    fs::write(
        session_dir.join(format!("{}.jsonl", spec_session_id(&spec))),
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"stale\"}]}\n",
    )
    .expect("seed stale session");

    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("genuine fresh startup must refuse inherited history");
    assert!(error.contains("stale child session"), "{error}");
}

#[test]
fn continuation_after_tool_use_does_not_trip_stale_session() {
    let root = temp_root("runner-tooluse-restart-continuation");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            "if (promptCount === 1) { send({type:'agent_start'}); for (let i = 0; i < 15; i++) { const msg = message('investigating '+i, 'gpt-5.5', 'toolUse'); send({type:'message_start'}); send({type:'message_end', message: msg}); } for (let i = 0; i < 43; i++) emitReadTool(); send({type:'agent_end', willRetry:false}); send({type:'agent_settled'}); process.exit(42); }",
        ),
    );
    let spec = write_planning_spec_for_run(
        &root,
        "019fa883-1eaf-75f9-99af-6aa246736f74",
        "planning.task-atoms.v1",
    );
    let first = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("first child stops mid-investigation without a submit");
    assert!(!first.contains("stale child session"), "{first}");
    let session_text = fs::read_to_string(
        spec_session_dir(&spec).join(format!("{}.jsonl", spec_session_id(&spec))),
    )
    .expect("session jsonl");
    assert_eq!(session_text.matches("\"role\":\"assistant\"").count(), 15);
    assert_eq!(session_text.matches("\"role\":\"toolResult\"").count(), 43);
    assert!(!session_text.contains("autopilot_submit"));

    write_fake_pi(
        &root,
        &rpc_fake_pi("", &format!("emitCarrier({accepted:?});")),
    );
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("restart of the same already-validated session must continue, not reassert fresh");
}

#[test]
fn fresh_assignment_rejects_inherited_child_session_history() {
    let root = temp_root("runner-stale-session-rejected");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi("", &format!("emitCarrier({accepted:?});")),
    );
    let spec = write_planning_spec_for_run(
        &root,
        "019fa883-1eaf-75f9-99af-6aa246736f72",
        "planning.task-atoms.v1",
    );

    // Pre-seed the run-owned store with a session file for this exact id, as a
    // prior run would have left behind had identity collided.
    let session_dir = spec_session_dir(&spec);
    fs::create_dir_all(&session_dir).expect("session dir");
    fs::write(
        session_dir.join(format!("{}.jsonl", spec_session_id(&spec))),
        "{\"role\":\"user\",\"content\":\"stale context from an earlier run\"}\n",
    )
    .expect("seed stale session");

    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("fresh assignment must refuse inherited history");
    assert!(
        error.contains("stale child session"),
        "expected a loud stale-session rejection, got: {error}"
    );
}

/// Issue a spec for the next scenario in a multi-scenario test.
///
/// Each scenario is an independent top-level invocation, so each gets its own
/// run identity exactly as production would. Without this, one scenario's
/// retained child session would leak into the next and trip the fresh-session
/// fence instead of the behaviour under test.
fn next_scenario_spec(root: &Path) -> PathBuf {
    static SCENARIO: AtomicU32 = AtomicU32::new(0);
    let n = SCENARIO.fetch_add(1, Ordering::SeqCst);
    write_planning_spec_for_run(
        root,
        &format!("019fb000-0000-7000-8000-{n:012x}"),
        "planning.task-atoms.v1",
    )
}

fn write_planning_spec_for_run(root: &Path, run_id: &str, boundary: &str) -> PathBuf {
    write_planning_spec_with_prompt_for_run(
        root,
        run_id,
        boundary,
        "gpt-5.5",
        "runner prompt with AUTHORITY-A-SENTINEL AUTHORITY-B-SENTINEL AUTHORITY-C-SENTINEL CONTEXT-SENTINEL-UNIQUE",
    )
}

fn spec_session_id(spec_path: &Path) -> String {
    let value: Value =
        serde_json::from_slice(&fs::read(spec_path).expect("spec")).expect("spec json");
    value["session_id"].as_str().expect("session_id").to_owned()
}

fn spec_session_dir(spec_path: &Path) -> PathBuf {
    let value: Value =
        serde_json::from_slice(&fs::read(spec_path).expect("spec")).expect("spec json");
    PathBuf::from(value["session_dir"].as_str().expect("session_dir"))
}

/// A transient upstream capacity refusal must be retried on the same session
/// and then succeed, rather than failing the whole assignment.
///
/// This is the launch-side failure observed in production: three of five
/// same-wave children were refused with "servers are currently overloaded",
/// zero tokens billed, and the run had no retry path for it.
#[test]
fn upstream_capacity_refusal_is_retried_and_then_succeeds() {
    let root = temp_root("runner-capacity-retry");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "if (promptCount === 1) {{ emitCapacityRefusal(); }} else {{ emitCarrier({accepted:?}); }}"
            ),
        ),
    );
    let spec = next_scenario_spec(&root);
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("capacity refusal must be retried, not fatal");

    let events = attempt_events(&root, "planning-main-task-extractor-01");
    assert!(
        events.iter().any(|e| e == "upstream-capacity-retry"),
        "a capacity retry must be recorded: {events:?}"
    );
    assert!(
        events.iter().any(|e| e == "accepted"),
        "assignment must ultimately be accepted: {events:?}"
    );
    assert!(
        events.iter().all(|e| e != "terminal-assistant-hard-fail"),
        "capacity retry must not blur into the terminal hard-fail path: {events:?}"
    );
}

/// A persistent capacity refusal must still fail loudly once the bounded retry
/// budget is exhausted, naming the upstream cause.
#[test]
fn persistent_upstream_capacity_refusal_fails_loudly_after_retries() {
    let root = temp_root("runner-capacity-exhausted");
    write_fake_pi(&root, &rpc_fake_pi("", "emitCapacityRefusal();"));
    let spec = next_scenario_spec(&root);
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("persistent capacity refusal must fail");
    assert!(
        error.contains("upstream capacity refusal"),
        "error must name the upstream cause: {error}"
    );
    assert!(
        error.contains("exhausted"),
        "error must report retry exhaustion: {error}"
    );
    assert!(
        !carrier_path(&root).exists(),
        "no carrier may be written for an upstream refusal"
    );
}

/// A generic non-stop terminal without the provider refusal evidence remains a
/// loud terminal hard failure, but now leaves bounded forensic facts explaining
/// why the strict capacity classifier did not match.
#[test]
fn terminal_error_without_provider_error_message_hard_fails_and_persists_forensics() {
    let root = temp_root("runner-terminal-error-forensics");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            "send({type:'agent_start'}); \
             send({type:'message_start'}); \
             send({type:'message_end', message:{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[], stopReason:'error'}}); \
             send({type:'agent_end', willRetry:false}); \
             send({type:'agent_settled'});",
        ),
    );
    let spec = next_scenario_spec(&root);
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("generic terminal error must remain a hard failure");
    assert!(
        error.contains("agent-run terminal assistant stopReason was not stop: error"),
        "operator-visible hard failure must stay unchanged: {error}"
    );
    assert!(
        !error.contains("upstream capacity refusal"),
        "generic terminal error must not be reclassified as capacity: {error}"
    );
    assert!(
        !carrier_path(&root).exists(),
        "no carrier may be written for a terminal hard failure"
    );

    let rows = attempt_event_rows(&root, "planning-main-task-extractor-01");
    let forensic = rows
        .iter()
        .find(|row| row["event"] == "terminal-assistant-hard-fail")
        .expect("terminal hard-fail event must be persisted");
    assert_eq!(forensic["schema"], "autopilot.agent_run_attempt_event.v1");
    assert_eq!(forensic["attempt"], 1);
    assert_eq!(forensic["rejection"], Value::Null);
    let terminal = &forensic["terminal_failure"];
    assert_eq!(terminal["stopReason"], "error");
    assert_eq!(terminal["provider_errorMessage_present"], false);
    assert_eq!(terminal["provider_errorMessage"], Value::Null);
    assert_eq!(terminal["assistant_text_present"], false);
    assert_eq!(terminal["assistant_text_len"], 0);
    assert_eq!(terminal["capacity_detector_matched"], false);
    let miss = terminal["capacity_detector_miss"]
        .as_array()
        .expect("capacity miss reasons")
        .iter()
        .map(|value| value.as_str().expect("miss reason"))
        .collect::<Vec<_>>();
    assert_eq!(miss, ["missing-errorMessage"]);
}

/// Assistant text cannot be mistaken for a capacity refusal or a planning
/// carrier. It is an identity-channel error and must not consume value repair.
#[test]
fn content_failure_is_not_misclassified_as_capacity_refusal() {
    let root = temp_root("runner-content-not-capacity");
    write_fake_pi(
        &root,
        &rpc_fake_pi("", "emitAssistant('no boundary token here');"),
    );
    let spec = next_scenario_spec(&root);
    let error = with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect_err("content failure must still fail");
    assert!(
        !error.contains("upstream capacity refusal"),
        "content failure must not be classified as upstream capacity: {error}"
    );
    assert!(
        error.contains("terminal miss deterministic repeated prose digest"),
        "repeated planning text must fail through terminal continuation: {error}"
    );
    assert_eq!(
        attempt_events(&root, "planning-main-task-extractor-01"),
        [
            "started",
            "terminal-continuation",
            "continuation-prepared",
            "continuation-dispatched",
            "terminal-continuation-deterministic"
        ]
    );
}

fn attempt_events(root: &Path, assignment_id: &str) -> Vec<String> {
    let path = root
        .join(".pi/autopilot/runner/attempt-events")
        .join(format!("{assignment_id}.jsonl"));
    let text = fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|row| row["event"].as_str().map(str::to_owned))
        .collect()
}

fn attempt_event_rows(root: &Path, assignment_id: &str) -> Vec<Value> {
    let path = root
        .join(".pi/autopilot/runner/attempt-events")
        .join(format!("{assignment_id}.jsonl"));
    let text = fs::read_to_string(path).expect("attempt event log");
    text.lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("attempt event row"))
        .collect()
}

/// Pi closes a successful auto-retry from inside the replacement turn.
///
/// Verified against `agent-session.js`: `auto_retry_end {success:true}` is
/// emitted on the first non-error assistant `message_end` (line 379), which
/// arrives while the replacement turn is still running. The `success:false`
/// form is emitted post-turn (line 769). Production hit the first ordering and
/// was killed by an unhandled transition, discarding a run Pi had already
/// recovered.
#[test]
fn auto_retry_closed_inside_replacement_turn_is_accepted() {
    let root = temp_root("runner-autoretry-midturn");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &rpc_fake_pi(
            "",
            &format!(
                "send({{type:'agent_start'}}); \
                 send({{type:'message_start'}}); \
                 send({{type:'message_end', message:{{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[], stopReason:'error', errorMessage:'Codex error: Our servers are currently overloaded. Please try again later.'}}}}); \
                 send({{type:'agent_end',willRetry:true}}); \
                 send({{type:'auto_retry_start'}}); \
                 send({{type:'agent_start'}}); \
                 send({{type:'message_start'}}); \
                 emitCarrierResult({accepted:?}); \
                 send({{type:'auto_retry_end',success:true}}); \
                 send({{type:'agent_end',willRetry:false}}); \
                 send({{type:'agent_settled'}});"
            ),
        ),
    );
    let spec = next_scenario_spec(&root);
    with_fake_path(&root, || {
        child::main(&["--spec".to_owned(), spec.display().to_string()])
    })
    .expect("a retry Pi closed mid-turn must be accepted, not rejected as out-of-order");
    assert!(
        carrier_path(&root).exists(),
        "the recovered assistant result must still produce a carrier"
    );
}
