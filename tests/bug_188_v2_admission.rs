use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use drivers::planning::{self, WorkMapV2AdmissionContext};
use drivers::runner;
use drivers::seam as production_seam;

// Production promotion is Core-only. This test-local façade makes direct
// image replay fixtures explicit without giving runtime consumers that API.
mod seam {
    pub use super::production_seam::write_approved_plan_v2_for_test_only as write_approved_plan_v2;
    pub use super::production_seam::*;
}
use kernel::generated::{
    AgentRunSpec, ContractId, Digest as ContractDigest, Id, Path as ContractPath, PlanningAtomKind,
    PlanningAtomRegistryAtom, Ref, SchemaId, SessionContinuity, TerminalRoute, ThinkingLevel,
    ToolName, ValidationAssignmentKind,
};
use sha2::{Digest, Sha256};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repository() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/bug-188-v2-fixtures")
        .join(format!(
            "repo-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir_all(root.join("upstream")).unwrap();
    fs::write(root.join("upstream/source.bin"), b"immutable\0source").unwrap();
    fs::write(root.join("upstream/executable.bin"), b"exec\0source\x01").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            root.join("upstream/executable.bin"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "v2@example.invalid"]);
    git(&root, &["config", "user.name", "V2"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "--quiet", "-m", "fixture"]);
    fs::canonicalize(root).unwrap()
}

const HOSTILE_GIT_HELPER_VICTIM: &str = "PI_BUG188_HOSTILE_GIT_HELPER_VICTIM";
const HOSTILE_GIT_HELPER_VICTIM_HEAD: &str = "PI_BUG188_HOSTILE_GIT_HELPER_VICTIM_HEAD";
const HOSTILE_GIT_HELPER_VICTIM_TREE: &str = "PI_BUG188_HOSTILE_GIT_HELPER_VICTIM_TREE";
const HOSTILE_GIT_HELPER_VICTIM_BLOB: &str = "PI_BUG188_HOSTILE_GIT_HELPER_VICTIM_BLOB";

fn git_stdout(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn hostile_git_repositories() -> (PathBuf, PathBuf) {
    let victim = repository();
    let attacker = repository();
    fs::write(attacker.join("upstream/source.bin"), b"attacker\0source").unwrap();
    git(&attacker, &["add", "upstream/source.bin"]);
    git(&attacker, &["commit", "--quiet", "-m", "attacker source"]);
    assert_ne!(
        git_stdout(&victim, &["rev-parse", "HEAD"]),
        git_stdout(&attacker, &["rev-parse", "HEAD"]),
        "victim and attacker must have distinct commits"
    );
    assert_ne!(
        git_stdout(&victim, &["rev-parse", "HEAD^{tree}"]),
        git_stdout(&attacker, &["rev-parse", "HEAD^{tree}"]),
        "victim and attacker must have distinct trees"
    );
    assert_ne!(
        fs::read(victim.join("upstream/source.bin")).unwrap(),
        fs::read(attacker.join("upstream/source.bin")).unwrap(),
        "victim and attacker must have distinct source bytes"
    );
    (victim, attacker)
}

fn hostile_git_helper(victim: &Path, attacker: &Path) -> std::process::Output {
    let victim_head = git_stdout(victim, &["rev-parse", "HEAD"]);
    let victim_tree = git_stdout(victim, &["rev-parse", "HEAD^{tree}"]);
    let victim_blob = git_stdout(victim, &["rev-parse", "HEAD:upstream/source.bin"]);
    let hostile_config = attacker.join(".git/hostile-authority.gitconfig");
    fs::write(&hostile_config, "[core]\n\tabbrev = 4\n").unwrap();
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "hostile_git_environment_helper_process",
            "--nocapture",
        ])
        .env(HOSTILE_GIT_HELPER_VICTIM, victim)
        .env(HOSTILE_GIT_HELPER_VICTIM_HEAD, victim_head.trim())
        .env(HOSTILE_GIT_HELPER_VICTIM_TREE, victim_tree.trim())
        .env(HOSTILE_GIT_HELPER_VICTIM_BLOB, victim_blob.trim())
        .env("GIT_DIR", attacker.join(".git"))
        .env("GIT_WORK_TREE", attacker)
        .env("GIT_INDEX_FILE", attacker.join(".git/index"))
        .env("GIT_OBJECT_DIRECTORY", attacker.join(".git/objects"))
        .env(
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            attacker.join(".git/objects"),
        )
        .env("GIT_COMMON_DIR", attacker.join(".git"))
        .env("GIT_CONFIG_SYSTEM", &hostile_config)
        .env("GIT_CONFIG_GLOBAL", &hostile_config)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.abbrev")
        .env("GIT_CONFIG_VALUE_0", "4")
        .env("GIT_CONFIG_PARAMETERS", "'core.abbrev=4'")
        .env("GIT_REPLACE_REF_BASE", "refs/replace")
        .env("GIT_NO_REPLACE_OBJECTS", "0")
        .env("GIT_ATTR_NOSYSTEM", "0")
        .env("GIT_ARBITRARY_HOSTILE_SELECTOR", "must-be-removed")
        .output()
        .unwrap()
}

#[test]
fn hostile_git_environment_helper_process() {
    let Ok(victim) = std::env::var(HOSTILE_GIT_HELPER_VICTIM) else {
        return;
    };
    let victim = fs::canonicalize(victim).unwrap();
    let binding = runner::repository_authority_binding(&victim, "hostile-git-env")
        .expect("authority must ignore hostile Git selectors");
    let expected_head = std::env::var(HOSTILE_GIT_HELPER_VICTIM_HEAD).unwrap();
    let expected_tree = std::env::var(HOSTILE_GIT_HELPER_VICTIM_TREE).unwrap();
    let expected_blob = std::env::var(HOSTILE_GIT_HELPER_VICTIM_BLOB).unwrap();
    assert_eq!(binding.manifest.repo_root, victim.to_str().unwrap());
    assert_eq!(binding.manifest.head_commit, expected_head);
    assert_eq!(binding.manifest.head_tree, expected_tree);
    let source = binding
        .manifest
        .tracked_sources
        .iter()
        .find(|source| source.path == "upstream/source.bin")
        .expect("victim source is tracked")
        .clone();
    assert_eq!(source.mode, "100644");
    assert_eq!(source.blob, expected_blob);
    assert_eq!(
        source.whole_file_anchor,
        format!(
            "git://{}/upstream/source.bin#whole-file",
            binding.manifest.head_commit
        )
    );
    let expected_run_root = victim.join(".pi/autopilot/hostile-git-env");
    assert_eq!(
        Path::new(&binding.path),
        expected_run_root.join("planning/repository-authority.v1.json")
    );
    assert!(Path::new(&binding.path).starts_with(&expected_run_root));

    let replay =
        runner::read_repository_authority_binding(Path::new(&binding.path), &binding.digest)
            .expect("live authority replay must stay in victim");
    assert_eq!(replay, binding);
    let pinned = runner::read_pinned_repository_source_blob(
        &binding,
        &source.path,
        &source.whole_file_anchor,
    )
    .expect("pinned victim source must survive hostile selectors");
    assert_eq!(pinned.mode, "100644");
    assert_eq!(pinned.blob, source.blob);
    assert_eq!(pinned.bytes, b"immutable\0source");
    assert_ne!(pinned.bytes, b"attacker\0source");

    let error = runner::repository_authority(&victim.join("upstream"))
        .expect_err("a subdirectory is not the supplied authority root")
        .to_string();
    assert!(
        error.contains("repository authority supplied root does not match git top-level"),
        "{error}"
    );
    println!(
        "BUG188_GIT_ENV_GREEN root={} head={} tree={} blob={} mode={} binding={} selectors=GIT_DIR,GIT_WORK_TREE,GIT_INDEX_FILE,GIT_OBJECT_DIRECTORY,GIT_ALTERNATE_OBJECT_DIRECTORIES,GIT_CONFIG_SYSTEM,GIT_CONFIG_GLOBAL,GIT_CONFIG_COUNT,GIT_CONFIG_PARAMETERS,GIT_REPLACE_REF_BASE,GIT_ATTR_NOSYSTEM",
        binding.manifest.repo_root,
        binding.manifest.head_commit,
        binding.manifest.head_tree,
        source.blob,
        source.mode,
        binding.path
    );
}

#[test]
fn hostile_git_environment_authority_stays_with_victim_and_replays_pinned_source() {
    let (victim, attacker) = hostile_git_repositories();
    let output = hostile_git_helper(&victim, &attacker);
    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{stdout}");
    assert!(
        output.status.success(),
        "green helper failed: stdout={stdout} stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("BUG188_GIT_ENV_GREEN"),
        "green helper did not report the victim authority result: {stdout}"
    );
    assert!(stdout.contains(&format!("root={}", victim.display())));
}

