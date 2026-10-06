/**
 * Long-press acceleration for a stepped control.
 *
 * A retention control moves in steps of 0.0001, so a plain tap can never reach
 * a useful value; the press must be able to ramp. This module owns only the
 * timing decision — "how much should this press apply right now" — and nothing
 * else. It holds no DOM, no timers and no clock: every moment arrives as a
 * number argument, which is what keeps it testable and safe on mobile.
 *
 * The caller drives it: `down()` from pointerdown, `tick(now)` from its own
 * animation frame, `up()` from pointerup, `cancel()` from pointercancel.
 */

export interface LongPressConfig {
  /** ms a press must last before acceleration begins. */
  rampDelayMs: number;
  /** Step sizes in increasing order; the ramp moves through them in order. */
  steps: readonly number[];
  /** ms between repeats once accelerating. */
  repeatMs: number;
}

export interface LongPressController {
  /** A press began at `now` (epoch ms). */
  down(now: number): void;
  /**
   * Advance to `now`. Returns the amount to apply, or null when nothing is
   * due yet.
   */
  tick(now: number): number | null;
  /**
   * The press ended. Returns the amount a plain tap should still apply — one
   * base step — or 0 when the press already accelerated (the repeats stand in
   * for the tap).
   */
  up(now: number): number;
  /** Whether the current press has accelerated. */
  isAccelerating(): boolean;
  /** Abandon the press, e.g. because the pointer was cancelled. */
  cancel(): void;
}

/**
 * Substituted for a `rampDelayMs` that is not a finite positive number.
 *
 * 500 ms matches the long-press threshold users already feel from their OS, so
 * an acceleration the caller misconfigured still reads as "I held this down".
 */
const FALLBACK_RAMP_DELAY_MS = 500;

/**
 * Substituted for a `repeatMs` that is not a finite positive number.
 *
 * 50 ms is roughly a display frame at 20 Hz: fast enough that the ramp feels
 * continuous, slow enough that one repeat cannot outrun a repaint.
 */
const FALLBACK_REPEAT_MS = 50;

/**
 * Substituted when `steps` sanitises to nothing.
 *
 * A step of 1 is the only neutral choice: any other magnitude would invent a
 * unit the caller never agreed to.
 */
const FALLBACK_STEPS: readonly number[] = [1];

/**
 * Create a controller. `direction` is +1 to increase the value, -1 to
 * decrease; the returned amounts are always positive magnitudes and the
 * caller applies the sign.
 */
export function createLongPress(
  config: LongPressConfig,
  direction: 1 | -1 = 1
): LongPressController {
  // `direction` is intentionally not folded into any returned amount: the sign
  // belongs to the caller, which is the only party that knows what the value is
  // read back as. It is accepted so a call site can read symmetrically for an
  // up and a down arrow. Accepted and ignored, never silently reinterpreted.
  void direction;

  const rampDelayMs = positiveOr(config?.rampDelayMs, FALLBACK_RAMP_DELAY_MS);
  const repeatMs = positiveOr(config?.repeatMs, FALLBACK_REPEAT_MS);
  const steps = sanitizeSteps(config?.steps);

  let active = false;
  let start = 0;
  let lastNow = Number.NEGATIVE_INFINITY;
  let accelerated = false;
  let stepIndex = 0;
  let lastEmitAt = 0;

  return {
    down(now: number): void {
      // A non-finite clock reading would poison every later comparison, so it
      // is pinned to a finite origin rather than propagated.
      const at = Number.isFinite(now) ? now : 0;
      active = true;
      start = at;
      lastNow = at;
      accelerated = false;
      stepIndex = 0;
      lastEmitAt = at;
    },

    tick(now: number): number | null {
      if (!active || !Number.isFinite(now)) return null;
      // A backwards clock step is dropped, and `lastNow` is left untouched so
      // the next forward tick resumes normally instead of being poisoned.
      if (now < lastNow) return null;
      lastNow = now;

      if (now - start < rampDelayMs) return null;

      if (!accelerated) {
        accelerated = true;
        stepIndex = 0;
        // The repeat grid starts when the ramp does, not at whatever instant
        // the first qualifying tick happened to arrive, so the cadence does not
        // inherit the caller's frame timing.
        lastEmitAt = start + rampDelayMs;
        return steps[0]!;
      }

      // A window that has already passed is owed, not discarded.
      //
      // This used to reschedule from the arrival time and drop whatever the
      // tick was short by, which loses steps two ways. A tick landing a
      // millisecond early wastes its whole window; and the caller ticks from a
      // timer, so a busy main thread coalesces several of them into one — a
      // 200 ms stall is four windows and, under the old rule, exactly one
      // emitted step, with the other three gone. That reads as the ramp
      // "losing count": it fires, but the value moves by far less than the time
      // held justifies, and by a different amount each press.
      //
      // Advancing the grid by whole windows keeps the rest pending, so nothing
      // is lost. Still at most one step per call, so a stall cannot dump a
      // burst into a single repaint: the backlog drains over the following
      // ticks, which arrive faster than the windows do.
      // Advance the grid by exactly one window, not by everything that has
      // elapsed. Consuming the whole gap here is the tempting version and it
      // still loses: it emits one step and writes off the other three, which is
      // the same defect with more arithmetic. One window per step means the
      // remainder stays owed and drains on later ticks.
      if (now - lastEmitAt < repeatMs) return null;
      lastEmitAt += repeatMs;
      if (stepIndex < steps.length - 1) stepIndex += 1;
      return steps[stepIndex]!;
    },

    up(_now: number): number {
      if (!active) return 0;
      const hadAccelerated = accelerated;
      active = false;
      accelerated = false;
      stepIndex = 0;
      // Once repeats have fired they stand in for the tap, so a release must
      // not also add a step on top of them.
      return hadAccelerated ? 0 : steps[0]!;
    },

    isAccelerating(): boolean {
      return active && accelerated;
    },

    cancel(): void {
      active = false;
      accelerated = false;
      stepIndex = 0;
    },
  };
}

/** `value` when it is finite and positive, the fallback otherwise. */
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Reduce `steps` to finite positive magnitudes, or to the fallback when that
 * leaves nothing. Non-positive and non-finite entries are dropped rather than
 * allowed through: a NaN step would surface as a NaN amount, and a negative
 * one would contradict the "amounts are positive magnitudes" contract.
 */
function sanitizeSteps(steps: readonly number[]): readonly number[] {
  const source = Array.isArray(steps) ? steps : [];
  const cleaned = source.filter(
    (step) => Number.isFinite(step) && step > 0
  );
  return cleaned.length > 0 ? cleaned : FALLBACK_STEPS;
}
