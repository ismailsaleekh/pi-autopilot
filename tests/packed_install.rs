use std::{
    ffi::CString,
    fs,
    io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::Value;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct RunOutput {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl RunOutput {
    fn success(&self) -> bool {
        self.code == 0
    }
}

#[test]
fn packed_install_resolves_installed_core_and_fails_before_spawn_when_missing() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("packed-install")?;
    let package_root = package_root()?;
    let stage = root.join("stage");
    let pack_dir = root.join("pack");
    let consumer = root.join("consumer");
    let cache = root.join("npm-cache");
    fs::create_dir_all(&stage)?;
    fs::create_dir_all(&pack_dir)?;
    fs::create_dir_all(&consumer)?;
    fs::create_dir_all(&cache)?;

    let source_package_json = package_root.join("package.json");
    fs::copy(&source_package_json, stage.join("package.json"))?;
    let bin_entry = package_bin_entry(&source_package_json)?;
    let staged_binary = stage.join(&bin_entry);
    fs::create_dir_all(staged_binary.parent().ok_or("bin parent")?)?;
    fs::copy(env!("CARGO_BIN_EXE_autopilot-core"), &staged_binary)?;
    make_executable(&staged_binary)?;

    let pack = npm_pack(&stage, &pack_dir, &cache)?;
    let metadata: Value = serde_json::from_slice(&pack.stdout)?;
    let packed = metadata
        .as_array()
        .and_then(|items| items.first())
        .ok_or("npm pack did not return package metadata")?;
    let files = packed
        .get("files")
        .and_then(Value::as_array)
        .ok_or("npm pack metadata omitted files")?;
    let packed_bin = files
        .iter()
        .find(|file| file.get("path").and_then(Value::as_str) == Some(bin_entry.as_str()))
        .ok_or_else(|| format!("packed payload omitted bin.autopilot-core at {bin_entry}"))?;
    let mode = packed_bin
        .get("mode")
        .and_then(Value::as_u64)
        .ok_or("packed bin omitted mode")?;
    assert_ne!(mode & 0o111, 0, "packed autopilot-core is not executable");

    let filename = packed
        .get("filename")
        .and_then(Value::as_str)
        .ok_or("npm pack metadata omitted filename")?;
    let tarball = pack_dir.join(filename);
    assert!(tarball.is_file(), "npm pack tarball was not created");
    npm_install(&consumer, &tarball, &cache)?;

    let installed = consumer.join("node_modules").join("pi-autopilot");
    let installed_package_json = installed.join("package.json");
    let installed_binary = installed.join(&bin_entry);
    assert!(installed_binary.is_file(), "installed bin path is absent");
    assert_executable(&installed_binary)?;

    let resolver = package_root.join("host").join("src").join("resolve-core.ts");
    let resolved = run_resolver(&resolver, &installed_package_json, &installed_binary)?;
    assert_eq!(resolved, installed_binary.to_string_lossy());
    assert!(PathBuf::from(&resolved).starts_with(&installed));

    fs::remove_file(&installed_binary)?;
    let missing = run_resolver_raw(&resolver, &installed_package_json, &installed_binary)?;
    assert!(!missing.success(), "missing binary unexpectedly resolved");
    let evidence = String::from_utf8_lossy(&missing.stderr);
    assert!(evidence.len() < 1200, "missing-binary evidence is unbounded");
    assert!(evidence.contains("autopilot-core is not installed"), "{evidence}");
    assert!(evidence.contains(installed_binary.to_string_lossy().as_ref()), "{evidence}");
    assert!(!evidence.contains("exited code="), "resolver spawned the core: {evidence}");

    fs::remove_dir_all(root)?;
    Ok(())
}

fn npm_pack(stage: &Path, pack_dir: &Path, cache: &Path) -> Result<RunOutput, Box<dyn std::error::Error>> {
    let output = run_program(
        "env",
        &[
            format!("npm_config_cache={}", cache.display()),
            "npm".to_owned(),
            "pack".to_owned(),
            "--ignore-scripts".to_owned(),
            "--pack-destination".to_owned(),
            pack_dir.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
        Some(stage),
    )?;
    require_success("npm pack", output)
}

fn npm_install(consumer: &Path, tarball: &Path, cache: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let output = run_program(
        "env",
        &[
            format!("npm_config_cache={}", cache.display()),
            "npm".to_owned(),
            "install".to_owned(),
            "--ignore-scripts".to_owned(),
            "--no-audit".to_owned(),
            "--no-fund".to_owned(),
            "--prefix".to_owned(),
            consumer.to_string_lossy().into_owned(),
            tarball.to_string_lossy().into_owned(),
        ],
        None,
    )?;
    drop(require_success("npm install", output)?);
    Ok(())
}

fn package_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("drivers manifest has no parent")?
        .to_path_buf())
}

