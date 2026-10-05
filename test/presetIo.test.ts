import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportLibrary,
  exportPreset,
  importPresets,
} from '../src/presetIo.ts';
import {
  defaultAlgorithmPreset,
  defaultDisplayPreset,
  defaultFilterPreset,
} from '../src/presets.ts';
import type { PresetLibrary } from '../src/types.ts';

/** A library whose every preset is recognisable by name and content. */
function sampleLibrary(): PresetLibrary {
  const filter = defaultFilterPreset('f1', 'Work');
  filter.folders.values.push('Projects');
  filter.searchQuery = 'tag:#work';

  const algorithm = defaultAlgorithmPreset('a1', 'Fast');
  algorithm.algorithm = 'fsrs';
  algorithm.sensitivity = 'aggressive';

  const display = defaultDisplayPreset('d1', 'Compact');
  display.previewSize = 'small';

  return {
    filters: [filter],
    algorithms: [algorithm],
    displays: [display],
    totals: [
      {
        id: 't1',
        name: 'Workflow',
        filterId: 'f1',
        algorithmId: 'a1',
        displayId: 'd1',
      },
    ],
  };
}

/** A valid destination library with ids and names distinct from the sample. */
function baseLibrary(): PresetLibrary {
  return {
    filters: [defaultFilterPreset('cur-f', 'Current filter')],
    algorithms: [defaultAlgorithmPreset('cur-a', 'Current algorithm')],
    displays: [defaultDisplayPreset('cur-d', 'Current display')],
    totals: [
      {
        id: 'cur-t',
        name: 'Current total',
        filterId: 'cur-f',
        algorithmId: 'cur-a',
        displayId: 'cur-d',
      },
    ],
  };
}

// ─── export / import round-trips ───────────────────────────────────────────

test('a full library export round-trips with its fields intact', () => {
  const result = importPresets(exportLibrary(sampleLibrary()), baseLibrary());

  assert.equal(result.ok, true);
  assert.deepEqual(result.imported, {
    filters: 1,
    algorithms: 1,
    displays: 1,
    totals: 1,
  });

  const filter = result.library.filters.find((p) => p.name === 'Work');
  assert.ok(filter);
  assert.deepEqual(filter.folders.values, ['Projects']);
  assert.equal(filter.searchQuery, 'tag:#work');

  const algorithm = result.library.algorithms.find((p) => p.name === 'Fast');
  assert.ok(algorithm);
  assert.equal(algorithm.algorithm, 'fsrs');
  assert.equal(algorithm.sensitivity, 'aggressive');

  const display = result.library.displays.find((p) => p.name === 'Compact');
  assert.ok(display);
  assert.equal(display.previewSize, 'small');
});

test('a single filter export round-trips', () => {
  const json = exportPreset(sampleLibrary(), 'filter', 'f1');
  assert.ok(json);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);
  assert.equal(result.imported.filters, 1);
  assert.equal(result.imported.algorithms, 0);
  assert.equal(result.imported.displays, 0);
  assert.equal(result.imported.totals, 0);

  const filter = result.library.filters.find((p) => p.name === 'Work');
  assert.ok(filter);
  assert.deepEqual(filter.folders.values, ['Projects']);
});

test('a single algorithm export round-trips', () => {
  const json = exportPreset(sampleLibrary(), 'algorithm', 'a1');
  assert.ok(json);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);
  assert.equal(result.imported.algorithms, 1);

  const algorithm = result.library.algorithms.find((p) => p.name === 'Fast');
  assert.ok(algorithm);
  assert.equal(algorithm.algorithm, 'fsrs');
});

test('a single display export round-trips', () => {
  const json = exportPreset(sampleLibrary(), 'display', 'd1');
  assert.ok(json);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);
  assert.equal(result.imported.displays, 1);

  const display = result.library.displays.find((p) => p.name === 'Compact');
  assert.ok(display);
  assert.equal(display.previewSize, 'small');
});

test('a total export carries the sub-presets it references', () => {
  const json = exportPreset(sampleLibrary(), 'total', 't1');
  assert.ok(json);

  const parsed = JSON.parse(json) as { presets: PresetLibrary };
  assert.equal(parsed.presets.filters.length, 1);
  assert.equal(parsed.presets.algorithms.length, 1);
  assert.equal(parsed.presets.displays.length, 1);
  assert.equal(parsed.presets.totals.length, 1);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);
  assert.deepEqual(result.imported, {
    filters: 1,
    algorithms: 1,
    displays: 1,
    totals: 1,
  });

  const total = result.library.totals.find((p) => p.name === 'Workflow');
  assert.ok(total);
  // If the references had dangled, ensureLibrary would have dropped the total.
  const filter = result.library.filters.find((p) => p.id === total.filterId);
  assert.ok(filter);
  assert.deepEqual(filter.folders.values, ['Projects']);
});

test('exporting an id that does not exist returns null', () => {
  const library = sampleLibrary();
  assert.equal(exportPreset(library, 'filter', 'missing'), null);
  assert.equal(exportPreset(library, 'algorithm', 'missing'), null);
  assert.equal(exportPreset(library, 'display', 'missing'), null);
  assert.equal(exportPreset(library, 'total', 'missing'), null);
});

