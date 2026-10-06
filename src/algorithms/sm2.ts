import type { Rating } from '../types.ts';
import {
  DAY_MS,
  ladderFrom,
  makeState,
  payloadFor,
  RATING_ORDER,
  type SchedulerAlgorithm,
} from './shared.ts';

/**
 * SuperMemo 2 (Wozniak, 1990), implemented as published.
 *
 * Included as a deliberately transparent baseline: roughly a dozen lines with
 * no fitted parameters, so the effect of a real forgetting-curve model (FSRS)
 * can be compared against it directly instead of taken on faith.
 *
 * Known weaknesses, which is why this is not the default: EF is a single
 * scalar conflating "how hard is this" with "how well did I just do", and
 * because only q=5 raises it, repeated passes at q=3–4 ratchet it down to the
 * 1.3 floor where interval growth stalls ("ease hell").
 */

const MIN_EF = 1.3;
const INITIAL_EF = 2.5;

type Sm2Payload = {
  /** Easiness factor. */
  ef: number;
  /** Most recently computed interval, in days. */
  intervalDays: number;
  /** Consecutive successful repetitions. */
  reps: number;
};

/**
 * Map our four ratings onto SM-2's 0–5 quality scale.
 *
 * `again` maps to 2 (below the 3 threshold) so it restarts the ladder, which
 * is SM-2's definition of a failed recall.
 */
function qualityFor(rating: Rating): number {
  switch (rating) {
    case 'again':
      return 2;
    case 'hard':
      return 3;
    case 'good':
      return 4;
    case 'easy':
      return 5;
  }
}

/**
 * The one computation both `review` and `ladder` go through.
 *
 * Kept as a single function rather than duplicated so the previewed interval
 * and the committed interval cannot drift apart.
 */
function outcomeFor(prior: Sm2Payload | null, rating: Rating): Sm2Payload {
  const ef = prior?.ef ?? INITIAL_EF;
  const previousInterval = prior?.intervalDays ?? 0;
  const previousReps = prior?.reps ?? 0;

  const quality = qualityFor(rating);

  if (quality < 3) {
    // SM-2 restarts the repetition ladder on a failed recall *without*
    // touching the E-Factor (that is the algorithm's explicit wording).
    return { ef, intervalDays: 1, reps: 0 };
  }

  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const nextEf = Math.max(MIN_EF, ef + delta);
  const reps = previousReps + 1;
  const intervalDays =
    reps === 1 ? 1 : reps === 2 ? 6 : Math.ceil(previousInterval * nextEf);

  return { ef: nextEf, intervalDays, reps };
}

export const sm2Algorithm: SchedulerAlgorithm = {
  id: 'sm2',
  label: 'SM-2',
  description: 'Classic SuperMemo 2. Simple and transparent, no fitted parameters.',
  schedules: true,
  review(previous, rating, ctx) {
    const data = outcomeFor(payloadFor(previous, 'sm2') as Sm2Payload | null, rating);

    return makeState({
      algorithm: 'sm2',
      due: ctx.now + data.intervalDays * DAY_MS,
      now: ctx.now,
      hash: ctx.hash,
      previous,
      data,
    });
  },
  ladder(previous, ctx) {
    const prior = payloadFor(previous, 'sm2') as Sm2Payload | null;
    return ladderFrom(
      RATING_ORDER,
      (rating) => outcomeFor(prior, rating).intervalDays,
      ctx.now
    );
  },
};
