import { COORDINATOR_IMPLEMENTATION_BUILD } from "./runtime-constants.js";
export const UNIT_FAILURE_CURRENT_PRODUCER_GENERATION = 3;
export function currentUnitFailureProducerProvenance() {
    return Object.freeze({ producer_build: COORDINATOR_IMPLEMENTATION_BUILD, producer_generation: UNIT_FAILURE_CURRENT_PRODUCER_GENERATION });
}
export const BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS = Object.freeze({
    phase2Initial: '653f660e',
    captureCommitOnly: '9bbfa0d2',
});
