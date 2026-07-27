use std::env;
use std::io;
use std::path::PathBuf;

use drivers::seam::{self, CoreState};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let event_path = env::var_os("AUTOPILOT_CORE_EVENT_LOG").map(PathBuf::from);
    let mut state = CoreState::open(event_path)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    seam::run(stdin.lock(), &mut stdout, &mut state)?;
    Ok(())
}
