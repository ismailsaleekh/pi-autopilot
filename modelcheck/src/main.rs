use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    match Path::new("data/workflow.kdl").try_exists() {
        Ok(true) => {
            eprintln!("modelcheck not yet implemented (W2)");
            ExitCode::from(2)
        }
        Ok(false) => {
            println!("no workflow.kdl present");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("failed to inspect data/workflow.kdl: {error}");
            ExitCode::from(1)
        }
    }
}
