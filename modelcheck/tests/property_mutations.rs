use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const WORKFLOW: &str = include_str!("../../data/workflow.kdl");
static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn c1_unreachable_state_fails() {
    assert_fails(
        "C1",
        WORKFLOW.replace(
            "    state \"terminal\" terminal=#true\n\n    transition",
            "    state \"terminal\" terminal=#true\n    state \"ghost\" terminal=#false\n    transition from=\"ghost\" to=\"terminal\" evidence=\"ghost-proof\"\n\n    transition",
        ),
    );
}

#[test]
fn c2_non_terminal_without_exit_fails() {
    assert_fails(
        "C2",
        WORKFLOW.replace(
            "    state \"terminal\" terminal=#true\n\n    transition",
            "    state \"terminal\" terminal=#true\n    state \"stuck\" terminal=#false\n\n    transition",
        ).replace(
            "    transition from=\"ready-to-close\" to=\"terminal\" evidence=\"result-ref-archived\"",
            "    transition from=\"ready-to-close\" to=\"stuck\" evidence=\"stuck-proof\"\n    transition from=\"ready-to-close\" to=\"terminal\" evidence=\"result-ref-archived\"",
        ),
    );
}

#[test]
fn c3_cycle_without_exit_fails() {
    assert_fails(
        "C3",
        WORKFLOW.replace(
            "    state \"terminal\" terminal=#true\n\n    transition",
            "    state \"terminal\" terminal=#true\n    state \"loop-a\" terminal=#false\n    state \"loop-b\" terminal=#false\n\n    transition",
        ).replace(
            "    transition from=\"ready-to-execute\" to=\"allocating\" evidence=\"execution-command\"",
            "    transition from=\"ready-to-execute\" to=\"allocating\" evidence=\"execution-command\"\n    transition from=\"allocating\" to=\"loop-a\" evidence=\"loop-entry\"\n    transition from=\"loop-a\" to=\"loop-b\" evidence=\"loop-proof\"\n    transition from=\"loop-b\" to=\"loop-a\" evidence=\"loop-proof\"",
        ),
    );
}

#[test]
fn c4_literal_terminal_reachability_fails() {
    assert_fails(
        "C4",
        WORKFLOW.replace(
            "    transition from=\"ready-to-commit\" to=\"failed\" evidence=\"run-main-cas-failed\" doc=\"D76 §9.1 — compare-and-swap failure is explicit; response-loss restart reconciles postconditions.\"\n",
            "",
        ),
    );
}

#[test]
fn c5_missing_verdict_fails() {
    assert_fails(
        "C5",
        WORKFLOW.replace(
            "    transition from=\"forward-validating-1\" to=\"forward-fixing\" verdict_kind=\"forward\" verdict=\"BLOCKED\" evidence=\"forward-round-1-verdict\" doc=\"D76 §9.2 — blocked forward validation is routed through the consolidated forward Fixer path before the bounded recheck.\"\n",
            "",
        ),
    );
}

#[test]
fn c6_missing_evidence_fails() {
    assert_fails(
        "C6",
        WORKFLOW.replacen("evidence=\"plan-approval\"", "evidence=\"\"", 1),
    );
}

#[test]
fn c7_closed_before_forward_gate_fails() {
    assert_fails(
        "C7",
        WORKFLOW.replace(
            "    transition from=\"allocated\" to=\"implementing\" evidence=\"lane-launch-action\"",
            "    transition from=\"allocated\" to=\"closed\" evidence=\"gate-bypass\"\n    transition from=\"allocated\" to=\"implementing\" evidence=\"lane-launch-action\"",
        ),
    );
}

#[test]
fn c8_parallel_cap_scope_fails() {
    assert_fails(
        "C8",
        WORKFLOW.replace(
            "    state \"implementing\"\n}",
            "    state \"implementing\"\n    state \"release-queued\"\n}",
        ),
    );
}

#[test]
fn unknown_node_is_rejected() {
    let path = write_workflow(format!("{WORKFLOW}\nbogus \"node\"\n"));
    let report = modelcheck::run_path(&path);
    assert_ne!(report.exit_code, 0);
    assert!(
        report.stderr.contains("unknown node `bogus`"),
        "{}",
        report.stderr
    );
    assert!(report.stderr.contains("line"), "{}", report.stderr);
}

fn assert_fails(property: &str, source: String) {
    let path = write_workflow(source);
    let report = modelcheck::run_path(&path);
    assert_eq!(
        report.exit_code, 1,
        "stdout={} stderr={}",
        report.stdout, report.stderr
    );
    assert!(
        report.stdout.contains(&format!("{property} FAIL")),
        "{}",
        report.stdout
    );
    assert!(report.stderr.contains(property), "{}", report.stderr);
}

fn write_workflow(source: String) -> PathBuf {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("modelcheck-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir created");
    let path = dir.join("workflow.kdl");
    std::fs::write(&path, source).expect("workflow written");
    path
}
