/**
 * Markdown & HTML Table Parser, Adaptive Natural Linearizer & Summarizer
 * Supports:
 *   - Standard GFM tables (`| A | B |`)
 *   - Indented tables & pipe-less tables (`A | B\n--- | ---`)
 *   - 2-column key-value phrasing vs. multi-column header-paired row phrasing
 *   - Smart mode (read small tables, summarize large tables with on-demand Read full)
 */

import { normalizeInline } from './inline-normalizer.js';

const TABLE_EMPTY_CELL_REGEX = /^(?:-|—|–|n\/a|none|null|\u2014|\u2013|\s)*$/i;

/**
 * Splits a single Markdown table line into trimmed cell strings, honoring escaped `\|` and inline code.
 */
export function parseMarkdownTableRow(line) {
  if (!line || typeof line !== 'string') return [];
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);

  const cells = [];
  let buf = '';
  let inCode = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      buf += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

/**
 * Tests whether a Markdown line is a valid table separator row (`| :--- | :---: | --- |`).
 */
export function isTableSeparatorLine(line) {
  if (!line || typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  if (!trimmed.includes('|') && !/^:?-{3,}:?$/.test(trimmed)) return false;
  const cells = parseMarkdownTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/**
 * Parses an array of Markdown table lines into { headers, rows }.
 */
export function parseMarkdownTable(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return null;

  const headers = parseMarkdownTableRow(lines[0]);
  if (headers.length === 0) return null;

  const hasSep = isTableSeparatorLine(lines[1]);
  const dataStart = hasSep ? 2 : 1;
  const rows = [];

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || isTableSeparatorLine(line)) continue;
    const cells = parseMarkdownTableRow(line);
    if (cells.every((c) => !c)) continue;
    // Pad or trim to header length
    const normalized = [];
    for (let c = 0; c < headers.length; c++) {
      normalized.push(cells[c] !== undefined ? cells[c] : '');
    }
    rows.push(normalized);
  }

  return { headers, rows };
}

/**
 * Parses an HTML <table>...</table> string into { headers, rows }.
 */
export function parseHtmlTable(html) {
  if (!html || typeof html !== 'string') return null;
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) return null;

  const extracted = rowMatches.map((m) => {
    const cells = [...m[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
      c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    );
    return cells;
  }).filter((r) => r.length > 0);

  if (extracted.length === 0) return null;
  return {
    headers: extracted[0],
    rows: extracted.slice(1),
  };
}

/**
 * Builds natural spoken + display segments for every row of a parsed table.
 */
function tableBuildReadSegments(parsed, options, stats) {
  const { headers, rows } = parsed;
  const cleanHeaders = headers.map((h) => normalizeInline(h, options, stats));
  const colCount = cleanHeaders.length;
  const segments = [];

  const headerDispList = cleanHeaders.map((h) => h.displayText).filter(Boolean);
  const headerSpkList = cleanHeaders.map((h) => h.spokenText).filter(Boolean);

  // Brief natural intro naming the columns
  if (headerSpkList.length > 0) {
    const dispJoin =
      headerDispList.length === 2
        ? `${headerDispList[0]} and ${headerDispList[1]}`
        : headerDispList.join(', ');
    const spkJoin =
      headerSpkList.length === 2
        ? `${headerSpkList[0]} and ${headerSpkList[1]}`
        : headerSpkList.join(', ');

    segments.push({
      blockType: 'table-header',
      badge: 'TABLE',
      displayText: `Table (${rows.length} ${rows.length === 1 ? 'row' : 'rows'}): ${dispJoin}.`,
      spokenText: `Table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}: ${spkJoin}.`,
    });
  }

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const cleanCells = row.map((cell) => normalizeInline(cell, options, stats));

    if (colCount === 2) {
      // 2-column key-value style: "WebGPU: Supported."
      const keyDisp = cleanCells[0]?.displayText || `Row ${rIdx + 1}`;
      const keySpk = cleanCells[0]?.spokenText || `Row ${rIdx + 1}`;
      const valRaw = row[1] || '';
      const valEmpty = TABLE_EMPTY_CELL_REGEX.test(valRaw.trim());
      const valDisp = valEmpty ? 'none' : cleanCells[1]?.displayText || 'none';
      const valSpk = valEmpty ? 'none' : cleanCells[1]?.spokenText || 'none';

      segments.push({
        blockType: 'table-row',
        badge: 'TABLE',
        displayText: tableEnsurePunct(`${keyDisp}: ${valDisp}`),
        spokenText: tableEnsurePunct(`${keySpk}: ${valSpk}`),
      });
    } else {
      // Multi-column style: lead with column 1 value (if non-empty), pair remaining columns with header names
      const dispParts = [];
      const spkParts = [];

      const firstCellRaw = row[0] || '';
      const firstEmpty = TABLE_EMPTY_CELL_REGEX.test(firstCellRaw.trim());
      if (!firstEmpty && cleanCells[0]?.spokenText) {
        dispParts.push(cleanCells[0].displayText);
        spkParts.push(cleanCells[0].spokenText);
      } else {
        dispParts.push(`Row ${rIdx + 1}`);
        spkParts.push(`Row ${rIdx + 1}`);
      }

      for (let c = 1; c < colCount; c++) {
        const rawCell = (row[c] || '').trim();
        if (TABLE_EMPTY_CELL_REGEX.test(rawCell)) continue;
        const hDisp = cleanHeaders[c]?.displayText || `Column ${c + 1}`;
        const hSpk = cleanHeaders[c]?.spokenText || `Column ${c + 1}`;
        const vDisp = cleanCells[c]?.displayText || '';
        const vSpk = cleanCells[c]?.spokenText || '';
        if (!vSpk) continue;

        dispParts.push(`${hDisp}: ${vDisp}`);
        spkParts.push(`${hSpk} is ${vSpk}`);
      }

      const dispSentence = dispParts.length > 1 ? `${dispParts[0]} — ${dispParts.slice(1).join('; ')}` : dispParts[0];
      const spkSentence = spkParts.length > 1 ? `${spkParts[0]}: ${spkParts.slice(1).join(', ')}` : spkParts[0];

      segments.push({
        blockType: 'table-row',
        badge: 'TABLE',
        displayText: tableEnsurePunct(dispSentence),
        spokenText: tableEnsurePunct(spkSentence),
      });
    }
  }

  return segments;
}

