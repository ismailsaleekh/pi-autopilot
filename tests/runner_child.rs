#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::runner::{child, planning_paths, role_builtin_tool_names, session_id_for};
use drivers::seam::{self, CoreState};
use kernel::generated::{ContractId, CoreToHostSpawnPayload, Id, ModeId, SeamEnvelope};
use serde_json::{json, Value};
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
        &format!(
            r#"#!/usr/bin/env node
import {{ writeFileSync }} from 'node:fs';
writeFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2), cwd: process.cwd() }}));
const text = {:?};
const message = {{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};
console.log(JSON.stringify({{type:'message_end', message}}));
console.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));
"#,
            argv_path, accepted
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
    assert_eq!(argv[0..3], ["--mode", "json", "--session-id"]);
    assert!(argv[3].starts_with("autopilot-planning-main-task-extractor-01-"));
    assert_eq!(
        argv[4..15],
        [
            "--no-extensions",
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
    assert!(argv.contains(&"read,grep,find,ls".to_owned()));
    assert!(argv.contains(&"-p".to_owned()));
    assert_eq!(
        PathBuf::from(argv_record["cwd"].as_str().expect("cwd")),
        root
    );
}

#[test]
fn real_core_agent_run_accepts_variadic_authority_spec() {
    let root = temp_root("runner-variadic-real-core");
    write_fake_pi(&root, &success_fake_pi(&transcript("planning.task-atoms.v1")));
    let context_document = doc(
        "CONTEXT.md",
        "context/non-authority",
        "CONTEXT-SENTINEL-UNIQUE",
    );
    let authority_documents = (1..=6)
        .map(|index| doc(&format!("TASK-{index}.md"), "authority", &format!("AUTHORITY-{index}")))
        .collect::<Vec<_>>();
    let expected_context_digest = sha_json(&json!({
        "authority_set_id":"set-a",
        "authority_documents":authority_documents.clone(),
        "context_document":context_document.clone(),
    }));
    let spec = write_planning_spec(
        &root,
        |mut value| {
            value["authority_documents"] = json!(authority_documents);
            value["context_digest"] = json!(expected_context_digest);
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
    }

    let previous = std::env::current_dir().expect("current dir");
    std::env::set_current_dir(&root).expect("chdir root");
    let mut state = CoreState::open(None).expect("core state");
    let envelope = send_command(
        &mut state,
        "autopilot-plan main A1.md A2.md A3.md A4.md A5.md A6.md C1.md C2.md",
    );
    std::env::set_current_dir(previous).expect("restore cwd");

    assert_eq!(envelope.kind, "spawn", "payload={}", envelope.payload);
    let spawn: CoreToHostSpawnPayload =
        serde_json::from_value(envelope.payload).expect("spawn payload");
    assert_eq!(spawn.action.assignment_id.0, "planning-main-task-extractor-01");

    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join(".pi/autopilot/main/planning-manifest.json")).expect("manifest"),
    )
    .expect("manifest json");
    let manifest_contexts = manifest["context_documents"].as_array().expect("manifest contexts");
    assert_eq!(manifest_contexts.len(), 2);
    assert_eq!(manifest_contexts[0]["path"], "C1.md");
    assert_eq!(manifest_contexts[1]["path"], "C2.md");
    assert_eq!(manifest["context"]["path"], "C1.md");
    assert_eq!(manifest["context_document"]["path"], "C1.md");

    let spec_path = root.join(".pi/autopilot/main/planning/specs/planning-main-task-extractor-01.json");
    let spec: Value = serde_json::from_slice(&fs::read(&spec_path).expect("spec"))
        .expect("spec json");
    let spec_contexts = spec["context_documents"].as_array().expect("spec contexts");
    assert_eq!(spec_contexts.len(), 2);
    assert_eq!(spec_contexts[0]["body"], "CTX1");
    assert_eq!(spec_contexts[1]["body"], "CTX2");
    assert_eq!(spec["context_document"]["path"], "C1.md");

    let prompt = fs::read_to_string(
        root.join(".pi/autopilot/main/planning/prompts/planning-main-task-extractor-01.md"),
    )
    .expect("planning prompt");
    assert!(prompt.contains("CTX1"), "{prompt}");
    assert!(prompt.contains("CTX2"), "{prompt}");
}

