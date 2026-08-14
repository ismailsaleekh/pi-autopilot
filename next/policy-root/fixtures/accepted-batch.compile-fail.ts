import type { PreparedCommit } from "../../authority/protocol/accepted-batch.js";
import { journalRecordCapsule } from "../../authority/protocol/journal-record.capsule.js";

const record = journalRecordCapsule.arbitrary.validForKind("run-genesis", 401);
const forbiddenCommit: PreparedCommit = {
  kind: "prepared-genesis",
  record,
};

void forbiddenCommit;
