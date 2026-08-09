//! Repository manifest, pinned-object, and no-replace Git authority.

use super::*;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryAuthority {
    pub schema: String,
    pub repo_root: String,
    pub head_commit: String,
    pub head_tree: String,
    pub status_porcelain: String,
    pub tracked_sources: Vec<RepositoryTrackedSource>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct RepositoryTrackedSource {
    pub path: String,
    pub mode: String,
    pub blob: String,
    pub whole_file_anchor: String,
}

/// A bounded byte-for-byte read of an immutable authority-pinned source blob.
/// This is intentionally not a worktree read.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RepositoryPinnedSourceBlob {
    pub path: String,
    pub mode: String,
    pub blob: String,
    pub whole_file_anchor: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RepositoryAuthorityBinding {
    pub path: String,
    pub digest: String,
    pub manifest: RepositoryAuthority,
}

pub fn repository_authority(cwd: &Path) -> Result<RepositoryAuthority, RunnerError> {
    compute_repository_authority(cwd)
}

pub fn repository_authority_binding(
    cwd: &Path,
    workstream: &str,
) -> Result<RepositoryAuthorityBinding, RunnerError> {
    validate_workstream_component(workstream)?;
    let manifest = compute_repository_authority(cwd)?;
    let path = repository_authority_manifest_path(Path::new(&manifest.repo_root), workstream);
    reject_link_components_for_path(&path)?;
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|error| RunnerError::Io(error.to_string()))?;
    if bytes.len() > REPOSITORY_AUTHORITY_MANIFEST_MAX_BYTES {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority manifest oversized: {} bytes exceeds {REPOSITORY_AUTHORITY_MANIFEST_MAX_BYTES}",
            bytes.len()
        )));
    }
    write_bounded_file_create_once(&path, &bytes, REPOSITORY_AUTHORITY_MANIFEST_MAX_BYTES)?;
    let stored = read_bounded_authority_file(&path, REPOSITORY_AUTHORITY_MANIFEST_MAX_BYTES)?;
    if stored != bytes {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority manifest digest drift at {}",
            path.display()
        )));
    }
    let digest = sha256_hex(&stored);
    Ok(RepositoryAuthorityBinding {
        path: path_to_string(&path)?,
        digest,
        manifest,
    })
}

pub fn read_repository_authority_binding(
    path: &Path,
    expected_digest: &str,
) -> Result<RepositoryAuthorityBinding, RunnerError> {
    let bytes = read_bounded_authority_file(path, REPOSITORY_AUTHORITY_MANIFEST_MAX_BYTES)?;
    let digest = sha256_hex(&bytes);
    if digest != expected_digest {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority digest drift: expected {expected_digest}, got {digest}"
        )));
    }
    let manifest: RepositoryAuthority = serde_json::from_slice(&bytes)
        .map_err(|error| RunnerError::InvalidSpec(format!("repository authority json: {error}")))?;
    validate_repository_manifest_shape(&manifest)?;
    let _ = repository_authority_run_root_from_manifest(&manifest, path)?;
    verify_repository_authority_live(&manifest)?;
    Ok(RepositoryAuthorityBinding {
        path: path_to_string(path)?,
        digest,
        manifest,
    })
}

/// Revalidates the repository authority and returns the exact pinned blob for
/// one declared origin.  It never reads a mutable worktree path or current HEAD.
pub fn read_pinned_repository_source_blob(
    authority: &RepositoryAuthorityBinding,
    origin_path: &str,
    origin_anchor: &str,
) -> Result<RepositoryPinnedSourceBlob, RunnerError> {
    let persisted =
        read_repository_authority_binding(Path::new(&authority.path), &authority.digest)?;
    if persisted.manifest != authority.manifest {
        return Err(RunnerError::InvalidSpec(
            "repository authority binding manifest drift during vendoring enrichment".to_owned(),
        ));
    }
    read_pinned_repository_source_blob_from_verified(&persisted, origin_path, origin_anchor)
}

