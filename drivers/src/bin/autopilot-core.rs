use std::env;
use std::io;
use std::path::PathBuf;

use drivers::seam::{self, CoreState};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "agent-run") {
        if let Err(error) = drivers::runner::child::main(&args[1..]) {
            eprintln!("autopilot-core agent-run: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }

    let event_path = env::var_os("AUTOPILOT_CORE_EVENT_LOG").map(PathBuf::from);
    let mut state = CoreState::open(event_path)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    seam::run(stdin.lock(), &mut stdout, &mut state)?;
    Ok(())
}
