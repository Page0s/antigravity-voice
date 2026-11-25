/**
 * Antigravity Voice Text-to-Speech Sanitizer & Output Filter Orchestrator (v2.1.0)
 * Single source of truth used by hooks, sidecar server, tests, and browser bundle.
 *
 * Orchestrates:
 *   block-parser -> specialized block renderers (tables, code, diagrams, math, callouts, lists)
 *                -> inline-normalizer (dual displayText + spokenText)
 *                -> context-aware chunker (balanced, parenthesis-safe, orphan-free)
 */

import { parseMarkdownBlocks } from './pipeline/block-parser.js';
import { chunkDualSegment, chunkSentences } from './pipeline/chunker.js';
import { renderCodeBlock, renderDiagramBlock } from './pipeline/code-handler.js';
import { normalizeInline } from './pipeline/inline-normalizer.js';
import { formatMathBlock } from './pipeline/math-reader.js';
import {
  DEFAULT_FILTER_OPTIONS,
  OUTPUT_PROFILES,
  detectMatchingProfile,
  parseCustomRules,
  resolveFilterOptions,
} from './pipeline/presets.js';
import { renderTableBlock } from './pipeline/table-reader.js';

export {
  DEFAULT_FILTER_OPTIONS,
  OUTPUT_PROFILES,
  chunkSentences,
  detectMatchingProfile,
  resolveFilterOptions,
};

function sanitizerEnsureTerminalPunct(str) {
  const t = String(str || '').trim();
  if (!t) return '';
  // Replace trailing semicolon on list items with period for crisp cadence
  const cleaned = t.replace(/;\s*$/, '.');
  return /[.!?:]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

/**
 * Full structured pipeline for speech synthesis and interactive transcript rendering.
 *
 * @param {string} rawText - Raw Markdown / LLM response text
 * @param {object} rawOptions - Filter options, profile name, or legacy v2.0.0 flags
 * @returns {{
 *   cleanText: string,
 *   displayText: string,
 *   segments: Array<{ text: string, spokenText: string, displayText: string, blockType: string, badge: string, expandable: object|null }>,
 *   stats: object,
 *   options: object
 * }}
 */
export function processForSpeech(rawText, rawOptions = {}) {
  const options = resolveFilterOptions(rawOptions);
  const stats = {
    tablesRead: 0,
    tablesSummarized: 0,
    tablesSkipped: 0,
    codeRead: 0,
    codeSummarized: 0,
    codeSkipped: 0,
    diagramsFiltered: 0,
    mathConverted: 0,
    urlsFiltered: 0,
    citationsStripped: 0,
    emojisStripped: 0,
    customSkipped: 0,
  };

  if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
    return {
      cleanText: '',
      displayText: '',
      segments: [],
      stats,
      options,
    };
  }

  const { skipPrefixes } = parseCustomRules(options.customRules);
  const shouldCustomSkip = (content) => {
    if (skipPrefixes.length === 0 || !content) return false;
    const lower = content.trim().toLowerCase();
    return skipPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()) || lower.includes(prefix.toLowerCase()));
  };

  const blocks = parseMarkdownBlocks(rawText);
  const preChunkSegments = [];

  for (const block of blocks) {
    if (block.type === 'hr') {
      continue;
    }

    if (block.content && shouldCustomSkip(block.content)) {
      stats.customSkipped++;
      continue;
    }

    if (block.type === 'code') {
      const codeSegs = renderCodeBlock(block.lang, block.content, options, stats);
      preChunkSegments.push(...codeSegs);
      continue;
    }

    if (block.type === 'diagram') {
      const diagSegs = renderDiagramBlock(block.kind || 'diagram', '', block.content, options, stats);
      preChunkSegments.push(...diagSegs);
      continue;
    }

    if (block.type === 'table') {
      const tableSegs = renderTableBlock(block.table, options, stats);
      preChunkSegments.push(...tableSegs);
      continue;
    }

    if (block.type === 'math') {
      const mathSeg = formatMathBlock(block.content, options);
      if (mathSeg) {
        if (mathSeg.skipped) {
          stats.mathConverted++;
        } else {
          stats.mathConverted++;
          preChunkSegments.push(mathSeg);
        }
      }
      continue;
    }

    if (block.type === 'heading') {
      const norm = normalizeInline(block.content, options, stats);
      if (!norm.spokenText) continue;
      const announce = options.structure === 'announce';
      const disp = sanitizerEnsureTerminalPunct(norm.displayText || norm.spokenText);
      const spkCore = sanitizerEnsureTerminalPunct(norm.spokenText);
      const spk = announce && block.level <= 2 ? `Section: ${spkCore}` : spkCore;
      preChunkSegments.push({
        blockType: 'heading',
        badge: `H${Math.min(block.level || 1, 6)}`,
        displayText: disp,
        spokenText: spk,
      });
      continue;
    }

    if (block.type === 'callout') {
      if (options.callouts === 'skip') continue;
      const norm = normalizeInline(block.content, options, stats);
      if (!norm.spokenText) continue;
      const label = block.calloutType || 'Note';
      const disp = sanitizerEnsureTerminalPunct(
        options.callouts === 'announce' ? `${label}: ${norm.displayText}` : norm.displayText
      );
      const spk = sanitizerEnsureTerminalPunct(
        options.callouts === 'announce' ? `${label}: ${norm.spokenText}` : norm.spokenText
      );
      preChunkSegments.push({
        blockType: 'callout',
        badge: label.toUpperCase(),
        displayText: disp,
        spokenText: spk,
      });
      continue;
    }

    if (block.type === 'quote') {
      if (options.callouts === 'skip') continue;
      const norm = normalizeInline(block.content, options, stats);
      if (!norm.spokenText) continue;
      const disp = sanitizerEnsureTerminalPunct(norm.displayText);
      const spk = sanitizerEnsureTerminalPunct(
        options.callouts === 'announce' ? `Quote: ${norm.spokenText}` : norm.spokenText
      );
      preChunkSegments.push({
        blockType: 'quote',
        badge: 'QUOTE',
        displayText: disp,
        spokenText: spk,
      });
      continue;
    }

    if (block.type === 'task-item') {
      const norm = normalizeInline(block.content, options, stats);
      if (!norm.spokenText) continue;
      const dispPrefix = block.checked ? 'Done: ' : 'To do: ';
      const spkPrefix = block.checked ? 'Done: ' : 'To do: ';
      preChunkSegments.push({
        blockType: 'task-item',
        badge: block.checked ? 'DONE' : 'TODO',
        displayText: sanitizerEnsureTerminalPunct(`${dispPrefix}${norm.displayText}`),
        spokenText: sanitizerEnsureTerminalPunct(`${spkPrefix}${norm.spokenText}`),
      });
      continue;
    }

    if (block.type === 'list-item') {
      const norm = normalizeInline(block.content, options, stats);
      if (!norm.spokenText) continue;
      const announceNum = options.structure === 'announce' && block.ordered && Number.isFinite(block.number);
      const dispPrefix = block.ordered && Number.isFinite(block.number) ? `${block.number}. ` : '';
      const spkPrefix = announceNum ? `Item ${block.number}: ` : '';
      preChunkSegments.push({
        blockType: 'list-item',
        badge: '',
        displayText: sanitizerEnsureTerminalPunct(`${dispPrefix}${norm.displayText}`),
        spokenText: sanitizerEnsureTerminalPunct(`${spkPrefix}${norm.spokenText}`),
      });
      continue;
    }

    // Default: paragraph
    const norm = normalizeInline(block.content, options, stats);
    if (!norm.spokenText) continue;
    preChunkSegments.push({
      blockType: 'paragraph',
      badge: '',
      displayText: norm.displayText,
      spokenText: norm.spokenText,
    });
  }

  // Chunk each block cleanly while keeping displayText & spokenText synchronized
  const finalSegments = [];
  for (const seg of preChunkSegments) {
    const chunked = chunkDualSegment(seg, options.maxChunkLength);
    finalSegments.push(...chunked);
  }

  const cleanText = finalSegments
    .map((s) => s.spokenText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const displayText = finalSegments
    .map((s) => s.displayText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    cleanText,
    displayText,
    segments: finalSegments,
    stats,
    options,
  };
}

