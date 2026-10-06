import { t } from './i18n.ts';
import { describeReadableInterval, type IntervalUnit } from './format.ts';
import type { Tier } from './tiers.ts';

/**
 * How a rung of the rating ladder is worded.
 *
 * Its own module rather than a corner of `rating.ts` because that file imports
 * `obsidian` for its menus, and anything it exports is therefore unreachable
 * from the test runner. The rule this holds — that a pressable rung states what
 * a press would commit — is exactly the kind of thing that should be pinned by
 * a test, so it lives where a test can load it.
 */

const SINGULAR_UNIT_KEY: Record<IntervalUnit, string> = {
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
};


/** One interval, worded, with its unit agreeing in number. */
function renderInterval(days: number, unit: IntervalUnit): string {
  const display = describeReadableInterval(days, unit);
  const singular = display.decimals === 0 && display.value === 1;
  const key = singular ? SINGULAR_UNIT_KEY[display.unit] : display.unit;
  return t(`tuning.interval.${key}`, {
    value: display.value.toFixed(display.decimals),
  });
}

/**
 * A tier's interval: what the model computed, and what a press would commit
 * when the two disagree.
 *
 * FSRS rounds each grade to whole days and then pushes it at least a day past
 * the previous one, so the committed rungs are not the model's numbers. Both
 * matter and neither alone is honest:
 *
 * - The committed one alone makes the retention control look broken. Sweeping
 *   it from 0.90 to 0.99 moves this card's model interval from 2.3 days to 3.8
 *   hours while every committed value stays on 1/2/3/4 — the knob visibly does
 *   nothing.
 * - The model value alone misleads the other way, and badly: at 0.99 this row
 *   would read "3.8 hours" while pressing it schedules two days.
 *
 * So the model's value leads — it is what moves, and what makes three grades
 * that the model cannot tell apart read as three equal numbers instead of a
 * fabricated staircase — and the commitment is stated whenever it differs.
 * When they agree, which is what a settled note usually shows, there is only
 * one number and nothing extra to read.
 */
export function formatTierInterval(tier: Tier, unit: IntervalUnit): string {
  const model = renderInterval(tier.modelDays, unit);
  // Only an anchor can be pressed, so only an anchor has a commitment to
  // state. An interpolated rung is a preview mark; saying it "schedules"
  // anything would invent a press that does not exist.
  if (!tier.anchor) return model;

  const committed = renderInterval(tier.intervalDays, unit);
  if (committed === model) return model;
  return t('tuning.interval.committed', { model, committed });
}
