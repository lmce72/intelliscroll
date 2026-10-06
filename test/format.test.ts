import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeInterval,
  describeReadableInterval,
  formatRetention,
  INTERVAL_UNITS,
  RETENTION_STEP,
  type IntervalDisplay,
  type IntervalUnit,
} from '../src/format.ts';
import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from '../src/types.ts';

/** Fractional digits a caller would actually render for a display value. */
function renderedDecimals(display: IntervalDisplay): number {
  const text = display.value.toFixed(display.decimals);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

// ─── Unit list ─────────────────────────────────────────────────────────────

test('the switcher offers days, hours, minutes in that order', () => {
  assert.deepEqual(INTERVAL_UNITS, ['days', 'hours', 'minutes']);
});

// ─── Magnitude-based decimals ──────────────────────────────────────────────

test('whole amounts show no decimals', () => {
  assert.deepEqual(describeInterval(3, 'days'), {
    value: 3,
    unit: 'days',
    decimals: 0,
  });
  assert.deepEqual(describeInterval(1, 'hours'), {
    value: 24,
    unit: 'hours',
    decimals: 0,
  });
  assert.deepEqual(describeInterval(1, 'minutes'), {
    value: 1440,
    unit: 'minutes',
    decimals: 0,
  });
});

test('fractional amounts below ten keep one decimal', () => {
  assert.deepEqual(describeInterval(1.5, 'days'), {
    value: 1.5,
    unit: 'days',
    decimals: 1,
  });
  assert.deepEqual(describeInterval(0.5, 'days'), {
    value: 0.5,
    unit: 'days',
    decimals: 1,
  });
});

test('a fractional amount keeps its decimal however large it is', () => {
  // This used to drop to no decimals at or above ten, which merged rungs: a
  // ladder of 10, 11, 12, 13 days with interpolated rungs at 10.4 and 11.5
  // rendered as 10, 10, 11, 11, 11, 12, 12, 13 — eight rungs showing four
  // values. A whole amount still shows none.
  assert.deepEqual(describeInterval(10.4, 'days'), {
    value: 10.4,
    unit: 'days',
    decimals: 1,
  });
  assert.deepEqual(describeInterval(365.5, 'days'), {
    value: 365.5,
    unit: 'days',
    decimals: 1,
  });
  assert.deepEqual(describeInterval(11, 'days'), {
    value: 11,
    unit: 'days',
    decimals: 0,
  });
});

// ─── Rounding that never lies about zero ───────────────────────────────────

test('a twenty-minute note never reads as zero hours', () => {
  const display = describeInterval(20 / 1440, 'hours');
  assert.notEqual(display.value, 0);
  assert.equal(display.value, 0.3);
  assert.equal(display.value.toFixed(display.decimals), '0.3');
});

test('a sub-unit interval in days is escalated past zero rather than shown as 0', () => {
  const display = describeInterval(20 / 1440, 'days');
  // 20 minutes is 0.0138… days; one decimal would round it to a bare zero, so
  // a second decimal is added to keep the interval visible.
  assert.equal(display.value, 0.01);
  assert.equal(display.decimals, 2);
  assert.equal(display.value.toFixed(display.decimals), '0.01');
});

test('the escalation repeats until the value is visible', () => {
  // One millisecond out, expressed in days, needs six decimals before it is
  // distinguishable from zero.
  const display = describeInterval(1 / (1440 * 1000), 'days');
  assert.equal(display.value, 0.000001);
  assert.equal(display.decimals, 6);
  assert.ok(display.value > 0);
});

// ─── decimals matches what is rendered ─────────────────────────────────────

test('decimals equals the number of digits actually rendered', () => {
  const samples = [
    [3, 'days'],
    [1.5, 'days'],
    [10.4, 'days'],
    [20 / 1440, 'hours'],
    [20 / 1440, 'days'],
    [0.97, 'minutes'],
    [0.5, 'minutes'],
    [365, 'days'],
  ] as const;

  for (const [days, unit] of samples) {
    const display = describeInterval(days, unit);
    assert.equal(
      renderedDecimals(display),
      display.decimals,
      `${days} ${unit} renders a different precision than it reports`
    );
    assert.equal(display.unit, unit);
    assert.ok(Number.isFinite(display.value));
    assert.ok(!Number.isNaN(display.value));
  }
});

test('every requested unit is echoed back and every positive interval stays positive', () => {
  for (const unit of INTERVAL_UNITS) {
    for (const days of [0.0007, 0.25, 1, 1.5, 30, 365.25]) {
      const display = describeInterval(days, unit);
      assert.equal(display.unit, unit);
      assert.ok(display.value > 0, `${days} ${unit} lost its value`);
      assert.ok(display.value.toFixed(display.decimals).length > 0);
    }
  }
});

// ─── Unusable input degrades, never throws ─────────────────────────────────

test('zero, negative and non-finite intervals render as a plain zero', () => {
  const unusable = [0, -1, -0.5, NaN, Infinity, -Infinity];

  for (const days of unusable) {
    for (const unit of INTERVAL_UNITS) {
      const display = describeInterval(days, unit);
      assert.equal(display.value, 0, `${days} ${unit}`);
      assert.equal(display.unit, unit, 'the requested unit still comes back');
      assert.equal(display.decimals, 0);
      assert.equal(display.value.toFixed(display.decimals), '0');
    }
  }
});

test('describeInterval tolerates a sweep of raw numbers without throwing or leaking NaN', () => {
  const raws = [0, 1e-9, 1e-3, 0.0007, 1 / 1440, 0.5, 1, 7, 30, 1e6];
  for (const unit of INTERVAL_UNITS) {
    for (const days of raws) {
      assert.doesNotThrow(() => describeInterval(days, unit));
      const display = describeInterval(days, unit);
      assert.ok(
        Number.isFinite(display.value),
        `${days} ${unit} produced ${display.value}`
      );
    }
  }
});

// ─── Retention precision ───────────────────────────────────────────────────

test('one step always changes the formatted retention, at every value', () => {
  // The bug this pins: precision used to be banded, so below 0.90 the readout
  // sat on two decimals and a 0.0001 tap left it apparently unchanged. The
  // control looked dead. A readout coarser than the step it reports on is worse
  // than a noisy one, so this is checked across the whole range rather than in
  // the band where it happened to work.
  assert.equal(RETENTION_STEP, 0.0001);

  const starts = [
    REQUEST_RETENTION_MIN,
    0.75,
    0.85,
    0.89,
    0.9,
    0.94,
    0.95,
    0.97,
    REQUEST_RETENTION_MAX,
  ];

  for (const start of starts) {
    assert.notEqual(
      formatRetention(start + RETENTION_STEP),
      formatRetention(start),
      `a step from ${start} must be visible`
    );
  }
});

test('formatRetention trims trailing zeros but never below two decimals', () => {
  // The value decides the precision, so a round number stays readable and a
  // stepped one shows exactly the digits that differ.
  assert.equal(formatRetention(0.85), '0.85');
  assert.equal(formatRetention(0.8501), '0.8501');
  assert.equal(formatRetention(0.9), '0.90');
  assert.equal(formatRetention(0.95), '0.95');
  assert.equal(formatRetention(0.9501), '0.9501');
  assert.equal(formatRetention(0.7), '0.70');
  assert.equal(formatRetention(0.99), '0.99');
});

test('a value carrying float noise is rounded to the step before display', () => {
  // Stepping accumulates binary rounding error; the string must not show it.
  let value = 0.85;
  for (let i = 0; i < 7; i++) value += RETENTION_STEP;
  const text = formatRetention(value);
  assert.equal(text, '0.8507');
  assert.ok(text.length <= 6, `no float tail: ${text}`);
});

test('formatRetention does not emit NaN for a non-finite value', () => {
  assert.equal(formatRetention(NaN), '0.00');
  assert.equal(formatRetention(Infinity), '0.00');
});

// ─── Step round-trip ───────────────────────────────────────────────────────

test('twenty consecutive steps produce twenty distinct strings', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    seen.add(formatRetention(0.85 + i * RETENTION_STEP));
  }
  assert.equal(seen.size, 20);
});

