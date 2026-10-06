import type { LadderStep } from './algorithms/index.ts';
import type { Rating } from './types.ts';

/**
 * A single rung of the displayed ladder.
 *
 * `anchor` marks a rung the scheduling algorithm itself produced; only those
 * carry a `rating`, because only those are things a press can actually commit.
 * Every other rung is interpolated for display and has no grade behind it.
 */
export interface Tier {
  /** 1-based position, ascending by interval. */
  tier: number;
  /** Epoch ms this tier would schedule. */
  due: number;
  /** Interval in days. Fractional. */
  intervalDays: number;
  /** The algorithm's own grade, present only when `anchor` is true. */
  rating?: Rating;
  anchor: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Smallest positive interval a logarithm is taken of.
 *
 * Geometric interpolation needs `log(a)`; a raw interval of 0 (FSRS schedules
 * an again on a brand-new card at ~0 days in some parameter sets) or a negative
 * value would make that `-Infinity`, and the whole series would come out NaN.
 * Clamping to this floor first keeps every emitted tier finite. It is only a
 * guard for the maths — an anchor still reports its own interval unchanged.
 */
const INTERVAL_FLOOR = 1e-6;

/** Clamp an interval to the positive domain the log needs. */
function clampInterval(days: number): number {
  return Number.isFinite(days) && days > INTERVAL_FLOOR ? days : INTERVAL_FLOOR;
}

function anchorTier(tier: number, step: LadderStep): Tier {
  return {
    tier,
    due: step.due,
    intervalDays: step.intervalDays,
    rating: step.rating,
    anchor: true,
  };
}

/** Every native step, renumbered but otherwise untouched. */
function anchorsOnly(steps: readonly LadderStep[]): Tier[] {
  return steps.map((step, index) => anchorTier(index + 1, step));
}

/**
 * Split `extra` interpolated tiers across gaps in proportion to each gap's
 * log-width, using largest-remainder rounding so the total lands exactly on
 * `extra` and the widest gap gets the most resolution.
 *
 * A gap of log-width w receives `extra * w / sum(w)` tiers. Rounding each
 * share down leaves a small remainder, which is handed to the gaps with the
 * largest fractional parts — the standard largest-remainder method, chosen so
 * that no gap is systematically favoured or starved by simple `Math.round`.
 */
function allocate(extra: number, widths: readonly number[]): number[] {
  const gaps = widths.length;
  const total = widths.reduce((sum, width) => sum + width, 0);

  // When every gap is zero-width there is no basis for proportion, so the
  // extras are spread as evenly as the integer counts allow.
  const weights =
    total > 0
      ? widths.map((width) => (width > 0 ? width / total : 0))
      : widths.map(() => 1 / gaps);

  const exact = weights.map((weight) => weight * extra);
  const allocation = exact.map((value) => Math.floor(value));
  let remaining = extra - allocation.reduce((sum, value) => sum + value, 0);

  const byRemainder = exact
    .map((value, index) => ({
      index,
      fraction: value - Math.floor(value),
      width: widths[index] ?? 0,
    }))
    // Ties go to the wider gap, then to the earlier one, so the result is
    // deterministic rather than dependent on sort stability.
    .sort(
      (a, b) =>
        b.fraction - a.fraction ||
        b.width - a.width ||
        a.index - b.index
    );

  remaining = Math.max(0, Math.min(remaining, gaps));
  for (let i = 0; i < remaining; i++) {
    const target = byRemainder[i]?.index;
    if (target !== undefined) allocation[target] = (allocation[target] ?? 0) + 1;
  }

  return allocation;
}

/**
 * Expand an algorithm's native ladder into `count` tiers by geometric
 * interpolation, keeping every native step as an anchor.
 *
 * See the module tests for the observable contract. Two decisions worth
 * reading the code for: a zero-width gap repeats its interval rather than
 * inventing a spread, and a sub-`count` request returns the anchors rather
 * than dropping a real grade.
 */
export function expandTiers(steps: readonly LadderStep[], count: number): Tier[] {
  if (steps.length === 0) return [];

  // A non-finite or sub-binary count has no meaningful ladder to build.
  if (!Number.isFinite(count) || count < 2) return [];

  // A ladder is a whole number of rungs; a fractional request rounds down to
  // the nearest count it can actually build.
  const target = Math.floor(count);
  if (target <= steps.length) {
    // Fewer rungs than the algorithm has real grades: interpolating could only
    // add rungs, never remove them, so the anchors are returned as-is rather
    // than dropping a grade the user can still press.
    return anchorsOnly(steps);
  }

  const gapCount = steps.length - 1;
  // A lone anchor has no gap to subdivide, so there is nowhere for the extras
  // to go; it is returned alone rather than duplicated.
  if (gapCount === 0) return anchorsOnly(steps);

  const widths = Array.from({ length: gapCount }, (_, i) => {
    const a = clampInterval(steps[i]!.intervalDays);
    const b = clampInterval(steps[i + 1]!.intervalDays);
    return Math.log(b) - Math.log(a);
  });
  const allocation = allocate(target - steps.length, widths);

  const tiers: Tier[] = [anchorTier(1, steps[0]!)];

  for (let i = 0; i < gapCount; i++) {
    const a = steps[i]!;
    const b = steps[i + 1]!;
    const extra = allocation[i] ?? 0;

    const lo = clampInterval(a.intervalDays);
    const hi = clampInterval(b.intervalDays);
    // `extra` inserted tiers cut the gap into `extra + 1` sub-intervals, so
    // each step multiplies by (hi/lo)^(1/(extra+1)) — geometric, not linear,
    // because these are intervals: linear steps would pile every tier into the
    // last few days of a long gap.
    const ratio = hi / lo;
    let intervalDays = a.intervalDays;

    for (let j = 1; j <= extra; j++) {
      intervalDays =
        ratio === 1 ? a.intervalDays : lo * Math.pow(ratio, j / (extra + 1));
      tiers.push({
        tier: tiers.length + 1,
        // Recover the same origin the anchors were built from, so `due - now`
        // stays exactly proportional to `intervalDays` for interpolated rungs
        // too. `LadderStep.due` is `now + intervalDays * DAY_MS` by
        // construction, so shifting from the anchor's own due is equivalent.
        due: a.due + (intervalDays - a.intervalDays) * DAY_MS,
        intervalDays,
        anchor: false,
      });
    }

    tiers.push(anchorTier(tiers.length + 1, b));
  }

  return tiers;
}

export interface RetentionWindow {
  /** Below this the top two tiers are clamped together. */
  min: number;
  /** Above this they are squeezed together again. */
  max: number;
}

/** Sampling resolution used when a caller passes no (or an unusable) step. */
const DEFAULT_STEP = 0.001;

/**
 * A `step` smaller than this relative to the requested range would make the
 * scan itself the bottleneck (a pathological step plus a wide range is
 * millions of samples, or effectively a hang), so anything past this falls
 * back to a sane resolution instead of blocking.
 */
const MAX_SAMPLES = 1_000_000;

/**
 * The widest contiguous range of retention values for which the top two tiers
 * are at least `topGapDays` apart, according to `evaluate`.
 *
 * `evaluate(retention)` returns the tier intervals in days, ascending. It is
 * injected so this stays pure and testable without the FSRS engine.
 * Returns null when no such range exists.
 */
export function retentionWindow(
  evaluate: (retention: number) => readonly number[],
  options: { min: number; max: number; topGapDays: number; step?: number }
): RetentionWindow | null {
  const { min, max, topGapDays } = options;
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(topGapDays) ||
    min > max
  ) {
    return null;
  }

