import assert from "node:assert/strict";
import test from "node:test";
import { gitLawVector } from "../../ports/laws/git.vectors.js";
import { workspaceLawVector } from "../../ports/laws/workspace.vectors.js";

/**
 * Registration anchor: real replay lives beside OS fixtures under
 * testkit/real-adapters. This suite protects the centrally owned vector IDs from
 * replacement by adapter-local lookalikes.
 */
test("Git/workspace parity uses the frozen centrally owned vectors", () => {
  assert.equal(gitLawVector.id, "git.materialize-seal-integrate-cas.v1");
  assert.equal(workspaceLawVector.id, "workspace.allocate-isolate-inspect-dispose.v1");
  assert.equal(gitLawVector.port, "git");
  assert.equal(workspaceLawVector.port, "workspace");
});
