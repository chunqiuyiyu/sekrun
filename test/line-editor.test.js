import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import {
  completionReplacementEnd,
  CompletionEngine,
  cursorBackToLogicalCursor,
  findAtToken,
  getCompletions,
  highlight,
  insertPastedText,
  insertPrintableText,
  isPrintableInput,
  normalizeInputKey,
  normalizePastedText,
  promptLine,
  Suggester,
  visualCursorPosition,
  visualLineCount,
  visiblePrefix,
  visibleWidth,
} from '../lib/line_editor.js';

test('promptLine returns only the current physical prompt line', () => {
  assert.equal(promptLine('\n> '), '> ');
  assert.equal(promptLine('\r\nask> '), 'ask> ');
  assert.equal(promptLine('sek> '), 'sek> ');
});

test('cursorBackToLogicalCursor keeps cursor at end when there is no trailing text', () => {
  assert.equal(cursorBackToLogicalCursor('', ''), 0);
});

test('cursorBackToLogicalCursor moves back over text after the cursor', () => {
  assert.equal(cursorBackToLogicalCursor('cd', ''), 2);
});

test('cursorBackToLogicalCursor moves back over autosuggestion text', () => {
  assert.equal(cursorBackToLogicalCursor('', 'elp'), 3);
  assert.equal(cursorBackToLogicalCursor('x', 'elp'), 4);
});

test('visibleWidth ignores ANSI control sequences', () => {
  assert.equal(visibleWidth('\x1b[31mred\x1b[0m'), 3);
});

test('visiblePrefix clips text without exceeding display width', () => {
  assert.equal(visiblePrefix('abcdef', 3), 'abc');
  assert.equal(visiblePrefix('中文abc', 4), '中文');
  assert.equal(visiblePrefix('中文abc', 5), '中文a');
  assert.equal(visiblePrefix('abc', 0), '');
});

test('visualCursorPosition accounts for prompt width when a single line wraps', () => {
  // '12345678' (8) + prompt (2) = 10 = termWidth — cursor stays on row 0 at col=10 (wrapping margin)
  assert.deepEqual(visualCursorPosition('12345678', 2, 10), { row: 0, col: 10 });
  // '1234567' (7) + prompt (2) = 9 < termWidth — cursor on row 0 at col 9
  assert.deepEqual(visualCursorPosition('1234567', 2, 10), { row: 0, col: 9 });
});

test('visualLineCount preserves explicit newlines and wrapped rows', () => {
  // '12345' (5+2=7, fits 1 row) + \n + '1234567890' (10, fits 1 row) = 2 visual rows
  assert.equal(visualLineCount('12345\n1234567890', 2, 10), 2);
  assert.equal(visualLineCount('', 2, 10), 1);
});

test('highlight keeps unknown plain text visible', () => {
  assert.equal(highlight('hello'), 'hello');
  assert.equal(highlight('hello world'), 'hello world');
});

test('normalizeInputKey converts data chunks to strings', () => {
  assert.equal(normalizeInputKey('a'), 'a');
  assert.equal(normalizeInputKey(Buffer.from('a')), 'a');
  assert.equal(normalizeInputKey(Buffer.from('中文')), '中文');
  assert.equal(normalizeInputKey(new Uint8Array(Buffer.from('\x1b[C'))), '\x1b[C');
  assert.equal(normalizeInputKey({}), '');
});

test('isPrintableInput accepts Unicode IME chunks and rejects controls', () => {
  assert.equal(isPrintableInput('a'), true);
  assert.equal(isPrintableInput('中文'), true);
  assert.equal(isPrintableInput('你好 world'), true);
  assert.equal(isPrintableInput('\x1b[C'), false);
  assert.equal(isPrintableInput('\r'), false);
  assert.equal(isPrintableInput('\x7f'), false);
});

test('insertPrintableText inserts multi-character chunks at the cursor', () => {
  assert.deepEqual(insertPrintableText('ask  now', 4, 'about files'), {
    input: 'ask about files now',
    cursor: 15,
  });
  assert.deepEqual(insertPrintableText('ask  now', 4, Buffer.from('中文')), {
    input: 'ask 中文 now',
    cursor: 6,
  });
  assert.equal(insertPrintableText('ask', 3, '\r'), null);
});

test('normalizePastedText normalizes CRLF multi-line paste to LF', () => {
  assert.equal(normalizePastedText('first\r\nsecond\rthird'), 'first\nsecond\nthird');
  assert.equal(normalizePastedText('\r'), null);
  assert.equal(normalizePastedText('single line'), null);
  assert.equal(normalizePastedText('\x1b[A\r\ntext'), null);
});

test('insertPastedText inserts a multi-line paste as logical newlines', () => {
  assert.deepEqual(insertPastedText('beforeafter', 6, 'one\r\ntwo\rthree'), {
    input: 'beforeone\ntwo\nthreeafter',
    cursor: 'beforeone\ntwo\nthree'.length,
  });
});

test('completionReplacementEnd consumes an existing separator space', () => {
  assert.equal(completionReplacementEnd('read @src/file next', 'read @src/file'.length, ['src/file ']), 'read @src/file '.length);
  assert.equal(completionReplacementEnd('read @src/file,next', 'read @src/file'.length, ['src/file ']), 'read @src/file'.length);
});

test('CompletionEngine completes command objects without requiring full path field', async () => {
  const engine = new CompletionEngine(process.cwd());

  await engine.compute('/he', '/he'.length);
  const result = engine.next();

  assert.deepEqual(result, {
    input: '/help ',
    cursor: '/help '.length,
  });
});

test('Suggester does not extend exact built-in commands', () => {
  const suggester = new Suggester();
  suggester.addEntry('/exit after this task');

  assert.equal(suggester.suggest('/exit'), '');
  assert.equal(suggester.suggest('/ex'), '/exit after this task');
});

test('Suggester setWorkspaceRoot stores the root', () => {
  const suggester = new Suggester();
  suggester.setWorkspaceRoot('/tmp');
  assert.equal(suggester._workspaceRoot, '/tmp');
});

test('findAtToken identifies active @ path token bounds', () => {
  const input = 'read @src/index.js now';
  const token = findAtToken(input, 'read @src/in'.length);

  assert.deepEqual(token, {
    atIndex: 5,
    startIndex: 6,
    endIndex: 18,
    partial: 'src/in',
  });
  assert.equal(findAtToken('read @src/file more', 'read @src/file more'.length), null);
});

test('getCompletions replaces the whole @ path token when cursor is in the middle', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sek-test-'));
  try {
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.js'), '// test');

    const input = 'read @src/inx.js please';
    const cursor = 'read @src/in'.length;
    const completions = await getCompletions(input, cursor, tmpDir);
    const completed =
      input.slice(0, completions.start) +
      completions.completions[0] +
      input.slice(completions.end);

    assert.equal(completions.start, 'read @'.length);
    assert.equal(completions.end, 'read @src/inx.js '.length);
    assert.deepEqual(completions.completions, [`src${path.sep}index.js `]);
    assert.equal(completed, `read @src${path.sep}index.js please`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
