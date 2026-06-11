import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../lib/shell.js';
import { isSubPath } from '../lib/workspace.js';

test('truncate adds suffix', () => {
  assert.equal(truncate('hello world', 8), 'hel\n...[truncated]');
});

test('isSubPath accepts children and rejects siblings', () => {
  if (process.platform === 'win32') {
    assert.equal(isSubPath('C:\\proj', 'C:\\proj\\src\\main.js'), true);
    assert.equal(isSubPath('C:\\proj', 'C:\\project\\src\\main.js'), false);
  } else {
    assert.equal(isSubPath('/proj', '/proj/src/main.js'), true);
    assert.equal(isSubPath('/proj', '/project/src/main.js'), false);
  }
});
