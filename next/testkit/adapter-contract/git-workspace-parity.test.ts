import assert from "node:assert/strict";
import test from "node:test";
import { PORT_LAW_VECTORS } from "../../ports/laws/vectors.js";

/** Registration anchor: parity suites must consume exactly the six central Amendment-002 vectors. */
test("adapter parity is anchored to exactly the six centrally owned vectors", () => {
  assert.equal(PORT_LAW_VECTORS.length, 6);
  assert.deepEqual(PORT_LAW_VECTORS.map((vector) => vector.id).sort(), [
    "child.route-before-launch-continuation-reseed.v2",
    "clock.decimal-monotonic-source.v2",
    "git.explicit-identities-unborn-serial-integration.v2",
    "secrets.opaque-purpose-destination-revoke.v2",
    "store.codec-decimal-proof-paging.v2",
    "workspace.empty-reservation-lease-epoch.v2",
  ]);
  assert.deepEqual(PORT_LAW_VECTORS.map((vector) => vector.port).sort(), ["child", "clock", "git", "secrets", "store", "workspace"]);
});
