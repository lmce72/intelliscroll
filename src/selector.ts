import type {
  AlgorithmId,
  NotePreview,
  NoteSrsState,
  ViewHistoryEntry,
} from './types.ts';

const COOLDOWN_MS = 30 * 60 * 1000;
const RECENTLY_VIEWED_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Priority bonus, expressed in days of overdue-ness, for a note that was shown
 * but not engaged with.
 *
 * This is how a skipped note gets a second chance without touching its
 * schedule. A skip is the absence of a review, not a failed one, so it must
 * never shorten an interval — but letting it drop silently to the back of the
 * queue would starve notes the user genuinely has not read.
 */
const UNENGAGED_BOOST_DAYS = 1;

/**
 * How long that boost takes to fade, in days.
 *
 * Without decay the boost is permanent: `unengagedAt` is never cleared except
 * by a real review, so every note ever scrolled past would carry a permanent
 * +1 day. In a vault where most notes have been skipped at some point that
 * bonus applies to nearly everything, which cancels it out and leaves the feed
 * ordering skewed for no reason. "Give it a second chance soon" should mean
 * soon, not forever.
 */
const UNENGAGED_BOOST_WINDOW_DAYS = 3;

/**
 * Random spread, in days, added to each priority.
 *
 * Without this the feed becomes a strict due-date ordering, which loses the
 * scroll feel the plugin is built around. One day of spread means a note that
 * is meaningfully overdue still reliably wins, while near-ties shuffle.
 */
const PRIORITY_JITTER_DAYS = 1;

/**
 * Share of each batch reserved for notes the scheduler has no review history
 * for.
 *
 * Without a reservation, a backlog of overdue notes fills every batch forever
 * and the bulk of a mostly-unreviewed vault is never seen — a cold-start
 * starvation loop where notes that are never shown can never accrue the
 * history that would make them showable.
 */
const EXPLORE_RATIO = 0.25;

