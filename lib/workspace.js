import fs from 'node:fs/promises';
import path from 'node:path';

export class Workspace {
  static async open(rootPath) {
    const root = normalizeAbsolute(rootPath);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
    return new Workspace(root);
  }

  constructor(root) {
    this.root = normalizeAbsolute(root);
  }

  async resolvePath(inputPath) {
    const resolved = path.isAbsolute(inputPath)
      ? normalizeAbsolute(inputPath)
      : normalizeAbsolute(path.resolve(this.root, inputPath));
    if (!isSubPath(this.root, resolved)) {
      throw new Error('PathOutsideWorkspace');
    }
    return resolved;
  }

  relativePath(absolutePath) {
    const normalized = normalizeAbsolute(absolutePath);
    if (normalized === this.root) return '.';
    if (!isSubPath(this.root, normalized)) return normalized;
    return path.relative(this.root, normalized) || '.';
  }

  bashNeedsApproval(command) {
    const lower = command.toLowerCase();
    const patterns = [
      'curl ',
      'curl\t',
      'wget ',
      'http://',
      'https://',
      'ftp://',
      'invoke-webrequest',
      'iwr ',
      'ssh ',
      'scp ',
      'nc ',
      'ncat ',
      'npm install',
      'pnpm install',
      'yarn add',
      'pip install',
      'git push',
      'git fetch',
      'git pull',
    ];
    return patterns.some((pattern) => lower.includes(pattern)) || command.includes('../') || command.includes('..\\');
  }
}

export function normalizeAbsolute(inputPath) {
  let resolved = path.resolve(inputPath);
  while (resolved.length > path.parse(resolved).root.length && /[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === 'win32' ? resolved.replaceAll('/', '\\') : resolved;
}

export function isSubPath(root, candidate) {
  const normalizedRoot = normalizeAbsolute(root);
  const normalizedCandidate = normalizeAbsolute(candidate);
  if (process.platform === 'win32') {
    const r = normalizedRoot.toLowerCase();
    const c = normalizedCandidate.toLowerCase();
    return c === r || c.startsWith(`${r}\\`) || c.startsWith(`${r}/`);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
