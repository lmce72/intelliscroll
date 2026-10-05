import { MarkdownView, setIcon } from 'obsidian';
import type DoomscrollPlugin from './main';
import { isIgnored, ratingIcon, showRatingMenu } from './rating.ts';
import { t } from './i18n.ts';

const FLOAT_CLASS = 'doomscroll-note-float';
const BADGE_CLASS = 'doomscroll-note-float-badge';
const RATE_CLASS = 'doomscroll-note-float-rate';

/**
 * A floating marker that appears in a note opened from the feed.
 *
 * It shows two things: that this note came from the feed, and a way to rate it
 * without going back. That matters because a rating is only meaningful *after*
 * reading — at the moment the card is clicked you have not read anything yet,
 * so the feed's own rating button is the wrong moment to ask. The association
 * therefore lasts for the session rather than for the instant of opening.
 *
 * Mounted into the note view's own container rather than the workspace root so
 * it moves with the pane and disappears with it. DOM is built exclusively
 * through Obsidian's `createEl`/`setIcon`.
 */
export class NoteOverlay {
  constructor(private readonly plugin: DoomscrollPlugin) {}

  /**
   * Bring every note pane in line with the current set of feed-opened notes.
   *
   * Sweeps all panes rather than tracking the active one: an overlay belongs to
   * the pane showing that note, so managing only the active pane would strip it
   * from the note you just navigated away from. Idempotent, so it is safe to
   * call on every pane change.
   */
  refresh(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const path = view.file?.path ?? null;
      const existing = view.contentEl.querySelector(`.${FLOAT_CLASS}`);
      const wanted =
        path !== null && this.plugin.wasOpenedFromFeed(path);

      if (wanted && existing === null && path !== null) {
        this.mount(view, path);
      } else if (!wanted && existing !== null) {
        existing.remove();
      }
    }
  }

  destroy(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.contentEl.querySelector(`.${FLOAT_CLASS}`)?.remove();
      }
    }
  }

  private mount(view: MarkdownView, path: string): void {
    const container = view.contentEl.createDiv({ cls: FLOAT_CLASS });

    // The badge is the marker itself: the same icon the ribbon uses, so its
    // meaning is already familiar from the feed's entry point.
    const badge = container.createSpan({ cls: BADGE_CLASS });
    setIcon(badge, 'gallery-vertical');
    badge.setAttribute('aria-label', t('view.float.marker'));
    badge.setAttribute('title', t('view.float.marker'));

    const button = container.createEl('button', {
      cls: `clickable-icon ${RATE_CLASS}`,
    });
    setIcon(button, 'gauge');

    const label = t('view.float.rate', {
      title: view.file?.basename ?? path,
    });
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      showRatingMenu({
        plugin: this.plugin,
        event,
        path,
        onRated: (rating) => {
          // Reflect the choice on the button, matching the card's behaviour.
          setIcon(button, ratingIcon(rating));
          const label = t('view.action.rated', { rating: t(`view.rating.${rating}`) });
          button.setAttribute('aria-label', label);
          button.setAttribute('title', label);
        },
      });
    });

    // An ignored note is no longer part of the feed, so claiming it came from
    // there would be stale. The class lets the badge say so.
    container.toggleClass('is-ignored', isIgnored(this.plugin, path));
  }
}
