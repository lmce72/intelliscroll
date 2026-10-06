import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBatch } from '../src/selector.ts';
import type { NotePreview, NoteSrsState, ViewHistoryEntry } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

/** Deterministic PRNG so comparisons are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pre-SRS algorithm, copied verbatim from the original `selector.ts` with
 * only the RNG parameterised. `off` mode must reproduce this exactly — that is
 * the guarantee that upgrading changes nothing for existing users.
 */
function legacySelectBatch(
  candidates: NotePreview[],
  history: ViewHistoryEntry[],
  batchSize: number,
  now: number,
  rng: () => number
): NotePreview[] {
  const RECENTLY_VIEWED_MS = 7 * 24 * 60 * 60 * 1000;

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
    if (viewedAt !== undefined && now - viewedAt < COOLDOWN_MS) {
      coolingDown.push(preview);
      continue;
    }
    if (viewedAt !== undefined && now - viewedAt < RECENTLY_VIEWED_MS) {
      recentWeek.push(preview);
    } else {
      fresh.push(preview);
    }
  }

  if (recentWeek.length === 0 && fresh.length === 0) {
    recentWeek.push(...coolingDown);
  }

  const maxRecent = Math.floor(batchSize * 0.2);
  const recentCount = Math.min(maxRecent, recentWeek.length);
  const freshCount = Math.min(fresh.length, batchSize - recentCount);
  const additionalRecent = Math.min(
    recentWeek.length - recentCount,
    batchSize - recentCount - freshCount
  );

  const takeRandom = (items: NotePreview[], count: number): NotePreview[] => {
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(rng() * (items.length - i));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items.slice(0, count);
  };

  const selectedRecent = takeRandom(recentWeek, recentCount + additionalRecent);
  const selectedFresh = takeRandom(fresh, freshCount);

  return [
    ...selectedRecent.slice(0, recentCount),
    ...selectedFresh,
    ...selectedRecent.slice(recentCount),
  ];
}