#[test]
fn repository_authority_requires_exact_root_and_accepts_linked_worktree_root() {
    let root = repository();
    let error = runner::repository_authority(&root.join("upstream"))
        .expect_err("a repository subdirectory must not become authority")
        .to_string();
    assert!(
        error.contains("repository authority supplied root does not match git top-level"),
        "{error}"
    );

    let linked = root.join("linked-worktree");
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--quiet",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let linked = fs::canonicalize(linked).unwrap();
    let manifest = runner::repository_authority(&linked)
        .expect("an exact canonical linked-worktree root remains legitimate");
    assert_eq!(manifest.repo_root, linked.to_str().unwrap());
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn atom_registry(root: &Path) -> (PathBuf, String) {
    let bytes = planning::atom_registry_bytes(
        "bug188",
        "authority",
        vec![Id("producer".into())],
        vec![
            PlanningAtomRegistryAtom {
                id: Id("atom-1".into()),
                producer_assignment_id: Id("producer".into()),
                kind: PlanningAtomKind::Work,
                text: "atom".into(),
                sources: vec![Ref("source".into())],
            },
            PlanningAtomRegistryAtom {
                id: Id("atom-2".into()),
                producer_assignment_id: Id("producer".into()),
                kind: PlanningAtomKind::Work,
                text: "second atom".into(),
                sources: vec![Ref("source".into())],
            },
        ],
    )
    .unwrap();
    let path = root.join(".pi/autopilot/bug188/planning/atoms.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &bytes).unwrap();
    (path, sha(&bytes))
}

fn source_carrier(root: &Path, payload: &str) -> planning::WorkMapV2SourceCarrier {
    source_carrier_named(root, "source-carrier.v1.json", payload)
}

fn source_carrier_named(
    root: &Path,
    name: &str,
    payload: &str,
) -> planning::WorkMapV2SourceCarrier {
    let path = root.join(".pi/autopilot/bug188/planning").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let carrier = serde_json::json!({
        "schema":"autopilot.work_map_v2_source_carrier.v1",
        "boundary":"planning.work-map.v2",
        "result_contract":"planning.work-map.v2",
        "raw_work_map_payload":payload,
    });
    fs::write(&path, serde_json::to_vec(&carrier).unwrap()).unwrap();
    planning::read_work_map_v2_source_carrier(&path).unwrap()
}

fn anchor(authority: &runner::RepositoryAuthorityBinding) -> String {
    authority
        .manifest
        .tracked_sources
        .iter()
        .find(|item| item.path == "upstream/source.bin")
        .unwrap()
        .whole_file_anchor
        .clone()
}

fn command() -> serde_json::Value {
    serde_json::json!({"command":"true","expected":"passes","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"leaves no state"})
}

fn fixture_assignment_id(name: &str) -> Id {
    let stable = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                char::from(byte)
            } else {
                '-'
            }
        })
        .collect::<String>();
    Id(format!("fixture-{stable}"))
}

fn actual_carrier_named(root: &Path, name: &str, payload: &str) -> PathBuf {
    let authority = runner::repository_authority_binding(root, "bug188").unwrap();
    let (atom_path, atom_digest) = atom_registry(root);
    let assignment_id = fixture_assignment_id(name);
    let paths = runner::planning_paths(root, "bug188", &assignment_id);
    let path = paths.carrier_path;
    let spec_path = paths.spec_path;
    let prompt_path = paths.prompt_path;
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::create_dir_all(spec_path.parent().unwrap()).unwrap();
    fs::create_dir_all(prompt_path.parent().unwrap()).unwrap();
    fs::write(&prompt_path, "fixture prompt\n").unwrap();
    let route = TerminalRoute {
        version: "v2".to_owned(),
        profile_id: "planning.work-map.v2:autopilot_submit_synthesis".to_owned(),
        tool_name: ToolName("autopilot_submit_synthesis".to_owned()),
        boundary_id: ContractId("planning.work-map.v2".to_owned()),
        result_contract: ContractId("planning.work-map.v2".to_owned()),
        schema_digest: ContractDigest(
            "07750be5a58112e8b3f956f261d33ef75e3a71b9b13b75be2192cfc43adbbc9a".to_owned(),
        ),
    };
    let spec = AgentRunSpec {
        schema: SchemaId("autopilot.agent_run_spec.v4".to_owned()),
        assignment_kind: ValidationAssignmentKind::PlanningReview,
        action_id: Id(format!("test-action-{}", assignment_id.0)),
        assignment_id: assignment_id.clone(),
        run_id: Id("test-run".to_owned()),
        run_revision: 1,
        workstream: Id("bug188".to_owned()),
        role_id: Id("plan-synthesizer".to_owned()),
        mode: kernel::generated::ModeId("initial-plan".to_owned()),
        provider: "fixture".to_owned(),
        model: "fixture".to_owned(),
        thinking: ThinkingLevel("low".to_owned()),
        route: "fixture".to_owned(),
        cwd: ContractPath(root.display().to_string()),
        allowed_tools: vec![ToolName(route.tool_name.0.clone())],
        spec_path: ContractPath(spec_path.display().to_string()),
        prompt_path: ContractPath(prompt_path.display().to_string()),
        prompt_digest: ContractDigest("a".repeat(64)),
        boundary_id: ContractId("planning.work-map.v2".to_owned()),
        boundary_digest: ContractDigest("b".repeat(64)),
        result_contract: ContractId("planning.work-map.v2".to_owned()),
        result_contract_digest: ContractDigest("c".repeat(64)),
        carrier_path: ContractPath(path.display().to_string()),
        session_id: Id("test-session".to_owned()),
        session_dir: ContractPath(
            root.join(".pi/autopilot/bug188/sessions")
                .display()
                .to_string(),
        ),
        session_continuity: SessionContinuity::Fresh,
        settings_digest: ContractDigest("d".repeat(64)),
        context_digest: ContractDigest("e".repeat(64)),
        skills_digest: ContractDigest("f".repeat(64)),
        subscription_digest: ContractDigest("0".repeat(64)),
        lane_id: None,
        attempt: None,
        base_commit: None,
        worktree: None,
        required_focused_evidence: None,
        authority_set_id: None,
        authority_documents: None,
        context_document: None,
        context_documents: None,
        assignment_path: None,
        assignment_digest: None,
        context_manifest_path: None,
        context_manifest_digest: None,
        runtime_extension_path: Some(ContractPath(
            root.join(".pi/autopilot/bug188/runtime-addon.js")
                .display()
                .to_string(),
        )),
        runtime_extension_digest: Some(ContractDigest(
            kernel::generated::CHILD_ADDON_DIGEST.to_owned(),
        )),
        terminal_profile_id: Some(route.profile_id.clone()),
        terminal_route: Some(route.clone()),
        unavailable_tools: None,
        producer_assignment_ids: None,
        validation_id: None,
        validation_attempt: None,
        semantic_round: None,
        model_submission_path: None,
        atom_id_prefix: None,
        atom_registry_path: Some(ContractPath(atom_path.display().to_string())),
        atom_registry_digest: Some(ContractDigest(atom_digest.clone())),

        planning_inputs_path: None,
        planning_inputs_digest: None,
        repository_manifest_path: Some(ContractPath(authority.path.clone())),
        repository_manifest_digest: Some(ContractDigest(authority.digest.clone())),

        repository_head_commit: Some(kernel::generated::Sha(
            authority.manifest.head_commit.clone(),
        )),
        repository_head_tree: Some(kernel::generated::Sha(authority.manifest.head_tree.clone())),
    };
    let spec_bytes = serde_json::to_vec(&spec).unwrap();
    fs::write(&spec_path, &spec_bytes).unwrap();
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v2",
        "action_id":spec.action_id.0,"assignment_id":assignment_id.0,"run_revision":1,
        "workstream":"bug188","role_id":"plan-synthesizer","mode":"initial-plan",
        "boundary_id":"planning.work-map.v2","result_contract":"planning.work-map.v2",
        "prompt_path":prompt_path,"prompt_digest":"a".repeat(64),
        "boundary_digest":"b".repeat(64),"result_contract_digest":"c".repeat(64),
        "settings_digest":"d".repeat(64),"context_digest":"e".repeat(64),
        "skills_digest":"f".repeat(64),"subscription_digest":"0".repeat(64),
        "runtime_extension_digest":kernel::generated::CHILD_ADDON_DIGEST,"spec_digest":sha(&spec_bytes),
        "spec_path":spec_path,"carrier_path":path,"carrier_channel":"tool",
        "tool_name":route.tool_name.0.clone(),"tool_schema_digest":route.schema_digest.0.clone(),
        "carrier_binding":runner::child::carrier_binding(&spec),
        "pi_version":"pi test-only 0.84.1",
        "terminal_route":route.clone(),
        "atom_registry_path":atom_path,"atom_registry_digest":atom_digest,
        "repository_manifest_path":authority.path,"repository_manifest_digest":authority.digest,
        "repository_head_commit":authority.manifest.head_commit,"repository_head_tree":authority.manifest.head_tree,
        "raw_output":payload,
    });
    fs::write(&path, serde_json::to_vec(&carrier).unwrap()).unwrap();
    path
}

fn admit(root: &Path, raw: &str) -> Result<drivers::planning::ApprovedWorkMapV2, String> {
    let authority = runner::repository_authority_binding(root, "bug188").unwrap();
    let (atom_path, atom_digest) = atom_registry(root);
    let carrier = actual_carrier_named(root, "actual-carrier.v2.json", raw);
    planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atom_path,
            atom_registry_digest: &atom_digest,
            repository_authority: &authority,
            recovery_subject: None,
        },
    )
}

fn admit_with_subject(
    root: &Path,
    raw: &str,
    carrier_name: &str,
    subject: Option<&drivers::planning::ApprovedWorkMapV2>,
) -> Result<drivers::planning::ApprovedWorkMapV2, String> {
    let authority = runner::repository_authority_binding(root, "bug188").unwrap();
    let (atom_path, atom_digest) = atom_registry(root);
    let carrier = actual_carrier_named(root, carrier_name, raw);
    planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atom_path,
            atom_registry_digest: &atom_digest,
            repository_authority: &authority,
            recovery_subject: subject,
        },
    )
}

fn simple(id: &str) -> String {
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":id,"kind":"implementation","objective":"exact authority","criteria":["criterion"],
        "depends_on":[],"files":["src/a.rs"],"package_scope_files":[],"commands":[command()],
        "package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]
    }]}).to_string()
}