/// Batch callers may use a binding that was freshly verified immediately
/// before and after the bounded object reads. This avoids turning a fixed W0
/// proof into hundreds of redundant live-status processes while retaining the
/// same pinned manifest/object checks for every source row.
pub(crate) fn read_pinned_repository_source_blob_from_verified(
    authority: &RepositoryAuthorityBinding,
    origin_path: &str,
    origin_anchor: &str,
) -> Result<RepositoryPinnedSourceBlob, RunnerError> {
    validate_repository_manifest_shape(&authority.manifest)?;
    if !authority.manifest.status_porcelain.is_empty() {
        return Err(RunnerError::InvalidSpec(
            "repository authority requires clean status for vendoring enrichment".to_owned(),
        ));
    }
    let sources = authority
        .manifest
        .tracked_sources
        .iter()
        .filter(|source| source.path == origin_path)
        .collect::<Vec<_>>();
    let source = match sources.as_slice() {
        [source] => *source,
        [] => {
            return Err(RunnerError::InvalidSpec(format!(
                "vendoring origin is not an authority-tracked source: {origin_path}"
            )));
        }
        _ => {
            return Err(RunnerError::InvalidSpec(format!(
                "vendoring origin is ambiguous in repository authority: {origin_path}"
            )));
        }
    };
    if source.whole_file_anchor != origin_anchor {
        return Err(RunnerError::InvalidSpec(format!(
            "vendoring origin anchor drift for {origin_path}"
        )));
    }
    if !matches!(source.mode.as_str(), "100644" | "100755") {
        return Err(RunnerError::InvalidSpec(format!(
            "vendoring origin mode is not a regular executable/nonexecutable blob: {}",
            source.mode
        )));
    }
    let root = Path::new(&authority.manifest.repo_root);
    let expected_tree = authority_git_output_bounded_with_limits(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{tree}}", authority.manifest.head_commit),
        ],
        &[],
        256,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if !expected_tree.status.success()
        || std::str::from_utf8(&expected_tree.stdout)
            .map(str::trim)
            .ok()
            != Some(authority.manifest.head_tree.as_str())
    {
        return Err(RunnerError::InvalidSpec(
            "repository authority pinned commit/tree drift during vendoring enrichment".to_owned(),
        ));
    }
    let tree_entry = authority_git_output_bounded_with_limits(
        root,
        &[
            "ls-tree",
            "-z",
            &authority.manifest.head_tree,
            "--",
            origin_path,
        ],
        &[],
        REPOSITORY_AUTHORITY_LS_TREE_MAX_RECORD_BYTES + origin_path.len() + 128,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if !tree_entry.status.success() {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority cannot read pinned tree origin {origin_path}"
        )));
    }
    let record = tree_entry.stdout.strip_suffix(&[0]).ok_or_else(|| {
        RunnerError::InvalidSpec("pinned tree entry missing NUL terminator".to_owned())
    })?;
    if record.contains(&0) {
        return Err(RunnerError::InvalidSpec(
            "pinned tree origin returned multiple entries".to_owned(),
        ));
    }
    let record = std::str::from_utf8(record)
        .map_err(|error| RunnerError::InvalidSpec(format!("pinned tree origin utf8: {error}")))?;
    let (header, path) = record.split_once('\t').ok_or_else(|| {
        RunnerError::InvalidSpec("pinned tree origin record malformed".to_owned())
    })?;
    let mut parts = header.split_whitespace();
    let (Some(mode), Some(kind), Some(blob)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(RunnerError::InvalidSpec(
            "pinned tree origin record incomplete".to_owned(),
        ));
    };
    if parts.next().is_some()
        || path != origin_path
        || mode != source.mode
        || kind != "blob"
        || blob != source.blob
    {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority pinned tree row drift for {origin_path}"
        )));
    }
    let output = authority_git_output_bounded_with_limits(
        root,
        &["cat-file", "blob", &source.blob],
        &[],
        MAX_AUTHORITY_SOURCE_BYTES,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if !output.status.success() {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority cannot read pinned blob for {origin_path}"
        )));
    }
    Ok(RepositoryPinnedSourceBlob {
        path: source.path.clone(),
        mode: source.mode.clone(),
        blob: source.blob.clone(),
        whole_file_anchor: source.whole_file_anchor.clone(),
        bytes: output.stdout,
    })
}

