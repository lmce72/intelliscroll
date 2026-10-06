import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DWELL_HIGH_MS,
  DWELL_LOW_MS,
  MAX_DWELL_SAMPLE_MS,
  SENSITIVITY_THRESHOLDS,
  clampDwell,
  thresholdDemand,
  gradeEngagement,
  ratingForVerdict,
  thresholdsFor,
  type EngagementSignals,
} from '../src/grading.ts';
import {
  AUTO_RATING,
  SENSITIVITIES,
  SENSITIVITY_OPTIONS,
  type Sensitivity,
  type SensitivityThresholds,
} from '../src/types.ts';

/** Dwell samples spanning the interesting boundaries plus garbage inputs. */
const DWELL_SAMPLES = [
  -1000, 0, 1, 999, DWELL_LOW_MS - 1, DWELL_LOW_MS, DWELL_HIGH_MS - 1,
  DWELL_HIGH_MS, 60_000, MAX_DWELL_SAMPLE_MS * 10, Number.NaN,
  Number.POSITIVE_INFINITY,
];

/**
 * The old hand-written `switch`, kept here as an oracle so the move to data
 * cannot have quietly changed how any preset classifies anything.
 */
function referenceGrade(
  signals: EngagementSignals,
  sensitivity: Exclude<Sensitivity, 'custom'>
): 'engaged' | 'unengaged' {
  if (signals.opened) return 'engaged';
  const dwell = clampDwell(signals.dwellMs);
  switch (sensitivity) {
    case 'conservative':
      return 'unengaged';
    case 'aggressive':
      return dwell >= DWELL_LOW_MS ? 'engaged' : 'unengaged';
    case 'medium':
    default:
      return dwell >= DWELL_HIGH_MS ? 'engaged' : 'unengaged';
  }
}

test('automatic grading can only ever produce the single auto rating', () => {
  // The central safety property: behaviour may decide *whether* a note was
  // engaged with, never how well it was recalled. Sweep the whole input space
  // and assert no negative rating can escape.
  for (const sensitivity of SENSITIVITY_OPTIONS) {
    for (const dwellMs of DWELL_SAMPLES) {
      for (const opened of [true, false]) {
        const rating = ratingForVerdict(
          gradeEngagement({ opened, dwellMs }, thresholdsFor(sensitivity))
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

test('ratingForVerdict has no branch that can produce a negative rating', () => {
  // Exhaust every verdict the grader can emit, including via malformed custom
  // thresholds, and assert the rating is only ever null or the single auto
  // rating. This is the one testable place the rule lives.
  const verdicts = ['engaged', 'unengaged'] as const;
  for (const verdict of verdicts) {
    const rating = ratingForVerdict(verdict);
    assert.ok(rating === null || rating === AUTO_RATING);
  }
  assert.equal(AUTO_RATING, 'good');

  const malformed = [
    { openedOnly: false, engagedMs: Number.NaN },
    { openedOnly: false, engagedMs: -1 },
    { openedOnly: false, engagedMs: Number.POSITIVE_INFINITY },
    { openedOnly: 'yes', engagedMs: 'soon' },
  ] as unknown as SensitivityThresholds[];
  for (const custom of malformed) {
    for (const opened of [true, false]) {
      const rating = ratingForVerdict(
        gradeEngagement({ opened, dwellMs: 0 }, thresholdsFor('custom', custom))
      );
      assert.ok(rating === null || rating === AUTO_RATING);
    }
  }
});

test('opening the note always counts, whatever the sensitivity', () => {
  for (const sensitivity of SENSITIVITY_OPTIONS) {
    assert.equal(
      gradeEngagement(
        { opened: true, dwellMs: 0 },
        thresholdsFor(sensitivity)
      ),
      'engaged',
      `${sensitivity}: an explicit open is the strongest available signal`
    );
  }
});

test('the conservative setting never trusts dwell time', () => {
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: 10 * 60 * 1000 },
      thresholdsFor('conservative')
    ),
    'unengaged'
  );
});

test('the medium setting requires a long dwell', () => {
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: DWELL_HIGH_MS - 1 },
      thresholdsFor('medium')
    ),
    'unengaged'
  );
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: DWELL_HIGH_MS },
      thresholdsFor('medium')
    ),
    'engaged'
  );
});

test('the aggressive setting accepts any real dwell', () => {
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: DWELL_LOW_MS - 1 },
      thresholdsFor('aggressive')
    ),
    'unengaged'
  );
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: DWELL_LOW_MS },
      thresholdsFor('aggressive')
    ),
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
      thresholdsFor('aggressive')
    ),
    'engaged',
    'a clamped sample still counts as engaged rather than throwing'
  );
});

