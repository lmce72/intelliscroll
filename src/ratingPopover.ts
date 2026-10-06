/**
 * The rating popover: a live, dismissable panel listing the tiers a rating
 * would schedule, with an in-place control for the parameter that shapes them.
 *
 * Not an Obsidian `Menu`: a native menu is static — it cannot re-render while
 * the user holds an adjuster — and it never delivers `pointerdown`/`pointerup`,
 * which the long-press ramp needs.
 *
 * The module deliberately imports nothing from the Obsidian runtime. The icon
 * renderer is injected, so the file (and the pure helpers at the top) can be
 * exercised without the app; the popover also never reaches into the plugin,
 * only into the callbacks it was handed.
 */

import { createLongPress } from './longPress.ts';
import { RETENTION_STEP, formatRetention } from './format.ts';
import type { Tier } from './tiers.ts';

/** A rectangle in viewport coordinates, as `getBoundingClientRect` reports it. */
export interface PopoverRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

/** Space left between the anchor and the popover. */
export const POPOVER_GAP = 6;
/** Space the popover keeps from the viewport edge. */
export const POPOVER_MARGIN = 8;

/**
 * Where to place the popover for an anchor, preferring below and flipping above
 * when there is no room, then clamping so it can never leave the viewport.
 *
 * Pure so the flip/clamp arithmetic is testable without a DOM. Coordinates are
 * viewport-relative, which is what works inside Obsidian's scrollable panes:
 * the popover is positioned `fixed` and re-placed on every scroll.
 */
export function computePopoverPosition(
  anchor: PopoverRect,
  popover: PopoverSize,
  viewport: PopoverSize,
  options?: { gap?: number; margin?: number }
): PopoverPosition {
  const gap = options?.gap ?? POPOVER_GAP;
  const margin = options?.margin ?? POPOVER_MARGIN;

  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - popover.height;
  const fitsBelow = below + popover.height <= viewport.height - margin;
  const fitsAbove = above >= margin;
  // Below is the default; flip only when below does not fit and above does.
  const placement: PopoverPosition['placement'] =
    !fitsBelow && fitsAbove ? 'above' : 'below';

  const desiredTop = placement === 'below' ? below : above;
  const maxTop = Math.max(margin, viewport.height - popover.height - margin);
  const top = Math.min(Math.max(desiredTop, margin), maxTop);

  // Centre on the anchor, then keep both edges inside the viewport.
  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const desiredLeft = anchor.left + anchor.width / 2 - popover.width / 2;
  const left = Math.min(Math.max(desiredLeft, margin), maxLeft);

  return { top: Math.round(top), left: Math.round(left), placement };
}

/**
 * Apply an adjuster step, clamped to the allowed range.
 *
 * Rounded to six decimals because the values are compared for equality to
 * decide whether anything changed: raw binary addition would turn 0.95 into
 * 0.9500000000000001 and defeat both the comparison and the display.
 */
export function stepRetention(
  value: number,
  delta: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value) || !Number.isFinite(delta)) return value;
  const clamped = Math.min(max, Math.max(min, value + delta));
  return Math.round(clamped * 1e6) / 1e6;
}

/**
 * The step sizes a held adjuster ramps through: the base step, then ten and a
 * hundred times it. A tap that starts at 0.0001 can therefore reach 0.01 while
 * the press is held, without a tap ever moving more than one base step.
 */
export function retentionRampSteps(step: number): number[] {
  const base = Number.isFinite(step) && step > 0 ? step : RETENTION_STEP;
  return [base, base * 10, base * 100];
}

/** ms a held adjuster waits before it starts repeating. */
const RAMP_DELAY_MS = 400;
/** ms between repeats once accelerating. */
const REPEAT_MS = 50;
/**
 * How often the press is ticked; also its redraw cadence.
 *
 * Deliberately faster than `REPEAT_MS`. Ticking at exactly the repeat interval
 * means every tick is a photo finish against the gate — one arriving a
 * millisecond early contributes nothing, and a main thread busy enough to
 * coalesce two timers skips a whole window. Sampling several times per window
 * makes the ramp's rate depend on elapsed time rather than on frame luck.
 */
const TICK_MS = 16;

