import { ensureLibrary, newPresetId, uniqueName } from './presets.ts';
import {
  isAlgorithmPreset,
  isDisplayPreset,
  isFilterPreset,
  isTotalPreset,
  type PresetLibrary,
  type TotalPreset,
} from './types.ts';

/**
 * JSON export/import for the preset library.
 *
 * Presets live in `data.json`, which is gitignored, so this file is the only
 * way a user moves a configuration between machines or backs it up. Everything
 * read here came from a file the user may have hand-edited or that may have
 * been written by another (possibly older) build, so nothing is trusted: the
 * import path validates with the same guards the rest of the plugin uses and
 * degrades to a working library instead of throwing.
 */

/** What an exported payload describes. */
export type ExportKind = 'filter' | 'algorithm' | 'display' | 'total' | 'library';

export interface ExportEnvelope {
  /** Format version, for future compatibility. */
  version: 1;
  kind: ExportKind;
  /** Epoch ms. */
  exportedAt: number;
  /** Always a full library shape, filtered to what `kind` says. */
  presets: PresetLibrary;
}

export interface ImportResult {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  error?: string;
  /** The merged library — always usable, even when nothing was imported. */
  library: PresetLibrary;
  /** Per-group counts actually imported. */
  imported: { filters: number; algorithms: number; displays: number; totals: number };
}

const EXPORT_KINDS: readonly ExportKind[] = [
  'filter',
  'algorithm',
  'display',
  'total',
  'library',
];

function isExportKind(value: unknown): value is ExportKind {
  return (
    typeof value === 'string' &&
    (EXPORT_KINDS as readonly string[]).includes(value)
  );
}

// ─── Export ────────────────────────────────────────────────────────────────

function envelope(kind: ExportKind, presets: PresetLibrary): string {
  const payload: ExportEnvelope = {
    version: 1,
    kind,
    exportedAt: Date.now(),
    presets,
  };
  // Indented because the file exists to be read and hand-edited by a human.
  return JSON.stringify(payload, null, 2);
}

export function exportLibrary(library: PresetLibrary): string {
  return envelope('library', structuredClone(library));
}

/**
 * Export a single preset.
 *
 * A `total` export also carries the three sub-presets it names. Without them
 * the file would not be importable anywhere else: importing a total whose
 * references resolve to nothing would have it silently dropped.
 */
export function exportPreset(
  library: PresetLibrary,
  kind: Exclude<ExportKind, 'library'>,
  id: string
): string | null {
  const presets: PresetLibrary = {
    filters: [],
    algorithms: [],
    displays: [],
    totals: [],
  };

  if (kind === 'filter') {
    const preset = library.filters.find((item) => item.id === id);
    if (!preset) return null;
    presets.filters.push(structuredClone(preset));
    return envelope(kind, presets);
  }

  if (kind === 'algorithm') {
    const preset = library.algorithms.find((item) => item.id === id);
    if (!preset) return null;
    presets.algorithms.push(structuredClone(preset));
    return envelope(kind, presets);
  }

  if (kind === 'display') {
    const preset = library.displays.find((item) => item.id === id);
    if (!preset) return null;
    presets.displays.push(structuredClone(preset));
    return envelope(kind, presets);
  }

  const total = library.totals.find((item) => item.id === id);
  if (!total) return null;
  const filter = library.filters.find((item) => item.id === total.filterId);
  const algorithm = library.algorithms.find(
    (item) => item.id === total.algorithmId
  );
  const display = library.displays.find((item) => item.id === total.displayId);
  if (!filter || !algorithm || !display) return null;
  presets.filters.push(structuredClone(filter));
  presets.algorithms.push(structuredClone(algorithm));
  presets.displays.push(structuredClone(display));
  presets.totals.push(structuredClone(total));
  return envelope(kind, presets);
}

// ─── Import ────────────────────────────────────────────────────────────────

function validEntries<T>(
  value: unknown,
  guard: (item: unknown) => item is T
): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(guard);
}

/**
 * Copy incoming presets so nothing aliases the parsed payload, then give each a
 * fresh id when it collides with one already present. The returned map lets a
 * total's references follow the presets it points at to their new ids.
 */
