use kernel::boundary::{Producer, Rejection};
use kernel_macros::acceptance_boundary;

#[acceptance_boundary(
    id = "shape.no-admits.v1",
    producer = Producer::Operator,
    visible = true
)]
fn no_admits(_: &str) -> Result<String, Rejection> {
    Ok(String::new())
}

fn main() {}