fn package_bin_entry(package_json: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let value: Value = serde_json::from_slice(&fs::read(package_json)?)?;
    let entry = value
        .get("bin")
        .and_then(|bin| bin.get("autopilot-core"))
        .and_then(Value::as_str)
        .ok_or("package.json bin.autopilot-core is absent")?;
    Ok(entry.to_owned())
}

fn run_resolver(
    resolver: &Path,
    package_json: &Path,
    expected: &Path,
) -> Result<String, Box<dyn std::error::Error>> {
    let output = run_resolver_raw(resolver, package_json, expected)?;
    if !output.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn run_resolver_raw(
    resolver: &Path,
    package_json: &Path,
    expected: &Path,
) -> Result<RunOutput, Box<dyn std::error::Error>> {
    let script = r#"
import { pathToFileURL } from 'node:url';
try {
  const [resolver, packageJson, expected] = process.argv.slice(1);
  const { resolveCoreBinary } = await import(pathToFileURL(resolver).href);
  const actual = resolveCoreBinary({ packageJsonPath: packageJson });
  if (actual !== expected) {
    throw new Error(`resolved ${actual} instead of ${expected}`);
  }
  console.log(actual);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error).slice(0, 1000));
  process.exit(42);
}
"#;
    run_program(
        "node",
        &[
            "--experimental-strip-types".to_owned(),
            "--input-type=module".to_owned(),
            "--eval".to_owned(),
            script.to_owned(),
            resolver.to_string_lossy().into_owned(),
            package_json.to_string_lossy().into_owned(),
            expected.to_string_lossy().into_owned(),
        ],
        None,
    )
}

fn require_success(label: &str, output: RunOutput) -> Result<RunOutput, Box<dyn std::error::Error>> {
    if !output.success() {
        return Err(format!(
            "{label} failed status={} stdout={} stderr={}",
            output.code,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output)
}

fn run_program(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<RunOutput, Box<dyn std::error::Error>> {
    let io_root = temp_root("program-io")?;
    let stdout_path = io_root.join("stdout");
    let stderr_path = io_root.join("stderr");
    fs::write(&stdout_path, [])?;
    fs::write(&stderr_path, [])?;
    let stdout_fd = open_write_fd(&stdout_path)?;
    let stderr_fd = open_write_fd(&stderr_path)?;
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if pid == 0 {
        if let Some(dir) = cwd {
            let Ok(dir_c) = cstring_path(dir) else {
                unsafe { _exit(124) };
            };
            if unsafe { chdir(dir_c.as_ptr()) } != 0 {
                unsafe { _exit(125) };
            }
        }
        if unsafe { dup2(stdout_fd, 1) } < 0 {
            unsafe { _exit(126) };
        }
        if unsafe { dup2(stderr_fd, 2) } < 0 {
            unsafe { _exit(126) };
        }
        let program_c = CString::new(program)?;
        let mut values = Vec::with_capacity(args.len() + 1);
        values.push(CString::new(program)?);
        for arg in args {
            values.push(CString::new(arg.as_str())?);
        }
        let mut pointers: Vec<*const i8> = values.iter().map(|value| value.as_ptr()).collect();
        pointers.push(std::ptr::null());
        unsafe { execvp(program_c.as_ptr(), pointers.as_ptr()) };
        unsafe { _exit(127) };
    }
    unsafe {
        close(stdout_fd);
        close(stderr_fd);
    }
    let mut status = 0;
    let waited = unsafe { waitpid(pid, &mut status, 0) };
    if waited != pid {
        return Err(io::Error::last_os_error().into());
    }
    let output = RunOutput {
        code: exit_code(status).unwrap_or(128),
        stdout: fs::read(&stdout_path)?,
        stderr: fs::read(&stderr_path)?,
    };
    fs::remove_dir_all(io_root)?;
    Ok(output)
}

fn open_write_fd(path: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    let path_c = cstring_path(path)?;
    let fd = unsafe { open(path_c.as_ptr(), 1) };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(fd)
}

fn cstring_path(path: &Path) -> Result<CString, Box<dyn std::error::Error>> {
    Ok(CString::new(path.as_os_str().as_bytes())?)
}

fn exit_code(status: i32) -> Option<i32> {
    if status & 0x7f == 0 {
        Some((status >> 8) & 0xff)
    } else {
        None
    }
}

fn make_executable(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn assert_executable(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(fs::metadata(path)?.permissions().mode() & 0o111, 0);
    Ok(())
}

fn temp_root(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-{label}-{}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&root)?;
    Ok(root)
}

unsafe extern "C" {
    fn fork() -> i32;
    fn execvp(file: *const i8, argv: *const *const i8) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    fn dup2(old_fd: i32, new_fd: i32) -> i32;
    fn chdir(path: *const i8) -> i32;
    fn open(path: *const i8, flags: i32) -> i32;
    fn close(fd: i32) -> i32;
    fn _exit(status: i32) -> !;
}
