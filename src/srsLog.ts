import type { DataAdapter } from 'obsidian';
import type {
  AlgorithmId,
  FsrsTunables,
  NoteSrsState,
  Rating,
  SrsLogEntry,
  SrsSnapshot,
} from './types.ts';
import { isRating } from './types.ts';
import type { SchedulerAlgorithm } from './algorithms/index.ts';
import { DAY_MS } from './algorithms/index.ts';

/**
 * Sidecar persistence for resurfacing state.
 *
 * Two files, both beside the plugin rather than in `data.json`:
 *
 *   srs-log.ndjson       append-only, one JSON object per line
 *   srs-snapshot.json    periodically compacted snapshot of every note's state
 *
 * Why not `data.json`: that file is rewritten in full on every change, so a
 * single state update rewrites the whole index and drags the entire file
 * through the user's sync chain each time. Appending one line is O(1) and a
 * conflict only damages the tail.
 *
 * Why not SQLite: `sql.js` keeps the database in memory and serialises the
 * whole thing on flush, so it does not relieve write amplification at all;
 * and the one mature Obsidian precedent (Vault Curate) is read-only on
 * mobile, where state still needs to be written.
 *
 * Review entries carry the full resulting state rather than the inputs.
 * Replaying inputs would be smaller, and ts-fsrs's fuzzing does happen to be
 * deterministic today — but that is an undocumented implementation detail, so
 * a library upgrade or a changed retention setting could silently reconstruct
 * different state. Storing the outcome cannot drift.
 */

const LOG_FILE = 'srs-log.ndjson';
const SNAPSHOT_FILE = 'srs-snapshot.json';
const SNAPSHOT_TMP_FILE = 'srs-snapshot.tmp.json';
const SNAPSHOT_VERSION = 1;

/**
 * Compact once the log tail grows past this. Keeping the tail short bounds
 * both startup replay and the amount a sync conflict can destroy.
 */
const COMPACT_THRESHOLD_LINES = 500;

/**
 * Ignore a repeat "unengaged" report for a note marked this recently.
 *
 * Tearing a batch down marks every visible-but-unengaged card, and batches are
 * torn down on every reshuffle, settings change and re-render. Without this the
 * log would gain a duplicate line per visible card per re-render, and the
 * priority marker would be pushed forward indefinitely instead of recording
 * when the note was actually skipped. The window matches the selection
 * cooldown, so a note cannot be re-shown before its marker is due to be
 * refreshed anyway.
 */
const UNENGAGED_DEDUPE_MS = 30 * 60 * 1000;

const LOG_PREFIX = '[intelliscroll/srs]';

// One switch governs every line this module prints, so the plugin can silence
// it entirely. Errors default to on because a swallowed failure here means
// silently losing scheduling state.
let errorsEnabled = true;
let debugEnabled = false;

export function setSrsLogging(options: {
  errors?: boolean;
  debug?: boolean;
}): void {
  if (options.errors !== undefined) errorsEnabled = options.errors;
  if (options.debug !== undefined) debugEnabled = options.debug;
}

/** Report a malformed input or degraded condition. Debug-gated. */
function warn(message: string): void {
  if (debugEnabled) console.warn(`${LOG_PREFIX} ${message}`);
}

/** Report a failure that would otherwise be swallowed. */
export function logSrsError(message: string, error?: unknown): void {
  if (!errorsEnabled) return;
  if (error === undefined) {
    console.error(`${LOG_PREFIX} ${message}`);
  } else {
    console.error(`${LOG_PREFIX} ${message}`, error);
  }
}

/** Split a log file into raw lines, tolerating a trailing partial line. */
export function splitLogLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Parse one log line. Returns null for anything malformed — a crash midway
 * through an append leaves a truncated final line, and that must not take the
 * whole log down with it.
 */
export function parseLogEntry(line: string): SrsLogEntry | null {
  if (line.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    warn(`dropping unparseable log line (${line.length} bytes)`);
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = parsed as Partial<SrsLogEntry>;

  if (typeof entry.t !== 'number' || !Number.isFinite(entry.t)) return null;
  if (typeof entry.path !== 'string' || entry.path.length === 0) return null;
  if (
    entry.kind !== 'review' &&
    entry.kind !== 'unengaged' &&
    entry.kind !== 'edit'
  ) {
    return null;
  }
  if (entry.rating !== undefined && !isRating(entry.rating)) return null;

  return entry as SrsLogEntry;
}

function isNoteSrsState(value: unknown): value is NoteSrsState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<NoteSrsState>;
  return (
    typeof state.algorithm === 'string' &&
    typeof state.due === 'number' &&
    typeof state.lastReviewedAt === 'number' &&
    typeof state.reviews === 'number' &&
    typeof state.hash === 'string' &&
    typeof state.data === 'object' &&
    state.data !== null
  );
}

