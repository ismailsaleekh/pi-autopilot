use kernel::boundary::{Producer, Rejection};
use kernel_macros::acceptance_boundary;

#[acceptance_boundary(
    id = "shape.hidden.v1",
    producer = Producer::Operator,
    visible = false,
    admits = "a value the producer can see"
)]
fn hidden_value(_: &str) -> Result<String, Rejection> {
    Ok(String::new())
}

fn main() {}