function reassignForMerge<T extends { id: string; name: string }>(
  incoming: readonly T[],
  merged: ReadonlyArray<{ id: string; name: string }>
): { items: T[]; idMap: Map<string, string> } {
  const usedIds = new Set(merged.map((item) => item.id));
  const takenNames = merged.map((item) => item.name);
  const items: T[] = [];
  const idMap = new Map<string, string>();

  for (const item of incoming) {
    const copy = structuredClone(item);
    if (usedIds.has(copy.id)) {
      let fresh = newPresetId();
      while (usedIds.has(fresh)) fresh = newPresetId();
      copy.id = fresh;
    }
    usedIds.add(copy.id);
    idMap.set(item.id, copy.id);
    copy.name = uniqueName(takenNames, copy.name);
    takenNames.push(copy.name);
    items.push(copy);
  }

  return { items, idMap };
}

function emptyImported(): ImportResult['imported'] {
  return { filters: 0, algorithms: 0, displays: 0, totals: 0 };
}

/**
 * Import an export into an existing library.
 *
 * Never throws: a corrupt file, a truncated download or a payload from an
 * unknown build all return a result object. Merging is additive and ids/names
 * are adjusted to stay unique, because a duplicate id makes "active preset"
 * ambiguous.
 */
export function importPresets(
  json: string,
  current: PresetLibrary
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: 'Not valid JSON.',
      library: current,
      imported: emptyImported(),
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Expected a JSON object at the top level.',
      library: current,
      imported: emptyImported(),
    };
  }

  const envelopeShape = parsed as Partial<ExportEnvelope>;
  if (envelopeShape.version !== 1) {
    return {
      ok: false,
      error: 'Unsupported export version.',
      library: current,
      imported: emptyImported(),
    };
  }
  if (!isExportKind(envelopeShape.kind)) {
    return {
      ok: false,
      error: 'Export is missing a valid kind.',
      library: current,
      imported: emptyImported(),
    };
  }

  const rawPresets = envelopeShape.presets;
  if (
    typeof rawPresets !== 'object' ||
    rawPresets === null ||
    Array.isArray(rawPresets)
  ) {
    return {
      ok: false,
      error: 'Export is missing its presets.',
      library: current,
      imported: emptyImported(),
    };
  }
  const source = rawPresets as Partial<PresetLibrary>;

  const incomingFilters = validEntries(source.filters, isFilterPreset);
  const incomingAlgorithms = validEntries(source.algorithms, isAlgorithmPreset);
  const incomingDisplays = validEntries(source.displays, isDisplayPreset);
  const incomingTotals = validEntries(source.totals, isTotalPreset);

  const merged = structuredClone(current);
  const imported = emptyImported();

  const filters = reassignForMerge(incomingFilters, merged.filters);
  merged.filters.push(...filters.items);
  imported.filters = filters.items.length;

  const algorithms = reassignForMerge(incomingAlgorithms, merged.algorithms);
  merged.algorithms.push(...algorithms.items);
  imported.algorithms = algorithms.items.length;

  const displays = reassignForMerge(incomingDisplays, merged.displays);
  merged.displays.push(...displays.items);
  imported.displays = displays.items.length;

  // A total's references must follow its sub-presets when those got a fresh id,
  // otherwise the composite would point at the id it used to have.
  const remappedTotals: TotalPreset[] = incomingTotals.map((total) => {
    const copy = structuredClone(total);
    copy.filterId = filters.idMap.get(copy.filterId) ?? copy.filterId;
    copy.algorithmId = algorithms.idMap.get(copy.algorithmId) ?? copy.algorithmId;
    copy.displayId = displays.idMap.get(copy.displayId) ?? copy.displayId;
    return copy;
  });
  const totals = reassignForMerge(remappedTotals, merged.totals);
  merged.totals.push(...totals.items);
  imported.totals = totals.items.length;

  const library = ensureLibrary(merged);

  if (
    imported.filters + imported.algorithms + imported.displays + imported.totals ===
    0
  ) {
    return { ok: false, error: 'No valid presets found in the export.', library, imported };
  }

  return { ok: true, library, imported };
}
