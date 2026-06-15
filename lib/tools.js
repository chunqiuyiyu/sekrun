import fs from 'node:fs/promises';
import path from 'node:path';
import { execute } from './shell.js';
import { diffLines } from './diff.js';

export const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          offset: { type: 'integer', description: '1-based start line (optional)' },
          limit: { type: 'integer', description: 'Max lines (optional, default 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace',
      description:
        'Find and replace a string in a file. Finds the first exact match of old_str and replaces it with new_str. ' +
        'old_str must include all whitespace, indentation, and surrounding code exactly as it appears in the file. ' +
        'If the match is not unique, the replacement is rejected — provide more context to make old_str unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          old_str: { type: 'string', description: 'The exact string to find and replace' },
          new_str: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to the end of a UTF-8 text file. Creates the file if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory entries.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search literal substring in files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in project root.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch',
      description:
        'Fetch a URL and return the response text. Useful for reading web pages or APIs. ' +
        'Only available in ask mode for read-only internet lookups.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch (https only)' },
          maxBytes: { type: 'integer', description: 'Max response bytes to read (default 4096, max 65536)' },
        },
        required: ['url'],
      },
    },
  },
];

export function isReadOnlyTool(name) {
  return name === 'read_file' || name === 'list_dir' || name === 'grep' || name === 'fetch';
}

export async function approvalFor(context, name, argumentsText) {
  if (name === 'bash') {
    return context.workspace.bashNeedsApproval(parseArgs(argumentsText).command || '') ? 'on_request' : 'auto';
  }

  const pathArg = extractPath(name, argumentsText);
  if (!pathArg) return 'auto';
  try {
    await context.workspace.resolvePath(pathArg);
    return 'auto';
  } catch {
    return 'on_request';
  }
}

export function approvalPrompt(name, argumentsText) {
  if (name === 'bash') {
    const cmd = parseArgs(argumentsText).command || '';
    return `Allow bash command outside sandbox policy?\n  command: ${cmd}`;
  }
  return 'Allow access outside workspace?';
}

export async function dispatch(context, name, argumentsText) {
  if (name === 'read_file') return toolReadFile(context, argumentsText);
  if (name === 'write_file') return toolWriteFile(context, argumentsText);
  if (name === 'list_dir') return toolListDir(context, argumentsText);
  if (name === 'grep') return toolGrep(context, argumentsText);
  if (name === 'bash') return toolBash(context, argumentsText);
  if (name === 'replace') return toolReplace(context, argumentsText);
  if (name === 'append_file') return toolAppendFile(context, argumentsText);
  if (name === 'fetch') return toolFetch(context, argumentsText);
  return `Unknown tool: ${name}`;
}

function extractPath(name, argumentsText) {
  const args = parseArgs(argumentsText);
  if (args.path) return args.path;
  if (name === 'list_dir' || name === 'grep') return '.';
  return null;
}

async function toolReadFile(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  const abs = await context.workspace.resolvePath(args.path);
  const data = await fs.readFile(abs, 'utf8');
  const startLine = args.offset ?? 1;
  const maxLines = args.limit ?? 200;
  const lines = data.split(/\n/);
  const out = [];

  for (let index = 0; index < lines.length && out.length < maxLines; index += 1) {
    const lineNo = index + 1;
    if (lineNo >= startLine) {
      out.push(`${lineNo}|${lines[index].replace(/\r$/, '')}`);
    }
  }
  return out.length > 0 ? `${out.join('\n')}\n` : `(empty file or offset beyond end): ${args.path}`;
}

async function toolWriteFile(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.content, 'content');
  const abs = await context.workspace.resolvePath(args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  // Read old content for diff (if file exists)
  let oldContent = '';
  let fileExisted = false;
  try {
    oldContent = await fs.readFile(abs, 'utf8');
    fileExisted = true;
  } catch {
    // file does not exist yet
  }

  await fs.writeFile(abs, args.content, 'utf8');

  // Compute and append diff
  const diffText = diffLines(args.path, oldContent, args.content, fileExisted);
  const size = Buffer.byteLength(args.content, 'utf8');
  return `Wrote ${size} bytes to ${args.path}\n${diffText}`;
}

