use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let path = match (args.next(), args.next()) {
        (None, None) => "data/workflow.kdl".to_owned(),
        (Some(path), None) => path,
        _ => {
            eprintln!("usage: modelcheck [workflow.kdl]");
            return ExitCode::from(2);
        }
    };
    let report = modelcheck::run_path(Path::new(&path));
    print!("{}", report.stdout);
    eprint!("{}", report.stderr);
    ExitCode::from(report.exit_code)
}
