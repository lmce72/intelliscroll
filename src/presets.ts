import {
  FSRS_DEFAULT_TUNABLES,
  FILE_CATEGORIES,
  isAlgorithmPreset,
  isDisplayPreset,
  isFilterPreset,
  isTotalPreset,
  type AlgorithmPreset,
  type DisplayPreset,
  type FileCategory,
  type FilterPreset,
  type FilterableKind,
  type FilterRule,
  type PluginSettings,
  type PresetLibrary,
  type RuleMode,
  type TotalPreset,
} from './types.ts';

/**
 * Pure operations over the preset library.
 *
 * Everything here is deterministic and side-effect free so the tricky parts —
 * deep-copy inheritance, falling back when an active id dangles, repairing a
 * library that was hand-edited or imported — can be tested directly.
 *
 * "Inheritance" is copy-on-inherit: a copy is fully independent of its parent,
 * so editing one never disturbs the other. That is why every clone goes
 * through `structuredClone` rather than sharing nested objects.
 */

export type PresetKind = 'filter' | 'algorithm' | 'display' | 'total';

/** Name given to the preset created from settings that predate presets. */
export const DEFAULT_PRESET_NAME = 'Default';

export function newPresetId(): string {
  // Available in Obsidian's Electron runtime and in Node 19+.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

export function emptyRule(): FilterRule {
  return { mode: 'blacklist', values: [] };
}

/** The kinds that are standalone files rather than notes. */
export const STANDALONE_KINDS: readonly FilterableKind[] = [
  'image',
  'document',
  'video',
  'audio',
  'other',
];

/**
 * The file-type rule equivalent to the old `showNonMarkdownFiles` boolean.
 *
 * Hiding standalone files must NOT be expressed as an empty whitelist: that
 * would exclude `note` too and empty the feed entirely. The old setting only
 * ever gated attachments, so the faithful translation is a blacklist of every
 * standalone kind, leaving notes untouched.
 */
export function fileTypesAllowingStandalone(
  allowed: boolean
): FilterPreset['fileTypes'] {
  return allowed
    ? { mode: 'blacklist', values: [] }
    : { mode: 'blacklist', values: [...STANDALONE_KINDS] };
}

/** Whether a file-type rule lets any standalone file through. */
export function allowsStandaloneFiles(
  rule: FilterPreset['fileTypes']
): boolean {
  if (rule.mode === 'blacklist') {
    return STANDALONE_KINDS.some((kind) => !rule.values.includes(kind));
  }
  return STANDALONE_KINDS.some((kind) => rule.values.includes(kind));
}

export function defaultFilterPreset(
  id: string = newPresetId(),
  name: string = DEFAULT_PRESET_NAME
): FilterPreset {
  return {
    id,
    name,
    folders: emptyRule(),
    tags: emptyRule(),
    globs: emptyRule(),
    searchQuery: '',
    // Blacklisting nothing means every standalone file type is allowed, which
    // matches the old `showNonMarkdownFiles: true` default.
    fileTypes: { mode: 'blacklist', values: [] },
    includeMediaOnlyNotes: true,
  };
}

export function defaultAlgorithmPreset(
  id: string = newPresetId(),
  name: string = DEFAULT_PRESET_NAME
): AlgorithmPreset {
  return {
    id,
    name,
    // Off is the behaviour-preserving default.
    algorithm: 'off',
    gradingMode: 'hybrid',
    sensitivity: 'medium',
    fsrsTunables: { ...FSRS_DEFAULT_TUNABLES },
  };
}

export function defaultDisplayPreset(
  id: string = newPresetId(),
  name: string = DEFAULT_PRESET_NAME
): DisplayPreset {
  return {
    id,
    name,
    simplifiedView: true,
    reduceAnimations: false,
    previewSize: 'medium',
    openNoteBehavior: 'tab',
    frontmatterImageProps: ['cover', 'image', 'banner'],
    frontmatterBeforeProps: [],
    frontmatterAfterProps: [],
  };
}

export function defaultLibrary(): PresetLibrary {
  const filter = defaultFilterPreset();
  const algorithm = defaultAlgorithmPreset();
  const display = defaultDisplayPreset();
  return {
    filters: [filter],
    algorithms: [algorithm],
    displays: [display],
    totals: [
      {
        id: newPresetId(),
        name: DEFAULT_PRESET_NAME,
        filterId: filter.id,
        algorithmId: algorithm.id,
        displayId: display.id,
      },
    ],
  };
}

/** The preset seeded from settings that predate the preset system. */
export function libraryFromLegacySettings(
  legacy: LegacyFlatSettings
): PresetLibrary {
  const filter = defaultFilterPreset();
  filter.folders = { mode: 'blacklist', values: [...legacy.excludeFolders] };
  filter.tags = { mode: 'blacklist', values: [...legacy.excludeTags] };
  filter.globs = { mode: 'blacklist', values: [...legacy.excludeGlobs] };
  filter.searchQuery = legacy.searchQuery;
  filter.fileTypes = fileTypesAllowingStandalone(legacy.showNonMarkdownFiles);
  filter.includeMediaOnlyNotes = legacy.includeMediaOnlyNotes;

  const algorithm = defaultAlgorithmPreset();
  algorithm.algorithm = legacy.algorithm;
  algorithm.gradingMode = legacy.gradingMode;
  algorithm.sensitivity = legacy.sensitivity;
  algorithm.fsrsTunables = { ...legacy.fsrsTunables };

  const display = defaultDisplayPreset();
  display.simplifiedView = legacy.simplifiedView;
  display.reduceAnimations = legacy.reduceAnimations;
  display.previewSize = legacy.previewSize;
  display.openNoteBehavior = legacy.openNoteBehavior;
  display.frontmatterImageProps = [...legacy.frontmatterImageProps];
  display.frontmatterBeforeProps = [...legacy.frontmatterBeforeProps];
  display.frontmatterAfterProps = [...legacy.frontmatterAfterProps];

  return {
    filters: [filter],
    algorithms: [algorithm],
    displays: [display],
    totals: [
      {
        id: newPresetId(),
        name: DEFAULT_PRESET_NAME,
        filterId: filter.id,
        algorithmId: algorithm.id,
        displayId: display.id,
      },
    ],
  };
}

/** The flat settings shape this fork used before presets existed. */
export interface LegacyFlatSettings {
  excludeFolders: string[];
  excludeTags: string[];
  excludeGlobs: string[];
  searchQuery: string;
  showNonMarkdownFiles: boolean;
  includeMediaOnlyNotes: boolean;
  simplifiedView: boolean;
  reduceAnimations: boolean;
  previewSize: DisplayPreset['previewSize'];
  openNoteBehavior: DisplayPreset['openNoteBehavior'];
  frontmatterImageProps: string[];
  frontmatterBeforeProps: string[];
  frontmatterAfterProps: string[];
  algorithm: AlgorithmPreset['algorithm'];
  gradingMode: AlgorithmPreset['gradingMode'];
  sensitivity: AlgorithmPreset['sensitivity'];
  fsrsTunables: AlgorithmPreset['fsrsTunables'];
}

// ─── Library integrity ─────────────────────────────────────────────────────

function validEntries<T>(
  value: unknown,
  guard: (item: unknown) => item is T
): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(guard);
}

