/**
 * Client-Side Text and Markdown Sanitizer
 * Mirrors backend sanitizer for local manipulation.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'est',
  'min', 'sec', 'hr', 'no', 'vol', 'dept', 'inc', 'corp', 'co',
  'a.m', 'p.m', 'am', 'pm', 'st', 'ave', 'rd', 'blvd'
]);

export function sanitizeText(text, options = {}) {
  if (!text || typeof text !== 'string') return '';

  const {
    skipCodeBlocks = false,
    stripUrls = true,
    stripTables = true,
  } = options;

  let cleaned = text;

  // 1. Remove XML/HTML comments and clean HTML tags
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '. ');
  cleaned = cleaned.replace(/<\/p>/gi, '. ');
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  // 1b. LaTeX block math $$...$$ and inline math $...$
  cleaned = cleaned.replace(/\$\$([\s\S]*?)\$\$/g, (m, formula) => {
    return ` [formula: ${formula.trim().replace(/[\r\n]+/g, ' ')}]. `;
  });
  cleaned = cleaned.replace(/\$(?!\s|\d)([^$\n]+?)(?<!\s)\$/g, '$1');

  // 2. Fenced code blocks ```lang\ncode\n```
  cleaned = cleaned.replace(/```([a-zA-Z0-9_\-\+]*)\s*([\s\S]*?)```/g, (match, lang, code) => {
    if (skipCodeBlocks) return '';
    const languageName = lang ? formatLanguageName(lang) : 'code';
    const lines = code.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return '';
    if (lines.length <= 2 && code.length < 80) {
      return ` Here is the ${languageName}: ${code.trim().replace(/[\r\n]+/g, ' ')}. `;
    }
    return ` [Code block omitted: ${languageName} with ${lines.length} lines]. `;
  });

  // 3. Inline code blocks `code`
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 4. Markdown tables
  if (stripTables) {
    cleaned = cleaned.replace(/^\|[^\r\n]+\|(\r?\n\|[^\r\n]+\|)+/gm, ' [Table omitted]. ');
    cleaned = cleaned.replace(/^\s*\|.*?\|\s*$/gm, '');
  }

  // 5. Markdown images: ![alt](url)
  cleaned = cleaned.replace(/!\[(.*?)\]\([^)]+\)/g, (match, alt) => {
    return alt ? `Image: ${alt}. ` : '';
  });

  // 6. Markdown links: [label](url) -> label
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 7. Bare URLs
  if (stripUrls) {
    cleaned = cleaned.replace(/https?:\/\/[^\s)]+/g, (match) => {
      const punctMatch = match.match(/[.,!?:;]+$/);
      const punct = punctMatch ? punctMatch[0] : '';
      const cleanUrl = match.slice(0, match.length - punct.length);
      try {
        const parsed = new URL(cleanUrl);
        const host = parsed.hostname.replace(/^www\./, '');
        return `a link to ${host}${punct}`;
      } catch {
        return `a web link${punct}`;
      }
    });
  }

  // 8. Markdown headers
  cleaned = cleaned.replace(/^#{1,6}\s+(.+)$/gm, '$1. ');

  // 9. Markdown blockquotes
  cleaned = cleaned.replace(/^>\s*(.+)$/gm, '$1 ');

  // 10. Horizontal rules
  cleaned = cleaned.replace(/^[\*\-_]{3,}\s*$/gm, '');

  // 11. Markdown list markers
  cleaned = cleaned.replace(/^[\*\-]\s+/gm, '');
  cleaned = cleaned.replace(/^\d+\.\s+/gm, '');

  // 12. Bold & Italic markers
  cleaned = cleaned.replace(/(\*{1,3}|_{1,3})([^\*_]+)\1/g, '$2');

  // 13. Strikethrough
  cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');

  // 14. Collapse excessive punctuation & whitespace
  cleaned = cleaned.replace(/\[\s*\]/g, '');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.replace(/(\r?\n){2,}/g, '. ');
  cleaned = cleaned.replace(/\r?\n/g, ' ');

  // 15. Fix double punctuation
  cleaned = cleaned.replace(/\.+/g, '.');
  cleaned = cleaned.replace(/\s+([.,!?:;])/g, '$1');
  cleaned = cleaned.replace(/([.,!?:;]){2,}/g, '$1');

  return cleaned.trim();
}

export function chunkSentences(text, maxChunkLength = 140) {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  const rawChunks = [];
  const boundaryRegex = /([.!?]+)(?:\s+|$)/g;
  let lastIndex = 0;
  let currentBuffer = '';
  let match;

  while ((match = boundaryRegex.exec(trimmed)) !== null) {
    const matchEnd = match.index + match[0].length;
    const segment = trimmed.slice(lastIndex, matchEnd);
    lastIndex = matchEnd;

    currentBuffer = currentBuffer ? `${currentBuffer}${segment}` : segment;

    // Check the word immediately before the punctuation
    const textBeforePunct = trimmed.slice(0, match.index);
    const words = textBeforePunct.trim().split(/\s+/);
    const lastWord = words[words.length - 1]?.toLowerCase().replace(/^[("']+|[)"',;:]+$/g, '') || '';
    const cleanLastWord = lastWord.replace(/[.!?]+$/, '');

    // If the word before punctuation is an abbreviation, do not split
    if (cleanLastWord && (ABBREVIATIONS.has(cleanLastWord) || ABBREVIATIONS.has(lastWord))) {
      continue;
    }

    // Also avoid splitting single-letter initials (e.g. "J. K. Rowling")
    if (/^[a-z]$/i.test(cleanLastWord)) {
      continue;
    }

    rawChunks.push(currentBuffer.trim());
    currentBuffer = '';
  }

  // Any trailing text after the last punctuation
  if (lastIndex < trimmed.length) {
    const remainder = trimmed.slice(lastIndex).trim();
    if (remainder) {
      if (currentBuffer) {
        currentBuffer = `${currentBuffer} ${remainder}`;
      } else {
        currentBuffer = remainder;
      }
    }
  }

  if (currentBuffer.trim()) {
    rawChunks.push(currentBuffer.trim());
  }

  // Refine chunks that exceed maxChunkLength by splitting on commas, semicolons, or dashes
  const refinedChunks = [];
  for (const chunk of rawChunks) {
    if (chunk.length <= maxChunkLength) {
      refinedChunks.push(chunk);
    } else {
      const subChunks = splitLongChunk(chunk, maxChunkLength);
      refinedChunks.push(...subChunks);
    }
  }

  return refinedChunks.filter((c) => c && c.trim().length > 0);
}

function splitLongChunk(longChunk, maxLength) {
  const parts = [];
  const clauses = longChunk.split(/([,;:\u2014\-]\s+)/);
  let current = '';

  for (let i = 0; i < clauses.length; i++) {
    const part = clauses[i];
    if ((current + part).length > maxLength && current.length > 0) {
      parts.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  // If any part is still longer than maxLength, split by spaces
  const finalParts = [];
  for (const part of parts) {
    if (part.length <= maxLength) {
      finalParts.push(part);
    } else {
      const words = part.split(/\s+/);
      let wordBuf = '';
      for (const w of words) {
        if ((wordBuf + ' ' + w).trim().length > maxLength && wordBuf.length > 0) {
          finalParts.push(wordBuf.trim());
          wordBuf = w;
        } else {
          wordBuf = wordBuf ? `${wordBuf} ${w}` : w;
        }
      }
      if (wordBuf.trim()) finalParts.push(wordBuf.trim());
    }
  }

  return finalParts.length > 0 ? finalParts : [longChunk];
}

const LANGUAGE_NAMES = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  py: 'Python',
  python: 'Python',
  sh: 'shell script',
  shell: 'shell script',
  bash: 'Bash',
  zsh: 'Z shell',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  jsonl: 'JSON Lines',
  cpp: 'C plus plus',
  'c++': 'C plus plus',
  c: 'C code',
  cs: 'C sharp',
  'c#': 'C sharp',
  csharp: 'C sharp',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go code',
  golang: 'Go code',
  rb: 'Ruby',
  ruby: 'Ruby',
  php: 'PHP',
  sql: 'SQL query',
  yaml: 'YAML config',
  yml: 'YAML config',
  xml: 'XML',
  md: 'Markdown',
  markdown: 'Markdown',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  dockerfile: 'Dockerfile',
  docker: 'Docker',
};

function formatLanguageName(lang) {
  if (!lang) return 'code';
  const key = lang.trim().toLowerCase();
  return LANGUAGE_NAMES[key] || `${lang} code`;
}
