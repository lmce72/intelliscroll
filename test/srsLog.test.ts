import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataAdapter } from 'obsidian';
import {
  SrsStore,
  foldEntries,
  parseLogEntry,
  setSrsLogging,
  splitLogLines,
} from '../src/srsLog.ts';
import { getAlgorithm } from '../src/algorithms/index.ts';
import { FSRS_DEFAULT_TUNABLES } from '../src/types.ts';
import type { NoteSrsState, SrsLogEntry } from '../src/types.ts';

const NOW = Date.UTC(2026, 0, 1);
const DIR = '.obsidian/plugins/intelliscroll';

/** Minimal in-memory stand-in for Obsidian's vault adapter. */
class FakeAdapter {
  files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async append(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`missing: ${path}`);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`missing: ${from}`);
    // Obsidian's FileSystemAdapter refuses to overwrite instead of replacing,
    // so a fake that quietly overwrites hides a real failure mode.
    if (this.files.has(to)) throw new Error('Destination file already exists!');
    this.files.set(to, value);
    this.files.delete(from);
  }
}

/** Adapter whose next append fails, and whose snapshot write can be held. */
class FlakyAdapter extends FakeAdapter {
  failNextAppend = false;
  /** When set, writing the snapshot temp file waits for this promise. */
  gateTmpWrite: Promise<void> | null = null;

  override async append(path: string, data: string): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('append failed');
    }
    return super.append(path, data);
  }

  override async write(path: string, data: string): Promise<void> {
    if (this.gateTmpWrite && path.endsWith('srs-snapshot.tmp.json')) {
      await this.gateTmpWrite;
    }
    return super.write(path, data);
  }
}

function makeStore(adapter: FakeAdapter): SrsStore {
  return new SrsStore(adapter as unknown as DataAdapter, DIR);
}

function reviewEntry(path: string, due: number, t = NOW): SrsLogEntry {
  const state: NoteSrsState = {
    algorithm: 'sm2',
    due,
    lastReviewedAt: t,
    reviews: 1,
    hash: 'h',
    data: { ef: 2.5, intervalDays: 1, reps: 1 },
  };
  return { t, path, kind: 'review', rating: 'good', state };
}

// ─── log parsing ───────────────────────────────────────────────────────────