export interface SelectionOptions {
  /** The active scheduler. `off` (or omitted) keeps the original shuffle. */
  algorithm?: AlgorithmId;
  /** Per-note scheduling state, keyed by path. */
  states?: Readonly<Record<string, NoteSrsState>>;
  /** Injectable for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
}

export function selectBatch(
  candidates: NotePreview[],
  history: ViewHistoryEntry[],
  batchSize: number,
  now: number,
  options: SelectionOptions = {}
): NotePreview[] {
  const rng = options.rng ?? Math.random;
  const states = options.states;
  const scheduling =
    options.algorithm !== undefined &&
    options.algorithm !== 'off' &&
    states !== undefined;

  const lastViewedAt = new Map<string, number>();
  for (const entry of history) {
    const previous = lastViewedAt.get(entry.path);
    if (previous === undefined || entry.viewedAt > previous) {
      lastViewedAt.set(entry.path, entry.viewedAt);
    }
  }

  const recentWeek: NotePreview[] = [];
  const fresh: NotePreview[] = [];
  const coolingDown: NotePreview[] = [];

  for (const preview of candidates) {
    const viewedAt = lastViewedAt.get(preview.path);
    const state = states?.[preview.path];

    // A note that has been reviewed *since it was last shown* is exempt from
    // the cooldown: the reader has already said when they want it back, and the
    // schedule is the better authority on that than a fixed delay.
    //
    // This is what makes a sub-day interval meaningful. Without it a note rated
    // "again in a minute" would still be held back for the full cooldown, so
    // the minute would be decorative. Notes that were merely scrolled past are
    // untouched — reaching this needs a review, and a review moves the due date,
    // so an automatically graded note still loses on priority to anything
    // genuinely overdue.
    const reviewedSinceView =
      state !== undefined &&
      state.reviews > 0 &&
      viewedAt !== undefined &&
      state.lastReviewedAt >= viewedAt;

    if (
      viewedAt !== undefined &&
      now - viewedAt < COOLDOWN_MS &&
      !reviewedSinceView
    ) {
      coolingDown.push(preview);
      continue;
    }

    if (viewedAt !== undefined && now - viewedAt < RECENTLY_VIEWED_MS) {
      recentWeek.push(preview);
    } else {
      fresh.push(preview);
    }
  }

  // A small or heavily filtered vault can put every note in cooldown. In that
  // case, repeat notes instead of returning an empty feed.
  if (recentWeek.length === 0 && fresh.length === 0) {
    recentWeek.push(...coolingDown);
  }

  // Calculate how many recent we can include (20% of batch)
  const maxRecent = Math.floor(batchSize * 0.2);

  const recentCount = Math.min(maxRecent, recentWeek.length);
  const freshCount = Math.min(fresh.length, batchSize - recentCount);
  const additionalRecent = Math.min(
    recentWeek.length - recentCount,
    batchSize - recentCount - freshCount
  );

  const pick = scheduling
    ? (items: NotePreview[], count: number) =>
        takeByPriority(items, count, states, now, rng)
    : (items: NotePreview[], count: number) => takeRandom(items, count, rng);

  const selectedRecent = pick(recentWeek, recentCount + additionalRecent);
  const selectedFresh = pick(fresh, freshCount);

  return [
    ...selectedRecent.slice(0, recentCount),
    ...selectedFresh,
    ...selectedRecent.slice(recentCount),
  ];
}

/**
 * How strongly a reviewed note wants to be shown, in days of overdue-ness.
 *
 * Only ever called for notes that have actually been reviewed. A note that was
 * merely shown and skipped carries `reviews === 0` and is deliberately kept
 * out of this path: its placeholder state has `due: 0`, and treating that as a
 * real due date would compute roughly 19,700 days overdue and pin every
 * skipped note to the top of the feed permanently.
 */
function priorityOf(
  state: NoteSrsState,
  now: number,
  rng: () => number
): number {
  let score = (now - state.due) / DAY_MS;

  if (state.unengagedAt !== undefined) {
    const ageDays = (now - state.unengagedAt) / DAY_MS;
    const freshness = 1 - ageDays / UNENGAGED_BOOST_WINDOW_DAYS;
    if (freshness > 0) {
      score += UNENGAGED_BOOST_DAYS * freshness;
    }
  }

  return score + rng() * PRIORITY_JITTER_DAYS;
}

type ScoredPreview = { item: NotePreview; score: number };

function takeByPriority(
  items: NotePreview[],
  count: number,
  states: Readonly<Record<string, NoteSrsState>>,
  now: number,
  rng: () => number
): NotePreview[] {
  const scheduled: ScoredPreview[] = [];
  const unscheduled: NotePreview[] = [];

  for (const item of items) {
    const state = states[item.path];
    if (state && state.reviews > 0) {
      scheduled.push({ item, score: priorityOf(state, now, rng) });
    } else {
      unscheduled.push(item);
    }
  }

  scheduled.sort((a, b) => b.score - a.score);
  shuffleInPlace(unscheduled, rng);

  // Reserve a slice for notes with no review history, then let the two pools
  // top each other up so a batch is still full when one side runs dry.
  const reserved = Math.min(
    unscheduled.length,
    Math.floor(count * EXPLORE_RATIO)
  );

  let fromScheduled = Math.min(scheduled.length, count - reserved);
  let fromUnscheduled = Math.min(unscheduled.length, count - fromScheduled);

  fromScheduled = Math.min(scheduled.length, count - fromUnscheduled);
  fromUnscheduled = Math.min(unscheduled.length, count - fromScheduled);

  return [
    ...scheduled.slice(0, fromScheduled).map((entry) => entry.item),
    ...unscheduled.slice(0, fromUnscheduled),
  ];
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

function takeRandom<T>(items: T[], count: number, rng: () => number): T[] {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (items.length - i));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }

  return items.slice(0, count);
}
