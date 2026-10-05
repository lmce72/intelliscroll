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
  const states = ladder('fsrs', ['good', 'good', 'good', 'good']);
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
