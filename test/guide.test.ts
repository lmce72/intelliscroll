import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDecayFactor, FSRS6_DEFAULT_DECAY } from 'ts-fsrs';
import { DAY_MS, getAlgorithm } from '../src/algorithms/index.ts';
import { expandTiers } from '../src/tiers.ts';
import { FSRS_DEFAULT_TUNABLES, type FsrsTunables, type NoteSrsState } from '../src/types.ts';
import { sections as en } from '../src/guide/en.ts';
import { sections as zh } from '../src/guide/zh.ts';

/**
 * Holds the algorithm guide to the algorithm.
 *
 * The guide is a reference someone is meant to trust about behaviour they
 * cannot watch happen, so a figure in it going stale is worse than a figure
 * being absent. Everything asserted here is stated in `src/guide/*.ts`, and a
 * failure names which claim moved.
 */

const NOW = 1791278071601;
const { decay, factor } = computeDecayFactor(FSRS6_DEFAULT_DECAY);

/** The card the guide's worked example walks through, reviewed 1.4h ago. */
function reproducer(over: Partial<Record<string, unknown>> = {}) {
  return {
    stability: 2.3065,
    difficulty: 2.11810397,
    state: 2,
    reps: 1,
    lapses: 0,
    learning_steps: 0,
    scheduled_days: 5,
    elapsed_days: 0,
    due: new Date('2026-10-11T07:49:56.733Z'),
    last_review: new Date(NOW - 1.4 * 3_600_000),
    ...over,
  };
}

function stateOf(card: unknown): NoteSrsState {
  return {
    algorithm: 'fsrs',
    due: NOW,
    lastReviewedAt: NOW,
    reviews: 1,
    hash: 'h',
    data: { card },
  } as unknown as NoteSrsState;
}

function tunables(retention: number, cap: number): FsrsTunables {
  return {
    ...FSRS_DEFAULT_TUNABLES,
    requestRetention: retention,
    maximumInterval: cap,
    enableFuzz: false,
  };
}

function ladder(card: unknown, retention: number, cap: number, now = NOW) {
  return getAlgorithm('fsrs').ladder(stateOf(card), {
    now,
    hash: 'h',
    fsrs: tunables(retention, cap),
  });
}

const round = (value: number, places = 2): number =>
  Math.round(value * 10 ** places) / 10 ** places;

// ─── The guide's own structure ─────────────────────────────────────────────

test('both language versions carry the same sections, in the same order', () => {
  // The guides are separate documents, so nothing but this stops one gaining a
  // section the other lacks — which would silently leave one language's readers
  // with a worse explanation than the other's.
  assert.ok(zh.length > 0, 'the Chinese guide is not empty');
  assert.equal(
    en.length,
    zh.length,
    `section counts differ: en ${en.length}, zh ${zh.length}`
  );
  assert.deepEqual(
    en.map((section) => section.id),
    zh.map((section) => section.id),
    'section ids and order must match; they are DOM anchors'
  );
});

test('every section is titled and has content', () => {
  for (const section of zh) {
    assert.ok(section.title.trim().length > 0, `${section.id} has a title`);
    assert.ok(section.blocks.length > 0, `${section.id} has blocks`);
  }
});

// ─── The numbers the guide states ──────────────────────────────────────────

test('the interval modifier table matches ts-fsrs', () => {
  // Stated in section 2. Every one of these is a claim a reader could check by
  // hand against the formula, so they have to be the library's values.
  const stated: [number, number][] = [
    [0.70, 9.2879],
    [0.85, 1.9064],
    [0.90, 1.0],
    [0.95, 0.4026],
    [0.99, 0.0687],
  ];

  for (const [retention, expected] of stated) {
    const actual = (Math.pow(retention, 1 / decay) - 1) / factor;
    assert.equal(
      round(actual, 4),
      expected,
      `interval modifier at ${retention} is stated as ${expected}`
    );
  }
});

test('the worked example in section 3 reproduces step for step', () => {
  // 1.4 hours elapsed rounds to 0 whole days, so retrievability is 1, the
  // growth term is zero, and the three passing grades keep the card's own
  // stability. The committed ladder then comes entirely from the ordering rule.
  const steps = ladder(reproducer(), 0.85, 30);
  const byRating = new Map(steps.map((step) => [step.rating, step]));

  for (const grade of ['hard', 'good', 'easy'] as const) {
    assert.equal(
      round(byRating.get(grade)!.modelDays),
      4.4,
      `${grade} keeps the card's stability, scaled by 1.9064`
    );
  }
  assert.equal(round(byRating.get('again')!.modelDays), 1.0);

  assert.deepEqual(
    steps.map((step) => Math.round(step.intervalDays)),
    [1, 4, 5, 6],
    'the committed ladder, which the ordering rule manufactures'
  );
});