fn closure(root: &Path) -> String {
    let authority = runner::repository_authority_binding(root, "bug188-closure").unwrap();
    let origin_anchor = anchor(&authority);
    serde_json::json!({"schema":"planning.work-map.v2","units":[
      {"id":"owner-a","kind":"implementation","objective":"owner a","criteria":["a"],"depends_on":[],"files":["src/a.rs"],"package_scope_files":[],"commands":[command()],"package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]},
      {"id":"owner-vendor","kind":"implementation","objective":"owner vendor","criteria":["vendor"],"depends_on":[],"files":["vendor/source.bin","manifests/provenance.json"],"package_scope_files":[],"commands":[command()],"package_proofs":[],"vendor_bindings":[{"binding_id":"binding-source","origin_path":"upstream/source.bin","destination":"vendor/source.bin","origin_anchor":origin_anchor}],"provenance_manifest_destination":"manifests/provenance.json","links":["atom-1"]},
      {"id":"final-closure","kind":"implementation","objective":"final closure","criteria":["clean","vendor"],"depends_on":["owner-a","owner-vendor"],"files":["src/final.rs"],"package_scope_files":["manifests/provenance.json","src/a.rs","src/final.rs","vendor/source.bin"],"commands":[command()],"package_proofs":[{"proof_id":"vendor-proof","kind":"vendored-bytes-match-origin","criterion_ordinals":[2],"expected":"bytes match","vendor_binding_ids":["binding-source"]}],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]}
    ]}).to_string()
}

fn vendor_one(root: &Path) -> String {
    let authority = runner::repository_authority_binding(root, "bug188").unwrap();
    let source = anchor(&authority);
    let executable = authority
        .manifest
        .tracked_sources
        .iter()
        .find(|item| item.path == "upstream/executable.bin")
        .unwrap()
        .whole_file_anchor
        .clone();
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"vendor","kind":"implementation","objective":"copy binary source bytes",
        "criteria":["bytes"],"depends_on":[],
        "files":["vendor/z.bin","vendor/a.bin","manifests/provenance.json"],
        "package_scope_files":["vendor/z.bin","vendor/a.bin","manifests/provenance.json"],
        "commands":[command()],
        "package_proofs":[{"proof_id":"vendor-proof","kind":"vendored-bytes-match-origin","criterion_ordinals":[1],"expected":"bytes","vendor_binding_ids":["binding-z","binding-a"]}],
        "vendor_bindings":[
            {"binding_id":"binding-z","origin_path":"upstream/source.bin","destination":"vendor/z.bin","origin_anchor":source},
            {"binding_id":"binding-a","origin_path":"upstream/executable.bin","destination":"vendor/a.bin","origin_anchor":executable}
        ],"provenance_manifest_destination":"manifests/provenance.json","links":["atom-1"]
    }]}).to_string()
}

fn clean_one() -> String {
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"clean","kind":"implementation","objective":"clean closure",
        "criteria":["clean"],"depends_on":[],"files":["README"],
        "package_scope_files":["README"],"commands":[command()],
        "package_proofs":[{"proof_id":"clean-proof","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"clean","vendor_binding_ids":[]}],
        "vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]
    }]}).to_string()
}

fn persisted(
    root: &Path,
    raw: &str,
    stem: &str,
) -> (seam::ApprovedPlanV2Promotion, PathBuf, PathBuf) {
    let admitted = admit(root, raw).unwrap();
    let image = root.join(format!(".pi/autopilot/bug188/{stem}.json"));
    let binding = root.join(format!(".pi/autopilot/bug188/{stem}-binding.json"));
    let promotion = seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).unwrap();
    (promotion, image, binding)
}

fn vendor_closure_map(root: &Path, sources: &[String]) -> String {
    let authority = runner::repository_authority_binding(root, "bug188").unwrap();
    let mut units = Vec::new();
    let mut owner_ids = Vec::new();
    let mut scope = vec!["src/final.rs".to_owned()];
    let mut proof_ids = Vec::new();
    for (group_index, group) in sources.chunks(64).enumerate() {
        let unit_id = format!("owner-{group_index:03}");
        owner_ids.push(unit_id.clone());
        let manifest = format!("manifests/{group_index:03}.json");
        let mut files = vec![manifest.clone()];
        let mut bindings = Vec::new();
        for (offset, source_path) in group.iter().enumerate() {
            let index = group_index * 64 + offset;
            let destination = format!("vendor/{index:03}.bin");
            let binding_id = format!("binding-{index:03}");
            files.push(destination.clone());
            scope.push(destination.clone());
            proof_ids.push(binding_id.clone());
            let origin_anchor = authority
                .manifest
                .tracked_sources
                .iter()
                .find(|source| source.path == *source_path)
                .unwrap()
                .whole_file_anchor
                .clone();
            bindings.push(serde_json::json!({
                "binding_id":binding_id,"origin_path":source_path,"destination":destination,
                "origin_anchor":origin_anchor
            }));
        }
        scope.push(manifest.clone());
        units.push(serde_json::json!({
            "id":unit_id,"kind":"implementation","objective":"copy immutable bytes",
            "criteria":["bytes"],"depends_on":[],"files":files,"package_scope_files":[],
            "commands":[command()],"package_proofs":[],"vendor_bindings":bindings,
            "provenance_manifest_destination":manifest,"links":["atom-1"]
        }));
    }
    units.push(serde_json::json!({
        "id":"final","kind":"implementation","objective":"prove global vendoring closure",
        "criteria":["vendor proof"],"depends_on":owner_ids,"files":["src/final.rs"],
        "package_scope_files":scope,"commands":[command()],
        "package_proofs":[{"proof_id":"vendor-proof","kind":"vendored-bytes-match-origin","criterion_ordinals":[1],"expected":"all bytes","vendor_binding_ids":proof_ids}],
        "vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]
    }));
    serde_json::json!({"schema":"planning.work-map.v2","units":units}).to_string()
}

fn proof_rows(count: usize, offset: usize) -> Vec<serde_json::Value> {
    (0..count)
        .map(|index| {
            serde_json::json!({
                "proof_id":format!("proof-{:03}", offset + index),"kind":"clean-exact-package-tip",
                "criterion_ordinals":[1],"expected":"clean","vendor_binding_ids":[]
            })
        })
        .collect()
}

fn proof_map(count: usize) -> String {
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"proof-final","kind":"implementation","objective":"prove clean closure",
        "criteria":["clean"],"depends_on":[],"files":["README"],"package_scope_files":["README"],
        "commands":[command()],"package_proofs":proof_rows(count, 0),"vendor_bindings":[],
        "provenance_manifest_destination":null,"links":["atom-1"]
    }]})
    .to_string()
}

