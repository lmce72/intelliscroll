import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeAlgorithm,
  activeDisplay,
  activeFilter,
  allowsStandaloneFiles,
  commitFilterPreset,
  defaultFilterPreset,
  defaultLibrary,
  duplicatePreset,
  ensureLibrary,
  fileTypesAllowingStandalone,
  idsForTotal,
  libraryFromUnknownLegacy,
  removePreset,
  resolveActiveIds,
} from '../src/presets.ts';
import { compileFilter } from '../src/filtering.ts';
import type { PresetLibrary } from '../src/types.ts';

// ─── integrity ─────────────────────────────────────────────────────────────

test('a garbage library degrades to a working one instead of throwing', () => {
  for (const input of [null, undefined, 42, 'nonsense', [], { filters: 'no' }]) {
    const library = ensureLibrary(input);
    assert.equal(library.filters.length, 1, `filters for ${String(input)}`);
    assert.equal(library.algorithms.length, 1);
    assert.equal(library.displays.length, 1);
    assert.equal(library.totals.length, 1, 'and a total tying them together');
    assert.equal(library.totals[0]!.filterId, library.filters[0]!.id);
  }
});

test('invalid entries are dropped rather than kept half-formed', () => {
  const library = ensureLibrary({
    filters: [
      { id: 'good', name: 'Good', folders: { mode: 'blacklist', values: [] },
        tags: { mode: 'blacklist', values: [] },
        globs: { mode: 'blacklist', values: [] },
        searchQuery: '', fileTypes: { mode: 'blacklist', values: [] },
        includeMediaOnlyNotes: true },
      { id: 'bad', name: 'Missing everything else' },
      'not an object',
      null,
    ],
  });

  assert.equal(library.filters.length, 1);
  assert.equal(library.filters[0]!.id, 'good');
});

test('duplicate ids are reassigned so "active" stays unambiguous', () => {
  const template = defaultFilterPreset('same-id', 'A');
  const library = ensureLibrary({
    filters: [template, { ...template, name: 'B' }],
  });

  assert.equal(library.filters.length, 2);
  assert.notEqual(library.filters[0]!.id, library.filters[1]!.id);
});

test('totals pointing at a deleted preset are removed', () => {
  const library = ensureLibrary({
    filters: [defaultFilterPreset('f1', 'F')],
    algorithms: [],
    displays: [],
    totals: [
      { id: 't1', name: 'Dangling', filterId: 'gone', algorithmId: 'x', displayId: 'y' },
    ],
  });

  assert.equal(
    library.totals.some((total) => total.name === 'Dangling'),
    false,
    'the dangling total is dropped'
  );
  // A fresh default replaces it, because every group is kept non-empty.
  assert.equal(library.totals.length, 1);
  assert.equal(library.totals[0]!.filterId, 'f1');
});

// ─── migration from the old flat settings ──────────────────────────────────

