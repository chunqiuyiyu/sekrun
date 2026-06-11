/**
 * line_editor.js — fish-style line editor with autosuggestions.
 *
 * Replace readline.question() with a keypress-driven loop giving:
 *  - real-time greyed-out autosuggestions (→ / Ctrl+F to accept)
 *  - Tab completion with a candidate list
 *  - syntax highlighting for known commands
 *  - history navigation (↑ / ↓)
 *  - Emacs-style line editing (Ctrl+A/E, Ctrl+U/K, Ctrl+W, etc.)
 *  - @ file-path completion (suggest files/dirs from workspace)
 */

import { emitKeypressEvents } from 'node:readline';
import process from 'node:process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// ── ANSI escape helpers ────────────────────────────────────────────────────

const esc = '\x1b';
const csi = `${esc}[`;

function cursorBack(n = 1) { return `${csi}${n}D`; }
function eraseInLine(n = 0) { return `${csi}${n}K`; } // 0=toEnd, 1=toStart, 2=full

const style = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  inverse: '\x1b[7m',
};

/**
 * Compute visible width of a string (ignoring ANSI escape sequences).
 * Supports CJK wide characters and emoji surrogate pairs.
 */
function visibleWidth(str) {
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);
    if (code === 0x1b) {
      i += 1;
      if (i < str.length && str[i] === '[') {
        i += 1;
        while (i < str.length) {
          const ch = str[i];
          i += 1;
          if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              ch === '@' || ch === '[' || ch === '\\' || ch === ']' ||
              ch === '^' || ch === '_' || ch === '`' || ch === '{' ||
              ch === '|' || ch === '}' || ch === '~') {
            break;
          }
        }
      }
      continue;
    }
    if (code <= 0x1f || code === 0x7f) { i += 1; continue; }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) { i += 2; w += 2; continue; }
    // CJK wide
    if ((code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xfe00 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xffef)) {
      w += 2;
    } else {
      w += 1;
    }
    i += 1;
  }
  return w;
}

function promptLine(prompt) {
  return prompt.split(/\r?\n/).pop() ?? '';
}

function cursorBackToLogicalCursor(bufferAfter, suggestionText) {
  return visibleWidth(bufferAfter) + visibleWidth(suggestionText);
}

