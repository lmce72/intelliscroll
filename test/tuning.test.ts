import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TIER_COUNT,
  DEFAULT_TOP_GAP_DAYS,
  FSRS_DEFAULT_TUNABLES,
  REQUEST_RETENTION_MAX,
  REQUEST_RETENTION_MIN,
  TOP_GAP_DAYS_MAX,
  TOP_GAP_DAYS_MIN,
  isTierCount,
  normalizeTierCount,
  normalizeTopGapDays,
  type AlgorithmPreset,
  type DisplayPreset,
} from '../src/types.ts';
import {
  backfillPresetDefaults,
  defaultAlgorithmPreset,
  defaultDisplayPreset,
  defaultLibrary,
  ensureLibrary,
  fsrsRetentionWindow,
  normalizeIntervalUnit,
  normalizeSensitivityThresholds,
  referenceTierIntervals,
  retentionBounds,
} from '../src/presets.ts';
import { SENSITIVITY_THRESHOLDS } from '../src/grading.ts';

// ─── Numeric backfill ──────────────────────────────────────────────────────

test('top gap days clamp into range and fall back when unusable', () => {
  assert.equal(normalizeTopGapDays(DEFAULT_TOP_GAP_DAYS), DEFAULT_TOP_GAP_DAYS);
  assert.equal(normalizeTopGapDays(0), TOP_GAP_DAYS_MIN, 'zero is below the floor');
  assert.equal(normalizeTopGapDays(-4), TOP_GAP_DAYS_MIN);
  assert.equal(normalizeTopGapDays(999), TOP_GAP_DAYS_MAX);
  assert.equal(normalizeTopGapDays(3.6), 4, 'a fractional value rounds to a whole day');
  for (const bad of [undefined, null, 'nope', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeTopGapDays(bad), DEFAULT_TOP_GAP_DAYS, `value ${String(bad)}`);
  }
});

test('tier count accepts only the offered lengths', () => {
  assert.equal(isTierCount(4), true);
  assert.equal(isTierCount(8), true);
  assert.equal(isTierCount(6), false);
  assert.equal(isTierCount('4'), false);
  assert.equal(normalizeTierCount(8), 8);
  for (const bad of [undefined, 6, 0, '8', Number.NaN]) {
    assert.equal(normalizeTierCount(bad), DEFAULT_TIER_COUNT, `value ${String(bad)}`);
  }
});

test('interval unit round-trips the offered values and falls back otherwise', () => {
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    assert.equal(normalizeIntervalUnit(unit), unit);
  }
  for (const bad of [undefined, null, 'DAYS', 'seconds', 24]) {
    assert.equal(normalizeIntervalUnit(bad), 'days', `value ${String(bad)}`);
  }
});

test('custom thresholds are sanitized to a fresh object', () => {
  const kept = normalizeSensitivityThresholds({ openedOnly: true, engagedMs: 800 });
  assert.deepEqual(kept, { openedOnly: true, engagedMs: 800 });

  const repaired = normalizeSensitivityThresholds({ openedOnly: 'yes', engagedMs: -5 });
  assert.deepEqual(repaired, SENSITIVITY_THRESHOLDS.medium, 'malformed fields fall back');

  // The medium preset must never be handed out for mutation.
  assert.notEqual(
    normalizeSensitivityThresholds(undefined),
    SENSITIVITY_THRESHOLDS.medium
  );
});

test('backfill gives old presets the new fields', () => {
  const library = defaultLibrary();
  const algorithm = library.algorithms[0]! as Partial<AlgorithmPreset>;
  const display = library.displays[0]! as Partial<DisplayPreset>;
  Reflect.deleteProperty(algorithm, 'topGapDays');
  Reflect.deleteProperty(display, 'intervalUnit');
  Reflect.deleteProperty(display, 'tierCount');

  backfillPresetDefaults(library);

  assert.equal(algorithm.topGapDays, DEFAULT_TOP_GAP_DAYS);
  assert.equal(display.intervalUnit, 'days');
  assert.equal(display.tierCount, DEFAULT_TIER_COUNT);
});

test('the read prompt fails closed on anything that is not an explicit true', () => {
  // It expands a control under the reader's cursor, so an unreadable or
  // hand-edited value has to mean off rather than switching itself on.
  const library = defaultLibrary();
  const display = library.displays[0]! as Record<string, unknown>;

  for (const value of [undefined, null, 'true', 1, {}, []]) {
    display.promptRatingAfterRead = value;
    backfillPresetDefaults(library);
    assert.equal(
      library.displays[0]!.promptRatingAfterRead,
      false,
      `${JSON.stringify(value)} must mean off`
    );
  }

  display.promptRatingAfterRead = true;
  backfillPresetDefaults(library);
  assert.equal(library.displays[0]!.promptRatingAfterRead, true, 'true survives');
});

