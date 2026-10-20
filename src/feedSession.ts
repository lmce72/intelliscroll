/**
 * Which notes belong to the reading session started from the feed.
 *
 * A card opened from the feed is only the first step. Reading usually moves on
 * by following links inside that note, and each of those notes is just as much
 * a resurfaced note as the card itself — so it should offer the same rating
 * control. Membership therefore propagates through link navigation, however
 * many steps deep, and into whatever tab a link chooses to open.
 *
 * Propagation is deliberately driven by *clicks on internal links* rather than
 * by "any file opened while a member is active". The wider rule would also pull
 * in notes reached from the quick switcher, a bookmark, or a command while the
 * member sits in the background, which is not what following a link means.
 *
 * The destination is not resolved here. Reading view exposes a resolved
 * `href`, Live Preview exposes only the rendered link text (which may be an
 * alias), and resolving either by hand duplicates what Obsidian already does.
 * Instead a click inside a member arms the *next* file-open, which is the file
 * the click opened no matter how Obsidian spelled the link.
 *
 * This module deliberately imports nothing from the Obsidian runtime: the pane
 * lookup is injected, so the membership rules are testable without a vault.
 */

import type { PathRename } from './pathRename.ts';

/** How long a click's file-open still counts as that click. */
export const LINK_NAVIGATION_GRACE_MS = 2_000;

/**
 * Links Obsidian itself will follow.
 *
 * Reading view renders `a.internal-link` (with `data-href` and a resolved
 * `href`); Live Preview renders `span.cm-hmd-internal-link`. External links and
 * plain spans are left out so they cannot arm a navigation.
 */
const INTERNAL_LINK_SELECTOR =
  'a.internal-link, a[data-href], .cm-hmd-internal-link';

export interface FeedSessionOptions {
  /**
   * The path of the markdown pane containing this element, or null when the
   * element is not inside a note (sidebar, tab header, popover).
   */
  sourcePathFor(element: Element): string | null;
  /** Clock, injectable so expiry is testable. */
  now?(): number;
}

export class FeedSession {
  /** Notes whose panes should show the feed's rating control. */
  private readonly members = new Set<string>();

  /** When a tracked link click happened, until its file-open arrives. */
  private pendingSince: number | null = null;
  /** The note the tracked click was made in. */
  private pendingSource: string | null = null;

  private readonly watchedDocuments = new Set<Document>();
  private readonly sourcePathFor: (element: Element) => string | null;
  private readonly now: () => number;

  constructor(options: FeedSessionOptions) {
    this.sourcePathFor = options.sourcePathFor;
    this.now = options.now ?? (() => Date.now());
  }

  /** Add a note to the session. */
  mark(path: string): void {
    this.members.add(path);
  }

  has(path: string): boolean {
    return this.members.has(path);
  }

  /**
   * Follow a rename (or a folder rename) so an open note keeps its control.
   *
   * Without this the session would still remember the old path: the pane's
   * control would be swept away, and a note created later at the vacated path
   * would inherit the membership it never had.
   */
  rename(mapping: PathRename): void {
    const moves: Array<[string, string]> = [];
    for (const path of this.members) {
      const next = mapping.map(path);
      if (next !== null && next !== path) moves.push([path, next]);
    }
    for (const [from, to] of moves) {
      this.members.delete(from);
      this.members.add(to);
    }

    // A click can be in flight across a rename; keep its source pointing at the
    // note that actually moved.
    if (this.pendingSource !== null) {
      this.pendingSource = mapping.map(this.pendingSource) ?? this.pendingSource;
    }
  }

  /** Forget a deleted note. */
  forget(path: string): void {
    this.members.delete(path);
    if (this.pendingSource === path) {
      this.pendingSince = null;
      this.pendingSource = null;
    }
  }

  /** Forget every note below a deleted folder. */
  forgetUnder(folder: string): void {
    const prefix = `${folder}/`;
    for (const path of Array.from(this.members)) {
      if (path.startsWith(prefix)) this.members.delete(path);
    }
    if (this.pendingSource?.startsWith(prefix)) {
      this.pendingSince = null;
      this.pendingSource = null;
    }
  }

  /**
   * Watch a window's document for link clicks.
   *
   * Idempotent, so it is safe to call whenever a window appears. Capture phase
   * because a link's own handler stops propagation once it has opened the
   * target.
   */
  watchDocument(doc: Document): void {
    if (this.watchedDocuments.has(doc)) return;
    this.watchedDocuments.add(doc);
    // `mousedown` as well as `click`: Live Preview resolves a modified click
    // (Ctrl/Cmd-click for a new tab) while the button is still going down, and
    // arming only on `click` would miss the file-open that follows. Arming
    // twice for one gesture is harmless — the later timestamp simply wins.
    doc.addEventListener('mousedown', this.onLinkClick, true);
    doc.addEventListener('click', this.onLinkClick, true);
    // Middle-click opens a new tab without a `click` event.
    doc.addEventListener('auxclick', this.onLinkClick, true);
  }

  /**
   * Arm the next file-open when a link inside a member note is clicked.
   *
   * Exposed separately from the DOM handler so the rule can be tested without
   * a document.
   */
  noteLinkClicked(sourcePath: string | null): void {
    if (sourcePath === null || !this.members.has(sourcePath)) return;
    this.pendingSince = this.now();
    this.pendingSource = sourcePath;
  }

  /**
   * Fold an opened file into the session when it is the result of a tracked
   * link click. Returns true when membership changed.
   *
   * A click whose file-open never arrives simply expires; nothing else needs
   * to clear it.
   */
  noteFileOpened(path: string | null): boolean {
    const since = this.pendingSince;
    const source = this.pendingSource;
    this.pendingSince = null;
    this.pendingSource = null;

    if (since === null || path === null) return false;
    if (this.now() - since > LINK_NAVIGATION_GRACE_MS) return false;
    // Re-activating the note the click came from is not a step deeper.
    if (path === source) return false;
    if (this.members.has(path)) return false;

    this.members.add(path);
    return true;
  }

  /** Remove every listener and forget the session. */
  destroy(): void {
    for (const doc of this.watchedDocuments) {
      doc.removeEventListener('mousedown', this.onLinkClick, true);
      doc.removeEventListener('click', this.onLinkClick, true);
      doc.removeEventListener('auxclick', this.onLinkClick, true);
    }
    this.watchedDocuments.clear();
    this.members.clear();
    this.pendingSince = null;
    this.pendingSource = null;
  }

  private readonly onLinkClick = (event: MouseEvent): void => {
    // Primary click and middle-click (which opens a new tab) only.
    if (event.button !== 0 && event.button !== 1) return;

    // Duck-typed rather than `instanceof Element`: an event from a popout
    // window carries that window's own `Element` constructor, so a cross-realm
    // instanceof check would reject every click in it.
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;

    const link = target.closest(INTERNAL_LINK_SELECTOR);
    if (link === null) return;

    this.noteLinkClicked(this.sourcePathFor(link));
  };
}