// ─── malformed input ───────────────────────────────────────────────────────

test('malformed JSON is reported rather than thrown', () => {
  const current = baseLibrary();
  const result = importPresets('{ this is not json', current);

  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.deepEqual(result.library, current);
});

test('a literal JSON null is rejected', () => {
  const result = importPresets('null', baseLibrary());
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('an array instead of an object is rejected', () => {
  const result = importPresets('[]', baseLibrary());
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('wrong field types on the envelope are rejected', () => {
  const current = baseLibrary();
  const result = importPresets(
    JSON.stringify({
      version: 1,
      kind: 'filter',
      exportedAt: 0,
      presets: { filters: 'not an array' },
    }),
    current
  );

  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.deepEqual(result.library, current);
});

test('an unsupported version is rejected', () => {
  const result = importPresets(
    JSON.stringify({
      version: 99,
      kind: 'filter',
      exportedAt: 0,
      presets: { filters: [] },
    }),
    baseLibrary()
  );

  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('invalid entries are dropped while valid ones still import', () => {
  const library = sampleLibrary();
  const payload = {
    version: 1,
    kind: 'library',
    exportedAt: 0,
    presets: {
      filters: [
        library.filters[0],
        { id: 'broken', name: 'Broken', folders: 'wrong type' },
      ],
      algorithms: [],
      displays: [],
      totals: [],
    },
  };

  const result = importPresets(JSON.stringify(payload), baseLibrary());
  assert.equal(result.ok, true);
  assert.equal(result.imported.filters, 1);
  assert.equal(
    result.library.filters.some((p) => p.name === 'Broken'),
    false,
    'the malformed entry must not survive'
  );
});

test('a preset missing required fields imports nothing and reports failure', () => {
  const result = importPresets(
    JSON.stringify({
      version: 1,
      kind: 'filter',
      exportedAt: 0,
      presets: { filters: [{ id: 'x', name: 'X' }] },
    }),
    baseLibrary()
  );

  assert.equal(result.ok, false);
  assert.equal(result.imported.filters, 0);
  assert.ok(result.error);
});

// ─── collisions and merging ────────────────────────────────────────────────

test('an id collision with the current library gets a fresh id', () => {
  const current = baseLibrary();
  const source = sampleLibrary();
  source.filters[0]!.id = 'cur-f';

  const json = exportPreset(source, 'filter', 'cur-f');
  assert.ok(json);

  const result = importPresets(json, current);
  assert.equal(result.ok, true);
  assert.equal(result.library.filters.length, 2);

  const ids = result.library.filters.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`);
  assert.ok(
    result.library.filters.some((p) => p.name === 'Work'),
    'the imported preset kept its content'
  );
});

test('a name collision is uniquified with a number', () => {
  const source = sampleLibrary();
  source.filters[0]!.name = 'Current filter';

  const json = exportPreset(source, 'filter', 'f1');
  assert.ok(json);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);

  const names = result.library.filters.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, `names collided: ${names.join(', ')}`);
  assert.ok(names.includes('Current filter 2'), `missing name: ${names.join(', ')}`);
});

test('an imported total follows its presets to their reassigned ids', () => {
  const source = sampleLibrary();
  // Force every sub-preset to collide with one in the current library; the
  // total must be rewritten to point at the copies, not the old ids.
  source.filters[0]!.id = 'cur-f';
  source.algorithms[0]!.id = 'cur-a';
  source.displays[0]!.id = 'cur-d';
  source.totals[0]!.filterId = 'cur-f';
  source.totals[0]!.algorithmId = 'cur-a';
  source.totals[0]!.displayId = 'cur-d';

  const json = exportPreset(source, 'total', 't1');
  assert.ok(json);

  const result = importPresets(json, baseLibrary());
  assert.equal(result.ok, true);

  const total = result.library.totals.find((p) => p.name === 'Workflow');
  assert.ok(total);

  const filter = result.library.filters.find((p) => p.id === total.filterId);
  const algorithm = result.library.algorithms.find((p) => p.id === total.algorithmId);
  const display = result.library.displays.find((p) => p.id === total.displayId);

  assert.ok(filter, 'the total must resolve to the imported filter');
  assert.equal(filter.searchQuery, 'tag:#work');
  assert.ok(algorithm);
  assert.equal(algorithm.algorithm, 'fsrs');
  assert.ok(display);
  assert.equal(display.previewSize, 'small');
});

test('importing into a non-empty library is additive and does not mutate it', () => {
  const current = baseLibrary();
  const result = importPresets(exportLibrary(sampleLibrary()), current);

  assert.equal(result.ok, true);
  assert.equal(result.library.filters.length, 2);
  assert.equal(result.library.algorithms.length, 2);
  assert.equal(result.library.displays.length, 2);
  assert.equal(result.library.totals.length, 2);
  assert.ok(result.library.filters.some((p) => p.id === 'cur-f'));
  assert.ok(result.library.totals.some((p) => p.id === 'cur-t'));

  assert.equal(current.filters.length, 1, 'the caller library is left alone');
  assert.equal(current.totals.length, 1);
});
