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
