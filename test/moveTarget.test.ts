import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMoveTargetFolder } from '../src/moveTarget.ts';

test('an empty one-click target hides the action', () => {
  assert.equal(normalizeMoveTargetFolder(''), '');
  assert.equal(normalizeMoveTargetFolder('   '), '');
});

test('the root can be selected explicitly', () => {
  assert.equal(normalizeMoveTargetFolder('/'), '/');
  assert.equal(normalizeMoveTargetFolder('.'), '/');
  assert.equal(normalizeMoveTargetFolder(' / '), '/');
});

test('folder paths are stored relative to the vault', () => {
  assert.equal(normalizeMoveTargetFolder('/Notes/'), 'Notes');
  assert.equal(normalizeMoveTargetFolder('Notes/Sub/'), 'Notes/Sub');
  assert.equal(normalizeMoveTargetFolder('  Notes  '), 'Notes');
  assert.equal(normalizeMoveTargetFolder('///Notes//Sub///'), 'Notes/Sub');
});