fn split_proof_map(first: usize, second: usize) -> String {
    serde_json::json!({"schema":"planning.work-map.v2","units":[
        {"id":"proof-owner","kind":"implementation","objective":"owner","criteria":["clean"],"depends_on":[],"files":["src/owner.rs"],"package_scope_files":[],"commands":[command()],"package_proofs":proof_rows(first, 0),"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]},
        {"id":"proof-final","kind":"implementation","objective":"final","criteria":["clean"],"depends_on":["proof-owner"],"files":["README"],"package_scope_files":["README","src/owner.rs"],"commands":[command()],"package_proofs":proof_rows(second, first),"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]}
    ]}).to_string()
}

#[test]
fn green_two_owners_one_final_closure_and_core_dest_is_read_only_to_children() {
    let root = repository();
    assert!(admit(&root, &closure(&root)).is_ok());
}

#[test]
fn closure_rules_reject_incomplete_duplicate_two_and_nontransitive_closure() {
    let root = repository();
    let base: serde_json::Value = serde_json::from_str(&closure(&root)).unwrap();
    let mut incomplete = base.clone();
    incomplete["units"][2]["package_scope_files"] = serde_json::json!(["src/a.rs"]);
    assert!(
        admit(&root, &incomplete.to_string())
            .unwrap_err()
            .contains("closure package scope")
    );
    let mut duplicate = base.clone();
    duplicate["units"][1]["package_scope_files"] = serde_json::json!(["src/a.rs"]);
    assert!(admit(&root, &duplicate.to_string()).is_err());
    let mut two = base.clone();
    two["units"][0]["package_proofs"] = serde_json::json!([{"proof_id":"clean-proof","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"clean","vendor_binding_ids":[]}]);
    assert!(admit(&root, &two.to_string()).is_err());
    let mut nontransitive = base;
    nontransitive["units"][2]["depends_on"] = serde_json::json!(["owner-a"]);
    assert!(
        admit(&root, &nontransitive.to_string())
            .unwrap_err()
            .contains("does not transitively")
    );
}

#[test]
fn raw_admission_rejects_nonimplementation_derived_unsafe_ids_controls_and_origin_collisions() {
    let root = repository();
    let mut nonimplementation: serde_json::Value = serde_json::from_str(&simple("one")).unwrap();
    nonimplementation["units"][0]["kind"] = serde_json::json!("verification");
    assert!(admit(&root, &nonimplementation.to_string()).is_err());
    assert!(admit(&root, &simple(&"u".repeat(242))).is_ok());
    assert!(admit(&root, &simple(&"u".repeat(243))).is_err());
    let mut control: serde_json::Value = serde_json::from_str(&simple("one")).unwrap();
    control["units"][0]["files"] = serde_json::json!(["src/\u{0001}a.rs"]);
    assert!(admit(&root, &control.to_string()).is_err());
    let mut origin: serde_json::Value = serde_json::from_str(&closure(&root)).unwrap();
    origin["units"][2]["files"] = serde_json::json!(["upstream/source.bin"]);
    origin["units"][2]["package_scope_files"] = serde_json::json!([
        "manifests/provenance.json",
        "src/a.rs",
        "upstream/source.bin",
        "vendor/source.bin"
    ]);
    assert!(
        admit(&root, &origin.to_string())
            .unwrap_err()
            .contains("immutable origin")
    );
}

#[test]
fn source_carrier_budget_is_raw_not_json_escape_budget() {
    let root = repository();
    let path = root.join(".pi/autopilot/bug188/planning/escaped-carrier.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let exact_payload = "\\".repeat(kernel::generated::WORK_MAP_V2_MAX_BYTES);
    let exact = serde_json::json!({
        "schema":"autopilot.work_map_v2_source_carrier.v1",
        "boundary":"planning.work-map.v2",
        "result_contract":"planning.work-map.v2",
        "raw_work_map_payload": exact_payload,
    });
    fs::write(&path, serde_json::to_vec(&exact).unwrap()).unwrap();
    assert!(planning::read_work_map_v2_source_carrier(&path).is_ok());

    let plus_one = serde_json::json!({
        "schema":"autopilot.work_map_v2_source_carrier.v1",
        "boundary":"planning.work-map.v2",
        "result_contract":"planning.work-map.v2",
        "raw_work_map_payload": "\\".repeat(kernel::generated::WORK_MAP_V2_MAX_BYTES + 1),
    });
    fs::write(&path, serde_json::to_vec(&plus_one).unwrap()).unwrap();
    assert!(planning::read_work_map_v2_source_carrier(&path).is_err());
}

#[test]
fn durable_binding_replays_source_and_rejects_recanonicalized_tampering() {
    let root = repository();
    let raw = closure(&root);
    let admitted = admit(&root, &raw).unwrap();
    let image = root.join(".pi/autopilot/bug188/approved-v2.json");
    let binding = root.join(".pi/autopilot/bug188/approved-v2-binding.json");
    let promotion = seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).unwrap();
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &promotion.binding_sha256)
            .unwrap()
            .units
            .len(),
        3
    );
    let image_bytes = fs::read(&image).unwrap();
    let mut image_value: serde_json::Value = serde_json::from_slice(&image_bytes).unwrap();
    image_value["units"][0]["objective"] = serde_json::json!("reserialized image tamper");
    fs::write(&image, serde_json::to_vec(&image_value).unwrap()).unwrap();
    assert!(seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).is_err());
    fs::write(&image, image_bytes).unwrap();
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    value["workstream"] = serde_json::json!("tampered");
    fs::write(&binding, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).is_err());
}

#[test]
fn binary_sources_modes_raw_hashes_and_core_canonical_binding_order() {
    let root = repository();
    let raw = vendor_one(&root);
    let (promotion, _, binding) = persisted(&root, &raw, "binary-approved");
    let artifact = seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).unwrap();
    let row = &artifact.vendoring[0];
    assert_eq!(row.vendor_bindings.len(), 2);
    assert_eq!(row.vendor_bindings[0].binding_id.0, "binding-a");
    assert_eq!(row.vendor_bindings[0].origin_mode, "100755");
    assert_eq!(
        row.vendor_bindings[0].origin_bytes_sha256,
        sha(b"exec\0source\x01")
    );
    assert_eq!(row.vendor_bindings[1].binding_id.0, "binding-z");
    assert_eq!(row.vendor_bindings[1].origin_mode, "100644");
    assert_eq!(
        row.vendor_bindings[1].origin_bytes_sha256,
        sha(b"immutable\0source")
    );
    assert!(
        row.vendor_bindings
            .iter()
            .all(|binding| binding.origin_git_blob_oid.len() == 40)
    );
    assert_eq!(
        artifact.package_authority[0].package_scope_files[0].0,
        "manifests/provenance.json"
    );
    assert_eq!(
        artifact.package_authority[0].package_proofs[0].vendor_binding_ids[0].0,
        "binding-a"
    );
}

#[test]
fn source_blob_two_mebibytes_exact_and_plus_one_are_bounded() {
    let root = repository();
    fs::write(
        root.join("upstream/source.bin"),
        vec![b'x'; runner::MAX_AUTHORITY_SOURCE_BYTES],
    )
    .unwrap();
    git(&root, &["add", "upstream/source.bin"]);
    git(&root, &["commit", "--quiet", "-m", "two mebibytes"]);
    let authority = runner::repository_authority_binding(&root, "blob-exact").unwrap();
    let source = authority
        .manifest
        .tracked_sources
        .iter()
        .find(|source| source.path == "upstream/source.bin")
        .unwrap();
    assert_eq!(
        runner::read_pinned_repository_source_blob(
            &authority,
            &source.path,
            &source.whole_file_anchor
        )
        .unwrap()
        .bytes
        .len(),
        runner::MAX_AUTHORITY_SOURCE_BYTES
    );
    fs::write(
        root.join("upstream/source.bin"),
        vec![b'x'; runner::MAX_AUTHORITY_SOURCE_BYTES + 1],
    )
    .unwrap();
    git(&root, &["add", "upstream/source.bin"]);
    git(
        &root,
        &["commit", "--quiet", "-m", "two mebibytes plus one"],
    );
    let authority = runner::repository_authority_binding(&root, "blob-plus-one").unwrap();
    let source = authority
        .manifest
        .tracked_sources
        .iter()
        .find(|source| source.path == "upstream/source.bin")
        .unwrap();
    assert!(
        runner::read_pinned_repository_source_blob(
            &authority,
            &source.path,
            &source.whole_file_anchor
        )
        .is_err()
    );
}

#[test]
fn aggregate_sources_sixty_four_mebibytes_exact_and_plus_one_cross_units() {
    let root = repository();
    fs::write(
        root.join("upstream/source.bin"),
        vec![b'y'; runner::MAX_AUTHORITY_SOURCE_BYTES],
    )
    .unwrap();
    fs::write(root.join("upstream/one.bin"), b"z").unwrap();
    git(&root, &["add", "upstream"]);
    git(&root, &["commit", "--quiet", "-m", "aggregate objects"]);
    let exact = vendor_closure_map(&root, &vec!["upstream/source.bin".to_owned(); 32]);
    assert!(admit(&root, &exact).is_ok());
    let mut plus = vec!["upstream/source.bin".to_owned(); 32];
    plus.push("upstream/one.bin".to_owned());
    assert!(
        admit(&root, &vendor_closure_map(&root, &plus))
            .unwrap_err()
            .contains("vendored source bytes exceed")
    );
}

#[test]
fn global_binding_limit_is_checked_across_owner_rows() {
    let root = repository();
    fs::write(root.join("upstream/one.bin"), b"z").unwrap();
    git(&root, &["add", "upstream/one.bin"]);
    git(&root, &["commit", "--quiet", "-m", "one byte"]);
    assert!(
        admit(
            &root,
            &vendor_closure_map(&root, &vec!["upstream/one.bin".to_owned(); 128])
        )
        .is_ok()
    );
    let mut plus: serde_json::Value = serde_json::from_str(&vendor_closure_map(
        &root,
        &vec!["upstream/one.bin".to_owned(); 129],
    ))
    .unwrap();
    // Omit the proof only in the +1 specimen so the aggregate binding gate,
    // rather than the proof's own 128-id field bound, is the reached branch.
    plus["units"].as_array_mut().unwrap().last_mut().unwrap()["package_proofs"] =
        serde_json::json!([]);
    let error = admit(&root, &plus.to_string()).unwrap_err();
    assert!(
        error.contains("total vendor bindings exceeds 128"),
        "{error}"
    );
}

#[test]
fn global_proof_limit_exact_and_plus_one_are_checked() {
    let root = repository();
    assert!(admit(&root, &proof_map(256)).is_ok());
    let exact_split = admit(&root, &split_proof_map(128, 128)).unwrap_err();
    assert!(
        !exact_split.contains("total package proofs exceeds 256"),
        "{exact_split}"
    );
    let plus_one = admit(&root, &split_proof_map(129, 128)).unwrap_err();
    assert!(
        plus_one.contains("total package proofs exceeds 256"),
        "{plus_one}"
    );
}

#[test]
fn required_unknown_null_schema_id_path_and_control_cases_reject() {
    let root = repository();
    let base: serde_json::Value = serde_json::from_str(&clean_one()).unwrap();
    for pointer in [
        "/schema",
        "/units/0/package_scope_files",
        "/units/0/provenance_manifest_destination",
    ] {
        let mut candidate = base.clone();
        let key = pointer.rsplit('/').next().unwrap();
        candidate
            .pointer_mut(pointer.rsplit_once('/').unwrap().0)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(
            admit(&root, &candidate.to_string()).is_err(),
            "missing {pointer}"
        );
    }
    let mut unknown = base.clone();
    unknown["units"][0]["unknown"] = serde_json::json!(true);
    assert!(admit(&root, &unknown.to_string()).is_err());
    let mut schema = base.clone();
    schema["schema"] = serde_json::json!("planning.work-map.v1");
    assert!(admit(&root, &schema.to_string()).is_err());
    let mut id = base.clone();
    id["units"][0]["id"] = serde_json::json!("\u{0001}");
    assert!(admit(&root, &id.to_string()).is_err());
    let mut path = base;
    path["units"][0]["files"] = serde_json::json!(["../README"]);
    assert!(admit(&root, &path.to_string()).is_err());
}

