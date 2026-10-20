import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fileExtension,
  isHiddenVaultPath,
  migratePathValues,
  pathRename,
} from '../src/pathRename.ts';

test('a file rename maps exactly that path', () => {
  const rename = pathRename('Notes/a.md', 'Archive/a.md', false);

  assert.equal(rename.map('Notes/a.md'), 'Archive/a.md');
  assert.equal(rename.map('Notes/b.md'), null);
  assert.equal(rename.map('Notes/a.md.bak'), null);
  assert.equal(rename.covers('Notes/a.md'), true);
  assert.equal(rename.covers('Notes/b.md'), false);
});

test('a folder rename carries every descendant', () => {
  const rename = pathRename('Notes', 'Archive', true);

  assert.equal(rename.map('Notes'), 'Archive');
  assert.equal(rename.map('Notes/a.md'), 'Archive/a.md');
  assert.equal(rename.map('Notes/sub/deep/b.md'), 'Archive/sub/deep/b.md');
});

test('a folder rename does not swallow a sibling with the same prefix', () => {
  // The bug the trailing slash exists to prevent: moving `Notes` must not take
  // `Notes-archive` with it.
  const rename = pathRename('Notes', 'Archive', true);

  assert.equal(rename.map('Notes-archive/c.md'), null);
  assert.equal(rename.covers('Notes-archive/c.md'), false);
});

test('a folder rename of the vault root is expressed as one folder', () => {
  // Not a real Obsidian operation, but the arithmetic must not depend on the
  // path having a slash-less shape.
  const rename = pathRename('a/b', 'a/c', true);
  assert.equal(rename.map('a/b/c.md'), 'a/c/c.md');
  assert.equal(rename.map('a/bb/c.md'), null);
});

test('a no-op rename maps nothing new and stays harmless', () => {
  const rename = pathRename('a.md', 'a.md', false);
  assert.equal(rename.map('a.md'), 'a.md');
  assert.equal(rename.map('b.md'), null);
});

test('extensions are read from the file name, case-insensitively', () => {
  assert.equal(fileExtension('Notes/a.MD'), '.md');
  assert.equal(fileExtension('a.png'), '.png');
  assert.equal(fileExtension('Notes/archive.tar.gz'), '.gz');
  assert.equal(fileExtension('no-extension'), '');
  // A leading dot makes a hidden file, not an extension.
  assert.equal(fileExtension('.env'), '');
  assert.equal(fileExtension('Notes/.env'), '');
});

test('an ignored note keeps its entry when the note is renamed', () => {
  const rename = pathRename('Notes/a.md', 'Archive/a.md', false);
  const result = migratePathValues(['Notes/a.md', 'Notes/b.md'], rename);

  assert.deepEqual(result.values, ['Archive/a.md', 'Notes/b.md']);
  assert.equal(result.changed, true);
});

test('an ignored folder keeps its trailing slash and covers descendants', () => {
  const rename = pathRename('Notes', 'Archive', true);
  const result = migratePathValues(
    ['Notes/', 'Notes/a.md', 'Notes-archive/', 'Other.md'],
    rename
  );

  assert.deepEqual(result.values, [
    'Archive/',
    'Archive/a.md',
    'Notes-archive/',
    'Other.md',
  ]);
  assert.equal(result.changed, true);
});

test('migrated values that collide are deduplicated', () => {
  const rename = pathRename('Notes', 'Archive', true);
  const result = migratePathValues(['Notes/', 'Archive/', 'Notes/a.md', 'Archive/a.md'], rename);

  assert.deepEqual(result.values, ['Archive/', 'Archive/a.md']);
  assert.equal(result.changed, true);
});

test('a rename that touches no filter value reports no change', () => {
  const rename = pathRename('Notes', 'Archive', true);
  const result = migratePathValues(['Other/', 'Notes-archive/a.md'], rename);

  assert.deepEqual(result.values, ['Other/', 'Notes-archive/a.md']);
  assert.equal(result.changed, false);
});

test('dot-segments mark a path as not part of the vault index', () => {
  assert.equal(isHiddenVaultPath('.trash/note.md'), true);
  assert.equal(isHiddenVaultPath('Notes/.hidden/a.md'), true);
  assert.equal(isHiddenVaultPath('.probe.md'), true);
  assert.equal(isHiddenVaultPath('Notes/a.md'), false);
  assert.equal(isHiddenVaultPath('notes/version.2/a.md'), false);
});