/// Read a complete, bounded set of pinned source blobs after a caller has
/// freshly verified the authority binding. The caller must verify the same
/// binding again after this batch; this brackets every tree/blob read without
/// repeating repository-status processes per source leaf.
pub(crate) fn read_pinned_repository_source_blobs_from_verified(
    authority: &RepositoryAuthorityBinding,
    origins: &[(&str, &str)],
) -> Result<Vec<RepositoryPinnedSourceBlob>, RunnerError> {
    if origins.is_empty() || origins.len() > 128 {
        return Err(RunnerError::InvalidSpec(
            "pinned source batch cardinality is malformed".to_owned(),
        ));
    }
    validate_repository_manifest_shape(&authority.manifest)?;
    if !authority.manifest.status_porcelain.is_empty() {
        return Err(RunnerError::InvalidSpec(
            "repository authority requires clean status for vendoring enrichment".to_owned(),
        ));
    }
    let by_path = authority
        .manifest
        .tracked_sources
        .iter()
        .map(|source| (source.path.as_str(), source))
        .collect::<BTreeMap<_, _>>();
    let mut sources = Vec::with_capacity(origins.len());
    let mut unique_sources = Vec::with_capacity(origins.len());
    let mut paths = Vec::with_capacity(origins.len());
    let mut seen = BTreeSet::new();
    for (path, anchor) in origins {
        let source = by_path.get(path).copied().ok_or_else(|| {
            RunnerError::InvalidSpec(format!("vendoring origin is not authority-tracked: {path}"))
        })?;
        if source.whole_file_anchor != *anchor
            || !matches!(source.mode.as_str(), "100644" | "100755")
            || !is_git_oid(&source.blob)
        {
            return Err(RunnerError::InvalidSpec(format!(
                "pinned source batch authority drift: {path}"
            )));
        }
        sources.push(source);
        if seen.insert(*path) {
            unique_sources.push(source);
            paths.push((*path).to_owned());
        }
    }
    let root = Path::new(&authority.manifest.repo_root);
    let tree_limit = unique_sources
        .len()
        .checked_mul(REPOSITORY_AUTHORITY_LS_TREE_MAX_RECORD_BYTES + 1)
        .ok_or_else(|| RunnerError::InvalidSpec("pinned source tree batch overflow".to_owned()))?;
    let tree = authority_git_output_bounded_with_limits(
        root,
        &["ls-tree", "-z", &authority.manifest.head_tree, "--"],
        &paths,
        tree_limit,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if !tree.status.success() {
        return Err(RunnerError::InvalidSpec(
            "pinned source tree batch cannot be read".to_owned(),
        ));
    }
    let mut tree_rows = BTreeMap::new();
    for row in tree
        .stdout
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let tab = row.iter().position(|byte| *byte == b'\t').ok_or_else(|| {
            RunnerError::InvalidSpec("pinned source tree row lacks TAB".to_owned())
        })?;
        let path = std::str::from_utf8(&row[tab + 1..]).map_err(|_| {
            RunnerError::InvalidSpec("pinned source tree path is not UTF-8".to_owned())
        })?;
        let header = std::str::from_utf8(&row[..tab]).map_err(|_| {
            RunnerError::InvalidSpec("pinned source tree header is not UTF-8".to_owned())
        })?;
        let mut parts = header.split_whitespace();
        let (Some(mode), Some(kind), Some(blob)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(RunnerError::InvalidSpec(
                "pinned source tree row is incomplete".to_owned(),
            ));
        };
        if parts.next().is_some()
            || kind != "blob"
            || !matches!(mode, "100644" | "100755")
            || !is_git_oid(blob)
            || tree_rows
                .insert(path.to_owned(), (mode.to_owned(), blob.to_owned()))
                .is_some()
        {
            return Err(RunnerError::InvalidSpec(
                "pinned source tree row is malformed or duplicate".to_owned(),
            ));
        }
    }
    if tree_rows.len() != unique_sources.len()
        || unique_sources.iter().any(|source| {
            tree_rows
                .get(&source.path)
                .is_none_or(|(mode, blob)| mode != &source.mode || blob != &source.blob)
        })
    {
        return Err(RunnerError::InvalidSpec(
            "pinned source tree batch differs from authority".to_owned(),
        ));
    }
    let mut input = Vec::new();
    for source in &unique_sources {
        input.extend_from_slice(source.blob.as_bytes());
        input.push(b'\n');
    }
    // Work-map V2 already caps the aggregate bound source bytes. Batch
    // framing adds only one fixed header allowance per distinct object.
    let blob_limit = MAX_VENDORED_SOURCE_BYTES
        .checked_add(unique_sources.len().checked_mul(128).ok_or_else(|| {
            RunnerError::InvalidSpec("pinned source blob batch overflow".to_owned())
        })?)
        .ok_or_else(|| RunnerError::InvalidSpec("pinned source blob batch overflow".to_owned()))?;
    let blobs = authority_git_output_bounded_with_input(
        root,
        &["cat-file", "--batch"],
        &[],
        &input,
        blob_limit,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(RunnerError::InvalidSpec)?;
    if !blobs.status.success() {
        return Err(RunnerError::InvalidSpec(
            "pinned source blob batch cannot be read".to_owned(),
        ));
    }
    let mut cursor = 0_usize;
    let mut unique_result = BTreeMap::new();
    for source in unique_sources {
        let header_end = blobs.stdout[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .ok_or_else(|| {
                RunnerError::InvalidSpec("pinned blob batch header missing".to_owned())
            })?;
        let header = std::str::from_utf8(&blobs.stdout[cursor..header_end]).map_err(|_| {
            RunnerError::InvalidSpec("pinned blob batch header is not UTF-8".to_owned())
        })?;
        let mut parts = header.split_whitespace();
        let (Some(blob), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(RunnerError::InvalidSpec(
                "pinned blob batch header is incomplete".to_owned(),
            ));
        };
        let size = size.parse::<usize>().map_err(|_| {
            RunnerError::InvalidSpec("pinned blob batch size is malformed".to_owned())
        })?;
        if parts.next().is_some()
            || blob != source.blob
            || kind != "blob"
            || !is_git_oid(blob)
            || size > MAX_AUTHORITY_SOURCE_BYTES
        {
            return Err(RunnerError::InvalidSpec(
                "pinned blob batch header differs from authority".to_owned(),
            ));
        }
        let start = header_end + 1;
        let end = start.checked_add(size).ok_or_else(|| {
            RunnerError::InvalidSpec("pinned blob batch size overflow".to_owned())
        })?;
        if end >= blobs.stdout.len() || blobs.stdout[end] != b'\n' {
            return Err(RunnerError::InvalidSpec(
                "pinned blob batch payload is truncated".to_owned(),
            ));
        }
        unique_result.insert(
            source.path.clone(),
            RepositoryPinnedSourceBlob {
                path: source.path.clone(),
                mode: source.mode.clone(),
                blob: source.blob.clone(),
                whole_file_anchor: source.whole_file_anchor.clone(),
                bytes: blobs.stdout[start..end].to_vec(),
            },
        );
        cursor = end + 1;
    }
    if cursor != blobs.stdout.len() {
        return Err(RunnerError::InvalidSpec(
            "pinned blob batch has trailing rows".to_owned(),
        ));
    }
    sources
        .into_iter()
        .map(|source| {
            unique_result.get(&source.path).cloned().ok_or_else(|| {
                RunnerError::InvalidSpec("pinned blob batch result omission".to_owned())
            })
        })
        .collect()
}

fn compute_repository_authority(cwd: &Path) -> Result<RepositoryAuthority, RunnerError> {
    // The caller supplies an authority root, not an arbitrary location inside
    // one. Resolve and reject links before any Git process can inspect it.
    reject_link_components_for_path(cwd)?;
    let supplied_root = fs::canonicalize(cwd).map_err(io_error)?;
    if !fs::metadata(&supplied_root).map_err(io_error)?.is_dir() {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority supplied root is not a directory: {}",
            supplied_root.display()
        )));
    }
    reject_link_components_for_path(&supplied_root)?;
    require_exact_git_root(&supplied_root)?;
    let repo_root = supplied_root;
    let first = live_repository_snapshot(&repo_root)?;
    if !first.status_porcelain.is_empty() {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority requires clean status including nonignored untracked files: {}",
            first.status_porcelain.replace('\n', ";")
        )));
    }
    let tracked_sources = tracked_sources_from_head(&repo_root, &first.head_commit)?;
    let second = live_repository_snapshot(&repo_root)?;
    if first != second {
        return Err(RunnerError::InvalidSpec(
            "repository authority moved while manifest was being built".to_owned(),
        ));
    }
    let manifest = RepositoryAuthority {
        schema: "autopilot.repository_authority.v1".to_owned(),
        repo_root: path_to_string(&repo_root)?,
        head_commit: first.head_commit,
        head_tree: first.head_tree,
        status_porcelain: first.status_porcelain,
        tracked_sources,
    };
    validate_repository_manifest_shape(&manifest)?;
    Ok(manifest)
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct LiveRepositorySnapshot {
    head_commit: String,
    head_tree: String,
    status_porcelain: String,
}

