/**
 * Block-Level Markdown & Antigravity Output Parser
 * Parses raw LLM / .md content into typed structural blocks BEFORE inline cleaning
 * so headings, tables, nested lists, task items, callouts, math, code, and diagrams
 * preserve clean conversational boundaries.
 */

import { detectAsciiVisualType } from './code-handler.js';
import { isTableSeparatorLine, parseHtmlTable, parseMarkdownTable } from './table-reader.js';

const BLOCK_CALLOUT_LABELS = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

/**
 * Pre-strips invisible/non-spoken container tags (<think>, <style>, <script>, <svg>, HTML comments)
 * and unwraps Antigravity carousel slide markers cleanly.
 */
function blockPreprocessDocument(rawText) {
  let s = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Remove ANSI escape sequences globally
  s = s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Strip reasoning/hidden/non-text HTML blocks completely
  s = s.replace(/<(think|thought|style|script|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n');
  s = s.replace(/<plugin-card\b[^>]*>[\s\S]*?<\/plugin-card>/gi, '\n');
  s = s.replace(/<!--\s*slide\s*-->/gi, '\n---\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Unwrap Antigravity ````carousel ... ```` wrappers while preserving inner blocks
  s = s.replace(/^`{4,}carousel\s*\n([\s\S]*?)^`{4,}\s*$/gm, '$1');

  // Unwrap <details><summary>Title</summary>Body</details> cleanly into heading-like break + body
  s = s.replace(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_, sum, body) => {
    return `\n\n**${sum.trim()}**\n\n${body.trim()}\n\n`;
  });

  // Remove reference-style link definitions (`[1]: https://...`) & footnote definitions (`[^1]: ...`)
  s = s.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '');

  return s;
}

/**
 * Checks whether line `i` starts a Markdown table (with or without outer pipes, possibly indented).
 */
function blockStartsMarkdownTable(lines, i) {
  if (i + 1 >= lines.length) return false;
  const headerLine = lines[i].trim();
  const sepLine = lines[i + 1].trim();
  if (!headerLine || !headerLine.includes('|')) return false;
  return isTableSeparatorLine(sepLine);
}

/**
 * Checks whether line `i` starts an unfenced ASCII directory tree or box diagram.
 */
function blockStartsAsciiTree(lines, i) {
  const line = lines[i];
  if (!/[├└│┌┐┘┬┴┼]/.test(line) && !/^\s*\+[-=]{2,}\+/.test(line)) return false;
  let count = 0;
  for (let j = i; j < Math.min(lines.length, i + 6); j++) {
    if (/[├└│┌┐┘┬┴┼▼▲]|\+[-=]{2,}\+/.test(lines[j])) count++;
  }
  return count >= 2;
}

/**
 * Checks whether a line starts a new distinct block (used to stop paragraph/list-item continuation).
 */
function blockIsBoundaryLine(lines, i) {
  const line = lines[i];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (/^\s*(?:\$\$|\\\[)/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) return true;
  if (/^\s*(?:[-*+•▪▸]|\d+[.)])\s+/.test(line)) return true;
  if (/^\s*<table\b/i.test(line)) return true;
  if (blockStartsMarkdownTable(lines, i)) return true;
  if (blockStartsAsciiTree(lines, i)) return true;
  return false;
}

/**
 * Parses a raw Markdown document into an ordered list of typed blocks.
 */
export function parseMarkdownBlocks(rawText) {
  const doc = blockPreprocessDocument(rawText);
  const lines = doc.split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Blank line
    if (!trimmed) {
      i++;
      continue;
    }

    // 2. Fenced code block (supports ```, ````, ~~~, and indented fences!)
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)(.*)$/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const lang = fenceMatch[3] || '';
      const closeRegex = new RegExp(`^\\s*${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
      const codeLines = [];
      i++;
      while (i < lines.length && !closeRegex.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({
        type: 'code',
        lang,
        content: codeLines.join('\n'),
      });
      continue;
    }

    // 3. Display math block: $$...$$ or \[...\] (single-line or multi-line)
    if (/^\s*\$\$/.test(line)) {
      const singleLine = trimmed.match(/^\$\$(.+?)\$\$$/);
      if (singleLine) {
        blocks.push({ type: 'math', content: singleLine[1].trim() });
        i++;
        continue;
      }
      const mathLines = [];
      const firstRest = trimmed.slice(2).trim();
      if (firstRest) mathLines.push(firstRest);
      i++;
      while (i < lines.length && !/\$\$\s*$/.test(lines[i].trim())) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const endLine = lines[i].trim().replace(/\$\$\s*$/, '').trim();
        if (endLine) mathLines.push(endLine);
        i++;
      }
      blocks.push({ type: 'math', content: mathLines.join(' ').trim() });
      continue;
    }

    if (/^\s*\\\[/.test(line)) {
      const singleLine = trimmed.match(/^\\\[(.+?)\\\]$/);
      if (singleLine) {
        blocks.push({ type: 'math', content: singleLine[1].trim() });
        i++;
        continue;
      }
      const mathLines = [];
      const firstRest = trimmed.slice(2).trim();
      if (firstRest) mathLines.push(firstRest);
      i++;
      while (i < lines.length && !/\\\]\s*$/.test(lines[i].trim())) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const endLine = lines[i].trim().replace(/\\\]\s*$/, '').trim();
        if (endLine) mathLines.push(endLine);
        i++;
      }
      blocks.push({ type: 'math', content: mathLines.join(' ').trim() });
      continue;
    }

    // 4. HTML <table>...</table> block
    if (/^\s*<table\b/i.test(line)) {
      const htmlLines = [];
      while (i < lines.length) {
        htmlLines.push(lines[i]);
        if (/<\/table>/i.test(lines[i])) {
          i++;
          break;
        }
        i++;
      }
      const parsedHtml = parseHtmlTable(htmlLines.join('\n'));
      if (parsedHtml) {
        blocks.push({ type: 'table', table: parsedHtml });
      }
      continue;
    }

    // 5. Markdown table (with or without outer pipes, including indented tables!)
    if (blockStartsMarkdownTable(lines, i)) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length) {
        const tl = lines[i].trim();
        if (!tl || !tl.includes('|')) break;
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = parseMarkdownTable(tableLines);
      if (parsed) {
        blocks.push({ type: 'table', table: parsed });
      }
      continue;
    }

    // 6. Unfenced ASCII tree / architecture diagram
    if (blockStartsAsciiTree(lines, i)) {
      const treeLines = [];
      while (i < lines.length && lines[i].trim() !== '' && (/[├└│┌┐┘┬┴┼▼▲]|\+[-=]{2,}\+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        treeLines.push(lines[i]);
        i++;
      }
      const rawTree = treeLines.join('\n');
      const asciiKind = detectAsciiVisualType(rawTree) || 'ascii-tree';
      blocks.push({ type: 'diagram', kind: asciiKind, content: rawTree });
      continue;
    }

    // 7. Horizontal rule (---, ***, ___)
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 8. ATX Heading (# Title .. ###### Title)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 9. Setext Heading (Title \n === or ---)
    if (i + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[i + 1]) && !/^\s*(?:[-*+>]|\d+[.)])\s+/.test(line)) {
      const isH1 = lines[i + 1].trim().startsWith('=');
      blocks.push({
        type: 'heading',
        level: isH1 ? 1 : 2,
        content: trimmed,
      });
      i += 2;
      continue;
    }

    // 10. Blockquote or GitHub/Antigravity Callout (> [!NOTE], > [!WARNING], > quote)
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const firstLine = (quoteLines[0] || '').trim();
      const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        const alertKey = alertMatch[1].toUpperCase();
        const restParts = [];
        if (alertMatch[2]) restParts.push(alertMatch[2]);
        for (let q = 1; q < quoteLines.length; q++) {
          const ql = quoteLines[q].trim();
          if (ql) restParts.push(ql);
        }
        blocks.push({
          type: 'callout',
          calloutType: BLOCK_CALLOUT_LABELS[alertKey] || alertKey,
          content: restParts.join(' ').trim(),
        });
      } else {
        const joinedQuote = quoteLines.map((l) => l.trim()).filter(Boolean).join(' ');
        if (joinedQuote) {
          blocks.push({
            type: 'quote',
            content: joinedQuote,
          });
        }
      }
      continue;
    }

    // 11. List item (unordered `-`, `*`, `+`, `•`, `▪`, `▸`, ordered `1.`, `1)`, and task lists `- [x]` / `- [ ]`)
    //     Handles ANY indentation depth cleanly!
    const taskMatch = line.match(/^(\s*)(?:[-*+])\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const checked = taskMatch[2].toLowerCase() === 'x';
      const itemParts = [taskMatch[3].trim()];
      i++;
      while (i < lines.length && !blockIsBoundaryLine(lines, i)) {
        itemParts.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: 'task-item',
        checked,
        indent,
        content: itemParts.join(' '),
      });
      continue;
    }

    const unorderedMatch = line.match(/^(\s*)(?:[-*+•▪▸])\s+(.+)$/);
    if (unorderedMatch) {
      const indent = unorderedMatch[1].length;
      const itemParts = [unorderedMatch[2].trim()];
      i++;
      while (i < lines.length && !blockIsBoundaryLine(lines, i)) {
        itemParts.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: 'list-item',
        ordered: false,
        indent,
        content: itemParts.join(' '),
      });
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (orderedMatch) {
      const indent = orderedMatch[1].length;
      const number = Number(orderedMatch[2]);
      const itemParts = [orderedMatch[3].trim()];
      i++;
      while (i < lines.length && !blockIsBoundaryLine(lines, i)) {
        itemParts.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: 'list-item',
        ordered: true,
        number,
        indent,
        content: itemParts.join(' '),
      });
      continue;
    }

    // 12. Standard paragraph (collect contiguous non-boundary lines; also handle inline $$...$$ cleanly)
    const paraLines = [trimmed];
    i++;
    while (i < lines.length && !blockIsBoundaryLine(lines, i)) {
      // Stop before Setext underline on the line after next
      if (i + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[i + 1])) {
        break;
      }
      paraLines.push(lines[i].trim());
      i++;
    }

    const joinedPara = paraLines.join(' ').trim();
    if (joinedPara) {
      // If paragraph contains inline display math `$$...$$`, split so display math is handled cleanly
      if (joinedPara.includes('$$')) {
        const parts = joinedPara.split(/(\$\$[\s\S]+?\$\$)/g);
        for (const p of parts) {
          const pt = p.trim();
          if (!pt) continue;
          const dm = pt.match(/^\$\$([\s\S]+?)\$\$$/);
          if (dm) {
            blocks.push({ type: 'math', content: dm[1].trim() });
          } else {
            blocks.push({ type: 'paragraph', content: pt });
          }
        }
      } else {
        blocks.push({ type: 'paragraph', content: joinedPara });
      }
    }
  }

  return blocks;
}
