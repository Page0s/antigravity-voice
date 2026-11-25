/**
 * Context-Aware Sentence & Clause Chunker (v2)
 * Solves:
 *   - Never splits inside balanced parentheses (...) or quotes "..."
 *   - Never splits on abbreviations (Dr., Mr., e.g., i.e., vs., etc.),
 *     decimals (3.14), version numbers (v2.0.0), or dotted tech names (Node.js, app.js)
 *   - Balanced clause splitting with strict orphan guard (never cuts a lone trailing word like "engine.")
 *   - Enforces Kokoro-82M safe chunk ceiling (~260 chars)
 */

const CHUNKER_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'rev', 'gen', 'col', 'lt', 'sgt',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'est', 'fig', 'eq', 'ref', 'ch', 'sec', 'art',
  'min', 'hr', 'no', 'vol', 'dept', 'inc', 'corp', 'co', 'ltd', 'llc',
  'a.m', 'p.m', 'am', 'pm', 'ave', 'rd', 'blvd', 'ln', 'ct', 'pl',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'u.s', 'u.k', 'u.n', 'e.u', 'a.i', 'm.l',
]);

const CHUNKER_DOTTED_TECH_EXT = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'rs', 'go', 'md', 'mdx',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'html', 'css', 'scss', 'sql', 'sh',
  'ps1', 'xml', 'svg', 'png', 'jpg', 'wav', 'mp3', 'pdf', 'txt', 'csv', 'env', 'exe',
  'com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'gov', 'edu',
]);

const CHUNKER_MIN_ORPHAN_CHARS = 28;
const CHUNKER_MIN_ORPHAN_WORDS = 4;

/**
 * Counts words in a string.
 */