test('splits a log into raw lines and tolerates a truncated final line', () => {
  assert.deepEqual(splitLogLines(''), []);
  assert.deepEqual(splitLogLines('{"a":1}\n'), ['{"a":1}']);
  assert.deepEqual(splitLogLines('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  // A crash midway through an append leaves a partial line; it must still be
  // returned so the caller can count it, and parsing it must simply fail.
  assert.deepEqual(splitLogLines('{"a":1}\n{"b":'), ['{"a":1}', '{"b":']);
});

test('drops malformed log lines instead of taking the whole log down', () => {
  assert.equal(parseLogEntry('{"b":'), null);
  assert.equal(parseLogEntry('not json at all'), null);
  assert.equal(parseLogEntry(''), null);
  assert.equal(parseLogEntry('{"t":1}'), null, 'missing path');
  assert.equal(parseLogEntry('{"path":"a"}'), null, 'missing timestamp');
  assert.equal(parseLogEntry('{"t":1,"path":"a","kind":"nope"}'), null);
  assert.equal(
    parseLogEntry('{"t":1,"path":"a","kind":"review","rating":"terrible"}'),
    null,
    'unknown rating'
  );

  const good = parseLogEntry('{"t":1,"path":"a","kind":"unengaged"}');
  assert.equal(good?.path, 'a');
});

// ─── folding ───────────────────────────────────────────────────────────────

test('the newest review entry for a path wins', () => {
  const states = foldEntries({}, [
    reviewEntry('a.md', NOW + 1000),
    reviewEntry('a.md', NOW + 9000),
  ]);
  assert.equal(states['a.md']!.due, NOW + 9000);
});

test('an unengaged entry raises priority without touching the schedule', () => {
  // The property this whole design rests on: being scrolled past must never
  // reschedule a note, or skipped notes get shown more often and are skipped
  // more often again.
  const before = foldEntries({}, [reviewEntry('a.md', NOW + 5000)]);
  const after = foldEntries({ ...before }, [
    { t: NOW + 100, path: 'a.md', kind: 'unengaged' },
  ]);

  assert.equal(after['a.md']!.due, before['a.md']!.due, 'due date is untouched');
  assert.equal(
    after['a.md']!.data['intervalDays'],
    before['a.md']!.data['intervalDays'],
    'algorithm payload is untouched'
  );
  assert.equal(after['a.md']!.reviews, 1, 'no review was recorded');
  assert.equal(after['a.md']!.unengagedAt, NOW + 100, 'priority marker is set');
});

test('an unengaged entry for a never-reviewed note invents no review', () => {
  const states = foldEntries({}, [
    { t: NOW, path: 'new.md', kind: 'unengaged', algorithm: 'fsrs' },
  ]);
  const state = states['new.md']!;

  assert.equal(state.reviews, 0, 'still unreviewed');
  assert.equal(state.lastReviewedAt, 0);
  assert.equal(state.due, 0, 'due immediately, as an unreviewed note should be');
  assert.equal(state.unengagedAt, NOW);
});

test('an edit entry never creates state for an untracked note', () => {
  const states = foldEntries({}, [
    { t: NOW, path: 'ghost.md', kind: 'edit', hash: 'x' },
  ]);
  assert.equal(states['ghost.md'], undefined);
});

// ─── store round-trips ─────────────────────────────────────────────────────

test('records a review, persists it, and reloads to the same state', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();

  const algorithm = getAlgorithm('sm2');
  await store.recordReview(
    {
      path: 'note.md',
      rating: 'good',
      algorithm: 'sm2',
      source: 'auto',
      hash: 'hash-a',
      now: NOW,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    algorithm
  );
  await store.flush();

  const reloaded = makeStore(adapter);
  await reloaded.load();

  const original = store.getState('note.md')!;
  const restored = reloaded.getState('note.md')!;
  assert.deepEqual(restored, original);
  assert.equal(restored.reviews, 1);
  assert.equal(restored.hash, 'hash-a');
});

test('compaction folds the log into the snapshot and empties it', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();

  const algorithm = getAlgorithm('leitner');
  await store.recordReview(
    {
      path: 'a.md',
      rating: 'good',
      algorithm: 'leitner',
      source: 'auto',
      hash: 'h',
      now: NOW,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    algorithm
  );
  await store.compact();

  assert.equal(adapter.files.get(`${DIR}/srs-log.ndjson`), '', 'log truncated');
  assert.ok(adapter.files.has(`${DIR}/srs-snapshot.json`), 'snapshot written');
  assert.equal(
    adapter.files.has(`${DIR}/srs-snapshot.tmp.json`),
    false,
    'temp file is renamed away, not left behind'
  );

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.reviews, 1);
});

test('compacting again replaces the existing snapshot', async () => {
  // Obsidian's rename refuses to overwrite, so the second compaction is where
  // the destination check bites. Without removing it first, every compaction
  // after the first one failed, and every review past the threshold with it.
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  const algorithm = getAlgorithm('leitner');

  await store.load();
  for (const due of [NOW + 1000, NOW + 2000]) {
    await store.recordReview(
      {
        path: 'a.md',
        rating: 'good',
        algorithm: 'leitner',
        source: 'auto',
        hash: 'h',
        now: due,
        tunables: FSRS_DEFAULT_TUNABLES,
      },
      algorithm
    );
    await store.compact();
  }

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.reviews, 2);
  assert.ok(adapter.files.has(`${DIR}/srs-snapshot.json`));
  assert.equal(adapter.files.has(`${DIR}/srs-snapshot.tmp.json`), false);
});

test('a snapshot plus its covered log lines is not applied twice', async () => {
  // Simulates dying after the snapshot is written but before the log is
  // truncated — the one window the write ordering is designed to survive.
  const adapter = new FakeAdapter();
  const entry = reviewEntry('a.md', NOW + 1000);
  const line = JSON.stringify(entry);

  adapter.files.set(
    `${DIR}/srs-snapshot.json`,
    JSON.stringify({
      version: 1,
      logLines: 1,
      states: { 'a.md': entry.state },
    })
  );
  adapter.files.set(`${DIR}/srs-log.ndjson`, `${line}\n`);

  const store = makeStore(adapter);
  await store.load();

  const state = store.getState('a.md')!;
  assert.equal(state.reviews, 1, 'reviews must not be double-counted');
  assert.equal(state.due, NOW + 1000);
});

