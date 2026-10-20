import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedSession, LINK_NAVIGATION_GRACE_MS } from '../src/feedSession.ts';
import { pathRename } from '../src/pathRename.ts';

function makeSession(): {
  session: FeedSession;
  advance(ms: number): void;
} {
  let now = 1_000;
  const session = new FeedSession({
    // The pane lookup is irrelevant to the membership rules under test.
    sourcePathFor: () => null,
    now: () => now,
  });
  return {
    session,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a marked note is a member and an unmarked one is not', () => {
  const { session } = makeSession();
  session.mark('feed-note.md');

  assert.equal(session.has('feed-note.md'), true);
  assert.equal(session.has('unrelated.md'), false);
});

test('a link clicked inside a member note adds the note it opens', () => {
  const { session } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('a.md');
  assert.equal(session.noteFileOpened('b.md'), true);
  assert.equal(session.has('b.md'), true);
});

test('a link clicked outside a member note adds nothing', () => {
  const { session } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('sidebar-note.md');
  assert.equal(session.noteFileOpened('b.md'), false);
  assert.equal(session.has('b.md'), false);
});

test('membership travels through as many link steps as the reader takes', () => {
  const { session } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('a.md');
  session.noteFileOpened('b.md');
  session.noteLinkClicked('b.md');
  session.noteFileOpened('c.md');

  assert.deepEqual(
    ['a.md', 'b.md', 'c.md'].filter((path) => session.has(path)),
    ['a.md', 'b.md', 'c.md']
  );
});

test('a click whose file-open never arrives expires', () => {
  const { session, advance } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('a.md');
  advance(LINK_NAVIGATION_GRACE_MS + 1);

  assert.equal(session.noteFileOpened('b.md'), false);
  assert.equal(session.has('b.md'), false);
});

test('one click arms one open, not every open that follows', () => {
  const { session } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('a.md');
  session.noteFileOpened('b.md');

  assert.equal(session.noteFileOpened('c.md'), false);
  assert.equal(session.has('c.md'), false);
});

test('opening the clicked note again is not a step deeper', () => {
  const { session } = makeSession();
  session.mark('a.md');

  session.noteLinkClicked('a.md');
  assert.equal(session.noteFileOpened('a.md'), false);
  assert.equal(session.has('a.md'), true, 'it stays a member');
});

test('a file-open with no click behind it adds nothing', () => {
  const { session } = makeSession();
  session.mark('a.md');

  assert.equal(session.noteFileOpened('quick-switcher.md'), false);
  assert.equal(session.has('quick-switcher.md'), false);
});

test('a note already in the session is not added twice', () => {
  const { session } = makeSession();
  session.mark('a.md');
  session.mark('b.md');

  session.noteLinkClicked('a.md');
  assert.equal(session.noteFileOpened('b.md'), false);
  assert.equal(session.has('b.md'), true);
});

test('membership follows a file rename', () => {
  const { session } = makeSession();
  session.mark('old.md');

  session.rename(pathRename('old.md', 'new.md', false));

  assert.equal(session.has('old.md'), false);
  assert.equal(session.has('new.md'), true);
});

test('membership follows a folder rename without taking lookalike siblings', () => {
  const { session } = makeSession();
  session.mark('Notes/a.md');
  session.mark('Notes-archive/b.md');

  session.rename(pathRename('Notes', 'Archive', true));

  assert.equal(session.has('Notes/a.md'), false);
  assert.equal(session.has('Archive/a.md'), true);
  assert.equal(session.has('Notes-archive/b.md'), true);
});

test('a click in flight follows its note across a rename', () => {
  const { session } = makeSession();
  session.mark('old.md');
  session.noteLinkClicked('old.md');

  session.rename(pathRename('old.md', 'new.md', false));

  assert.equal(session.noteFileOpened('target.md'), true);
  assert.equal(session.has('target.md'), true);
});

test('a deleted note leaves the session, and a folder takes its children', () => {
  const { session } = makeSession();
  session.mark('a.md');
  session.mark('Notes/b.md');
  session.mark('Notes/c.md');

  session.forget('a.md');
  session.forgetUnder('Notes');

  assert.equal(session.has('a.md'), false);
  assert.equal(session.has('Notes/b.md'), false);
  assert.equal(session.has('Notes/c.md'), false);
});