fn live_repository_snapshot(repo_root: &Path) -> Result<LiveRepositorySnapshot, RunnerError> {
    require_exact_git_root(repo_root)?;
    let head_commit = git_stdout_runner(repo_root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let head_tree = git_stdout_runner(repo_root, &["rev-parse", "--verify", "HEAD^{tree}"])?;
    let status_porcelain = repository_status_porcelain(repo_root)?;
    Ok(LiveRepositorySnapshot {
        head_commit: head_commit.trim().to_owned(),
        head_tree: head_tree.trim().to_owned(),
        status_porcelain,
    })
}

fn repository_status_porcelain(repo_root: &Path) -> Result<String, RunnerError> {
    let mut stdout = git_stdout_runner_bounded(
        repo_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        REPOSITORY_AUTHORITY_STATUS_MAX_STDOUT_BYTES,
        "git status",
    )?;
    let ignored_pi = git_stdout_runner_bounded(
        repo_root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--",
            ".pi",
        ],
        REPOSITORY_AUTHORITY_STATUS_MAX_STDOUT_BYTES,
        "git status ignored .pi",
    )?;
    stdout.extend_from_slice(&ignored_pi);
    let mut foreign = BTreeSet::new();
    for record in stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 4 || record[2] != b' ' {
            return Err(RunnerError::InvalidSpec(
                "git status emitted a malformed porcelain-v1 record".to_owned(),
            ));
        }
        let status = &record[..2];
        let path = std::str::from_utf8(&record[3..])
            .map_err(|error| RunnerError::InvalidSpec(format!("git status path utf8: {error}")))?;
        let untracked = status == b"??";
        let ignored = status == b"!!";
        if ignored && !is_pi_namespace_path(path) {
            continue;
        }
        if !(untracked || ignored) || !matches_package_owned_runtime_path(path) {
            foreign.insert(format!("{} {path}", String::from_utf8_lossy(status)));
        }
    }
    Ok(foreign.into_iter().collect::<Vec<_>>().join("\n"))
}

