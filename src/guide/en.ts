import type { GuideSection } from '../guide.ts';

/**
 * The algorithm guide (English), translated from `./zh.ts`.
 *
 * Every number in here was measured against the shipped `ts-fsrs` and is
 * reproduced in `test/guide.test.ts`, so the guide cannot quietly drift from
 * the behaviour it describes.
 */
export const sections: readonly GuideSection[] = [
  {
    id: 'why',
    title: 'Why this guide exists',
    blocks: [
      {
        kind: 'p',
        text:
          'What this plugin does is schedule your own notes on a forgetting curve, so they come back just as you are about to forget them. It does not write to your notes or change them — all scheduling state lives in the plugin’s own sidecar files.',
      },
      {
        kind: 'p',
        text:
          'The problem is that a system scheduling on a forgetting curve is asking you to trust it with something you cannot inspect directly. You see a card and a number of days; you cannot see what the model behind them is thinking. So “trust me” is not an adequate answer.',
      },
      {
        kind: 'p',
        text:
          'This guide is the answer that was owed. It sets out what the model is; what actually happens when you press a rating; which of the numbers on screen the model computed and which are the scheduler rounding; and when the whole system stops carrying any information.',
      },
      {
        kind: 'note',
        text:
          'By the end you should be able to work out for yourself why a card’s interval is 4 days rather than 40; why three ratings sometimes look like they do the same thing; and which knob to turn to change intervals.',
      },
    ],
  },

  {
    id: 'model',
    title: '1. The FSRS model has three quantities',
    blocks: [
      {
        kind: 'p',
        text:
          'The plugin uses FSRS-6 by default, through the ts-fsrs library. The whole model turns on three numbers; once you understand them, every later phenomenon here can be derived from them.',
      },
      { kind: 'h', text: 'Stability (S)' },
      {
        kind: 'p',
        text:
          'Measured in days. It is defined as the interval at which your chance of recalling the note is exactly 90%. That is not approximate; it is the definition — FSRS uses it to calibrate how firmly something is remembered.',
      },
      {
        kind: 'note',
        text:
          'Hold on to that definition and you can answer half the questions that follow yourself. At 90% retention the interval is S itself; lower retention to 85% and the interval becomes 1.9 times S.',
      },
      { kind: 'h', text: 'Difficulty (D)' },
      {
        kind: 'p',
        text:
          'Ranges from 1 to 10. It decides how fast stability grows: for easy material S rises further with each successful review, for hard material it rises less. Your ratings adjust it — rating a note Hard pushes it up.',
      },
      { kind: 'h', text: 'Retrievability (R)' },
      {
        kind: 'p',
        text:
          'The chance you can still recall it right now, from 0 to 1. It is decided by S together with how long it has been since the last review, following the forgetting curve:',
      },
      {
        kind: 'code',
        text: 'R(t, S) = (1 + factor × t / S) ^ decay\n\nFSRS-6: decay = −0.1542, factor = 0.98034649',
      },
      {
        kind: 'p',
        text:
          'Substituting t = S gives R = 0.9, which is what the definition — S is the interval at 90% retention — looks like inside the formula.',
      },
      {
        kind: 'note',
        text:
          'One easy place to go wrong: TS-FSRS 5.4.2 uses the FSRS-6 parameters (decay = −0.1542), not the FSRS-5 ones (−0.5). Much of the secondhand material online gives the FSRS-5 formula; put it in and every retention value comes out wrong except the 0.90 point.',
      },
    ],
  },

  {
    id: 'press',
    title: '2. What actually happens when you press a rating',
    blocks: [
      {
        kind: 'p',
        text:
          'This is the most important section in the guide. A rating passes through the eight steps below in order, and not one of them can be skipped.',
      },
      {
        kind: 'ol',
        items: [
          'Read the card’s current state: stability S, difficulty D, and the time of the last review, last_review.',
          'Work out how many days have passed since that review. Note that this step rounds to whole days — see the next section.',
          'Use the forgetting curve and that number of days to compute retrievability R right now.',
          'Update stability from the rating you gave: this yields the new S′.',
          'Update difficulty from the rating: this yields the new D′.',
          'Compute the ideal interval: ideal interval = S′ × interval modifier(retention).',
          'Clamp the ideal interval into the legal range: round it to the nearest whole day, then clamp it into [1, maximum interval].',
          'Finally, enforce the tier increase: guarantee that each higher rating is at least one day beyond the one below it.',
        ],
      },
      { kind: 'h', text: 'The rounding in step 2, and why it matters so much' },
      {
        kind: 'p',
        text:
          'When ts-fsrs works out how long has passed, it counts UTC calendar-day boundaries, and the result is a whole number. That is, 1.4 hours and 20 hours since the last review both come out as 0 days; 25 hours comes out as 1 day.',
      },
      {
        kind: 'p',
        text:
          'Put 0 days into the forgetting curve and R = 1, meaning you remember it with certainty. In the term FSRS uses to update stability there is a factor exp((1 − R) × w) − 1. When R = 1 that factor is exactly 0, so the whole growth term is multiplied to zero.',
      },
      {
        kind: 'note',
        text:
          'The consequence: rate a note twice within the same UTC calendar day and Hard, Good and Easy all produce identical stability — the model has no new information to work with, and it honestly learns nothing. Only Again takes a different formula and gives a different value.',
      },
      { kind: 'h', text: 'The interval modifier in step 6' },
      {
        kind: 'p',
        text:
          'The interval modifier translates retention into how many times longer the interval becomes. By definition it is exactly 1.0000 at 90% retention, which is what makes S equal to the interval at 90% retention.',
      },
      {
        kind: 'table',
        head: ['Desired retention', 'Interval modifier', 'Meaning'],
        rows: [
          ['0.70', '9.2879', 'Intervals are 9.3 times S; the fewest reviews'],
          ['0.85', '1.9064', 'Intervals are 1.9 times S'],
          ['0.90', '1.0000', 'The interval is S itself (the definition point)'],
          ['0.95', '0.4026', 'Intervals are 40% of S'],
          ['0.99', '0.0687', 'Intervals are 6.9% of S; reviews are very dense'],
        ],
      },
      { kind: 'h', text: 'The two actions in step 7, and why their order cannot be reversed' },
      {
        kind: 'p',
        text:
          'First the interval is clamped into [1, maximum interval], and only then does step 8 enforce the increases. That order has an important consequence: the increases run after the clamp, so they can push the result outside the maximum interval.',
      },
      {
        kind: 'code',
        text:
          'Source: node_modules/ts-fsrs/dist/index.mjs\n\n' +
          '  // Step 7: the clamp (with a one-day hard floor)\n' +
          '  next_interval(s, elapsed_days) {\n' +
          '    const newInterval = Math.min(\n' +
          '      Math.max(1, Math.round(s * this.intervalModifier)),\n' +
          '      this.param.maximum_interval\n' +
          '    );\n' +
          '    return this.apply_fuzz(newInterval, elapsed_days);\n' +
          '  }\n\n' +
          '  // Step 8: the increase enforcement (lines 1266–1269)\n' +
          '  again_interval = Math.min(again_interval, hard_interval);\n' +
          '  hard_interval  = Math.max(hard_interval,  again_interval + 1);\n' +
          '  good_interval  = Math.max(good_interval,  hard_interval  + 1);\n' +
          '  easy_interval  = Math.max(easy_interval,  good_interval  + 1);',
      },
      {
        kind: 'note',
        text:
          'So a maximum interval of 30 actually yields 30 / 31 / 32, and the real ceiling is the value you set plus 2. Set 365 and you get 365 / 366 / 367.',
      },
    ],
  },

  {
    id: 'example',
    title: '3. One real rating, taken apart step by step',
    blocks: [
      {
        kind: 'p',
        text:
          'The walkthrough below uses a real card — stability 2.31 days, difficulty 2.12, last reviewed 1.4 hours ago — with a desired retention of 0.85 and a maximum interval of 30 days.',
      },
      {
        kind: 'example',
        title: 'Step 2: how long has passed',
        blocks: [
          {
            kind: 'p',
            text: '1.4 hours → 0 days (same UTC calendar day, rounded down).',
          },
        ],
      },
      {
        kind: 'example',
        title: 'Step 3: R right now',
        blocks: [
          { kind: 'p', text: 'R = (1 + 0.98034649 × 0 / 2.3065) ^ (−0.1542) = 1.0' },
        ],
      },
      {
        kind: 'example',
        title: 'Step 4: the new stability',
        blocks: [
          {
            kind: 'p',
            text:
              'R = 1 zeroes the growth factor, so the new stability for Hard, Good and Easy is still 2.3065; Again takes a different formula and comes out at 0.523.',
          },
        ],
      },
      {
        kind: 'example',
        title: 'Step 6: the ideal interval',
        blocks: [
          {
            kind: 'code',
            text:
              'Again:   0.523  × 1.9064 =  1.00 days\n' +
              'Hard:    2.3065 × 1.9064 =  4.40 days\n' +
              'Good:    2.3065 × 1.9064 =  4.40 days\n' +
              'Easy:    2.3065 × 1.9064 =  4.40 days',
          },
          {
            kind: 'p',
            text: 'Notice that the last three are identical — this is what the previous section meant by the model learning nothing.',
          },
        ],
      },
      {
        kind: 'example',
        title: 'Step 7: the clamp',
        blocks: [
          {
            kind: 'code',
            text:
              'Again:   round(1.00) = 1   clamped to [1,30] → 1\n' +
              'Hard:    round(4.40) = 4   clamped to [1,30] → 4\n' +
              'Good:    round(4.40) = 4   clamped to [1,30] → 4\n' +
              'Easy:    round(4.40) = 4   clamped to [1,30] → 4',
          },
        ],
      },
      {
        kind: 'example',
        title: 'Step 8: the increase enforcement',
        blocks: [
          {
            kind: 'code',
            text:
              'again = min(1, 4)              = 1\n' +
              'hard  = max(4, 1+1)            = 4\n' +
              'good  = max(4, 4+1)            = 5\n' +
              'easy  = max(4, 5+1)            = 6\n\n' +
              'Committed:  1 / 4 / 5 / 6 days',
          },
          {
            kind: 'note',
            text:
              'This is the key point: the tidy ladder you see — Hard 4 days, Good 5 days, Easy 6 days — comes entirely from step 8. The model gave all three of those ratings the same 4.40 days.',
          },
        ],
      },
    ],
  },

  {
    id: 'display',
    title: '4. What the two intervals on screen are',
    blocks: [
      {
        kind: 'p',
        text:
          'Each row of the rating popover reads “model value (schedules X)”, and the two numbers come from different places:',
      },
      {
        kind: 'ul',
        items: [
          'The model value = S′ × interval modifier, then clamped by the maximum interval, but not rounded and not subject to the one-day hard floor. It is what the model itself intends.',
          'The committed interval, X = the number of days actually written into the schedule once all eight steps have run.',
        ],
      },
      {
        kind: 'p',
        text:
          'When the two differ, both are shown; when they agree, only one number appears. That is deliberate. Showing only the committed interval would make the retention knob look completely inert (see the next section); showing only the model value would let a row reading “3.8 hours” turn into two days once you press it.',
      },
      {
        kind: 'table',
        head: ['Rating', 'Model value', 'Schedules'],
        rows: [
          ['Again', '1.0 days', '1 day (same, not shown separately)'],
          ['Hard', '4.4 days', '4 days'],
          ['Good', '4.4 days', '5 days'],
          ['Easy', '4.4 days', '6 days'],
        ],
      },
      {
        kind: 'p',
        text:
          'Those are measurements from the card in section 3. The model gives the last three ratings the same 4.4 days, while the schedule commits 4 / 5 / 6 days — the difference comes entirely from the increase enforcement in step 8 of section 2.',
      },
      {
        kind: 'note',
        text:
          'Interpolated rungs — the ones labelled “Tier N” — do not show a committed interval. They cannot be clicked and pressing one commits nothing, so claiming it would schedule something would be inventing it.',
      },
    ],
  },

  {
    id: 'retention',
    title: '5. Desired retention: the one knob that really controls interval length',
    blocks: [
      {
        kind: 'p',
        text:
          'Desired retention is the chance you want of still remembering a note when it comes up for review. Raise it and you review sooner, so intervals are shorter and reviews more frequent; lower it and you review later, so intervals are longer and you forget more.',
      },
      {
        kind: 'p',
        text:
          'Because it is a multiplier, its effect on every one of your notes is uniform and proportional — which is exactly why it makes a better throttle than the maximum interval.',
      },
      { kind: 'h', text: 'Common ranges' },
      {
        kind: 'table',
        head: ['Value', 'Suits', 'Cost'],
        rows: [
          ['0.70 – 0.80', 'You only need to find it again, not remember it', 'Intervals are long and much is forgotten'],
          ['0.85 – 0.90', 'The usual range for most people', 'Balanced'],
          ['0.90 – 0.95', 'You want to remember it fairly firmly', 'The review load rises noticeably'],
          ['0.95 – 0.99', 'Close to “must remember”', 'The review load rises steeply and intervals are squeezed very short'],
        ],
      },
      {
        kind: 'note',
        text:
          'Moving retention from 0.90 to 0.99 shrinks intervals to roughly 1/14.5. The relationship is not linear; the higher you go the steeper it gets — which is why the last few points are so expensive.',
      },
      { kind: 'h', text: 'The retention range is derived, not fixed' },
      {
        kind: 'p',
        text:
          'The retention control in settings is not a fixed 0.70–0.99; it is a window derived from the top-gap rule, which requires the second-highest rung to sit at least some number of days below the highest. Below the lower edge, the maximum interval pins the top few rungs to the same day; above the upper edge, the whole ladder is squeezed together. In both cases the rungs stop meaning anything.',
      },
      {
        kind: 'p',
        text:
          'The window is measured on a reference note reviewed three times as Good, not on the note you happen to be looking at; a given note can respond over a narrower span.',
      },
    ],
  },

  {
    id: 'cap',
    title: '6. Maximum interval: a guard rail, not a throttle',
    blocks: [
      {
        kind: 'p',
        text:
          'Maximum interval (1 to 3650 days, default 30) limits how far ahead a note can ever be scheduled. It is also the ceiling on how far a note you already know can be spaced.',
      },
      {
        kind: 'note',
        text:
          'It acts in two directions, and it is easy to see only one of them: lowering it cuts off long intervals, and raising it does no damage to short-term precision — because it only truncates the top of the ladder.',
      },
      { kind: 'h', text: 'Measured: the same cap at different levels of maturity' },
      {
        kind: 'p',
        text: 'At a retention of 0.85, the committed interval for each of the four ratings:',
      },
      {
        kind: 'table',
        head: ['Reviews', 'Stability S', 'Cap 30', 'Cap 3650'],
        rows: [
          ['2', '16', '4 / 30 / 31 / 32', '4 / 117 / 173 / 298 days'],
          ['4', '405', '13 / 30 / 31 / 32', '13 / 2028 / 2859 / 3650 days'],
          ['8', '14027', '30 / 31 / 32 / 33', '32 / 3650 / 3651 / 3652 days'],
        ],
      },
      {
        kind: 'p',
        text:
          'The cap only truncates the rungs that exceed it, so raising it can never shorten any interval — it buys back the whole long end. In the first two of the three rows the first rung is unchanged, because it is still below the cap; by the third row even the first rung is past 30 days, so it is truncated along with the rest.',
      },
      {
        kind: 'note',
        text:
          'A note you know well ought to come back after months or even years, and that is where the value of spaced repetition lies. Set the cap too low and that value is what you give up.',
      },
      { kind: 'h', text: 'It has another side effect: flattening the ladder' },
      {
        kind: 'p',
        text:
          'Because the clamp happens before the increases, every rung that exceeds the cap lands on the same number. Hard, Good and Easy then read as 30 / 31 / 32 — three ratings doing almost the same thing. The rating popover flags this case and says which setting to change.',
      },
    ],
  },

  {
    id: 'ladder',
    title: '7. Where the eight rungs come from',
    blocks: [
      {
        kind: 'p',
        text:
          'FSRS has only four ratings (Again / Hard / Good / Easy). The plugin expands them into eight displayed rungs: four native ones plus four interpolated ones.',
      },
      {
        kind: 'ul',
        items: [
          'A native grade (clickable): it has a rating behind it, and pressing it commits.',
          'An interpolated rung (not clickable, labelled “Tier N”): a preview marker only, there to show the spread of intervals more clearly.',
        ],
      },
      { kind: 'h', text: 'How the interpolation works' },
      {
        kind: 'p',
        text:
          'There are three gaps between the four native grades. The four extra rungs are allotted by each gap’s logarithmic width, so the widest gap gets the most; inside each gap they are cut in a geometric progression. Geometric rather than arithmetic because these are intervals: an arithmetic split would cram most of the rungs into the last few days of a long gap.',
      },
      {
        kind: 'p',
        text:
          'The widths are measured in model intervals, not committed intervals — the committed ones have already been through rounding and the increase enforcement, so dividing rungs by them would be like framing a forgery.',
      },
      {
        kind: 'example',
        title: 'Measured: a brand-new card (cap 365, retention 0.90)',
        blocks: [
          {
            kind: 'code',
            text:
              'Model intervals of the four native grades:  0.212 / 1.293 / 2.307 / 8.296 days\n' +
              'Expanded to eight:                          0.212 / 0.387 / 0.708 / 1.293\n' +
              '                                            1.727 / 2.307 / 4.374 / 8.296 days',
          },
          {
            kind: 'p',
            text:
              'All eight values are distinct — the interpolation really does add resolution rather than copying the four values out again.',
          },
        ],
      },
      {
        kind: 'note',
        text:
          'An interpolated rung commits nothing. To get precision beyond the four ratings you have to combine them: different retention values crossed with different levels of maturity give different ladders.',
      },
    ],
  },

  {
    id: 'silent',
    title: '8. When ratings stop being informative',
    blocks: [
      {
        kind: 'p',
        text: 'There are two situations in which some of the four ratings come out nearly or exactly the same. Neither is a bug; the model is reporting honestly.',
      },
      { kind: 'h', text: 'The first: rating twice within the same day' },
      {
        kind: 'p',
        text:
          'As section 2 describes, review within the same UTC calendar day and the elapsed time comes out as 0 days, R = 1, and the stability growth term goes to zero. Hard, Good and Easy then share a single stability, and the model draws no distinction between them.',
      },
      {
        kind: 'p',
        text:
          'Let a full day pass and it resolves itself. Measured on one card:',
      },
      {
        kind: 'table',
        head: ['Since the last review', 'Model interval for Hard / Good / Easy'],
        rows: [
          ['1.4 hours', '2.31 / 2.31 / 2.31 days (identical)'],
          ['1 day', '5.32 / 7.32 / 11.69 days'],
          ['5 days', '11.85 / 18.17 / 32.01 days'],
          ['20 days', '20.64 / 32.79 / 59.39 days'],
        ],
      },
      {
        kind: 'p',
        text: '(Retention 0.90, cap 30 days.)',
      },
      {
        kind: 'note',
        text:
          'How to tell: if you have rated a note and then immediately open the rating popover again, and three rungs read as the same number, the model is telling you it has no new information today. Come back tomorrow.',
      },
      { kind: 'h', text: 'The second: flattened by the maximum interval' },
      {
        kind: 'p',
        text:
          'A mature note wants intervals far beyond the cap, so every high rung is truncated to the same number. This one is fixable: raise the maximum interval. The rating popover flags this case at the top.',
      },
    ],
  },

  {
    id: 'grading',
    title: '9. What automatic grading can and cannot do',
    blocks: [
      {
        kind: 'p',
        text:
          'There are three grading modes: automatic only, automatic with manual override, and manual only. Under automatic grading, the plugin judges whether you properly looked at a card from how long you spent on it.',
      },
      {
        kind: 'note',
        text:
          'The most important constraint: automatic grading only ever produces one value, Good. Behaviour can distinguish engaged from unengaged, but it cannot tell whether recall was easy or effortful. In the published research, behavioural proxies agree with users’ own ratings only about 65% of the time, and no study can infer recall quality from reading behaviour at all.',
      },
      { kind: 'h', text: 'The three sensitivity levels' },
      {
        kind: 'table',
        head: ['Sensitivity', 'Counts as engaged when'],
        rows: [
          ['Conservative', 'Only opening the note counts; time on screen counts for nothing'],
          ['Medium', '15 seconds on screen counts (the default)'],
          ['Aggressive', '3 seconds on screen counts'],
        ],
      },
      {
        kind: 'p',
        text:
          'There is also a Custom option, where you set the thresholds yourself.',
      },
      { kind: 'h', text: 'A skip is not a failure' },
      {
        kind: 'p',
        text:
          'When a card is scrolled past without a rating, the plugin does not treat it as Again. A skip means the note was not reviewed, not that reviewing it failed. Feeding skips to the scheduler as failures would manufacture lapses out of nothing, raise difficulty and drive stability down, producing a spiral in which the more you skip a note the more often it is shown, and the more often it is shown the more you skip it.',
      },
      {
        kind: 'p',
        text:
          'What the plugin does with a skip is give the note a small priority bonus at selection time, so it gets a second chance soon, while leaving its schedule completely untouched. That bonus also decays over time; otherwise it would become a permanent surcharge.',
      },
    ],
  },

  {
    id: 'selection',
    title: '10. How the feed picks these twenty',
    blocks: [
      {
        kind: 'p',
        text:
          'Scheduling decides when a note is due; selection decides which notes go into this batch. The two are separate.',
      },
      { kind: 'h', text: 'Priority' },
      {
        kind: 'code',
        text:
          'Priority = days overdue\n' +
          '         + unengaged bonus (1 day, decaying linearly over a 3-day window)\n' +
          '         + random jitter (0 to 1 day)',
      },
      {
        kind: 'ul',
        items: [
          'Days overdue: the more a note is due, the further forward it sorts.',
          'The unengaged bonus: a note you scrolled past without rating gets a little near-term priority.',
          'The random jitter: without it, the feed degenerates into a list sorted strictly by due date and loses the feel of scrolling. One day of jitter leaves clearly overdue notes winning reliably while near-ties shuffle.',
        ],
      },
      { kind: 'h', text: 'Two guard rails' },
      {
        kind: 'ul',
        items: [
          'The explore quota: every batch reserves a fixed 25% for notes that have never been reviewed. Without it, a backlog of overdue old notes would fill every batch forever and most never-reviewed notes would never get a chance to be seen — a cold-start starvation loop.',
          'The recency cap: notes seen in the last seven days take at most 20% of a batch.',
        ],
      },
      { kind: 'h', text: 'The 30-minute cooldown' },
      {
        kind: 'p',
        text:
          'A note you have just seen will not appear again for 30 minutes. But there are two exemptions and exceptions:',
      },
      {
        kind: 'ul',
        items: [
          'A note you rated after seeing it is not held back by the cooldown — you have already said when you want to see it again, and the schedule outranks a fixed delay. This is what lets the one-minute rung take effect at all.',
          'If the filters are so tight that the entire pool is cooling down, the plugin repeats notes that are still cooling rather than handing you an empty list.',
        ],
      },
    ],
  },

  {
    id: 'algorithms',
    title: '11. The trade-offs between the four algorithms',
    blocks: [
      {
        kind: 'p',
        text: 'The plugin ships with four scheduling algorithms, switched by preset.',
      },
      {
        kind: 'table',
        head: ['Algorithm', 'Suits', 'Notes'],
        rows: [
          [
            'Off',
            'You want no scheduling at all, only a shuffled feed',
            'Reproduces the upstream plugin’s original shuffle bit for bit. No ratings, no intervals.',
          ],
          [
            'FSRS-6',
            'Recommended',
            'A modern forgetting-curve model. It handles reviews that did not happen on time — reviewing a few days late degrades gracefully rather than miscomputing the interval.',
          ],
          [
            'SM-2',
            'You want a transparent baseline',
            'SuperMemo 2, published in 1990, a dozen lines of code and no fitted parameters. A known weakness: a single scalar, EF, carries both how hard the material is and how you have just performed, and only q=5 raises it, so repeated 3s and 4s drive it all the way down to its 1.3 floor.',
          ],
          [
            'Leitner',
            'You want the simplest thing that works',
            'A fixed interval ladder with two rungs, asking only remembered or not remembered.',
          ],
        ],
      },
      {
        kind: 'note',
        text:
          'FSRS is the default recommendation because a scroll feed cannot guarantee you will see a note on the day it comes due. FSRS is the only one of the four that models your chance of recall at an arbitrary moment, so seeing a note early or late is handled smoothly; SM-2 and Leitner multiply the timing error straight into the interval.',
      },
    ],
  },

  {
    id: 'mistakes',
    title: '12. Common misconceptions',
    blocks: [
      { kind: 'h', text: '“I set the maximum interval to 30, so my intervals got shorter”' },
      {
        kind: 'p',
        text:
          'Not quite. It does cut off the long end, but the price is that every high rung sticks to the cap. If your goal is for notes to come back more often, the knob you want is retention — it is a multiplier, it shortens every interval proportionally, and it does not destroy the separation between rungs.',
      },
      { kind: 'h', text: '“Why does my interval keep sitting at around 4 days?”' },
      {
        kind: 'p',
        text:
          'Most likely because the note is still young. Stability S is defined as the interval at 90% retention, and a note reviewed only once or twice usually has an S of only a few days. Measured: S ≈ 2.3 after one review, ≈ 16 after two, ≈ 90 after three. The interval rises on its own as the number of reviews grows.',
      },
      { kind: 'h', text: '“The three ratings seem to be doing the same thing”' },
      {
        kind: 'p',
        text:
          'Two possibilities: the note has already been reviewed today (see section 8), or it is mature enough that the maximum interval has flattened it. Wait a day for the first; raise the cap for the second.',
      },
      { kind: 'h', text: '“Raising retention should make intervals longer, right?”' },
      {
        kind: 'p',
        text:
          'The other way round. Retention is the chance you want of still remembering a note when it comes up for review — asking for a higher chance of recall means you must review sooner, so intervals are shorter and reviews more frequent. This is the easiest one to get backwards.',
      },
      { kind: 'h', text: '“Will automatic grading record a note I did not read as a failure?”' },
      {
        kind: 'p',
        text:
          'No. Automatic grading only ever produces Good and never produces a negative rating; with no engagement at all it records nothing and only affects selection priority.',
      },
    ],
  },

  {
    id: 'glossary',
    title: '13. Glossary',
    blocks: [
      {
        kind: 'table',
        head: ['Term', 'Meaning'],
        rows: [
          ['Stability S', 'The number of days until retention falls to 90%. The baseline for intervals.'],
          ['Difficulty D', '1–10. How hard the material is to remember, which decides how fast S grows.'],
          ['Retrievability R', 'The chance you can still recall it right now, 0–1.'],
          ['Interval modifier', 'The factor that converts retention into a multiple of the interval. 1.0000 at 0.90.'],
          ['Rung / ladder', 'The eight rows in the rating popover: four native plus four interpolated.'],
          ['Model interval', 'S′ × interval modifier, clamped by the cap but not rounded. What the model intends.'],
          ['Committed interval', 'The whole number of days actually written into the schedule after all eight steps.'],
          ['Due date', 'The moment a note should next appear.'],
          ['Overdue', 'How many days the current time is past the due date; decides selection priority.'],
          ['Unengaged', 'A card scrolled past without a rating. Not a failure, only a review that did not happen.'],
          ['Explore quota', 'A fixed 25% of every batch reserved for notes that have never been reviewed.'],
          ['Cooldown', 'A note just seen does not appear again for 30 minutes; a note you rated is exempt.'],
        ],
      },
    ],
  },

  {
    id: 'where',
    title: '14. Where to see what this guide describes',
    blocks: [
      {
        kind: 'ul',
        items: [
          'The rating popover: each row’s model interval, the interval it would commit, and warnings about defects in the ladder.',
          'Algorithm presets: algorithm, grading mode, sensitivity thresholds, retention, maximum interval, the top-gap rule, and the tier count.',
          'Display presets: interval unit (days / hours / minutes) and tier count.',
          'The settings page: the derived window for the retention control, and whether the current value falls outside it.',
        ],
      },
      {
        kind: 'note',
        text:
          'Every number in this guide is reproduced by a test (`test/guide.test.ts`), so if ts-fsrs changes behaviour one day, the test fails rather than letting the guide quietly become a lie.',
      },
    ],
  },
];
