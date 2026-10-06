import { MarkdownView, setIcon } from 'obsidian';
import type IntelliScrollPlugin from './main';
import {
  applyRating,
  ignoreIcon,
  ignoreLabel,
  isIgnored,
  paintRatingButton,
  RATING_ORDER,
  ratingColorClass,
  ratingIcon,
  ratingLabel,
  showRatingMenu,
  toggleIgnored,
} from './rating.ts';
import { isTapGesture } from './ratingPopover.ts';
import { activeDisplay } from './presets.ts';
import { logSrsError } from './srsLog.ts';
import { DWELL_HIGH_MS, MAX_DWELL_SAMPLE_MS } from './grading.ts';
import { t } from './i18n.ts';

const FLOAT_CLASS = 'intelliscroll-note-float';
const RATE_CLASS = 'intelliscroll-note-float-rate';
const IGNORE_CLASS = 'intelliscroll-note-float-ignore';
const RATINGS_CLASS = 'intelliscroll-note-float-ratings';
const CHOICE_CLASS = 'intelliscroll-note-float-choice';

/**
 * Whether the opt-in "offer the ratings once read" behaviour is on.
 *
 * Read through the effective display preset rather than through a key of its
 * own, so switching preset or making a session override takes effect without
 * this module knowing where the value came from. `backfillPresetDefaults`
 * guarantees the field is a real boolean, and anything that is not an explicit
 * `true` means off.
 */
export function isReadPromptEnabled(plugin: IntelliScrollPlugin): boolean {
  return plugin.getEffectiveDisplay().promptRatingAfterRead === true;
}

/**
 * Dwell before a note counts as read enough to offer the ratings.
 *
 * The same figure automatic grading treats as "actually read"; reusing it keeps
 * the two from drifting apart.
 */
const READ_PROMPT_DWELL_MS = DWELL_HIGH_MS;
/** Quiet time after any touch or scroll before the control may grow. */
const READ_PROMPT_IDLE_MS = 800;
/** How often active dwell is sampled. */
const DWELL_TICK_MS = 1_000;

/** Per-pane reading state for one mounted control. */
interface DwellTrack {
  view: MarkdownView;
  path: string;
  control: HTMLElement;
  rateButton: HTMLButtonElement | null;
  /** Milliseconds this pane has been the active, visible one. */
  accumulatedMs: number;
  lastTickAt: number;
  /** Last touch or scroll, used to avoid expanding under a finger. */
  lastActivityAt: number;
  expanded: boolean;
  disposers: (() => void)[];
}

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
 * lasts for the session rather than for the instant of opening. For the same
 * reason, the opt-in prompt waits until the pane has actually been read — it
 * never appears on open, and never while the user is still scrolling.
 *
 * Mounted into the note view's own container rather than the workspace root so
 * it moves with the pane and disappears with it. DOM is built exclusively
 * through Obsidian's `createEl`/`setIcon`.
 */
export class NoteOverlay {
  private unsubscribe: (() => void) | null = null;
  private tracked = new Map<HTMLElement, DwellTrack>();
  private tickTimer: number | null = null;

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
      if (path === null) continue;