/**
 * Apply entries to a state map. Pure, so the fold is unit-testable without
 * touching a filesystem.
 */
export function foldEntries(
  states: Record<string, NoteSrsState>,
  entries: readonly SrsLogEntry[]
): Record<string, NoteSrsState> {
  for (const entry of entries) {
    switch (entry.kind) {
      case 'review':
        if (isNoteSrsState(entry.state)) {
          states[entry.path] = entry.state;
        } else {
          warn(`review entry for ${entry.path} has no usable state`);
        }
        break;
      case 'unengaged': {
        const existing = states[entry.path];
        // Selection priority only. A skip is the absence of a review, not a
        // failed retrieval, so it must never alter the schedule.
        states[entry.path] = existing
          ? { ...existing, unengagedAt: entry.t }
          : {
              algorithm: entry.algorithm ?? 'off',
              due: 0,
              lastReviewedAt: 0,
              reviews: 0,
              hash: '',
              unengagedAt: entry.t,
              data: {},
            };
        break;
      }
      case 'edit': {
        const existing = states[entry.path];
        if (existing) states[entry.path] = { ...existing };
        break;
      }
    }
  }
  return states;
}

export interface ReviewRecord {
  path: string;
  rating: Rating;
  algorithm: AlgorithmId;
  source: 'auto' | 'explicit';
  hash: string;
  now: number;
  tunables: FsrsTunables;
}

export class SrsStore {
  private states: Record<string, NoteSrsState> = {};
  /** Raw log lines already folded into `states`. */
  private foldedLines = 0;
  /** Lines appended since the last successful write, joined by '\n'. */
  private pendingLines: string[] = [];
  private writtenLines = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  // Declared and assigned explicitly rather than as constructor parameter
  // properties: those need code generation, which Node's strip-only TypeScript
  // mode cannot do, and that would make this module untestable.
  private readonly adapter: DataAdapter;
  private readonly dir: string;

  constructor(adapter: DataAdapter, dir: string) {
    this.adapter = adapter;
    this.dir = dir;
  }

  get logPath(): string {
    return `${this.dir}/${LOG_FILE}`;
  }

  get snapshotPath(): string {
    return `${this.dir}/${SNAPSHOT_FILE}`;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Number of log lines currently persisted but not yet compacted. */
  get tailLength(): number {
    return this.writtenLines + this.pendingLines.length;
  }

  getState(path: string): NoteSrsState | undefined {
    return this.states[path];
  }

  getStates(): Readonly<Record<string, NoteSrsState>> {
    return this.states;
  }

  /** Read the snapshot, then replay whatever the log has appended since. */
  async load(): Promise<void> {
    let snapshot: SrsSnapshot | null = null;
    if (await this.adapter.exists(this.snapshotPath)) {
      try {
        const raw = await this.adapter.read(this.snapshotPath);
        const parsed = JSON.parse(raw) as Partial<SrsSnapshot>;
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.states &&
          typeof parsed.states === 'object' &&
          typeof parsed.logLines === 'number'
        ) {
          snapshot = {
            version:
              typeof parsed.version === 'number' ? parsed.version : 0,
            logLines: parsed.logLines,
            states: parsed.states as Record<string, NoteSrsState>,
          };
        }
      } catch {
        warn('snapshot unreadable; falling back to replaying the whole log');
      }
    }

    this.states = snapshot ? { ...snapshot.states } : {};
    this.foldedLines = snapshot ? snapshot.logLines : 0;

    if (await this.adapter.exists(this.logPath)) {
      const text = await this.adapter.read(this.logPath);
      const lines = splitLogLines(text);
      this.writtenLines = lines.length;

      // Snapshot already covers the first `foldedLines` raw lines.
      const start = Math.min(this.foldedLines, lines.length);
      const tail: SrsLogEntry[] = [];
      for (let i = start; i < lines.length; i++) {
        const entry = parseLogEntry(lines[i] ?? '');
        if (entry) tail.push(entry);
      }
      foldEntries(this.states, tail);
    } else {
      this.writtenLines = 0;
    }

    this.loaded = true;
  }