#[test]
fn fake_pi_boundary_retry_reuses_session_and_succeeds() {
    let root = temp_root("runner-retry");
    let count_path = root.join("count.txt");
    let argv_path = root.join("argv.jsonl");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &format!(
            r#"#!/usr/bin/env node
import {{ readFileSync, writeFileSync, appendFileSync }} from 'node:fs';
let count = 0;
try {{ count = Number(readFileSync({count_path:?}, 'utf8')); }} catch {{ count = 0; }}
count += 1;
writeFileSync({count_path:?}, String(count));
appendFileSync({argv_path:?}, JSON.stringify({{ argv: process.argv.slice(2) }}) + '\n');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
if (count === 2 && !prompt.includes('field:    raw_output')) process.exit(43);
const text = count === 1 ? 'not-json' : {accepted:?};
const message = {{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};
console.log(JSON.stringify({{type:'message_end', message}}));
console.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));
"#,
            count_path = count_path,
            argv_path = argv_path,
            accepted = accepted,
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
    assert_eq!(session_ids.len(), 2);
    assert_eq!(session_ids[0], session_ids[1]);
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
fn fake_pi_nonzero_malformed_wrong_model_boundary_and_jsonl_protocol_fail_loudly() {
    let root = temp_root("runner-failures");

    write_fake_pi(&root, "#!/usr/bin/env node\nprocess.exit(42);\n");
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("nonzero")
    .contains("nonzero"));

    write_fake_pi(&root, "#!/usr/bin/env node\nconsole.log('not json');\n");
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("malformed")
    .contains("malformed"));

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst message={{role:'assistant', provider:'openai-codex', model:'wrong', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("wrong model")
    .contains("provider/model drift"));

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'no boundary token here'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\n",
    );
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("boundary")
    .contains("value repair exhausted"));

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst message={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("agent_end")
    .contains("agent_end"));

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst one={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconst two={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message:one}}));\nconsole.log(JSON.stringify({{type:'message_end', message:two}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[one,two], willRetry:false}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .is_ok(),
        "agent_end final messages select the accepted assistant result"
    );
    fs::remove_file(carrier_path(&root)).ok();

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst message={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message}}));\nconsole.log(JSON.stringify({{type:'tool_execution_start', toolName:'read'}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("tool after assistant")
    .contains("tool activity"));

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst toolUse={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text:'thinking'}}], stopReason:'toolUse'}};\nconst final={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message:toolUse}}));\nconsole.log(JSON.stringify({{type:'tool_execution_start', toolName:'read'}}));\nconsole.log(JSON.stringify({{type:'tool_execution_end', toolName:'read'}}));\nconsole.log(JSON.stringify({{type:'turn_end', message:final, toolResults:[]}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[toolUse, final], willRetry:false}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    fs::remove_file(carrier_path(&root)).ok();
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .is_ok(),
        "real Pi 0.82 agent_end messages shape should parse"
    );

    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst message={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'length'}};\nconsole.log(JSON.stringify({{type:'message_end', message}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));\n",
            transcript("planning.task-atoms.v1")
        ),
    );
    fs::remove_file(carrier_path(&root)).ok();
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("bad stopReason")
    .contains("stopReason"));
}