#[test]
fn clean_vendor_and_both_proof_closures_admit() {
    let root = repository();
    assert!(admit(&root, &clean_one()).is_ok());
    assert!(admit(&root, &vendor_one(&root)).is_ok());
    let mut both: serde_json::Value = serde_json::from_str(&vendor_one(&root)).unwrap();
    both["units"][0]["criteria"] = serde_json::json!(["clean", "vendor"]);
    both["units"][0]["package_proofs"] = serde_json::json!([
        {"proof_id":"clean-proof","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"clean","vendor_binding_ids":[]},
        {"proof_id":"vendor-proof","kind":"vendored-bytes-match-origin","criterion_ordinals":[2],"expected":"bytes","vendor_binding_ids":["binding-a","binding-z"]}
    ]);
    assert!(admit(&root, &both.to_string()).is_ok());
}

#[test]
fn generated_and_core_topology_equal_and_ancestor_contradictions_reject() {
    let root = repository();
    let base: serde_json::Value = serde_json::from_str(&vendor_one(&root)).unwrap();
    for generated in ["vendor", "vendor/a.bin", "vendor/a.bin/generated"] {
        let mut candidate = base.clone();
        candidate["units"][0]["commands"][0] = serde_json::json!({"command":"true","expected":"passes","effect":"declared-predictable","generated_paths":[generated],"handling":"block-if-created","scope_preservation":"clean"});
        assert!(
            admit(&root, &candidate.to_string()).is_err(),
            "generated {generated}"
        );
    }
    let mut collision = base;
    collision["units"][0]["vendor_bindings"][0]["destination"] =
        serde_json::json!("upstream/source.bin");
    collision["units"][0]["files"] = serde_json::json!([
        "upstream/source.bin",
        "vendor/a.bin",
        "manifests/provenance.json"
    ]);
    collision["units"][0]["package_scope_files"] = collision["units"][0]["files"].clone();
    assert!(admit(&root, &collision.to_string()).is_err());
}

#[test]
fn authenticated_recovery_allows_objective_only_repaired_and_no_defect() {
    let root = repository();
    let original_raw = vendor_one(&root);
    let original = admit(&root, &original_raw).unwrap();
    let mut repaired: serde_json::Value = serde_json::from_str(&original_raw).unwrap();
    repaired["recovery"] = serde_json::json!({"disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"objective","affected_unit_ids":["vendor"],"actions":["repair objective"],"preserved_authority":["all non-objective fields"],"repair_evidence_refs":["evidence:1"]});
    repaired["units"][0]["objective"] =
        serde_json::json!("copy immutable binary source bytes exactly");
    assert!(
        admit_with_subject(
            &root,
            &repaired.to_string(),
            "repaired-carrier.json",
            Some(&original)
        )
        .is_ok()
    );
    let mut no_defect: serde_json::Value = serde_json::from_str(&original_raw).unwrap();
    no_defect["recovery"] = serde_json::json!({"disposition":"no-defect","diagnosis_refs":["review:1"],"root_cause":"no defect","affected_unit_ids":[],"actions":["replay"],"preserved_authority":["all authority"],"repair_evidence_refs":["evidence:1"]});
    assert!(
        admit_with_subject(
            &root,
            &no_defect.to_string(),
            "no-defect-carrier.json",
            Some(&original)
        )
        .is_ok()
    );
}

#[test]
fn recovery_rejects_every_nonobjective_mutation_and_unsealed_subjects() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_str(&raw).unwrap();
    candidate["recovery"] = serde_json::json!({"disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"objective","affected_unit_ids":["vendor"],"actions":["repair"],"preserved_authority":["authority"],"repair_evidence_refs":["evidence:1"]});
    candidate["units"][0]["objective"] = serde_json::json!("objective changed");
    for (field, value) in [
        ("criteria", serde_json::json!(["changed"])),
        ("links", serde_json::json!(["changed-atom"])),
    ] {
        let mut changed = candidate.clone();
        changed["units"][0][field] = value;
        assert!(
            admit_with_subject(
                &root,
                &changed.to_string(),
                "recovery-mutation.json",
                Some(&original)
            )
            .is_err()
        );
    }
    let recovered = admit_with_subject(
        &root,
        &candidate.to_string(),
        "recovery-good.json",
        Some(&original),
    )
    .unwrap();
    assert!(
        admit_with_subject(
            &root,
            &candidate.to_string(),
            "recovery-recursive.json",
            Some(&recovered)
        )
        .is_err()
    );
}

#[test]
fn recovered_binding_replays_subject_and_rejects_subject_tampering() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_str(&raw).unwrap();
    candidate["recovery"] = serde_json::json!({"disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"objective","affected_unit_ids":["vendor"],"actions":["repair"],"preserved_authority":["authority"],"repair_evidence_refs":["evidence:1"]});
    candidate["units"][0]["objective"] = serde_json::json!("objective changed");
    let recovered = admit_with_subject(
        &root,
        &candidate.to_string(),
        "recovery-output.json",
        Some(&original),
    )
    .unwrap();
    let image = root.join(".pi/autopilot/bug188/recovered.json");
    let binding = root.join(".pi/autopilot/bug188/recovered-binding.json");
    let promotion = seam::write_approved_plan_v2("bug188", &image, &binding, &recovered).unwrap();
    assert!(seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).is_ok());
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    assert!(value["recovery_subject"].is_object());
    fs::write(actual_carrier_path(&root), b"tampered").unwrap();
    assert!(seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).is_err());
}

#[test]
fn repository_authority_rejects_live_drift_symlink_and_gitlink() {
    let drift = repository();
    let authority = runner::repository_authority_binding(&drift, "drift").unwrap();
    fs::write(drift.join("upstream/source.bin"), b"drift").unwrap();
    assert!(
        runner::read_repository_authority_binding(Path::new(&authority.path), &authority.digest)
            .is_err()
    );
    #[cfg(unix)]
    {
        let symlink = repository();
        std::os::unix::fs::symlink("source.bin", symlink.join("upstream/link")).unwrap();
        git(&symlink, &["add", "upstream/link"]);
        git(&symlink, &["commit", "--quiet", "-m", "symlink"]);
        assert!(runner::repository_authority(&symlink).is_err());
    }
    let gitlink = repository();
    let nested = gitlink.join("nested");
    fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "--quiet"]);
    git(&nested, &["config", "user.email", "v2@example.invalid"]);
    git(&nested, &["config", "user.name", "V2"]);
    fs::write(nested.join("x"), b"x").unwrap();
    git(&nested, &["add", "."]);
    git(&nested, &["commit", "--quiet", "-m", "nested"]);
    let head = Command::new("git")
        .current_dir(&nested)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let head = String::from_utf8(head.stdout).unwrap();
    git(
        &gitlink,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            head.trim(),
            "upstream/submodule",
        ],
    );
    git(&gitlink, &["commit", "--quiet", "-m", "gitlink"]);
    assert!(runner::repository_authority(&gitlink).is_err());
}

#[test]
fn pinned_source_ignores_replace_refs_and_reaches_tree_row_check() {
    let root = repository();
    let mut authority = runner::repository_authority_binding(&root, "replace").unwrap();
    let source = authority
        .manifest
        .tracked_sources
        .iter()
        .find(|row| row.path == "upstream/source.bin")
        .unwrap()
        .clone();
    fs::write(root.join("replacement"), b"attacker").unwrap();
    let replacement = Command::new("git")
        .current_dir(&root)
        .args(["hash-object", "-w", "replacement"])
        .output()
        .unwrap();
    let replacement = String::from_utf8(replacement.stdout).unwrap();
    fs::remove_file(root.join("replacement")).unwrap();
    git(&root, &["replace", &source.blob, replacement.trim()]);
    assert_eq!(
        runner::read_pinned_repository_source_blob(
            &authority,
            &source.path,
            &source.whole_file_anchor
        )
        .unwrap()
        .bytes,
        b"immutable\0source"
    );
    let other = authority
        .manifest
        .tracked_sources
        .iter()
        .find(|row| row.path == "upstream/executable.bin")
        .unwrap()
        .blob
        .clone();
    authority
        .manifest
        .tracked_sources
        .iter_mut()
        .find(|row| row.path == "upstream/source.bin")
        .unwrap()
        .blob = other;
    let bytes = serde_json::to_vec_pretty(&authority.manifest).unwrap();
    fs::write(&authority.path, &bytes).unwrap();
    authority.digest = sha(&bytes);
    assert!(
        runner::read_pinned_repository_source_blob(
            &authority,
            &source.path,
            &source.whole_file_anchor
        )
        .unwrap_err()
        .to_string()
        .contains("pinned tree row drift")
    );
}

#[test]
fn capability_rooted_files_reject_symlinks_and_create_once_reuses_only_exact_bytes() {
    let root = repository();
    #[cfg(unix)]
    {
        let alias = root.join(".pi/autopilot/bug188/planning/alias.json");
        let target = root.join(".pi/autopilot/bug188/planning/target.json");
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        fs::write(&target, b"x").unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        assert!(planning::read_work_map_v2_source_carrier(&alias).is_err());
    }
    let raw = vendor_one(&root);
    let admitted = admit(&root, &raw).unwrap();
    let image = root.join(".pi/autopilot/bug188/reuse.json");
    let binding = root.join(".pi/autopilot/bug188/reuse-binding.json");
    assert!(seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).is_ok());
    assert!(seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).is_ok());
    let other = admit(&root, &clean_one()).unwrap();
    assert!(seam::write_approved_plan_v2("bug188", &image, &binding, &other).is_err());
}

#[cfg(unix)]
fn replace_with_symlink(path: &Path, target_suffix: &str) {
    let target = path.with_file_name(format!(
        "{}-{target_suffix}",
        path.file_name().unwrap().to_string_lossy()
    ));
    fs::rename(path, &target).unwrap();
    std::os::unix::fs::symlink(&target, path).unwrap();
}

#[cfg(unix)]
fn assert_no_follow(error: String) {
    assert!(
        error.contains("authority read refused symlink/no-follow final component")
            || error.contains("authority path component refused symlink/no-follow traversal"),
        "expected capability no-follow rejection, got: {error}"
    );
}