test('replays the whole log on top of the snapshot', async () => {
  const adapter = new FakeAdapter();
  const first = reviewEntry('a.md', NOW + 1000);
  const second = reviewEntry('a.md', NOW + 2000);

  adapter.files.set(
    `${DIR}/srs-snapshot.json`,
    JSON.stringify({
      version: 1,
      logLines: 1,
      states: { 'a.md': first.state },
    })
  );
  adapter.files.set(
    `${DIR}/srs-log.ndjson`,
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
  );

  const store = makeStore(adapter);
  await store.load();
  assert.equal(
    store.getState('a.md')!.due,
    NOW + 2000,
    'the later entry wins whether or not the snapshot already covered it'
  );
});

test('a stale watermark cannot hide entries written after a truncation', async () => {
  // The real failure: a snapshot written before truncation carried the *old*
  // log's length (500). After truncation the new log held fresh entries, and
  // loading skipped the first 500 of them — all of them. A week of reviews
  // disappeared on every restart.
  const adapter = new FakeAdapter();
  const old = reviewEntry('a.md', NOW + 1000);
  const fresh = reviewEntry('a.md', NOW + 9000);
  adapter.files.set(
    `${DIR}/srs-snapshot.json`,
    JSON.stringify({
      version: 1,
      logLines: 500,
      states: { 'a.md': old.state },
    })
  );
  adapter.files.set(`${DIR}/srs-log.ndjson`, `${JSON.stringify(fresh)}\n`);

  const store = makeStore(adapter);
  await store.load();
  assert.equal(
    store.getState('a.md')!.due,
    NOW + 9000,
    'the one entry in the current log must not be skipped'
  );
});

test('a failed compaction does not reject a review that was already logged', async () => {
  class UnrenameableAdapter extends FakeAdapter {
    override async rename(): Promise<void> {
      throw new Error('rename is broken');
    }
  }

  const adapter = new UnrenameableAdapter();
  const store = makeStore(adapter);
  const algorithm = getAlgorithm('leitner');
  await store.load();

  // The threshold is 500 lines; record exactly that many so the last write is
  // the one that attempts — and fails — to compact. The expected error is
  // reported by the store, so silence it for the duration of this test.
  setSrsLogging({ errors: false });
  try {
    for (let i = 0; i < 500; i++) {
      await store.recordReview(
        {
          path: 'a.md',
          rating: 'good',
          algorithm: 'leitner',
          source: 'auto',
          hash: 'h',
          now: NOW + i,
          tunables: FSRS_DEFAULT_TUNABLES,
        },
        algorithm
      );
    }
  } finally {
    setSrsLogging({ errors: true });
  }

  assert.equal(store.getState('a.md')!.reviews, 500, 'state was updated');
  const lines = adapter.files.get(`${DIR}/srs-log.ndjson`)!.trim().split('\n');
  assert.equal(lines.length, 500, 'every line is durable regardless');
});

test('an unreadable snapshot degrades to replaying the whole log', async () => {
  const adapter = new FakeAdapter();
  const entry = reviewEntry('a.md', NOW + 1000);
  adapter.files.set(`${DIR}/srs-snapshot.json`, '{ this is not json');
  adapter.files.set(`${DIR}/srs-log.ndjson`, `${JSON.stringify(entry)}\n`);

  const store = makeStore(adapter);
  await store.load();
  assert.equal(store.getState('a.md')!.due, NOW + 1000);
});

test('a repeat unengaged report inside the dedupe window is ignored', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();

  const logLines = (): number =>
    (adapter.files.get(`${DIR}/srs-log.ndjson`) ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;

  await store.recordUnengaged('a.md', NOW, 'fsrs');
  await store.flush();
  assert.equal(logLines(), 1);

  // Batch teardown re-reports the same visible card on every re-render.
  await store.recordUnengaged('a.md', NOW + 60_000, 'fsrs');
  await store.flush();
  assert.equal(logLines(), 1, 'the duplicate is not logged');
  assert.equal(
    store.getState('a.md')!.unengagedAt,
    NOW,
    'and the marker is not pushed forward'
  );

  // Once the window passes it records again.
  const later = NOW + 31 * 60 * 1000;
  await store.recordUnengaged('a.md', later, 'fsrs');
  await store.flush();
  assert.equal(logLines(), 2);
  assert.equal(store.getState('a.md')!.unengagedAt, later);
});

test('content hashing is stable and changes when the note changes', () => {
  const a = SrsStore.hashContent('hello world');
  assert.equal(a, SrsStore.hashContent('hello world'), 'deterministic');
  assert.notEqual(a, SrsStore.hashContent('hello worlds'));
  assert.equal(SrsStore.hashContent(''), '811c9dc5');
});

