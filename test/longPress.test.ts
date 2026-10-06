import assert from 'node:assert/strict';
import test from 'node:test';
import { createLongPress } from '../src/longPress.ts';
import type {
  LongPressConfig,
  LongPressController,
} from '../src/longPress.ts';

const CONFIG: LongPressConfig = {
  rampDelayMs: 500,
  steps: [1, 2, 5],
  repeatMs: 100,
};

/** Feed an explicit sequence of timestamps and collect what tick emitted. */
function drive(
  controller: LongPressController,
  times: readonly number[]
): (number | null)[] {
  return times.map((now) => controller.tick(now));
}

// ─── Tap ───────────────────────────────────────────────────────────────────

test('a short tap returns exactly one base step', () => {
  const press = createLongPress(CONFIG);
  press.down(1_000);

  assert.equal(press.isAccelerating(), false, 'not accelerating before up');
  assert.equal(press.up(1_100), CONFIG.steps[0], 'tap applies the first step');
  assert.equal(press.isAccelerating(), false, 'a tap never accelerates');
});

test('a tap that is held past rampDelay but never ticked still applies one base step', () => {
  // Repeats only exist once they are emitted; if the caller never got a frame,
  // nothing has stood in for the tap, so the release must still apply it.
  const press = createLongPress(CONFIG);
  press.down(0);
  assert.equal(press.up(900), CONFIG.steps[0]);
});

// ─── Hold / ramp ───────────────────────────────────────────────────────────

test('holding past rampDelay starts the ramp at the first step', () => {
  const press = createLongPress(CONFIG);
  press.down(0);

  assert.equal(press.tick(499), null, 'nothing before the ramp delay');
  assert.equal(press.tick(500), CONFIG.steps[0], 'first accelerated amount');
  assert.equal(press.isAccelerating(), true, 'the press has accelerated');
});

test('the ramp advances through the steps and then stays on the last', () => {
  const press = createLongPress(CONFIG);
  press.down(0);

  const emitted = drive(press, [
    500, // first accelerated emit: steps[0]
    600, // +1 repeat: steps[1]
    700, // +1 repeat: steps[2]
    800, // +1 repeat: already at the last step, so it repeats
    900,
  ]);

  assert.deepEqual(emitted, [1, 2, 5, 5, 5]);
});

test('tick emits at most one step per call, however many windows elapsed', () => {
  const press = createLongPress(CONFIG);
  press.down(0);

  press.tick(500); // steps[0]
  // Two repeat windows have elapsed (500 -> 900), but a single call may only
  // advance one step; a stalled frame must not dump a burst of steps.
  assert.equal(press.tick(900), CONFIG.steps[1]);
  assert.equal(press.tick(1_100), CONFIG.steps[2]);
});

test('repeats are gated by repeatMs', () => {
  const press = createLongPress(CONFIG);
  press.down(0);

  const emitted = drive(press, [
    500, // ramp reached: first emit
    510, // inside the window
    599, // still inside
    600, // window elapsed: next step
    699, // inside again
    700, // window elapsed: next step
  ]);

  assert.deepEqual(emitted, [1, null, null, 2, null, 5]);
});

test('a release after accelerating applies nothing on top of the repeats', () => {
  const press = createLongPress(CONFIG);
  press.down(0);
  press.tick(500);
  press.tick(600);

  assert.equal(press.up(650), 0, 'the repeats stand in for the tap');
  assert.equal(press.isAccelerating(), false, 'no press is active after up');
});

// ─── Backwards time ────────────────────────────────────────────────────────

test('a tick earlier than the previous one emits nothing and does not throw', () => {
  const press = createLongPress(CONFIG);
  press.down(0);
  assert.equal(press.tick(500), CONFIG.steps[0]);

  assert.doesNotThrow(() => {
    assert.equal(press.tick(100), null, 'backwards time emits nothing');
    assert.equal(press.tick(499), null);
  });

  // The next forward tick still behaves, so the odd reading did not poison it.
  assert.equal(press.tick(600), CONFIG.steps[1]);
});

// ─── Out-of-order lifecycle ────────────────────────────────────────────────

test('tick before down and after up returns null', () => {
  const press = createLongPress(CONFIG);

  assert.equal(press.tick(1_000), null, 'no press has started');
  press.down(0);
  press.up(50);
  assert.equal(press.tick(1_000), null, 'the press already ended');
});

