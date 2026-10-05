import type {
  AlgorithmId,
  FsrsTunables,
  NoteSrsState,
  Rating,
} from '../types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything a scheduler needs that isn't the note's own state. */
export interface ReviewContext {
  /** Epoch ms of the review. */
  now: number;
  /** Content hash of the note at review time. */
  hash: string;
  /** FSRS tunables. Only the FSRS algorithm reads these. */
  fsrs: FsrsTunables;
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
 * True when a note is due for resurfacing.
 *
 * Notes with no state have never been reviewed and are always considered due,
 * so a fresh vault drains into the feed instead of stalling.
 */
export function isDue(state: NoteSrsState | undefined, now: number): boolean {
  if (!state) return true;
  return state.due <= now;
}