/** Movement past this many pixels means the press was a scroll, not a tap. */
const TAP_MOVE_TOLERANCE_PX = 10;
/**
 * Longest a press may last and still count as a tap. A touch "click" can arrive
 * a few hundred ms after the finger lifts; a deliberate hold must not open a
 * menu, and on a tablet it must not open one under a moving finger.
 */
const TAP_MAX_MS = 700;

let pressOrigin: { x: number; y: number; at: number } | null = null;
let pressMoved = false;
const trackedWindows = new WeakSet<Window>();

/**
 * Track press geometry on a window exactly once.
 *
 * Installed lazily so importing this module touches no globals, which is what
 * lets the pure helpers be tested in Node.
 */
function installTapTracker(win: Window): void {
  if (trackedWindows.has(win)) return;
  trackedWindows.add(win);

  win.addEventListener(
    'pointerdown',
    (event) => {
      pressOrigin = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      pressMoved = false;
    },
    true
  );
  win.addEventListener(
    'pointermove',
    (event) => {
      if (!pressOrigin) return;
      const moved = Math.hypot(
        event.clientX - pressOrigin.x,
        event.clientY - pressOrigin.y
      );
      if (moved > TAP_MOVE_TOLERANCE_PX) pressMoved = true;
    },
    true
  );
  // A cancelled press tells us nothing about intent, so it is forgotten rather
  // than allowed to veto the next genuine click.
  win.addEventListener(
    'pointercancel',
    () => {
      pressOrigin = null;
      pressMoved = false;
    },
    true
  );
}

/**
 * Whether a click is a genuine tap rather than the tail of a scroll gesture or
 * a long hold.
 *
 * Callers consult this before opening a menu: on a touch device the browser
 * still emits a click after a swipe, and opening a menu mid-scroll is the exact
 * mis-tap the feed must avoid.
 */
export function isTapGesture(event: MouseEvent): boolean {
  if (event.view) installTapTracker(event.view);
  // No tracked press means the click came from the keyboard or a test harness;
  // there is no gesture to distrust, so it is accepted.
  if (!pressOrigin) return true;
  if (pressMoved) return false;
  return event.timeStamp - pressOrigin.at <= TAP_MAX_MS;
}

/** One rating offered when the algorithm yields no ladder (a shuffled feed). */
export interface TierPopoverRating {
  key: string;
  label: string;
  icon?: string;
  onPick: () => void;
}

export interface TierPopoverRetention {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Recompute the tiers for a candidate retention, for live refresh. */
  preview: (retention: number) => readonly Tier[];
  /** Called as the value changes, so the caller can apply and persist it. */
  onChange: (value: number) => void;
}

export interface TierPopoverOptions {
  anchor: HTMLElement;
  tiers: readonly Tier[];
  /** Format one tier's interval. Injected so the popover holds no wording. */
  formatInterval: (tier: Tier) => string;
  /** Name one tier. Injected for the same reason. */
  labelTier: (tier: Tier) => string;
  /** Lucide icon for one tier, or none. */
  iconTier?: (tier: Tier) => string | undefined;
  /** Render a Lucide icon into a node. Injected to keep this module Obsidian-free. */
  renderIcon: (el: HTMLElement, icon: string) => void;
  onPick: (tier: Tier) => void;
  /** Rows shown instead of tiers when the algorithm schedules nothing. */
  ratings?: readonly TierPopoverRating[];
  /** Omit to hide the retention adjuster entirely. */
  retention?: TierPopoverRetention;
  /**
   * A sentence about what the ladder cannot show by itself — grades pinned onto
   * the interval cap, or grades the model does not distinguish. Injected as
   * finished wording so this module holds none.
   */
  notice?: string;
  title?: string;
  adjusterLabel?: string;
  decreaseLabel?: string;
  increaseLabel?: string;
  closeLabel?: string;
  onClose?: () => void;
}

export interface TierPopover {
  close(): void;
}

/**
 * The open popover per anchor, so a second click on the same control replaces
 * the panel rather than stacking another one behind it. The outside-pointer
 * handler deliberately ignores the anchor, which is what makes it clickable
 * again — and that would otherwise open a duplicate.
 */
const openByAnchor = new WeakMap<HTMLElement, TierPopover>();

/**
 * Open the popover anchored to an element. The caller owns dismissal only in so
 * far as it must eventually receive `close()`; every listener and timer this
 * creates is torn down inside `close()`.
 */