#[cfg(unix)]
#[test]
fn unix_final_symlink_matrix_reaches_each_v2_authority_consumer() {
    for consumer in [
        "binding",
        "approved image",
        "repository manifest",
        "source carrier",
        "atom registry",
    ] {
        let root = repository();
        let (promotion, image, binding) = persisted(&root, &vendor_one(&root), "symlink-final");
        let path = match consumer {
            "binding" => binding.clone(),
            "approved image" => image,
            "repository manifest" => PathBuf::from(
                runner::repository_authority_binding(&root, "bug188")
                    .unwrap()
                    .path,
            ),
            "source carrier" => actual_carrier_path(&root),
            "atom registry" => root.join(".pi/autopilot/bug188/planning/atoms.json"),
            _ => unreachable!(),
        };
        replace_with_symlink(&path, "symlink-target");
        assert_no_follow(
            seam::read_approved_plan_v2(&binding, &promotion.binding_sha256)
                .unwrap_err()
                .to_string(),
        );
    }
}

#[cfg(unix)]
#[test]
fn unix_parent_symlink_matrix_reaches_source_atom_binding_image_and_manifest_consumers() {
    // The source and atom readers can be isolated before repository enrichment:
    // retain the source carrier descriptor, then replace its parent directory.
    let root = repository();
    let authority = runner::repository_authority_binding(&root, "bug188").unwrap();
    let (atom_path, atom_digest) = atom_registry(&root);
    let raw = vendor_one(&root);
    let carrier = source_carrier(&root, &raw);
    let planning = root.join(".pi/autopilot/bug188/planning");
    replace_with_symlink(&planning, "source-atom-parent-target");
    assert_no_follow(planning::read_work_map_v2_source_carrier(&carrier_path(&root)).unwrap_err());
    assert_no_follow(
        planning::admit_work_map_v2(
            raw.as_bytes(),
            &carrier,
            WorkMapV2AdmissionContext {
                atom_registry_path: &atom_path,
                atom_registry_digest: &atom_digest,
                repository_authority: &authority,
                recovery_subject: None,
            },
        )
        .unwrap_err(),
    );

    for consumer in ["binding", "approved image"] {
        let root = repository();
        let admitted = admit(&root, &vendor_one(&root)).unwrap();
        let image = root.join(".pi/autopilot/bug188/images/image.json");
        let binding = root.join(".pi/autopilot/bug188/bindings/binding.json");
        let promotion =
            seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).unwrap();
        let parent = match consumer {
            "binding" => binding.parent().unwrap(),
            "approved image" => image.parent().unwrap(),
            _ => unreachable!(),
        };
        replace_with_symlink(parent, "authority-parent-target");
        assert_no_follow(
            seam::read_approved_plan_v2(&binding, &promotion.binding_sha256)
                .unwrap_err()
                .to_string(),
        );
    }

    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "manifest-parent");
    replace_with_symlink(
        &root.join(".pi/autopilot/bug188/planning"),
        "manifest-parent-target",
    );
    assert_no_follow(
        seam::read_approved_plan_v2(&binding, &promotion.binding_sha256)
            .unwrap_err()
            .to_string(),
    );
}

fn carrier_path(root: &Path) -> PathBuf {
    // This lexical path deliberately crosses the replaced parent in the test
    // above; source carrier parsing must reject it before JSON/digest work.
    root.join(".pi/autopilot/bug188/planning/source-carrier.v1.json")
}

fn actual_carrier_path(root: &Path) -> PathBuf {
    runner::planning_paths(
        root,
        "bug188",
        &fixture_assignment_id("actual-carrier.v2.json"),
    )
    .carrier_path
}

fn recovered_subject_fixture(label: &str) -> (PathBuf, PathBuf, String, PathBuf) {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_str(&raw).unwrap();
    candidate["recovery"] = serde_json::json!({
        "disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"objective",
        "affected_unit_ids":["vendor"],"actions":["repair"],"preserved_authority":["all"],
        "repair_evidence_refs":["evidence:1"]
    });
    candidate["units"][0]["objective"] = serde_json::json!("recovered objective");
    let recovered = admit_with_subject(
        &root,
        &candidate.to_string(),
        "recovered-subject-primary.json",
        Some(&original),
    )
    .unwrap();
    let image = root.join(format!(".pi/autopilot/bug188/{label}-image.json"));
    let binding = root.join(format!(".pi/autopilot/bug188/{label}-binding.json"));
    seam::write_approved_plan_v2("bug188", &image, &binding, &recovered).unwrap();

    let binding_digest = sha(&fs::read(&binding).unwrap());
    let subject = actual_carrier_path(&root);
    (root, binding, binding_digest, subject)
}

#[cfg(unix)]
#[test]
fn unix_recovery_subject_carrier_final_and_parent_symlinks_reach_replay_consumer() {
    for parent_link in [false, true] {
        let (root, binding, digest, subject) = recovered_subject_fixture(if parent_link {
            "recovery-subject-parent"
        } else {
            "recovery-subject-final"
        });
        if parent_link {
            replace_with_symlink(subject.parent().unwrap(), "recovery-subject-parent-target");
        } else {
            replace_with_symlink(&subject, "recovery-subject-final-target");
        }
        assert_no_follow(
            seam::read_approved_plan_v2(&binding, &digest)
                .unwrap_err()
                .to_string(),
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn workstream_is_one_safe_component_and_paths_cannot_cross_runs() {
    let root = repository();
    for unsafe_workstream in ["", ".", "..", "a/b", "a\\b", "a\n", " space"] {
        assert!(runner::repository_authority_binding(&root, unsafe_workstream).is_err());
    }
    assert!(runner::repository_authority_binding(&root, "safe._-9").is_ok());
    let raw = vendor_one(&root);
    let admitted = admit(&root, &raw).unwrap();
    let image = root.join(".pi/autopilot/other/image.json");
    let binding = root.join(".pi/autopilot/other/binding.json");
    assert!(seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).is_err());
}

#[test]
fn raw_one_mebibyte_valid_json_and_one_byte_overreach_are_distinguished() {
    let root = repository();
    let raw = format!(
        "{}{}",
        simple("one"),
        " ".repeat(kernel::generated::WORK_MAP_V2_MAX_BYTES - simple("one").len())
    );
    assert_eq!(raw.len(), kernel::generated::WORK_MAP_V2_MAX_BYTES);
    let authority = runner::repository_authority_binding(&root, "bug188").unwrap();
    let (atom_path, atom_digest) = atom_registry(&root);
    let carrier = source_carrier(&root, &raw);
    assert!(
        planning::admit_work_map_v2(
            raw.as_bytes(),
            &carrier,
            WorkMapV2AdmissionContext {
                atom_registry_path: &atom_path,
                atom_registry_digest: &atom_digest,
                repository_authority: &authority,
                recovery_subject: None,
            },
        )
        .is_ok()
    );
    let error = planning::admit_work_map_v2(
        format!("{raw} ").as_bytes(),
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atom_path,
            atom_registry_digest: &atom_digest,
            repository_authority: &authority,
            recovery_subject: None,
        },
    )
    .unwrap_err();
    assert!(error.contains("raw artifact exceeds"), "{error}");
}

#[test]
fn unicode_free_text_survives_source_promotion_and_replay() {
    let root = repository();
    let mut value: serde_json::Value = serde_json::from_str(&clean_one()).unwrap();
    value["units"][0]["objective"] = serde_json::json!("目的は完全な検証です");
    value["units"][0]["criteria"] = serde_json::json!(["基準が満たされる"]);
    value["units"][0]["commands"][0]["command"] = serde_json::json!("真実を検査する");
    value["units"][0]["commands"][0]["expected"] = serde_json::json!("成功する");
    value["units"][0]["commands"][0]["scope_preservation"] = serde_json::json!("状態を保存する");
    value["units"][0]["package_proofs"][0]["expected"] = serde_json::json!("証明は完全です");
    let raw = value.to_string();
    let admitted = admit(&root, &raw).unwrap();
    let image = root.join(".pi/autopilot/bug188/unicode.json");
    let binding = root.join(".pi/autopilot/bug188/unicode-binding.json");
    let promotion = seam::write_approved_plan_v2("bug188", &image, &binding, &admitted).unwrap();
    let replay = seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).unwrap();
    assert_eq!(replay.units[0].objective, "目的は完全な検証です");
    assert_eq!(replay.units[0].criterion_text[0].text, "基準が満たされる");
}

#[test]
fn recovery_blocked_dispositions_admit_unchanged_but_cannot_promote() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    for disposition in [
        "requires-new-authority",
        "infrastructure-blocked",
        "unsafe-blocked",
    ] {
        let mut candidate: serde_json::Value = serde_json::from_str(&raw).unwrap();
        candidate["recovery"] = serde_json::json!({
            "disposition":disposition,"diagnosis_refs":["review:1"],"root_cause":"blocked",
            "affected_unit_ids":[],"actions":["stop"],"preserved_authority":["all"],
            "repair_evidence_refs":["evidence:1"]
        });
        let admitted = admit_with_subject(
            &root,
            &candidate.to_string(),
            &format!("{disposition}.json"),
            Some(&original),
        )
        .unwrap_or_else(|error| panic!("{disposition}: {error}"));
        let error = seam::write_approved_plan_v2(
            "bug188",
            &root.join(format!(".pi/autopilot/bug188/{disposition}.image.json")),
            &root.join(format!(".pi/autopilot/bug188/{disposition}.binding.json")),
            &admitted,
        )
        .unwrap_err();
        assert!(error.contains("blocked recovery disposition"), "{error}");
    }
}

