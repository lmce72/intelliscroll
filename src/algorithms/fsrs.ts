import {
  computeDecayFactor,
  createEmptyCard,
  FSRS6_DEFAULT_DECAY,
  fsrs,
  generatorParameters,
  Rating as FsrsRating,
  type Card,
  type Grade,
} from 'ts-fsrs';
import type { FsrsTunables, NoteSrsState, Rating } from '../types.ts';
import {
  DAY_MS,
  ladderFrom,
  makeState,
  payloadFor,
  RATING_ORDER,
  type SchedulerAlgorithm,
} from './shared.ts';

/**
 * FSRS-6 via `ts-fsrs`.
 *
 * The recommended engine. A scroll feed cannot guarantee that a note is
 * reviewed on its due date, and FSRS is the only one of the candidates that
 * models recall probability at an arbitrary elapsed time — so reviewing early
 * or late degrades gracefully instead of corrupting an interval multiplier.
 *
 * `ts-fsrs` is MIT, has zero runtime dependencies, ships a CommonJS build, is
 * pure JS (no native module, so it is safe on mobile), and is already shipped
 * by the mainstream Obsidian spaced-repetition plugin.
 */

const RATING_MAP: Record<Rating, Grade> = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
};

type FsrsPayload = {
  /** The FSRS card, with its Date fields stored as ISO strings. */
  card: Record<string, unknown>;
};

/**
 * The scheduler is rebuilt only when the tunables actually change, so the
 * per-review cost does not include parameter validation.
 */
let cachedKey: string | null = null;
let cachedScheduler: ReturnType<typeof fsrs> | null = null;

function schedulerFor(tunables: FsrsTunables): ReturnType<typeof fsrs> {
  const key = [
    tunables.requestRetention,
    tunables.maximumInterval,
    tunables.enableFuzz,
    tunables.enableShortTerm,
  ].join('|');

  if (cachedScheduler === null || cachedKey !== key) {
    cachedScheduler = fsrs(
      generatorParameters({
        request_retention: tunables.requestRetention,
        maximum_interval: tunables.maximumInterval,
        enable_fuzz: tunables.enableFuzz,
        // Off by default, and deliberately so: a whole note is re-read, not
        // drilled, so minute-scale learning steps resurface the same note
        // several times in one sitting. See the note on
        // `FsrsTunables.enableShortTerm` — it is the only way to an interval
        // below a day, which is why it is reachable at all.
        enable_short_term: tunables.enableShortTerm,
      })
    );
    cachedKey = key;
  }

  return cachedScheduler;
}

/**
 * Dates do not survive JSON, so they are stored as ISO strings. Serializing
 * generically (rather than listing fields) keeps this working when ts-fsrs
 * adds or removes card fields.
 */
function serializeCard(card: Card): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function deserializeCard(
  raw: Record<string, unknown>,
  fallbackNow: number
): Card {
  const due = typeof raw.due === 'string' ? new Date(raw.due) : new Date(fallbackNow);
  const card: Record<string, unknown> = { ...raw, due };

  // A `Date` is accepted as well as the ISO string `serializeCard` writes.
  //
  // Discarding anything that is not a string was worse than it looks: ts-fsrs
  // derives elapsed time from `last_review`, so a dropped field silently means
  // "never reviewed" — elapsed 0, retrievability 1, and a stability that does
  // not grow. The card would keep scheduling as though it had just been seen,
  // which is exactly the "the intervals are stuck" symptom, with nothing in the
  // log to explain it. Anything else is still dropped, because a card that
  // cannot say when it was last reviewed must not pretend to know.
  if (typeof raw.last_review === 'string') {
    card.last_review = new Date(raw.last_review);
  } else if (raw.last_review instanceof Date) {
    card.last_review = raw.last_review;
  } else {
    delete card.last_review;
  }

  return card as unknown as Card;
}

/** The card a review would start from: the stored one, or a fresh card. */
function cardFor(previous: NoteSrsState | null, now: number): Card {
  const prior = payloadFor(previous, 'fsrs') as FsrsPayload | null;
  return prior && prior.card
    ? deserializeCard(prior.card, now)
    : createEmptyCard(new Date(now));
}

/**
 * The factor FSRS scales a card's stability by to hit a requested retention.
 *
 * ts-fsrs holds this on the algorithm object but marks it `protected`, so it is
 * recomputed from the two pieces the library does export. The formula is the
 * library's own — `computeDecayFactor` supplies FSRS-6's decay and the factor
 * that goes with it — and a test pins the result against `next_interval`, so an
 * upstream change breaks a test rather than silently shifting every interval
 * this plugin displays.
 */
function intervalModifierFor(requestRetention: number): number {
  const { decay, factor } = computeDecayFactor(FSRS6_DEFAULT_DECAY);
  return (Math.pow(requestRetention, 1 / decay) - 1) / factor;
}

export const fsrsAlgorithm: SchedulerAlgorithm = {
  id: 'fsrs',
  label: 'FSRS-6',
  description:
    'Modern forgetting-curve scheduler. Handles irregular review timing best.',
  schedules: true,
  review(previous, rating, ctx) {
    const { card: next } = schedulerFor(ctx.fsrs).next(
      cardFor(previous, ctx.now),
      new Date(ctx.now),
      RATING_MAP[rating]
    );

    return makeState({
      algorithm: 'fsrs',
      due: next.due.getTime(),
      now: ctx.now,
      hash: ctx.hash,
      previous,
      data: { card: serializeCard(next) } satisfies FsrsPayload,
    });
  },
  ladder(previous, ctx) {
    const now = ctx.now;
    const scheduler = schedulerFor(ctx.fsrs);
    // `repeat()` is what `next()` itself calls, so every step here is by
    // construction the same value a press would commit.
    const outcomes = scheduler.repeat(cardFor(previous, now), new Date(now));

    // What the model computed, before ts-fsrs rounds it and pushes each grade
    // past the previous one. The cap applies; the one-day floor and the
    // rounding do not, because those two are what hide the retention control's
    // effect — sweeping it moves the model's value by a factor of ten while
    // every rounded value stays put.
    const modifier = intervalModifierFor(ctx.fsrs.requestRetention);

    return ladderFrom(
      RATING_ORDER,
      (rating) =>
        (outcomes[RATING_MAP[rating]].card.due.getTime() - now) / DAY_MS,
      now,
      (rating) =>
        Math.min(
          outcomes[RATING_MAP[rating]].card.stability * modifier,
          ctx.fsrs.maximumInterval
        )
    );
  },
};