// ─── file lifecycle ────────────────────────────────────────────────────────

/** Record one reviewed note, so there is a state worth moving or deleting. */
async function seedReview(
  store: SrsStore,
  path: string,
  now = NOW
): Promise<void> {
  await store.recordReview(
    {
      path,
      rating: 'good',
      algorithm: 'leitner',
      source: 'auto',
      hash: 'h',
      now,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    getAlgorithm('leitner')
  );
}

test('a rename moves the schedule and survives a reload', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'old.md');

  assert.equal(await store.renamePath('old.md', 'new.md', NOW + 1000), true);
  assert.equal(store.getState('old.md'), undefined);
  assert.equal(store.getState('new.md')!.reviews, 1);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('old.md'), undefined, 'old path stays gone');
  assert.equal(reloaded.getState('new.md')!.reviews, 1, 'state followed');
});

test('a chain of renames keeps following the note', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'a.md');

  await store.renamePath('a.md', 'b.md', NOW + 1);
  await store.renamePath('b.md', 'c.md', NOW + 2);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md'), undefined);
  assert.equal(reloaded.getState('b.md'), undefined);
  assert.equal(reloaded.getState('c.md')!.reviews, 1);
});

test('renaming a note with no state writes nothing', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();

  assert.equal(await store.renamePath('never-seen.md', 'other.md', NOW), false);
  assert.equal(adapter.files.get(`${DIR}/srs-log.ndjson`), undefined);
});

test('a folder rename moves descendants and leaves a lookalike sibling alone', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'Notes/a.md', NOW + 1);
  await seedReview(store, 'Notes/sub/b.md', NOW + 2);
  await seedReview(store, 'Notes-archive/c.md', NOW + 3);

  const moved = await store.renameFolderPaths('Notes', 'Moved', NOW + 10);
  assert.equal(moved, 2);

  assert.equal(store.getState('Notes/a.md'), undefined);
  assert.equal(store.getState('Notes/sub/b.md'), undefined);
  assert.equal(store.getState('Moved/a.md')!.reviews, 1);
  assert.equal(store.getState('Moved/sub/b.md')!.reviews, 1);
  assert.ok(store.getState('Notes-archive/c.md'), 'sibling untouched');

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('Notes/a.md'), undefined);
  assert.equal(reloaded.getState('Moved/sub/b.md')!.reviews, 1);
  assert.ok(reloaded.getState('Notes-archive/c.md'));
});

test('a delete removes the state and a reload does not resurrect it', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'gone.md');

  assert.equal(await store.forgetPath('gone.md', NOW + 1000), true);
  assert.equal(store.getState('gone.md'), undefined);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('gone.md'), undefined);
});

test('a folder delete clears descendants but not a lookalike sibling', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'Notes/a.md', NOW + 1);
  await seedReview(store, 'Notes/sub/b.md', NOW + 2);
  await seedReview(store, 'Notes-archive/c.md', NOW + 3);

  assert.equal(await store.forgetFolderPaths('Notes', NOW + 10), 2);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('Notes/a.md'), undefined);
  assert.equal(reloaded.getState('Notes/sub/b.md'), undefined);
  assert.ok(reloaded.getState('Notes-archive/c.md'));
});

test('a rewrite by a new file at the old path keeps the moved schedule apart', async () => {
  // The path-reuse hazard: after a rename, a brand-new note is created at the
  // vacated path. It must not inherit the renamed note's schedule.
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'note.md', NOW + 1);
  await seedReview(store, 'note.md', NOW + 2);
  await store.renamePath('note.md', 'renamed.md', NOW + 3);
  await seedReview(store, 'note.md', NOW + 4);

  assert.equal(store.getState('renamed.md')!.reviews, 2, 'renamed note keeps its own');
  assert.equal(store.getState('note.md')!.reviews, 1, 'new note starts from its own review');

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('renamed.md')!.reviews, 2);
  assert.equal(reloaded.getState('note.md')!.reviews, 1);
});

test('a rename line without a source path is dropped instead of misfiled', () => {
  assert.equal(
    parseLogEntry('{"t":1,"path":"b.md","kind":"rename"}'),
    null,
    'a rename must name where it came from'
  );
  assert.equal(
    parseLogEntry('{"t":1,"path":"b.md","kind":"rename","from":"a.md"}')?.from,
    'a.md'
  );
  assert.equal(parseLogEntry('{"t":1,"path":"a.md","kind":"delete"}')?.kind, 'delete');
});