  /**
   * Record an informative review and return the new state.
   *
   * Only call this for real engagement; skips go through `recordUnengaged`
   * so they never reach the scheduler.
   */
  async recordReview(
    record: ReviewRecord,
    algorithm: SchedulerAlgorithm
  ): Promise<NoteSrsState> {
    const previous = this.states[record.path] ?? null;
    const next = algorithm.review(previous, record.rating, {
      now: record.now,
      hash: record.hash,
      fsrs: record.tunables,
    });

    this.states[record.path] = next;
    this.enqueue({
      t: record.now,
      path: record.path,
      kind: 'review',
      rating: record.rating,
      algorithm: record.algorithm,
      source: record.source,
      hash: record.hash,
      state: next,
    });

    await this.maybeCompact();
    return next;
  }

  /**
   * Record that a note was shown but not engaged with.
   *
   * Deliberately does NOT reschedule: the note keeps its interval but gains
   * selection priority, so it gets another chance without the "skipped, so
   * show it sooner, so it gets skipped" spiral.
   */
  async recordUnengaged(
    path: string,
    now: number,
    algorithm: AlgorithmId
  ): Promise<void> {
    const existing = this.states[path];
    if (existing) {
      if (
        existing.unengagedAt !== undefined &&
        now - existing.unengagedAt < UNENGAGED_DEDUPE_MS
      ) {
        return;
      }
      this.states[path] = { ...existing, unengagedAt: now };
    } else {
      this.states[path] = {
        algorithm,
        due: 0,
        lastReviewedAt: 0,
        reviews: 0,
        hash: '',
        unengagedAt: now,
        data: {},
      };
    }

    this.enqueue({ t: now, path, kind: 'unengaged', algorithm });
    await this.maybeCompact();
  }

  /** Record that a note's content changed, so its hash may need refreshing. */
  async recordEdit(path: string, hash: string, now: number): Promise<void> {
    const existing = this.states[path];
    if (!existing) return;
    this.states[path] = { ...existing, hash };
    this.enqueue({ t: now, path, kind: 'edit', hash });
    await this.maybeCompact();
  }

  private enqueue(entry: SrsLogEntry): void {
    this.pendingLines.push(JSON.stringify(entry));
  }

  /** Append buffered lines. Safe to call concurrently; writes are serialised. */
  async flush(): Promise<void> {
    if (this.pendingLines.length === 0) return;
    const chunk = this.pendingLines.join('\n') + '\n';
    this.pendingLines = [];

    this.writeChain = this.writeChain.then(async () => {
      try {
        if (await this.adapter.exists(this.logPath)) {
          await this.adapter.append(this.logPath, chunk);
        } else {
          // `append` is not guaranteed to create the file.
          await this.adapter.write(this.logPath, chunk);
        }
        this.writtenLines += chunk.split('\n').length - 1;
      } catch (error) {
        // Put the lines back so a later flush can retry rather than losing
        // them, and surface the failure instead of swallowing it.
        this.pendingLines.unshift(...chunk.trimEnd().split('\n'));
        logSrsError('failed to append to the resurfacing log', error);
        throw error;
      }
    });

    await this.writeChain;
  }

  private async maybeCompact(): Promise<void> {
    await this.flush();
    if (this.tailLength >= COMPACT_THRESHOLD_LINES) {
      await this.compact();
    }
  }

  /**
   * Fold the log into the snapshot and truncate it.
   *
   * Order matters: the snapshot is written (atomically, via a temp file and a
   * rename) *before* the log is truncated. If the process dies in between, the
   * snapshot's `logLines` watermark still matches the untouched log, so the
   * replay skips exactly the lines already folded. Truncating first would lose
   * everything the snapshot had not captured yet.
   */
  async compact(): Promise<void> {
    await this.flush();

    const snapshot: SrsSnapshot = {
      version: SNAPSHOT_VERSION,
      logLines: this.writtenLines,
      states: this.states,
    };

    await this.adapter.write(
      `${this.dir}/${SNAPSHOT_TMP_FILE}`,
      JSON.stringify(snapshot)
    );
    await this.adapter.rename(
      `${this.dir}/${SNAPSHOT_TMP_FILE}`,
      this.snapshotPath
    );

    // Only now is it safe to drop the folded lines.
    await this.adapter.write(this.logPath, '');
    this.writtenLines = 0;
    this.foldedLines = 0;
  }

  /**
   * Turn a note's content hash into the value stored alongside its state.
   * Kept here so the hashing rule lives with the data that depends on it.
   */
  static hashContent(content: string): string {
    // FNV-1a, 32-bit. Cheap, dependency-free, and only needs to detect that a
    // note changed — it is not a security boundary.
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }
}

/** Days elapsed between two epoch-ms timestamps, floored at zero. */
export function elapsedDays(from: number, to: number): number {
  return Math.max(0, (to - from) / DAY_MS);
}