  let step =
    typeof options.step === 'number' &&
    Number.isFinite(options.step) &&
    options.step > 0
      ? options.step
      : DEFAULT_STEP;

  const span = max - min;
  if (span / step > MAX_SAMPLES) step = DEFAULT_STEP;
  // Even the fallback cannot cover a range this wide without an unbounded
  // scan; refusing is better than blocking the caller.
  if (span / step > MAX_SAMPLES) return null;

  /**
   * An evaluator that throws or yields non-numeric output tells us nothing
   * about this sample. Swallowing it as "does not qualify" keeps one bad
   * sample from aborting the whole scan — the window is defined by the samples
   * that do answer, not by whether every sample does.
   */
  const qualifies = (retention: number): boolean => {
    let intervals: readonly number[] = [];
    try {
      intervals = evaluate(retention);
    } catch {
      return false;
    }
    if (!Array.isArray(intervals) || intervals.length < 2) return false;

    const last = intervals[intervals.length - 1];
    const previous = intervals[intervals.length - 2];
    if (typeof last !== 'number' || typeof previous !== 'number') return false;
    if (!Number.isFinite(last) || !Number.isFinite(previous)) return false;

    const gap = last - previous;
    return Number.isFinite(gap) && gap >= topGapDays;
  };

  const samples: number[] = [];
  const lastIndex = Math.floor(span / step + 1e-9);
  for (let i = 0; i <= lastIndex; i++) samples.push(min + i * step);
  // `max` is inclusive, and a range that is not a whole number of steps ends
  // short of it, so append it explicitly rather than widening the last step.
  if (samples[samples.length - 1]! < max - 1e-9) samples.push(max);

  let bestStart = -1;
  let bestEnd = -1;
  let bestLength = 0;
  let runStart = -1;
  const closeRun = (endIndex: number): void => {
    if (runStart >= 0) {
      const length = endIndex - runStart + 1;
      // Strictly greater, so an earlier run wins a tie.
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
        bestEnd = endIndex;
      }
    }
    runStart = -1;
  };

  for (let i = 0; i < samples.length; i++) {
    if (qualifies(samples[i]!)) {
      if (runStart < 0) runStart = i;
    } else {
      closeRun(i - 1);
    }
  }
  closeRun(samples.length - 1);

  if (bestStart < 0) return null;
  return { min: samples[bestStart]!, max: samples[bestEnd]! };
}
