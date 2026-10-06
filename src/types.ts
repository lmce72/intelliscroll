import type { IntervalUnit } from './format.ts';

export type OpenNoteBehavior = 'tab' | 'reuse' | 'window';
export type PreviewSize = 'small' | 'medium' | 'large';

// ─── SRS resurfacing ───────────────────────────────────────────────────────
// The feed's scheduling engine. `off` reproduces the original pure-random
// behaviour and is the default, so an upgrade never changes what users see.

export type AlgorithmId = 'off' | 'fsrs' | 'sm2' | 'leitner';
export type GradingMode = 'auto' | 'hybrid' | 'manual';
export type Sensitivity = 'conservative' | 'medium' | 'aggressive' | 'custom';

/**
 * What a sensitivity setting demands before a showing counts as engagement.
 *
 * Kept as plain data (rather than branches inside the grader) so the settings
 * page can display what a preset actually does, and so a user can supply their
 * own numbers for `custom`. The grader still only ever emits `good` — these
 * thresholds decide *whether* a review happened, never its quality.
 */
export interface SensitivityThresholds {
  /** When true, only opening the note counts; dwell is ignored entirely. */
  openedOnly: boolean;
  /** Dwell at or above this many ms counts as read. Ignored when openedOnly. */
  engagedMs: number;
}

// The four FSRS ratings, reused as the vocabulary for every algorithm.
// IMPORTANT: automatic grading may only ever produce 'good'. Behaviour is
// enough to tell "engaged" from "not engaged", never to judge recall quality
// (behavioural proxies match explicit ratings only ~65% of the time). Only an
// explicit user action may produce 'again' / 'hard' / 'easy'.
export type Rating = 'again' | 'hard' | 'good' | 'easy';

export const ALGORITHM_IDS: readonly AlgorithmId[] = [
  'off',
  'fsrs',
  'sm2',
  'leitner',
];
export const GRADING_MODES: readonly GradingMode[] = [
  'auto',
  'hybrid',
  'manual',
];
export const SENSITIVITIES: readonly Sensitivity[] = [
  'conservative',
  'medium',
  'aggressive',
];
/** Every value the setting may hold, presets first. */
export const SENSITIVITY_OPTIONS: readonly Sensitivity[] = [
  ...SENSITIVITIES,
  'custom',
];

/**
 * The one rating automatic grading is allowed to emit.
 * See the note on `Rating`.
 */
export const AUTO_RATING: Rating = 'good';

/** FSRS parameters that are safe and meaningful to expose to the user. */
export interface FsrsTunables {
  /** Target recall probability at review time. Higher = shorter intervals. */
  requestRetention: number;
  /** Upper bound on the interval in days. */
  maximumInterval: number;
  /** Jitter due dates so batches do not cluster on one day. */
  enableFuzz: boolean;
  /**
   * Use FSRS's short-term learning steps (its defaults are 1 minute and 10
   * minutes).
   *
   * Off by default, and the reason is in the feed's nature rather than in the
   * algorithm: a whole note is re-read, not drilled, so the minute-scale steps
   * resurface the same note several times in one sitting. What they buy is the
   * only way to get an interval below a day — FSRS's day-scale path floors at
   * `max(1, round(...))` and cannot express one. A vault that wants a
   * "show me again in a minute" rung turns this on and accepts the repeats.
   */
  enableShortTerm: boolean;
}

export const FSRS_DEFAULT_TUNABLES: FsrsTunables = {
  requestRetention: 0.9,
  maximumInterval: 30,
  enableFuzz: true,
  enableShortTerm: false,
};

export const REQUEST_RETENTION_MIN = 0.7;
/**
 * Upper bound on desired retention.
 *
 * 0.99 rather than 0.97 because that is where the knob stops doing anything:
 * measured on the day-scale path, the ladder is `[1d, 2d, 3d, 4d]` at 0.99 and
 * still `[1d, 2d, 3d, 4d]` at 1.0, so anything beyond it is a number that
 * changes nothing except the review load. This is the outer envelope only —
 * the control's real range is derived per preset by `fsrsRetentionWindow`.
 */
