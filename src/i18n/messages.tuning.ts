import type { MessageModule } from '../i18n.ts';

/**
 * Messages for the rating popover and the interval it previews
 * (`src/ratingPopover.ts`, `src/rating.ts`).
 *
 * Key convention: `<area>.<feature>.<field>`. Interval wording lives here
 * because `src/format.ts` is deliberately free of a locale: it returns a number
 * plus a unit identity, and these strings are how that identity is spoken.
 *
 * Singular and plural are separate keys rather than a `{count}` rule because
 * the two languages disagree about where it matters — Chinese does not inflect
 * at all, English does — and the caller picks the key from the rendered number.
 */
export const messages: MessageModule = {
  en: {
    'tuning.tier.interpolated': 'Tier {tier}',
    'tuning.retention.label': 'Desired retention',
    'tuning.retention.decrease': 'Decrease retention',
    'tuning.retention.increase': 'Increase retention',
    'tuning.close': 'Close',
    'tuning.prompt.ratings': 'Rate this note',

    'tuning.interval.day': '{value} day',
    'tuning.interval.days': '{value} days',
    'tuning.interval.hour': '{value} hour',
    'tuning.interval.hours': '{value} hours',
    'tuning.interval.minute': '{value} minute',
    'tuning.interval.minutes': '{value} minutes',
    // Shown only when the model's interval and the interval a press would
    // commit round differently, so neither number is passed off as the other.
    'tuning.interval.committed': '{model} (schedules {committed})',
    // Shown above the ladder when the numbers alone would mislead.
    'tuning.notice.capped':
      '{grades} are pinned at the maximum interval, so they schedule the same. Raise the cap to separate them.',
    'tuning.notice.tied':
      'FSRS gives {grades} one interval: this note was reviewed too recently for the model to tell them apart.',
  },
  zh: {
    'tuning.tier.interpolated': '第 {tier} 档',
    'tuning.retention.label': '目标留存率',
    'tuning.retention.decrease': '降低留存率',
    'tuning.retention.increase': '提高留存率',
    'tuning.close': '关闭',
    'tuning.prompt.ratings': '给这篇笔记评分',

    'tuning.interval.day': '{value} 天',
    'tuning.interval.days': '{value} 天',
    'tuning.interval.hour': '{value} 小时',
    'tuning.interval.hours': '{value} 小时',
    'tuning.interval.minute': '{value} 分钟',
    'tuning.interval.minutes': '{value} 分钟',
    'tuning.interval.committed': '{model}（实际提交 {committed}）',
    'tuning.notice.capped':
      '{grades} 被最大间隔上限压在同一天，排程结果相同。调高上限即可分开。',
    'tuning.notice.tied':
      'FSRS 给 {grades} 的是同一个间隔：这篇笔记复习得太近，模型无从区分它们。',
  },
};
