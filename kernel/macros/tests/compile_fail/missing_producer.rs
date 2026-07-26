use kernel::boundary::Rejection;
use kernel_macros::acceptance_boundary;

#[acceptance_boundary(
    id = "shape.no-producer.v1",
    visible = true,
    admits = "a value the producer can see"
)]
fn no_producer(_: &str) -> Result<String, Rejection> {
    Ok(String::new())
}

fn main() {}
