use std::collections::HashSet;

use kernel::boundary::{
    BOUNDARIES, BoundaryDescriptor, BoundaryMode, BoundaryRuntime, BoundaryTransitionError,
    Producer, Rejection, boundary_by_id,
};
use kernel_macros::acceptance_boundary;

const MODEL_ID: &str = "shape.model.v1";
const MODEL_ADMITS: &str = "model text containing a signed count";
const OPERATOR_ID: &str = "shape.operator.v1";
const OPERATOR_ADMITS: &str = "operator text containing an approval word";
const RECORD_ID: &str = "shape.record.v1";
const RECORD_ADMITS: &str = "record text containing a captured payload";

#[acceptance_boundary(
    id = "shape.model.v1",
    producer = Producer::Model,
    visible = true,
    admits = "model text containing a signed count",
    mode = BoundaryMode::Enforce
)]
fn accept_model(raw: &str) -> Result<String, Rejection> {
    if raw.contains("count=") {
        Ok(raw.to_owned())
    } else {
        required_runtime(MODEL_ID).reject(raw)?;
        Ok(raw.to_owned())
    }
}

#[acceptance_boundary(
    id = "shape.operator.v1",
    producer = Producer::Operator,
    visible = true,
    admits = "operator text containing an approval word",
    mode = BoundaryMode::Enforce
)]
fn accept_operator(raw: &str) -> Result<String, Rejection> {
    if raw.contains("approve") {
        Ok(raw.to_owned())
    } else {
        required_runtime(OPERATOR_ID).reject(raw)?;
        Ok(raw.to_owned())
    }
}

#[acceptance_boundary(
    id = "shape.record.v1",
    producer = Producer::Model,
    visible = true,
    admits = "record text containing a captured payload",
    mode = BoundaryMode::Record
)]
fn accept_record(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    if raw.contains("capture=") {
        Ok(raw.to_owned())
    } else {
        runtime.reject(raw)?;
        Ok(format!("recorded:{raw}"))
    }
}

fn required_boundary(id: &str) -> &'static BoundaryDescriptor {
    match boundary_by_id(id) {
        Some(descriptor) => descriptor,
        None => panic!("missing boundary {id}"),
    }
}

fn required_runtime(id: &'static str) -> BoundaryRuntime {
    match BoundaryRuntime::new(required_boundary(id)) {
        Ok(runtime) => runtime,
        Err(error) => panic!("runtime missing for {id}: {error}"),
    }
}

fn assert_rejection(
    rejection: Rejection,
    boundary_id: &'static str,
    expected: &'static str,
    actual: &'static str,
) {
    assert_eq!(rejection.boundary_id(), boundary_id);
    assert_eq!(rejection.expected(), expected);
    assert_eq!(rejection.actual(), actual);
    assert!(rejection.producer_visible());
}

#[test]
fn malformed_values_return_shaped_rejections() {
    match accept_model("not a counted value") {
        Ok(value) => panic!("model boundary accepted {value}"),
        Err(rejection) => {
            assert_rejection(rejection, MODEL_ID, MODEL_ADMITS, "not a counted value")
        }
    }

    match accept_operator("please continue") {
        Ok(value) => panic!("operator boundary accepted {value}"),
        Err(rejection) => {
            assert_rejection(rejection, OPERATOR_ID, OPERATOR_ADMITS, "please continue")
        }
    }
}

#[test]
fn registry_lists_boundaries_with_unique_ids() {
    let ids: HashSet<&'static str> = BOUNDARIES.iter().map(BoundaryDescriptor::id).collect();

    assert!(ids.contains(MODEL_ID));
    assert!(ids.contains(OPERATOR_ID));
    assert!(ids.contains(RECORD_ID));
    assert_eq!(
        ids.len(),
        BOUNDARIES.len(),
        "duplicate boundary id in registry"
    );
}

#[test]
fn record_to_enforce_flip_is_one_way() {
    let descriptor = required_boundary(RECORD_ID);
    assert_eq!(descriptor.mode(), BoundaryMode::Record);
    assert_eq!(descriptor.admits(), RECORD_ADMITS);

    let mut runtime = required_runtime(RECORD_ID);
    assert_eq!(runtime.mode(), BoundaryMode::Record);

    match accept_record("bad value", &runtime) {
        Ok(value) => assert_eq!(value, "recorded:bad value"),
        Err(rejection) => panic!("record mode rejected {rejection:?}"),
    }

    runtime.flip_to_enforce();
    assert_eq!(runtime.mode(), BoundaryMode::Enforce);

    match accept_record("bad value", &runtime) {
        Ok(value) => panic!("enforce mode accepted {value}"),
        Err(rejection) => assert_rejection(rejection, RECORD_ID, RECORD_ADMITS, "bad value"),
    }

    assert_eq!(
        runtime.flip_to_record(),
        Err(BoundaryTransitionError::EnforceToRecordRefused { id: RECORD_ID })
    );
    assert_eq!(runtime.mode(), BoundaryMode::Enforce);
}

#[test]
fn descriptors_expose_producer_and_mode() {
    let model = required_boundary(MODEL_ID);
    let operator = required_boundary(OPERATOR_ID);
    let record = required_boundary(RECORD_ID);

    assert_eq!(model.producer(), Producer::Model);
    assert_eq!(operator.producer(), Producer::Operator);
    assert_eq!(record.mode(), BoundaryMode::Record);
}
