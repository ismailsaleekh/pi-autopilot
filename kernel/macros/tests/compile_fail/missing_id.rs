use kernel::boundary::{Producer, Rejection};
use kernel_macros::acceptance_boundary;

#[acceptance_boundary(
    producer = Producer::Operator,
    visible = true,
    admits = "a value the producer can see"
)]
fn no_id(_: &str) -> Result<String, Rejection> {
    Ok(String::new())
}

fn main() {}