fn is_pi_namespace_path(path: &str) -> bool {
    matches!(path, ".pi" | ".pi/") || path.starts_with(".pi/")
}

fn matches_package_owned_runtime_path(path: &str) -> bool {
    path == ".pi/autopilot"
        || path.starts_with(".pi/autopilot/")
        || path == ".pi/tasks"
        || path.starts_with(".pi/tasks/")
}

fn tracked_sources_from_head(
    repo_root: &Path,
    head_commit: &str,
) -> Result<Vec<RepositoryTrackedSource>, RunnerError> {
    let stdout = git_stdout_runner_bounded(
        repo_root,
        &["ls-tree", "-r", "-z", "--full-tree", head_commit],
        REPOSITORY_AUTHORITY_LS_TREE_MAX_STDOUT_BYTES,
        "git ls-tree",
    )?;
    let mut sources = Vec::new();
    for raw in stdout
        .split(|byte| *byte == 0)
        .filter(|raw| !raw.is_empty())
    {
        if raw.len() > REPOSITORY_AUTHORITY_LS_TREE_MAX_RECORD_BYTES {
            return Err(RunnerError::InvalidSpec(format!(
                "git ls-tree record oversized: {} bytes exceeds {REPOSITORY_AUTHORITY_LS_TREE_MAX_RECORD_BYTES}",
                raw.len()
            )));
        }
        let record = std::str::from_utf8(raw)
            .map_err(|error| RunnerError::InvalidSpec(format!("git ls-tree utf8: {error}")))?;
        let (header, path) = record.split_once('\t').ok_or_else(|| {
            RunnerError::InvalidSpec(format!("git ls-tree malformed record: {record:?}"))
        })?;
        if path.len() > REPOSITORY_AUTHORITY_LS_TREE_MAX_PATH_BYTES {
            return Err(RunnerError::InvalidSpec(format!(
                "git ls-tree path oversized: {} bytes exceeds {REPOSITORY_AUTHORITY_LS_TREE_MAX_PATH_BYTES}: {path:?}",
                path.len()
            )));
        }
        let mut parts = header.split_whitespace();
        let mode = parts.next().ok_or_else(|| {
            RunnerError::InvalidSpec(format!("git ls-tree missing mode: {record:?}"))
        })?;
        let kind = parts.next().ok_or_else(|| {
            RunnerError::InvalidSpec(format!("git ls-tree missing type: {record:?}"))
        })?;
        let object = parts.next().ok_or_else(|| {
            RunnerError::InvalidSpec(format!("git ls-tree missing object: {record:?}"))
        })?;
        if parts.next().is_some() || path.trim().is_empty() {
            return Err(RunnerError::InvalidSpec(format!(
                "git ls-tree malformed tracked source: {record:?}"
            )));
        }
        match (mode, kind) {
            ("100644" | "100755", "blob") => {}
            ("120000", "blob") => {
                return Err(RunnerError::InvalidSpec(format!(
                    "repository authority rejects tracked symlink mode 120000: {path}"
                )));
            }
            (_, "commit") => {
                return Err(RunnerError::InvalidSpec(format!(
                    "repository authority rejects gitlink/submodule tracked source mode {mode}: {path}"
                )));
            }
            _ => {
                return Err(RunnerError::InvalidSpec(format!(
                    "repository authority unsupported tracked source mode/type: mode={mode} type={kind} path={path}"
                )));
            }
        }
        if sources.len() >= REPOSITORY_AUTHORITY_MAX_TRACKED_SOURCES {
            return Err(RunnerError::InvalidSpec(format!(
                "repository authority tracked source inventory exceeds {REPOSITORY_AUTHORITY_MAX_TRACKED_SOURCES} entries"
            )));
        }
        sources.push(RepositoryTrackedSource {
            path: path.to_owned(),
            mode: mode.to_owned(),
            blob: object.to_owned(),
            whole_file_anchor: format!("git://{head_commit}/{path}#whole-file"),
        });
    }
    if sources.is_empty() {
        return Err(RunnerError::InvalidSpec(
            "repository authority tracked source inventory is empty".to_owned(),
        ));
    }
    Ok(sources)
}

