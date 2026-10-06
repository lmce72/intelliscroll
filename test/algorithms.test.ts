import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, getAlgorithm } from '../src/algorithms/index.ts';
import type { ReviewContext } from '../src/algorithms/index.ts';
import { FSRS_DEFAULT_TUNABLES } from '../src/types.ts';
import type { FsrsTunables, NoteSrsState, Rating } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 1);
const HASH = 'hash-1';

function context(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    now: NOW,
    hash: HASH,
    // Fuzz off so assertions can name exact due dates.
    fsrs: { ...FSRS_DEFAULT_TUNABLES, enableFuzz: false },
    ...overrides,
  };
}

/** Days between `now` and the state's due date. */
function dueInDays(state: NoteSrsState, now = NOW): number {
  return (state.due - now) / DAY_MS;
}

/** Run a sequence of ratings, reviewing exactly on each due date. */
function ladder(
  algorithmId: 'sm2' | 'leitner' | 'fsrs',
  ratings: readonly Rating[],
  fsrs?: FsrsTunables
): NoteSrsState[] {
  const algorithm = getAlgorithm(algorithmId);
  const states: NoteSrsState[] = [];
  let previous: NoteSrsState | null = null;
  let now = NOW;

  for (const rating of ratings) {
    const ctx = context({ now, fsrs: fsrs ?? context().fsrs });
    const next = algorithm.review(previous, rating, ctx);
    states.push(next);
    previous = next;
    now = next.due;
  }

  return states;
}

// ─── SM-2 ──────────────────────────────────────────────────────────────────

test('SM-2 follows its published interval ladder', () => {
  const [first, second, third] = ladder('sm2', ['good', 'good', 'good']);

  assert.equal(dueInDays(first!), 1, 'first repetition is 1 day');
  assert.equal(
    dueInDays(second!, first!.due),
    6,
    'second repetition is 6 days'
  );
  // EF stays 2.5 while only q=4 is used, so the third interval is 6 * 2.5.
  assert.equal(dueInDays(third!, second!.due), 15);
});

test('SM-2 restarts the ladder on a failed recall without touching the E-Factor', () => {
  const states = ladder('sm2', ['good', 'good', 'good', 'again']);
  const beforeFailure = states[2]!;
  const afterFailure = states[3]!;

  assert.equal(dueInDays(afterFailure, beforeFailure.due), 1, 'back to 1 day');
  assert.equal(
    (afterFailure.data as { ef: number }).ef,
    (beforeFailure.data as { ef: number }).ef,
    'EF is explicitly left alone on a failed recall'
  );
  assert.equal((afterFailure.data as { reps: number }).reps, 0);
});

test('SM-2 clamps the E-Factor at its 1.3 floor', () => {
  const states = ladder('sm2', Array<Rating>(12).fill('hard'));
  const finalEf = (states[states.length - 1]!.data as { ef: number }).ef;
  assert.equal(finalEf, 1.3, 'repeated hard grades ratchet EF down to the floor');
});

// ─── Leitner ───────────────────────────────────────────────────────────────

test('Leitner advances one box per success and starts at one day', () => {
  const states = ladder('leitner', ['good', 'good', 'good']);

  assert.equal(dueInDays(states[0]!), 1, 'first success lands on the 1-day box');
  assert.equal(dueInDays(states[1]!, states[0]!.due), 3);
  assert.equal(dueInDays(states[2]!, states[1]!.due), 7);
});

test('Leitner drops straight back to the first box on a failure', () => {
  const states = ladder('leitner', ['good', 'good', 'good', 'again']);
  assert.equal((states[3]!.data as { box: number }).box, 0);
  assert.equal(dueInDays(states[3]!, states[2]!.due), 1);
});

test('Leitner never advances past its last box', () => {
  const states = ladder('leitner', Array<Rating>(20).fill('good'));
  const lastBox = (states[states.length - 1]!.data as { box: number }).box;
  assert.equal(lastBox, 6, 'box index stops at the end of the ladder');
});

// ─── FSRS ──────────────────────────────────────────────────────────────────

