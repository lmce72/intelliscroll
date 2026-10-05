import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentLabel,
  extensionsFor,
  fileCategory,
  isAudioPath,
  isImagePath,
  isPdfPath,
  isVideoPath,
} from '../src/media.ts';

test('recognizes supported standalone image paths', () => {
  assert.equal(isImagePath('Reference Images/diagram.PNG'), true);
  assert.equal(isImagePath('Reference Images/diagram.pdf'), false);
  assert.equal(isImagePath('diagram.png?width=400'), true);
});

test('labels standalone attachments by extension', () => {
  assert.equal(attachmentLabel('Reference Images/diagram.png'), '');
  assert.equal(attachmentLabel('README'), '📎 File attached');
  assert.equal(attachmentLabel('Reference/handout.pdf'), '');
});

test('recognizes PDF paths for inline previews', () => {
  assert.equal(isPdfPath('Documents/guide.PDF'), true);
  assert.equal(isPdfPath('Documents/guide.pdf?view=1'), true);
  assert.equal(isPdfPath('Documents/guide.epub'), false);
});

test('recognizes browser-friendly video paths for inline previews', () => {
  assert.equal(isVideoPath('Clips/demo.mp4'), true);
  assert.equal(isVideoPath('Clips/demo.WEBM'), true);
  assert.equal(isVideoPath('Clips/demo.mkv'), false);
  assert.equal(attachmentLabel('Clips/demo.mp4'), '');
});

// ─── filter categories ─────────────────────────────────────────────────────

test('classifies paths into filter categories', () => {
  assert.equal(fileCategory('a/photo.png'), 'image');
  assert.equal(fileCategory('a/paper.pdf'), 'document');
  assert.equal(fileCategory('a/book.epub'), 'document');
  assert.equal(fileCategory('a/clip.mp4'), 'video');
  assert.equal(fileCategory('a/song.mp3'), 'audio');
  assert.equal(fileCategory('a/archive.zip'), 'other');
  assert.equal(fileCategory('a/no-extension'), 'other');
});

test('markdown is a note, not a file category', () => {
  assert.equal(fileCategory('a/note.md'), 'note');
  assert.equal(fileCategory('a/note.MD'), 'note');
});

test('classification ignores query strings and fragments', () => {
  assert.equal(fileCategory('a/photo.png?width=400'), 'image');
  assert.equal(fileCategory('a/paper.pdf#page=3'), 'document');
});

test('audio has a predicate of its own', () => {
  assert.equal(isAudioPath('a/song.mp3'), true);
  assert.equal(isAudioPath('a/clip.wav'), true);
  assert.equal(isAudioPath('a/clip.mp4'), false);
  assert.equal(isAudioPath('a/note.md'), false);
});

test('every extension that renders inline classifies into its own category', () => {
  // The categories are deliberately WIDER than the rendering predicates (extra
  // extensions can be filtered without changing how anything renders), but
  // they must never be narrower — that would mean a file renders inline yet
  // classifies as `other`, so "no documents" would miss it.
  for (const extension of extensionsFor('image')) {
    if (isImagePath(`x.${extension}`)) {
      assert.equal(fileCategory(`x.${extension}`), 'image', extension);
    }
  }
  for (const extension of extensionsFor('document')) {
    if (isPdfPath(`x.${extension}`)) {
      assert.equal(fileCategory(`x.${extension}`), 'document', extension);
    }
  }
  for (const extension of extensionsFor('video')) {
    if (isVideoPath(`x.${extension}`)) {
      assert.equal(fileCategory(`x.${extension}`), 'video', extension);
    }
  }
});

test('extensions that only filter, not render, are still classified', () => {
  // These are in the category but deliberately NOT in the render predicate:
  // adding them to rendering would change how existing notes look.
  assert.equal(isImagePath('a/photo.avif'), false);
  assert.equal(fileCategory('a/photo.avif'), 'image');

  assert.equal(isVideoPath('a/clip.mkv'), false);
  assert.equal(fileCategory('a/clip.mkv'), 'video');
});
