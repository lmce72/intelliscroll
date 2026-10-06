import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, getAlgorithm } from '../src/algorithms/index.ts';
import type { LadderStep } from '../src/algorithms/index.ts';
import { expandTiers, retentionWindow } from '../src/tiers.ts';
import { FSRS_DEFAULT_TUNABLES } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 1);

const CTX = {
  now: NOW,
  hash: 'hash-1',
  // Fuzz off so the native ladder is a fixed, nameable set of intervals.
  fsrs: { ...FSRS_DEFAULT_TUNABLES, enableFuzz: false },
};

function fsrsLadder(): LadderStep[] {
  return getAlgorithm('fsrs').ladder(null, CTX);
}

function assertClose(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

/** Synthetic steps from bare intervals, rated in ascending order. */
function stepsFromIntervals(intervals: readonly number[]): LadderStep[] {
  const ratings = ['again', 'hard', 'good', 'easy'] as const;
  return intervals.map((intervalDays, index) => ({
    rating: ratings[index % ratings.length]!,
    due: NOW + intervalDays * DAY_MS,
    intervalDays,
  }));
}

// ─── expandTiers ───────────────────────────────────────────────────────────

test('FSRS four grades expand into eight tiers with the widest gap most subdivided', () => {
  const ladder = fsrsLadder();
  assert.deepEqual(
    ladder.map((step) => step.intervalDays),
    [1, 2, 3, 8],
    'the native ladder is the four grades whose gaps this test reasons about'
  );

  const tiers = expandTiers(ladder, 8);

  assert.equal(tiers.length, 8);
  assert.deepEqual(
    tiers.map((tier) => tier.tier),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'tiers are numbered 1-based and ascending'
  );

  // 4 extra tiers over 3 log-widths: 1 into 1->2, 1 into 2->3, and 2 into the
  // widest gap 3->8. Each gap is subdivided geometrically, so the interior
  // points are lo * (hi/lo)^(j/(extra+1)).
  const expected = [
    1,
    Math.SQRT2, // 1 * (2/1)^(1/2)
    2,
    2 * Math.sqrt(1.5), // 2 * (3/2)^(1/2)
    3,
    3 * Math.cbrt(8 / 3), // 3 * (8/3)^(1/3)
    3 * Math.cbrt(8 / 3) ** 2, // 3 * (8/3)^(2/3)
    8,
  ];
  tiers.forEach((tier, index) =>
    assertClose(tier.intervalDays, expected[index]!, 1e-9)
  );
});

test('anchors keep their exact interval, due, and rating', () => {
  const ladder = fsrsLadder();
  const tiers = expandTiers(ladder, 8);
  const anchors = tiers.filter((tier) => tier.anchor);

  assert.equal(anchors.length, 4, 'every native grade survives interpolation');
  assert.deepEqual(
    anchors.map((tier) => tier.rating),
    ['again', 'hard', 'good', 'easy']
  );
  assert.deepEqual(
    anchors.map((tier) => tier.intervalDays),
    ladder.map((step) => step.intervalDays)
  );
  assert.deepEqual(
    anchors.map((tier) => tier.due),
    ladder.map((step) => step.due)
  );
  for (const tier of tiers) {
    if (tier.anchor) {
      assert.ok(tier.rating !== undefined, 'anchors carry a grade');
    } else {
      assert.equal(tier.rating, undefined, 'interpolated tiers carry no grade');
    }
  }
});

test('every tier keeps due proportional to its interval', () => {
  const tiers = expandTiers(fsrsLadder(), 8);
  for (const tier of tiers) {
    assertClose((tier.due - NOW) / DAY_MS, tier.intervalDays, 1e-9);
  }
});

test('interpolated tiers stay strictly ascending between anchors', () => {
  const tiers = expandTiers(fsrsLadder(), 12);
  assert.equal(tiers.length, 12);
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(
      tiers[i]!.intervalDays > tiers[i - 1]!.intervalDays,
      `not ascending at ${i}: ${JSON.stringify(tiers.map((t) => t.intervalDays))}`
    );
  }
});

test('a count at or below the anchor count returns the anchors renumbered', () => {
  const ladder = fsrsLadder();
  for (const count of [2, 3, 4]) {
    const tiers = expandTiers(ladder, count);
    assert.equal(tiers.length, 4, `count ${count} does not drop real grades`);
    assert.deepEqual(
      tiers.map((tier) => tier.tier),
      [1, 2, 3, 4]
    );
    assert.ok(tiers.every((tier) => tier.anchor));
  }
});

test('degenerate counts return an empty ladder', () => {
  const ladder = fsrsLadder();
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, 1, 0, -5]) {
    assert.deepEqual(expandTiers(ladder, count), [], `count ${count}`);
  }
});

test('empty steps produce no tiers', () => {
  assert.deepEqual(expandTiers([], 8), []);
});

test('a single anchor has no gap and is returned alone', () => {
  const tiers = expandTiers(stepsFromIntervals([5]), 8);
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0]!.anchor, true);
  assert.equal(tiers[0]!.intervalDays, 5);
});