/**
 * Repair a library read from disk or imported.
 *
 * Nothing loaded from outside is trusted: invalid entries are dropped, ids are
 * de-duplicated, every group is guaranteed non-empty, and totals pointing at
 * presets that no longer exist are removed. A malformed library degrades to a
 * working one rather than throwing.
 */
export function ensureLibrary(input: unknown): PresetLibrary {
  const source =
    typeof input === 'object' && input !== null
      ? (input as Partial<PresetLibrary>)
      : {};

  const library: PresetLibrary = {
    filters: validEntries(source.filters, isFilterPreset),
    algorithms: validEntries(source.algorithms, isAlgorithmPreset),
    displays: validEntries(source.displays, isDisplayPreset),
    totals: validEntries(source.totals, isTotalPreset),
  };

  // Ids must be unique within each group, or "active" becomes ambiguous.
  dedupeIds(library.filters);
  dedupeIds(library.algorithms);
  dedupeIds(library.displays);
  dedupeIds(library.totals);

  if (library.filters.length === 0) library.filters.push(defaultFilterPreset());
  if (library.algorithms.length === 0) {
    library.algorithms.push(defaultAlgorithmPreset());
  }
  if (library.displays.length === 0) library.displays.push(defaultDisplayPreset());

  const filterIds = new Set(library.filters.map((p) => p.id));
  const algorithmIds = new Set(library.algorithms.map((p) => p.id));
  const displayIds = new Set(library.displays.map((p) => p.id));
  library.totals = library.totals.filter(
    (total) =>
      filterIds.has(total.filterId) &&
      algorithmIds.has(total.algorithmId) &&
      displayIds.has(total.displayId)
  );

  // Every group is guaranteed non-empty, totals included. Without this a
  // corrupt or half-written file would leave the composite-preset feature
  // looking as though it had simply vanished. This cannot undo a deliberate
  // deletion, because `removePreset` refuses to empty a group either.
  if (library.totals.length === 0) {
    library.totals.push({
      id: newPresetId(),
      name: DEFAULT_PRESET_NAME,
      filterId: library.filters[0]!.id,
      algorithmId: library.algorithms[0]!.id,
      displayId: library.displays[0]!.id,
    });
  }

  return library;
}

