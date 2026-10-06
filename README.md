# IntelliScroll

**Scroll your own notes, resurfaced on a forgetting curve.**

A fork of Doomscroll that replaces
the pure-random shuffle with a spaced-repetition scheduler.

**Nothing is ever written into your notes.** No frontmatter properties, no
inline markers, no note IDs. Every scheduler already in the Obsidian ecosystem
either stamps state into your notes or requires you to author flashcards;
IntelliScroll keeps all state in its own sidecar files and treats the notes you
already wrote as the review material.

Installs as a separate plugin (`intelliscroll`), so it can sit alongside
Doomscroll rather than replacing it.

## Why a scheduler instead of a shuffle

In a single-author vault, "recently modified" is the *wrong* signal — the notes
you just wrote are the ones you already know. What matters is **time since you
last saw it**. That is a forgetting curve, not a recency feed.

So the feed keeps its scroll format and gains a scheduling engine behind it.
Four are available, and the default is `off`, which reproduces the original
shuffled feed exactly:

| Algorithm | Notes |
| --- | --- |
| `Off` | The original shuffle. Default, so upgrading changes nothing. |
| `FSRS-6` | Recommended. The only option that handles irregular review timing well — which a scroll feed inevitably produces. |
| `SM-2` | Classic SuperMemo 2. Transparent, no fitted parameters, included as a baseline. |
| `Leitner` | Fixed interval ladder, two grades. The simplest option. |

## What it deliberately does not do

- **It does not guess how well you remembered something.** Automatic grading
  can only ever conclude "engaged" or "not engaged"; it never invents a
  negative rating. Behavioural proxies match explicit self-ratings only about
  65% of the time, so a card you scroll past is recorded as *unseen*, not as
  failed — its schedule is untouched, only its priority rises. Feeding skips in
  as failures would fabricate lapses and spiral.
- **It is not a memory trainer.** Reviewing a whole note is re-reading, not
  active recall: expect roughly 40–50% one-week retention versus 60–70% for
  flashcards. This is a resurfacing layer for notes you do not want to
  formalise into cards.

## State and privacy

All scheduling state lives in two files beside the plugin
(`srs-log.ndjson` and `srs-snapshot.json`). Nothing is sent anywhere, and no
note file is modified — that is the property the test suite guards hardest.

## Features

<img src="https://github.com/user-attachments/assets/bbb240b2-e7bd-4ee7-af4e-b9f583d74629" height="400px" alt="The feed on mobile" />

- **Four scheduling algorithms** — Off, FSRS-6, SM-2, Leitner — chosen in an
  algorithm preset, overridable from the feed header for a single session
- **Named presets** for filters, algorithms, and display, plus a total preset
  that names one preset from each group
- **Per-card rating** when you want to correct the schedule by hand, with the
  four ratings coloured by what they mean: forgetting red, difficulty orange,
  success green, triviality blue
- **A per-note ignore list** for notes you never want to see again, written
  straight from a card
- **A floating control in any note opened from the feed** — the note stays
  marked while you read it, so you can rate it when you actually know, rather
  than at the moment you clicked the card
- **Ratings that show what they will do** before you press them, each labelled
  with the interval it would schedule, and the four FSRS grades expanded into
  eight tiers so you can pick something between "hard" and "good"
- **Hold to adjust faster** — a tap on the retention control moves it one
  0.0001 step; holding ramps up to 0.01 so the control is usable at all
- **Interface in English or 简体中文**, following Obsidian by default
- **Preset export and import** as JSON, to the clipboard or a vault file
- Shuffled card feed, not another list sorted by modification date
- Manual reshuffle when the current batch is not doing it for you
- Optional infinite scrolling that loads more notes as you reach the end
- At most 20% of each batch is reserved for notes seen in the last seven days,
  unless there are not enough unseen notes
