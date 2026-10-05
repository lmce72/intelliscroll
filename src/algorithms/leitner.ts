import { DAY_MS, makeState, payloadFor, type SchedulerAlgorithm } from './shared.ts';

/**
 * Leitner box system: a fixed ladder of intervals, two grades.
 *
 * The classic method is the most passive-feed-friendly of the traditional
 * schemes because it needs only "got it" / "didn't", with no self-assessed
 * degree of difficulty. Included as the simplest possible counterpoint to
 * FSRS — if the forgetting curve earns its complexity, the difference should
 * be visible against this.
 */

const BOX_INTERVALS_DAYS = [1, 3, 7, 16, 35, 75, 160];
const LAST_BOX = BOX_INTERVALS_DAYS.length - 1;

type LeitnerPayload = {
  /** Index into BOX_INTERVALS_DAYS. */
  box: number;
};

export const leitnerAlgorithm: SchedulerAlgorithm = {
  id: 'leitner',
  label: 'Leitner',
  description: 'Fixed interval ladder with two grades. The simplest option.',
  schedules: true,
  review(previous, rating, ctx) {
    const prior = payloadFor(previous, 'leitner') as LeitnerPayload | null;
    // A brand-new note sits "before" box 0, so its first success lands on the
    // 1-day box rather than skipping straight to 3 days.
    const currentBox = prior ? prior.box : -1;

    let nextBox: number;
    switch (rating) {
      case 'again':
        nextBox = 0;
        break;
      case 'hard':
        // Holding position is the only "hard" response a two-grade scheme can
        // express without a separate interval multiplier.
        nextBox = Math.max(0, currentBox);
        break;
      default:
        nextBox = Math.min(LAST_BOX, currentBox + 1);
        break;
    }

    const intervalDays = BOX_INTERVALS_DAYS[nextBox] ?? 1;

    return makeState({
      algorithm: 'leitner',
      due: ctx.now + intervalDays * DAY_MS,
      now: ctx.now,
      hash: ctx.hash,
      previous,
      data: { box: nextBox } satisfies LeitnerPayload,
    });
  },
};
