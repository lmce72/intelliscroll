import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DWELL_HIGH_MS,
  DWELL_LOW_MS,
  MAX_DWELL_SAMPLE_MS,
  clampDwell,
  gradeEngagement,
  ratingForVerdict,
} from '../src/grading.ts';
import { AUTO_RATING, SENSITIVITIES } from '../src/types.ts';

test('automatic grading can only ever produce the single auto rating', () => {
  // The central safety property: behaviour may decide *whether* a note was
  // engaged with, never how well it was recalled. Sweep the whole input space
  // and assert no negative rating can escape.
  const dwellSamples = [
    -1000, 0, 1, 999, DWELL_LOW_MS - 1, DWELL_LOW_MS, DWELL_HIGH_MS - 1,
    DWELL_HIGH_MS, 60_000, MAX_DWELL_SAMPLE_MS * 10, Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  for (const sensitivity of SENSITIVITIES) {
    for (const dwellMs of dwellSamples) {
      for (const opened of [true, false]) {
        const rating = ratingForVerdict(
          gradeEngagement({ opened, dwellMs }, sensitivity)
        );
        assert.ok(
          rating === null || rating === AUTO_RATING,
          `sensitivity=${sensitivity} dwell=${dwellMs} opened=${opened} produced ${rating}`
        );
        assert.equal(AUTO_RATING, 'good');
      }
    }
  }
});

test('an unengaged verdict yields no review at all', () => {
  // A skip is the absence of a review, not a failed one.
  assert.equal(ratingForVerdict('unengaged'), null);
  assert.equal(ratingForVerdict('engaged'), 'good');
});

test('opening the note always counts, whatever the sensitivity', () => {
  for (const sensitivity of SENSITIVITIES) {
    assert.equal(
      gradeEngagement({ opened: true, dwellMs: 0 }, sensitivity),
      'engaged',
      `${sensitivity}: an explicit open is the strongest available signal`
    );
  }
});

test('the conservative setting never trusts dwell time', () => {
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: 10 * 60 * 1000 }, 'conservative'),
    'unengaged'
  );
});

test('the medium setting requires a long dwell', () => {
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: DWELL_HIGH_MS - 1 }, 'medium'),
    'unengaged'
  );
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: DWELL_HIGH_MS }, 'medium'),
    'engaged'
  );
});

test('the aggressive setting accepts any real dwell', () => {
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: DWELL_LOW_MS - 1 }, 'aggressive'),
    'unengaged'
  );
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: DWELL_LOW_MS }, 'aggressive'),
    'engaged'
  );
});

test('dwell samples are clamped and garbage becomes zero', () => {
  assert.equal(clampDwell(1000), 1000);
  assert.equal(clampDwell(-500), 0);
  // NaN and Infinity are bugs, not observations, so they collapse to "no dwell
  // seen" rather than to a full-length sample that would advance a schedule.
  assert.equal(clampDwell(Number.NaN), 0);
  assert.equal(clampDwell(Number.POSITIVE_INFINITY), 0);

  // A pane that was switched away from must not report hours of dwell: this
  // vault has a measured failure mode where requestAnimationFrame stops
  // firing while hidden.
  assert.equal(clampDwell(4 * 60 * 60 * 1000), MAX_DWELL_SAMPLE_MS);
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: 4 * 60 * 60 * 1000 },
      'aggressive'
    ),
    'engaged',
    'a clamped sample still counts as engaged rather than throwing'
  );
});