export const REQUEST_RETENTION_MAX = 0.99;
export const MAXIMUM_INTERVAL_MIN = 1;
export const MAXIMUM_INTERVAL_MAX = 3650;

// ─── Tuning bounds ─────────────────────────────────────────────────────────
// The retention control is not bounded by these directly: its range is derived
// at runtime from the maximum interval and the top-gap rule (see
// `fsrsRetentionWindow`). These are only the outer envelope the rule is scanned
// within and the fallback when no window exists.

/**
 * Minimum days the second-highest ladder tier must sit below the highest.
 *
 * Zero would make the rule vacuous (every gap is at least zero), so the range
 * starts at one: a rule that cannot exclude anything is not a rule.
 */
export const TOP_GAP_DAYS_MIN = 1;
export const TOP_GAP_DAYS_MAX = 30;
export const DEFAULT_TOP_GAP_DAYS = 2;

/** Ladder lengths the user may choose between. */
export const TIER_COUNTS: readonly number[] = [4, 8];
export const DEFAULT_TIER_COUNT = 4;

/** Clamp a top-gap setting into range, falling back when unusable. */
export function normalizeTopGapDays(value: unknown): number {
  // `Number(null)` and `Number('')` are both 0, which would silently pin the
  // rule to its minimum instead of falling back; an unset field is not a
  // deliberate zero.
  if (value === null || value === undefined || value === '') {
    return DEFAULT_TOP_GAP_DAYS;
  }
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_TOP_GAP_DAYS;
  return Math.min(TOP_GAP_DAYS_MAX, Math.max(TOP_GAP_DAYS_MIN, numeric));
}

export function isTierCount(value: unknown): value is number {
  return typeof value === 'number' && TIER_COUNTS.includes(value);
}

/** Keep a tier count to one of the offered lengths, falling back when unusable. */
export function normalizeTierCount(value: unknown): number {
  return isTierCount(value) ? value : DEFAULT_TIER_COUNT;
}

// ─── Presets ───────────────────────────────────────────────────────────────
// Configuration is stored as named presets rather than flat settings, so a
// user can switch between whole configurations and try one without committing
// it. Presets are pure configuration and live in data.json (the sidecar store
// is for per-note scheduling state).

/** Whether a rule's values are excluded or are the only things allowed. */
export type RuleMode = 'blacklist' | 'whitelist';

/**
 * One filter dimension: a set of values plus whether they exclude or include.
 *
 * The mode is per dimension rather than per preset, because the dimensions
 * routinely want opposite treatment — "only these folders" while excluding
 * some tags is a normal configuration.
 */
export interface FilterRule {
  mode: RuleMode;
  values: string[];
}

/**
 * Category of a *standalone non-Markdown* file. Markdown notes are not a file
 * category; a note that contains only an attachment is governed by
 * `includeMediaOnlyNotes` instead, which is a view-time toggle that does not
 * force a re-index.
 */
export type FileCategory = 'image' | 'document' | 'video' | 'audio' | 'other';

/**
 * What `fileCategory()` can return: the five file categories plus `note`.
 *
 * The file-type rule accepts `note` as a value so that "only images" can mean
 * only images. Without it, Markdown notes would always pass the rule and the
 * whitelist could never narrow to attachments alone.
 */
export type FilterableKind = FileCategory | 'note';

export interface FileTypeRule {
  mode: RuleMode;
  values: FilterableKind[];
}

export interface FilterPreset {
  id: string;
  name: string;
  folders: FilterRule;
  tags: FilterRule;
  globs: FilterRule;
  /**
   * Exact note paths to keep out of the feed.
   *
   * Separate from `globs` because this is written from the feed itself, one
   * note at a time, when a card turns out to be one you never want to see
   * again — the user should not have to compose a pattern for that. Matching is
   * case-insensitive equality on the full path; folders already have their own
   * dimension, so a prefix is deliberately not treated as one here.
   */
  ignore: FilterRule;
  searchQuery: string;
  /** Replaces the old `showNonMarkdownFiles`, which this subsumes exactly. */
  fileTypes: FileTypeRule;
  /** Deliberately a live view-time toggle, not an index-time rule. */
  includeMediaOnlyNotes: boolean;
}

