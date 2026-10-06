import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, getAlgorithm } from '../src/algorithms/index.ts';
import type { LadderStep } from '../src/algorithms/index.ts';
import { expandTiers, ladderResolution, retentionWindow } from '../src/tiers.ts';
import type { Tier } from '../src/tiers.ts';
import { formatTierInterval } from '../src/tierDisplay.ts';

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

/**
 * Synthetic steps from bare intervals, rated in ascending order.
 *
 * `modelDays` mirrors `intervalDays` unless the caller overrides it: these
 * fixtures describe ladders whose committed and model intervals agree, which
 * is the case for SM-2 and Leitner and for FSRS once its grades have diverged.
 */
function stepsFromIntervals(
  intervals: readonly number[],
  modelDays?: readonly number[]
): LadderStep[] {
  const ratings = ['again', 'hard', 'good', 'easy'] as const;
  return intervals.map((intervalDays, index) => ({
    rating: ratings[index % ratings.length]!,
    due: NOW + intervalDays * DAY_MS,
    intervalDays,
    modelDays: modelDays?.[index] ?? intervalDays,
  }));
}

// ─── expandTiers ───────────────────────────────────────────────────────────

test('rungs are spaced by the model interval, not by the rounded one', () => {
  // The committed ladder is whole days that FSRS has already forced apart, so
  // spacing the rungs by it would build the display on the artefact. Widths
  // come from `modelDays`, which is why the allocation is not the one the
  // committed gaps alone would produce: here again->hard is the widest gap on
  // the model scale, so it takes two of the four extra rungs.
  const ladder = fsrsLadder();
  assert.deepEqual(
    ladder.map((step) => step.intervalDays),
    [1, 2, 3, 8],
    'the committed ladder this test reasons against'
  );

  const [a, h, g, e] = ladder.map((step) => step.modelDays) as [
    number,
    number,
    number,
    number,
  ];
  const tiers = expandTiers(ladder, 8);

  assert.equal(tiers.length, 8);
  assert.deepEqual(
    tiers.map((tier) => tier.tier),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'tiers are numbered 1-based and ascending'
  );
  assert.equal(
    new Set(tiers.map((tier) => tier.modelDays.toFixed(6))).size,
    8,
    'eight rungs on the model scale, none a duplicate of another'
  );

  // Each gap is subdivided geometrically, so an interior point is
  // lo * (hi/lo)^(j/(extra+1)) with `extra` rungs inserted.
  const expected = [
    a,
    a * Math.cbrt(h / a),
    a * Math.cbrt(h / a) ** 2,
    h,
    h * Math.sqrt(g / h),
    g,
    g * Math.sqrt(e / g),
    e,
  ];
  tiers.forEach((tier, index) =>
    assertClose(tier.modelDays, expected[index]!, 1e-9)
  );
});

