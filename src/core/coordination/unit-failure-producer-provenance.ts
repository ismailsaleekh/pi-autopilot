import { COORDINATOR_IMPLEMENTATION_BUILD } from './runtime-constants.ts';

export const UNIT_FAILURE_CURRENT_PRODUCER_GENERATION = 3 as const;

export interface CurrentUnitFailureProducerProvenance {
  readonly producer_build: typeof COORDINATOR_IMPLEMENTATION_BUILD;
  readonly producer_generation: typeof UNIT_FAILURE_CURRENT_PRODUCER_GENERATION;
}

export function currentUnitFailureProducerProvenance(): CurrentUnitFailureProducerProvenance {
  return Object.freeze({ producer_build: COORDINATOR_IMPLEMENTATION_BUILD, producer_generation: UNIT_FAILURE_CURRENT_PRODUCER_GENERATION });
}

export const BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS = Object.freeze({
  phase2Initial: '653f660e',
  captureCommitOnly: '9bbfa0d2',
} as const);
