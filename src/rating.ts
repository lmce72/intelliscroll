import { Menu, TFile } from 'obsidian';
import type IntelliScrollPlugin from './main';
import { getAlgorithm } from './algorithms/index.ts';
import { SrsStore, logSrsError } from './srsLog.ts';
import { t } from './i18n.ts';
import { setIcon } from 'obsidian';
import {
  normalizeTierCount,
  REQUEST_RETENTION_MAX,
  REQUEST_RETENTION_MIN,
  type Rating,
} from './types.ts';
import { expandTiers, type Tier } from './tiers.ts';
import {
  RETENTION_STEP,
  describeReadableInterval,
  type IntervalUnit,
} from './format.ts';
import {
  isTapGesture,
  openTierPopover,
  type TierPopoverRating,
} from './ratingPopover.ts';

/**
 * Rating and ignoring, shared by both entry points: a card in the feed and the
 * floating control in a note opened from the feed.
 *
 * The two must behave identically — same ratings, same ignore toggle, same
 * store write — so this lives here rather than on either view. Only the
 * presentation around it differs.
 */

export const RATING_ORDER: readonly Rating[] = ['again', 'hard', 'good', 'easy'];

/**
 * Rungs the rating popover shows when the caller does not say.
 *
 * The live count is the display preset's `tierCount`; this is only the fallback
 * for a caller that has none. It is deliberately not baked into `tiersFor` —
 * an earlier version hardcoded 8 here, which meant the setting did nothing and
 * the popover disagreed with the settings page.
 */
export const DEFAULT_TIER_COUNT = 8;

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

/** The colour class a rating paints itself with. Shared with inline choices. */
export function ratingColorClass(rating: Rating): string {
  return RATING_CLASS[rating];
}

const SINGULAR_UNIT_KEY: Record<IntervalUnit, string> = {
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
};

/**
 * A tier's interval, worded for display in the requested unit.
 *
 * The unit comes from the display preset rather than being picked per interval.
 * Choosing it per interval reads better in isolation but produces a ladder that
 * mixes "3 days" with "20 minutes" in one column, and the point of offering the
 * switch at all is that the reader decides which scale they are thinking in.
 * `describeInterval` is what keeps a sub-unit value from rendering as "0".
 */
export function formatTierInterval(tier: Tier, unit: IntervalUnit): string {
  const display = describeReadableInterval(tier.intervalDays, unit);
  const singular = display.decimals === 0 && display.value === 1;
  const key = singular ? SINGULAR_UNIT_KEY[display.unit] : display.unit;
  return t(`tuning.interval.${key}`, {
    value: display.value.toFixed(display.decimals),
  });
}

/** One thing the ignore menu can offer. */
export interface IgnoreTarget {
  /** What goes into the ignore list. A trailing slash marks a directory. */
  value: string;
  /** Folder depth below the vault root. */
  level: number;
  kind: 'note' | 'folder';
}

/**
 * The ignore menu's entries for a note: the note itself, then each folder from
 * the note's own folder upwards.
 *
 * Stops *below* the vault root. Ignoring the root would exclude the entire
 * vault, and that should not be one click away in a menu opened next to a path.
 * A note sitting at the root therefore offers only itself.
 */
export function ignoreTargets(path: string): IgnoreTarget[] {
  const targets: IgnoreTarget[] = [{ value: path, level: 0, kind: 'note' }];

  const segments = path.split('/');
  segments.pop(); // drop the filename

  for (let depth = segments.length; depth >= 1; depth--) {
    const folder = segments.slice(0, depth).join('/');
    targets.push({ value: `${folder}/`, level: depth, kind: 'folder' });
  }

  return targets;
}

