use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use drivers::recovery::{FileAssignmentLock, LockAcquire, ProcessBirthIdentity, ProcessProbe};
use kernel::generated::Id;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn pid_reuse_with_different_birth_identity_is_stale_not_live()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("pid-reuse")?;
    let holder_pid = 41;
    let new_runner_pid = std::process::id();
    let stale_bytes = format!("pid={holder_pid}\nbirth=old-process-birth\n");
    fs::write(root.join("a1.lock"), stale_bytes.as_bytes())?;

    let probe = IdentityProbe {
        live_pid: holder_pid,
        live_birth: "unrelated-current-process-birth".to_owned(),
        owner_pid: new_runner_pid,
        owner_birth: "new-runner-birth".to_owned(),
    };
    let acquire = FileAssignmentLock::acquire(&root, &id("a1"), new_runner_pid, &probe);

    assert_ne!(acquire, LockAcquire::HeldByLive { pid: holder_pid });
    assert_recovery_has_no_kill_path()?;
    match acquire {
        LockAcquire::Acquired(lock) => {
            assert_eq!(lock.pid(), new_runner_pid);
            assert_eq!(lock.birth_identity().0, "new-runner-birth");
            assert_eq!(
                fs::read(root.join("stale-lock-evidence"))?,
                stale_bytes.as_bytes()
            );
            assert_eq!(
                fs::read_to_string(root.join("a1.lock"))?,
                format!("pid={new_runner_pid}\nbirth=new-runner-birth\n")
            );
            lock.release()?;
        }
        LockAcquire::Degraded { reason } => {
            assert!(
                reason.starts_with("lock-holder-identity") || reason.starts_with("stale-lock"),
                "degraded stale identity reason must be typed, got {reason}"
            );
        }
        LockAcquire::HeldByLive { .. } => unreachable!("asserted above"),
    }

    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn matching_live_holder_still_visible_waits() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("genuine-live")?;
    let holder_pid = 41;
    let new_runner_pid = std::process::id();
    fs::write(
        root.join("a1.lock"),
        format!("pid={holder_pid}\nbirth=original-holder-birth\n"),
    )?;

    let probe = IdentityProbe {
        live_pid: holder_pid,
        live_birth: "original-holder-birth".to_owned(),
        owner_pid: new_runner_pid,
        owner_birth: "new-runner-birth".to_owned(),
    };
    let acquire = FileAssignmentLock::acquire(&root, &id("a1"), new_runner_pid, &probe);

    assert_eq!(acquire, LockAcquire::HeldByLive { pid: holder_pid });
    assert_recovery_has_no_kill_path()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

struct IdentityProbe {
    live_pid: u32,
    live_birth: String,
    owner_pid: u32,
    owner_birth: String,
}

impl ProcessProbe for IdentityProbe {
    fn is_live(&self, pid: u32) -> bool {
        pid == self.live_pid || pid == self.owner_pid
    }

    fn birth_identity(&self, pid: u32) -> Result<Option<ProcessBirthIdentity>, String> {
        if pid == self.live_pid {
            Ok(Some(ProcessBirthIdentity(self.live_birth.clone())))
        } else if pid == self.owner_pid {
            Ok(Some(ProcessBirthIdentity(self.owner_birth.clone())))
        } else {
            Ok(None)
        }
    }
}

fn assert_recovery_has_no_kill_path() -> Result<(), Box<dyn std::error::Error>> {
    let source =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/recovery/mod.rs"))?;
    assert!(
        !source.contains("kill"),
        "recovery lock code must not kill unrelated processes"
    );
    Ok(())
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}

fn temp_root(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-stale-lock-{label}-{}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&root)?;
    Ok(root)
}