export function openTierPopover(options: TierPopoverOptions): TierPopover {
  // Replacing an existing panel for this anchor keeps them from piling up.
  openByAnchor.get(options.anchor)?.close();

  const doc = options.anchor.ownerDocument;
  const win = doc.defaultView ?? window;
  installTapTracker(win);

  let closed = false;
  const disposers: (() => void)[] = [];

  const el = doc.body.createDiv({ cls: 'intelliscroll-tier-popover' });
  el.setAttribute('role', 'dialog');
  // Hidden until measured, so it never flashes at the top-left before it is
  // placed.
  el.style.visibility = 'hidden';

  const header = el.createDiv({ cls: 'intelliscroll-tier-header' });
  if (options.title !== undefined) {
    header.createSpan({ cls: 'intelliscroll-tier-title', text: options.title });
  }
  const closeButton = header.createEl('button', {
    cls: 'clickable-icon intelliscroll-tier-close',
  });
  const closeLabel = options.closeLabel ?? '';
  closeButton.setAttribute('aria-label', closeLabel);
  closeButton.setAttribute('title', closeLabel);
  options.renderIcon(closeButton, 'x');

  // Above the ladder, because it explains what the ladder below cannot: three
  // rungs reading the same number are not three equal choices.
  if (options.notice) {
    el.createDiv({ cls: 'intelliscroll-tier-notice', text: options.notice });
  }

  const rowsEl = el.createDiv({ cls: 'intelliscroll-tier-rows' });

  const retention = options.retention;
  let value =
    retention && Number.isFinite(retention.value)
      ? retention.value
      : retention?.min ?? 0;
  let valueEl: HTMLElement | null = null;

  const renderRows = (tiers: readonly Tier[]): void => {
    rowsEl.empty();

    if (tiers.length === 0) {
      // No schedule to preview: the ratings are still offered, with nothing
      // where the interval would go, rather than a fabricated "0 days".
      for (const rating of options.ratings ?? []) {
        const row = rowsEl.createEl('button', {
          cls: 'intelliscroll-tier-row',
        });
        const icon = row.createSpan({ cls: 'intelliscroll-tier-icon' });
        if (rating.icon !== undefined) options.renderIcon(icon, rating.icon);
        row.createSpan({ cls: 'intelliscroll-tier-label', text: rating.label });
        row.addEventListener('click', () => {
          close();
          rating.onPick();
        });
      }
      return;
    }

    for (const tier of tiers) {
      const icon = options.iconTier?.(tier);
      const label = options.labelTier(tier);
      const interval = options.formatInterval(tier);

      if (!tier.anchor) {
        // Interpolated rungs show the shape of the scale but back no grade, so
        // they are rendered as inert rows: making them pressable would commit
        // something other than the interval shown beside them.
        const row = rowsEl.createDiv({
          cls: 'intelliscroll-tier-row is-interpolated',
        });
        const iconEl = row.createSpan({ cls: 'intelliscroll-tier-icon' });
        if (icon !== undefined) options.renderIcon(iconEl, icon);
        row.createSpan({ cls: 'intelliscroll-tier-label', text: label });
        row.createSpan({ cls: 'intelliscroll-tier-interval', text: interval });
        continue;
      }

      const row = rowsEl.createEl('button', { cls: 'intelliscroll-tier-row' });
      const iconEl = row.createSpan({ cls: 'intelliscroll-tier-icon' });
      if (icon !== undefined) options.renderIcon(iconEl, icon);
      row.createSpan({ cls: 'intelliscroll-tier-label', text: label });
      row.createSpan({ cls: 'intelliscroll-tier-interval', text: interval });
      row.addEventListener('click', () => {
        close();
        options.onPick(tier);
      });
    }
  };

  const refresh = (): void => {
    renderRows(retention ? retention.preview(value) : options.tiers);
    valueEl?.setText(formatRetention(value));
  };

  const applyDelta = (delta: number): void => {
    if (!retention) return;
    const next = stepRetention(value, delta, retention.min, retention.max);
    if (next === value) return;
    value = next;
    retention.onChange(value);
    refresh();
  };

  if (retention) {
    const adjuster = el.createDiv({ cls: 'intelliscroll-tier-retention' });
    if (options.adjusterLabel !== undefined) {
      adjuster.createSpan({
        cls: 'intelliscroll-tier-retention-label',
        text: options.adjusterLabel,
      });
    }
    const controls = adjuster.createDiv({
      cls: 'intelliscroll-tier-retention-controls',
    });

    const wireStep = (button: HTMLButtonElement, direction: 1 | -1): void => {
      const press = createLongPress(
        {
          rampDelayMs: RAMP_DELAY_MS,
          steps: retentionRampSteps(retention.step),
          repeatMs: REPEAT_MS,
        },
        direction
      );
      let timer: number | null = null;
      const stop = (): void => {
        if (timer !== null) {
          win.clearInterval(timer);
          timer = null;
        }
      };
      disposers.push(stop);

      button.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        // Suppresses text selection and the long-press callout on touch.
        event.preventDefault();
        press.down(Date.now());
        stop();
        timer = win.setInterval(() => {
          const amount = press.tick(Date.now());
          if (amount !== null) applyDelta(direction * amount);
        }, TICK_MS);
      });
      button.addEventListener('pointerup', (event) => {
        event.preventDefault();
        const amount = press.up(Date.now());
        stop();
        // A tap that never accelerated applies exactly one base step.
        if (amount > 0) applyDelta(direction * amount);
      });
      button.addEventListener('pointercancel', () => {
        press.cancel();
        stop();
      });
      button.addEventListener('click', (event) => event.preventDefault());
      button.addEventListener('contextmenu', (event) =>
        event.preventDefault()
      );
    };

    const decrease = controls.createEl('button', {
      cls: 'clickable-icon intelliscroll-tier-step',
    });
    decrease.setAttribute('aria-label', options.decreaseLabel ?? '');
    decrease.setAttribute('title', options.decreaseLabel ?? '');
    options.renderIcon(decrease, 'minus');
    wireStep(decrease, -1);

    valueEl = controls.createSpan({ cls: 'intelliscroll-tier-retention-value' });

    const increase = controls.createEl('button', {
      cls: 'clickable-icon intelliscroll-tier-step',
    });
    increase.setAttribute('aria-label', options.increaseLabel ?? '');
    increase.setAttribute('title', options.increaseLabel ?? '');
    options.renderIcon(increase, 'plus');
    wireStep(increase, 1);
  }

  closeButton.addEventListener('click', () => close());

  const reposition = (): void => {
    const anchorRect = options.anchor.getBoundingClientRect();
    // The anchor scrolled out of the viewport entirely: the popover has nothing
    // left to point at, so it goes away with it.
    if (
      anchorRect.bottom < 0 ||
      anchorRect.top > win.innerHeight ||
      anchorRect.right < 0 ||
      anchorRect.left > win.innerWidth
    ) {
      close();
      return;
    }

    const popoverRect = el.getBoundingClientRect();
    const position = computePopoverPosition(
      {
        top: anchorRect.top,
        left: anchorRect.left,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      { width: popoverRect.width, height: popoverRect.height },
      { width: win.innerWidth, height: win.innerHeight }
    );
    el.style.top = `${position.top}px`;
    el.style.left = `${position.left}px`;
    el.setAttribute('data-placement', position.placement);
  };

  const onOutsidePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (el.contains(target)) return;
    // The anchor toggles the popover; closing here would fight its own click.
    if (options.anchor.contains(target)) return;
    close();
  };
  doc.addEventListener('pointerdown', onOutsidePointerDown, true);
  disposers.push(() =>
    doc.removeEventListener('pointerdown', onOutsidePointerDown, true)
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  disposers.push(() => doc.removeEventListener('keydown', onKeyDown, true));

  win.addEventListener('scroll', reposition, true);
  win.addEventListener('resize', reposition);
  disposers.push(() => {
    win.removeEventListener('scroll', reposition, true);
    win.removeEventListener('resize', reposition);
  });

  const handle: TierPopover = {
    close(): void {
      if (closed) return;
      closed = true;
      if (openByAnchor.get(options.anchor) === handle) {
        openByAnchor.delete(options.anchor);
      }
      for (const dispose of disposers.splice(0)) dispose();
      el.remove();
      options.onClose?.();
    },
  };

  function close(): void {
    handle.close();
  }

  openByAnchor.set(options.anchor, handle);
  refresh();
  reposition();
  el.style.removeProperty('visibility');

  return handle;
}
