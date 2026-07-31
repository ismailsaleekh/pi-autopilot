use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::{Error, Result};

#[derive(Debug)]
pub struct OutputFile {
    pub path: PathBuf,
    pub content: String,
}

pub fn check_outputs(outputs: &[OutputFile]) -> Result<()> {
    let expected = expected_set(outputs);
    for path in existing()? {
        if !expected.contains(&path) {
            return Err(Error::drift(format!(
                "generated output drift: unexpected file {}",
                path.display()
            )));
        }
    }
    for output in outputs {
        let actual = read(&output.path)?;
        if actual != output.content {
            return Err(Error::drift(first_diff(
                &output.path,
                &actual,
                &output.content,
            )));
        }
    }
    Ok(())
}

pub fn write_outputs(outputs: &[OutputFile]) -> Result<()> {
    let expected = expected_set(outputs);
    for path in existing()? {
        if !expected.contains(&path) {
            fs(&path, |p| std::fs::remove_file(p))?;
        }
    }
    for output in outputs {
        if let Some(parent) = output.path.parent() {
            fs(parent, |p| std::fs::create_dir_all(p))?;
        }
        let tmp = output
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        fs(&tmp, |p| std::fs::write(p, output.content.as_bytes()))?;
        std::fs::rename(&tmp, &output.path)
            .map_err(|e| Error::io(format!("failed to replace {}: {e}", output.path.display())))?;
    }
    Ok(())
}

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| {
        Error::drift(format!(
            "generated output drift: {} missing or unreadable: {e}",
            path.display()
        ))
    })
}
fn expected_set(outputs: &[OutputFile]) -> BTreeSet<PathBuf> {
    outputs.iter().map(|output| output.path.clone()).collect()
}
fn existing() -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for dir in [
        "kernel/src/generated",
        "src/generated",
        "generated/prompts",
        "drivers/src/generated",
    ] {
        if Path::new(dir).exists() {
            for entry in WalkDir::new(dir) {
                let entry = entry.map_err(|e| Error::io(format!("walk {dir}: {e}")))?;
                if entry.file_type().is_file() {
                    out.push(entry.path().to_path_buf());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}
fn fs(path: &Path, op: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<()> {
    op(path).map_err(|e| {
        Error::io(format!(
            "filesystem operation failed for {}: {e}",
            path.display()
        ))
    })
}

macro_rules! first_diff_fn {($($t:tt)*)=>{$($t)*};}
first_diff_fn! { pub fn first_diff(path:&Path,actual:&str,expected:&str)->String{let actual=actual.lines().collect::<Vec<_>>();let expected=expected.lines().collect::<Vec<_>>();for index in 0..actual.len().max(expected.len()){let a=actual.get(index).copied().unwrap_or("<EOF>");let e=expected.get(index).copied().unwrap_or("<EOF>");if a!=e{return format!("generated output drift: {} first differing line {} (actual `{a}`, expected `{e}`)",path.display(),index+1);}}format!("generated output drift: {} differs",path.display())} }
