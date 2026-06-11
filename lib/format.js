const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  // Extended colors for richer display
  heading: '\x1b[38;5;75m',   // bright blue
  subheading: '\x1b[38;5;117m', // light blue
  listBullet: '\x1b[38;5;78m', // greenish teal
  inlineCode: '\x1b[38;5;209m', // warm orange for inline code
  codeBlock: '\x1b[38;5;245m',  // gray for code blocks
  tableBorder: '\x1b[38;5;240m', // dark gray
};

export function printBeautified(text) {
  const lines = String(text).split('\n');
  let inCode = false;
  let inTable = false;
  const tableBuffer = [];

  function flushTable() {
    if (tableBuffer.length === 0) return;
    printTable(tableBuffer);
    tableBuffer.length = 0;
    inTable = false;
  }

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    // Strip trailing carriage return for consistent handling
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (line.startsWith('```')) {
      flushTable();
      if (inCode) {
        // Closing fence — do not output the fence line, just exit code mode
        inCode = false;
      } else {
        // Opening fence — enter code mode, do not output the fence line
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      console.log(`${color.codeBlock}${line}${color.reset}`);
      continue;
    }

    if (isTableLine(line)) {
      tableBuffer.push(line);
      inTable = true;
      continue;
    }

    if (inTable) flushTable();

    // Heading: strip # prefix, output bold+colored text
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#+)/)[1].length;
      const headingColor = level === 1 ? color.heading : color.subheading;
      const headingText = renderInline(line.replace(/^#+\s*/, ''));
      console.log(`${color.bold}${headingColor}${headingText}${color.reset}`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const listBody = line.replace(/^(\s*)[-*]\s+/, `$1${color.listBullet}${color.bold}\u2022${color.reset} `);
      console.log(renderInline(listBody));
      continue;
    }
    console.log(renderInline(line));
  }

  if (inTable) flushTable();
}

function isTableLine(line) {
  const trimmed = line.trim();
  // A table line starts and ends with |, or is a separator like |---|---|
  return /^\|/.test(trimmed) && /\|$/.test(trimmed);
}

function printTable(lines) {
  // Filter out separator lines (| --- | --- |), but note their alignment
  const dataRows = [];
  let separators = null;

  for (const line of lines) {
    const cells = splitPipeCells(line);
    if (isSeparatorRow(cells)) {
      separators = cells;
    } else {
      dataRows.push(cells);
    }
  }

  if (dataRows.length === 0) return;

  // Apply inline formatting to all cells first
  const formattedRows = dataRows.map((row) => row.map((cell) => renderInline(cell)));

  // Calculate column widths
  const colCount = Math.max(...formattedRows.map((r) => r.length));
  const colWidths = new Array(colCount).fill(0);
  for (const row of formattedRows) {
    for (let i = 0; i < row.length; i += 1) {
      colWidths[i] = Math.max(colWidths[i], stringWidth(row[i]));
    }
  }

  // Render rows
  for (let ri = 0; ri < formattedRows.length; ri += 1) {
    const row = formattedRows[ri];
    const padded = row.map((cell, ci) => padCell(cell, colWidths[ci] || 0));
    while (padded.length < colCount) padded.push(' '.repeat(colWidths[padded.length] || 0));
    const formatted = padded.join(` ${color.tableBorder}\u2502${color.reset} `);
    console.log(`${color.tableBorder}\u2502${color.reset} ${formatted} ${color.tableBorder}\u2502${color.reset}`);

    // After header row (first row), print separator
    if (ri === 0) {
      const sep = colWidths.map((w) => color.tableBorder + '\u2500'.repeat(w + 2) + color.reset).join('\u253c');
      console.log(`${color.tableBorder}\u251c${color.reset}${sep}${color.tableBorder}\u2524${color.reset}`);
    }
  }
}

function splitPipeCells(line) {
  const trimmed = line.trim();
  // Strip leading and trailing |
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let inBacktick = false;
  for (const ch of inner) {
    if (ch === '`') inBacktick = !inBacktick;
    if (ch === '|' && !inBacktick) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

/**
 * 获取字符串在终端中的显示宽度。
 * 中文字符占 2 列，ANSI 转义序列和零宽字符占 0 列。
 * 自实现，无外部依赖。
 */
function stringWidth(str) {
  let width = 0;
  let i = 0;
  const len = str.length;

  while (i < len) {
    const code = str.charCodeAt(i);

    // --- 1. 跳过 ANSI 转义序列 (\x1b[...m) ---
    if (code === 0x1b) {
      i += 1;
      // 标准 CSI 序列: \x1b[ 参数... 结束符
      if (i < len && str[i] === '[') {
        i += 1;
        while (i < len) {
          const ch = str[i];
          i += 1;
          // 结束字符范围: 0x40-0x7e
          if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              ch === '@' || ch === '[' || ch === '\\' || ch === ']' ||
              ch === '^' || ch === '_' || ch === '`' || ch === '{' ||
              ch === '|' || ch === '}' || ch === '~') {
            break;
          }
        }
      }
      // 其他以 \x1b 开头的序列，直接跳过
      continue;
    }

    // --- 2. 控制字符 (0x00-0x1f, 0x7f) ---
    if (code <= 0x1f || code === 0x7f) {
      if (code === 0x09) { // \t — 按 4 列制表位估算
        width += 4;
      }
      // 其他控制字符不占宽度
      i += 1;
      continue;
    }

    // --- 3. 零宽字符 ---
    if (isZeroWidth(code)) {
      i += 1;
      continue;
    }

    // --- 4. Emoji / 代理对 (Surrogate pairs) ---
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      // 高代理对，后面跟低代理对
      i += 2;
      width += 2; // Emoji 通常占 2 列
      continue;
    }

    // --- 5. 全宽字符 ---
    if (isWide(code)) {
      width += 2;
    } else {
      width += 1;
    }
    i += 1;
  }

  return width;
}

/**
 * 判断 Unicode 码点是否为全宽字符。
 */
function isWide(code) {
  return (
    // CJK 统一表意文字
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK 统一表意文字扩展 A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK 统一表意文字扩展 B
    (code >= 0x20000 && code <= 0x2a6df) ||
    // CJK 统一表意文字扩展 C-F
    (code >= 0x2a700 && code <= 0x2b73f) ||
    // CJK 兼容表意文字
    (code >= 0xf900 && code <= 0xfaff) ||
    // 全角 ASCII 变体 (FF01-FF60)
    (code >= 0xff01 && code <= 0xff60) ||
    // 全角符号 (FFE0-FFE6)
    (code >= 0xffe0 && code <= 0xffe6) ||
    // CJK 符号和标点 (3000-303F)
    (code >= 0x3000 && code <= 0x303f) ||
    // 平假名、片假名
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    // 谚文音节和谚文字母
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    // CJK 兼容表意文字补充
    (code >= 0x2f800 && code <= 0x2fa1f) ||
    // 康熙部首
    (code >= 0x2f00 && code <= 0x2fdf) ||
    // 易经六十四卦符号
    (code >= 0x4dc0 && code <= 0x4dff) ||
    // 带圈 CJK 字符 和 CJK 兼容字符
    (code >= 0x3200 && code <= 0x32ff) ||
    (code >= 0x3300 && code <= 0x33ff)
  );
}

/**
 * 判断是否为零宽字符。
 */
function isZeroWidth(code) {
  return (
    code === 0x200b || // ZERO WIDTH SPACE
    code === 0x200c || // ZERO WIDTH NON-JOINER
    code === 0x200d || // ZERO WIDTH JOINER
    code === 0xfeff || // ZERO WIDTH NO-BREAK SPACE (BOM)
    code === 0x2060 || // WORD JOINER
    code === 0x2061 || // FUNCTION APPLICATION
    code === 0x2062 || // INVISIBLE TIMES
    code === 0x2063 || // INVISIBLE SEPARATOR
    code === 0x2064 || // INVISIBLE PLUS
    // 组合用变音符号
    (code >= 0x0300 && code <= 0x036f) ||
    // 组合用附加符号扩展
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    // 异体字选择符
    (code >= 0xfe00 && code <= 0xfe0f) ||
    // 组合用半角符号
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function padCell(cell, width) {
  const vis = stringWidth(cell);
  const padding = Math.max(0, width - vis);
  return cell + ' '.repeat(padding);
}

function renderInline(line) {
  return line
    .replace(/\*\*([^*]+)\*\*/g, `${color.bold}$1${color.reset}`)
    .replace(/`([^`]+)`/g, `${color.inlineCode}$1${color.reset}`);
}
