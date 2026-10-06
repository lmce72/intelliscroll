import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePopoverPosition,
  isTapGesture,
  retentionRampSteps,
  stepRetention,
} from '../src/ratingPopover.ts';
import { RETENTION_STEP } from '../src/format.ts';

// `src/ratingPopover.ts` imports nothing from the Obsidian runtime, so these
// helpers run under the plain Node test runner. The DOM half of the popover is
// not covered here — this repo has no DOM harness — and is verified by hand.

// ─── computePopoverPosition ────────────────────────────────────────────────

const VIEWPORT = { width: 1_000, height: 800 };

test('an anchor with room below places the popover below, centred on it', () => {
  const position = computePopoverPosition(
    { top: 100, left: 400, width: 200, height: 20 },
    { width: 200, height: 150 },
    VIEWPORT
  );
  assert.deepEqual(position, { top: 126, left: 400, placement: 'below' });
});

test('an anchor near the bottom flips the popover above it', () => {
  const position = computePopoverPosition(
    { top: 700, left: 400, width: 200, height: 20 },
    { width: 200, height: 150 },
    VIEWPORT
  );
  assert.equal(position.placement, 'above');
  assert.equal(position.top, 544, 'sits above the anchor with the gap');
});

test('the popover stays inside the viewport on the right and left edges', () => {
  const right = computePopoverPosition(
    { top: 100, left: 950, width: 40, height: 20 },
    { width: 200, height: 150 },
    VIEWPORT
  );
  assert.equal(right.left, 792, 'right edge kept a margin from the viewport');

  const left = computePopoverPosition(
    { top: 100, left: 0, width: 20, height: 20 },
    { width: 200, height: 150 },
    VIEWPORT
  );
  assert.equal(left.left, 8, 'left edge kept a margin from the viewport');
});

test('a popover too tall for either side is still clamped inside the viewport', () => {
  const position = computePopoverPosition(
    { top: 40, left: 10, width: 20, height: 20 },
    { width: 200, height: 150 },
    { width: 1_000, height: 100 }
  );
  assert.equal(position.top, 8, 'never placed above the top margin');
});

test('a popover wider than the viewport is pinned to the left margin', () => {
  const position = computePopoverPosition(
    { top: 100, left: 10, width: 20, height: 20 },
    { width: 2_000, height: 50 },
    VIEWPORT
  );
  assert.equal(position.left, 8, 'a negative clamp bound degrades to the margin');
});

// ─── stepRetention ─────────────────────────────────────────────────────────

test('a step moves the value by exactly one increment', () => {
  assert.equal(stepRetention(0.9, RETENTION_STEP, 0.7, 0.97), 0.9001);
  assert.equal(stepRetention(0.9001, -RETENTION_STEP, 0.7, 0.97), 0.9);
});

test('a step is clamped to the allowed range', () => {
  assert.equal(stepRetention(0.97, 0.01, 0.7, 0.97), 0.97);
  assert.equal(stepRetention(0.7, -0.01, 0.7, 0.97), 0.7);
});

test('a step leaves no binary dust to defeat the equality check', () => {
  // 0.95 + 0.0001 is 0.9500000000000001 in raw binary; the helper rounds it so a
  // caller comparing the result to decide "did anything change" sees a clean
  // value and the display does not grow a tail.
  assert.equal(stepRetention(0.95, RETENTION_STEP, 0.7, 0.97), 0.9501);
});

test('a non-finite step or value is passed through untouched', () => {
  assert.equal(stepRetention(0.9, Number.NaN, 0.7, 0.97), 0.9);
  assert.ok(Number.isNaN(stepRetention(Number.NaN, 0.0001, 0.7, 0.97)));
});

// ─── retentionRampSteps ────────────────────────────────────────────────────

test('the ramp triples geometrically: base, ten times, a hundred times', () => {
  assert.deepEqual(retentionRampSteps(1), [1, 10, 100]);
  assert.deepEqual(retentionRampSteps(RETENTION_STEP), [
    RETENTION_STEP,
    RETENTION_STEP * 10,
    RETENTION_STEP * 100,
  ]);
});

