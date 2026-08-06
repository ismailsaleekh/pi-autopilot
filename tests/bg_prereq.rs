use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use drivers::bgtasks::{BgCapabilities, BgCapability, require_before_mutation};
use kernel::failure::{Failure, OperatorDecision};

#[test]
fn missing_background_task_capability_pauses_before_any_mutation()
-> Result<(), Box<dyn std::error::Error>> {
    for (label, caps, tool) in [
        (
            "run",
            BgCapabilities {
                run: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Run,
        ),
        (
            "is-agent",
            BgCapabilities {
                run_is_agent: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Run,
        ),
        (
            "trigger",
            BgCapabilities {
                run_completion_trigger: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Run,
        ),
        (
            "status",
            BgCapabilities {
                status: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Status,
        ),
        (
            "logs",
            BgCapabilities {
                logs: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Logs,
        ),
        (
            "bounded-logs",
            BgCapabilities {
                logs_bounded: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Logs,
        ),
        (
            "kill",
            BgCapabilities {
                stop: false,
                ..BgCapabilities::complete()
            },
            BgCapability::Kill,
        ),
    ] {
        let root = temp_root(label)?;
        let target = root.join("mutation");
        let result = require_before_mutation(&caps, None, || {
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("artifact"), b"mutated").unwrap();
        });
        let error = result.unwrap_err();
        assert_eq!(error.capability, tool);
        assert_eq!(
            error.failure,
            Failure::Paused {
                needs: OperatorDecision::SupplyCapability
            }
        );
        assert!(error.instruction.contains("pi-background-tasks 2.1.1"));
        assert!(error.instruction.contains("reload/restart"));
        assert!(!target.exists(), "{label} created a directory");
        assert!(!target.join("artifact").exists(), "{label} created a file");
        fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn complete_background_task_capability_allows_mutation() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("complete")?;
    let target = root.join("mutation");
    match require_before_mutation(&BgCapabilities::complete(), None, || {
        fs::create_dir_all(&target)
    }) {
        Ok(result) => result?,
        Err(error) => return Err(format!("unexpected pause: {error:?}").into()),
    }
    assert!(target.exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

fn temp_root(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-bg-{label}-{}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&root)?;
    Ok(root)
}
