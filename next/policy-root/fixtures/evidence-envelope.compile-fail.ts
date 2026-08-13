import type { EvidenceEnvelope } from "../../authority/protocol/evidence-fact.capsule.js";
import { evidenceFactCapsule } from "../../authority/protocol/evidence-fact.capsule.js";

const fact = evidenceFactCapsule.arbitrary.valid(402);

const forbiddenEnvelope: EvidenceEnvelope = fact.envelope;

void forbiddenEnvelope;