test('FSRS grows the interval with successive successful reviews', () => {
  // An explicit high ceiling, so this tests growth rather than the cap. The
  // default cap is 30 days and would otherwise flatten the ladder — which is
  // correct behaviour, and covered by its own test below.
  const states = ladder('fsrs', ['good', 'good', 'good', 'good'], {
    ...FSRS_DEFAULT_TUNABLES,
    enableFuzz: false,
    maximumInterval: 3650,
  });
  const intervals = states.map((state, index) =>
    dueInDays(state, index === 0 ? NOW : states[index - 1]!.due)
  );

  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i]! > intervals[i - 1]!,
      `interval must grow: ${JSON.stringify(intervals)}`
    );
  }
});

test('a higher desired retention yields shorter intervals', () => {
  // Regression guard for the direction, which is easy to state backwards:
  // raising retention means reviewing *sooner*, so intervals shrink and
  // workload grows.
  const base: FsrsTunables = { ...FSRS_DEFAULT_TUNABLES, enableFuzz: false };
  const low = ladder('fsrs', ['good', 'good', 'good'], {
    ...base,
    requestRetention: 0.8,
  });
  const high = ladder('fsrs', ['good', 'good', 'good'], {
    ...base,
    requestRetention: 0.95,
  });

  const lowLast = dueInDays(low[low.length - 1]!, low[low.length - 2]!.due);
  const highLast = dueInDays(high[high.length - 1]!, high[high.length - 2]!.due);

  assert.ok(
    highLast < lowLast,
    `retention 0.95 should schedule sooner than 0.80 (got ${highLast} vs ${lowLast})`
  );
});

test('FSRS honours the maximum interval ceiling', () => {
  // ts-fsrs clamps the computed interval but `scheduled_days` can land a
  // couple of days past the ceiling (observed: 30 -> 32, 365 -> 366), so the
  // assertion allows that documented slack instead of pinning exact rounding.
  const scheduledFor = (maximumInterval: number): number => {
    const states = ladder('fsrs', Array<Rating>(10).fill('easy'), {
      ...FSRS_DEFAULT_TUNABLES,
      enableFuzz: false,
      maximumInterval,
    });
    const last = states[states.length - 1]!;
    return (last.data as { card: { scheduled_days: number } }).card
      .scheduled_days;
  };

  const tight = scheduledFor(30);
  const loose = scheduledFor(365);

  assert.ok(tight <= 30 + 5, `30-day ceiling produced ${tight} days`);
  assert.ok(loose <= 365 + 5, `365-day ceiling produced ${loose} days`);
  assert.ok(
    tight < loose,
    `a tighter ceiling must shorten intervals (${tight} vs ${loose})`
  );
});

// ─── Shared bookkeeping ────────────────────────────────────────────────────

test('every algorithm counts reviews, records the hash, and clears the unengaged marker', () => {
  for (const id of ['off', 'fsrs', 'sm2', 'leitner'] as const) {
    const algorithm = getAlgorithm(id);
    const previous: NoteSrsState = {
      algorithm: id,
      due: NOW,
      lastReviewedAt: NOW - DAY_MS,
      reviews: 4,
      hash: 'stale',
      unengagedAt: NOW - 1000,
      data: {},
    };

    const next = algorithm.review(previous, 'good', context());

    assert.equal(next.reviews, 5, `${id}: reviews increments`);
    assert.equal(next.hash, HASH, `${id}: hash is refreshed`);
    assert.equal(next.lastReviewedAt, NOW, `${id}: lastReviewedAt is now`);
    assert.equal(
      next.unengagedAt,
      undefined,
      `${id}: a real review supersedes the unengaged marker`
    );
  }
});

test('switching algorithms resets the payload but keeps the review count', () => {
  const sm2 = getAlgorithm('sm2');
  const fsrs = getAlgorithm('fsrs');

  const sm2State = sm2.review(null, 'good', context());
  assert.ok((sm2State.data as { ef?: number }).ef !== undefined);

  const switched = fsrs.review(sm2State, 'good', context());

  assert.equal(switched.algorithm, 'fsrs');
  assert.equal(switched.reviews, 2, 'review count survives the switch');
  assert.equal(
    (switched.data as { ef?: number }).ef,
    undefined,
    'the previous algorithm payload is discarded'
  );
  assert.ok(
    (switched.data as { card?: unknown }).card !== undefined,
    'the new algorithm starts from its own default state'
  );
});

test('the off algorithm never schedules', () => {
  assert.equal(getAlgorithm('off').schedules, false);
  for (const id of ['fsrs', 'sm2', 'leitner'] as const) {
    assert.equal(getAlgorithm(id).schedules, true, `${id} schedules`);
  }
});