function chunkerWordCount(str) {
  const t = String(str || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Splits a string into sentences while respecting:
 * - balanced parentheses & quotes (no splits inside `(...)`)
 * - abbreviations & initials (`Dr.`, `J. K.`, `e.g.`)
 * - decimal numbers, IPs, semver, and tech extensions (`3.14`, `Node.js`, `v2.0.0`, `example.com`)
 */
export function splitIntoSentencesSafe(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inDoubleQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Only consider sentence-ending punctuation outside parens/brackets
    if (parenDepth > 0 || bracketDepth > 0) continue;

    if (ch === '.' || ch === '!' || ch === '?') {
      // Consume consecutive terminal marks (`...`, `?!`, `!!`)
      let endPunct = i;
      while (endPunct + 1 < trimmed.length && /[.!?]/.test(trimmed[endPunct + 1])) {
        endPunct++;
      }
      // Consume optional closing quote or paren immediately following punctuation (`."` or `.)`)
      let endSeg = endPunct;
      while (endSeg + 1 < trimmed.length && /["'”’)\]]/.test(trimmed[endSeg + 1])) {
        if (trimmed[endSeg + 1] === '"') inDoubleQuote = !inDoubleQuote;
        endSeg++;
      }

      const nextChar = trimmed[endSeg + 1];
      const isEnd = endSeg + 1 >= trimmed.length;
      const followedBySpace = nextChar && /\s/.test(nextChar);

      // If punctuation is NOT followed by whitespace or end-of-string (e.g. `3.14`, `Node.js`, `example.com`), skip!
      if (!isEnd && !followedBySpace) {
        i = endPunct;
        continue;
      }

      // Skip ellipsis mid-sentence when next word starts lowercase (`Wait... maybe`)
      if (trimmed.slice(i, endPunct + 1) === '...' && !isEnd) {
        const afterEllipsis = trimmed.slice(endSeg + 1).trimStart();
        if (afterEllipsis && /^[a-z]/.test(afterEllipsis)) {
          i = endSeg;
          continue;
        }
      }

      // For a single period `.`, check abbreviations, initials, and tech names
      if (ch === '.' && endPunct === i) {
        const before = trimmed.slice(start, i);
        const tokenMatch = before.match(/([^\s]+)$/);
        const rawToken = tokenMatch ? tokenMatch[1] : '';
        const cleanToken = rawToken.toLowerCase().replace(/^[("'“‘]+|[)"'”’,;:]+$/g, '');

        // Abbreviation check (e.g. `Dr.`, `Mr.`, `e.g.`, `a.m.`)
        if (cleanToken && CHUNKER_ABBREVIATIONS.has(cleanToken)) {
          i = endSeg;
          continue;
        }

        // Single-letter initial (e.g. `J. K. Rowling`)
        if (/^[a-z]$/i.test(cleanToken)) {
          i = endSeg;
          continue;
        }

        // Dotted abbreviation like `e.g.` or `U.S.` where last segment is single letter
        if (/^(?:[a-z]\.)+[a-z]$/i.test(cleanToken)) {
          i = endSeg;
          continue;
        }

        // Standalone dot-extension before space (`Structured .md files`)
        if (rawToken === '' || /\s$/.test(before)) {
          i = endSeg;
          continue;
        }

        // Tech filename or domain at end of token (`app.js`, `example.com`) followed by lowercase continuation
        const dotIdx = cleanToken.lastIndexOf('.');
        if (dotIdx > 0) {
          const ext = cleanToken.slice(dotIdx + 1);
          const afterWord = trimmed.slice(endSeg + 1).trimStart();
          if (CHUNKER_DOTTED_TECH_EXT.has(ext) && afterWord && /^[a-z]/.test(afterWord)) {
            i = endSeg;
            continue;
          }
        }
      }

      const candidate = trimmed.slice(start, endSeg + 1).trim();
      if (candidate) sentences.push(candidate);

      // Advance past whitespace
      let nextStart = endSeg + 1;
      while (nextStart < trimmed.length && /\s/.test(trimmed[nextStart])) nextStart++;
      start = nextStart;
      i = nextStart - 1;
    }
  }

  if (start < trimmed.length) {
    const tail = trimmed.slice(start).trim();
    if (tail) sentences.push(tail);
  }

  return sentences;
}

/**
 * Finds the best balanced split index inside a long sentence so neither half is an orphan.
 * Prefers top-level (depth 0) clause punctuation (`, `, `; `, `: `, ` — `) near the midpoint,
 * then top-level coordinating conjunctions (` and `, ` or `, ` but `, ` while `, ` because `, ` which `, ` that `),
 * and finally balanced word boundaries — NEVER splitting inside `(...)` or leaving < 4 words / < 28 chars.
 */
function chunkerFindBalancedSplit(text, maxLength) {
  const len = text.length;
  const minSideChars = Math.min(CHUNKER_MIN_ORPHAN_CHARS, Math.floor(len * 0.25));
  const idealMid = Math.min(maxLength, Math.floor(len / 2));

  // Track parenthesis/quote nesting depth at every character
  const depthAt = new Int16Array(len);
  let pDepth = 0;
  let bDepth = 0;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch === '(') pDepth++;
    else if (ch === ')' && pDepth > 0) pDepth--;
    else if (ch === '[') bDepth++;
    else if (ch === ']' && bDepth > 0) bDepth--;
    depthAt[i] = pDepth + bDepth;
  }

  const scoreCandidate = (splitPos, priorityBoost) => {
    const left = text.slice(0, splitPos).trim();
    const right = text.slice(splitPos).trim();
    if (!left || !right) return -Infinity;
    if (left.length < minSideChars || right.length < minSideChars) return -Infinity;
    if (chunkerWordCount(left) < CHUNKER_MIN_ORPHAN_WORDS || chunkerWordCount(right) < CHUNKER_MIN_ORPHAN_WORDS) {
      return -Infinity;
    }
    // Prefer candidates where left <= maxLength and closest to balanced midpoint
    const overPenalty = left.length > maxLength ? (left.length - maxLength) * 4 : 0;
    const balancePenalty = Math.abs(splitPos - idealMid);
    return priorityBoost - balancePenalty - overPenalty;
  };

  let bestPos = -1;
  let bestScore = -Infinity;

  // Tier 1: Top-level clause punctuation `, `, `; `, `: `, ` — ` (keep delimiter on the LEFT chunk!)
  for (let i = 1; i < len - 1; i++) {
    if (depthAt[i] !== 0) continue;
    const ch = text[i];
    if ((ch === ',' || ch === ';' || ch === ':' || ch === '—') && /\s/.test(text[i + 1])) {
      const splitPos = i + 1;
      const boost = ch === ';' || ch === ':' || ch === '—' ? 500 : 420;
      const sc = scoreCandidate(splitPos, boost);
      if (sc > bestScore) {
        bestScore = sc;
        bestPos = splitPos;
      }
    }
  }

  // Tier 2: Top-level conjunctions / relative clauses (` and `, ` or `, ` but `, ` while `, ` because `, ` which `, ` that `, ` so `)
  if (bestPos === -1) {
    const conjRegex = /\s+(and|or|but|while|because|which|whether|where|when|so)\s+/gi;
    let m;
    while ((m = conjRegex.exec(text)) !== null) {
      const idx = m.index;
      if (depthAt[idx] !== 0) continue;
      const sc = scoreCandidate(idx, 260);
      if (sc > bestScore) {
        bestScore = sc;
        bestPos = idx;
      }
    }
  }

  // Tier 3: Top-level space near balanced midpoint
  if (bestPos === -1) {
    for (let i = 1; i < len - 1; i++) {
      if (depthAt[i] !== 0) continue;
      if (/\s/.test(text[i])) {
        const sc = scoreCandidate(i, 100);
        if (sc > bestScore) {
          bestScore = sc;
          bestPos = i;
        }
      }
    }
  }

  // Tier 4: Any space (only if the entire string is wrapped in giant parens)
  if (bestPos === -1) {
    for (let i = 1; i < len - 1; i++) {
      if (/\s/.test(text[i])) {
        const sc = scoreCandidate(i, 10);
        if (sc > bestScore) {
          bestScore = sc;
          bestPos = i;
        }
      }
    }
  }

  return bestPos;
}

/**
 * Recursively splits an overly long single sentence into balanced, orphan-free sub-chunks.
 * Soft tolerance: allows sentences slightly above `maxLength` (up to `softMax`) to stay intact
 * rather than cutting off 1–3 trailing words!
 */
export function splitLongSentenceBalanced(sentence, maxLength = 195) {
  const trimmed = String(sentence || '').trim();
  if (!trimmed) return [];

  // Allow generous soft headroom so natural 145–235 char sentences stay whole and never cut a lone word
  const softCeiling = Math.min(265, Math.max(maxLength + 45, Math.round(maxLength * 1.25)));
  if (trimmed.length <= softCeiling) {
    return [trimmed];
  }

  const splitPos = chunkerFindBalancedSplit(trimmed, maxLength);
  if (splitPos === -1) {
    // Hard word-wrap fallback only for giant unpunctuated strings > 265 chars
    if (trimmed.length <= 275) return [trimmed];
    const words = trimmed.split(/\s+/);
    const mid = Math.ceil(words.length / 2);
    const left = words.slice(0, mid).join(' ');
    const right = words.slice(mid).join(' ');
    if (!left || !right) return [trimmed];
    return [...splitLongSentenceBalanced(left, maxLength), ...splitLongSentenceBalanced(right, maxLength)];
  }

  const left = trimmed.slice(0, splitPos).trim();
  const right = trimmed.slice(splitPos).trim();
  return [...splitLongSentenceBalanced(left, maxLength), ...splitLongSentenceBalanced(right, maxLength)];
}

/**
 * Merges tiny orphan fragments (e.g. a lone trailing word or < 24 chars) back into their neighbor
 * as long as the merged chunk stays within Kokoro's safe length limit.
 */
function chunkerMergeOrphans(chunks, hardLimit = 275) {
  if (chunks.length <= 1) return chunks;
  const merged = [];

  for (let i = 0; i < chunks.length; i++) {
    const cur = chunks[i];
    const isTiny = cur.length < CHUNKER_MIN_ORPHAN_CHARS && chunkerWordCount(cur) < CHUNKER_MIN_ORPHAN_WORDS;
    const isFragmentStart = /^[,;:)\]}]/.test(cur);

    if ((isTiny || isFragmentStart) && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.length + 1 + cur.length <= hardLimit) {
        merged[merged.length - 1] = `${prev} ${cur}`.replace(/\s+([.,!?;:])/g, '$1');
        continue;
      }
    }
    merged.push(cur);
  }

  return merged;
}

