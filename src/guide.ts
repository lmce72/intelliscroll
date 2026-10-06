import { getLanguage } from './i18n.ts';
import { sections as en } from './guide/en.ts';
import { sections as zh } from './guide/zh.ts';

/**
 * The algorithm guide, and the shape it is written in.
 *
 * A plugin that schedules your notes on a forgetting curve is asking to be
 * trusted with something you cannot check by looking at it, and "trust me" is
 * not an answer. This is the explanation that is owed instead: what the model
 * is, what a press actually does, which of the numbers on screen are the
 * model's and which are the scheduler rounding, and where the whole thing
 * stops being informative.
 *
 * Written as structured blocks rather than a string of Markdown. The plugin
 * renders DOM with `createEl` and never `innerHTML`, so shipping prose as
 * Markdown would mean either a parser in the bundle or a hole in the rule that
 * exists to keep XSS out. Blocks are also what let the measured tables be real
 * tables instead of preformatted text.
 *
 * Every number in here was measured against the shipped `ts-fsrs` and is
 * reproduced in `test/guide.test.ts`, so the guide cannot quietly drift from
 * the behaviour it describes.
 */
export type GuideBlock =
  /** A paragraph. */
  | { kind: 'p'; text: string }
  /** A subsection heading. */
  | { kind: 'h'; text: string }
  /** A bulleted list. */
  | { kind: 'ul'; items: readonly string[] }
  /** A numbered list, for sequences where order carries meaning. */
  | { kind: 'ol'; items: readonly string[] }
  /** Fixed-width block: formulas, measured ladders, source excerpts. */
  | { kind: 'code'; text: string }
  /** A table with a header row. */
  | { kind: 'table'; head: readonly string[]; rows: readonly (readonly string[])[] }
  /** A callout: the thing worth remembering if nothing else is. */
  | { kind: 'note'; text: string }
  /** A worked example, set apart from the prose around it. */
  | { kind: 'example'; title: string; blocks: readonly GuideBlock[] };

export interface GuideSection {
  /** Stable anchor, also the DOM id. */
  id: string;
  title: string;
  blocks: readonly GuideBlock[];
}

const SECTIONS: Record<'en' | 'zh', readonly GuideSection[]> = { en, zh };

/** The guide in the plugin's current language. */
export function guideSections(): readonly GuideSection[] {
  return SECTIONS[getLanguage()] ?? en;
}
