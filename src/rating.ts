import { Menu, TFile } from 'obsidian';
import type IntelliScrollPlugin from './main';
import { getAlgorithm } from './algorithms/index.ts';
import { SrsStore } from './srsLog.ts';
import { t } from './i18n.ts';
import { setIcon } from 'obsidian';
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

/**
 * The colour each rating paints the button, following what the rating means:
 * forgetting is the failure case, difficulty is a warning, success is normal,
 * and triviality is the easy path.
 */
const RATING_CLASS: Record<Rating, string> = {
  again: 'intelliscroll-rated-again',
  hard: 'intelliscroll-rated-hard',
  good: 'intelliscroll-rated-good',
  easy: 'intelliscroll-rated-easy',
};

/**
 * Paint a rating button for its current state.
 *
 * Shared so the card and the floating control cannot drift apart in either
 * their icon, their colour or their label.
 */
export function paintRatingButton(
  plugin: IntelliScrollPlugin,
  button: HTMLElement,
  path: string,
  title: string
): void {
  const rating = plugin.lastRatingFor(path);
  setIcon(button, rating === null ? 'gauge' : ratingIcon(rating));
  for (const cls of Object.values(RATING_CLASS)) button.toggleClass(cls, false);
  if (rating !== null) button.addClass(RATING_CLASS[rating]);
  // Recorded so stylesheets can distinguish an unrated button from a rated one
  // without depending on which view the button belongs to.
  if (rating === null) delete button.dataset.rating;
  else button.dataset.rating = rating;

  const label =
    rating === null
      ? t('view.action.rate', { title })
      : t('view.action.rated', { rating: ratingLabel(rating) });
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
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

  // Both entry points must reflect this, including the one that did not ask.
  plugin.notifyRatingWritten(path, rating);
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