#[test]
fn drifted_spec_fields_are_rejected_before_pi_launch() {
    let cases: Vec<(&str, Box<dyn Fn(Value) -> Value>)> = vec![
        (
            "role",
            Box::new(|mut value| {
                value["role_id"] = json!("not-a-registered-role");
                value
            }),
        ),
        (
            "mode",
            Box::new(|mut value| {
                value["mode"] = json!("not-a-registered-mode");
                value
            }),
        ),
        (
            "provider",
            Box::new(|mut value| {
                value["provider"] = json!("openrouter");
                value
            }),
        ),
        (
            "model",
            Box::new(|mut value| {
                value["model"] = json!("not-rostered");
                value
            }),
        ),
        (
            "thinking",
            Box::new(|mut value| {
                value["thinking"] = json!("max");
                value
            }),
        ),
        (
            "route",
            Box::new(|mut value| {
                value["route"] = json!("api-key");
                value
            }),
        ),
        (
            "tools",
            Box::new(|mut value| {
                value["allowed_tools"] = json!(["bash"]);
                value
            }),
        ),
        (
            "boundary",
            Box::new(|mut value| {
                value["boundary_id"] = json!("planning.questions.v1");
                value
            }),
        ),
        (
            "result",
            Box::new(|mut value| {
                value["result_contract"] = json!("planning.questions.v1");
                value
            }),
        ),
        (
            "prompt",
            Box::new(|mut value| {
                let other =
                    PathBuf::from(value["cwd"].as_str().expect("cwd")).join("not-the-prompt.md");
                value["prompt_path"] = json!(other);
                value
            }),
        ),
        (
            "boundary_digest",
            Box::new(|mut value| {
                value["boundary_digest"] = json!("0".repeat(64));
                value
            }),
        ),
        (
            "context_digest",
            Box::new(|mut value| {
                value["context_digest"] = json!("1".repeat(64));
                value
            }),
        ),
        (
            "doc_digest",
            Box::new(|mut value| {
                value["authority_documents"][0]["digest"] = json!("2".repeat(64));
                value
            }),
        ),
        (
            "assignment",
            Box::new(|mut value| {
                value["assignment_id"] = json!("planning-main-task-extractor-forged");
                value
            }),
        ),
    ];
    for (label, mutate) in cases {
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
                || error.contains("tools"),
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
    assert!(with_fake_path(&root, || child::main(&[
        "--spec".to_owned(),
        spec.display().to_string()
    ]))
    .expect_err("stale")
    .contains("stale carrier rejected"));

    let root = temp_root("runner-bounded");
    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconsole.log('x'.repeat(4096));\nsetTimeout(()=>{}, 200);\n",
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        with_env("AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES", "1024", || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
    })
    .expect_err("bounded stdout");
    assert!(error.contains("Transient"), "{error}");
    assert!(
        error.contains("AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES"),
        "{error}"
    );
    assert!(error.contains("artifact="), "{error}");
    assert!(error.contains("malformed"), "{error}");

    let root = temp_root("runner-timeout");
    write_fake_pi(&root, "#!/usr/bin/env node\nsetTimeout(()=>{}, 5000);\n");
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        with_env("AUTOPILOT_AGENT_RUN_TIMEOUT_MS", "50", || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
    })
    .expect_err("timeout");
    assert!(error.contains("timeout"));

    let root = temp_root("runner-process-tree");
    let marker = root.join("grandchild-survived");
    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nimport {{ spawn }} from 'node:child_process';\nspawn(process.execPath, ['-e', {:?}], {{stdio:'ignore'}});\nsetTimeout(()=>{{}}, 5000);\n",
            format!(
                "setTimeout(()=>require('fs').writeFileSync({:?}, 'alive'), 500)",
                marker
            )
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    let error = with_fake_path(&root, || {
        with_env("AUTOPILOT_AGENT_RUN_TIMEOUT_MS", "50", || {
            child::main(&["--spec".to_owned(), spec.display().to_string()])
        })
    })
    .expect_err("timeout tree");
    assert!(error.contains("timeout"));
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(
        !marker.exists(),
        "process-group termination must reap child process trees"
    );
}

