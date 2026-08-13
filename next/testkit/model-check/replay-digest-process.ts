import { foldAll } from "../../authority/evolution/index.js";
import { stateDigest } from "../../authority/model/index.js";
import {
  domainFactCapsule,
  journalRecordCapsule,
} from "../../authority/protocol/aggregate.generated.js";
import { canonicalDecisionFactsDigest } from "../../authority/protocol/journal-record.capsule.js";

const parsedSeed = Number(process.argv[2] ?? "0");
const seed = Number.isSafeInteger(parsedSeed) ? parsedSeed : 0;
const generatedGenesis = journalRecordCapsule.arbitrary.validForKind("run-genesis", seed);
const requirements = domainFactCapsule.arbitrary.validForKind("requirements-bound", seed + 1);
const decision = journalRecordCapsule.arbitrary.validForKind("decision-committed", seed + 2);

if (
  generatedGenesis.kind !== "run-genesis"
  || requirements.kind !== "requirements-bound"
  || decision.kind !== "decision-committed"
) {
  process.stderr.write("arbitrary kind mismatch");
  process.exitCode = 1;
} else {
  const genesis = generatedGenesis;
  const facts = Object.freeze([Object.freeze({ ...requirements, runId: genesis.runId })]);
  const committed = journalRecordCapsule.decode({
    ...decision,
    runId: genesis.runId,
    sequence: genesis.sequence + 1,
    facts,
    factRoot: canonicalDecisionFactsDigest(facts),
  });
  if (committed.kind === "error" || committed.value.kind !== "decision-committed") {
    process.stderr.write("decision binding failed");
    process.exitCode = 1;
  } else {
    const result = foldAll(genesis, [committed.value]);
    if (result.kind === "rejected") {
      process.stderr.write(result.error.code);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${stateDigest(result.state)}\n`);
    }
  }
}
