/**
 * Inline Markdown, Symbol, Path, URL, Emoji & Pronunciation Normalizer
 * Produces dual representation:
 *   - displayText: clean readable text preserving helpful visual symbols
 *   - spokenText:  smooth TTS-optimized phrasing so Kokoro/SAPI never stumble
 */

import { latexToSpeech } from './math-reader.js';
import { parseCustomRules } from './presets.js';

const INLINE_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '...',
  rarr: '→',
  larr: '←',
  harr: '↔',
  rArr: '⇒',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
  le: '≤',
  ge: '≥',
  ne: '≠',
  approx: '≈',
  infin: '∞',
  copy: 'copyright',
  reg: 'registered',
  trade: 'trademark',
  bull: '•',
  middot: '·',
};

const INLINE_KEY_NAMES = {
  ctrl: 'Control',
  cmd: 'Command',
  alt: 'Alt',
  opt: 'Option',
  shift: 'Shift',
  esc: 'Escape',
  del: 'Delete',
  ins: 'Insert',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Return',
  space: 'Space',
  backspace: 'Backspace',
  pgup: 'Page Up',
  pgdn: 'Page Down',
  home: 'Home',
  end: 'End',
  win: 'Windows',
  meta: 'Meta',
};

const INLINE_UNIT_NAMES = {
  ms: 'milliseconds',
  ns: 'nanoseconds',
  us: 'microseconds',
  'µs': 'microseconds',
  'μs': 'microseconds',
  kb: 'kilobytes',
  mb: 'megabytes',
  gb: 'gigabytes',
  tb: 'terabytes',
  pb: 'petabytes',
  kib: 'kibibytes',
  mib: 'mebibytes',
  gib: 'gibibytes',
  bps: 'bits per second',
  kbps: 'kilobits per second',
  mbps: 'megabits per second',
  gbps: 'gigabits per second',
  fps: 'frames per second',
  hz: 'hertz',
  khz: 'kilohertz',
  mhz: 'megahertz',
  ghz: 'gigahertz',
  px: 'pixels',
  km: 'kilometers',
  cm: 'centimeters',
  mm: 'millimeters',
  kg: 'kilograms',
  mg: 'milligrams',
  ml: 'milliliters',
  mph: 'miles per hour',
  kph: 'kilometers per hour',
  min: 'minutes',
  mins: 'minutes',
  sec: 'seconds',
  secs: 'seconds',
  hr: 'hours',
  hrs: 'hours',
  wpm: 'words per minute',
};

const INLINE_DOT_EXT_SPOKEN = {
  md: 'dot M D',
  mdx: 'dot M D X',
  js: 'dot J S',
  mjs: 'dot M J S',
  cjs: 'dot C J S',
  ts: 'dot T S',
  tsx: 'dot T S X',
  jsx: 'dot J S X',
  json: 'dot JSON',
  jsonl: 'dot JSON L',
  yaml: 'dot YAML',
  yml: 'dot Y M L',
  toml: 'dot TOML',
  html: 'dot H T M L',
  css: 'dot C S S',
  scss: 'dot S C S S',
  py: 'dot P Y',
  rs: 'dot R S',
  go: 'dot go',
  sh: 'dot S H',
  ps1: 'dot P S 1',
  sql: 'dot S Q L',
  csv: 'dot C S V',
  xml: 'dot X M L',
  svg: 'dot S V G',
  png: 'dot P N G',
  jpg: 'dot J P G',
  jpeg: 'dot J P E G',
  wav: 'dot wave',
  mp3: 'dot M P 3',
  pdf: 'dot P D F',
  txt: 'dot text',
  env: 'dot env',
  log: 'dot log',
  lock: 'dot lock',
  exe: 'dot E X E',
};

const INLINE_SYMBOL_LITERAL_NAMES = {
  '-': 'dash',
  '–': 'en dash',
  '—': 'em dash',
  ';': 'semicolon',
  ':': 'colon',
  ',': 'comma',
  '.': 'period',
  '!': 'exclamation mark',
  '?': 'question mark',
  '#': 'hash',
  '*': 'asterisk',
  '**': 'double asterisk',
  '***': 'triple asterisk',
  _: 'underscore',
  __: 'double underscore',
  '`': 'backtick',
  '```': 'triple backtick',
  '~~~': 'triple tilde',
  '~': 'tilde',
  '|': 'pipe',
  '/': 'slash',
  '\\': 'backslash',
  '>': 'greater than',
  '<': 'less than',
  '=': 'equals',
  '==': 'double equals',
  '===': 'triple equals',
  '---': 'triple dash',
  '+': 'plus',
  '&': 'ampersand',
  '%': 'percent',
  '$': 'dollar sign',
  '@': 'at sign',
  '^': 'caret',
  '->': 'arrow',
  '=>': 'fat arrow',
  '→': 'arrow',
  '- [x]': 'checked checkbox',
  '- [ ]': 'unchecked checkbox',
  '[x]': 'checked box',
  '[ ]': 'unchecked box',
};

