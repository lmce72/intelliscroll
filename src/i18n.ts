/**
 * In-plugin localisation.
 *
 * Messages live in TypeScript modules rather than external files on purpose:
 * a plugin bundle is a single `main.js`, and this must work on mobile, where
 * there is no filesystem to load a locale from. It also means a missing key is
 * a type error rather than an empty string at runtime.
 *
 * Messages are split into one module per feature area (`messages.*.ts`) which
 * are merged here. That keeps each area's strings together and means adding a
 * language never requires editing a single growing file — the areas can be
 * translated independently.
 */

import { messages as guideMessages } from './i18n/messages.guide.ts';
import { messages as presetMessages } from './i18n/messages.presets.ts';
import { messages as settingsMessages } from './i18n/messages.settings.ts';
import { messages as tuningMessages } from './i18n/messages.tuning.ts';
import { messages as viewMessages } from './i18n/messages.view.ts';

import { LANGUAGES, isLanguage, type Language } from './types.ts';

export { LANGUAGES, isLanguage };
export type { Language };

/** The languages that actually have a message table. */
export const CONCRETE_LANGUAGES = ['en', 'zh'] as const;
export type ConcreteLanguage = (typeof CONCRETE_LANGUAGES)[number];

/** A flat dictionary: dotted key to message, with `{name}` placeholders. */
export type MessageTable = Record<string, string>;

export interface MessageModule {
  en: MessageTable;
  zh: MessageTable;
}

/** Every message module, merged. Later modules may not shadow earlier keys. */
const MODULES: readonly MessageModule[] = [
  settingsMessages,
  presetMessages,
  viewMessages,
  tuningMessages,
  guideMessages,
];

const en: MessageTable = {};
const zh: MessageTable = {};

for (const module of MODULES) {
  for (const [key, value] of Object.entries(module.en)) {
    if (key in en) {
      // A silent overwrite here would mean one area's wording quietly replaces
      // another's, which is very hard to notice and very confusing to debug.
      console.error(`[intelliscroll/i18n] duplicate message key: ${key}`);
    }
    en[key] = value;
  }
  for (const [key, value] of Object.entries(module.zh)) {
    zh[key] = value;
  }
}

let current: ConcreteLanguage = 'en';

/**
 * Read Obsidian's own language.
 *
 * Obsidian records it in `localStorage`; `moment` is its i18n backbone and is
 * always present. Both are probed because neither is a documented API.
 */
export function detectAppLanguage(): ConcreteLanguage {
  try {
    const stored = window.localStorage.getItem('language') ?? '';
    const lowered = stored.toLowerCase();
    if (lowered.startsWith('zh')) return 'zh';
    if (lowered.startsWith('en')) return 'en';

    const momentLocale = (window as unknown as { moment?: { locale?: () => string } })
      .moment?.locale?.();
    if (typeof momentLocale === 'string' && momentLocale.toLowerCase().startsWith('zh')) {
      return 'zh';
    }
  } catch (error) {
    // Falling back to English is the right degradation; a missing locale must
    // never stop the plugin loading.
    console.warn('[intelliscroll/i18n] could not detect app language', error);
  }
  return 'en';
}

export function resolveLanguage(language: Language): ConcreteLanguage {
  if (language === 'auto') return detectAppLanguage();
  return language;
}

/** Point the translator at a language. Called whenever the setting changes. */
export function setLanguage(language: Language): ConcreteLanguage {
  current = resolveLanguage(language);
  return current;
}

export function getLanguage(): ConcreteLanguage {
  return current;
}

/**
 * Look up a message.
 *
 * An unknown key returns the key itself rather than an empty string: a visible
 * `settings.batchSize` in the UI is an obvious bug report, whereas a blank
 * label just looks like a rendering glitch.
 */
export function t(
  key: string,
  vars?: Readonly<Record<string, string | number>>
): string {
  const table = current === 'zh' ? zh : en;
  const template = table[key] ?? en[key] ?? key;
  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Whether a key exists, for tests and for spotting untranslated strings. */
export function hasMessage(key: string, language: ConcreteLanguage): boolean {
  return (language === 'zh' ? zh : en)[key] !== undefined;
}

export function messageKeys(): string[] {
  return Object.keys(en);
}
