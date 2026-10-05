import { AUTO_RATING, type Rating, type Sensitivity } from './types.ts';

/**
 * Turn observed behaviour into a grading decision.
 *
 * The hard rule this module exists to enforce: **automatic grading may only
 * ever produce `AUTO_RATING` ('good')**. Behaviour can distinguish "engaged"
 * from "not engaged"; it cannot judge how well something was recalled.
 * Behavioural proxies match explicit ratings only about 65% of the time, and
 * no published work infers recall quality from reading behaviour at all.
 *
 * So a skip is never a failed review. It is the *absence* of a review, and it
 * is reported as `'unengaged'` so the caller can raise the note's selection
 * priority without touching its schedule. Feeding skips into a scheduler as
 * failures would fabricate lapses, inflate difficulty, collapse stability, and
 * create a spiral where skipped notes are shown more often and therefore
 * skipped more.
 */

/** Dwell below this counts as barely looked at. */
export const DWELL_LOW_MS = 3_000;
/** Dwell at or above this counts as actually read. */
export const DWELL_HIGH_MS = 15_000;

/**
 * Upper bound on a single dwell sample.
 *
 * Dwell is measured with timestamps rather than by accumulating animation
 * frames, because this vault has a measured failure mode where
 * `requestAnimationFrame` stops firing while a pane is hidden. A pane that is
 * switched away from and back could otherwise report hours of dwell. Anything
 * beyond this bound is treated as "we cannot know" and capped.
 */
export const MAX_DWELL_SAMPLE_MS = 5 * 60 * 1000;

export type EngagementVerdict = 'engaged' | 'unengaged';

export interface EngagementSignals {
  /** The user opened the note out of the feed. */
  opened: boolean;
  /** Milliseconds the card was visible in the viewport. */
  dwellMs: number;
}

/** Clamp a dwell sample into a sane range. */
export function clampDwell(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_DWELL_SAMPLE_MS);
}

/**
 * Decide whether a card's showing counts as engagement.
 *
 * The three sensitivity settings differ only in how much evidence they demand
 * before advancing a note's schedule — none of them ever produce a negative
 * rating, because behaviour cannot justify one.
 */
export function gradeEngagement(
  signals: EngagementSignals,
  sensitivity: Sensitivity
): EngagementVerdict {
  // Opening the note is the strongest signal available and always counts.
  if (signals.opened) return 'engaged';

  const dwell = clampDwell(signals.dwellMs);

  switch (sensitivity) {
    case 'conservative':
      // Only an explicit open counts; dwell is not trusted enough to move a
      // schedule.
      return 'unengaged';
    case 'aggressive':
      // Any real dwell counts, so intervals advance faster.
      return dwell >= DWELL_LOW_MS ? 'engaged' : 'unengaged';
    case 'medium':
    default:
      return dwell >= DWELL_HIGH_MS ? 'engaged' : 'unengaged';
  }
}

/**
 * The rating an automatic verdict maps to, or null when the note should not be
 * reviewed at all.
 *
 * This exists so the "automatic grading never invents a negative rating" rule
 * lives in exactly one testable place. If this function ever gains a branch
 * that returns anything other than `AUTO_RATING`, the test suite will catch it.
 */
export function ratingForVerdict(verdict: EngagementVerdict): Rating | null {
  return verdict === 'engaged' ? AUTO_RATING : null;
}