test('flat settings migrate into a single Default preset, field for field', () => {
  const library = libraryFromUnknownLegacy({
    excludeFolders: ['4. Archive', '10-Planner'],
    excludeTags: ['draft'],
    excludeGlobs: ['_*'],
    searchQuery: 'tag:#work',
    showNonMarkdownFiles: true,
    includeMediaOnlyNotes: false,
    simplifiedView: false,
    reduceAnimations: true,
    previewSize: 'large',
    openNoteBehavior: 'reuse',
    frontmatterImageProps: ['cover'],
    frontmatterBeforeProps: ['status'],
    frontmatterAfterProps: ['tags'],
    algorithm: 'fsrs',
    gradingMode: 'manual',
    sensitivity: 'aggressive',
    fsrsTunables: { requestRetention: 0.85, maximumInterval: 200, enableFuzz: false },
  });

  const filter = library.filters[0]!;
  assert.deepEqual(filter.folders.values, ['4. Archive', '10-Planner']);
  assert.equal(filter.folders.mode, 'blacklist');
  assert.deepEqual(filter.tags.values, ['draft']);
  assert.deepEqual(filter.globs.values, ['_*']);
  assert.equal(filter.searchQuery, 'tag:#work');
  assert.equal(filter.includeMediaOnlyNotes, false);

  const algorithm = library.algorithms[0]!;
  assert.equal(algorithm.algorithm, 'fsrs');
  assert.equal(algorithm.gradingMode, 'manual');
  assert.equal(algorithm.sensitivity, 'aggressive');
  assert.equal(algorithm.fsrsTunables.requestRetention, 0.85);
  assert.equal(algorithm.fsrsTunables.enableFuzz, false);

  const display = library.displays[0]!;
  assert.equal(display.simplifiedView, false);
  assert.equal(display.reduceAnimations, true);
  assert.equal(display.previewSize, 'large');
  assert.equal(display.openNoteBehavior, 'reuse');
  assert.deepEqual(display.frontmatterBeforeProps, ['status']);
  assert.deepEqual(display.frontmatterAfterProps, ['tags']);

  assert.equal(library.totals.length, 1);
});

test('hiding standalone files keeps notes in the feed', () => {
  // This is the regression that mattered: `showNonMarkdownFiles: false` only
  // ever gated *attachments*. Migrating it to an empty whitelist excluded
  // `note` as well and emptied the feed completely — a silent data-shaped bug
  // that no amount of type checking would have caught.
  const hidden = compileFilter(
    libraryFromUnknownLegacy({ showNonMarkdownFiles: false }).filters[0]!
  );
  assert.equal(hidden.passesPath('note.md'), true, 'notes must survive');
  assert.equal(hidden.passesPath('paper.pdf'), false);
  assert.equal(hidden.passesPath('photo.png'), false);

  const shown = compileFilter(
    libraryFromUnknownLegacy({ showNonMarkdownFiles: true }).filters[0]!
  );
  assert.equal(shown.passesPath('note.md'), true);
  assert.equal(shown.passesPath('paper.pdf'), true);
});

test('allowsStandaloneFiles reports whether any file kind gets through', () => {
  assert.equal(
    allowsStandaloneFiles(fileTypesAllowingStandalone(false)),
    false
  );
  assert.equal(allowsStandaloneFiles(fileTypesAllowingStandalone(true)), true);
  // A whitelist containing only notes allows no standalone files either.
  assert.equal(allowsStandaloneFiles({ mode: 'whitelist', values: ['note'] }), false);
  assert.equal(
    allowsStandaloneFiles({ mode: 'whitelist', values: ['note', 'image'] }),
    true
  );
});

test('the pre-fork flat frontmatter list becomes the after-preview list', () => {
  const library = libraryFromUnknownLegacy({
    frontmatterDisplayProps: ['status', 'tags'],
  });
  assert.deepEqual(library.displays[0]!.frontmatterAfterProps, ['status', 'tags']);
});

test('migrating an empty object still yields a usable library', () => {
  const library = libraryFromUnknownLegacy({});
  assert.equal(library.filters.length, 1);
  assert.equal(library.algorithms[0]!.algorithm, 'off', 'behaviour-preserving');
  assert.equal(library.filters[0]!.includeMediaOnlyNotes, true);
});

// ─── copy-on-inherit ───────────────────────────────────────────────────────

test('a copy is fully independent of its parent', () => {
  const library: PresetLibrary = {
    filters: [defaultFilterPreset('f1', 'Parent')],
    algorithms: [],
    displays: [],
    totals: [],
  };
  library.filters[0]!.folders.values.push('Keep');

  const result = duplicatePreset(library, 'filter', 'f1');
  assert.ok(result);

  const copy = library.filters.find((p) => p.id === result.newId)!;
  assert.deepEqual(copy.folders.values, ['Keep'], 'copied the nested rule');
  assert.notEqual(copy.id, 'f1');

  // This is the whole promise of copy-on-inherit: editing one leaves the other
  // alone, including the nested objects, which a shallow copy would share.
  copy.folders.values.push('Added to copy');
  assert.deepEqual(library.filters[0]!.folders.values, ['Keep']);

  library.filters[0]!.folders.values.push('Added to parent');
  assert.deepEqual(copy.folders.values, ['Keep', 'Added to copy']);
});