function normalizeInputKey(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

function isPrintableInput(key) {
  if (!key || key.includes(esc)) return false;
  for (const ch of key) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// ── Command/context database ──────────────────────────────────────────────

const DEFAULT_COMMANDS = [
  { name: '/help', desc: 'Show help', group: 'system' },
  { name: '/exit', desc: 'Quit', group: 'system' },
  { name: '/quit', desc: 'Quit', group: 'system' },
  { name: '/stats', desc: 'Show usage stats', group: 'system' },
  { name: '/ask', desc: 'Enter read-only ask mode', group: 'system' },
  { name: '/edit', desc: 'Return to agent mode', group: 'system' },
  { name: '/agent', desc: 'Return to agent mode', group: 'system' },
];

const TOOL_COMMANDS = [
  { name: 'read_file', desc: 'Read a file in workspace', group: 'tool' },
  { name: 'write_file', desc: 'Write a file in workspace', group: 'tool' },
  { name: 'list_dir', desc: 'List directory contents', group: 'tool' },
  { name: 'grep', desc: 'Search for text in files', group: 'tool' },
  { name: 'bash', desc: 'Run a shell command', group: 'tool' },
];

// ── @ file-path helpers ───────────────────────────────────────────────────

/**
 * Find the last `@` token in the input and return the partial path after it.
 * Returns `null` if there is no active @-completion context.
 */
function findAtToken(input, cursor) {
  if (!input) return null;
  const beforeCursor = input.slice(0, cursor);
  const lastAt = beforeCursor.lastIndexOf('@');
  if (lastAt === -1) return null;
  const partial = beforeCursor.slice(lastAt + 1);
  if (/[\s'"]/.test(partial)) return null;

  let endIndex = cursor;
  while (endIndex < input.length && !/[\s'"]/.test(input[endIndex])) {
    endIndex += 1;
  }

  return {
    atIndex: lastAt,
    startIndex: lastAt + 1,
    endIndex,
    partial,
  };
}

function completionReplacementEnd(input, endIndex, completions) {
  if (
    endIndex < input.length &&
    /\s/.test(input[endIndex]) &&
    completions.length > 0 &&
    completions.every((completion) => completion.endsWith(' '))
  ) {
    return endIndex + 1;
  }
  return endIndex;
}

/**
 * Given a workspace root and a partial path (after @), return matching entries.
 * Returns an array of { name, isDir, full } objects.
 */
async function getAtCompletions(workspaceRoot, partial) {
  if (!workspaceRoot) return [];
  const dir = partial ? path.dirname(partial) || '.' : '.';
  const base = partial ? path.basename(partial) : '';
  const absDir = path.resolve(workspaceRoot, dir);
  const entries = await readdir(absDir).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (entry.startsWith(base) && entry !== base) {
      const full = dir === '.' ? entry : path.join(dir, entry);
      try {
        const isDir = (await stat(path.resolve(absDir, entry))).isDirectory();
        out.push({ name: entry, isDir, full: isDir ? full + '/' : full });
      } catch {
        out.push({ name: entry, isDir: false, full });
      }
    }
  }
  return out;
}

/**
 * The autosuggestion engine.
 * Maintains a ring of suggestion sources that can be queried by prefix.
 */
class Suggester {
  constructor() {
    this._history = [];
    this._maxHistory = 1000;
    this._lastPrefix = '';
    this._lastSuggestion = '';
  }

  /** Set the workspace root for @-completion suggestions. */
  setWorkspaceRoot(root) {
    this._workspaceRoot = root;
  }

  /** Add a line to history (most recent first). */
  addEntry(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Remove duplicates
    const idx = this._history.indexOf(trimmed);
    if (idx !== -1) this._history.splice(idx, 1);
    this._history.unshift(trimmed);
    if (this._history.length > this._maxHistory) {
      this._history.length = this._maxHistory;
    }
  }

  /**
   * Find a suggestion for the given input line.
   * Returns the full suggested text (or empty string).
   */
  suggest(line) {
    if (!line) return '';
    if (DEFAULT_COMMANDS.some((cmd) => cmd.name === line)) return '';

    // Fast path: if input hasn't changed, return cached
    if (line === this._lastPrefix && this._lastSuggestion) {
      return this._lastSuggestion;
    }
    this._lastPrefix = line;

    // 1. Try history (most recent match first)
    for (const entry of this._history) {
      if (entry.startsWith(line) && entry.length > line.length) {
        this._lastSuggestion = entry;
        return entry;
      }
    }

    // 2. Try commands
    for (const cmd of [...DEFAULT_COMMANDS, ...TOOL_COMMANDS]) {
      const full = cmd.name;
      if (full.startsWith(line) && full.length > line.length) {
        this._lastSuggestion = full;
        return full;
      }
    }

    this._lastSuggestion = '';
    return '';
  }

  clearCache() {
    this._lastPrefix = '';
    this._lastSuggestion = '';
  }
}

// ── Tab completer ─────────────────────────────────────────────────────────

/**
 * Get completions for a partial input.
 * Returns { start, completions } where `start` is the index where
 * completions should be spliced into the input.
 */
async function getCompletions(input, cursor, workspaceRoot) {
  if (!input) return { start: 0, completions: DEFAULT_COMMANDS.map(c => c.name + ' ') };

  // Determine the word being completed
  const beforeCursor = input.slice(0, cursor);
  const afterCursor = input.slice(cursor);

  // Check for @ file-path completion first
  const atToken = findAtToken(input, cursor);
  if (atToken !== null && workspaceRoot) {
    const entries = await getAtCompletions(workspaceRoot, atToken.partial);
    const completions = entries.map(e => e.full + ' ');
    return {
      start: atToken.startIndex,
      end: completionReplacementEnd(input, atToken.endIndex, completions),
      completions,
    };
  }

  const wordStart = beforeCursor.lastIndexOf(' ') + 1;
  const wordEnd = afterCursor.indexOf(' ') === -1 ? input.length : cursor + afterCursor.indexOf(' ');
  const partial = input.slice(wordStart, wordEnd);
  const isFirstWord = beforeCursor.trim() === '' || beforeCursor.trim().startsWith('/');

  const completions = [];

  if (isFirstWord) {
    // Complete commands (both /-prefixed and tool names)
    for (const cmd of [...DEFAULT_COMMANDS, ...TOOL_COMMANDS]) {
      const name = cmd.name;
      if (name.startsWith(partial) && name !== partial) {
        completions.push(name + ' ');
      }
    }
    // Also try to match incomplete / prefix
    if (partial.startsWith('/')) {
      for (const cmd of DEFAULT_COMMANDS) {
        const name = cmd.name;
        if (name.startsWith(partial) && name !== partial) {
          completions.push(name + ' ');
        }
      }
    }
  } else {
    // Subsequent words: try file path completion
    if (workspaceRoot && partial !== '') {
      try {
        const dir = path.dirname(partial) || '.';
        const base = path.basename(partial);
        const absDir = path.resolve(workspaceRoot, dir);
        const entries = await readdir(absDir).catch(() => []);
        for (const entry of entries) {
          if (entry.startsWith(base) && entry !== base) {
            const full = path.join(dir, entry);
            try {
              const isDir = (await stat(path.resolve(absDir, entry))).isDirectory();
              completions.push(isDir ? full + '/' : full + ' ');
            } catch {
              completions.push(full + ' ');
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return { start: wordStart, end: completionReplacementEnd(input, wordEnd, completions), completions };
}

// ── Syntax highlighting ───────────────────────────────────────────────────

/**
 * Apply ANSI colours to a command line based on token type.
 */
function highlight(line) {
  if (!line) return line;
  const trimmed = line.trimStart();
  const leadingSpaces = line.length - trimmed.length;

  const firstWordEnd = trimmed.search(/[\s/]/);
  const firstWord = firstWordEnd === -1 ? trimmed : trimmed.slice(0, firstWordEnd);

  let result = line.slice(0, leadingSpaces); // preserve leading spaces (uncoloured)

  if (firstWord.startsWith('/')) {
    // System commands
    const isKnown = DEFAULT_COMMANDS.some(c => c.name === firstWord);
    result += isKnown ? `${style.cyan}${firstWord}${style.reset}` : `${style.red}${firstWord}${style.reset}`;
  } else if (TOOL_COMMANDS.some(c => c.name === firstWord)) {
    // Known tool names
    result += `${style.green}${firstWord}${style.reset}`;
  } else if (firstWord) {
    // Unknown — could be shell command
    result += `${style.yellow}${firstWord}${style.reset}`;
  }

  // Append rest of line (after first word)
  if (firstWordEnd !== -1) {
    const rest = trimmed.slice(firstWordEnd);
    let highlighted = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; highlighted += `${style.magenta}${ch}${style.reset}`; }
      else if (ch === '"' && !inSingle) { inDouble = !inDouble; highlighted += `${style.magenta}${ch}${style.reset}`; }
      else if (inSingle || inDouble) { highlighted += ch; }
      else if (ch === '@') {
        // Highlight @ symbol — the path after it will be highlighted
        highlighted += `${style.blue}@`;
        // Find the end of the @-path (next space or end)
        let j = i + 1;
        while (j < rest.length && rest[j] !== ' ' && rest[j] !== "'" && rest[j] !== '"') {
          j += 1;
        }
        const pathPart = rest.slice(i + 1, j);
        highlighted += `${style.blue}${pathPart}${style.reset}`;
        i = j - 1;
      }
      else { highlighted += ch; }
    }
    result += highlighted;
  }

  return result;
}

// ── Line buffer (editable) ────────────────────────────────────────────────

class LineBuffer {
  constructor() {
    this.text = '';
    this.cursor = 0; // index into this.text
  }

  get before() { return this.text.slice(0, this.cursor); }
  get after() { return this.text.slice(this.cursor); }

  insert(ch) {
    this.text = this.before + ch + this.after;
    this.cursor += ch.length;
  }

  deleteBefore() {
    if (this.cursor <= 0) return false;
    this.text = this.before.slice(0, -1) + this.after;
    this.cursor -= 1;
    return true;
  }

  deleteAfter() {
    if (this.cursor >= this.text.length) return false;
    this.text = this.before + this.after.slice(1);
    return true;
  }

  deleteWordBefore() {
    if (this.cursor <= 0) return false;
    const idx = this.before.trimEnd().lastIndexOf(' ', this.cursor - 2);
    const n = this.cursor - (idx + 1);
    this.text = this.text.slice(0, this.cursor - n) + this.after;
    this.cursor -= n;
    return true;
  }

  moveLeft() { if (this.cursor > 0) { this.cursor -= 1; return true; } return false; }
  moveRight() { if (this.cursor < this.text.length) { this.cursor += 1; return true; } return false; }
  moveToStart() { this.cursor = 0; }
  moveToEnd() { this.cursor = this.text.length; }

  clear() { this.text = ''; this.cursor = 0; }

  setText(t) { this.text = t; this.cursor = t.length; }
}

// ── Fish-style line editor ───────────────────────────────────────────────

/**
 * Ask a question with full fish-style editing.
 *
 * @param {string} prompt - The prompt string (e.g. "> ")
 * @param {object} options
 * @param {string} [options.workspaceRoot] - For file completions
 * @param {Suggester} [options.suggester] - Shared suggestion engine
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} The line as entered (without trailing newline).
 */
export async function readLine(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const { workspaceRoot, suggester = new Suggester(), signal } = options;
    // Pass workspaceRoot to suggester for @-completions
    if (workspaceRoot) suggester.setWorkspaceRoot(workspaceRoot);
    let historyIdx = -1;
    let currentLine = '';
    let asyncSuggestionGen = 0; // generation counter to discard stale async suggestions

    const buf = new LineBuffer();
    let suggestion = '';
    let tabCount = 0;
    let lastTabCompletions = [];
    let lastTabStart = 0;

    const output = process.stderr;
    const input = process.stdin;

    // Ensure raw mode
    const wasRaw = input.isRaw;
    const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : false;
    if (!input.isRaw) input.setRawMode(true);
    input.resume();

    // Write the prompt
    output.write(prompt);

    const currentPromptLine = promptLine(prompt);

    /**
     * Redraw the current line (prompt + input + suggestion).
     */
    function redraw() {
      const highlightedLine = highlight(buf.text);
      const suggestionText = suggestion ? suggestion.slice(buf.text.length) : '';

      // Redraw the current physical line from scratch. The prompt may include
      // leading newlines, but only its final line belongs to redraws.
      output.write('\r');
      output.write(eraseInLine(2));
      output.write(currentPromptLine);

      // Write the highlighted buffer
      output.write(highlightedLine);

      // Write the dimmed suggestion
      if (suggestionText) {
        // Use dim for the entire suggestion block
        output.write(`${style.dim}${suggestionText}${style.reset}`);
      }

      // Reposition cursor at the right place
      const back = cursorBackToLogicalCursor(buf.after, suggestionText);
      if (back > 0) {
        output.write(cursorBack(back));
      }
    }

    function updateSuggestion() {
      if (buf.text.length > 0) {
        // Check for @ file-path suggestion
        const atToken = findAtToken(buf.text, buf.cursor);
        if (atToken !== null && workspaceRoot) {
          // Async suggestion — bump generation so stale results are discarded
          asyncSuggestionGen += 1;
          const captureGen = asyncSuggestionGen;
          getAtCompletions(workspaceRoot, atToken.partial).then(matches => {
            // Discard if the buffer changed since this lookup started
            if (captureGen !== asyncSuggestionGen) return;
            const beforeAt = buf.text.slice(0, atToken.atIndex);
            const afterCursorText = buf.text.slice(buf.cursor);
            if (matches.length === 1) {
              const matchPath = matches[0].full;
              const fullSuggested = beforeAt + '@' + matchPath + ' ' + afterCursorText;
              suggestion = fullSuggested;
            } else if (matches.length > 1) {
              // Show common prefix as inline hint when multiple matches exist
              const paths = matches.map(m => m.full);
              const completionStrs = paths.map(p => p + ' ');
              const common = commonPrefix(completionStrs);
              if (common.length > atToken.partial.length) {
                const partial = atToken.partial;
                const toSuggest = common.slice(partial.length);
                suggestion = beforeAt + '@' + partial + toSuggest + afterCursorText;
              } else {
                suggestion = '';
              }
            } else {
              suggestion = '';
            }
            redraw();
          }).catch(() => {
            if (captureGen === asyncSuggestionGen) {
              suggestion = '';
              redraw();
            }
          });
          // Don't set suggestion yet — it will be set async
          suggestion = '';
          return;
        }
        suggestion = suggester.suggest(buf.text) || '';
      } else {
        suggestion = '';
      }
    }

    function acceptSuggestion() {
      if (suggestion && suggestion.length > buf.text.length) {
        buf.setText(suggestion);
        suggestion = '';
        redraw();
      }
    }

    /**
     * Handle tab completion.
     */
    async function doTab() {
      const completions = await getCompletions(buf.text, buf.cursor, workspaceRoot);
      if (completions.completions.length === 0) {
        output.write('\x07'); // bell
        tabCount = 0;
        return;
      }

      if (completions.completions.length === 1) {
        // Single match: accept
        const end = completions.end ?? buf.cursor;
        buf.text = buf.text.slice(0, completions.start) + completions.completions[0] + buf.text.slice(end);
        buf.cursor = completions.start + completions.completions[0].length;
        tabCount = 0;
        updateSuggestion();
        redraw();
        return;
      }

      // Multiple matches
      if (tabCount === 0) {
        // First tab: store completions, find common prefix
        lastTabCompletions = completions.completions;
        lastTabStart = completions.start;
        const common = commonPrefix(completions.completions);
        if (common.length > 0) {
          const end = completions.end ?? buf.cursor;
          const partial = buf.text.slice(lastTabStart, buf.cursor);
          const toInsert = common.slice(partial.length);
          if (toInsert) {
            buf.text = buf.text.slice(0, lastTabStart) + common + buf.text.slice(end);
            buf.cursor = lastTabStart + common.length;
            updateSuggestion();
            redraw();
          }
        }
        tabCount = 1;
      } else {
        // Second tab: show list below
        tabCount = 0;
        output.write('\n');
        printCompletionList(lastTabCompletions);
        // Reprint prompt and line
        output.write('\n' + currentPromptLine);
        const hl = highlight(buf.text);
        output.write(hl);
        const sugText = suggestion ? suggestion.slice(buf.text.length) : '';
        if (sugText) {
          output.write(`${style.dim}${sugText}${style.reset}`);
        }
        // Move cursor back
        const back = cursorBackToLogicalCursor(buf.after, sugText);
        if (back > 0) {
          output.write(cursorBack(back));
        }
      }
    }

    function printCompletionList(items) {
      const termWidth = process.stderr.columns || 80;
      const maxItemWidth = Math.max(...items.map(i => visibleWidth(i))) + 2;
      const cols = Math.max(1, Math.floor(termWidth / maxItemWidth));
      const rows = Math.ceil(items.length / cols);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = c * rows + r;
          if (idx < items.length) {
            const item = items[idx];
            output.write(item);
            const pad = maxItemWidth - visibleWidth(item);
            if (pad > 0) output.write(' '.repeat(pad));
          }
        }
        output.write('\n');
      }
    }

    function commonPrefix(list) {
      if (!list || list.length === 0) return '';
      let prefix = list[0];
      for (let i = 1; i < list.length; i++) {
        const item = list[i];
        let j = 0;
        const maxLen = Math.min(prefix.length, item.length);
        while (j < maxLen && prefix[j] === item[j]) j++;
        prefix = prefix.slice(0, j);
        if (prefix === '') break;
      }
      return prefix;
    }

    // ── Key handling ────────────────────────────────────────────────────────

    function onData(chunk) {
      const key = normalizeInputKey(chunk);
      if (!key) return;

      // Handle exit signals
      if (key === '\x03' || key === '\x04') { // Ctrl+C / Ctrl+D
        input.removeListener('data', onData);
        cleanup();
        resolve('');
        return;
      }

      // Tab
      if (key === '\t') {
        doTab().catch(() => {});
        return;
      }

      // Reset tab counter on any non-tab key
      tabCount = 0;

      // Ctrl+C alternative
      if (key === '\x03') {
        input.removeListener('data', onData);
        cleanup();
        resolve('');
        return;
      }

      // Ctrl+D — exit if line is empty
      if (key === '\x04') {
        if (buf.text.length === 0) {
          input.removeListener('data', onData);
          cleanup();
          resolve('');
          return;
        }
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        input.removeListener('data', onData);
        cleanup();
        output.write('\n');
        resolve(buf.text);
        return;
      }

      // Backspace
      if (key === '\x7f' || key === '\b') {
        if (buf.deleteBefore()) {
          suggestion = '';
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Ctrl+W — delete word before cursor
      if (key === '\x17') {
        if (buf.deleteWordBefore()) {
          suggestion = '';
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Ctrl+U — delete whole line
      if (key === '\x15') {
        buf.clear();
        suggestion = '';
        redraw();
        return;
      }

      // Ctrl+K — delete after cursor
      if (key === '\x0b') {
        if (buf.deleteAfter()) {
          suggestion = '';
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Up arrow — history previous
      if (key === '\x1b[A' || key === '\x1bOA') {
        if (historyIdx === -1) {
          // Save current line
          currentLine = buf.text;
        }
        if (historyIdx < suggester._history.length - 1) {
          historyIdx += 1;
          buf.setText(suggester._history[historyIdx]);
          suggestion = '';
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Down arrow — history next
      if (key === '\x1b[B' || key === '\x1bOB') {
        if (historyIdx > 0) {
          historyIdx -= 1;
          buf.setText(suggester._history[historyIdx]);
          suggestion = '';
          updateSuggestion();
          redraw();
        } else if (historyIdx === 0) {
          historyIdx = -1;
          buf.setText(currentLine);
          suggestion = '';
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Right arrow — accept next char from suggestion
      if (key === '\x1b[C' || key === '\x1bOC') {
        if (suggestion && buf.cursor < suggestion.length) {
          const ch = suggestion[buf.cursor];
          buf.insert(ch);
          updateSuggestion();
          redraw();
        } else {
          buf.moveRight();
          updateSuggestion();
          redraw();
        }
        return;
      }

      // Left arrow
      if (key === '\x1b[D' || key === '\x1bOD') {
        buf.moveLeft();
        updateSuggestion();
        redraw();
        return;
      }

      // Ctrl+F → accept suggestion char (same as right arrow)
      if (key === '\x06') {
        if (suggestion && buf.cursor < suggestion.length) {
          const ch = suggestion[buf.cursor];
          buf.insert(ch);
          suggestion = '';
          redraw();
          updateSuggestion();
        }
        return;
      }

      // Ctrl+E / End — accept full suggestion
      if (key === '\x05' || key === '\x1b[F' || key === '\x1bOF') {
        acceptSuggestion();
        return;
      }

      // Ctrl+A / Home — go to line start
      if (key === '\x01' || key === '\x1b[H' || key === '\x1bOH') {
        buf.moveToStart();
        redraw();
        return;
      }

      // Ctrl+L — redraw
      if (key === '\x0c') {
        redraw();
        return;
      }

      // Printable text. IMEs and paste can deliver multiple Unicode
      // characters in a single data chunk, so accept the whole chunk.
      if (isPrintableInput(key)) {
        buf.insert(key);
        updateSuggestion();
        redraw();
        return;
      }

      // Ignore other escape sequences / control chars
    }

    input.on('data', onData);

    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!wasRaw && input.isRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
    }

    function onAbort() {
      input.removeListener('data', onData);
      cleanup();
      reject(new DOMException('readLine aborted', 'AbortError'));
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('readLine aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export {
  Suggester,
  cursorBackToLogicalCursor,
  completionReplacementEnd,
  findAtToken,
  getCompletions,
  isPrintableInput,
  normalizeInputKey,
  promptLine,
  visibleWidth,
};
