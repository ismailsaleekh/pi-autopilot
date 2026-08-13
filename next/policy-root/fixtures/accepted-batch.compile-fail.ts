interface AcceptedBatch {
  readonly opaque: unique symbol;
}

const forbiddenBatch: AcceptedBatch = {};

void forbiddenBatch;