export interface AlgorithmPreset {
  id: string;
  name: string;
  algorithm: AlgorithmId;
  gradingMode: GradingMode;
  sensitivity: Sensitivity;
  /**
   * Numbers backing `sensitivity: 'custom'`; ignored by the presets. Optional
   * because a preset that never chooses `custom` has nothing to carry, and an
   * absent or malformed value falls back to the medium preset rather than
   * breaking scheduling.
   */
  sensitivityThresholds?: SensitivityThresholds;
  /**
   * Minimum days the second-highest ladder tier must sit below the highest.
   *
   * Scheduling, not presentation: it decides which retention values are
   * admissible (see `fsrsRetentionWindow`), and the whole point of the setting
   * is to keep adjacent ratings from collapsing into the same interval.
   */
  topGapDays: number;
  fsrsTunables: FsrsTunables;
}

export interface DisplayPreset {
  id: string;
  name: string;
  simplifiedView: boolean;
  reduceAnimations: boolean;
  previewSize: PreviewSize;
  openNoteBehavior: OpenNoteBehavior;
  /**
   * Unit the intervals are shown in. Presentation only: the scheduler always
   * works in days, and this only changes how a day count is read out.
   */
  intervalUnit: IntervalUnit;
  /** How many rungs the displayed ladder expands to. Presentation only. */
  tierCount: number;
  /**
   * Offer the ratings in the floating control once a note reached from the
   * feed has actually been read.
   *
   * Off by default. Expanding while someone is still reading is an
   * interruption, and a feature meant to help capture a rating must not become
   * something that nags.
   */
  promptRatingAfterRead: boolean;
  frontmatterImageProps: string[];
  frontmatterBeforeProps: string[];
  frontmatterAfterProps: string[];
}

/** A composite: one preset from each group, referenced by id. */
export interface TotalPreset {
  id: string;
  name: string;
  filterId: string;
  algorithmId: string;
  displayId: string;
}

export interface PresetLibrary {
  filters: FilterPreset[];
  algorithms: AlgorithmPreset[];
  displays: DisplayPreset[];
  totals: TotalPreset[];
}

export const RULE_MODES: readonly RuleMode[] = ['blacklist', 'whitelist'];
export const FILE_CATEGORIES: readonly FileCategory[] = [
  'image',
  'document',
  'video',
  'audio',
  'other',
];

export function isRuleMode(value: unknown): value is RuleMode {
  return value === 'blacklist' || value === 'whitelist';
}

export function isFileCategory(value: unknown): value is FileCategory {
  return (
    value === 'image' ||
    value === 'document' ||
    value === 'video' ||
    value === 'audio' ||
    value === 'other'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Partial<FilterRule>;
  return isRuleMode(rule.mode) && isStringArray(rule.values);
}

export function isFilterableKind(value: unknown): value is FilterableKind {
  return value === 'note' || isFileCategory(value);
}

export function isFileTypeRule(value: unknown): value is FileTypeRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Partial<FileTypeRule>;
  return (
    isRuleMode(rule.mode) &&
    Array.isArray(rule.values) &&
    rule.values.every((item) => isFilterableKind(item))
  );
}

export function isFilterPreset(value: unknown): value is FilterPreset {
  if (typeof value !== 'object' || value === null) return false;
  const preset = value as Partial<FilterPreset>;
  return (
    typeof preset.id === 'string' &&
    preset.id.length > 0 &&
    typeof preset.name === 'string' &&
    isFilterRule(preset.folders) &&
    isFilterRule(preset.tags) &&
    isFilterRule(preset.globs) &&
    isFilterRule(preset.ignore) &&
    typeof preset.searchQuery === 'string' &&
    isFileTypeRule(preset.fileTypes) &&
    typeof preset.includeMediaOnlyNotes === 'boolean'
  );
}