      const button = view.contentEl.querySelector<HTMLElement>(`.${RATE_CLASS}`);
      if (button) {
        paintRatingButton(
          this.plugin,
          button,
          path,
          view.file?.basename ?? path
        );
      }
      this.paintChoices(view.contentEl, path);
    }
  }

  /** Mark the chosen inline rating, if one exists in this pane. */
  private paintChoices(container: HTMLElement, path: string): void {
    const row = container.querySelector<HTMLElement>(`.${RATINGS_CLASS}`);
    if (!row) return;
    const chosen = this.plugin.lastRatingFor(path);
    for (const button of Array.from(
      row.querySelectorAll<HTMLElement>(`.${CHOICE_CLASS}`)
    )) {
      const selected = button.dataset.rating === chosen;
      button.toggleClass('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  private createRateButton(
    control: HTMLElement,
    path: string,
    title: string
  ): HTMLButtonElement {
    const rateButton = control.createEl('button', {
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
        onRated: () => this.repaint(),
      });
    });
    return rateButton;
  }

  /** Begin sampling reading time for a freshly mounted control. */
  private track(
    view: MarkdownView,
    path: string,
    control: HTMLElement,
    rateButton: HTMLButtonElement
  ): void {
    const now = Date.now();
    const track: DwellTrack = {
      view,
      path,
      control,
      rateButton,
      accumulatedMs: 0,
      lastTickAt: now,
      lastActivityAt: now,
      expanded: false,
      disposers: [],
    };

    const activity = (): void => {
      track.lastActivityAt = Date.now();
    };
    // Capture phase: `scroll` does not bubble, and the pane's real scroller is
    // a descendant of `contentEl`.
    view.contentEl.addEventListener('scroll', activity, true);
    view.contentEl.addEventListener('pointerdown', activity, true);
    track.disposers.push(
      () => view.contentEl.removeEventListener('scroll', activity, true),
      () => view.contentEl.removeEventListener('pointerdown', activity, true)
    );

    this.tracked.set(control, track);
    this.ensureTicking();
  }

  private untrack(control: HTMLElement): void {
    const track = this.tracked.get(control);
    if (!track) return;
    for (const dispose of track.disposers.splice(0)) dispose();
    this.tracked.delete(control);
    this.stopTickingIfIdle();
  }

  private ensureTicking(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = window.setInterval(() => this.tick(), DWELL_TICK_MS);
  }

  private stopTickingIfIdle(): void {
    if (this.tickTimer === null || this.tracked.size > 0) return;
    window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /**
   * Advance reading time for the active pane and expand when it is due.
   *
   * Only the active, visible pane accumulates, so a note left open in a
   * background tab cannot bank the dwell and then prompt the moment it is
   * looked at.
   */
  private tick(): void {
    if (!isReadPromptEnabled(this.plugin)) return;

    const now = Date.now();
    const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const visible = activeDocument.visibilityState === 'visible';

    for (const track of this.tracked.values()) {
      const elapsed = now - track.lastTickAt;
      track.lastTickAt = now;
      if (track.expanded || !visible || track.view !== active) continue;

      // Cap the sample so a hidden pane whose timer stalled cannot bank hours.
      track.accumulatedMs += Math.max(0, Math.min(elapsed, MAX_DWELL_SAMPLE_MS));
      if (track.accumulatedMs < READ_PROMPT_DWELL_MS) continue;
      // Never grow the control under a finger or mid-scroll: that is how a
      // tap lands on the wrong target.
      if (now - track.lastActivityAt < READ_PROMPT_IDLE_MS) continue;
      this.expand(track);
    }
  }

  /** Replace the single rate button with the four ratings, in place. */
  private expand(track: DwellTrack): void {
    if (track.expanded) return;

    // Nothing can be written while nothing is scheduled; the menu the single
    // button opens is the honest answer. Left un-expanded rather than marked
    // done, so switching scheduling on while the note stays open still offers
    // the choices.
    if (this.plugin.getEffectiveAlgorithm().algorithm === 'off') return;
    track.expanded = true;

    const row = track.control.createDiv({ cls: RATINGS_CLASS });
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', t('tuning.prompt.ratings'));

    for (const rating of RATING_ORDER) {
      const button = row.createEl('button', {
        cls: `clickable-icon ${CHOICE_CLASS} ${ratingColorClass(rating)}`,
      });
      button.dataset.rating = rating;
      setIcon(button, ratingIcon(rating));
      const label = ratingLabel(rating);
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!isTapGesture(event)) return;
        void (async () => {
          try {
            if (await applyRating(this.plugin, track.path, rating, 'explicit')) {
              this.repaint();
            }
          } catch (error) {
            logSrsError('failed to record a rating', error);
          }
        })();
      });
    }

    // The single button's menu would now be redundant beside the choices it
    // used to offer.
    track.rateButton?.remove();
    track.rateButton = null;
    this.paintChoices(track.control, track.path);
  }

  /** Fold every expanded control back to its single button. */
  private collapseAll(): void {
    for (const track of this.tracked.values()) {
      if (!track.expanded) continue;
      track.control.querySelector(`.${RATINGS_CLASS}`)?.remove();
      track.rateButton = this.createRateButton(
        track.control,
        track.path,
        track.view.file?.basename ?? track.path
      );
      track.expanded = false;
    }
  }

  /**
   * Turn the opt-in prompt on or off and remember it. Off is the default: a
   * rating prompt is only welcome once the reader has asked for one.
   */
  async setReadPromptEnabled(enabled: boolean): Promise<void> {
    // Written to the stored preset, not to a session override: this is a
    // preference the reader is stating, and it should outlive the session.
    const preset = activeDisplay(
      this.plugin.data.settings.presets,
      this.plugin.data.settings.activeDisplayPresetId
    );
    preset.promptRatingAfterRead = enabled;
    await this.plugin.saveSettingsAndRefreshViews();
    if (!enabled) this.collapseAll();
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
    const seen = new Set<HTMLElement>();

    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const path = view.file?.path ?? null;
      const existing = view.contentEl.querySelector<HTMLElement>(
        `.${FLOAT_CLASS}`
      );
      const wanted = path !== null && this.plugin.wasOpenedFromFeed(path);

      if (wanted && existing === null && path !== null) {
        this.mount(view, path);
      } else if (!wanted && existing !== null) {
        this.untrack(existing);
        existing.remove();
      }

      const control = view.contentEl.querySelector<HTMLElement>(
        `.${FLOAT_CLASS}`
      );
      if (control) seen.add(control);
    }

    // Drop tracks whose control went away for any reason other than the sweep
    // above, so a removed pane cannot keep the sampler alive.
    for (const control of Array.from(this.tracked.keys())) {
      if (!seen.has(control) && !control.isConnected) this.untrack(control);
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const control of Array.from(this.tracked.keys())) this.untrack(control);
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

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

    const rateButton = this.createRateButton(container, path, title);
    this.track(view, path, container, rateButton);
  }
}