test('up before down returns zero', () => {
  const press = createLongPress(CONFIG);
  assert.equal(press.up(1_000), 0);
});

// ─── Cancel ────────────────────────────────────────────────────────────────

test('cancel abandons the press and the next down starts fresh', () => {
  const press = createLongPress(CONFIG);
  press.down(0);
  press.tick(500);
  press.tick(600);
  assert.equal(press.isAccelerating(), true);

  press.cancel();
  assert.equal(press.isAccelerating(), false, 'the press is gone');
  assert.equal(press.tick(700), null, 'a cancelled press no longer ticks');

  press.down(1_000);
  assert.equal(press.tick(1_500), CONFIG.steps[0], 'the new press restarts the ramp');
  assert.equal(press.up(1_550), 0, 'the new press accelerated, so no tap step');
});

// ─── No state leaks between presses ────────────────────────────────────────

test('a press after an accelerated one starts from the base step again', () => {
  const press = createLongPress(CONFIG);

  press.down(0);
  drive(press, [500, 600, 700, 800]); // ramp all the way to the last step
  assert.equal(press.up(850), 0);

  press.down(10_000);
  assert.equal(
    press.tick(10_500),
    CONFIG.steps[0],
    'the ramp index was not carried over'
  );
  assert.equal(press.up(10_550), 0);
});

// ─── Malformed config ──────────────────────────────────────────────────────

test('malformed config neither throws nor emits NaN', () => {
  const malformed: readonly LongPressConfig[] = [
    { rampDelayMs: 0, steps: [], repeatMs: -1 },
    { rampDelayMs: Number.NaN, steps: [], repeatMs: Number.NaN },
    {
      rampDelayMs: Number.POSITIVE_INFINITY,
      steps: [Number.NaN, -1, 0],
      repeatMs: Number.POSITIVE_INFINITY,
    },
    { rampDelayMs: -5, steps: [4], repeatMs: 0 },
    { rampDelayMs: 500, steps: [] as number[], repeatMs: 100 },
  ];

  for (const config of malformed) {
    assert.doesNotThrow(
      () => {
        const press = createLongPress(config);
        press.down(0);
        const emitted = drive(press, [250, 500, 1_000, 10_000]);
        for (const amount of emitted) {
          assert.ok(
            amount === null || (Number.isFinite(amount) && amount > 0),
            `amount must be null or a finite positive magnitude, got ${amount}`
          );
        }
        const released = press.up(11_000);
        assert.ok(
          Number.isFinite(released) && released >= 0,
          `release amount must be finite, got ${released}`
        );
      },
      `config ${JSON.stringify(config)} must be usable`
    );
  }
});

test('an empty step list falls back to a single unit step', () => {
  const press = createLongPress({ rampDelayMs: 500, steps: [], repeatMs: 100 });
  press.down(0);
  assert.equal(press.tick(500), 1, 'the fallback base step is 1');
  assert.equal(press.up(550), 0);
});

test('non-positive and non-finite steps are dropped from the ladder', () => {
  const press = createLongPress({
    rampDelayMs: 100,
    steps: [Number.NaN, -1, 0, 2],
    repeatMs: 100,
  });
  press.down(0);

  const emitted = drive(press, [100, 200, 300]);
  assert.deepEqual(emitted, [2, 2, 2], 'only the surviving step is ever used');
});

// ─── Direction ─────────────────────────────────────────────────────────────

test('direction is not applied here: amounts are positive either way', () => {
  const increasing = createLongPress(CONFIG, 1);
  const decreasing = createLongPress(CONFIG, -1);

  for (const press of [increasing, decreasing]) {
    press.down(0);
  }

  const upward = drive(increasing, [500, 600, 700]);
  const downward = drive(decreasing, [500, 600, 700]);

  assert.deepEqual(downward, upward, 'the sign never changes what is emitted');
  assert.deepEqual(upward, [1, 2, 5]);
  for (const amount of upward) {
    assert.ok(amount! > 0, 'every amount is a positive magnitude');
  }

  assert.equal(decreasing.up(750), 0, 'the release amount is positive too');

  const downwardTap = createLongPress(CONFIG, -1);
  downwardTap.down(0);
  assert.equal(
    downwardTap.up(10),
    CONFIG.steps[0],
    'a tap is positive with direction -1 as well'
  );
});
