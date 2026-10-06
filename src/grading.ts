import {
  AUTO_RATING,
  type Rating,
  type Sensitivity,
  type SensitivityThresholds,
} from './types.ts';

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
 * What each preset stands for. The settings page renders these, so they are
 * data rather than branches — a preset the user cannot inspect is a setting
 * they cannot reason about.
 *
 * Built from `DWELL_LOW_MS` / `DWELL_HIGH_MS` so the numbers the settings page
 * displays cannot drift from the numbers the grader actually uses.
 */
export const SENSITIVITY_THRESHOLDS: Record<
  Exclude<Sensitivity, 'custom'>,
  SensitivityThresholds
> = {
  // Only an explicit open counts; dwell is not trusted enough to move a
  // schedule, so `engagedMs` is deliberately unused.
  conservative: { openedOnly: true, engagedMs: DWELL_HIGH_MS },
  medium: { openedOnly: false, engagedMs: DWELL_HIGH_MS },
  // Any real dwell counts, so intervals advance faster.
  aggressive: { openedOnly: false, engagedMs: DWELL_LOW_MS },
};

/**
 * Collapse a possibly-untrustworthy custom threshold into one that is safe to
 * compare against.
 *
 * The values arrive from persisted settings, which may predate or outlive this
 * code, so a field that is not a boolean or not a finite, non-negative number
 * falls back to the medium preset rather than being trusted. A `NaN` threshold
 * would make every comparison false and silently freeze scheduling.
 */
function sanitizeThresholds(
  custom: SensitivityThresholds | undefined
): SensitivityThresholds {
  const fallback = SENSITIVITY_THRESHOLDS.medium;
  if (!custom) return fallback;

  const openedOnly =
    typeof custom.openedOnly === 'boolean'
      ? custom.openedOnly
      : fallback.openedOnly;
  const engagedMs =
    typeof custom.engagedMs === 'number' &&
    Number.isFinite(custom.engagedMs) &&
    custom.engagedMs >= 0
      ? custom.engagedMs
      : fallback.engagedMs;

  return { openedOnly, engagedMs };
}

/**
 * Resolve a setting to concrete thresholds. `custom` falls back to `medium`
 * when unspecified.
 */
export function thresholdsFor(
  sensitivity: Sensitivity,
  custom?: SensitivityThresholds
): SensitivityThresholds {
  if (sensitivity === 'custom') return sanitizeThresholds(custom);
  return SENSITIVITY_THRESHOLDS[sensitivity];
}

/**
 * What a threshold demands, as data rather than as a sentence.
 *
 * Deliberately a tag, not a string: the settings page is localized, and a
 * module that returned English frame text would drop an untranslatable phrase
 * into the middle of a Chinese page. The caller owns the wording; this owns the
 * numbers. Same split as `format.ts` and `longPress.ts`.
 */
export type ThresholdDemand =
  | { kind: 'openedOnly' }
  | { kind: 'dwell'; ms: number };

export function thresholdDemand(
  thresholds: SensitivityThresholds
): ThresholdDemand {
  return thresholds.openedOnly
    ? { kind: 'openedOnly' }
    : { kind: 'dwell', ms: thresholds.engagedMs };
}

/**
 * Decide whether a card's showing counts as engagement.
 *
 * The thresholds only decide how much evidence is demanded before advancing a
 * note's schedule — none of them ever produce a negative rating, because
 * behaviour cannot justify one.
 */
export function gradeEngagement(
  signals: EngagementSignals,
  thresholds: SensitivityThresholds
): EngagementVerdict {
  // Opening the note is the strongest signal available and always counts.
  if (signals.opened) return 'engaged';

  if (thresholds.openedOnly) return 'unengaged';

  const dwell = clampDwell(signals.dwellMs);
  return dwell >= thresholds.engagedMs ? 'engaged' : 'unengaged';
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