- 30-minute cooldown before a note can appear again
- Back button for the batch you should not have reshuffled
- Filters for folders, tags, filename patterns, search queries, and file types
- Cover images from frontmatter, Markdown, or HTML
- Standalone vault attachments, including images that are not linked from a note
- Markdown previews with an optional Simplified view
- Lazy image loading
- Works on desktop and mobile
- Scroll position survives switching panes

## Installation

This installs as **IntelliScroll** (`intelliscroll`), so it can sit alongside
Doomscroll rather than replacing it.

1. Clone this repository into your vault's `.obsidian/plugins/` directory:
   ```
   git clone https://github.com/lmce72/intelliscroll .obsidian/plugins/intelliscroll
   ```

2. Navigate to the plugin directory and install dependencies:
   ```
   cd .obsidian/plugins/intelliscroll
   npm install
   ```

3. Build the plugin:
   ```
   npm run build
   ```

4. Enable the plugin in Obsidian settings under **Community plugins**.

## Settings

Settings are organised as **named presets** across four groups. A group can hold
any number of presets, and each group has one active preset. A **filter preset**
decides which notes are eligible for the feed, an **algorithm preset** decides
how they are scheduled, a **display preset** decides how they look, and a
**total preset** names one preset from each of the other three.

### Filter presets

Which notes are eligible for the feed.

