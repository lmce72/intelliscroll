import { Menu, TFile } from 'obsidian';
import type IntelliScrollPlugin from './main';
import { getAlgorithm } from './algorithms/index.ts';
import { SrsStore } from './srsLog.ts';
import { t } from './i18n.ts';
import type { Rating } from './types.ts';

/**
 * Rating and ignoring, shared by both entry points: a card in the feed and the
 * floating control in a note opened from the feed.
 *
 * The two must behave identically — same ratings, same ignore toggle, same
 * store write — so this lives here rather than on either view. Only the
 * presentation around it differs.
 */

export const RATING_ORDER: readonly Rating[] = ['again', 'hard', 'good', 'easy'];

const RATING_ICONS: Record<Rating, string> = {
  again: 'rotate-ccw',
  hard: 'minus',
  good: 'check',
  easy: 'zap',
};

export function ratingIcon(rating: Rating): string {
  return RATING_ICONS[rating];
}

export function ratingLabel(rating: Rating): string {
  return t(`view.rating.${rating}`);
}

/** Whether the active filter preset ignores this path. */
export function isIgnored(plugin: IntelliScrollPlugin, path: string): boolean {
  const lower = path.toLowerCase();
  return plugin
    .getEffectiveFilter()
    .ignore.values.some((value) => value.toLowerCase() === lower);
}

/**
 * Add or remove a path from the active filter preset's ignore list.
 *
 * Returns the new state. Edits the saved preset rather than a session
 * override, because wanting never to see a note again is worth keeping.
 */
export async function toggleIgnored(
  plugin: IntelliScrollPlugin,
  path: string
): Promise<boolean> {
  const preset = plugin.data.settings.presets.filters.find(
    (candidate) => candidate.id === plugin.data.settings.activeFilterPresetId
  );
  if (!preset) return isIgnored(plugin, path);

  const lower = path.toLowerCase();
  const already = preset.ignore.values.some(
    (value) => value.toLowerCase() === lower
  );
  preset.ignore = {
    mode: preset.ignore.mode,
    values: already
      ? preset.ignore.values.filter((value) => value.toLowerCase() !== lower)
      : [...preset.ignore.values, path],
  };

  await plugin.saveSettingsAndRefreshViews();
  return !already;
}

/**
 * Record a review. Returns false when nothing could be written, so callers can
 * avoid claiming success — an explicit rating against a disabled scheduler
 * would otherwise look like it worked.
 */
export async function applyRating(
  plugin: IntelliScrollPlugin,
  path: string,
  rating: Rating,
  source: 'auto' | 'explicit'
): Promise<boolean> {
  const algorithm = plugin.getEffectiveAlgorithm();
  if (algorithm.algorithm === 'off') return false;

  const store = plugin.srsStore;
  if (!store?.isLoaded) return false;

  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  const content = await plugin.app.vault.cachedRead(file);

  await store.recordReview(
    {
      path,
      rating,
      algorithm: algorithm.algorithm,
      source,
      hash: SrsStore.hashContent(content),
      now: Date.now(),
      tunables: algorithm.fsrsTunables,
    },
    getAlgorithm(algorithm.algorithm)
  );

  return true;
}

export interface RatingMenuOptions {
  plugin: IntelliScrollPlugin;
  event: MouseEvent;
  path: string;
  /** Called only when a rating was actually written. */
  onRated?: (rating: Rating) => void;
}

/** The rating menu, identical wherever it is opened from. */
export function showRatingMenu(options: RatingMenuOptions): void {
  const { plugin, event, path, onRated } = options;
  const menu = new Menu();

  menu.addItem((item) => item.setTitle(t('view.menu.rating')).setIsLabel(true));
  for (const rating of RATING_ORDER) {
    menu.addItem((item) =>
      item
        .setTitle(ratingLabel(rating))
        .setIcon(RATING_ICONS[rating])
        .onClick(() => {
          void (async () => {
            if (await applyRating(plugin, path, rating, 'explicit')) {
              onRated?.(rating);
            }
          })();
        })
    );
  }

  menu.showAtMouseEvent(event);
}

/**
 * The icon an ignore button should show for the current state.
 *
 * Ignoring is a two-state toggle rather than a set of choices, so it gets its
 * own button instead of a menu — one click instead of two, and the icon says
 * which way it will go.
 */
export function ignoreIcon(ignored: boolean): string {
  return ignored ? 'rotate-ccw' : 'eye-off';
}

export function ignoreLabel(ignored: boolean): string {
  return ignored ? t('view.menu.unignore') : t('view.menu.ignore');
}