#[test]
fn runner_streaming_pi_jsonl_discards_message_update_chatter_but_keeps_final_event() {
    let root = temp_root("runner-streaming");
    let stats_path = root.join("stream-stats.json");
    let accepted = transcript("planning.task-atoms.v1");
    write_fake_pi(
        &root,
        &format!(
            "#!/usr/bin/env node\nconst text={:?};\nconst finalMessage={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nfor (let i=0; i<400; i++) {{\n  const message={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text:'scratch '+i+' '+ 'x'.repeat(2048)}}], stopReason:'toolUse'}};\n  console.log(JSON.stringify({{type:'message_update', message, assistantMessageEvent:{{type:'thinking_delta', delta:'x'}}}}));\n}}\nconsole.log(JSON.stringify({{type:'message_end', message:finalMessage}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[finalMessage], willRetry:false}}));\n",
            accepted
        ),
    );
    let spec = write_planning_spec(&root, |value| value, "planning.task-atoms.v1", "gpt-5.5");
    with_fake_path(&root, || {
        with_env("AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES", "1024", || {
            with_env(
                "AUTOPILOT_AGENT_RUN_STATS_PATH",
                stats_path.to_str().expect("stats path"),
                || child::main(&["--spec".to_owned(), spec.display().to_string()]),
            )
        })
    })
    .expect("streaming chatter should not trip total stdout cap");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert_eq!(carrier["raw_output"], accepted);
    let stats: Value =
        serde_json::from_slice(&fs::read(stats_path).expect("stats")).expect("stats json");
    assert!(stats["stdout_total_bytes"].as_u64().expect("total") > 1024);
    assert_eq!(stats["stdout_tail_bytes"].as_u64(), Some(1024));
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
    with_env("AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES", "4096", || {
        with_env(
            "AUTOPILOT_AGENT_RUN_STATS_PATH",
            stats_path.to_str().expect("stats path"),
            || child::main(&["--spec".to_owned(), spec.display().to_string()]),
        )
    })
    .expect("real pi streaming run");
    let carrier: Value = serde_json::from_slice(&fs::read(carrier_path(&root)).expect("carrier"))
        .expect("carrier json");
    assert!(carrier["raw_output"]
        .as_str()
        .expect("raw")
        .contains("\"atoms\""));
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
    let assignment_id = Id("planning-main-task-extractor-01".to_owned());
    let paths = planning_paths(root, "main", &assignment_id);
    fs::create_dir_all(paths.prompt_path.parent().expect("prompt parent")).expect("prompt dir");
    fs::write(&paths.prompt_path, prompt).expect("prompt");
    let tools = role_builtin_tool_names("task-extractor").expect("tools");
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
    let context_digest = sha_json(&json!({
        "authority_set_id":"set-a",
        "authority_documents":authority_documents.clone(),
        "context_document":context_document.clone(),
    }));
    let session_id = session_id_for(
        &Id("main".to_owned()),
        &assignment_id,
        &Id("task-extractor".to_owned()),
        &ModeId("inventory".to_owned()),
        &ContractId(boundary.to_owned()),
    );
    let spec = json!({
        "schema":"autopilot.agent_run_spec.v1",
        "assignment_kind":"planning-review",
        "action_id":"action-planning-main-task-extractor-01",
        "assignment_id":"planning-main-task-extractor-01",
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
        "boundary_id":boundary,
        "boundary_digest":contract_digest(boundary),
        "result_contract":boundary,
        "result_contract_digest":contract_digest(boundary),
        "carrier_path":paths.carrier_path,
        "session_id":session_id.0,
        "settings_digest":sha256_hex(SETTINGS_IDENTITY.as_bytes()),
        "context_digest":context_digest,
        "skills_digest":sha256_hex(SKILLS_IDENTITY.as_bytes()),
        "subscription_digest":subscription_digest("openai-codex", model, "high"),
        "authority_set_id":"set-a",
        "authority_documents":authority_documents,
        "context_document":context_document
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

fn carrier_path(root: &Path) -> PathBuf {
    planning_paths(
        root,
        "main",
        &Id("planning-main-task-extractor-01".to_owned()),
    )
    .carrier_path
}

fn success_fake_pi(output: &str) -> String {
    format!(
        "#!/usr/bin/env node\nconst text={output:?};\nconst message={{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text}}], stopReason:'stop'}};\nconsole.log(JSON.stringify({{type:'message_end', message}}));\nconsole.log(JSON.stringify({{type:'turn_end', message, toolResults:[]}}));\nconsole.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));\nconsole.log(JSON.stringify({{type:'agent_settled'}}));\n"
    )
}

fn send_command(state: &mut CoreState, raw: &str) -> SeamEnvelope {
    let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}});
    seam::handle_line(&frame.to_string(), state).expect("handle command")
}

fn write_task_file(root: &Path, name: &str, marker: &str, id: &str, body: &str) {
    fs::write(root.join(name), format!("{marker}\nauthority_set_id: {id}\n\n{body}"))
        .expect("write task file");
}

fn git_init(root: &Path) {
    git(root, &["init"]);
    git(root, &["config", "user.email", "runner-child@example.invalid"]);
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
    fs::canonicalize(&root).expect("canonical temp root")
}

const SETTINGS_IDENTITY: &str = "agent-run-settings:session-id,no-extensions,no-skills,no-prompt-templates,no-themes,no-context-files:v1";
const SKILLS_IDENTITY: &str = "agent-run-skills:disabled:v1";

fn contract_digest(contract_id: &str) -> String {
    let admits = match contract_id {
        "planning.task-atoms.v1" => {
            "Task extractor output must name operator-task atoms with source anchors and no repository findings."
        }
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

fn sha_json(value: &impl serde::Serialize) -> String {
    sha256_hex(&serde_json::to_vec(value).expect("json digest"))
}

fn transcript(boundary_id: &str) -> String {
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