test('the maximum-interval table in section 6 reproduces', () => {
  // Two cards' worth of reviews, so the stability in each row is the one the
  // guide prints. Each is then reviewed up to that count, on its due dates.
  const grown = (reviews: number): unknown => {
    let st: NoteSrsState | null = null;
    let now = NOW;
    for (let i = 0; i < reviews; i++) {
      st = getAlgorithm('fsrs').review(st, 'good', {
        now,
        hash: 'h',
        // Cap high while growing, so the ladder reaching the printed stability
        // is not itself the cap's doing.
        fsrs: tunables(0.85, 3650),
      });
      now = st.due;
    }
    return st;
  };

  const stated: [number, number, number[], number[]][] = [
    [2, 16, [4, 30, 31, 32], [4, 117, 173, 298]],
    [4, 405, [13, 30, 31, 32], [13, 2028, 2859, 3650]],
    // The ordering overshoot applies at the cap too, so the uncapped top two
    // are 3651 and 3652 — the same +1/+2 section 2 documents.
    [8, 14027, [30, 31, 32, 33], [32, 3650, 3651, 3652]],
  ];

  for (const [reviews, stability, capped, uncapped] of stated) {
    const st = grown(reviews)!;
    const at = st.due;
    const S = (st.data.card as { stability: number }).stability;
    assert.equal(
      Math.round(S),
      stability,
      `${reviews} reviews should reach stability ${stability}`
    );

    const tight = ladder(st.data.card, 0.85, 30, at).map((step) =>
      Math.round(step.intervalDays)
    );
    const loose = ladder(st.data.card, 0.85, 3650, at).map((step) =>
      Math.round(step.intervalDays)
    );

    assert.deepEqual(tight, capped, `${reviews} reviews at cap 30`);
    assert.deepEqual(loose, uncapped, `${reviews} reviews at cap 3650`);
  }
});

test('a higher cap never shortens an interval, which is what section 6 claims', () => {
  // The claim the guide actually makes, and the one a reader will rely on when
  // deciding whether to raise the cap. Checked across maturities rather than
  // only the three rows printed.
  let st: NoteSrsState | null = null;
  let now = NOW;
  for (let i = 1; i <= 10; i++) {
    if (st) {
      const at = st.due;
      const tight = ladder(st.data.card, 0.85, 30, at);
      const loose = ladder(st.data.card, 0.85, 3650, at);
      tight.forEach((step, index) => {
        assert.ok(
          loose[index]!.intervalDays >= step.intervalDays,
          `pass ${i}, ${step.rating}: cap 3650 gave ${loose[index]!.intervalDays}, ` +
            `cap 30 gave ${step.intervalDays}`
        );
      });
    }
    if (i < 10) {
      st = getAlgorithm('fsrs').review(st, 'good', { now, hash: 'h', fsrs: tunables(0.85, 3650) });
      now = st.due;
    }
  }
});

test('the tier expansion in section 7 reproduces', () => {
  // A brand-new card, cap 365, retention 0.90.
  const steps = ladder(null, 0.9, 365, NOW);
  assert.deepEqual(
    steps.map((step) => round(step.modelDays, 3)),
    [0.212, 1.293, 2.307, 8.296],
    'the four native grades'
  );

  const tiers = expandTiers(steps, 8);
  assert.deepEqual(
    tiers.map((tier) => round(tier.modelDays, 3)),
    [0.212, 0.387, 0.708, 1.293, 1.727, 2.307, 4.374, 8.296],
    'eight rungs, all distinct'
  );
});

test('the maturity table in section 8 reproduces', () => {
  // Retention 0.90, cap 30: how far apart the three passing grades get as the
  // gap since the last review grows. This is the table that shows the collapse
  // is transient.
  const stated: [number, number[]][] = [
    [1.4 / 24, [2.31, 2.31, 2.31]],
    [1, [5.32, 7.32, 11.69]],
    [5, [11.85, 18.17, 32.01]],
    [20, [20.64, 32.79, 59.39]],
  ];

  for (const [daysAgo, expected] of stated) {
    const card = reproducer({ last_review: new Date(NOW - daysAgo * DAY_MS) });
    // Cap raised out of the way: at 30 the longer rows are truncated and the
    // separation this table exists to show is hidden by the cap instead.
    const steps = ladder(card, 0.9, 3650);
    const byRating = new Map(steps.map((step) => [step.rating, step]));
    assert.deepEqual(
      (['hard', 'good', 'easy'] as const).map((grade) =>
        round(byRating.get(grade)!.modelDays)
      ),
      expected,
      `${daysAgo} days since the last review`
    );
  }
});

test('a card carrying Date fields schedules the same as one carrying ISO strings', () => {
  // The sidecar stores ISO strings, but a card assembled in memory — by a test,
  // or by any future caller — carries real Dates. `deserializeCard` used to
  // drop `last_review` unless it was a string, and ts-fsrs derives elapsed time
  // from that field: dropping it silently meant "never reviewed", so elapsed
  // came out 0, retrievability 1, and the stability never grew. The card would
  // keep scheduling as though it had just been seen, which is the "intervals
  // are stuck" symptom with nothing in the log to explain it.
  const asDates = reproducer({ last_review: new Date(NOW - 5 * DAY_MS) });
  const asStrings = reproducer({
    due: '2026-10-11T07:49:56.733Z',
    last_review: new Date(NOW - 5 * DAY_MS).toISOString(),
  });

  const fromDates = ladder(asDates, 0.9, 3650).map((step) => round(step.modelDays, 3));
  const fromStrings = ladder(asStrings, 0.9, 3650).map((step) => round(step.modelDays, 3));

  assert.deepEqual(fromDates, fromStrings, 'both shapes must schedule identically');
  assert.notEqual(
    fromDates[1],
    2.31,
    'and elapsed must actually have been read, not silently reset to zero'
  );
});