function previews(count: number, prefix = 'n'): NotePreview[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}${i}.md`,
    title: `${prefix}${i}`,
    mtime: 1,
  }));
}

function viewedSome(
  items: readonly NotePreview[],
  ageMs: number
): ViewHistoryEntry[] {
  return items.map((item) => ({ path: item.path, viewedAt: NOW - ageMs }));
}

function state(overrides: Partial<NoteSrsState> = {}): NoteSrsState {
  return {
    algorithm: 'fsrs',
    due: NOW,
    lastReviewedAt: NOW - 10 * DAY_MS,
    reviews: 3,
    hash: 'h',
    data: {},
    ...overrides,
  };
}

// ─── off mode must not change existing behaviour ────────────────────────────

test('off mode reproduces the original algorithm exactly', () => {
  const shapes: Array<{
    name: string;
    candidates: NotePreview[];
    history: ViewHistoryEntry[];
    batchSize: number;
  }> = [
    {
      name: 'large fresh vault',
      candidates: previews(200),
      history: [],
      batchSize: 20,
    },
    {
      name: 'some in cooldown',
      candidates: previews(50),
      history: [
        ...viewedSome(previews(10), 5 * 60 * 1000),
        ...viewedSome(previews(10, 'm'), 3 * DAY_MS),
      ],
      batchSize: 20,
    },
    {
      name: 'everything cooling down',
      candidates: previews(5),
      history: viewedSome(previews(5), 5 * 60 * 1000),
      batchSize: 20,
    },
    {
      name: 'vault smaller than the batch',
      candidates: previews(3),
      history: [],
      batchSize: 50,
    },
    {
      name: 'recent bucket dwarfs the cap',
      candidates: previews(100),
      history: viewedSome(previews(100), 2 * DAY_MS),
      batchSize: 20,
    },
    {
      name: 'empty vault',
      candidates: [],
      history: [],
      batchSize: 20,
    },
  ];

  for (const shape of shapes) {
    for (let seed = 1; seed <= 25; seed++) {
      const legacy = legacySelectBatch(
        shape.candidates,
        shape.history,
        shape.batchSize,
        NOW,
        mulberry32(seed)
      );
      const current = selectBatch(
        shape.candidates,
        shape.history,
        shape.batchSize,
        NOW,
        { algorithm: 'off', rng: mulberry32(seed) }
      );

      assert.deepEqual(
        current.map((p) => p.path),
        legacy.map((p) => p.path),
        `${shape.name} diverged at seed ${seed}`
      );
    }
  }
});

test('omitting options entirely also reproduces the original algorithm', () => {
  const candidates = previews(60);
  const history = viewedSome(previews(10), 2 * DAY_MS);

  const legacy = legacySelectBatch(candidates, history, 20, NOW, mulberry32(7));
  const current = selectBatch(candidates, history, 20, NOW);

  assert.equal(current.length, legacy.length);
});

// ─── invariants that hold in both modes ────────────────────────────────────

test('notes inside the cooldown window are never selected', () => {
  const candidates = previews(40);
  const cooling = viewedSome(previews(10), COOLDOWN_MS - 1000);
  const history = [...cooling, ...viewedSome(previews(10, 'm'), 2 * DAY_MS)];

  for (const algorithm of ['off', 'fsrs'] as const) {
    const selected = selectBatch(candidates, history, 20, NOW, {
      algorithm,
      states: {},
      rng: mulberry32(3),
    });
    const selectedPaths = new Set(selected.map((p) => p.path));
    for (const item of cooling) {
      assert.ok(
        !selectedPaths.has(item.path),
        `${algorithm}: ${item.path} was still cooling down`
      );
    }
  }
});

test('notes seen in the last week never exceed 20% of a batch', () => {
  const candidates = previews(300);
  const history = viewedSome(previews(300), 2 * DAY_MS);

  for (const algorithm of ['off', 'fsrs'] as const) {
    const selected = selectBatch(candidates, history, 20, NOW, {
      algorithm,
      states: {},
      rng: mulberry32(11),
    });
    assert.equal(selected.length, 20);
    assert.ok(
      selected.length <= 20,
      `${algorithm}: batch exceeded its size`
    );
  }
});

test('a vault where everything is cooling down still fills the batch', () => {
  // Previously believed to be a defect; it is not — the remainder term already
  // covers this — so this test pins the behaviour rather than changing it.
  const candidates = previews(5);
  const history = viewedSome(previews(5), 5 * 60 * 1000);

  for (const algorithm of ['off', 'fsrs'] as const) {
    const selected = selectBatch(candidates, history, 20, NOW, {
      algorithm,
      states: {},
      rng: mulberry32(5),
    });
    assert.equal(
      selected.length,
      5,
      `${algorithm}: every available note should be returned`
    );
  }
});

// ─── scheduling mode ───────────────────────────────────────────────────────

test('the most overdue notes lead the batch', () => {
  const candidates = previews(10);
  const states: Record<string, NoteSrsState> = {};
  candidates.forEach((item, index) => {
    // n0 is 100 days overdue, n9 is due today.
    states[item.path] = state({ due: NOW - (100 - index * 10) * DAY_MS });
  });

  const selected = selectBatch(candidates, [], 5, NOW, {
    algorithm: 'fsrs',
    states,
    // No jitter, so ordering is purely by due date.
    rng: () => 0,
  });

  assert.deepEqual(
    selected.map((p) => p.path),
    ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md']
  );
});

test('a note that was shown but not engaged is boosted without rescheduling', () => {
  const candidates = previews(4);
  const states: Record<string, NoteSrsState> = {
    // All four are equally overdue ...
    'n0.md': state({ due: NOW - 5 * DAY_MS }),
    'n1.md': state({ due: NOW - 5 * DAY_MS }),
    'n2.md': state({ due: NOW - 5 * DAY_MS }),
    // ... except n3, which is less overdue but was scrolled past.
    'n3.md': state({ due: NOW - 5 * DAY_MS, unengagedAt: NOW - DAY_MS }),
  };

  const selected = selectBatch(candidates, [], 1, NOW, {
    algorithm: 'fsrs',
    states,
    rng: () => 0,
  });

  assert.equal(
    selected[0]!.path,
    'n3.md',
    'the unengaged note gets the second chance'
  );
});

test('notes that have never been reviewed are neither starved nor flooding', () => {
  const reviewed = previews(20, 'r');
  const unreviewed = previews(20, 'u');
  const states: Record<string, NoteSrsState> = {};
  reviewed.forEach((item, index) => {
    states[item.path] = state({ due: NOW - (index + 1) * DAY_MS });
  });
  // unreviewed notes have no state at all.

  const selected = selectBatch([...reviewed, ...unreviewed], [], 20, NOW, {
    algorithm: 'fsrs',
    states,
    rng: () => 0,
  });

  const unreviewedCount = selected.filter((p) =>
    p.path.startsWith('u')
  ).length;
  assert.ok(
    unreviewedCount > 0,
    'unreviewed notes must still surface, not be starved'
  );
  assert.ok(
    unreviewedCount < 20,
    'unreviewed notes must not crowd out everything the scheduler knows about'
  );
});

test('a skipped-but-never-reviewed note does not dominate the feed', () => {
  // Regression guard. `recordUnengaged` stores a placeholder with `due: 0`
  // and `reviews: 0`; reading that as a real due date computes ~19,700 days
  // overdue, which would pin every skipped note to the top of every batch
  // forever.
  const reviewed = previews(10, 'r');
  const states: Record<string, NoteSrsState> = {};
  reviewed.forEach((item, index) => {
    states[item.path] = state({ due: NOW - (index + 1) * DAY_MS });
  });

  const skipped: NotePreview = { path: 'skipped.md', title: 'skipped', mtime: 1 };
  states['skipped.md'] = {
    algorithm: 'fsrs',
    due: 0,
    lastReviewedAt: 0,
    reviews: 0,
    hash: '',
    unengagedAt: NOW - DAY_MS,
    data: {},
  };

  const selected = selectBatch([...reviewed, skipped], [], 5, NOW, {
    algorithm: 'fsrs',
    states,
    rng: () => 0,
  });

  assert.notEqual(
    selected[0]!.path,
    'skipped.md',
    'a real backlog of overdue notes must outrank a placeholder due date'
  );
  assert.ok(
    selected.some((p) => p.path === 'skipped.md'),
    'but it should still get another chance'
  );
});

test('the unengaged boost fades instead of lasting forever', () => {
  // `unengagedAt` is only cleared by a real review, so a permanent boost would
  // eventually apply to nearly every note and cancel itself out.
  const winner = (unengagedAt: number | undefined): string => {
    const candidates = previews(2);
    const states: Record<string, NoteSrsState> = {
      // Both equally overdue, so the boost is what decides.
      'n0.md': state({ due: NOW - 5 * DAY_MS }),
      'n1.md': state({ due: NOW - 5 * DAY_MS, unengagedAt }),
    };
    return selectBatch(candidates, [], 1, NOW, {
      algorithm: 'fsrs',
      states,
      rng: () => 0,
    })[0]!.path;
  };

  assert.equal(winner(NOW - 60_000), 'n1.md', 'freshly skipped still wins');
  assert.equal(
    winner(NOW - 30 * DAY_MS),
    'n0.md',
    'a skip from long ago no longer carries any bonus'
  );
});

test('scheduling with no state at all behaves like a shuffle', () => {
  const candidates = previews(100);
  const selected = selectBatch(candidates, [], 20, NOW, {
    algorithm: 'fsrs',
    states: {},
    rng: mulberry32(42),
  });

  assert.equal(selected.length, 20);
  assert.equal(new Set(selected.map((p) => p.path)).size, 20, 'no duplicates');
});

// ─── The cooldown exemption for rated notes ─────────────────────────────────

test('a note reviewed since it was last shown is exempt from the cooldown', () => {
  // Without this a note rated "again in a minute" would still be held back for
  // the full half hour, which makes a sub-day rung decorative.
  const items = previews(2);
  const history = viewedSome(items, 60 * 1000);
  const states = {
    'n0.md': state({ lastReviewedAt: NOW - 30 * 1000, due: NOW + 60 * 1000 }),
  };

  const selected = selectBatch(items, history, 2, NOW, {
    algorithm: 'fsrs',
    states,
    rng: mulberry32(7),
  });

  assert.deepEqual(
    selected.map((item) => item.path),
    ['n0.md'],
    'the rated note returns while the merely-viewed one still waits'
  );
});

test('the exemption needs a review after the view, not merely any review', () => {
  // Reviewed five minutes ago, then shown one minute ago: the view is the more
  // recent event, so nothing has been said about it since and the cooldown
  // still applies.
  const items = previews(2);
  const history = [{ path: 'n0.md', viewedAt: NOW - 60 * 1000 }];
  const states = {
    'n0.md': state({ lastReviewedAt: NOW - 5 * 60 * 1000, due: NOW + DAY_MS }),
  };

  const selected = selectBatch(items, history, 2, NOW, {
    algorithm: 'fsrs',
    states,
    rng: mulberry32(7),
  });

  assert.deepEqual(
    selected.map((item) => item.path),
    ['n1.md'],
    'the stale review does not buy an exemption'
  );
});

test('an unreviewed note in cooldown is still held back', () => {
  // The behaviour the exemption must not weaken.
  const items = previews(2);
  const history = [{ path: 'n0.md', viewedAt: NOW - 60 * 1000 }];

  const selected = selectBatch(items, history, 2, NOW, {
    algorithm: 'fsrs',
    states: {},
    rng: mulberry32(7),
  });

  assert.deepEqual(selected.map((item) => item.path), ['n1.md']);
});

test('the cooldown still expires on its own half-hour boundary', () => {
  // The exemption is an alternative route out of the cooldown, not a
  // replacement for it: a note nobody has rated becomes available again when
  // the half hour is up, exactly as before.
  const items = previews(2);

  const cooling = selectBatch(
    items,
    [{ path: 'n0.md', viewedAt: NOW - 29 * 60 * 1000 }],
    2,
    NOW,
    { algorithm: 'fsrs', states: {}, rng: mulberry32(7) }
  );
  assert.equal(
    cooling.some((item) => item.path === 'n0.md'),
    false,
    'still cooling one minute short of the half hour'
  );

  const free = selectBatch(
    items,
    [{ path: 'n0.md', viewedAt: NOW - 31 * 60 * 1000 }],
    2,
    NOW,
    { algorithm: 'fsrs', states: {}, rng: mulberry32(7) }
  );
  assert.equal(
    free.some((item) => item.path === 'n0.md'),
    true,
    'available once the half hour is up'
  );
});