export function isAlgorithmPreset(value: unknown): value is AlgorithmPreset {
  if (typeof value !== 'object' || value === null) return false;
  const preset = value as Partial<AlgorithmPreset>;
  return (
    typeof preset.id === 'string' &&
    preset.id.length > 0 &&
    typeof preset.name === 'string' &&
    isAlgorithmId(preset.algorithm) &&
    isGradingMode(preset.gradingMode) &&
    isSensitivity(preset.sensitivity) &&
    typeof preset.fsrsTunables === 'object' &&
    preset.fsrsTunables !== null
  );
}

export function isDisplayPreset(value: unknown): value is DisplayPreset {
  if (typeof value !== 'object' || value === null) return false;
  const preset = value as Partial<DisplayPreset>;
  return (
    typeof preset.id === 'string' &&
    preset.id.length > 0 &&
    typeof preset.name === 'string' &&
    typeof preset.simplifiedView === 'boolean' &&
    typeof preset.reduceAnimations === 'boolean' &&
    isPreviewSize(preset.previewSize) &&
    (preset.openNoteBehavior === 'tab' ||
      preset.openNoteBehavior === 'reuse' ||
      preset.openNoteBehavior === 'window') &&
    isStringArray(preset.frontmatterImageProps) &&
    isStringArray(preset.frontmatterBeforeProps) &&
    isStringArray(preset.frontmatterAfterProps)
  );
}

export function isTotalPreset(value: unknown): value is TotalPreset {
  if (typeof value !== 'object' || value === null) return false;
  const preset = value as Partial<TotalPreset>;
  return (
    typeof preset.id === 'string' &&
    preset.id.length > 0 &&
    typeof preset.name === 'string' &&
    typeof preset.filterId === 'string' &&
    typeof preset.algorithmId === 'string' &&
    typeof preset.displayId === 'string'
  );
}

/**
 * The plugin's interface language. `auto` follows Obsidian's own setting.
 *
 * Declared here rather than in `i18n.ts` so this module stays import-free —
 * `i18n.ts` imports from here, which keeps the dependency pointing one way.
 */
export type Language = 'auto' | 'en' | 'zh';

export const LANGUAGES: readonly Language[] = ['auto', 'en', 'zh'];

export function isLanguage(value: unknown): value is Language {
  return value === 'auto' || value === 'en' || value === 'zh';
}

export interface PluginSettings {
  /**
   * Not a preset group either: language is about reading the interface, not
   * about which notes appear, and needing to switch a preset to read the
   * settings in your own language would be absurd.
   */
  language: Language;

  /**
   * Feed mechanics. These are not part of any preset group: they do not affect
   * which notes are eligible, only how many arrive at once.
   */
  batchSize: number;
  infiniteScroll: boolean;

  presets: PresetLibrary;
  activeFilterPresetId: string;
  activeAlgorithmPresetId: string;
  activeDisplayPresetId: string;
  /** When set, this drives the three above. Editing any group clears it. */
  activeTotalPresetId: string | null;
}

export function isAlgorithmId(value: unknown): value is AlgorithmId {
  return (
    value === 'off' ||
    value === 'fsrs' ||
    value === 'sm2' ||
    value === 'leitner'
  );
}

export function isGradingMode(value: unknown): value is GradingMode {
  return value === 'auto' || value === 'hybrid' || value === 'manual';
}

export function isSensitivity(value: unknown): value is Sensitivity {
  return (
    value === 'conservative' ||
    value === 'medium' ||
    value === 'aggressive' ||
    value === 'custom'
  );
}

export function isRating(value: unknown): value is Rating {
  return (
    value === 'again' ||
    value === 'hard' ||
    value === 'good' ||
    value === 'easy'
  );
}

/** Clamp a retention setting into range, falling back when unusable. */
export function normalizeRetention(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return FSRS_DEFAULT_TUNABLES.requestRetention;
  return Math.min(
    REQUEST_RETENTION_MAX,
    Math.max(REQUEST_RETENTION_MIN, numeric)
  );
}

/** Clamp a maximum-interval setting into range, falling back when unusable. */
export function normalizeMaximumInterval(value: unknown): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return FSRS_DEFAULT_TUNABLES.maximumInterval;
  return Math.min(
    MAXIMUM_INTERVAL_MAX,
    Math.max(MAXIMUM_INTERVAL_MIN, numeric)
  );
}