#[test]
fn recovery_repaired_rejects_unchanged_and_blocked_rejects_objective_change() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut repaired: serde_json::Value = serde_json::from_str(&raw).unwrap();
    repaired["recovery"] = serde_json::json!({"disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"x","affected_unit_ids":[],"actions":["x"],"preserved_authority":["all"],"repair_evidence_refs":["evidence:1"]});
    let error = admit_with_subject(
        &root,
        &repaired.to_string(),
        "unchanged-repaired.json",
        Some(&original),
    )
    .unwrap_err();
    assert!(error.contains("disposition does not match"), "{error}");
    let mut blocked = repaired;
    blocked["recovery"]["disposition"] = serde_json::json!("unsafe-blocked");
    blocked["units"][0]["objective"] = serde_json::json!("changed objective");
    let error = admit_with_subject(
        &root,
        &blocked.to_string(),
        "changed-blocked.json",
        Some(&original),
    )
    .unwrap_err();
    assert!(error.contains("disposition does not match"), "{error}");
}

#[test]
fn recovery_comparison_freezes_all_valid_nonobjective_authority_fields() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut base: serde_json::Value = serde_json::from_str(&raw).unwrap();
    base["recovery"] = serde_json::json!({
        "disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"x",
        "affected_unit_ids":["vendor"],"actions":["x"],"preserved_authority":["all"],
        "repair_evidence_refs":["evidence:1"]
    });
    base["units"][0]["objective"] = serde_json::json!("objective changed");
    let mut fields = Vec::<(&str, serde_json::Value)>::new();
    fields.push(("criteria", serde_json::json!(["different criterion"])));
    fields.push((
        "commands",
        serde_json::json!([{
            "command":"true","expected":"different","effect":"no-effect",
            "generated_paths":[],"handling":"none","scope_preservation":"leaves no state"
        }]),
    ));
    fields.push(("package_proofs", serde_json::json!([{
        "proof_id":"vendor-proof","kind":"vendored-bytes-match-origin",
        "criterion_ordinals":[1],"expected":"different bytes","vendor_binding_ids":["binding-a","binding-z"]
    }])));
    fields.push(("links", serde_json::json!(["atom-2"])));
    for (field, value) in fields {
        let mut changed = base.clone();
        changed["units"][0][field] = value;
        assert_eq!(
            admit_with_subject(
                &root,
                &changed.to_string(),
                &format!("recovery-{field}.json"),
                Some(&original),
            )
            .unwrap_err(),
            "recovery changed non-objective V2 authority for unit vendor",
            "field {field}"
        );
    }

    let mut files = base.clone();
    files["units"][0]["files"] =
        serde_json::json!(["vendor/z2.bin", "vendor/a.bin", "manifests/provenance.json"]);
    files["units"][0]["package_scope_files"] = files["units"][0]["files"].clone();
    files["units"][0]["vendor_bindings"][0]["destination"] = serde_json::json!("vendor/z2.bin");
    assert_eq!(
        admit_with_subject(
            &root,
            &files.to_string(),
            "recovery-files.json",
            Some(&original)
        )
        .unwrap_err(),
        "recovery changed non-objective V2 authority for unit vendor"
    );

    let mut scope = base.clone();
    scope["units"][0]["package_scope_files"] =
        serde_json::json!(["vendor/a.bin", "vendor/z.bin", "manifests/provenance.json"]);
    assert_eq!(
        admit_with_subject(
            &root,
            &scope.to_string(),
            "recovery-scope.json",
            Some(&original)
        )
        .unwrap_err(),
        "recovery changed non-objective V2 authority for unit vendor"
    );

    let mut manifest = base.clone();
    manifest["units"][0]["files"] =
        serde_json::json!(["vendor/z.bin", "vendor/a.bin", "manifests/other.json"]);
    manifest["units"][0]["package_scope_files"] = manifest["units"][0]["files"].clone();
    manifest["units"][0]["provenance_manifest_destination"] =
        serde_json::json!("manifests/other.json");
    assert_eq!(
        admit_with_subject(
            &root,
            &manifest.to_string(),
            "recovery-manifest.json",
            Some(&original),
        )
        .unwrap_err(),
        "recovery changed non-objective V2 authority for unit vendor"
    );

    let mut binding = base.clone();
    binding["units"][0]["vendor_bindings"][0]["binding_id"] = serde_json::json!("binding-z2");
    binding["units"][0]["package_proofs"][0]["vendor_binding_ids"] =
        serde_json::json!(["binding-a", "binding-z2"]);
    assert_eq!(
        admit_with_subject(
            &root,
            &binding.to_string(),
            "recovery-binding.json",
            Some(&original),
        )
        .unwrap_err(),
        "recovery changed non-objective V2 authority for unit vendor"
    );

    let mut replaced = base.clone();
    replaced["units"][0]["id"] = serde_json::json!("vendor-replaced");
    assert_eq!(
        admit_with_subject(
            &root,
            &replaced.to_string(),
            "recovery-id.json",
            Some(&original),
        )
        .unwrap_err(),
        "recovery reordered or replaced V2 unit identity"
    );
    let mut kind = base;
    kind["units"][0]["kind"] = serde_json::json!("verification");
    assert_eq!(
        admit_with_subject(
            &root,
            &kind.to_string(),
            "recovery-kind.json",
            Some(&original)
        )
        .unwrap_err(),
        "work-map-v2:strict JSON parse: unknown variant `verification`, expected `implementation` at line 1 column 534"
    );
}

#[test]
fn recovery_identity_count_and_order_are_frozen_before_conversion() {
    let root = repository();
    let raw = closure(&root);
    let original = admit(&root, &raw).unwrap();
    let mut base: serde_json::Value = serde_json::from_str(&raw).unwrap();
    base["recovery"] = serde_json::json!({
        "disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"x",
        "affected_unit_ids":["owner-a"],"actions":["x"],"preserved_authority":["all"],
        "repair_evidence_refs":["evidence:1"]
    });
    base["units"][0]["objective"] = serde_json::json!("owner objective changed");
    let mut count = base.clone();
    count["units"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id":"added","kind":"implementation","objective":"added","criteria":["added"],
            "depends_on":[],"files":["src/added.rs"],"package_scope_files":[],
            "commands":[command()],"package_proofs":[],"vendor_bindings":[],
            "provenance_manifest_destination":null,"links":["atom-1"]
        }));
    assert_eq!(
        admit_with_subject(
            &root,
            &count.to_string(),
            "recovery-count.json",
            Some(&original)
        )
        .unwrap_err(),
        "recovery changed the V2 unit count"
    );
    let mut order = base;
    order["units"].as_array_mut().unwrap().swap(0, 1);
    assert_eq!(
        admit_with_subject(
            &root,
            &order.to_string(),
            "recovery-order.json",
            Some(&original)
        )
        .unwrap_err(),
        "recovery reordered or replaced V2 unit identity"
    );
}

