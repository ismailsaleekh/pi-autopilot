use kernel::boundary::Rejection;

fn main() {
    let _value = Rejection {
        boundary_id: "shape.direct.v1",
        expected: String::from("declared rule"),
        actual: String::from("raw value"),
        producer_visible: true,
    };
}