const INLINE_STATUS_EMOJIS = [
  { regex: /[✅✔☑]/g, word: 'Passed' },
  { regex: /[❌✖✘❎]/g, word: 'Failed' },
  { regex: /⚠️?/g, word: 'Warning' },
];

// Broad Unicode emoji, media controls & decorative symbol range (preserves all accented Latin/Cyrillic/etc. letters like Č, Ö, é, ü)
const INLINE_EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{23E9}-\u{23FA}\u{25AA}-\u{25FE}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0E}\u{FE0F}\u{200D}⋮]+/gu;

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => (INLINE_HTML_ENTITIES[name] !== undefined ? INLINE_HTML_ENTITIES[name] : m));
}

/**
 * Humanizes camelCase, PascalCase, and snake_case identifiers into natural words.
 */
export function humanizeIdentifier(token) {
  if (!token || typeof token !== 'string') return token;
  // Don't split all-caps short acronyms like API, URL, JSON, WebGPU
  if (/^[A-Z0-9]{2,6}$/.test(token)) return token;
  let res = token;
  // snake_case / SCREAMING_SNAKE -> spaces
  if (/_/.test(res)) {
    res = res.replace(/^_+|_+$/g, '').replace(/_+/g, ' ');
  }
  // camelCase / PascalCase boundaries (preserving consecutive acronym letters like HTTPServer -> HTTP Server)
  res = res.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  res = res.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return res.replace(/\s+/g, ' ').trim();
}

/**
 * Formats a file path according to the user's `filePaths` preference.
 */
function inlineFormatFilePath(rawPath, mode, forSpeech) {
  if (mode === 'skip') return '';
  if (mode === 'literal') return rawPath;

  // Strip line-number anchors like #L10-L20 or :42:10
  const cleaned = rawPath.replace(/^file:\/\/\/?/i, '').replace(/#L\d+(?:-L\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  const parts = cleaned.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) return rawPath;

  const filename = parts[parts.length - 1];

  if (mode === 'filename') {
    return forSpeech ? inlineSpeakFilename(filename) : filename;
  }

  // 'natural' mode: speak directory + filename smoothly
  const tail = parts.slice(-3);
  if (!forSpeech) return tail.join('/');
  const spokenParts = tail.map((p, idx) => (idx === tail.length - 1 ? inlineSpeakFilename(p) : p.replace(/[-_]+/g, ' ')));
  return spokenParts.join(' ');
}

function inlineSpeakFilename(filename) {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < filename.length - 1) {
    const base = filename.slice(0, dotIdx).replace(/[-_]+/g, ' ');
    const ext = filename.slice(dotIdx + 1).toLowerCase();
    const spokenExt = INLINE_DOT_EXT_SPOKEN[ext] || `dot ${ext}`;
    return `${base} ${spokenExt}`;
  }
  return filename.replace(/[-_]+/g, ' ');
}

/**
 * Detects whether a token looks like a file path (Windows or POSIX) rather than a word/word pair.
 */
function inlineLooksLikeFilePath(token) {
  if (!token || token.length < 4) return false;
  // Windows drive path C:\foo\bar
  if (/^[a-zA-Z]:\\[^\s]+/.test(token)) return true;
  // Home, relative, or root POSIX path ~/.gemini/..., ./foo/bar, ../foo, /usr/local/bin
  if (/^(?:~\/|\.\.?\/|\/)[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\/?$/.test(token)) return true;
  // Multi-segment path with a known file extension or 2+ slashes (e.g. sidecars/voice-panel/app.js)
  if (/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){1,}\.[a-zA-Z0-9]{1,6}(?:#L\d+(?:-L\d+)?)?(?::\d+(?::\d+)?)?$/.test(token)) {
    return true;
  }
  if (/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){2,}\/?$/.test(token)) {
    return true;
  }
  return false;
}

/**
 * Formats a bare URL according to user `urls` preference.
 */
