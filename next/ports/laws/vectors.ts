import type { ContractVector } from "./contract-vector.js";
import { childLawVector } from "./child.vectors.js";
import { clockLawVector } from "./clock.vectors.js";
import { gitLawVector } from "./git.vectors.js";
import { secretsLawVector } from "./secrets.vectors.js";
import { storeLawVector } from "./store.vectors.js";
import { workspaceLawVector } from "./workspace.vectors.js";

export {
  childLawVector,
  clockLawVector,
  gitLawVector,
  secretsLawVector,
  storeLawVector,
  workspaceLawVector,
};

export const PORT_LAW_VECTORS: readonly ContractVector[] = Object.freeze([
  childLawVector,
  clockLawVector,
  gitLawVector,
  secretsLawVector,
  storeLawVector,
  workspaceLawVector,
]);