- **Folders**, **tags**, and **filename patterns** (globs): each dimension is
  independently either a whitelist ("only these") or a blacklist ("exclude
  these"). The dimensions routinely want opposite treatment, so folders can be
  "only these" while tags are "exclude these"
- **Search query**: Filter notes with Obsidian-style search syntax, such as
  `tag:#work` or `[status:Draft]`
- **File types**: `image`, `document` (PDF, EPUB, docx…), `video`, `audio`,
  `other`, and `note` for Markdown notes. Documents and images are deliberately
  separate categories
- **Include media-only notes**: Show Markdown notes containing only images or
  other attachments (default: on)

Hiding standalone files keeps notes in the feed. The file-type rule is a
blacklist of the standalone kinds, not an empty whitelist, so turning it off
removes attachments without removing notes. This replaces the old "show
non-Markdown files" toggle.

File-type filtering is path-based, so a Markdown note that *embeds* a PDF
classifies as `note`, not `document`. It therefore targets standalone files —
which is where attachments actually appear as feed items.

### Algorithm presets

The scheduling engine.

- **Algorithm**: Off, FSRS-6, SM-2 or Leitner (default: Off, which reproduces
  the original shuffled feed exactly)
- **Grading**: Automatic only, automatic with manual override, or manual only
- **Automatic grading sensitivity**: How much evidence counts as engagement —
  conservative (only opening the note), medium (15 seconds of reading), or
  aggressive (3 seconds). Each preset's actual thresholds are shown next to it,
  and **Custom** lets you set your own
- **Desired retention** (FSRS, 0.70–0.97): Target chance of still remembering a
  note when it returns. Raising it shortens intervals and increases the number
  of reviews steeply. **This is the setting that controls how long intervals
  get** — see the note below on why the maximum interval is the wrong knob for
  that
- **Maximum interval** (FSRS): Longest gap in days before a note returns. FSRS
  applies this to *hard* and then pushes good and easy one day past it each, so
  the real ceiling is two days higher than the number you set
- **Smallest gap between the top two tiers** (FSRS): The second-highest tier
  must sit at least this many days below the highest. This is what bounds the
  retention control
- **Fuzz due dates** (FSRS): Spread due dates slightly so notes do not all
  return on the same day
- **Learning steps** (FSRS, default off): Use FSRS's 1-minute and 10-minute
  steps. This is the **only** way to schedule a note sooner than a day —
  FSRS's day-scale path floors at one day and cannot express anything shorter —
  so it is what puts a one-minute rung at the bottom of the ladder. It also
  means a note you push back comes round again inside the same sitting, which
  is why it is off by default

The retention control is bounded by the tier-gap rule above rather than by its
full 0.70–0.97 range, because outside that range the top tiers stop being
distinct. At a 30-day cap with a two-day gap the window is **0.9525–0.9700**.
Below it the cap clamps the top grades together; above it the whole ladder is
squeezed. The window is derived, not hardcoded — raising the cap or lowering
the gap widens it.

If your saved retention falls outside the window the settings page says so,
rather than quietly changing a scheduling value you chose.

**On the maximum interval:** shortening it does not shorten your intervals so
much as flatten the ladder. At a 30-day cap, any note reviewed more than twice
gives `30 / 31 / 32` days for hard, good and easy — three buttons that do the
same thing. Raise the cap and lower the retention instead.

### Display presets

How the feed looks and where a note opens.

- **Simplified view**: Show concise previews with readable tables, links, and
  code; turn off for full Markdown formatting (default: on)
- **Reduce animation**: Turn off card and transition animations
- **Preview size**: Show a small, medium, or large text preview (default:
  medium)
- **Where a note opens**: The pane a card opens into
- **Interval unit**: Show intervals in days, hours, or minutes. Sub-day
  intervals are common near the bottom of the ladder, where a days-only display
  would render several different choices as "1 day"
- **Rating tiers**: How many rungs the ladder shows, 4 or 8. Extra tiers are
  interpolated between the four real FSRS grades: the schedule is still updated
  from a real grade, but an interpolated tier's interval is not a value FSRS
  itself computed
- **Offer ratings after reading**: Expand the floating control into the ratings
  once a note opened from the feed has actually been read (default: off)
- **Frontmatter properties before preview** / **after preview**: Property names
  to render before or after the note body (one per line)
- **Frontmatter image properties**: Property names to check for images (default:
  `cover`, `image`, `banner`)

### Total presets

A total preset is a composite: it names one preset from each of the filter,
algorithm, and display groups.

### How presets behave

- **Inheritance is copy-on-inherit.** Copying a preset produces a fully
  independent one, and later edits to either copy do not affect the other.
  Copying a *total* preset also copies the three sub-presets it references, so
  the copy stays independent there too.
- **Migration.** Existing flat settings are migrated into a single preset named
  `Default` in each group, and a `Default` total is selected. The old flat
  fields are then removed, so **downgrading to an older build loses your
  configuration**.
- **Storage.** Presets live in `data.json`, which is gitignored, so they do not
  travel with the repository or sync via git. **Export and import** are how you
  move a configuration between machines or back it up: either copy the JSON to
  the clipboard or write it to a file in the vault. Importing is additive —
  existing presets are kept, colliding ids are reassigned, and colliding names
  are numbered.
- **Managing presets.** Each group has a section in settings for creating,
  renaming, copying and deleting presets. A group always keeps at least one, so
  the last in a group cannot be deleted.

## Usage

1. Click the gallery icon in the ribbon or use the "Open feed" command
2. Click any card to open the note in a new pane
3. Click the refresh icon when you want a new batch
4. Click the back arrow to return to the previous batch
5. Click the filter button in the feed header to switch filter presets, or
   adjust the current filter. A temporary change lasts for the session only and
   is discarded when the feed is reopened; the save button turns it into a named
   preset
6. Click the sliders icon to change the algorithm, grading or FSRS parameters
   on the spot — these last for the session only and are discarded when the
   feed is reopened, so it is safe to experiment
7. With resurfacing on and grading not set to automatic-only, each card carries
   two buttons: a gauge for rating it by hand, and an ignore button for notes
   you never want to see again
8. A note opened from the feed keeps a floating control in its pane for as long
   as the session lasts, so you can rate it after reading it
9. Select your presets in settings to tune which notes appear and how

## Development

```bash
npm run dev    # Watch mode for development
npm run build  # Production build
```

## License

MIT.

IntelliScroll is a fork of Doomscroll
by Oleg Yaroshevych. The original copyright notice is retained in
[LICENSE](LICENSE); the feed, indexing, rendering and settings infrastructure
are his work, and this fork adds the scheduling engine on top.
