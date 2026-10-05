import { MarkdownView, setIcon } from 'obsidian';
import type IntelliScrollPlugin from './main';
import {
  ignoreIcon,
  ignoreLabel,
  isIgnored,
  paintRatingButton,
  showRatingMenu,
  toggleIgnored,
} from './rating.ts';

const FLOAT_CLASS = 'intelliscroll-note-float';
const RATE_CLASS = 'intelliscroll-note-float-rate';
const IGNORE_CLASS = 'intelliscroll-note-float-ignore';

/**
 * A floating control for a note opened from the feed.
 *
 * It carries two buttons and no badge: the control's presence in the pane is
 * itself the statement that the note came from the feed, so a separate marker
 * icon beside two already-labelled buttons was noise. The buttons are coloured
 * — primary for rating, warning for ignoring — which is also what makes the
 * control read as belonging to this plugin at a glance.
 *
 * That matters because a rating is only meaningful *after* reading: at the
 * moment the card is clicked you have read nothing. The association therefore
 * lasts for the session rather than for the instant of opening.
 *
 * Mounted into the note view's own container rather than the workspace root so
 * it moves with the pane and disappears with it. DOM is built exclusively
 * through Obsidian's `createEl`/`setIcon`.
 */
export class NoteOverlay {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly plugin: IntelliScrollPlugin) {
    // A rating can also be given from the feed card, so repaint on every write
    // rather than only on this control's own menu.
    this.unsubscribe = plugin.onRatingWritten(() => this.repaint());
  }

  /** Repaint every mounted control from the plugin's remembered state. */
  private repaint(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const path = view.file?.path ?? null;
      const button = view.contentEl.querySelector<HTMLElement>(`.${RATE_CLASS}`);
      if (!path || !button) continue;
      paintRatingButton(this.plugin, button, path, view.file?.basename ?? path);
    }
  }

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
      const wanted = path !== null && this.plugin.wasOpenedFromFeed(path);

      if (wanted && existing === null && path !== null) {
        this.mount(view, path);
      } else if (!wanted && existing !== null) {
        existing.remove();
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.contentEl.querySelector(`.${FLOAT_CLASS}`)?.remove();
      }
    }
  }

  private mount(view: MarkdownView, path: string): void {
    const container = view.contentEl.createDiv({ cls: FLOAT_CLASS });
    const title = view.file?.basename ?? path;

    const ignoreButton = container.createEl('button', {
      cls: `mod-warning ${IGNORE_CLASS}`,
    });
    const paintIgnore = (ignored: boolean): void => {
      setIcon(ignoreButton, ignoreIcon(ignored));
      const label = ignoreLabel(ignored);
      ignoreButton.setAttribute('aria-label', label);
      ignoreButton.setAttribute('title', label);
    };
    paintIgnore(isIgnored(this.plugin, path));
    ignoreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void (async () => paintIgnore(await toggleIgnored(this.plugin, path)))();
    });

    const rateButton = container.createEl('button', {
      cls: `mod-cta ${RATE_CLASS}`,
    });
    paintRatingButton(this.plugin, rateButton, path, title);

    rateButton.addEventListener('click', (event) => {
      event.stopPropagation();
      showRatingMenu({
        plugin: this.plugin,
        event,
        path,
        // The painter runs off the plugin's remembered state, so the button
        // reflects the choice without this callback doing anything.
        onRated: () => undefined,
      });
    });
  }
}
