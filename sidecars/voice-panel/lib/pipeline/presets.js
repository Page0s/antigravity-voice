/**
 * Output Filter Profiles, Default Options & Legacy Setting Migration
 * Shared across Node.js hooks, sidecar server, and browser panel bundle.
 */

export const DEFAULT_FILTER_OPTIONS = Object.freeze({
  profile: 'balanced', // 'balanced' | 'full' | 'prose' | 'minimal' | 'custom'
  tables: 'smart', // 'smart' | 'read' | 'summarize' | 'skip'
  smartTableMaxRows: 6,
  smartTableMaxCols: 4,
  codeBlocks: 'smart', // 'smart' | 'summarize' | 'read' | 'skip'
  diagrams: 'summarize', // 'summarize' | 'skip'
  math: 'natural', // 'natural' | 'summarize' | 'skip' | 'literal'
  urls: 'domain', // 'domain' | 'skip' | 'keep'
  filePaths: 'filename', // 'filename' | 'natural' | 'literal' | 'skip'
  symbols: 'natural', // 'natural' | 'minimal' | 'literal'
  callouts: 'announce', // 'announce' | 'read' | 'skip'
  structure: 'clean', // 'clean' | 'announce'
  emojis: 'status', // 'status' | 'strip' | 'keep'
  stripCitations: true,
  stripHashesAndIds: true,
  humanizeIdentifiers: false,
  customRules: '', // Multiline "term => spoken" or "skip: pattern"
  maxChunkLength: 195,
});

export const OUTPUT_PROFILES = Object.freeze({
  balanced: Object.freeze({
    id: 'balanced',
    label: 'Balanced',
    shortLabel: 'Balanced',
    description: 'Smart tables (read small, summarize large), concise code summaries, smooth symbol & math reading',
    options: {
      tables: 'smart',
      codeBlocks: 'smart',
      diagrams: 'summarize',
      math: 'natural',
      urls: 'domain',
      filePaths: 'filename',
      symbols: 'natural',
      callouts: 'announce',
      structure: 'clean',
      emojis: 'status',
      stripCitations: true,
      stripHashesAndIds: true,
      humanizeIdentifiers: false,
    },
  }),
  full: Object.freeze({
    id: 'full',
    label: 'Room Listen',
    shortLabel: 'Full Listen',
    description: 'Hands-free mode: reads all tables row-by-row, announces structure, callouts, math & paths thoroughly',
    options: {
      tables: 'read',
      codeBlocks: 'smart',
      diagrams: 'summarize',
      math: 'natural',
      urls: 'domain',
      filePaths: 'natural',
      symbols: 'natural',
      callouts: 'announce',
      structure: 'announce',
      emojis: 'status',
      stripCitations: true,
      stripHashesAndIds: true,
      humanizeIdentifiers: true,
    },
  }),
  prose: Object.freeze({
    id: 'prose',
    label: 'Prose Only',
    shortLabel: 'Prose Only',
    description: 'Skips tables, code blocks, diagrams & bare URLs to speak only clean explanations',
    options: {
      tables: 'skip',
      codeBlocks: 'skip',
      diagrams: 'skip',
      math: 'summarize',
      urls: 'skip',
      filePaths: 'filename',
      symbols: 'natural',
      callouts: 'read',
      structure: 'clean',
      emojis: 'strip',
      stripCitations: true,
      stripHashesAndIds: true,
      humanizeIdentifiers: true,
    },
  }),
  minimal: Object.freeze({
    id: 'minimal',
    label: 'Minimal',
    shortLabel: 'Minimal',
    description: 'Light Markdown cleanup with minimal rewriting of symbols, URLs, and paths',
    options: {
      tables: 'summarize',
      codeBlocks: 'summarize',
      diagrams: 'summarize',
      math: 'literal',
      urls: 'keep',
      filePaths: 'literal',
      symbols: 'minimal',
      callouts: 'read',
      structure: 'clean',
      emojis: 'strip',
      stripCitations: false,
      stripHashesAndIds: false,
      humanizeIdentifiers: false,
    },
  }),
});