function inlineFormatUrl(match, mode, stats) {
  const punctMatch = match.match(/[.,!?:;]+$/);
  const punct = punctMatch ? punctMatch[0] : '';
  const cleanUrl = match.slice(0, match.length - punct.length);

  if (mode === 'keep') return match;
  if (stats) stats.urlsFiltered = (stats.urlsFiltered || 0) + 1;

  if (mode === 'skip') return punct;

  // 'domain' (Default)
  if (/^file:\/\//i.test(cleanUrl)) {
    const fname = inlineFormatFilePath(cleanUrl, 'filename', false);
    return `${fname}${punct}`;
  }
  if (/^sidecar:\/\//i.test(cleanUrl)) {
    return `sidecar panel${punct}`;
  }
  try {
    const parsed = new URL(cleanUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    return `a link to ${host}${punct}`;
  } catch {
    return `a web link${punct}`;
  }
}

/**
 * Formats an inline code span (`...`) for displayText and spokenText.
 */
function inlineFormatCodeSpan(rawInner, options, stats) {
  const inner = rawInner.trim();
  if (!inner) return { display: '', spoken: '' };

  // Display keeps clean readable text (without backticks)
  let display = inner;
  let spoken = inner;

  // 1. Pure symbol or Markdown syntax literal (e.g. `-`, `;`, `===`, `---`, `#`, `- [x]`)
  if (INLINE_SYMBOL_LITERAL_NAMES[inner]) {
    spoken = options.symbols === 'literal' ? inner : INLINE_SYMBOL_LITERAL_NAMES[inner];
    return { display, spoken };
  }

  // Repeated punctuation sequence like `######` or `----`
  if (/^([#=\-*~_`|])\1{2,}$/.test(inner)) {
    const ch = inner[0];
    const baseName = INLINE_SYMBOL_LITERAL_NAMES[ch] || 'symbols';
    spoken = options.symbols === 'literal' ? inner : `repeated ${baseName}`;
    return { display, spoken };
  }

  // GitHub alert tag literal like `[!WARNING]` or `> [!NOTE]`
  const alertLit = inner.match(/^>?\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);
  if (alertLit) {
    spoken = `${alertLit[1].toLowerCase()} alert`;
    return { display, spoken };
  }

  // 2. Standalone dot-extension like `.md`, `.json`, `.ts`
  const extOnly = inner.match(/^\.([a-zA-Z0-9]{1,5})$/);
  if (extOnly && INLINE_DOT_EXT_SPOKEN[extOnly[1].toLowerCase()]) {
    spoken =
      options.symbols === 'literal'
        ? inner
        : INLINE_DOT_EXT_SPOKEN[extOnly[1].toLowerCase()];
    return { display, spoken };
  }

  // 3. URL inside backticks
  if (/^(?:https?|file|sidecar):\/\/\S+$/i.test(inner)) {
    const formatted = inlineFormatUrl(inner, options.urls, stats);
    return { display: options.urls === 'keep' ? inner : formatted, spoken: formatted };
  }

  // 4. File path inside backticks
  if (inlineLooksLikeFilePath(inner)) {
    const dispPath = inlineFormatFilePath(inner, options.filePaths === 'skip' ? 'filename' : options.filePaths, false);
    const spkPath = inlineFormatFilePath(inner, options.filePaths, true);
    return { display: dispPath, spoken: spkPath };
  }

  // 5. UUID or long opaque hex hash inside backticks
  if (options.stripHashesAndIds && inlineIsOpaqueHash(inner)) {
    return { display: '', spoken: '' };
  }

  // 5b. Markdown link example inside backticks like `[Voice TTS](sidecar://...)`
  const mdLinkLit = inner.match(/^\[([^\]]+)\]\((?:https?|file|sidecar):\/\/[^)]+\)$/i);
  if (mdLinkLit) {
    spoken = mdLinkLit[1].trim();
    return { display: mdLinkLit[1].trim(), spoken };
  }

  // 5c. Markdown bullet/emphasis example inside backticks like `- **Topic:** details`
  if (options.symbols === 'natural' && /^(?:[-*+]\s+)?\*\*[^*]+\*\*/.test(inner)) {
    spoken = inner.replace(/^[-*+]\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
    return { display, spoken };
  }

  // 6. Code identifier humanization (snake_case / camelCase)
  if (options.humanizeIdentifiers && /^[a-zA-Z_$][a-zA-Z0-9_$-]*$/.test(inner)) {
    spoken = humanizeIdentifier(inner);
  } else if (options.symbols === 'natural') {
    // Even if humanizeIdentifiers is off, make spoken operators inside inline code smooth
    spoken = inlineNormalizeSymbolsForSpeech(spoken, options);
  }

  return { display, spoken };
}

function inlineIsOpaqueHash(token) {
  // UUID v4 etc.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return true;
  // Long hex / SHA (16+ hex chars)
  if (/^[0-9a-f]{16,}$/i.test(token)) return true;
  // JWT or very long base64 token
  if (/^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(token)) return true;
  return false;
}

/**
 * Checks whether the contents inside parentheses (...) are overwhelmingly raw syntax/punctuation
 * (e.g., `(#–######, Setext ===/---)`, `(;)`, `(=== / ---)`).
 */
function inlineIsHeavySyntaxParenthetical(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return true;
  // Single or double bare punctuation like `(;)`, `(,)`, `(|)`, `(->)`
  if (/^[^\p{L}\p{N}\s]{1,4}$/u.test(trimmed)) return true;
  // Contains repeated markdown syntax runs like `###`, `===`, `---`, `~~~`, `***`, ```` ``` ````
  if (/(?:###+|===+|---+|~~~+|\*\*\*+|```+)/.test(trimmed)) return true;
  // High non-letter symbol density (> 45% of non-space chars are symbols and length <= 40)
  const nonSpace = trimmed.replace(/\s+/g, '');
  const letters = (nonSpace.match(/[\p{L}\p{N}]/gu) || []).length;
  const symbolRatio = nonSpace.length > 0 ? (nonSpace.length - letters) / nonSpace.length : 0;
  if (nonSpace.length >= 3 && nonSpace.length <= 45 && symbolRatio >= 0.48) return true;
  return false;
}

/**
 * Normalizes symbols, ranges, operators, arrows, units, and slashes for smooth speech.
 */
export function inlineNormalizeSymbolsForSpeech(text, options = {}) {
  if (!text) return '';
  let s = text;

  // Always normalize typography for Kokoro/SAPI stability
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/\u00A0/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '');

  if (options.symbols === 'literal') {
    return s;
  }

  // Minimal mode: only fix typography, arrows, &, and repeated raw symbol runs
  if (options.symbols === 'minimal') {
    s = s.replace(/\s*&\s*/g, ' and ');
    s = s.replace(/\s*(?:→|⇒|->|=>|➜|⟶)\s*/g, ' to ');
    s = s.replace(/(?<!\w)[#=\-~*_]{3,}(?!\w)/g, ' ');
    return s;
  }

  // === Natural Speech Symbol Normalization ===

  // 1. Simplify heavy raw-syntax parentheticals like `(#–######, Setext ===/---)` or redundant `(;)`
  s = s.replace(/\(([^()]{1,60})\)/g, (full, inner) => {
    const trimmed = inner.trim();
    // Bare single punctuation symbol inside parens like `Semicolon (;)` -> drop silently if preceded by a word, else speak cleanly
    if (/^[^\p{L}\p{N}\s]{1,3}$/u.test(trimmed)) {
      return '';
    }
    // Check for multi-layout list like `(; / Č / Ö)` — keep letters/items cleanly separated instead of dropping!
    if (/^[^()]+(?:\/[^()]+)+$/.test(trimmed) && /[\p{L}]/u.test(trimmed) && !/(?:###|===|---|~~~)/.test(trimmed)) {
      const items = trimmed
        .split(/\s*\/\s*/)
        .map((part) => {
          const p = part.trim();
          if (INLINE_SYMBOL_LITERAL_NAMES[p]) return INLINE_SYMBOL_LITERAL_NAMES[p];
          return p;
        })
        .filter(Boolean);
      if (items.length > 0) {
        const joined = items.length === 2 ? `${items[0]} or ${items[1]}` : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
        return `(${joined})`;
      }
    }
    // Heavy syntax illustrations like `(#–######, Setext ===/---)` or `(- [x] / - [ ])`
    if (inlineIsHeavySyntaxParenthetical(trimmed)) {
      return '';
    }
    return full;
  });

  // 2. Strip leftover repeated Markdown syntax runs outside parentheses (e.g. `===`, `---`, `######`, `~~~`)
  s = s.replace(/(?:^|\s)[#=~*_]{3,}(?=\s|$|[.,!?;:])/g, ' ');
  s = s.replace(/---+|\u2014{2,}/g, ' ');

  // 3. Keyboard shortcuts: Ctrl+C, Cmd+Shift+P, Alt+F4
  s = s.replace(
    /\b(Ctrl|Cmd|Alt|Opt|Shift|Win|Meta)(?:\s*\+\s*([A-Za-z0-9]+|Shift|Alt|Ctrl|Cmd|Opt|Enter|Tab|Space|Esc|Del|Backspace|Up|Down|Left|Right|F\d{1,2}))+/gi,
    (match) => {
      return match
        .split(/\s*\+\s*/)
        .map((part) => INLINE_KEY_NAMES[part.toLowerCase()] || part)
        .join(' plus ');
    }
  );

  // 4. Special programming names before `+` / `#` rules
  s = s.replace(/\bC\+\+/g, 'C plus plus');
  s = s.replace(/\bC#/g, 'C sharp');
  s = s.replace(/\bF#/g, 'F sharp');
  s = s.replace(/\bN\/A\b/gi, 'not applicable');
  s = s.replace(/\bw\/o\b/gi, 'without');
  s = s.replace(/\bw\//gi, 'with ');
  s = s.replace(/\band\/or\b/gi, 'and or');
  s = s.replace(/\bi\.e\./gi, 'that is');
  s = s.replace(/\be\.g\./gi, 'for example');

  // 5. En-dash & numeric/letter ranges: `a–z` -> `a to z`, `1–3` -> `1 to 3`, `1–2s` -> `1 to 2s`, `hash–repeated hash` -> `hash to repeated hash`
  // Note: preserves compound words like `Sub-drills` and `Kokoro-82M`
  s = s.replace(/\b([a-zA-Z])\s*[–—]\s*([a-zA-Z])\b/g, '$1 to $2');
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*[–—]\s*(\d+(?:\.\d+)?)(?=[a-zA-Z%°\s.,!?;:)]|$)/g, '$1 to $2');
  s = s.replace(/\b([a-zA-Z]{2,})–([a-zA-Z]{2,})\b/g, '$1 to $2');
  // Spaced em-dash / en-dash or middle dot `•` used as separator -> comma pause
  s = s.replace(/\s+[—–•·]\s+/g, ', ');
  // Tight em-dash between words (`finish—or`) -> comma pause
  s = s.replace(/([\p{L}\p{N}])—([\p{L}\p{N}])/gu, '$1, $2');

  // 6. Arrows (Unicode and ASCII — excludes media ▶ button which is handled as icon)
  s = s.replace(/\s*(?:⇒)\s*/g, ' implies ');
  s = s.replace(/\s*(?:↔|<->|<=>)\s*/g, ' and ');
  s = s.replace(/\s*(?:→|->|=>|➜|⟶)\s*/g, ' to ');
  s = s.replace(/\s*(?:←|<-)\s*/g, ' from ');

  // 7. Comparisons & math symbols
  s = s.replace(/\s*(?:>=|≥)\s*/g, ' greater than or equal to ');
  s = s.replace(/\s*(?:<=|≤)\s*/g, ' less than or equal to ');
  s = s.replace(/\s*(?:!==|!=|≠)\s*/g, ' not equal to ');
  s = s.replace(/\s*(?:===|==)\s*/g, ' equals ');
  s = s.replace(/\s*≈\s*/g, ' approximately ');
  s = s.replace(/(?<=^|[\s(])~(\d)/g, 'about $1');
  s = s.replace(/\s*±\s*/g, ' plus or minus ');
  // Dimensions like `1920×1080` or `6×4` -> `1920 by 1080`
  s = s.replace(/\b(\d+)\s*[×x]\s*(\d+)\b/g, '$1 by $2');
  s = s.replace(/\s*×\s*/g, ' times ');
  s = s.replace(/\s*÷\s*/g, ' divided by ');
  s = s.replace(/∞/g, ' infinity ');
  s = s.replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius');
  s = s.replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit');
  s = s.replace(/(\d)\s*°/g, '$1 degrees');
  s = s.replace(/(\d+(?:\.\d+)?)%/g, '$1 percent');

  // 8. Spaced `+` and `&`
  s = s.replace(/\s+\+\s+/g, ' plus ');
  s = s.replace(/\s*&\s*/g, ' and ');

  // 9. Dot-prefixed standalone file extensions like `Structured .md files` -> `Structured dot M D files`
  s = s.replace(/(^|\s)\.([a-zA-Z0-9]{1,5})(?=\s|$|[.,!?;:)])/g, (m, lead, ext) => {
    const spoken = INLINE_DOT_EXT_SPOKEN[ext.toLowerCase()];
    return spoken ? `${lead}${spoken}` : m;
  });

  // 10. Version prefixes `v2.0.0` or `v2.1` -> `version 2.0.0`
  s = s.replace(/\bv(\d+\.\d+(?:\.\d+)?)\b/g, 'version $1');

  // 11. Common tech units attached to numbers: `150ms`, `80MB`, `10 min`, `60fps`
  s = s.replace(
    /\b(\d+(?:\.\d+)?)\s*(ms|ns|us|µs|μs|kib|mib|gib|kb|mb|gb|tb|pb|kbps|mbps|gbps|bps|fps|khz|mhz|ghz|hz|px|km|cm|mm|kg|mg|ml|mph|kph|wpm)\b/gi,
    (m, num, unit) => {
      const spokenUnit = INLINE_UNIT_NAMES[unit.toLowerCase()];
      if (!spokenUnit) return m;
      // Singularize when value is exactly 1
      if (num === '1' && spokenUnit.endsWith('s') && !spokenUnit.endsWith('ps')) {
        return `${num} ${spokenUnit.slice(0, -1)}`;
      }
      return `${num} ${spokenUnit}`;
    }
  );
  // Short time units like `1–3 min` -> `1 to 3 minutes`, `~1–2s` -> `about 1 to 2 seconds`, `2.5s` -> `2.5 seconds`
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*(min|mins|sec|secs|hr|hrs)\b/gi, (m, num, unit) => {
    const spokenUnit = INLINE_UNIT_NAMES[unit.toLowerCase()];
    if (!spokenUnit) return m;
    if (num === '1' && spokenUnit.endsWith('s')) return `${num} ${spokenUnit.slice(0, -1)}`;
    return `${num} ${spokenUnit}`;
  });
  s = s.replace(/\b(\d+(?:\.\d+)?)s\b/g, (m, num) => `${num} ${num === '1' ? 'second' : 'seconds'}`);
  // `1.5x` speed multiplier -> `1.5 times` (keeps `0x1F` hex untouched)
  s = s.replace(/\b(\d+(?:\.\d+)?)x\b/g, '$1 times');

  // 12. Context-aware slash `/` handling (preserve dates `11/25/2026` and simple fractions `1/2`, `3/4`)
  // Spaced slash between terms (`WebGPU / WASM`, `Play / Pause`)
  s = s.replace(/([\p{L}\p{N}])\s+\/\s+([\p{L}\p{N}])/gu, '$1 or $2');
  // Tight slash between words (`formatting/symbols`, `empty/N/A/—`, `read/write`)
  s = s.replace(/\b([\p{L}]{2,})\/([\p{L}]{2,})(?:\/([\p{L}—–-]{1,}))?/gu, (m, a, b, c) => {
    if (c) {
      const cleanC = /^[—–-]+$/.test(c) ? 'dash' : c;
      return `${a}, ${b}, or ${cleanC}`;
    }
    return `${a} or ${b}`;
  });

  // 13. Bare isolated hyphen surrounded by spaces inside a phrase (`indented - bug` vs clause break)
  s = s.replace(/\s+-\s+/g, ', ');

  // 14. Clean stray empty parens `()` or brackets `[]` left after stripping syntax
  s = s.replace(/\(\s*[,;:.]*\s*\)/g, '');
  s = s.replace(/\[\s*[,;:.]*\s*\]/g, '');

  return s;
}

/**
 * Handles emojis and status icons according to `options.emojis` (`status` | `strip` | `keep`).
 */
function inlineHandleEmojis(text, mode, stats, forSpeech) {
  if (!text || mode === 'keep') return text;

  let out = text;
  if (mode === 'status' && forSpeech) {
    for (const rule of INLINE_STATUS_EMOJIS) {
      out = out.replace(rule.regex, (m, offset, full) => {
        // Avoid duplicating word if it already follows immediately (e.g. `✅ Passed` or `⚠️ Warning`)
        const after = full.slice(offset + m.length).trim().toLowerCase();
        if (after.startsWith(rule.word.toLowerCase()) || after.startsWith('supported') || after.startsWith('done') || after.startsWith('yes')) {
          return '';
        }
        return ` ${rule.word}: `;
      });
    }
  }

  // Strip remaining emojis / pictographs
  const before = out;
  out = out.replace(INLINE_EMOJI_REGEX, ' ');
  if (forSpeech && stats && out !== before) {
    stats.emojisStripped = (stats.emojisStripped || 0) + 1;
  }
  return out;
}

/**
 * Applies custom user pronunciation / replacement rules to spoken text.
 */
function inlineApplyCustomReplacements(text, customRulesText) {
  if (!customRulesText || !text) return text;
  const { replacements } = parseCustomRules(customRulesText);
  if (replacements.length === 0) return text;

  let out = text;
  for (const { from, to } of replacements) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isWord = /^[a-zA-Z0-9_]+$/.test(from);
    const regex = isWord ? new RegExp(`\\b${escaped}\\b`, 'gi') : new RegExp(escaped, 'g');
    out = out.replace(regex, to);
  }
  return out;
}

/**
 * Normalizes a single inline Markdown string into BOTH `displayText` and `spokenText`.
 */
export function normalizeInline(rawText, options = {}, stats = null) {
  if (!rawText || typeof rawText !== 'string') {
    return { displayText: '', spokenText: '' };
  }

  // 0. Strip ANSI escape codes & HTML comments, decode HTML entities
  let base = rawText
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Protect autolinks <https://...> BEFORE stripping HTML tags
  base = base.replace(/<((?:https?|file|sidecar):\/\/[^>]+)>/gi, '$1');
  base = base.replace(/<mailto:([^>]+)>/gi, '$1');

  // Handle <kbd>Ctrl</kbd> tags cleanly and strip other inline HTML tags
  base = base.replace(/<br\s*\/?>/gi, '. ');
  base = base.replace(/<\/?(?:kbd|code|strong|em|b|i|span|mark|u|s|del|ins|sub|sup|a)\b[^>]*>/gi, '');
  base = base.replace(/<[^>]+>/g, '');
  base = decodeHtmlEntities(base);

  // 1. Protect inline code spans `...` with placeholders BEFORE bold/italic so `_underscores_` aren't mangled!
  const codePlaceholders = [];
  base = base.replace(/`([^`\n]+)`/g, (_, inner) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(inlineFormatCodeSpan(inner, options, stats));
    return `\uE000CODE${idx}\uE001`;
  });

  // 2. Protect inline LaTeX math: \(...\) and $...$ (carefully avoiding currency like $50, $1,200, \$100)
  const mathPlaceholders = [];
  // Unescape literal dollar \$100 -> keep as $100
  base = base.replace(/\\\$/g, '\uE002DOLLAR\uE003');
  // \( ... \) inline math
  base = base.replace(/\\\((.+?)\\\)/g, (_, formula) => {
    const idx = mathPlaceholders.length;
    const cleanF = formula.trim();
    const spoken =
      options.math === 'skip'
        ? ''
        : options.math === 'summarize'
          ? 'a formula'
          : options.math === 'literal'
            ? cleanF
            : latexToSpeech(cleanF);
    if (stats) stats.mathConverted = (stats.mathConverted || 0) + 1;
    mathPlaceholders.push({ display: cleanF, spoken });
    return `\uE000MATH${idx}\uE001`;
  });
  // $...$ inline math (never matches $50 or $10 to $20)
  base = base.replace(/(?<!\$)\$(?!\s|\d)([^$\n]+?)(?<!\s)\$(?!\$)/g, (full, formula) => {
    const cleanF = formula.trim();
    // Double check it's not a currency span like "$foo" with spaces around money
    if (/^\d[\d,.]*$/.test(cleanF)) return full;
    const idx = mathPlaceholders.length;
    const spoken =
      options.math === 'skip'
        ? ''
        : options.math === 'summarize'
          ? 'a formula'
          : options.math === 'literal'
            ? cleanF
            : latexToSpeech(cleanF);
    if (stats) stats.mathConverted = (stats.mathConverted || 0) + 1;
    mathPlaceholders.push({ display: cleanF, spoken });
    return `\uE000MATH${idx}\uE001`;
  });
  base = base.replace(/\uE002DOLLAR\uE003/g, '$');

  // 3. Markdown images: ![alt](url)
  base = base.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => {
    const trimmed = alt.trim();
    return trimmed ? `Image: ${trimmed}. ` : '';
  });

  // 4. Markdown links: [label](url) -> label (handles nested parens/file links)
  base = base.replace(/\[([^\]]+)\]\((?:[^()\s]+|\([^()]*\))+\)/g, '$1');

  // 5. Citations & footnotes: [1], [1][2], [1, 2], [^1] (must run BEFORE reference links so `[1][2]` isn't treated as `[label][ref]`)
  if (options.stripCitations) {
    base = base.replace(/(?:\[\^?\d+(?:\s*,\s*\d+)*\])+/g, () => {
      if (stats) stats.citationsStripped = (stats.citationsStripped || 0) + 1;
      return '';
    });
  }

  // 5b. Reference links: [label][ref] -> label (skip pure numeric brackets like `[1][2]`)
  base = base.replace(/\[([^\]]*[a-zA-Z][^\]]*)\]\[[^\]]*\]/g, '$1');

  // 6. Bare URLs: https://..., http://..., file:///..., sidecar://...
  base = base.replace(/(?:https?|file|sidecar):\/\/[^\s)>\]]+/gi, (match) =>
    inlineFormatUrl(match, options.urls, stats)
  );

  // 7. Bold, Italic & Strikethrough (word-boundary safe for underscores so `foo_bar_baz` is NEVER mangled!)
  base = base.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  base = base.replace(/\*\*([^*]+)\*\*/g, '$1');
  base = base.replace(/\*([^*\n]+)\*/g, '$1');
  base = base.replace(/(?<![\p{L}\p{N}])___([^_]+)___(?![\p{L}\p{N}])/gu, '$1');
  base = base.replace(/(?<![\p{L}\p{N}])__([^_]+)__(?![\p{L}\p{N}])/gu, '$1');
  base = base.replace(/(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1');
  base = base.replace(/~~([^~]+)~~/g, '$1');

  // 8. Bare file paths outside backticks (e.g. `C:\Users\...\file.txt`, `~/.gemini/antigravity/brain/`, `sidecars/voice-panel/app.js`)
  const pathPlaceholders = [];
  base = base.replace(
    /(?:[a-zA-Z]:\\[^\s,;:!?()]+|(?:~\/|\.\.?\/|\/)[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\/?|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]{1,6}(?:#L\d+(?:-L\d+)?)?(?::\d+(?::\d+)?)?)/g,
    (match) => {
      const idx = pathPlaceholders.length;
      const disp = inlineFormatFilePath(match, options.filePaths === 'skip' ? 'filename' : options.filePaths, false);
      const spk = inlineFormatFilePath(match, options.filePaths, true);
      pathPlaceholders.push({ display: disp, spoken: spk });
      return `\uE000PATH${idx}\uE001`;
    }
  );

  // 9. Strip UUIDs & long hex hashes in plain text
  if (options.stripHashesAndIds) {
    base = base.replace(/\(\s*[0-9a-f]{7,40}\s*\)/gi, '');
    base = base.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');
    base = base.replace(/\b[0-9a-f]{24,}\b/gi, '');
  }

  // Fork into displayText vs spokenText
  let displayText = base;
  let spokenText = base;

  // Restore placeholders into each track
  displayText = displayText
    .replace(/\uE000CODE(\d+)\uE001/g, (_, i) => codePlaceholders[Number(i)]?.display ?? '')
    .replace(/\uE000MATH(\d+)\uE001/g, (_, i) => mathPlaceholders[Number(i)]?.display ?? '')
    .replace(/\uE000PATH(\d+)\uE001/g, (_, i) => pathPlaceholders[Number(i)]?.display ?? '');

  spokenText = spokenText
    .replace(/\uE000CODE(\d+)\uE001/g, (_, i) => codePlaceholders[Number(i)]?.spoken ?? '')
    .replace(/\uE000MATH(\d+)\uE001/g, (_, i) => mathPlaceholders[Number(i)]?.spoken ?? '')
    .replace(/\uE000PATH(\d+)\uE001/g, (_, i) => pathPlaceholders[Number(i)]?.spoken ?? '');

  // Handle emojis on both tracks (keep readable in display if keep/status, strip/verbalize cleanly for speech)
  displayText = inlineHandleEmojis(displayText, options.emojis === 'strip' ? 'strip' : 'keep', null, false);
  spokenText = inlineHandleEmojis(spokenText, options.emojis, stats, true);

  // Humanize unquoted snake_case / camelCase identifiers in spokenText if enabled
  if (options.humanizeIdentifiers) {
    spokenText = spokenText.replace(/\b([a-z]+_[a-z0-9_]+|[a-z]+[A-Z][a-zA-Z0-9]*)\b/g, (m) =>
      humanizeIdentifier(m)
    );
  }

  // Apply symbol normalization ONLY to spokenText (displayText keeps clean visual symbols!)
  spokenText = inlineNormalizeSymbolsForSpeech(spokenText, options);

  // Apply user custom pronunciation rules to spokenText
  spokenText = inlineApplyCustomReplacements(spokenText, options.customRules);

  // Clean whitespace & punctuation on both tracks WITHOUT gluing `.md` / `.json` to preceding words!
  displayText = inlineCleanupPunctuation(displayText);
  spokenText = inlineCleanupPunctuation(spokenText);

  return { displayText, spokenText };
}

/**
 * Cleans whitespace and double punctuation while preserving `?`, `!`, ellipsis `...`,
 * and dot-prefixed extensions like `Structured .md files`.
 */
export function inlineCleanupPunctuation(str) {
  if (!str) return '';
  let s = str;
  s = s.replace(/[ \t]+/g, ' ');
  // Remove spaces before punctuation, EXCEPT before `.ext` (e.g. `Structured .md`)
  s = s.replace(/\s+([,!?:;])/g, '$1');
  s = s.replace(/\s+\.(?![a-zA-Z0-9])/g, '.');
  // Preserve `?` or `!` when followed by `.` (`What's New?.` -> `What's New?`)
  s = s.replace(/([!?])\.+/g, '$1');
  // Collapse `..` (2 dots) to `.`, keep `...` (3 dots) intact, collapse 4+ dots to `...`
  s = s.replace(/\.{4,}/g, '...');
  s = s.replace(/(?<!\.)\.\.(?!\.)/g, '.');
  // Clean inner spaces right inside parentheses/brackets (`( [Current]` -> `([Current]`)
  s = s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  s = s.replace(/\[\s+/g, '[').replace(/\s+\]/g, ']');
  s = s.replace(/\(\s*[,;:.]*\s*\)/g, '');
  // Fix accidental `, .` or `: .` or `, ,`
  s = s.replace(/([,;:])\s*[.,;:]+/g, '$1');
  s = s.replace(/^[,;:]+\s*/, '');
  return s.replace(/[ \t]+/g, ' ').trim();
}