test('a ladder whose grades share one model interval says so instead of inventing a spread', () => {
  // The case the user hit: a note reviewed earlier the same day, where FSRS's
  // recall growth term is zero and Hard, Good and Easy all keep the card's
  // stability. The committed values are 1/2/3/4 because of ts-fsrs's ordering
  // rule; the model's values are all the same.
  //
  // The ladder must not convert that into four distinct rungs. Showing the
  // model value is the whole point: three rungs that read the same tell the
  // reader the truth, which is that this note's grades do not differ today.
  const ladder = stepsFromIntervals([1, 2, 3, 4], [0.523, 2.307, 2.307, 2.307]);
  const tiers = expandTiers(ladder, 8);
  const model = tiers.map((tier) => Number(tier.modelDays.toFixed(4)));

  assert.equal(tiers.length, 8, 'still eight rungs');
  for (let i = 1; i < model.length; i++) {
    assert.ok(
      model[i]! >= model[i - 1]!,
      `never descends: ${JSON.stringify(model)}`
    );
  }
  assert.equal(
    model[model.length - 1],
    model[model.length - 2],
    'the top rungs are honestly identical rather than artificially ordered'
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

// ─── Displayed interval ────────────────────────────────────────────────────

test('a pressable rung states its commitment when the two numbers differ', () => {
  // The model's interval and the committed one are different quantities: FSRS
  // rounds to whole days and then pushes each grade past the last. Showing only
  // the model's value would let a row read "3.8 hours" while pressing it
  // schedules two days; showing only the committed one makes the retention
  // control look broken, because sweeping it moves the model tenfold and the
  // committed numbers not at all. So the model leads and the commitment is
  // stated whenever it differs.
  const anchor: Tier = {
    tier: 1,
    due: NOW,
    intervalDays: 2,
    modelDays: 0.16,
    rating: 'hard',
    anchor: true,
  };
  const text = formatTierInterval(anchor, 'days');

  // The unit steps down on its own for a sub-day value, so a fifth of a day
  // reads as hours rather than as "0.2 days".
  assert.equal(text, '3.8 hours (schedules 2 days)');

  // When the two agree there is one number and nothing extra to read.
  assert.equal(formatTierInterval({ ...anchor, modelDays: 2 }, 'days'), '2 days');
});

test('an interpolated rung states no commitment, because it has none', () => {
  // Interpolated tiers are inert — the popover renders them as rows, not
  // buttons — so claiming one "schedules" anything would invent a press that
  // does not exist.
  const interpolated: Tier = {
    tier: 2,
    due: NOW,
    intervalDays: 5,
    modelDays: 4.2,
    anchor: false,
  };
  const text = formatTierInterval(interpolated, 'days');

  assert.ok(text.includes('4.2'), `shows the model interval: ${text}`);
  assert.equal(/commit|schedul|提交/i.test(text), false, `no commitment claim: ${text}`);
});

// ─── What the ladder is not saying ─────────────────────────────────────────

test('a ladder pinned by the cap is reported as pinned', () => {
  // Three rungs reading "30 days" look like three choices. They are three
  // grades the cap truncated onto the same day, and the numbers do not say so.
  // `modelDays` arrives already clamped by the cap, so the pinned grades are
  // also equal to each other — which is why the tie must not be reported
  // separately, or the panel says it twice.
  const ladder = stepsFromIntervals([1, 30, 30, 30], [0.5, 30, 30, 30]);
  const resolution = ladderResolution(ladder, 30);

  assert.deepEqual(resolution.capPinned, ['hard', 'good', 'easy']);
  assert.deepEqual(
    resolution.tied,
    [],
    'the cap is the explanation, so the tie is not repeated'
  );
});

test('a ladder the model cannot separate is reported as tied', () => {
  // A note reviewed earlier the same day: FSRS recomputes elapsed in whole
  // days, so there is no new difficulty information and three grades keep one
  // stability. The equal numbers are honest; that they are equal because the
  // model is silent is not self-evident.
  const ladder = stepsFromIntervals([1, 2, 3, 4], [0.52, 2.3, 2.3, 2.3]);
  const resolution = ladderResolution(ladder, 30);

  assert.deepEqual(resolution.tied, ['good', 'easy']);
  assert.deepEqual(resolution.capPinned, [], 'nothing is on the cap here');
});

test('a ladder that is doing its job is reported as saying nothing', () => {
  // A notice on every card would be noise, so the common case must be silent.
  const ladder = stepsFromIntervals([1, 5, 12, 30], [0.9, 5.1, 12.4, 28.7]);
  const resolution = ladderResolution(ladder, 30);

  assert.deepEqual(resolution.capPinned, []);
  assert.deepEqual(resolution.tied, []);
});

test('a malformed cap never makes every grade look pinned', () => {
  // A non-finite cap must not turn into "everything is pinned", which would
  // put a warning on every card.
  const ladder = stepsFromIntervals([1, 5, 12, 30], [0.9, 5.1, 12.4, 28.7]);
  for (const cap of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      ladderResolution(ladder, cap).capPinned,
      [],
      `cap ${cap} must not pin anything`
    );
  }
});