fn git_stdout_runner_bounded(
    repo: &Path,
    args: &[&str],
    max_stdout_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, RunnerError> {
    let output = authority_git_output_bounded_with_limits(
        repo,
        args,
        &[],
        max_stdout_bytes,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(|error| RunnerError::InvalidSpec(format!("{label} process failed: {error}")))?;
    if !output.status.success() {
        return Err(RunnerError::InvalidSpec(format!(
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(output.stdout)
}

fn validate_repository_manifest_shape(manifest: &RepositoryAuthority) -> Result<(), RunnerError> {
    if manifest.schema != "autopilot.repository_authority.v1"
        || manifest.repo_root.trim().is_empty()
        || manifest.head_commit.trim().is_empty()
        || manifest.head_tree.trim().is_empty()
    {
        return Err(RunnerError::InvalidSpec(
            "repository authority manifest missing identity fields".to_owned(),
        ));
    }
    let root = Path::new(&manifest.repo_root);
    if !root.is_absolute() {
        return Err(RunnerError::InvalidSpec(
            "repository authority root is not absolute".to_owned(),
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(io_error)?;
    if canonical_root != root {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority canonical root drift: manifest={} canonical={}",
            root.display(),
            canonical_root.display()
        )));
    }
    reject_link_components_for_path(root)?;
    if manifest.status_porcelain.contains('\0') {
        return Err(RunnerError::InvalidSpec(
            "repository authority status is malformed".to_owned(),
        ));
    }
    let mut seen = BTreeSet::new();
    for source in &manifest.tracked_sources {
        if source.path.trim().is_empty()
            || source.path.contains('\0')
            || source.path.contains('\\')
            || Path::new(&source.path).is_absolute()
            || !matches!(source.mode.as_str(), "100644" | "100755")
            || !is_git_oid(&source.blob)
            || source.whole_file_anchor
                != format!("git://{}/{}#whole-file", manifest.head_commit, source.path)
        {
            return Err(RunnerError::InvalidSpec(format!(
                "repository authority malformed tracked source: {} mode={}",
                source.path, source.mode
            )));
        }
        if !seen.insert(source.path.clone()) {
            return Err(RunnerError::InvalidSpec(format!(
                "repository authority duplicate tracked source: {}",
                source.path
            )));
        }
    }
    Ok(())
}

fn is_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn verify_repository_authority_live(manifest: &RepositoryAuthority) -> Result<(), RunnerError> {
    let root = Path::new(&manifest.repo_root);
    let live = live_repository_snapshot(root)?;
    if live.head_commit != manifest.head_commit
        || live.head_tree != manifest.head_tree
        || live.status_porcelain != manifest.status_porcelain
    {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority live drift: expected head={} tree={} clean_status_len={}, got head={} tree={} status_len={}",
            manifest.head_commit,
            manifest.head_tree,
            manifest.status_porcelain.len(),
            live.head_commit,
            live.head_tree,
            live.status_porcelain.len()
        )));
    }
    Ok(())
}

fn repository_authority_manifest_path(repo_root: &Path, workstream: &str) -> PathBuf {
    repo_root
        .join(".pi/autopilot")
        .join(workstream)
        .join("planning")
        .join("repository-authority.v1.json")
}

pub(crate) fn repository_authority_run_root(
    binding: &RepositoryAuthorityBinding,
) -> Result<PathBuf, RunnerError> {
    repository_authority_run_root_from_manifest(&binding.manifest, Path::new(&binding.path))
}

fn repository_authority_run_root_from_manifest(
    manifest: &RepositoryAuthority,
    manifest_path: &Path,
) -> Result<PathBuf, RunnerError> {
    let root = Path::new(&manifest.repo_root);
    let autopilot = root.join(".pi").join("autopilot");
    let suffix = manifest_path.strip_prefix(&autopilot).map_err(|_| {
        RunnerError::InvalidSpec(format!(
            "repository authority manifest is outside its repository run root: {}",
            manifest_path.display()
        ))
    })?;
    let components = suffix.components().collect::<Vec<_>>();
    let [
        Component::Normal(workstream),
        Component::Normal(planning),
        Component::Normal(file),
    ] = components.as_slice()
    else {
        return Err(RunnerError::InvalidSpec(
            "repository authority manifest path shape is malformed".to_owned(),
        ));
    };
    let workstream = workstream.to_str().ok_or_else(|| {
        RunnerError::InvalidSpec("repository authority workstream is not UTF-8".to_owned())
    })?;
    validate_workstream_component(workstream)?;
    if *planning != "planning" || *file != "repository-authority.v1.json" {
        return Err(RunnerError::InvalidSpec(
            "repository authority manifest path is not the exact run manifest".to_owned(),
        ));
    }
    Ok(autopilot.join(workstream))
}

pub(crate) fn validate_workstream_component(value: &str) -> Result<(), RunnerError> {
    if value.is_empty()
        || value.len() > 242
        || matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(RunnerError::InvalidSpec(
            "repository authority workstream must be one safe component".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn path_uri_component(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository-authority.v1.json")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn require_exact_git_root(supplied_root: &Path) -> Result<(), RunnerError> {
    let repo_root_raw = git_stdout_runner(supplied_root, &["rev-parse", "--show-toplevel"])?;
    let reported_root = fs::canonicalize(repo_root_raw.trim()).map_err(io_error)?;
    reject_link_components_for_path(&reported_root)?;
    if reported_root != supplied_root {
        return Err(RunnerError::InvalidSpec(format!(
            "repository authority supplied root does not match git top-level: supplied={} git={}",
            supplied_root.display(),
            reported_root.display()
        )));
    }
    Ok(())
}

fn git_stdout_runner(repo: &Path, args: &[&str]) -> Result<String, RunnerError> {
    let output = authority_git_output_bounded_with_limits(
        repo,
        args,
        &[],
        REPOSITORY_AUTHORITY_IDENTITY_MAX_STDOUT_BYTES,
        PACKAGE_GIT_STDERR_MAX_BYTES,
    )
    .map_err(|error| RunnerError::InvalidSpec(format!("git {:?} process failed: {error}", args)))?;
    if !output.status.success() {
        return Err(RunnerError::InvalidSpec(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| RunnerError::InvalidSpec(format!("git stdout utf8: {error}")))
}
