use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use std::collections::BTreeSet;

use drivers::planning::{
    PlanningAcceptedRef, PlanningIssuedRef, PlanningLaunchAckRef, PlanningManifest, PlanningRefs,
    next_planning_wave, planning_policy,
};
use drivers::seam::{CoreState, handle_line};
use kernel::generated::SeamEnvelope;
use serde_json::json;

static CWD_LOCK: Mutex<()> = Mutex::new(());

fn temp_repo(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("pi-autopilot-impl10-{name}-{}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root).expect("old temp cleanup");
    }
    fs::create_dir_all(&root).expect("temp repo");
    root
}

fn run_git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .expect("git executable");
    assert!(status.success(), "git {args:?} failed with {status}");
}

fn write_planning_inputs(root: &Path) {
    fs::write(
        root.join("TASK-A.md"),
        doc("[authority]", "set-a", "Implement batch planning."),
    )
    .expect("task a");
    fs::write(
        root.join("TASK-B.md"),
        doc("[authority]", "set-a", "Respect every barrier."),
    )
    .expect("task b");
    fs::write(
        root.join("TASK-C.md"),
        doc("[authority]", "set-a", "Acknowledge launches."),
    )
    .expect("task c");
    fs::write(
        root.join("CONTEXT.md"),
        doc("[context/non-authority]", "set-a", "Repository context."),
    )
    .expect("context");
}

fn doc(marker: &str, id: &str, body: &str) -> String {
    format!("{marker}\nauthority_set_id: {id}\n\n{body}")
}

fn init_repo(root: &Path) {
    run_git(root, &["init", "-q"]);
    run_git(root, &["config", "user.email", "test@example.com"]);
    run_git(root, &["config", "user.name", "Test"]);
    run_git(root, &["add", "."]);
    run_git(root, &["commit", "-q", "-m", "fixture"]);
}

fn command_frame(id: u64, raw: &str) -> String {
    json!({"v":1,"id":id,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}}).to_string()
}

fn send(state: &mut CoreState, line: String) -> SeamEnvelope {
    handle_line(&line, state).expect("core frame")
}

fn with_repo<T>(name: &str, f: impl FnOnce(&Path, &mut CoreState) -> T) -> T {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = temp_repo(name);
    write_planning_inputs(&root);
    init_repo(&root);
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
    }
    std::env::set_current_dir(&root).expect("chdir");
    let mut state = CoreState::open(None).expect("state");
    let out = f(&root, &mut state);
    std::env::set_current_dir(previous).expect("restore cwd");
    out
}

#[test]
fn planning_wave_launches_full_wave_up_to_cap() {
    with_repo("full-wave", |_root, state| {
        let frame = send(
            state,
            command_frame(
                1,
                "autopilot-plan main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md",
            ),
        );
        assert_eq!(frame.kind, "spawn-wave", "payload={}", frame.payload);
        let actions = frame.payload["actions"].as_array().expect("wave actions");
        assert_eq!(actions.len(), 7);
        assert!(actions.iter().all(|action| {
            action["assignment_id"]
                .as_str()
                .expect("assignment id")
                .contains("task-extractor")
        }));
    });
}

#[test]
fn planning_wave_respects_lower_cap_and_tops_up() {
    let manifest = PlanningManifest::from_policy(
        "lower-cap",
        &planning_policy().expect("planning policy parses"),
    )
    .expect("manifest");
    let p1 = manifest
        .assignments
        .iter()
        .filter(|assignment| assignment.role == "task-extractor")
        .collect::<Vec<_>>();

    let first = next_planning_wave(&manifest, &PlanningRefs::default(), 3).expect("first wave");
    assert_eq!(first.len(), 3);
    assert!(
        first
            .iter()
            .all(|assignment| assignment.role == "task-extractor")
    );

    let issued = p1
        .iter()
        .take(3)
        .enumerate()
        .map(|(index, assignment)| PlanningIssuedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: format!("action-{index}"),
            run_revision: 1,
        })
        .collect::<Vec<_>>();
    let refs = PlanningRefs {
        issued: issued.clone(),
        launch_acks: issued
            .iter()
            .map(|issued| PlanningLaunchAckRef {
                assignment_id: issued.assignment_id.clone(),
                action_id: issued.action_id.clone(),
                run_revision: issued.run_revision,
                task_id: format!("task-{}", issued.action_id),
            })
            .collect(),
        accepted: BTreeSet::from([PlanningAcceptedRef {
            assignment_id: issued[0].assignment_id.clone(),
            action_id: issued[0].action_id.clone(),
            run_revision: issued[0].run_revision,
        }]),
        terminal_failures: BTreeSet::new(),
        activation_refs: BTreeSet::new(),
    };

    let topup = next_planning_wave(&manifest, &refs, 3).expect("top-up");
    assert_eq!(topup.len(), 1);
    assert_eq!(topup[0].assignment_id, p1[3].assignment_id);
    assert_ne!(topup[0].role, "repository-scout");
}

#[test]
fn core_restart_midwave_recomputes_identical_wave() {
    let manifest = PlanningManifest::from_policy(
        "restart-midwave",
        &planning_policy().expect("planning policy parses"),
    )
    .expect("manifest");
    let p1 = manifest
        .assignments
        .iter()
        .filter(|assignment| assignment.role == "task-extractor")
        .collect::<Vec<_>>();
    let issued = p1
        .iter()
        .take(5)
        .enumerate()
        .map(|(index, assignment)| PlanningIssuedRef {
            assignment_id: assignment.assignment_id.clone(),
            action_id: format!("action-{index}"),
            run_revision: 1,
        })
        .collect::<Vec<_>>();
    let refs = PlanningRefs {
        issued: issued.clone(),
        launch_acks: issued
            .iter()
            .map(|issued| PlanningLaunchAckRef {
                assignment_id: issued.assignment_id.clone(),
                action_id: issued.action_id.clone(),
                run_revision: issued.run_revision,
                task_id: format!("task-{}", issued.action_id),
            })
            .collect(),
        accepted: BTreeSet::from([PlanningAcceptedRef {
            assignment_id: issued[0].assignment_id.clone(),
            action_id: issued[0].action_id.clone(),
            run_revision: issued[0].run_revision,
        }]),
        terminal_failures: BTreeSet::new(),
        activation_refs: BTreeSet::new(),
    };

    let before = next_planning_wave(&manifest, &refs, 7).expect("before restart");
    let after = next_planning_wave(&manifest, &refs.clone(), 7).expect("after restart");
    assert_eq!(before, after);
    assert_eq!(before.len(), 2);
    assert!(
        before
            .iter()
            .all(|assignment| assignment.assignment_id != p1[0].assignment_id)
    );
    assert_eq!(before[0].assignment_id, p1[5].assignment_id);
}