test('a failed append is retried by the next write', async () => {
  const adapter = new FlakyAdapter();
  const store = makeStore(adapter);
  await store.load();
  const algorithm = getAlgorithm('leitner');

  // An existing log file routes the write through `append`; on a fresh log the
  // store would use `write`, which this test is not failing.
  adapter.files.set(`${DIR}/srs-log.ndjson`, '');
  adapter.failNextAppend = true;
  await assert.rejects(
    store.recordReview(
      {
        path: 'a.md',
        rating: 'good',
        algorithm: 'leitner',
        source: 'auto',
        hash: 'h',
        now: NOW,
        tunables: FSRS_DEFAULT_TUNABLES,
      },
      algorithm
    ),
    'the caller must know the write did not land'
  );

  // The failed chunk was put back. The next write has to retry it rather than
  // chain onto a permanently rejected promise.
  await store.recordReview(
    {
      path: 'a.md',
      rating: 'good',
      algorithm: 'leitner',
      source: 'auto',
      hash: 'h',
      now: NOW + 1000,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    algorithm
  );
  await store.flush();

  const lines = (adapter.files.get(`${DIR}/srs-log.ndjson`) ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(lines.length, 2, 'both the retried and the new line are present');

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.reviews, 2);
});

test('a review recorded during compaction survives the truncation', async () => {
  // The race: compaction snapshots the state, then an async write gives a
  // concurrent review time to update the state and append its line. If the
  // compaction is not serialised behind the same write chain, it truncates
  // that line after snapshotting a state that predates it.
  const adapter = new FlakyAdapter();
  const store = makeStore(adapter);
  await store.load();
  const algorithm = getAlgorithm('leitner');

  await store.recordReview(
    {
      path: 'a.md',
      rating: 'good',
      algorithm: 'leitner',
      source: 'auto',
      hash: 'h',
      now: NOW,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    algorithm
  );

  let release!: () => void;
  adapter.gateTmpWrite = new Promise<void>((resolve) => {
    release = resolve;
  });

  const compacting = store.compact();
  // Let the compaction task reach the blocked snapshot write.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const recording = store.recordReview(
    {
      path: 'a.md',
      rating: 'good',
      algorithm: 'leitner',
      source: 'auto',
      hash: 'h',
      now: NOW + 1000,
      tunables: FSRS_DEFAULT_TUNABLES,
    },
    algorithm
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  release();
  await Promise.all([compacting, recording]);
  adapter.gateTmpWrite = null;

  const linesAfter = (adapter.files.get(`${DIR}/srs-log.ndjson`) ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(linesAfter.length, 1, 'only the post-snapshot review is in the log');

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(
    reloaded.getState('a.md')!.reviews,
    2,
    'the review made during compaction is not lost'
  );
});

test('replaying a rename never overwrites the destination with a reused source', async () => {
  // Snapshot already reflects the post-compaction world: Y holds the renamed
  // note, X a new note that reused the vacated path. The untruncated log still
  // contains the rename; replaying it must use the state carried by the entry,
  // not copy whatever currently sits at `from`.
  const adapter = new FakeAdapter();
  const oldState: NoteSrsState = {
    algorithm: 'leitner',
    due: 5,
    lastReviewedAt: 4,
    reviews: 9,
    hash: 'old',
    data: { box: 3 },
  };
  const newState: NoteSrsState = {
    algorithm: 'leitner',
    due: 2,
    lastReviewedAt: 2,
    reviews: 1,
    hash: 'new',
    data: { box: 0 },
  };
  adapter.files.set(
    `${DIR}/srs-snapshot.json`,
    JSON.stringify({
      version: 1,
      logLines: 0,
      states: { 'Y.md': oldState, 'X.md': newState },
    })
  );
  adapter.files.set(
    `${DIR}/srs-log.ndjson`,
    `${JSON.stringify({ t: 1, path: 'Y.md', kind: 'rename', from: 'X.md', state: oldState })}\n` +
      `${JSON.stringify({ t: 2, path: 'X.md', kind: 'review', rating: 'good', algorithm: 'leitner', source: 'auto', hash: 'new', state: newState })}\n`
  );

  const store = makeStore(adapter);
  await store.load();

  assert.equal(store.getState('Y.md')!.reviews, 9, 'destination keeps its state');
  assert.equal(store.getState('Y.md')!.hash, 'old');
  assert.equal(store.getState('X.md')!.reviews, 1, 'the new note is separate');
  assert.equal(store.getState('X.md')!.hash, 'new');
});

test('a failed snapshot install falls back to the backup and replays the log', async () => {
  class FailInstallAdapter extends FakeAdapter {
    failInstall = false;
    override async rename(from: string, to: string): Promise<void> {
      if (
        this.failInstall &&
        from.endsWith('srs-snapshot.tmp.json') &&
        to.endsWith('srs-snapshot.json')
      ) {
        throw new Error('install failed');
      }
      return super.rename(from, to);
    }
  }

  const adapter = new FailInstallAdapter();
  const store = makeStore(adapter);
  const algorithm = getAlgorithm('leitner');
  const record = (now: number) => ({
    path: 'a.md',
    rating: 'good' as const,
    algorithm: 'leitner' as const,
    source: 'auto' as const,
    hash: 'h',
    now,
    tunables: FSRS_DEFAULT_TUNABLES,
  });

  await store.load();
  await store.recordReview(record(NOW), algorithm);
  await store.compact();
  await store.recordReview(record(NOW + 1000), algorithm);

  adapter.failInstall = true;
  await assert.rejects(store.compact(), 'the install failed');
  assert.ok(adapter.files.has(`${DIR}/srs-snapshot.bak.json`), 'old snapshot kept');
  assert.equal(adapter.files.has(`${DIR}/srs-snapshot.json`), false, 'install did not land');

  adapter.failInstall = false;
  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.reviews, 2, 'backup + log reconstruct both');
});

test('a crash-truncated log tail is repaired instead of merged', async () => {
  const adapter = new FakeAdapter();
  adapter.files.set(
    `${DIR}/srs-log.ndjson`,
    '{"t":1,"path":"a.md","kind":"unengaged"}\n{"t":2,"path":"b.md","kind":"re'
  );

  const store = makeStore(adapter);
  await store.load();
  const repaired = adapter.files.get(`${DIR}/srs-log.ndjson`)!;
  assert.ok(repaired.endsWith('\n'), 'the file is terminated');
  assert.equal(
    repaired.split('\n').filter(Boolean).length,
    1,
    'the partial line is gone'
  );

  await seedReview(store, 'b.md', NOW + 10);
  await store.flush();

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('b.md')!.reviews, 1, 'the next entry survives');
});

test('a complete entry missing only its newline is kept', async () => {
  const adapter = new FakeAdapter();
  const entry = reviewEntry('a.md', NOW + 1000);
  adapter.files.set(`${DIR}/srs-log.ndjson`, JSON.stringify(entry));

  const store = makeStore(adapter);
  await store.load();

  assert.ok(
    adapter.files.get(`${DIR}/srs-log.ndjson`)!.endsWith('\n'),
    'the missing newline is added'
  );
  assert.equal(store.getState('a.md')!.reviews, 1);
});

test('a failed chunk is retried before later chunks are written', async () => {
  const adapter = new FlakyAdapter();
  adapter.files.set(`${DIR}/srs-log.ndjson`, '');
  const store = makeStore(adapter);
  const algorithm = getAlgorithm('leitner');
  await store.load();

  const record = (now: number) => ({
    path: 'a.md',
    rating: 'good' as const,
    algorithm: 'leitner' as const,
    source: 'auto' as const,
    hash: 'h',
    now,
    tunables: FSRS_DEFAULT_TUNABLES,
  });

  adapter.failNextAppend = true;
  const first = store.recordReview(record(NOW), algorithm);
  const second = store.recordReview(record(NOW + 1), algorithm);

  await assert.rejects(first);
  await second;
  await store.flush();

  const lines = (adapter.files.get(`${DIR}/srs-log.ndjson`) ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { state: NoteSrsState });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.state.reviews, 1, 'the retried chunk comes first');
  assert.equal(lines[1]!.state.reviews, 2);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.reviews, 2);
});

test('an edit entry replays its hash', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();
  await seedReview(store, 'a.md');
  await store.recordEdit('a.md', 'h2', NOW + 1000);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('a.md')!.hash, 'h2');
});

test('a null-prototype state map treats prototype names as note paths', async () => {
  const adapter = new FakeAdapter();
  const store = makeStore(adapter);
  await store.load();

  await seedReview(store, '__proto__');
  assert.equal(store.getState('__proto__')!.reviews, 1);

  const reloaded = makeStore(adapter);
  await reloaded.load();
  assert.equal(reloaded.getState('__proto__')!.reviews, 1);
});