// ─── Ladders ───────────────────────────────────────────────────────────────

test('every ladder step agrees with what the corresponding review commits', () => {
  // The invariant that makes the ladder safe to show: a previewed interval is
  // the committed interval, not an approximation of it. Checked at three
  // maturities so a fresh note and a settled one are both covered.
  for (const id of ['fsrs', 'sm2', 'leitner'] as const) {
    const algorithm = getAlgorithm(id);
    let state: NoteSrsState | null = null;
    let now = NOW;

    for (let pass = 0; pass < 3; pass++) {
      const ctx = context({ now });
      const ladder = algorithm.ladder(state, ctx);
      assert.ok(ladder.length > 0, `${id}: ladder is non-empty`);

      for (const step of ladder) {
        assert.equal(
          algorithm.review(state, step.rating, ctx).due,
          step.due,
          `${id} pass ${pass}: ${step.rating} previews what it commits`
        );
      }

      state = algorithm.review(state, 'good', ctx);
      now = state.due;
    }
  }
});

test('a ladder ascends by interval', () => {
  for (const id of ['fsrs', 'sm2', 'leitner'] as const) {
    const ladder = getAlgorithm(id).ladder(null, context());
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(
        ladder[i]!.intervalDays >= ladder[i - 1]!.intervalDays,
        `${id} is ascending: ${JSON.stringify(ladder.map((s) => s.intervalDays))}`
      );
    }
  }
});

test('the off algorithm has no ladder', () => {
  // Nothing to preview: with no scheduling, every grade is the same press.
  assert.deepEqual(getAlgorithm('off').ladder(null, context()), []);
});

test('SM-2 cannot tell its passing grades apart before the second repetition', () => {
  // Not a defect to fix — reps === 1 gives every passing grade the same day,
  // and the ladder reports that honestly rather than inventing a spread.
  const ladder = getAlgorithm('sm2').ladder(null, context());
  assert.deepEqual(
    ladder.map((step) => step.intervalDays),
    [1, 1, 1, 1]
  );
});

test('Leitner previews holding its box on hard and advancing on good', () => {
  const algorithm = getAlgorithm('leitner');
  let state = algorithm.review(null, 'good', context());
  state = algorithm.review(state, 'good', context());

  const ladder = algorithm.ladder(state, context());
  const byRating = new Map(ladder.map((step) => [step.rating, step.intervalDays]));

  assert.equal(byRating.get('again'), 1, 'a lapse drops to the first box');
  assert.equal(byRating.get('hard'), 3, 'hard holds the current box');
  assert.equal(byRating.get('good'), 7, 'good advances one box');
  assert.equal(byRating.get('easy'), 7, 'the two-grade scheme has nowhere further to go');
});

test('FSRS applies its cap to hard, then forces good and easy past it', () => {
  // `ts-fsrs` clamps to maximum_interval and *then* enforces
  // `good >= hard + 1` and `easy >= good + 1`, so the cap is soft by up to two
  // days and the top grades are pinned a day apart once it binds. Pinned here
  // because the interval tuning UI depends on knowing the ceiling it reports
  // is not the ceiling FSRS enforces.
  const algorithm = getAlgorithm('fsrs');
  const ctx = context();
  let state: NoteSrsState | null = null;
  let now = NOW;
  for (let i = 0; i < 4; i++) {
    state = algorithm.review(state, 'good', context({ now }));
    now = state.due;
  }

  const byRating = new Map(
    algorithm.ladder(state, context({ now })).map((step) => [
      step.rating,
      step.intervalDays,
    ])
  );
  const hard = byRating.get('hard')!;
  const good = byRating.get('good')!;
  const easy = byRating.get('easy')!;

  assert.equal(hard, ctx.fsrs.maximumInterval, 'hard lands exactly on the cap');
  assert.equal(good, hard + 1, 'good is pushed one day past it');
  assert.equal(easy, good + 1, 'easy is pushed one day past good');
});

// ─── Learning steps (the sub-day rungs) ─────────────────────────────────────