/**
 * Converts a parsed table into spoken segments based on options.tables (`smart` | `read` | `summarize` | `skip`).
 */
export function renderTableBlock(parsed, options = {}, stats = null) {
  if (!parsed || !parsed.headers || parsed.headers.length === 0) return [];

  const mode = options.tables || 'smart';
  const rowCount = parsed.rows.length;
  const colCount = parsed.headers.length;

  if (mode === 'skip') {
    if (stats) stats.tablesSkipped = (stats.tablesSkipped || 0) + 1;
    return [];
  }

  const maxRows = options.smartTableMaxRows ?? 6;
  const maxCols = options.smartTableMaxCols ?? 4;
  const shouldReadFull =
    mode === 'read' || (mode === 'smart' && rowCount > 0 && rowCount <= maxRows && colCount <= maxCols);

  if (shouldReadFull) {
    if (stats) stats.tablesRead = (stats.tablesRead || 0) + 1;
    return tableBuildReadSegments(parsed, options, stats);
  }

  // Summarize mode (or large table in smart mode) with on-demand `Read rows` expansion!
  if (stats) stats.tablesSummarized = (stats.tablesSummarized || 0) + 1;

  const cleanHeaders = parsed.headers.map((h) => normalizeInline(h, options, null));
  const dispHeaders = cleanHeaders.map((h) => h.displayText).filter(Boolean).join(', ');
  const spkHeaders = cleanHeaders.map((h) => h.spokenText).filter(Boolean).join(', ');

  const rowWord = rowCount === 1 ? 'row' : 'rows';
  const colWord = colCount === 1 ? 'column' : 'columns';

  const summaryDisp = dispHeaders
    ? `Table with ${rowCount} ${rowWord} and ${colCount} ${colWord}: ${dispHeaders}.`
    : `Table with ${rowCount} ${rowWord} and ${colCount} ${colWord}.`;

  const summarySpk = spkHeaders
    ? `Table with ${rowCount} ${rowWord} and ${colCount} ${colWord}: ${spkHeaders}.`
    : `Table with ${rowCount} ${rowWord} and ${colCount} ${colWord}.`;

  // Pre-build expandable segments so the user can click "Read rows" right in the Live Monitor!
  const fullSegments = rowCount > 0 ? tableBuildReadSegments(parsed, options, null) : [];

  return [
    {
      blockType: 'table-summary',
      badge: 'TABLE',
      displayText: summaryDisp,
      spokenText: summarySpk,
      expandable:
        fullSegments.length > 0
          ? {
              kind: 'table',
              label: `Read ${rowCount} ${rowWord}`,
              segments: fullSegments,
            }
          : null,
    },
  ];
}

function tableEnsurePunct(str) {
  const t = String(str || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