/** Add or remove one exact value from the active filter preset's ignore list. */
export async function toggleIgnoreValue(
  plugin: IntelliScrollPlugin,
  value: string
): Promise<boolean> {
  const preset = plugin.data.settings.presets.filters.find(
    (candidate) => candidate.id === plugin.data.settings.activeFilterPresetId
  );
  if (!preset) return false;

  const already = preset.ignore.values.includes(value);
  preset.ignore = {
    mode: preset.ignore.mode,
    values: already
      ? preset.ignore.values.filter((entry) => entry !== value)
      : [...preset.ignore.values, value],
  };

  await plugin.saveSettingsAndRefreshViews();
  return !already;
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
  return toggleIgnoreValue(plugin, path);
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

/**
 * The tiers a rating would schedule, from the note's current state.
 *
 * The ladder is built here rather than at the call sites so a card and the
 * floating control cannot preview different numbers. An `off` algorithm has no
 * ladder at all, which is returned as an empty list rather than a fabricated
 * one: a shuffled feed genuinely has no schedule to preview.
 */
function tiersFor(
  plugin: IntelliScrollPlugin,
  path: string,
  retention?: number
): Tier[] {
  const preset = plugin.getEffectiveAlgorithm();
  if (preset.algorithm === 'off') return [];

  const tierCount = normalizeTierCount(
    plugin.getEffectiveDisplay().tierCount ?? DEFAULT_TIER_COUNT
  );

  const state = plugin.srsStore?.getState(path) ?? null;
  const fsrs =
    retention === undefined
      ? preset.fsrsTunables
      : { ...preset.fsrsTunables, requestRetention: retention };

  const steps = getAlgorithm(preset.algorithm).ladder(state, {
    now: Date.now(),
    // The preview resolves no content, so the stored hash is as good as any;
    // it exists only so the context matches what a real review would carry.
    hash: state?.hash ?? '',
    fsrs,
  });

  return expandTiers(steps, tierCount);
}

/**
 * Where the popover attaches.
 *
 * A click from a button carries that button as `currentTarget`; anything else
 * (a keyboard activation, a programmatic call) gets a zero-size stand-in at the
 * click point so the popover still lands under the pointer. The stand-in is
 * removed when the popover closes.
 */
function anchorForEvent(event: MouseEvent): {
  element: HTMLElement;
  cleanup: () => void;
} {
  const target: EventTarget | null = event.currentTarget;
  if (target instanceof HTMLElement) {
    return { element: target, cleanup: () => undefined };
  }

  const doc = event.view?.document ?? activeDocument;
  const element = doc.body.createDiv({
    cls: 'intelliscroll-popover-anchor',
  });
  element.style.position = 'fixed';
  element.style.left = `${event.clientX}px`;
  element.style.top = `${event.clientY}px`;
  element.style.width = '0';
  element.style.height = '0';
  return { element, cleanup: () => element.remove() };
}

/** The rating popover, identical wherever it is opened from. */
export function showRatingMenu(options: RatingMenuOptions): void {
  const { plugin, event, path, onRated } = options;

  // A click that was really a swipe, or the tail of a long hold, must not open
  // a menu — on a tablet that is how one appears under a moving finger.
  if (!isTapGesture(event)) return;

  const preset = plugin.getEffectiveAlgorithm();
  // Every interval in this menu is read out in one unit, chosen by the display
  // preset, so the ladder does not mix scales down a single column.
  const intervalUnit = plugin.getEffectiveDisplay().intervalUnit;
  const anchor = anchorForEvent(event);

  let tiers: Tier[] = [];
  try {
    tiers = tiersFor(plugin, path);
  } catch (error) {
    // A ladder that cannot be built must not stop the ratings from being
    // offered; they simply appear without an interval, as for `off`.
    logSrsError('rating ladder unavailable', error);
  }

  const commit = (rating: Rating): void => {
    void (async () => {
      try {
        if (await applyRating(plugin, path, rating, 'explicit')) {
          onRated?.(rating);
        }
      } catch (error) {
        logSrsError('failed to record a rating', error);
      }
    })();
  };

  // When there is no ladder the ratings are still offered, just without an
  // interval beside them.
  const ratings: TierPopoverRating[] =
    tiers.length === 0
      ? RATING_ORDER.map((rating) => ({
          key: rating,
          label: ratingLabel(rating),
          icon: RATING_ICONS[rating],
          onPick: () => commit(rating),
        }))
      : [];

  // Retention is an FSRS parameter; for the other algorithms the adjuster would
  // move a number nothing reads, so it is not offered.
  const retention =
    preset.algorithm === 'fsrs'
      ? {
          value: preset.fsrsTunables.requestRetention,
          min: REQUEST_RETENTION_MIN,
          max: REQUEST_RETENTION_MAX,
          step: RETENTION_STEP,
          preview: (value: number) => {
            // This runs on a live drag, so a throw must not leave the panel
            // mid-refresh: the last good ladder is kept and the failure logged.
            try {
              return tiersFor(plugin, path, value);
            } catch (error) {
              logSrsError('rating preview failed', error);
              return tiers;
            }
          },
          onChange: (value: number) => {
            // A temporary, session-scoped tweak, matching how the feed's tune
            // controls behave; nothing is written to disk until saved.
            plugin.applySessionAlgorithm({
              fsrsTunables: {
                ...preset.fsrsTunables,
                requestRetention: value,
              },
            });
          },
        }
      : undefined;

  openTierPopover({
    anchor: anchor.element,
    tiers,
    formatInterval: (tier) => formatTierInterval(tier, intervalUnit),
    labelTier: (tier) =>
      tier.rating !== undefined
        ? ratingLabel(tier.rating)
        : t('tuning.tier.interpolated', { tier: tier.tier }),
    iconTier: (tier) =>
      tier.rating !== undefined ? RATING_ICONS[tier.rating] : 'circle',
    renderIcon: (element, icon) => setIcon(element, icon),
    onPick: (tier) => {
      if (tier.rating !== undefined) commit(tier.rating);
    },
    ratings,
    retention,
    title: t('view.menu.rating'),
    adjusterLabel: t('tuning.retention.label'),
    decreaseLabel: t('tuning.retention.decrease'),
    increaseLabel: t('tuning.retention.increase'),
    closeLabel: t('tuning.close'),
    onClose: anchor.cleanup,
  });
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

/** The icons the ignore menu uses: a note hidden, a folder hidden. */
function ignoreTargetIcon(target: IgnoreTarget, ignored: boolean): string {
  if (ignored) return 'rotate-ccw';
  return target.kind === 'note' ? 'eye-off' : 'folder-minus';
}

/**
 * The ignore menu for a note: it, then each folder above it.
 *
 * Folders are listed with their path and depth so it is unambiguous which one
 * a click will exclude — an entry reading only a folder's own name would be
 * useless when several folders share it.
 */
export function showIgnoreMenu(options: {
  plugin: IntelliScrollPlugin;
  event: MouseEvent;
  path: string;
  onChanged?: () => void;
}): void {
  const { plugin, event, path, onChanged } = options;
  const preset = plugin.data.settings.presets.filters.find(
    (candidate) => candidate.id === plugin.data.settings.activeFilterPresetId
  );

  const menu = new Menu();
  menu.addItem((item) => item.setTitle(t('view.ignore.section')).setIsLabel(true));

  for (const target of ignoreTargets(path)) {
    const ignored = preset?.ignore.values.includes(target.value) ?? false;
    const title =
      target.kind === 'note'
        ? ignored
          ? t('view.menu.unignore')
          : t('view.menu.ignore')
        : t(ignored ? 'view.ignore.removeFolder' : 'view.ignore.addFolder', {
            path: target.value.replace(/\/+$/, ''),
            level: target.level,
          });

    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(ignoreTargetIcon(target, ignored))
        .onClick(() => {
          void (async () => {
            await toggleIgnoreValue(plugin, target.value);
            onChanged?.();
          })();
        })
    );
  }

  menu.showAtMouseEvent(event);
}