test('stepping up and down changes the output in both directions', () => {
  const value = 0.96;
  const base = formatRetention(value);
  assert.equal(base, '0.96');
  assert.notEqual(formatRetention(value + RETENTION_STEP), base);
  assert.notEqual(formatRetention(value - RETENTION_STEP), base);
});

// ─── Purity: no UI text, no i18n ───────────────────────────────────────────

test('describeInterval output carries numbers and a unit identity only', () => {
  const display = describeInterval(2.5, 'hours');
  assert.deepEqual(Object.keys(display).sort(), ['decimals', 'unit', 'value']);
  assert.equal(typeof display.value, 'number');
  assert.equal(typeof display.decimals, 'number');
  const unit: IntervalUnit = display.unit;
  assert.ok(INTERVAL_UNITS.includes(unit));
});

// ─── Stepping down to a readable unit ───────────────────────────────────────

test('a sub-day interval steps down rather than reading as a fraction of a day', () => {
  // A one-minute rung under a "days" setting would otherwise render as
  // "0.0007 days", which is a number nobody parses — and the whole point of
  // offering a minute-scale rung is that it is readable.
  const oneMinute = 1 / 1440;
  const display = describeReadableInterval(oneMinute, 'days');

  assert.equal(display.unit, 'minutes');
  assert.equal(display.value, 1);
});

test('stepping down stops as soon as the requested unit means something', () => {
  // Twelve hours is legible in hours, so it never reaches minutes; three days
  // is legible in days and is left exactly where it was.
  assert.equal(describeReadableInterval(0.5, 'days').unit, 'hours');
  assert.equal(describeReadableInterval(3, 'days').unit, 'days');
  assert.equal(describeReadableInterval(3, 'days').value, 3);
});

test('stepping down never steps back up', () => {
  // A ladder shown in minutes stays in minutes even when a rung is days long,
  // because that is the scale the reader asked to think in.
  const display = describeReadableInterval(30, 'minutes');
  assert.equal(display.unit, 'minutes');
  assert.equal(display.value, 30 * 1440);
});

test('stepping down leaves unusable input renderable', () => {
  for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
    const display = describeReadableInterval(bad, 'days');
    assert.equal(Number.isFinite(display.value), true);
    assert.equal(display.value, 0);
  }
});
