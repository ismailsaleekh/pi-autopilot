pub mod contracts;
pub mod emit;
pub mod kdl_read;
pub mod output;
pub mod table;

use std::fs;
use std::path::Path;

#[derive(Debug)]
pub struct Error(u8, String);
macro_rules! error_methods {($($t:tt)*)=>{$($t)*};}
impl Error {
    error_methods! { fn new(code:u8,message:impl Into<String>)->Self{Self(code,message.into())} pub fn usage(message:impl Into<String>)->Self{Self::new(64,message)} pub fn input(message:impl Into<String>)->Self{Self::new(2,message)} pub fn io(message:impl Into<String>)->Self{Self::new(1,message)} pub fn drift(message:impl Into<String>)->Self{Self::new(1,message)} pub fn exit_code(&self)->u8{self.0} }
}
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.1)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn run_cli(args: impl IntoIterator<Item = String>) -> Result<()> {
    let mut check = false;
    for arg in args {
        match arg.as_str() {
            "--check" => check = true,
            _ => return Err(Error::usage(format!("unknown argument: {arg}"))),
        }
    }
    run(Path::new("data/contracts.kdl"), check)
}

pub fn run(source_path: &Path, check: bool) -> Result<()> {
    let contracts = contracts::Contracts::read(source_path)?;
    let seam = table::TableDoc::read(
        &source_path.with_file_name("seam.kdl"),
        &contracts::SEAM_SPEC,
    )?;
    let host = table::TableDoc::read(
        &source_path.with_file_name("host-runtime.kdl"),
        &contracts::HOST_RUNTIME_SPEC,
    )?;
    let pi_rpc = table::TableDoc::read(
        &source_path.with_file_name("pi-rpc.kdl"),
        &contracts::PI_RPC_SPEC,
    )?;
    let recovery = fs::read_to_string(source_path.with_file_name("recovery.kdl"))
        .map_err(|error| Error::io(format!("read recovery.kdl: {error}")))?;
    contracts.validate_seam(&seam)?;
    contracts.validate_host_runtime(&host, &seam)?;
    let outputs = emit::emit_all(&contracts, &seam, &host, &pi_rpc, &recovery)?;
    if check {
        output::check_outputs(&outputs)
    } else {
        output::write_outputs(&outputs)
    }
}