test('copies get a distinct name and never collide', () => {
  const library: PresetLibrary = {
    filters: [defaultFilterPreset('f1', 'Work')],
    algorithms: [],
    displays: [],
    totals: [],
  };
  const first = duplicatePreset(library, 'filter', 'f1')!;
  const second = duplicatePreset(library, 'filter', first.newId)!;
  const names = library.filters.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, `names collided: ${names.join(', ')}`);
  assert.ok(names.includes('Work (copy)'));
  assert.ok(second);
});

test('duplicating a total preset also duplicates its three sub-presets', () => {
  const library = defaultLibrary();
  const original = library.totals[0]!;

  const result = duplicatePreset(library, 'total', original.id)!;
  const copy = library.totals.find((t) => t.id === result.newId)!;

  assert.notEqual(copy.filterId, original.filterId);
  assert.notEqual(copy.algorithmId, original.algorithmId);
  assert.notEqual(copy.displayId, original.displayId);

  // Otherwise editing the copy's filter would edit the original's — link
  // semantics, which this system does not promise.
  const copyFilter = library.filters.find((p) => p.id === copy.filterId)!;
  copyFilter.searchQuery = 'only in the copy';
  assert.equal(
    library.filters.find((p) => p.id === original.filterId)!.searchQuery,
    ''
  );
});

// ─── removal ───────────────────────────────────────────────────────────────

test('the last preset in a group cannot be removed', () => {
  const library = defaultLibrary();
  assert.equal(removePreset(library, 'filter', library.filters[0]!.id), false);
  assert.equal(library.filters.length, 1);
});

test('removing a sub-preset also removes totals that referenced it', () => {
  const library = defaultLibrary();
  library.filters.push(defaultFilterPreset('extra', 'Extra'));
  library.totals.push({
    id: 't2',
    name: 'Uses extra',
    filterId: 'extra',
    algorithmId: library.algorithms[0]!.id,
    displayId: library.displays[0]!.id,
  });

  assert.equal(removePreset(library, 'filter', 'extra'), true);
  assert.equal(
    library.totals.some((t) => t.filterId === 'extra'),
    false,
    'a total must not point at a preset that no longer exists'
  );
});

// ─── resolution ────────────────────────────────────────────────────────────

test('resolution falls back to the first preset when an id dangles', () => {
  const library = defaultLibrary();
  assert.equal(activeFilter(library, 'gone').id, library.filters[0]!.id);
  assert.equal(activeAlgorithm(library, '').id, library.algorithms[0]!.id);
  assert.equal(activeDisplay(library, 'nope').id, library.displays[0]!.id);
});

test('a total preset drives all three groups', () => {
  const library = defaultLibrary();
  library.filters.push(defaultFilterPreset('f2', 'Second'));
  library.algorithms.push({
    ...library.algorithms[0]!,
    id: 'a2',
    name: 'Second',
  });
  library.displays.push({ ...library.displays[0]!, id: 'd2', name: 'Second' });

  const total = {
    id: 't2',
    name: 'Combo',
    filterId: 'f2',
    algorithmId: 'a2',
    displayId: 'd2',
  };
  library.totals.push(total);

  const ids = idsForTotal(library, 't2')!;
  assert.equal(ids.activeFilterPresetId, 'f2');
  assert.equal(ids.activeAlgorithmPresetId, 'a2');
  assert.equal(ids.activeDisplayPresetId, 'd2');

  const resolved = resolveActiveIds(library, { activeTotalPresetId: 't2' });
  assert.equal(resolved.activeFilterPresetId, 'f2');
  assert.equal(resolved.activeTotalPresetId, 't2');
});