async function toolReplace(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.old_str, 'old_str');
  requireString(args.new_str, 'new_str');
  const abs = await context.workspace.resolvePath(args.path);

  let data;
  try {
    data = await fs.readFile(abs, 'utf8');
  } catch {
    throw new Error(`File not found: ${args.path}`);
  }

  const oldStr = args.old_str;
  const newStr = args.new_str;

  // Count occurrences
  let idx = data.indexOf(oldStr);
  if (idx === -1) {
    const preview = data.length > 500
      ? `${data.slice(0, 250)}...${data.slice(-250)}`
      : data;
    throw new Error(
      `old_str not found in ${args.path}. File content preview:\n${preview}`
    );
  }

  const secondIdx = data.indexOf(oldStr, idx + oldStr.length);
  if (secondIdx !== -1) {
    throw new Error(
      `old_str matches multiple locations in ${args.path}. ` +
      `Provide more surrounding context to make it unique.`
    );
  }

  const newContent = data.slice(0, idx) + newStr + data.slice(idx + oldStr.length);
  await fs.writeFile(abs, newContent, 'utf8');

  const diffText = diffLines(args.path, data, newContent, true);
  const size = Buffer.byteLength(newContent, 'utf8');
  return `Replaced in ${args.path} (${size} bytes after)\n${diffText}`;
}

async function toolAppendFile(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.content, 'content');
  const abs = await context.workspace.resolvePath(args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  let oldContent = '';
  let fileExisted = false;
  try {
    oldContent = await fs.readFile(abs, 'utf8');
    fileExisted = true;
  } catch {
    // file does not exist yet
  }

  const newContent = oldContent + args.content;
  await fs.writeFile(abs, newContent, 'utf8');

  const diffText = diffLines(args.path, oldContent, newContent, fileExisted);
  const appendedSize = Buffer.byteLength(args.content, 'utf8');
  return `Appended ${appendedSize} bytes to ${args.path}\n${diffText}`;
}

async function toolListDir(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  const abs = await context.workspace.resolvePath(args.path);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const entry of entries.slice(0, 500)) {
    out.push(`${entryKind(entry)} ${entry.name}`);
  }
  if (entries.length > 500) out.push('...[truncated]');
  return out.length > 0 ? `${out.join('\n')}\n` : '(empty directory)';
}

async function toolGrep(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.pattern, 'pattern');
  const start = await context.workspace.resolvePath(args.path);
  const out = [];
  await walkFiles(start, async (file) => {
    if (out.length >= 100) return;
    let data;
    try {
      data = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    const rel = context.workspace.relativePath(file);
    const lines = data.split(/\n/);
    for (let i = 0; i < lines.length && out.length < 100; i += 1) {
      const line = lines[i].replace(/\r$/, '');
      if (line.includes(args.pattern)) {
        out.push(`${rel}:${i + 1}:${line.trim()}`);
      }
    }
  });
  return out.length > 0 ? `${out.join('\n')}\n` : `No matches for '${args.pattern}' under ${args.path}`;
}

async function toolBash(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.command, 'command');
  const shellConfig = {
    cwd: (context.workspace && context.workspace.root) || process.cwd(),
    maxObservationBytes: (context.config && context.config.maxObservationBytes) || 8192,
  };
  return execute(shellConfig, args.command);
}


async function toolFetch(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.url, 'url');
  if (!args.url.startsWith('https://')) {
    throw new Error('Only https URLs are allowed for security');
  }
  const maxBytes = Math.min(args.maxBytes ?? 4096, 65536);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let body;
  try {
    const response = await fetch(args.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'sekrun/0.1' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, maxBytes));
    body = text.length > 0 ? text : '(empty response)';
    if (buffer.byteLength > maxBytes) {
      body += `\n...[truncated ${buffer.byteLength - maxBytes} more bytes]`;
    }
  } finally {
    clearTimeout(timeout);
  }
  return body;
}

function parseArgs(argumentsText) {
  try {
    return JSON.parse(argumentsText || '{}');
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error.message}`);
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required string parameter '${name}' is missing or empty`);
  }
}

function entryKind(entry) {
  return entry.isDirectory() ? 'dir' : 'file';
}

async function walkFiles(dir, fn) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await walkFiles(full, fn);
    } else if (entry.isFile()) {
      await fn(full);
    }
  }
}
