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
/** Previous snapshot, kept across the install window and removed afterwards. */
const SNAPSHOT_BACKUP_FILE = 'srs-snapshot.bak.json';
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
function warn(message: string, error?: unknown): void {
  if (!debugEnabled) return;
  if (error === undefined) console.warn(`${LOG_PREFIX} ${message}`);
  else console.warn(`${LOG_PREFIX} ${message}`, error);
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
    entry.kind !== 'edit' &&
    entry.kind !== 'rename' &&
    entry.kind !== 'delete'
  ) {
    return null;
  }
  if (entry.rating !== undefined && !isRating(entry.rating)) return null;
  // A rename without its source cannot move anything; treating it as valid
  // would silently drop the schedule it was meant to carry across.
  if (
    entry.kind === 'rename' &&
    (typeof entry.from !== 'string' || entry.from.length === 0)
  ) {
    return null;
  }

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
        if (!existing) break;
        states[entry.path] = {
          ...existing,
          hash: typeof entry.hash === 'string' ? entry.hash : existing.hash,
        };
        break;
      }
      case 'rename': {
        const from = entry.from;
        if (from === undefined || from === entry.path) break;

        // Prefer the state carried by the entry. Using `states[from]` would be
        // wrong after a path reuse: a fresh note may already occupy `from`,
        // and copying it would overwrite the real destination schedule.
        if (isNoteSrsState(entry.state)) {
          states[entry.path] = entry.state;
          delete states[from];
          break;
        }

        // Entries written before the state was carried fall back to a move.
        const existing = states[from];
        if (existing === undefined) break;
        // The file at `to` after a rename *is* the note that was at `from`, so
        // its schedule wins even if a state already existed at `to` (which can
        // only be a leftover from a path-reusing entry).
        states[entry.path] = existing;
        delete states[from];
        break;
      }
      case 'delete': {
        delete states[entry.path];
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
  /**
   * Note state keyed by vault path.
   *
   * Null-prototype on purpose: a vault can contain an extensionless file whose
   * path is `__proto__` or `constructor`, and a plain object would treat those
   * as inherited members instead of note keys.
   */
  private states: Record<string, NoteSrsState> = Object.create(null) as Record<
    string,
    NoteSrsState
  >;
  /** Lines appended since the last successful write, joined by '\n'. */
  private pendingLines: string[] = [];
  private writtenLines = 0;
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * A previous append failed, so the log may end mid-line. The next append
   * starts with a newline to keep the retried chunk on its own line.
   */
  private needsSeparator = false;
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

  get backupPath(): string {
    return `${this.dir}/${SNAPSHOT_BACKUP_FILE}`;
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

  /**
   * Read the snapshot, then replay the whole log on top of it.
   *
   * Replaying lines the snapshot already covers is deliberate and safe: every
   * entry carries its outcome rather than the inputs that produced it, so
   * applying one twice is a no-op. A line watermark cannot be kept correct
   * across a compaction that truncates the log — after truncation the snapshot
   * still described the *old* file's length, and loading skipped that many
   * entries of the new one. That silently dropped a week of reviews; a full
   * replay of at most a compacted log is cheap by comparison.
   */
  private async readSnapshot(path: string): Promise<SrsSnapshot | null> {
    if (!(await this.adapter.exists(path))) return null;
    try {
      const raw = await this.adapter.read(path);
      const parsed = JSON.parse(raw) as Partial<SrsSnapshot>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.states ||
        typeof parsed.states !== 'object'
      ) {
        return null;
      }
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        logLines: typeof parsed.logLines === 'number' ? parsed.logLines : 0,
        states: parsed.states as Record<string, NoteSrsState>,
      };
    } catch {
      warn(`snapshot unreadable: ${path}`);
      return null;
    }
  }

  async load(): Promise<void> {
    // The backup is only consulted when the primary is missing or unreadable,
    // i.e. during the short install window in `compact`.
    const snapshot =
      (await this.readSnapshot(this.snapshotPath)) ??
      (await this.readSnapshot(this.backupPath));

    this.states = Object.create(null) as Record<string, NoteSrsState>;
    if (snapshot) Object.assign(this.states, snapshot.states);

    if (await this.adapter.exists(this.logPath)) {
      const text = await this.adapter.read(this.logPath);
      const lines = splitLogLines(text);

      // Repair a crash-truncated tail before replaying and before any future
      // append. Leaving it in place would make the next append merge with the
      // partial line, and the whole merged line is then unparseable.
      if (text.length > 0 && !text.endsWith('\n')) {
        const last = lines[lines.length - 1] ?? '';
        if (parseLogEntry(last) !== null) {
          // A complete entry that merely lost its newline: keep it.
          await this.adapter.write(this.logPath, `${text}\n`);
        } else {
          lines.pop();
          await this.adapter.write(
            this.logPath,
            lines.length > 0 ? `${lines.join('\n')}\n` : ''
          );
        }
      }
      this.writtenLines = lines.length;
      this.needsSeparator = false;

      const entries: SrsLogEntry[] = [];
      for (const line of lines) {
        const entry = parseLogEntry(line);
        if (entry) entries.push(entry);
      }
      foldEntries(this.states, entries);
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

  /**
   * Move a note's schedule to its new path.
   *
   * Renaming is a path change, not a new note: keeping the state under the old
   * path would make the renamed note look never-reviewed (it would jump back to
   * the front of the feed and its intervals would restart), and would hand the
   * old schedule to whatever file later took that path.
   *
   * Returns false when there was nothing to move, so callers can skip a write.
   */
  async renamePath(from: string, to: string, now: number): Promise<boolean> {
    const moved = this.movePath(from, to, now);
    if (moved) await this.maybeCompact();
    return moved;
  }

  /** Move every state below a renamed folder. */
  async renameFolderPaths(
    fromFolder: string,
    toFolder: string,
    now: number
  ): Promise<number> {
    const fromPrefix = `${fromFolder}/`;
    const toPrefix = `${toFolder}/`;
    let moved = 0;

    for (const path of Object.keys(this.states)) {
      if (!path.startsWith(fromPrefix)) continue;
      if (this.movePath(path, `${toPrefix}${path.slice(fromPrefix.length)}`, now)) {
        moved++;
      }
    }

    if (moved > 0) await this.maybeCompact();
    return moved;
  }

  /**
   * Drop a deleted note's state.
   *
   * The store is keyed by path, so a state that outlives its file is not inert:
   * a later note created at the same path would silently inherit the deleted
   * note's schedule, ratings and content hash. A delete is a statement that the
   * path is free again.
   */
  async forgetPath(path: string, now: number): Promise<boolean> {
    if (!Object.prototype.hasOwnProperty.call(this.states, path)) return false;
    delete this.states[path];
    this.enqueue({ t: now, path, kind: 'delete' });
    await this.maybeCompact();
    return true;
  }

  /** Drop every state below a deleted folder. */
  async forgetFolderPaths(folder: string, now: number): Promise<number> {
    const prefix = `${folder}/`;
    let removed = 0;

    for (const path of Object.keys(this.states)) {
      if (!path.startsWith(prefix)) continue;
      delete this.states[path];
      this.enqueue({ t: now, path, kind: 'delete' });
      removed++;
    }

    if (removed > 0) await this.maybeCompact();
    return removed;
  }

  private movePath(from: string, to: string, now: number): boolean {
    if (from === to) return false;
    const existing = this.states[from];
    if (existing === undefined) return false;

    this.states[to] = existing;
    delete this.states[from];
    this.enqueue({ t: now, path: to, kind: 'rename', from, state: existing });
    return true;
  }

  private enqueue(entry: SrsLogEntry): void {
    this.pendingLines.push(JSON.stringify(entry));
  }

  /** Append buffered lines. Safe to call concurrently; writes are serialised. */
  async flush(): Promise<void> {
    // Be a barrier even when nothing new is buffered: callers use this to let
    // an already-started append settle before closing.
    if (this.pendingLines.length === 0) {
      await this.writeChain.catch(() => undefined);
      return;
    }

    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        // Take the lines *inside* the chain. A failed earlier chunk is put
        // back at the head of `pendingLines`; extracting outside the chain
        // would let a later chunk overtake it, reversing the log order that
        // last-write-wins replay depends on.
        if (this.pendingLines.length === 0) return;
        const chunk = this.pendingLines.join('\n') + '\n';
        this.pendingLines = [];
        // A failed attempt may have left the file mid-line. Start the retry on
        // a fresh line so the partial and the entry cannot merge.
        const data = this.needsSeparator ? `\n${chunk}` : chunk;

        try {
          if (await this.adapter.exists(this.logPath)) {
            await this.adapter.append(this.logPath, data);
          } else {
            // `append` is not guaranteed to create the file.
            await this.adapter.write(this.logPath, data);
          }
          this.needsSeparator = false;
          this.writtenLines += data.split('\n').length - 1;
        } catch (error) {
          // Put the lines back so a later flush can retry rather than losing
          // them, and surface the failure instead of swallowing it.
          this.pendingLines.unshift(...chunk.trimEnd().split('\n'));
          this.needsSeparator = true;
          logSrsError('failed to append to the resurfacing log', error);
          throw error;
        }
      });

    await this.writeChain;
  }

  private async maybeCompact(): Promise<void> {
    await this.flush();
    if (this.tailLength < COMPACT_THRESHOLD_LINES) return;

    try {
      await this.compact();
    } catch (error) {
      // The review is already durable in the log, so a maintenance failure
      // must not report the review itself as failed. The tail stays in place
      // and the next write tries again; the error is surfaced rather than
      // silently swallowed.
      logSrsError('failed to compact the resurfacing log', error);
    }
  }

  /**
   * Fold the log into the snapshot and truncate it.
   *
   * Order matters: the snapshot is written (atomically, via a temp file and a
   * rename) *before* the log is truncated. Truncating first would lose
   * everything the snapshot had not captured yet.
   *
   * The destination cannot be overwritten (`DataAdapter.rename` throws
   * "Destination file already exists!"), so the old snapshot is moved to a
   * backup first rather than deleted. If the install then fails — or the
   * process dies — `load` falls back to the backup while the log is still
   * intact, and replaying the whole log reconstructs the state. The backup is
   * removed only after the log has been truncated.
   *
   * The whole compaction runs as a link in the same write chain as `flush`.
   * Reviews can arrive while the snapshot is being written, and an unchained
   * compaction would truncate their log lines after snapshotting a state that
   * did not include them — silently losing a review that the caller was told
   * had been recorded.
   */
  async compact(): Promise<void> {
    await this.flush();

    const task = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const snapshot: SrsSnapshot = {
          version: SNAPSHOT_VERSION,
          // The log is truncated immediately after this write, so no line of
          // the file that will exist afterwards is covered by the snapshot yet.
          logLines: 0,
          // Stringified synchronously below: an entry recorded after this point
          // is not in this snapshot, but its flush is queued behind this task
          // and therefore appends after the truncation.
          states: this.states,
        };

        await this.adapter.write(
          `${this.dir}/${SNAPSHOT_TMP_FILE}`,
          JSON.stringify(snapshot)
        );

        // Move the current snapshot aside instead of deleting it.
        if (await this.adapter.exists(this.backupPath)) {
          await this.adapter.remove(this.backupPath);
        }
        if (await this.adapter.exists(this.snapshotPath)) {
          await this.adapter.rename(this.snapshotPath, this.backupPath);
        }
        await this.adapter.rename(
          `${this.dir}/${SNAPSHOT_TMP_FILE}`,
          this.snapshotPath
        );

        // Only now is it safe to drop the folded lines.
        await this.adapter.write(this.logPath, '');
        this.writtenLines = 0;
        this.needsSeparator = false;

        // Cleanup only: a leftover backup is harmless and the next compaction
        // replaces it, so a failure here must not fail the compaction.
        try {
          if (await this.adapter.exists(this.backupPath)) {
            await this.adapter.remove(this.backupPath);
          }
        } catch (error) {
          warn('could not remove the old snapshot backup', error);
        }
      });

    this.writeChain = task;
    await task;
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