test('each preset resolves to the thresholds it advertises', () => {
  // Asserted against the real constants, not copies, so the displayed numbers
  // cannot drift from the ones the grader uses.
  assert.deepEqual(SENSITIVITY_THRESHOLDS.conservative, {
    openedOnly: true,
    engagedMs: DWELL_HIGH_MS,
  });
  assert.deepEqual(SENSITIVITY_THRESHOLDS.medium, {
    openedOnly: false,
    engagedMs: DWELL_HIGH_MS,
  });
  assert.deepEqual(SENSITIVITY_THRESHOLDS.aggressive, {
    openedOnly: false,
    engagedMs: DWELL_LOW_MS,
  });

  for (const sensitivity of SENSITIVITIES) {
    assert.deepEqual(
      thresholdsFor(sensitivity),
      SENSITIVITY_THRESHOLDS[sensitivity as Exclude<Sensitivity, 'custom'>]
    );
  }
});

test('every preset classifies signals exactly as the old switch did', () => {
  // Direct before/after equivalence: the data table must not have changed any
  // decision the hand-written `switch` made.
  for (const sensitivity of SENSITIVITIES) {
    const preset = sensitivity as Exclude<Sensitivity, 'custom'>;
    for (const dwellMs of DWELL_SAMPLES) {
      for (const opened of [true, false]) {
        const signals = { opened, dwellMs };
        assert.equal(
          gradeEngagement(signals, thresholdsFor(sensitivity)),
          referenceGrade(signals, preset),
          `sensitivity=${sensitivity} dwell=${dwellMs} opened=${opened}`
        );
      }
    }
  }
});

test('custom honours explicit thresholds', () => {
  const thresholds = { openedOnly: false, engagedMs: 2000 };
  assert.deepEqual(thresholdsFor('custom', thresholds), thresholds);
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: 1999 }, thresholdsFor('custom', thresholds)),
    'unengaged'
  );
  assert.equal(
    gradeEngagement({ opened: false, dwellMs: 2000 }, thresholdsFor('custom', thresholds)),
    'engaged'
  );

  const openedOnly = { openedOnly: true, engagedMs: 1 };
  assert.equal(
    gradeEngagement(
      { opened: false, dwellMs: 10 * 60 * 1000 },
      thresholdsFor('custom', openedOnly)
    ),
    'unengaged'
  );
});

test('custom without thresholds falls back to medium', () => {
  assert.deepEqual(thresholdsFor('custom'), SENSITIVITY_THRESHOLDS.medium);
  assert.deepEqual(
    thresholdsFor('custom', undefined),
    SENSITIVITY_THRESHOLDS.medium
  );
});

test('malformed custom thresholds fall back instead of breaking scheduling', () => {
  const fallback = SENSITIVITY_THRESHOLDS.medium;
  // Each of these would otherwise produce `NaN` comparisons that are always
  // false, quietly freezing the schedule.
  const cases = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ];
  for (const engagedMs of cases) {
    const resolved = thresholdsFor('custom', { openedOnly: false, engagedMs });
    assert.equal(resolved.engagedMs, fallback.engagedMs, `engagedMs=${engagedMs}`);
  }

  // Non-boolean / non-numeric fields are ignored rather than trusted.
  const wrongTypes = {
    openedOnly: 'yes',
    engagedMs: 'soon',
  } as unknown as SensitivityThresholds;
  assert.deepEqual(thresholdsFor('custom', wrongTypes), fallback);
});

test('thresholdDemand reports the real numbers, not copies', () => {
  // Data, not a sentence: the wording belongs to the i18n table, and a module
  // returning English frame text would put an untranslatable phrase on a
  // Chinese settings page.
  const medium = thresholdDemand(thresholdsFor('medium'));
  assert.deepEqual(medium, { kind: 'dwell', ms: DWELL_HIGH_MS });
  assert.equal(medium.kind === 'dwell' && medium.ms, DWELL_HIGH_MS);

  const aggressive = thresholdDemand(thresholdsFor('aggressive'));
  assert.equal(aggressive.kind === 'dwell' && aggressive.ms, DWELL_LOW_MS);

  // An opened-only threshold has no dwell requirement at all, rather than a
  // sentinel the caller would have to know to ignore.
  assert.deepEqual(thresholdDemand(thresholdsFor('conservative')), {
    kind: 'openedOnly',
  });
});

test('SENSITIVITY_OPTIONS lists the presets first and custom last', () => {
  assert.deepEqual(SENSITIVITY_OPTIONS, [...SENSITIVITIES, 'custom']);
  assert.deepEqual(SENSITIVITIES, ['conservative', 'medium', 'aggressive']);
});