/**
 * Public backwards-compatible sentence chunker.
 * Splits cleaned text into balanced, conversational, orphan-free chunks.
 */
export function chunkSentences(text, maxChunkLength = 195) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const rawSentences = splitIntoSentencesSafe(trimmed);
  const refined = [];

  for (const s of rawSentences) {
    const pieces = splitLongSentenceBalanced(s, maxChunkLength);
    refined.push(...pieces);
  }

  return chunkerMergeOrphans(refined).filter((c) => c && c.trim().length > 0);
}

/**
 * Chunks a dual-track text item ({ displayText, spokenText, blockType, badge, expandable })
 * while preserving exact alignment between displayText and spokenText.
 */
export function chunkDualSegment(seg, maxChunkLength = 195) {
  const spoken = String(seg.spokenText || '').trim();
  const display = String(seg.displayText || spoken).trim();
  if (!spoken) return [];

  // Summarized / expandable / heading blocks stay as a single crisp segment unless extremely long
  if (seg.expandable || seg.blockType === 'heading' || seg.blockType === 'table-header') {
    return [
      {
        text: spoken,
        spokenText: spoken,
        displayText: display,
        blockType: seg.blockType || 'paragraph',
        badge: seg.badge || '',
        expandable: seg.expandable || null,
      },
    ];
  }

  const spkSentences = splitIntoSentencesSafe(spoken);
  const dispSentences = splitIntoSentencesSafe(display);

  // If sentence counts match cleanly (most prose), chunk each sentence pair individually
  if (spkSentences.length > 1 && spkSentences.length === dispSentences.length) {
    const out = [];
    for (let i = 0; i < spkSentences.length; i++) {
      out.push(
        ...chunkDualSingleSentence(
          dispSentences[i],
          spkSentences[i],
          seg.blockType || 'paragraph',
          seg.badge || '',
          maxChunkLength
        )
      );
    }
    return out;
  }

  // Single sentence (or asymmetrical sentence counts due to abbreviations/math): chunk cleanly
  if (spkSentences.length <= 1) {
    return chunkDualSingleSentence(display, spoken, seg.blockType || 'paragraph', seg.badge || '', maxChunkLength);
  }

  // Fallback when display & spoken sentence counts differ: chunk spoken cleanly and map display proportionally
  const spkChunks = chunkSentences(spoken, maxChunkLength);
  if (spkChunks.length === 1) {
    return [
      {
        text: spkChunks[0],
        spokenText: spkChunks[0],
        displayText: display,
        blockType: seg.blockType || 'paragraph',
        badge: seg.badge || '',
        expandable: null,
      },
    ];
  }
  const dispChunks = chunkSentences(display, maxChunkLength);
  return spkChunks.map((sc, idx) => ({
    text: sc,
    spokenText: sc,
    displayText: dispChunks.length === spkChunks.length ? dispChunks[idx] : sc,
    blockType: seg.blockType || 'paragraph',
    badge: seg.badge || '',
    expandable: null,
  }));
}

