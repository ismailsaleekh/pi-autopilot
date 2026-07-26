use kernel::boundary::Producer;
use kernel_macros::acceptance_boundary;

#[acceptance_boundary(
    id = "shape.wrong-return.v1",
    producer = Producer::Operator,
    visible = true,
    admits = "a value the producer can see"
)]
fn wrong_return(_: &str) -> String {
    String::new()
}

fn main() {}