#[test]
fn recovery_link_mutation_reaches_recovery_comparison_with_a_valid_atom() {
    let root = repository();
    let raw = vendor_one(&root);
    let original = admit(&root, &raw).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_str(&raw).unwrap();
    candidate["recovery"] = serde_json::json!({"disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"x","affected_unit_ids":["vendor"],"actions":["x"],"preserved_authority":["all"],"repair_evidence_refs":["evidence:1"]});
    candidate["units"][0]["objective"] = serde_json::json!("changed objective");
    candidate["units"][0]["links"] = serde_json::json!(["atom-2"]);
    let error = admit_with_subject(
        &root,
        &candidate.to_string(),
        "link-recovery.json",
        Some(&original),
    )
    .unwrap_err();
    assert!(
        error.contains("changed non-objective V2 authority"),
        "{error}"
    );
}

#[test]
fn replay_confines_rerooted_image_before_outside_digest_is_read() {
    let root = repository();
    let (promotion, _image, binding) = persisted(&root, &vendor_one(&root), "rerooted");
    let outside = root.join("outside-image.json");
    fs::write(&outside, b"outside bytes").unwrap();
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    value["approved_plan_path"] = serde_json::json!(outside);
    let bytes = drivers::evidence::canonical_json(&value).unwrap();
    fs::write(&binding, &bytes).unwrap();
    let error = seam::read_approved_plan_v2(&binding, &sha(&bytes)).unwrap_err();
    assert!(
        error.contains("outside the exact repository/run authority root"),
        "{error}"
    );
    assert_ne!(sha(&bytes), promotion.binding_sha256);
}

fn reroot_binding(path: &Path, value: &serde_json::Value) -> String {
    let bytes = drivers::evidence::canonical_json(value).unwrap();
    let digest = sha(&bytes);
    fs::write(path, bytes).unwrap();
    digest
}

#[test]
fn rerooted_semantic_tampering_reaches_v2_replay_not_outer_digest_mismatch() {
    // Image semantic equality is checked only after the re-rooted binding and
    // image digest both pass, so this cannot be dismissed as stale bytes.
    let root = repository();
    let (promotion, image, binding) = persisted(&root, &vendor_one(&root), "semantic-image");
    let mut image_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&image).unwrap()).unwrap();
    image_value["units"][0]["objective"] = serde_json::json!("semantic image tamper");
    let image_bytes = drivers::evidence::canonical_json(&image_value).unwrap();
    fs::write(&image, &image_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["approved_plan_sha256"] = serde_json::json!(sha(&image_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 image does not exactly equal strict source admission"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // A re-rooted binding shape error is distinct from its external digest.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "semantic-binding");
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_boundary"] = serde_json::json!("planning.work-map.v9");
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 binding is malformed"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // A re-rooted role/profile tuple must remain exact; a profile whitelist
    // alone cannot turn a synthesizer carrier into a compiler authority.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "semantic-role-profile");
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_role_id"] = serde_json::json!("plan-compiler");
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 binding is malformed"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // Re-root the carrier digest and raw-payload digest together; replay then
    // rejects the new semantic source schema rather than its old hash.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "semantic-source");
    let source = actual_carrier_path(&root);
    let mut source_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    source_value["raw_output"] =
        serde_json::json!(r#"{"schema":"planning.work-map.v1","units":[]}"#);
    let source_bytes = serde_json::to_vec(&source_value).unwrap();
    fs::write(&source, &source_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_carrier_sha256"] = serde_json::json!(sha(&source_bytes));
    binding_value["source_raw_work_map_sha256"] =
        serde_json::json!(sha(source_value["raw_output"].as_str().unwrap().as_bytes()));
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 source replay: work-map-v2:wrong schema planning.work-map.v1"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // The recovery subject gets its own complete carrier/digest re-root. The
    // ordinary candidate still replays, then the subject's semantic schema is
    // rejected before recursive recovery can be considered.
    let (root, binding, _, subject) = recovered_subject_fixture("semantic-subject");
    let mut subject_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&subject).unwrap()).unwrap();
    subject_value["raw_output"] =
        serde_json::json!(r#"{"schema":"planning.work-map.v1","units":[]}"#);
    let subject_bytes = serde_json::to_vec(&subject_value).unwrap();
    fs::write(&subject, &subject_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["recovery_subject"]["source_carrier_sha256"] =
        serde_json::json!(sha(&subject_bytes));
    binding_value["recovery_subject"]["source_raw_work_map_sha256"] =
        serde_json::json!(sha(subject_value["raw_output"]
            .as_str()
            .unwrap()
            .as_bytes()));
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 recovery subject replay: work-map-v2:wrong schema planning.work-map.v1"
    );
    let _ = fs::remove_dir_all(root);

    // The atom registry digest is re-rooted too; source replay reaches the
    // semantic link membership check rather than an old registry digest.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "semantic-atoms");
    let atoms = root.join(".pi/autopilot/bug188/planning/atoms.json");
    let mut atom_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&atoms).unwrap()).unwrap();
    atom_value["atoms"][0]["id"] = serde_json::json!("atom-x");
    let atom_bytes = serde_json::to_vec(&atom_value).unwrap();
    fs::write(&atoms, &atom_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["atom_registry_digest"] = serde_json::json!(sha(&atom_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    assert_eq!(
        seam::read_approved_plan_v2(&binding, &digest).unwrap_err(),
        "approved-plan-v2 source replay: unit vendor links unknown atom id atom-1"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // This complete but re-rooted repository manifest passes its own shape
    // before live authority comparison rejects the semantic status claim.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "semantic-repository");
    let repository = PathBuf::from(
        runner::repository_authority_binding(&root, "bug188")
            .unwrap()
            .path,
    );
    let mut repository_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&repository).unwrap()).unwrap();
    repository_value["status_porcelain"] = serde_json::json!("M semantic");
    let repository_bytes = serde_json::to_vec_pretty(&repository_value).unwrap();
    fs::write(&repository, &repository_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["repository_manifest_digest"] = serde_json::json!(sha(&repository_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    let error = seam::read_approved_plan_v2(&binding, &digest).unwrap_err();
    assert!(
        error.starts_with("approved-plan-v2 repository authority: runner spec refused: repository authority live drift:"),
        "{error}"
    );
    assert_ne!(digest, promotion.binding_sha256);
}

#[test]
fn rerooted_actual_carrier_route_and_spec_facts_reject_after_outer_digests_match() {
    // A lower-hex but wrong generated schema digest is not allowed to hide
    // behind a recomputed carrier/binding digest.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "wrong-schema");
    let source = actual_carrier_path(&root);
    let mut carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    carrier["tool_schema_digest"] = serde_json::json!("a".repeat(64));
    carrier["terminal_route"]["schema_digest"] = serde_json::json!("a".repeat(64));
    let carrier_bytes = serde_json::to_vec(&carrier).unwrap();
    fs::write(&source, &carrier_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_carrier_sha256"] = serde_json::json!(sha(&carrier_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    let error = seam::read_approved_plan_v2(&binding, &digest).unwrap_err();
    assert!(
        error.contains("work-map-v2 actual carrier route/tuple/size drift"),
        "{error}"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // Compiler/synthesizer modes are equally exact.  The carrier and its
    // closed spec agree on the wrong mode and all enclosing digests are fresh.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "wrong-mode");
    let source = actual_carrier_path(&root);
    let mut carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    let spec_path = PathBuf::from(carrier["spec_path"].as_str().unwrap());
    let mut spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
    spec["mode"] = serde_json::json!("planning-repair");
    let spec_bytes = serde_json::to_vec(&spec).unwrap();
    fs::write(&spec_path, &spec_bytes).unwrap();
    let typed_spec: AgentRunSpec = serde_json::from_slice(&spec_bytes).unwrap();
    carrier["mode"] = serde_json::json!("planning-repair");
    carrier["spec_digest"] = serde_json::json!(sha(&spec_bytes));
    carrier["carrier_binding"] = serde_json::json!(runner::child::carrier_binding(&typed_spec));
    let carrier_bytes = serde_json::to_vec(&carrier).unwrap();
    fs::write(&source, &carrier_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_carrier_sha256"] = serde_json::json!(sha(&carrier_bytes));
    binding_value["source_spec_digest"] = serde_json::json!(sha(&spec_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    let error = seam::read_approved_plan_v2(&binding, &digest).unwrap_err();
    assert!(
        error.contains("work-map-v2 actual carrier role/mode/route drift"),
        "{error}"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // The closed spec and carrier can agree on a re-rooted add-on digest, but
    // it still must be the codegen-pinned add-on authority.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "wrong-addon");
    let source = actual_carrier_path(&root);
    let mut carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    let spec_path = PathBuf::from(carrier["spec_path"].as_str().unwrap());
    let mut spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
    spec["runtime_extension_digest"] = serde_json::json!("a".repeat(64));
    let spec_bytes = serde_json::to_vec(&spec).unwrap();
    fs::write(&spec_path, &spec_bytes).unwrap();
    let typed_spec: AgentRunSpec = serde_json::from_slice(&spec_bytes).unwrap();
    carrier["runtime_extension_digest"] = serde_json::json!("a".repeat(64));
    carrier["spec_digest"] = serde_json::json!(sha(&spec_bytes));
    carrier["carrier_binding"] = serde_json::json!(runner::child::carrier_binding(&typed_spec));
    let carrier_bytes = serde_json::to_vec(&carrier).unwrap();
    fs::write(&source, &carrier_bytes).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_carrier_sha256"] = serde_json::json!(sha(&carrier_bytes));
    binding_value["source_spec_digest"] = serde_json::json!(sha(&spec_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    let error = seam::read_approved_plan_v2(&binding, &digest).unwrap_err();
    assert!(
        error.contains("work-map-v2 actual carrier/spec authority drift"),
        "{error}"
    );
    assert_ne!(digest, promotion.binding_sha256);

    // A relocated carrier with matching spec/carrier strings is still not the
    // generated carrier path for the bound planning assignment.
    let root = repository();
    let (promotion, _, binding) = persisted(&root, &vendor_one(&root), "wrong-carrier-path");
    let source = actual_carrier_path(&root);
    let relocated = source.with_file_name("rerooted-carrier.json");
    let mut carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    let spec_path = PathBuf::from(carrier["spec_path"].as_str().unwrap());
    let mut spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
    spec["carrier_path"] = serde_json::json!(relocated.display().to_string());
    let spec_bytes = serde_json::to_vec(&spec).unwrap();
    fs::write(&spec_path, &spec_bytes).unwrap();
    let typed_spec: AgentRunSpec = serde_json::from_slice(&spec_bytes).unwrap();
    carrier["carrier_path"] = serde_json::json!(relocated.display().to_string());
    carrier["spec_digest"] = serde_json::json!(sha(&spec_bytes));
    carrier["carrier_binding"] = serde_json::json!(runner::child::carrier_binding(&typed_spec));
    let carrier_bytes = serde_json::to_vec(&carrier).unwrap();
    fs::write(&relocated, &carrier_bytes).unwrap();
    fs::remove_file(&source).unwrap();
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).unwrap()).unwrap();
    binding_value["source_carrier_path"] = serde_json::json!(relocated.display().to_string());
    binding_value["source_carrier_sha256"] = serde_json::json!(sha(&carrier_bytes));
    binding_value["source_spec_digest"] = serde_json::json!(sha(&spec_bytes));
    let digest = reroot_binding(&binding, &binding_value);
    let error = seam::read_approved_plan_v2(&binding, &digest).unwrap_err();
    assert!(
        error.contains("work-map-v2 actual carrier generated path authority drift"),
        "{error}"
    );
    assert_ne!(digest, promotion.binding_sha256);
}

#[test]
fn source_carrier_plus_one_escape_reports_its_raw_payload_ceiling() {
    let root = repository();
    let path = root.join(".pi/autopilot/bug188/planning/escaped-plus-one.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema":"autopilot.work_map_v2_source_carrier.v1",
            "boundary":"planning.work-map.v2",
            "result_contract":"planning.work-map.v2",
            "raw_work_map_payload":"\\".repeat(kernel::generated::WORK_MAP_V2_MAX_BYTES + 1),
        }))
        .unwrap(),
    )
    .unwrap();
    let error = planning::read_work_map_v2_source_carrier(&path).unwrap_err();
    assert!(
        error.contains("payload exceeds WorkMap V2 byte cap"),
        "{error}"
    );
}
