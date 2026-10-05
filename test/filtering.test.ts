import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileFilter,
  fileNameOf,
  matchesAnyFolder,
  matchesFolder,
  normalizeFolderList,
  normalizeTagList,
  passesMode,
  passesTagRule,
} from '../src/filtering.ts';
import { defaultFilterPreset } from '../src/presets.ts';
import type { FilterPreset } from '../src/types.ts';

function preset(overrides: Partial<FilterPreset> = {}): FilterPreset {
  return { ...defaultFilterPreset(), ...overrides };
}

// ─── mode semantics ────────────────────────────────────────────────────────

test('blacklist excludes on a match and allows everything when empty', () => {
  assert.equal(passesMode('blacklist', true), false, 'matched -> excluded');
  assert.equal(passesMode('blacklist', false), true, 'unmatched -> allowed');
});

test('whitelist allows only on a match, and empty allows nothing', () => {
  assert.equal(passesMode('whitelist', true), true, 'matched -> allowed');
  assert.equal(passesMode('whitelist', false), false, 'unmatched -> excluded');

  // This is how "no standalone files at all" is expressed, and it is what the
  // old `showNonMarkdownFiles: false` migrates to.
  const filter = compileFilter(
    preset({ fileTypes: { mode: 'whitelist', values: [] } })
  );
  assert.equal(filter.passesPath('anything.pdf'), false);
  assert.equal(filter.passesPath('note.md'), false);
});

// ─── folders ───────────────────────────────────────────────────────────────

test('folder matching is a case-insensitive path prefix', () => {
  assert.equal(matchesFolder('Notes/a.md', 'Notes'), true);
  assert.equal(matchesFolder('notes/a.md', 'NOTES'), true);
  assert.equal(matchesFolder('Notes', 'Notes'), true);
  assert.equal(matchesFolder('Other/a.md', 'Notes'), false);
});

test('a folder does not match a sibling that merely starts with its name', () => {
  // The `${folder}/` guard is the whole reason this test exists.
  assert.equal(matchesFolder('Notes-archive/a.md', 'Notes'), false);
  assert.equal(matchesAnyFolder('Notes-archive/a.md', ['Notes']), false);
  assert.equal(matchesAnyFolder('Notes/deep/a.md', ['Notes']), true);
});

test('folder paths are normalized without trailing slashes or blanks', () => {
  assert.deepEqual(normalizeFolderList([' Notes/ ', 'A/B//', '', '   ']), [
    'Notes',
    'A/B',
  ]);
});

// ─── globs ─────────────────────────────────────────────────────────────────

test('globs match the full path and the bare filename', () => {
  const byFolder = compileFilter(
    preset({ globs: { mode: 'blacklist', values: ['Daily/*'] } })
  );
  assert.equal(byFolder.passesPath('Daily/2026-01-01.md'), false);
  assert.equal(byFolder.passesPath('Notes/2026-01-01.md'), true);

  const byName = compileFilter(
    preset({ globs: { mode: 'blacklist', values: ['*.draft.md'] } })
  );
  assert.equal(byName.passesPath('anywhere/deep/x.draft.md'), false);
  assert.equal(byName.passesPath('anywhere/deep/x.md'), true);
});

test('fileNameOf takes everything after the last slash', () => {
  assert.equal(fileNameOf('a/b/c.md'), 'c.md');
  assert.equal(fileNameOf('c.md'), 'c.md');
});

// ─── tags ──────────────────────────────────────────────────────────────────

test('tag values are compared without a leading # and case-insensitively', () => {
  assert.deepEqual(normalizeTagList([' #Work ', 'Draft']), ['work', 'draft']);

  const tags = new Set(['work', 'draft']);
  assert.equal(passesTagRule({ mode: 'blacklist', values: ['#Work'] }, tags), false);
  assert.equal(passesTagRule({ mode: 'blacklist', values: ['absent'] }, tags), true);
  assert.equal(passesTagRule({ mode: 'whitelist', values: ['work'] }, tags), true);
  assert.equal(passesTagRule({ mode: 'whitelist', values: ['absent'] }, tags), false);
});

test('an empty blacklist makes tag matching inert so it can be skipped', () => {
  const filter = compileFilter(preset({ tags: { mode: 'blacklist', values: [] } }));
  assert.equal(filter.tagsInert, true);

  // A whitelist is never inert, even when empty: empty excludes everything.
  const whitelist = compileFilter(
    preset({ tags: { mode: 'whitelist', values: [] } })
  );
  assert.equal(whitelist.tagsInert, false);
  assert.equal(whitelist.passesTags(new Set(['anything'])), false);
});

// ─── file types ────────────────────────────────────────────────────────────

test('file-type rules separate documents from images', () => {
  const noPdfs = compileFilter(
    preset({ fileTypes: { mode: 'blacklist', values: ['document'] } })
  );
  assert.equal(noPdfs.passesPath('paper.pdf'), false, 'pdf is a document');
  assert.equal(noPdfs.passesPath('book.epub'), false, 'epub is a document');
  assert.equal(noPdfs.passesPath('photo.png'), true, 'images survive');
  assert.equal(noPdfs.passesPath('note.md'), true, 'notes survive');

  const onlyImages = compileFilter(
    preset({ fileTypes: { mode: 'whitelist', values: ['image'] } })
  );
  assert.equal(onlyImages.passesPath('photo.png'), true);
  assert.equal(onlyImages.passesPath('paper.pdf'), false);
  // `note` is selectable precisely so "only images" can mean only images.
  assert.equal(onlyImages.passesPath('note.md'), false);
});

test('audio is a category of its own', () => {
  const noAudio = compileFilter(
    preset({ fileTypes: { mode: 'blacklist', values: ['audio'] } })
  );
  assert.equal(noAudio.passesPath('song.mp3'), false);
  assert.equal(noAudio.passesPath('clip.wav'), false);
  assert.equal(noAudio.passesPath('clip.mp4'), true, 'video is not audio');
});

// ─── compiled key ──────────────────────────────────────────────────────────

test('the index key covers index-affecting fields only', () => {
  const base = compileFilter(preset());
  const same = compileFilter(preset());
  assert.equal(base.key, same.key, 'identical presets share a key');

  const changedSearch = compileFilter(preset({ searchQuery: 'tag:#work' }));
  assert.notEqual(changedSearch.key, base.key, 'search re-indexes');

  const changedFileTypes = compileFilter(
    preset({ fileTypes: { mode: 'blacklist', values: ['image'] } })
  );
  assert.notEqual(changedFileTypes.key, base.key, 'file types re-index');

  // `includeMediaOnlyNotes` is applied in the view, so including it in the key
  // would turn a cheap toggle into a full vault re-index.
  const changedMediaOnly = compileFilter(
    preset({ includeMediaOnlyNotes: false })
  );
  assert.equal(
    changedMediaOnly.key,
    base.key,
    'a view-time toggle must not force a re-index'
  );
});

test('trimming whitespace-only search changes does not re-index', () => {
  const a = compileFilter(preset({ searchQuery: 'tag:#work' }));
  const b = compileFilter(preset({ searchQuery: '  tag:#work  ' }));
  assert.equal(a.key, b.key, 'surrounding whitespace is not a real change');
});