/**
 * Formats a concise human-readable filter summary (e.g. "1 table summarized • 2 citations removed").
 */
export function formatFilterStatsSummary(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const parts = [];
  if (stats.tablesRead > 0) parts.push(`${stats.tablesRead} ${stats.tablesRead === 1 ? 'table' : 'tables'} read`);
  if (stats.tablesSummarized > 0) parts.push(`${stats.tablesSummarized} ${stats.tablesSummarized === 1 ? 'table' : 'tables'} summarized`);
  if (stats.tablesSkipped > 0) parts.push(`${stats.tablesSkipped} ${stats.tablesSkipped === 1 ? 'table' : 'tables'} skipped`);
  if (stats.codeSummarized > 0) parts.push(`${stats.codeSummarized} code ${stats.codeSummarized === 1 ? 'block' : 'blocks'} summarized`);
  if (stats.codeSkipped > 0) parts.push(`${stats.codeSkipped} code ${stats.codeSkipped === 1 ? 'block' : 'blocks'} skipped`);
  if (stats.diagramsFiltered > 0) parts.push(`${stats.diagramsFiltered} ${stats.diagramsFiltered === 1 ? 'diagram' : 'diagrams'} filtered`);
  if (stats.mathConverted > 0) parts.push(`${stats.mathConverted} math`);
  if (stats.citationsStripped > 0) parts.push(`${stats.citationsStripped} ${stats.citationsStripped === 1 ? 'citation' : 'citations'} stripped`);
  return parts.join(' • ');
}

/**
 * Backwards-compatible text sanitizer returning the spoken-friendly string.
 * @param {string} text
 * @param {object} options
 * @returns {string}
 */
export function sanitizeText(text, options = {}) {
  return processForSpeech(text, options).cleanText;
}