export function isPreviewSize(value: unknown): value is PreviewSize {
  return (
    value === 'small' ||
    value === 'medium' ||
    value === 'large'
  );
}

// Persisted per note. path/title are omitted — path is the map key in
// PluginData.previews, and title is always the file basename, so both are
// cheap to derive at read time instead of duplicating them on disk.
export interface StoredNotePreview {
  mtime: number;
  // Omitted entirely (not `null`) when the note has no image — most notes
  // don't, and skipping the key avoids paying for "imagePath":null on each.
  imagePath?: string;
  mediaOnly?: true;
  // True when the feed item is a non-Markdown vault file rather than a note
  // containing an attachment embed.
  attachment?: true;
  // Legacy cached previews may still contain a snippet. New previews render
  // snippets on demand so this field is intentionally optional.
  snippet?: string;
}

export interface NotePreview extends StoredNotePreview {
  path: string;
  title: string;
}

export interface ViewHistoryEntry {
  path: string;
  viewedAt: number;
}

export interface PluginData {
  settings: PluginSettings;
  previews: Record<string, StoredNotePreview>;
  history: ViewHistoryEntry[];
  indexFormatVersion: number;
}

export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function toNotePreview(path: string, stored: StoredNotePreview): NotePreview {
  return { path, title: titleFromPath(path), ...stored };
}

// ─── Per-note SRS state ────────────────────────────────────────────────────

/**
 * Scheduling state for one note. Persisted in the sidecar store, never in the
 * note itself — the whole point of this fork is that notes are never written
 * to.
 *
 * `data` carries the algorithm-specific payload (an FSRS card, SM-2 ease and
 * interval, a Leitner box number, ...). It is deliberately untyped at this
 * boundary so algorithms stay pluggable; each algorithm module casts it
 * internally.
 */
export interface NoteSrsState {
  algorithm: AlgorithmId;
  /** Epoch ms when the note next becomes due. */
  due: number;
  /** Epoch ms of the most recent recorded review. */
  lastReviewedAt: number;
  /** Number of recorded reviews (informative signals only). */
  reviews: number;
  /** Content hash at the last review, used to detect material edits. */
  hash: string;
  /**
   * Epoch ms of the last time this note was shown but not engaged with. This
   * raises selection priority only — it must never reach an algorithm's
   * `review()`, because a skip is the absence of a review rather than a failed
   * retrieval. Feeding skips in as failures fabricates lapses and corrupts the
   * model.
   */
  unengagedAt?: number;
  data: Record<string, unknown>;
}

export type SrsEventKind = 'review' | 'unengaged' | 'edit';

/** One line of the append-only sidecar log. */
export interface SrsLogEntry {
  /** Epoch ms of the event. */
  t: number;
  /** Note path. */
  path: string;
  kind: SrsEventKind;
  /** Present only for kind === 'review'. */
  rating?: Rating;
  /** Which algorithm computed the resulting schedule. */
  algorithm?: AlgorithmId;
  /** Content hash at event time. */
  hash?: string;
  /**
   * 'auto' when inferred from behaviour (in which case `rating` is always
   * 'good'), 'explicit' when the user picked the rating.
   */
  source?: 'auto' | 'explicit';
  /**
   * The state produced by this review, for `kind === 'review'`.
   *
   * The outcome is stored rather than the inputs so that replaying the log
   * cannot drift: ts-fsrs's fuzzing is deterministic today, but that is an
   * undocumented implementation detail, and a library upgrade or a changed
   * retention setting would otherwise silently reconstruct different state.
   */
  state?: NoteSrsState;
}

/**
 * A compacted view of the log: the current state of every note plus how many
 * log lines have already been folded in. Loading is snapshot + replay of the
 * tail, which keeps startup O(tail) rather than O(whole history).
 */
export interface SrsSnapshot {
  version: number;
  /** Number of log lines already folded into `states`. */
  logLines: number;
  states: Record<string, NoteSrsState>;
}