function chunkDualSingleSentence(displaySentence, spokenSentence, blockType, badge, maxChunkLength) {
  const spkParts = splitLongSentenceBalanced(spokenSentence, maxChunkLength);
  if (spkParts.length <= 1) {
    return [
      {
        text: spkParts[0] || spokenSentence,
        spokenText: spkParts[0] || spokenSentence,
        displayText: displaySentence,
        blockType,
        badge,
        expandable: null,
      },
    ];
  }

  // Try balanced split on displaySentence with matching count; if counts align, pair them cleanly!
  const dispParts = splitLongSentenceBalanced(displaySentence, maxChunkLength);
  if (dispParts.length === spkParts.length) {
    return spkParts.map((sc, idx) => ({
      text: sc,
      spokenText: sc,
      displayText: dispParts[idx],
      blockType,
      badge,
      expandable: null,
    }));
  }

  // Split displaySentence proportionally at nearest whitespace/clause points to match spkParts count
  const totalSpk = spkParts.reduce((acc, p) => acc + p.length, 0) || 1;
  const alignedDisp = [];
  let cursor = 0;
  for (let i = 0; i < spkParts.length; i++) {
    if (i === spkParts.length - 1) {
      alignedDisp.push(displaySentence.slice(cursor).trim());
    } else {
      const ratio = spkParts[i].length / totalSpk;
      const target = Math.min(displaySentence.length - 1, cursor + Math.round(displaySentence.length * ratio));
      // Snap to nearest top-level comma/space near target
      let best = target;
      let minDist = Infinity;
      let depth = 0;
      for (let j = cursor + 10; j < displaySentence.length - 10; j++) {
        if (displaySentence[j] === '(') depth++;
        else if (displaySentence[j] === ')' && depth > 0) depth--;
        if (depth !== 0) continue;
        if (/[,;:\s]/.test(displaySentence[j])) {
          const dist = Math.abs(j - target) - (/[,;:]/.test(displaySentence[j]) ? 12 : 0);
          if (dist < minDist) {
            minDist = dist;
            best = /[,;:]/.test(displaySentence[j]) ? j + 1 : j;
          }
        }
      }
      alignedDisp.push(displaySentence.slice(cursor, best).trim());
      cursor = best;
    }
  }

  return spkParts.map((sc, idx) => ({
    text: sc,
    spokenText: sc,
    displayText: alignedDisp[idx] || sc,
    blockType,
    badge,
    expandable: null,
  }));
}
