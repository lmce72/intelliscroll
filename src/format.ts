/**
 * Display arithmetic for intervals and retention values.
 *
 * Deliberately free of UI text and of the i18n table: this module returns
 * numbers plus a unit identity and the caller looks up the wording. That keeps
 * the rounding rules pure and testable without a locale, and means adding a
 * language never touches arithmetic.
 */


export type IntervalUnit = 'days' | 'hours' | 'minutes';

/** Offered in the UI, in the order the switcher should list them. */
export const INTERVAL_UNITS: readonly IntervalUnit[] = [
  'days',
  'hours',
  'minutes',
];

/** How many of `unit` fit in one day. */
const UNITS_PER_DAY: Record<IntervalUnit, number> = {
  days: 1,
  hours: 24,
  minutes: 1440,
};

/**
 * The units from largest to smallest, which is the order a value is stepped
 * down through when it does not fit the requested one.
 */
const UNITS_PER_DAY_ORDER: readonly IntervalUnit[] = ['days', 'hours', 'minutes'];

export interface IntervalDisplay {
  /** Already rounded to `decimals`. */
  value: number;
  unit: IntervalUnit;
  decimals: number;
}

/**
 * Ceiling on the zero-avoidance escalation below.
 *
 * One second is about 1.2e-5 days, which the escalation resolves in five
 * steps; six leaves headroom while keeping an absurd input from driving
 * `toFixed` past its 0-100 argument range.
 */
const MAX_ESCALATED_DECIMALS = 6;

/** Round `value` to `decimals` places, half away from zero. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Digits to show for a converted amount, chosen from its magnitude.
 *
 * A whole amount shows none (a note returning in "3 days" must not read
 * "3.0 days"); a fractional amount below ten shows one, because the gap
 * between 1.5 and 1.8 days is worth seeing; anything at or above ten rounds to
 * a whole number, where a decimal is noise. The rule is applied to the raw
 * converted amount, before rounding.
 */
function baseDecimals(amount: number): number {
  if (Number.isInteger(amount)) return 0;
  return amount < 10 ? 1 : 0;
}

/**
 * Describe an interval for display in the requested unit.
 *
 * Never returns NaN, and never rounds a real interval down to a bare `0`: near
 * the bottom of the scheduling ladder the sub-day choices sit close together,
 * and "0 hours" for a note due in twenty minutes would erase the very
 * difference this display exists to show. Unusable input — non-finite, NaN,
 * negative or zero — degrades to a renderable zero rather than throwing,
 * because this runs against a live-refreshing preview and a mid-drag glitch
 * must not break the panel.
 */
export function describeInterval(
  intervalDays: number,
  unit: IntervalUnit
): IntervalDisplay {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    return { value: 0, unit, decimals: 0 };
  }

  const amount = intervalDays * UNITS_PER_DAY[unit];
  let decimals = baseDecimals(amount);
  let value = roundTo(amount, decimals);

  // A positive amount that rounds to zero at the chosen precision is shown one
  // digit finer, repeating until it is visible (bounded by the ceiling above).
  while (value === 0 && decimals < MAX_ESCALATED_DECIMALS) {
    decimals += 1;
    value = roundTo(amount, decimals);
  }

  return { value, unit, decimals };
}

/**
 * Describe an interval in `unit`, stepping down to a smaller unit when the
 * value would not be readable in the one asked for.
 *
 * The unit is a setting, and a setting cannot be right at both ends of a ladder
 * that spans a minute and a month: with days selected, a one-minute rung reads
 * as "0.0007 days", which is a number nobody parses. Stepping down only when
 * the requested unit would give a value below one keeps the reader's choice
 * wherever it still means something and rescues it where it does not — and it
 * never steps *up*, so a ladder shown in minutes stays in minutes.
 */
export function describeReadableInterval(
  intervalDays: number,
  unit: IntervalUnit
): IntervalDisplay {
  let index = UNITS_PER_DAY_ORDER.indexOf(unit);
  if (index < 0) index = 0;

  let display = describeInterval(intervalDays, UNITS_PER_DAY_ORDER[index]!);

  while (display.value < 1 && index < UNITS_PER_DAY_ORDER.length - 1) {
    index += 1;
    display = describeInterval(intervalDays, UNITS_PER_DAY_ORDER[index]!);
  }

  return display;
}

/** Smallest nudge the interval-tuning controls apply to retention. */
export const RETENTION_STEP = 0.0001;

// The interval responds steeply to retention as it approaches 1: in the top of
// the allowed range a single RETENTION_STEP moves the scheduled interval by far
// more than it does lower down. Two decimals cannot express those steps — they
// all collapse onto the same string — so precision is raised near the ceiling
// rather than everywhere.
//
/**
 * Decimal places a retention value is rounded to before display.
 *
 * Exactly one step's worth: more would be noise, and fewer would hide the step.
 */
const RETENTION_PRECISION = 4;

/** Fewest decimals shown, so `0.9` still reads as a retention rather than a count. */
const RETENTION_MIN_DECIMALS = 2;

/**
 * Format a retention value so that a single step is always visible.
 *
 * The rule this replaces raised precision only near the top of the range, on
 * the theory that fine detail mattered only where the interval moved a lot.
 * What it actually produced was a control that looked broken: at 0.85 the
 * readout sat on two decimals, so a 0.0001 tap left the number apparently
 * unchanged and the only evidence anything had happened was the intervals
 * shifting. A readout coarser than the step it is reporting on is worse than a
 * noisy one.
 *
 * Precision is now driven by the value instead: rounded to the step, trailing
 * zeros trimmed, never below two decimals. `0.85` still reads "0.85", and the
 * instant it is stepped it reads "0.8501" — so the string changes on every tap
 * and stops changing when it stops being true.
 */
export function formatRetention(value: number): string {
  // The control can momentarily hold a non-finite value mid-drag; render a
  // clean zero rather than the string "NaN".
  const safe = Number.isFinite(value) ? value : 0;

  const trimmed = roundTo(safe, RETENTION_PRECISION)
    .toFixed(RETENTION_PRECISION)
    .replace(/0+$/, '')
    .replace(/\.$/, '');

  const [whole = '0', fraction = ''] = trimmed.split('.');
  return `${whole}.${fraction.padEnd(RETENTION_MIN_DECIMALS, '0')}`;
}