const FILTER_OPTION_KEYS = [
  'tables',
  'codeBlocks',
  'diagrams',
  'math',
  'urls',
  'filePaths',
  'symbols',
  'callouts',
  'structure',
  'emojis',
  'stripCitations',
  'stripHashesAndIds',
  'humanizeIdentifiers',
];

/**
 * Resolves options from either the new structured `outputFilters` object
 * or legacy v2.0.0 flags (`skipCodeBlocks`, `stripUrls`, `stripTables`).
 */
export function resolveFilterOptions(rawOptions = {}) {
  const input = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const nested = input.outputFilters && typeof input.outputFilters === 'object' ? input.outputFilters : null;
  const mergedInput = nested ? { ...nested, ...input } : { ...input };

  // Start from profile preset if one was explicitly specified
  let base = { ...DEFAULT_FILTER_OPTIONS };
  if (mergedInput.profile && OUTPUT_PROFILES[mergedInput.profile]) {
    base = { ...base, ...OUTPUT_PROFILES[mergedInput.profile].options, profile: mergedInput.profile };
  }

  // Apply explicit new-style overrides
  for (const key of FILTER_OPTION_KEYS) {
    if (mergedInput[key] !== undefined) {
      base[key] = mergedInput[key];
    }
  }
  if (typeof mergedInput.smartTableMaxRows === 'number' && mergedInput.smartTableMaxRows > 0) {
    base.smartTableMaxRows = mergedInput.smartTableMaxRows;
  }
  if (typeof mergedInput.smartTableMaxCols === 'number' && mergedInput.smartTableMaxCols > 0) {
    base.smartTableMaxCols = mergedInput.smartTableMaxCols;
  }
  if (typeof mergedInput.customRules === 'string') {
    base.customRules = mergedInput.customRules;
  }
  if (typeof mergedInput.maxChunkLength === 'number' && mergedInput.maxChunkLength >= 60) {
    base.maxChunkLength = mergedInput.maxChunkLength;
  }

  // Legacy v2.0.0 compatibility flags (only apply when modern equivalent was not explicitly passed)
  if (mergedInput.skipCodeBlocks === true && mergedInput.codeBlocks === undefined && !nested?.codeBlocks) {
    base.codeBlocks = 'skip';
  }
  if (mergedInput.stripUrls === false && mergedInput.urls === undefined && !nested?.urls) {
    base.urls = 'keep';
  }
  if (mergedInput.stripTables === false && mergedInput.tables === undefined && !nested?.tables) {
    base.tables = 'read';
  } else if (mergedInput.stripTables === true && mergedInput.tables === undefined && !nested?.tables && !mergedInput.profile) {
    base.tables = 'summarize';
  }

  // Detect matching preset or mark custom
  base.profile = detectMatchingProfile(base);
  return base;
}

export function detectMatchingProfile(options) {
  for (const [id, preset] of Object.entries(OUTPUT_PROFILES)) {
    const matches = FILTER_OPTION_KEYS.every((k) => options[k] === preset.options[k]);
    if (matches) return id;
  }
  return 'custom';
}

/**
 * Parses user-defined custom pronunciation & skip rules.
 * Syntax per line:
 *   kubectl => kube control
 *   Kokoro -> Koh-koh-roh
 *   skip: DEBUG:
 */
export function parseCustomRules(rulesText = '') {
  const replacements = [];
  const skipPrefixes = [];

  if (!rulesText || typeof rulesText !== 'string') {
    return { replacements, skipPrefixes };
  }

  const lines = rulesText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const skipMatch = line.match(/^skip\s*:\s*(.+)$/i);
    if (skipMatch && skipMatch[1].trim()) {
      skipPrefixes.push(skipMatch[1].trim());
      continue;
    }

    const repMatch = line.match(/^(.+?)\s*(?:=>|->|=)\s*(.*)$/);
    if (repMatch && repMatch[1].trim()) {
      replacements.push({
        from: repMatch[1].trim(),
        to: repMatch[2].trim(),
      });
    }
  }

  return { replacements, skipPrefixes };
}