test('an unusable step falls back to the retention step', () => {
  const expected = [
    RETENTION_STEP,
    RETENTION_STEP * 10,
    RETENTION_STEP * 100,
  ];
  assert.deepEqual(retentionRampSteps(0), expected);
  assert.deepEqual(retentionRampSteps(Number.NaN), expected);
  assert.deepEqual(retentionRampSteps(-5), expected);
});

// ─── isTapGesture ──────────────────────────────────────────────────────────

test('a click with no tracked press is accepted', () => {
  // A keyboard activation or a test harness delivers no pointer gesture; there
  // is nothing to distrust, so the menu must still open.
  const event = { view: null, timeStamp: 0 } as unknown as MouseEvent;
  assert.equal(isTapGesture(event), true);
});

// ─── Keeping clear of the note's floating control ──────────────────────────

/** Viewport from a phone in portrait, and a menu opened from the float. */
const PHONE = { width: 400, height: 800 };
const MENU = { width: 240, height: 420 };
/** The float's button: near the bottom-left corner, as mobile shows it. */
const FLOAT_BUTTON = { top: 740, left: 16, width: 32, height: 32 };

/** What `floatingReserve` produces for a control at `floatTop`. */
const reserveFor = (floatTop: number): number => PHONE.height - floatTop + 6;

test('a menu opened from the floating control clears the whole control', () => {
  // The regression this pins. Reserving only the control's *height* is not
  // enough: the anchor is a button inside it, so "above the anchor" still lands
  // inside the control's own box, and on mobile that box is the bottom-left
  // corner where the menu is unreadable.
  const floatTop = 724;
  const placed = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE, {
    reserveBottom: reserveFor(floatTop),
  });

  assert.ok(
    placed.top + MENU.height <= floatTop,
    `menu ends at ${placed.top + MENU.height}, must end at or above the control's top (${floatTop})`
  );
});

test('without the reserve the menu sinks onto the control', () => {
  // What it looked like before: no reservation, so the menu takes the lowest
  // position the viewport allows and covers the button it came from.
  const placed = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE);
  assert.ok(
    placed.top + MENU.height > 724,
    'unreserved, the menu reaches into the control'
  );
});

test('a taller control reserves more, because it grows upward', () => {
  // One row until the note has been read, two after. It grows from a fixed
  // bottom edge, so the top moves up and a height captured earlier would leave
  // the menu overlapping the row that appeared.
  const oneRow = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE, {
    reserveBottom: reserveFor(740),
  });
  const twoRows = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE, {
    reserveBottom: reserveFor(704),
  });

  assert.ok(twoRows.top < oneRow.top, 'the taller control pushes the menu higher');
  assert.equal(oneRow.top - twoRows.top, 36, 'by exactly the extra row');
});

test('a reserve never pushes the menu off the top', () => {
  // A control taller than the room available must not invert the bounds and
  // leave the menu at a negative top, where it cannot be reached.
  for (const reserveBottom of [500, 900, 5000]) {
    const placed = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE, { reserveBottom });
    assert.ok(placed.top >= 8, `reserve ${reserveBottom} put the menu at ${placed.top}`);
    assert.ok(Number.isFinite(placed.top), `reserve ${reserveBottom} produced ${placed.top}`);
  }
});

test('a reserve does not move a menu that fits below its anchor', () => {
  // A card in the feed has no floating control under it, and even with one the
  // menu belongs where it fits whenever there is room.
  const anchor = { top: 100, left: 80, width: 32, height: 32 };
  const small = { width: 240, height: 200 };

  assert.deepEqual(
    computePopoverPosition(anchor, small, PHONE, { reserveBottom: 60 }),
    computePopoverPosition(anchor, small, PHONE),
    'room below means the reserve is irrelevant'
  );
});

test('a nonsense reserve is ignored rather than trusted', () => {
  const plain = computePopoverPosition(FLOAT_BUTTON, MENU, PHONE);
  for (const reserveBottom of [Number.NaN, -50, 0, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      computePopoverPosition(FLOAT_BUTTON, MENU, PHONE, { reserveBottom }),
      plain,
      `reserve ${reserveBottom} must leave placement alone`
    );
  }
});
