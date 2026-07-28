#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::runner::{child, planning_paths, role_builtin_tool_names};
use kernel::generated::Id;
use serde_json::{Value, json};
use sha2::{Digest as ShaDigest, Sha256};

static PATH_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn fake_pi_journey_writes_identity_carrier_and_isolated_exact_args() {
    let root = temp_root("runner-success");
    let argv_path = root.join("argv.json");
    write_fake_pi(
        &root,
        &format!(
            r#"#!/usr/bin/env node
import {{ writeFileSync }} from 'node:fs';
writeFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2), cwd: process.cwd() }}));
const message = {{role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{{type:'text', text:'atom: deliver success'}}], stopReason:'stop'}};
console.log(JSON.stringify({{type:'message_end', message}}));
console.log(JSON.stringify({{type:'agent_end', messages:[message], willRetry:false}}));
"#,
            argv_path
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
    assert_eq!(carrier["raw_output"], "atom: deliver success");
    assert!(carrier["spec_digest"].as_str().expect("spec digest").len() == 64);

    let argv_record: Value =
        serde_json::from_slice(&fs::read(argv_path).expect("argv")).expect("argv json");
    let argv = argv_record["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .map(|item| item.as_str().expect("arg").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        argv[0..13],
        [
            "--mode",
            "json",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--provider",
            "openai-codex",
            "--model",
            "gpt-5.5",
            "--thinking"
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
        .contains("nonzero")
    );

    write_fake_pi(&root, "#!/usr/bin/env node\nconsole.log('not json');\n");
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("malformed")
        .contains("malformed")
    );

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'wrong', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\n",
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
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'no boundary token here'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\n",
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("boundary")
        .contains("boundary rejection")
    );

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\n",
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("agent_end")
        .contains("agent_end")
    );

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst one={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconst two={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom two'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message:one}));\nconsole.log(JSON.stringify({type:'message_end', message:two}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[two], willRetry:false}));\n",
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("multiple assistants")
        .contains("assistant results")
    );

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'tool_execution_start', toolName:'read'}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\n",
    );
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("tool after assistant")
        .contains("tool activity")
    );

    write_fake_pi(
        &root,
        "#!/usr/bin/env node\nconst toolUse={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'thinking'}], stopReason:'toolUse'};\nconst final={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message:toolUse}));\nconsole.log(JSON.stringify({type:'tool_execution_start', toolName:'read'}));\nconsole.log(JSON.stringify({type:'tool_execution_end', toolName:'read'}));\nconsole.log(JSON.stringify({type:'turn_end', message:final, toolResults:[]}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[toolUse, final], willRetry:false}));\n",
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
        "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'length'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\n",
    );
    fs::remove_file(carrier_path(&root)).ok();
    assert!(
        with_fake_path(&root, || child::main(&[
            "--spec".to_owned(),
            spec.display().to_string()
        ]))
        .expect_err("bad stopReason")
        .contains("stopReason")
    );
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
        write_fake_pi(&root, success_fake_pi());
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
fn stale_or_linked_carrier_output_and_resource_limits_fail_closed() {
    let root = temp_root("runner-stale");
    write_fake_pi(&root, success_fake_pi());
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
        .contains("already present")
    );

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
    assert!(error.contains("stdout exceeded"));

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

fn write_planning_spec(
    root: &Path,
    mutate: impl Fn(Value) -> Value,
    boundary: &str,
    model: &str,
) -> PathBuf {
    let assignment_id = Id("planning-main-task-extractor-01".to_owned());
    let paths = planning_paths(root, "main", &assignment_id);
    fs::create_dir_all(paths.prompt_path.parent().expect("prompt parent")).expect("prompt dir");
    let prompt = "runner prompt with AUTHORITY-A-SENTINEL AUTHORITY-B-SENTINEL AUTHORITY-C-SENTINEL CONTEXT-SENTINEL-UNIQUE";
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

fn success_fake_pi() -> &'static str {
    "#!/usr/bin/env node\nconst message={role:'assistant', provider:'openai-codex', model:'gpt-5.5', content:[{type:'text', text:'atom'}], stopReason:'stop'};\nconsole.log(JSON.stringify({type:'message_end', message}));\nconsole.log(JSON.stringify({type:'turn_end', message, toolResults:[]}));\nconsole.log(JSON.stringify({type:'agent_end', messages:[message], willRetry:false}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n"
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

const SETTINGS_IDENTITY: &str = "agent-run-settings:no-session,no-extensions,no-skills,no-prompt-templates,no-themes,no-context-files:v1";
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

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
