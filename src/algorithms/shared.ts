import type {
  AlgorithmId,
  FsrsTunables,
  NoteSrsState,
  Rating,
} from '../types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rating order used by every ladder, ascending by interval.
 *
 * For FSRS this is also the library's own grade order. For SM-2 and Leitner it
 * is the order that *usually* ascends; a scheme can produce ties (SM-2's first
 * repetition gives every passing grade the same day), and ties are honest — the
 * ladder keeps the order given here rather than inventing a spread.
 */
export const RATING_ORDER: readonly Rating[] = [
  'again',
  'hard',
  'good',
  'easy',
];

/** Everything a scheduler needs that isn't the note's own state. */
export interface ReviewContext {
  /** Epoch ms of the review. */
  now: number;
  /** Content hash of the note at review time. */
  hash: string;
  /** FSRS tunables. Only the FSRS algorithm reads these. */
  fsrs: FsrsTunables;
}

/**
 * Where one grade would send a note, without committing to it.
 *
 * This is a "what if" — the caller asks what each rating would do and shows
 * the answers. It must not be confused with `review()`, the committed path,
 * and it must never be used to decide scheduling by itself.
 */
export interface LadderStep {
  /** The algorithm's own grade. Never an interpolated tier. */
  rating: Rating;
  /** Epoch ms the note would next be due. */
  due: number;
  /** `due - ctx.now` in days: what a press actually schedules. */
  intervalDays: number;
  /**
   * The interval the model computed, before ts-fsrs rounds it to whole days
   * and pushes it along its ordering staircase.
   *
   * These diverge, and the gap is the point. FSRS computes a fractional
   * interval from the card's stability, then rounds it and forces each grade
   * at least a day past the previous one — so for a card reviewed earlier the
   * same day, the model has genuinely different intentions per grade (say
   * 2.3 / 2.3 / 2.3 days) while the committed values are 2 / 3 / 4. Showing
   * only the committed number makes the retention control look broken, because
   * sweeping it changes the model's value by a factor of ten while every
   * rounded value stays put.
   *
   * The cap is applied (it is a real bound the user set) but neither the
   * one-day floor nor the rounding is, so a sub-day intention stays visible.
   * Callers that must not mislead should show this *and* say what commits.
   */
  modelDays: number;
}

export interface SchedulerAlgorithm {
  readonly id: AlgorithmId;
  /** Display name shown in settings. */
  readonly label: string;
  /** One-line description shown in settings. */
  readonly description: string;
  /**
   * False for `off`, which keeps the original shuffled feed and never
   * schedules anything. Callers must check this before invoking `review`.
   */
  readonly schedules: boolean;
  /**
   * Compute the next state after a review.
   *
   * Pure: no I/O, no clock reads (time arrives via `ctx.now`), no randomness.
   * Automatic grading may only pass `'good'` — see the note on `Rating`.
   */
  review(
    previous: NoteSrsState | null,
    rating: Rating,
    ctx: ReviewContext
  ): NoteSrsState;
  /**
   * Every grade's outcome from the note's current state, ascending by
   * interval.
   *
   * Required to agree with `review()`: for every step,
   * `review(previous, step.rating, ctx).due` must equal `step.due`. Algorithms
   * share one internal computation between the two rather than writing the
   * ladder twice — a preview that disagreed with what a press actually does
   * would be worse than showing nothing.
   *
   * `off` returns an empty list: a shuffled feed has no grades.
   */
  ladder(previous: NoteSrsState | null, ctx: ReviewContext): LadderStep[];
}

/**
 * Read an algorithm's payload out of a stored state.
 *
 * Returns null when the state came from a different algorithm, so switching
 * algorithms starts the new one fresh. The review log and the state's
 * bookkeeping fields (reviews, lastReviewedAt) survive the switch — only the
 * algorithm-specific payload resets.
 */
export function payloadFor(
  previous: NoteSrsState | null,
  id: AlgorithmId
): Record<string, unknown> | null {
  if (!previous || previous.algorithm !== id) return null;
  return previous.data;
}

/**
 * Assemble the next state from an algorithm's computed due date and payload.
 * Shared so every algorithm increments `reviews` and clears `unengagedAt`
 * identically.
 */
export function makeState(params: {
  algorithm: AlgorithmId;
  due: number;
  now: number;
  hash: string;
  previous: NoteSrsState | null;
  data: Record<string, unknown>;
}): NoteSrsState {
  return {
    algorithm: params.algorithm,
    due: params.due,
    lastReviewedAt: params.now,
    reviews: (params.previous?.reviews ?? 0) + 1,
    hash: params.hash,
    data: params.data,
    // `unengagedAt` is deliberately absent: a real review supersedes the
    // "shown but not engaged" marker.
  };
}

/**
 * Build a ladder from a per-rating interval function, sorted into ascending
 * order.
 *
 * The single place a ladder is assembled, so every algorithm is previewed the
 * same way. `sort` is stable, so ratings that tie keep `RATING_ORDER`.
 */
export function ladderFrom(
  ratings: readonly Rating[],
  intervalDaysFor: (rating: Rating) => number,
  now: number,
  modelDaysFor?: (rating: Rating) => number
): LadderStep[] {
  return ratings
    .map((rating) => {
      const intervalDays = intervalDaysFor(rating);
      return {
        rating,
        due: now + intervalDays * DAY_MS,
        intervalDays,
        // Algorithms that schedule in whole days already have nothing to
        // round, so the two coincide unless one says otherwise.
        modelDays: modelDaysFor ? modelDaysFor(rating) : intervalDays,
      };
    })
    .sort((a, b) => a.intervalDays - b.intervalDays);
}

/**
 * True when a note is due for resurfacing.
 *
 * Notes with no state have never been reviewed and are always considered due,
 * so a fresh vault drains into the feed instead of stalling.
 */
export function isDue(state: NoteSrsState | undefined, now: number): boolean {
  if (!state) return true;
  return state.due <= now;
}