test('ensureLibrary repairs a library that predates the tuning fields', () => {
  const library = defaultLibrary();
  Reflect.deleteProperty(library.algorithms[0]!, 'topGapDays');
  Reflect.deleteProperty(library.displays[0]!, 'intervalUnit');
  Reflect.deleteProperty(library.displays[0]!, 'tierCount');

  const repaired = ensureLibrary(library);

  assert.equal(repaired.algorithms[0]!.topGapDays, DEFAULT_TOP_GAP_DAYS);
  assert.equal(repaired.displays[0]!.intervalUnit, 'days');
  assert.equal(repaired.displays[0]!.tierCount, DEFAULT_TIER_COUNT);
});

test('the shipped defaults carry every tuning field', () => {
  const algorithm = defaultAlgorithmPreset();
  const display = defaultDisplayPreset();
  assert.equal(algorithm.topGapDays, DEFAULT_TOP_GAP_DAYS);
  assert.equal(display.intervalUnit, 'days');
  assert.equal(display.tierCount, DEFAULT_TIER_COUNT);
});

// ─── Retention bounds ──────────────────────────────────────────────────────

test('a missing window falls back to the global range and says so', () => {
  const bounds = retentionBounds(null, 0.9);
  assert.deepEqual(bounds, {
    min: REQUEST_RETENTION_MIN,
    max: REQUEST_RETENTION_MAX,
    fellBack: true,
    outside: false,
  });
});

test('an existing window bounds an in-range value exactly', () => {
  const bounds = retentionBounds({ min: 0.95, max: 0.97 }, 0.96);
  assert.deepEqual(bounds, {
    min: 0.95,
    max: 0.97,
    fellBack: false,
    outside: false,
  });
});

test('a stored value outside the window widens it rather than lying', () => {
  const bounds = retentionBounds({ min: 0.95, max: 0.97 }, 0.9);
  assert.equal(bounds.min, 0.9, 'the stored value stays representable');
  assert.equal(bounds.max, 0.97);
  assert.equal(bounds.outside, true);
  assert.equal(bounds.fellBack, false);
});

test('a non-finite stored value does not poison the bounds', () => {
  const bounds = retentionBounds({ min: 0.95, max: 0.97 }, Number.NaN);
  assert.ok(Number.isFinite(bounds.min));
  assert.ok(Number.isFinite(bounds.max));
});

// ─── The reference ladder and its window ───────────────────────────────────

test('the reference ladder is three Good reviews taken when due', () => {
  const intervals = referenceTierIntervals(
    { ...FSRS_DEFAULT_TUNABLES, enableFuzz: false },
    4
  );
  assert.equal(intervals.length, 4);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i]! >= intervals[i - 1]!,
      `tiers ascend: ${JSON.stringify(intervals)}`
    );
  }
  // Deterministic, so two calls must agree exactly.
  assert.deepEqual(
    intervals,
    referenceTierIntervals({ ...FSRS_DEFAULT_TUNABLES, enableFuzz: false }, 4)
  );
});

test('a 30-day cap and a 2-day gap yield a window, not nothing', () => {
  const window = fsrsRetentionWindow(
    { ...FSRS_DEFAULT_TUNABLES, maximumInterval: 30, enableFuzz: false },
    2,
    4
  );

  assert.ok(window !== null, 'a qualifying retention range exists');
  assert.ok(
    window.min >= REQUEST_RETENTION_MIN && window.max <= REQUEST_RETENTION_MAX,
    'window stays inside the allowed range'
  );
  assert.ok(window.min > 0.9, 'the clamp forces retention high before the gap opens');
  // Both ends are derived, not clipped at the ceiling: past the upper edge the
  // ladder is squeezed until the top two tiers are less than the gap apart.
  assert.ok(
    window.max < REQUEST_RETENTION_MAX,
    'the upper edge is found by the rule, not by running out of range'
  );

  // The rule is satisfied at the window's lower edge and violated just below it.
  const gapAt = (retention: number): number => {
    const intervals = referenceTierIntervals(
      { ...FSRS_DEFAULT_TUNABLES, maximumInterval: 30, enableFuzz: false, requestRetention: retention },
      4
    );
    return intervals[intervals.length - 1]! - intervals[intervals.length - 2]!;
  };
  assert.ok(gapAt(window.min) >= 2 - 1e-9);
  assert.ok(gapAt(Math.max(0.7, window.min - 0.005)) < 2);
});

test('an impossible top gap yields no window so the caller can fall back', () => {
  const window = fsrsRetentionWindow(
    { ...FSRS_DEFAULT_TUNABLES, maximumInterval: 30, enableFuzz: false },
    30,
    4
  );
  assert.equal(window, null);
});