test('a zero anchor interval is clamped for the maths without producing NaN', () => {
  const tiers = expandTiers(stepsFromIntervals([0, 9]), 4);

  assert.equal(tiers.length, 4);
  assert.equal(tiers[0]!.intervalDays, 0, 'the anchor reports its own value');
  for (const tier of tiers) {
    assert.ok(Number.isFinite(tier.intervalDays), 'interval is finite');
    assert.ok(Number.isFinite(tier.due), 'due is finite');
  }
  // The anchor is 0 and the extra rungs run geometrically up to the 9-day one.
  assert.ok(tiers[1]!.intervalDays > 0 && tiers[2]!.intervalDays < 9);
  assert.equal(tiers[3]!.intervalDays, 9);
});

test('duplicate adjacent intervals still yield the full count, ascending, with no NaN', () => {
  // The real case: SM-2's first repetition gives every passing grade the same
  // day, so all four anchors share an interval and every gap is zero-width.
  const tiers = expandTiers(stepsFromIntervals([1, 1, 1, 1]), 8);

  assert.equal(tiers.length, 8);
  for (const tier of tiers) {
    assert.ok(Number.isFinite(tier.due), 'due is finite');
    assert.equal(tier.intervalDays, 1, 'a zero-width gap repeats its interval');
  }
  // Non-decreasing is the honest contract for tied intervals.
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i]!.intervalDays >= tiers[i - 1]!.intervalDays);
  }
});

test('a zero-width gap is not injected into while a wider gap exists', () => {
  // Anchors 2, 2, 8: the 2->2 gap is zero-width and the 2->8 gap is wide, so
  // every extra tier belongs in the wide gap.
  const tiers = expandTiers(stepsFromIntervals([2, 2, 8]), 5);

  assert.equal(tiers.length, 5);
  const interpolated = tiers.filter((tier) => !tier.anchor);
  assert.equal(interpolated.length, 2);
  for (const tier of interpolated) {
    assert.ok(tier.intervalDays > 2 && tier.intervalDays < 8);
  }
  assert.deepEqual(
    tiers.map((tier) => tier.tier),
    [1, 2, 3, 4, 5]
  );
});

// ─── retentionWindow ───────────────────────────────────────────────────────

/** A gap that widens to a peak at 0.9 then narrows — the documented hump. */
function humpEvaluator(retention: number): number[] {
  const gap = 100 * (retention <= 0.9 ? retention - 0.8 : 1.0 - retention);
  return [1, 1 + gap];
}

test('finds the hump where the top two tiers stay far enough apart', () => {
  const window = retentionWindow(humpEvaluator, {
    min: 0.8,
    max: 1.0,
    topGapDays: 5,
  });

  assert.ok(window !== null, 'a qualifying range exists');
  // gap >= 5 iff |r - 0.9| <= 0.05.
  assertClose(window.min, 0.85, 0.002);
  assertClose(window.max, 0.95, 0.002);
});

test('returns the widest run when several qualify', () => {
  const twoBands = (retention: number): number[] => {
    const inBand =
      (retention >= 0.8 && retention <= 0.83) ||
      (retention >= 0.87 && retention <= 0.95);
    return [1, inBand ? 11 : 1];
  };

  const window = retentionWindow(twoBands, {
    min: 0.8,
    max: 1.0,
    topGapDays: 10,
    step: 0.001,
  });

  assert.ok(window !== null);
  assertClose(window.min, 0.87, 0.002, 'the wider second band wins');
  assertClose(window.max, 0.95, 0.002);
});

test('endpoints are inclusive and the comparison is at-least', () => {
  const constant = (): number[] => [1, 11];
  const window = retentionWindow(constant, {
    min: 0.8,
    max: 1.0,
    topGapDays: 10,
  });
  assert.deepEqual(window, { min: 0.8, max: 1.0 });
});

test('no qualifying sample yields null', () => {
  assert.equal(
    retentionWindow(humpEvaluator, { min: 0.8, max: 1.0, topGapDays: 99 }),
    null
  );
});

test('a throwing evaluator does not propagate', () => {
  const thrower = (): number[] => {
    throw new Error('boom');
  };
  assert.equal(
    retentionWindow(thrower, { min: 0.7, max: 0.97, topGapDays: 1 }),
    null
  );
});

test('non-finite or too-short evaluator output never qualifies', () => {
  const cases: Array<(r: number) => readonly number[]> = [
    () => [1], // fewer than two intervals
    () => [], // nothing to compare
    () => [1, Number.NaN],
    () => [1, Number.POSITIVE_INFINITY],
  ];
  for (const evaluate of cases) {
    assert.equal(
      retentionWindow(evaluate, { min: 0.7, max: 0.97, topGapDays: 1 }),
      null
    );
  }
});

test('an unusable step falls back to the default resolution', () => {
  const withBadStep = retentionWindow(humpEvaluator, {
    min: 0.8,
    max: 1.0,
    topGapDays: 5,
    step: 0,
  });
  assert.ok(withBadStep !== null);
  assertClose(withBadStep.min, 0.85, 0.002);
  assertClose(withBadStep.max, 0.95, 0.002);
});

test('an inverted or non-finite range yields null', () => {
  assert.equal(
    retentionWindow(humpEvaluator, { min: 1.0, max: 0.8, topGapDays: 5 }),
    null
  );
  assert.equal(
    retentionWindow(humpEvaluator, {
      min: Number.NaN,
      max: 1.0,
      topGapDays: 5,
    }),
    null
  );
});
