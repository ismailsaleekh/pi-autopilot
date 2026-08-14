import { stateDigest } from "../../authority/model/run-state.js";
import { nonemptyScenario } from "../scenario-harness/authority.js";

const seedText = process.argv[2] ?? "1";
const seed = Number.parseInt(seedText, 10);
if (!Number.isSafeInteger(seed)) {
  process.stderr.write("invalid seed\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${stateDigest(nonemptyScenario(seed).state)}\n`);
}