test('learning steps are the only route to an interval under a day', () => {
  const algorithm = getAlgorithm('fsrs');

  // The day-scale path floors at a day: ts-fsrs computes
  // `max(1, round(stability * modifier))`, so nothing sub-day can come out of
  // it however the retention is set.
  for (const step of algorithm.ladder(null, context())) {
    assert.ok(
      step.intervalDays >= 1,
      `day-scale floors at a day, got ${step.intervalDays}`
    );
  }

  const withSteps = algorithm.ladder(
    null,
    context({
      fsrs: {
        ...FSRS_DEFAULT_TUNABLES,
        enableFuzz: false,
        enableShortTerm: true,
      },
    })
  );

  const shortest = withSteps[0]!;
  assert.equal(
    Math.round(shortest.intervalDays * 1440),
    1,
    'with learning steps the bottom rung is exactly one minute'
  );
});

test('learning steps are off unless a preset asks for them', () => {
  // Switching this on changes what the feed does inside a single sitting, so
  // it must never arrive by default or by accident.
  assert.equal(FSRS_DEFAULT_TUNABLES.enableShortTerm, false);

  const algorithm = getAlgorithm('fsrs');
  const shortest = algorithm.ladder(null, context())[0]!;
  assert.ok(
    shortest.intervalDays >= 1,
    'the default ladder never reaches below a day'
  );
});

// ─── The model interval ────────────────────────────────────────────────────

test('the model interval is the library\'s own arithmetic, not a second guess', () => {
  // `intervalModifierFor` recomputes a factor ts-fsrs marks `protected`, so it
  // has to be pinned against the library rather than trusted. The easy grade is
  // the pin: FSRS forces each grade at least a day past the previous one, so
  // wherever `easy` is not merely `good + 1` its committed value is the
  // library's own rounding of stability times the modifier — and rounding the
  // model interval must therefore reproduce it.
  const algorithm = getAlgorithm('fsrs');
  const fsrs: FsrsTunables = {
    ...FSRS_DEFAULT_TUNABLES,
    enableFuzz: false,
    maximumInterval: 3650,
  };

  let state: NoteSrsState | null = null;
  let now = NOW;
  let checked = 0;

  for (let i = 0; i < 10; i++) {
    const ladder = algorithm.ladder(state, context({ now, fsrs }));
    const easy = ladder.find((step) => step.rating === 'easy')!;
    const good = ladder.find((step) => step.rating === 'good')!;

    if (Math.round(easy.intervalDays) > Math.round(good.intervalDays) + 1) {
      assert.equal(
        Math.min(Math.max(1, Math.round(easy.modelDays)), fsrs.maximumInterval),
        Math.round(easy.intervalDays),
        `pass ${i}: model ${easy.modelDays} must round to the committed ${easy.intervalDays}`
      );
      checked += 1;
    }

    state = algorithm.review(state, 'good', context({ now, fsrs }));
    now = state.due;
  }

  assert.ok(checked >= 5, `the pin must actually run: only ${checked} passes checked`);
});

test('a note reviewed earlier the same day reports one model interval for three grades', () => {
  // The case that made the retention control look broken. FSRS recomputes
  // elapsed days from the last review and floors it to whole days, so a review
  // an hour ago is zero elapsed: retrievability is 1, the recall growth term
  // exp((1-R)*w10) - 1 is 0, and Hard, Good and Easy all keep the card's
  // stability unchanged. The committed values are still 1/2/3/4, because
  // ts-fsrs's ordering rule forces them apart — which is exactly why the
  // display shows the model's value instead.
  const algorithm = getAlgorithm('fsrs');
  const fsrs: FsrsTunables = { ...FSRS_DEFAULT_TUNABLES, enableFuzz: false };
  const state = algorithm.review(null, 'good', context({ now: NOW, fsrs }));

  // Read the ladder back an hour later — still the same UTC calendar day.
  const ladder = algorithm.ladder(state, context({ now: NOW + 3_600_000, fsrs }));
  const byRating = new Map(ladder.map((step) => [step.rating, step]));

  const hard = byRating.get('hard')!;
  const good = byRating.get('good')!;
  const easy = byRating.get('easy')!;

  assert.equal(hard.modelDays, good.modelDays, 'hard and good: one model value');
  assert.equal(good.modelDays, easy.modelDays, 'good and easy: one model value');

  assert.ok(
    Math.round(easy.intervalDays) > Math.round(hard.intervalDays),
    'while the committed values are pushed apart by the ordering rule'
  );
});
