use std::fs;
use std::path::Path;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

fn fixture() -> TempDir {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_dir = temp.path().join("data");
    fs::create_dir_all(&data_dir).expect("create data dir");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/contracts.kdl"),
        data_dir.join("contracts.kdl"),
    )
    .expect("copy contracts");
    temp
}

fn codegen_command() -> Command {
    Command::cargo_bin("codegen").expect("codegen binary")
}

#[test]
fn check_catches_a_hand_edit_and_recovers() {
    let temp = fixture();

    codegen_command()
        .current_dir(temp.path())
        .assert()
        .success();
    codegen_command()
        .current_dir(temp.path())
        .arg("--check")
        .assert()
        .success();

    let generated = temp.path().join("kernel/src/generated/mod.rs");
    let mut content = fs::read_to_string(&generated).expect("read generated file");
    content.push_str("// hand edit\n");
    fs::write(&generated, content).expect("mutate generated file");

    codegen_command()
        .current_dir(temp.path())
        .arg("--check")
        .assert()
        .code(1)
        .stderr(predicates::str::contains("first differing line"));

    codegen_command()
        .current_dir(temp.path())
        .assert()
        .success();
    codegen_command()
        .current_dir(temp.path())
        .arg("--check")
        .assert()
        .success();
}

#[test]
fn unknown_kdl_node_is_rejected() {
    let temp = fixture();
    let contracts = temp.path().join("data/contracts.kdl");
    let mut content = fs::read_to_string(&contracts).expect("read contracts");
    content.push_str("\nbogus_node \"not allowed\"\n");
    fs::write(&contracts, content).expect("write bogus contracts");

    codegen_command()
        .current_dir(temp.path())
        .assert()
        .code(2)
        .stderr(
            predicates::str::contains("unknown top-level node `bogus_node`")
                .and(predicates::str::contains("line")),
        );
}
