import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataAdapter } from 'obsidian';
import {
  SrsStore,
  foldEntries,
  parseLogEntry,
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
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`missing: ${from}`);
    this.files.set(to, value);
    this.files.delete(from);
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

test('replays only the log tail beyond the snapshot watermark', async () => {
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
    'the tail entry is applied on top of the snapshot'
  );
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