test('a dangling total falls back to per-group selection', () => {
  const library = defaultLibrary();
  const resolved = resolveActiveIds(library, {
    activeTotalPresetId: 'deleted-total',
    activeFilterPresetId: library.filters[0]!.id,
  });

  assert.equal(resolved.activeTotalPresetId, null, 'drops the dead total');
  assert.equal(resolved.activeFilterPresetId, library.filters[0]!.id);
});

test('per-group ids are honoured, and unknown ones fall back', () => {
  const library = defaultLibrary();
  library.filters.push(defaultFilterPreset('f2', 'Second'));

  const kept = resolveActiveIds(library, { activeFilterPresetId: 'f2' });
  assert.equal(kept.activeFilterPresetId, 'f2');

  const unknown = resolveActiveIds(library, { activeFilterPresetId: 'ghost' });
  assert.equal(unknown.activeFilterPresetId, library.filters[0]!.id);
});

test('a total with no id selects nothing total-shaped', () => {
  const library = defaultLibrary();
  assert.equal(idsForTotal(library, 'missing'), null);
  assert.equal(resolveActiveIds(library, {}).activeTotalPresetId, null);
});

// ─── Committing a temporary filter configuration ───────────────────────────

test('committing writes back to the preset the configuration came from', () => {
  // The rule that makes both entry points work: try another preset and keep
  // it, or edit the current one and keep the edits. Matching on the active
  // preset instead would turn "try B and keep it" into "overwrite A with B".
  const library = defaultLibrary();
  const a = library.filters[0]!;
  const b = { ...structuredClone(a), id: 'preset-b', name: 'B', searchQuery: 'from-b' };
  library.filters.push(b);

  const tried = { ...structuredClone(b), searchQuery: 'edited-while-trying' };
  const result = commitFilterPreset(library, tried);

  assert.equal(result.activeId, 'preset-b');
  assert.equal(result.created, false);
  assert.equal(
    library.filters.find((p) => p.id === 'preset-b')!.searchQuery,
    'edited-while-trying',
    'the preset it came from is the one that changed'
  );
  assert.equal(
    library.filters.find((p) => p.id === a.id)!.searchQuery,
    a.searchQuery,
    'and the preset that merely happened to be active is untouched'
  );
});

test('committing does not alias the configuration into the library', () => {
  // The caller keeps its session object; if the library held the same object,
  // a later edit to one would silently change the other.
  const library = defaultLibrary();
  const target = library.filters[0]!;
  const config = structuredClone(target);

  commitFilterPreset(library, config);
  config.searchQuery = 'changed-after-committing';

  assert.notEqual(
    library.filters.find((p) => p.id === target.id)!.searchQuery,
    'changed-after-committing'
  );
});

test('committing a configuration whose preset was deleted creates one', () => {
  // Writing it into some other preset would silently overwrite configuration
  // the user never touched, which is worse than an extra entry they can see.
  const library = defaultLibrary();
  const countBefore = library.filters.length;
  const orphan = { ...structuredClone(library.filters[0]!), id: 'gone', name: 'Gone' };

  const result = commitFilterPreset(library, orphan);

  assert.equal(result.created, true);
  assert.equal(library.filters.length, countBefore + 1);
  assert.notEqual(result.activeId, 'gone', 'the id has to be a real one');
  assert.equal(
    library.filters.find((p) => p.id === result.activeId)!.name,
    'Gone',
    'and it keeps the name the user was looking at'
  );
});

test('committing the active preset unchanged is a no-op that keeps its id', () => {
  const library = defaultLibrary();
  const target = library.filters[0]!;
  const before = JSON.stringify(library);

  const result = commitFilterPreset(library, structuredClone(target));

  assert.equal(result.activeId, target.id);
  assert.equal(result.created, false);
  assert.equal(JSON.stringify(library), before, 'nothing else moved');
});