function dedupeIds<T extends { id: string }>(items: T[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) item.id = newPresetId();
    seen.add(item.id);
  }
}

/** Guarantee non-empty rule value lists are de-duplicated and trimmed. */
export function normalizeRule(rule: FilterRule): FilterRule {
  const values = Array.from(
    new Set(rule.values.map((value) => value.trim()).filter((v) => v.length > 0))
  );
  return { mode: rule.mode, values };
}

export function normalizeFileTypes(
  rule: FilterPreset['fileTypes']
): FilterPreset['fileTypes'] {
  // Preserve the canonical category order so the stored form is stable.
  const values = FILE_CATEGORIES.filter((category) =>
    rule.values.includes(category)
  );
  return { mode: rule.mode, values: [...values] };
}

// ─── Cloning (copy-on-inherit) ─────────────────────────────────────────────

/**
 * A name not already in `taken`, suffixing a counter when needed.
 *
 * Exported because import needs the identical rule: two places disagreeing
 * about how names are made unique would produce duplicates the UI cannot tell
 * apart.
 */
export function uniqueName(taken: readonly string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${newPresetId()}`;
}

export function cloneFilterPreset(
  preset: FilterPreset,
  name: string
): FilterPreset {
  return { ...structuredClone(preset), id: newPresetId(), name };
}

export function cloneAlgorithmPreset(
  preset: AlgorithmPreset,
  name: string
): AlgorithmPreset {
  return { ...structuredClone(preset), id: newPresetId(), name };
}

export function cloneDisplayPreset(
  preset: DisplayPreset,
  name: string
): DisplayPreset {
  return { ...structuredClone(preset), id: newPresetId(), name };
}

/**
 * Duplicate a preset, returning the new library and the new id.
 *
 * Duplicating a total preset also duplicates the three sub-presets it
 * references — otherwise editing the copy's filter would edit the original's
 * too, which is link semantics, not the copy semantics this system promises.
 */
export function duplicatePreset(
  library: PresetLibrary,
  kind: PresetKind,
  id: string
): { library: PresetLibrary; newId: string } | null {
  if (kind === 'filter') {
    const source = library.filters.find((p) => p.id === id);
    if (!source) return null;
    const copy = cloneFilterPreset(
      source,
      uniqueName(library.filters.map((p) => p.name), `${source.name} (copy)`)
    );
    library.filters.push(copy);
    return { library, newId: copy.id };
  }

  if (kind === 'algorithm') {
    const source = library.algorithms.find((p) => p.id === id);
    if (!source) return null;
    const copy = cloneAlgorithmPreset(
      source,
      uniqueName(library.algorithms.map((p) => p.name), `${source.name} (copy)`)
    );
    library.algorithms.push(copy);
    return { library, newId: copy.id };
  }

  if (kind === 'display') {
    const source = library.displays.find((p) => p.id === id);
    if (!source) return null;
    const copy = cloneDisplayPreset(
      source,
      uniqueName(library.displays.map((p) => p.name), `${source.name} (copy)`)
    );
    library.displays.push(copy);
    return { library, newId: copy.id };
  }

  const source = library.totals.find((p) => p.id === id);
  if (!source) return null;

  const filterSource = library.filters.find((p) => p.id === source.filterId);
  const algorithmSource = library.algorithms.find(
    (p) => p.id === source.algorithmId
  );
  const displaySource = library.displays.find((p) => p.id === source.displayId);
  if (!filterSource || !algorithmSource || !displaySource) return null;

  const suffix = ' (copy)';
  const filterCopy = cloneFilterPreset(
    filterSource,
    uniqueName(
      library.filters.map((p) => p.name),
      `${filterSource.name}${suffix}`
    )
  );
  const algorithmCopy = cloneAlgorithmPreset(
    algorithmSource,
    uniqueName(
      library.algorithms.map((p) => p.name),
      `${algorithmSource.name}${suffix}`
    )
  );
  const displayCopy = cloneDisplayPreset(
    displaySource,
    uniqueName(
      library.displays.map((p) => p.name),
      `${displaySource.name}${suffix}`
    )
  );
  library.filters.push(filterCopy);
  library.algorithms.push(algorithmCopy);
  library.displays.push(displayCopy);

  const totalCopy: TotalPreset = {
    id: newPresetId(),
    name: uniqueName(
      library.totals.map((p) => p.name),
      `${source.name}${suffix}`
    ),
    filterId: filterCopy.id,
    algorithmId: algorithmCopy.id,
    displayId: displayCopy.id,
  };
  library.totals.push(totalCopy);

  return { library, newId: totalCopy.id };
}

/** Remove a preset. Returns false when it is the last of its group. */
export function removePreset(
  library: PresetLibrary,
  kind: PresetKind,
  id: string
): boolean {
  const group = groupOf(library, kind);
  if (group.length <= 1) return false;
  const index = group.findIndex((preset) => preset.id === id);
  if (index === -1) return false;
  group.splice(index, 1);

  // A total preset cannot point at something that no longer exists.
  if (kind !== 'total') {
    library.totals = library.totals.filter((total) => {
      if (kind === 'filter') return total.filterId !== id;
      if (kind === 'algorithm') return total.algorithmId !== id;
      return total.displayId !== id;
    });
  }

  return true;
}

function groupOf(
  library: PresetLibrary,
  kind: PresetKind
): Array<{ id: string }> {
  switch (kind) {
    case 'filter':
      return library.filters;
    case 'algorithm':
      return library.algorithms;
    case 'display':
      return library.displays;
    case 'total':
      return library.totals;
  }
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * The preset a group id refers to, falling back to the group's first entry.
 *
 * Falling back rather than throwing keeps a dangling id (hand-edited, or a
 * preset deleted in another window) from breaking the feed.
 */
export function activeFilter(
  library: PresetLibrary,
  id: string
): FilterPreset {
  return library.filters.find((preset) => preset.id === id) ?? library.filters[0]!;
}

export function activeAlgorithm(
  library: PresetLibrary,
  id: string
): AlgorithmPreset {
  return (
    library.algorithms.find((preset) => preset.id === id) ??
    library.algorithms[0]!
  );
}

export function activeDisplay(
  library: PresetLibrary,
  id: string
): DisplayPreset {
  return (
    library.displays.find((preset) => preset.id === id) ?? library.displays[0]!
  );
}

/** The three active ids a total preset resolves to, or null if it is gone. */
export function idsForTotal(
  library: PresetLibrary,
  totalId: string
): Pick<
  PluginSettings,
  | 'activeFilterPresetId'
  | 'activeAlgorithmPresetId'
  | 'activeDisplayPresetId'
> | null {
  const total = library.totals.find((preset) => preset.id === totalId);
  if (!total) return null;
  return {
    activeFilterPresetId: total.filterId,
    activeAlgorithmPresetId: total.algorithmId,
    activeDisplayPresetId: total.displayId,
  };
}

/**
 * Rebuild an active-selection from stored ids.
 *
 * A total preset, when it still resolves, drives all three groups. Otherwise
 * each group id is honoured if it exists and falls back to that group's first
 * preset — a dangling id must degrade, not throw.
 */
export function resolveActiveIds(
  library: PresetLibrary,
  raw: {
    activeFilterPresetId?: unknown;
    activeAlgorithmPresetId?: unknown;
    activeDisplayPresetId?: unknown;
    activeTotalPresetId?: unknown;
  }
): Pick<
  PluginSettings,
  | 'activeFilterPresetId'
  | 'activeAlgorithmPresetId'
  | 'activeDisplayPresetId'
  | 'activeTotalPresetId'
> {
  if (typeof raw.activeTotalPresetId === 'string') {
    const ids = idsForTotal(library, raw.activeTotalPresetId);
    if (ids) return { ...ids, activeTotalPresetId: raw.activeTotalPresetId };
  }

  const pick = <T extends { id: string }>(group: T[], id: unknown): string =>
    typeof id === 'string' && group.some((preset) => preset.id === id)
      ? id
      : group[0]!.id;

  return {
    activeFilterPresetId: pick(library.filters, raw.activeFilterPresetId),
    activeAlgorithmPresetId: pick(
      library.algorithms,
      raw.activeAlgorithmPresetId
    ),
    activeDisplayPresetId: pick(library.displays, raw.activeDisplayPresetId),
    activeTotalPresetId: null,
  };
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Build a library from the flat settings this fork used before presets.
 *
 * Every field is read defensively: these come from a hand-editable file and
 * may be missing or the wrong type, and a throw here would make the plugin
 * unloadable.
 */
export function libraryFromUnknownLegacy(
  raw: Record<string, unknown>
): PresetLibrary {
  const defaults = defaultLibrary();
  const filter = defaults.filters[0]!;
  const algorithm = defaults.algorithms[0]!;
  const display = defaults.displays[0]!;

  filter.folders = {
    mode: 'blacklist',
    values: stringArray(raw.excludeFolders, []),
  };
  filter.tags = { mode: 'blacklist', values: stringArray(raw.excludeTags, []) };
  filter.globs = {
    mode: 'blacklist',
    values: stringArray(raw.excludeGlobs, []),
  };
  filter.searchQuery = typeof raw.searchQuery === 'string' ? raw.searchQuery : '';
  filter.fileTypes = fileTypesAllowingStandalone(
    boolOr(raw.showNonMarkdownFiles, true)
  );
  filter.includeMediaOnlyNotes = boolOr(raw.includeMediaOnlyNotes, true);

  if (raw.algorithm === 'off' || raw.algorithm === 'fsrs' || raw.algorithm === 'sm2' || raw.algorithm === 'leitner') {
    algorithm.algorithm = raw.algorithm;
  }
  if (raw.gradingMode === 'auto' || raw.gradingMode === 'hybrid' || raw.gradingMode === 'manual') {
    algorithm.gradingMode = raw.gradingMode;
  }
  if (raw.sensitivity === 'conservative' || raw.sensitivity === 'medium' || raw.sensitivity === 'aggressive') {
    algorithm.sensitivity = raw.sensitivity;
  }
  if (typeof raw.fsrsTunables === 'object' && raw.fsrsTunables !== null) {
    const tunables = raw.fsrsTunables as Record<string, unknown>;
    algorithm.fsrsTunables = {
      requestRetention: tunables.requestRetention as number,
      maximumInterval: tunables.maximumInterval as number,
      enableFuzz: boolOr(tunables.enableFuzz, true),
    };
  }

  display.simplifiedView = boolOr(raw.simplifiedView, true);
  display.reduceAnimations = boolOr(raw.reduceAnimations, false);
  if (typeof raw.previewSize === 'string') {
    display.previewSize = raw.previewSize as DisplayPreset['previewSize'];
  }
  if (typeof raw.openNoteBehavior === 'string') {
    display.openNoteBehavior =
      raw.openNoteBehavior as DisplayPreset['openNoteBehavior'];
  }
  display.frontmatterImageProps = stringArray(raw.frontmatterImageProps, [
    'cover',
    'image',
    'banner',
  ]);
  display.frontmatterBeforeProps = stringArray(raw.frontmatterBeforeProps, []);
  // Older builds stored one flat list; it belonged after the preview.
  display.frontmatterAfterProps = Array.isArray(raw.frontmatterAfterProps)
    ? stringArray(raw.frontmatterAfterProps, [])
    : stringArray(raw.frontmatterDisplayProps, []);

  return defaults;
}

/** A fresh filter rule with the given mode, keeping existing values. */
export function withMode(rule: FilterRule, mode: RuleMode): FilterRule {
  return { mode, values: [...rule.values] };
}

export function emptyFileTypeRule(): FilterPreset['fileTypes'] {
  return { mode: 'blacklist', values: [] };
}

/** All categories, for a whitelist that should allow nothing extra. */
export function allFileCategories(): FileCategory[] {
  return [...FILE_CATEGORIES];
}
