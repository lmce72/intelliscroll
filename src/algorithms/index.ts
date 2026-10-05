import { ALGORITHM_IDS, type AlgorithmId } from '../types.ts';
import { fsrsAlgorithm } from './fsrs.ts';
import { leitnerAlgorithm } from './leitner.ts';
import { offAlgorithm } from './off.ts';
import { sm2Algorithm } from './sm2.ts';
import type { SchedulerAlgorithm } from './shared.ts';

export {
  DAY_MS,
  isDue,
  makeState,
  payloadFor,
  type ReviewContext,
  type SchedulerAlgorithm,
} from './shared.ts';

const REGISTRY: Record<AlgorithmId, SchedulerAlgorithm> = {
  off: offAlgorithm,
  fsrs: fsrsAlgorithm,
  sm2: sm2Algorithm,
  leitner: leitnerAlgorithm,
};

export function getAlgorithm(id: AlgorithmId): SchedulerAlgorithm {
  return REGISTRY[id];
}

/** Every algorithm, in the order shown in settings. */
export function allAlgorithms(): SchedulerAlgorithm[] {
  return ALGORITHM_IDS.map((id) => REGISTRY[id]);
}
