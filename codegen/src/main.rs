use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    for arg in std::env::args().skip(1) {
        if arg != "--check" {
            eprintln!("unknown argument: {arg}");
            return ExitCode::from(64);
        }
    }

    match Path::new("data/contracts.kdl").try_exists() {
        Ok(true) => {
            eprintln!("codegen not yet implemented (W0-4)");
            ExitCode::from(2)
        }
        Ok(false) => {
            println!("no contracts are present yet");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("failed to inspect data/contracts.kdl: {error}");
            ExitCode::from(1)
        }
    }
}
