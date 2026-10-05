import { makeState, type SchedulerAlgorithm } from './shared.ts';

/**
 * The original IntelliScroll behaviour: a shuffled feed with no scheduling.
 *
 * This is the default, so upgrading a vault never changes what the user sees.
 * Its output is byte-identical to the pre-SRS `selectBatch`.
 */
export const offAlgorithm: SchedulerAlgorithm = {
  id: 'off',
  label: 'Off',
  description: 'Keep the original shuffled feed. No scheduling.',
  schedules: false,
  review(previous, _rating, ctx) {
    // Unreachable in practice: callers check `schedules` first, and the feed
    // never records reviews while this algorithm is selected. Implemented so
    // the registry stays total and callers need no special case.
    return makeState({
      algorithm: 'off',
      due: ctx.now,
      now: ctx.now,
      hash: ctx.hash,
      previous,
      data: {},
    });
  },
};
