# IntelliScroll

**Scroll your own notes, resurfaced on a forgetting curve.**

A fork of [Doomscroll](https://github.com/yaroshevych/doomscroll) that replaces
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

- **Four scheduling algorithms** — Off, FSRS-6, SM-2, Leitner — chosen in
  settings, overridable from the feed header for a single session
- **Per-card rating** when you want to correct the schedule by hand
- Shuffled card feed, not another list sorted by modification date
- Manual reshuffle when the current batch is not doing it for you
- Optional infinite scrolling that loads more notes as you reach the end
- At most 20% of each batch is reserved for notes seen in the last seven days,
  unless there are not enough unseen notes
- 30-minute cooldown before a note can appear again
- Back button for the batch you should not have reshuffled
- Filters for folders, tags, and filename patterns
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

### Resurfacing

- **Algorithm**: Off, FSRS-6, SM-2 or Leitner (default: Off, which reproduces
  the original shuffled feed exactly)
- **Grading**: Automatic only, automatic with manual override, or manual only
- **Automatic grading sensitivity**: How much evidence counts as engagement
- **Desired retention** (FSRS, 0.70–0.97): Target chance of still remembering a
  note when it returns. Raising it shortens intervals and increases the number
  of reviews steeply. 0.85–0.90 suits most people
- **Maximum interval** (FSRS): Longest gap in days before a note returns
- **Fuzz due dates** (FSRS): Spread due dates slightly so notes do not all
  return on the same day

### Feed

- **Batch size** (5 to 50): How many cards to show per reshuffle (default: 20)
- **Infinite scrolling**: Load more notes automatically as you reach the end;
  when enabled, batch size is fixed for incremental loading
- **Include media-only notes**: Show Markdown notes containing only images or
  other attachments (default: on)
- **Show non-Markdown files**: Show standalone vault files such as images,
  PDFs, and other attachments (default: on)
- **Simplified view**: Show concise previews with readable tables, links, and
  code; turn off for full Markdown formatting (default: on)
- **Preview size**: Show a small, medium, or large text preview (default:
  medium)
- **Exclude folders**: Folder paths to skip (one per line)
- **Exclude tags**: Tag names to skip without # (one per line)
- **Exclude filename patterns**: Patterns to skip (one per line, e.g., `_*` for drafts)
- **Search query**: Filter notes with Obsidian-style search syntax, such as `tag:#work` or `[status:Draft]`
- **Frontmatter image properties**: Property names to check for images (default: `cover`, `image`, `banner`)
- **Frontmatter properties before preview**: Property names to render before the note body (one per line)
- **Frontmatter properties after preview**: Property names to render after the note body (one per line)

## Usage

1. Click the gallery icon in the ribbon or use the "Open feed" command
2. Click any card to open the note in a new pane
3. Click the refresh icon when you want a new batch
4. Click the back arrow to return to the previous batch
5. Click the sliders icon to change the algorithm, grading or FSRS parameters
   on the spot — these last for the session only and are discarded when the
   feed is reopened, so it is safe to experiment
6. With resurfacing on and grading not set to automatic-only, each card carries
   a small gauge icon for rating it by hand
7. Adjust settings to tune which notes appear

## Development

```bash
npm run dev    # Watch mode for development
npm run build  # Production build
```

## License

MIT.

IntelliScroll is a fork of [Doomscroll](https://github.com/yaroshevych/doomscroll)
by Oleg Yaroshevych. The original copyright notice is retained in
[LICENSE](LICENSE); the feed, indexing, rendering and settings infrastructure
are his work, and this fork adds the scheduling engine on top.
