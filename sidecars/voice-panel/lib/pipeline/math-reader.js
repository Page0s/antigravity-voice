/**
 * LaTeX & Math Expression to Natural Spoken English Converter
 * Zero-dependency deterministic converter for $...$, $$...$$, \(...\), \[...\].
 */

const MATH_GREEK_LETTERS = {
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  delta: 'delta',
  epsilon: 'epsilon',
  varepsilon: 'epsilon',
  zeta: 'zeta',
  eta: 'eta',
  theta: 'theta',
  vartheta: 'theta',
  iota: 'iota',
  kappa: 'kappa',
  lambda: 'lambda',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  pi: 'pi',
  varpi: 'pi',
  rho: 'rho',
  sigma: 'sigma',
  tau: 'tau',
  upsilon: 'upsilon',
  phi: 'phi',
  varphi: 'phi',
  chi: 'chi',
  psi: 'psi',
  omega: 'omega',
  Gamma: 'capital gamma',
  Delta: 'delta',
  Theta: 'theta',
  Lambda: 'lambda',
  Xi: 'xi',
  Pi: 'pi',
  Sigma: 'sigma',
  Phi: 'phi',
  Psi: 'psi',
  Omega: 'omega',
};

const MATH_OPERATORS = {
  times: 'times',
  cdot: 'times',
  div: 'divided by',
  pm: 'plus or minus',
  mp: 'minus or plus',
  leq: 'is less than or equal to',
  le: 'is less than or equal to',
  geq: 'is greater than or equal to',
  ge: 'is greater than or equal to',
  neq: 'is not equal to',
  ne: 'is not equal to',
  approx: 'is approximately',
  equiv: 'is equivalent to',
  sim: 'is similar to',
  propto: 'is proportional to',
  infty: 'infinity',
  in: 'in',
  notin: 'not in',
  subset: 'is a subset of',
  subseteq: 'is a subset of or equal to',
  supset: 'is a superset of',
  cup: 'union',
  cap: 'intersection',
  emptyset: 'the empty set',
  forall: 'for all',
  exists: 'there exists',
  neg: 'not',
  land: 'and',
  lor: 'or',
  implies: 'implies',
  Rightarrow: 'implies',
  rightarrow: 'goes to',
  to: 'to',
  leftarrow: 'from',
  leftrightarrow: 'if and only if',
  iff: 'if and only if',
  partial: 'partial',
  nabla: 'del',
  sum: 'sum',
  prod: 'product',
  int: 'integral',
  lim: 'limit',
  log: 'log',
  ln: 'natural log',
  exp: 'e to the',
  sin: 'sine',
  cos: 'cosine',
  tan: 'tangent',
  sec: 'secant',
  csc: 'cosecant',
  cot: 'cotangent',
  arcsin: 'arc sine',
  arccos: 'arc cosine',
  arctan: 'arc tangent',
  min: 'minimum',
  max: 'maximum',
  mod: 'modulo',
  pmod: 'modulo',
  deg: 'degrees',
  dots: 'and so on',
  ldots: 'and so on',
  cdots: 'and so on',
  therefore: 'therefore',
  because: 'because',
};

/**
 * Extracts a balanced `{...}` group starting at `startIdx`, returning { content, endIdx }.
 */
function mathExtractGroup(str, startIdx) {
  let i = startIdx;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (i >= str.length) return null;

  if (str[i] === '{') {
    let depth = 0;
    const contentStart = i + 1;
    for (let j = i; j < str.length; j++) {
      if (str[j] === '{' && str[j - 1] !== '\\') depth++;
      else if (str[j] === '}' && str[j - 1] !== '\\') {
        depth--;
        if (depth === 0) {
          return { content: str.slice(contentStart, j), endIdx: j + 1 };
        }
      }
    }
    return { content: str.slice(contentStart), endIdx: str.length };
  }

  // Single token (macro or character)
  if (str[i] === '\\') {
    const m = str.slice(i).match(/^\\[a-zA-Z]+/);
    if (m) return { content: m[0], endIdx: i + m[0].length };
  }
  return { content: str[i], endIdx: i + 1 };
}

/**
 * Recursively replaces \frac{a}{b} and \sqrt[n]{x} constructs.
 */
function mathReplaceStructuredCommands(input) {
  let out = input;

  // \frac{num}{den} and \dfrac, \tfrac
  let safety = 0;
  while (/\\[dt]?frac\b/.test(out) && safety < 16) {
    safety++;
    const match = out.match(/\\[dt]?frac\b/);
    if (!match) break;
    const start = match.index;
    const afterCmd = start + match[0].length;
    const num = mathExtractGroup(out, afterCmd);
    if (!num) break;
    const den = mathExtractGroup(out, num.endIdx);
    if (!den) break;
    const spokenNum = latexToSpeech(num.content);
    const spokenDen = latexToSpeech(den.content);
    out = `${out.slice(0, start)} ${spokenNum} over ${spokenDen} ${out.slice(den.endIdx)}`;
  }

  // \sqrt[n]{x} and \sqrt{x}
  safety = 0;
  while (/\\sqrt\b/.test(out) && safety < 16) {
    safety++;
    const match = out.match(/\\sqrt\b/);
    if (!match) break;
    const start = match.index;
    let cursor = start + match[0].length;
    while (cursor < out.length && /\s/.test(out[cursor])) cursor++;

    let rootPrefix = 'square root of';
    if (out[cursor] === '[') {
      const closeBracket = out.indexOf(']', cursor);
      if (closeBracket !== -1) {
        const degree = out.slice(cursor + 1, closeBracket).trim();
        cursor = closeBracket + 1;
        if (degree === '3') rootPrefix = 'cube root of';
        else if (degree === '4') rootPrefix = 'fourth root of';
        else rootPrefix = `${degree}th root of`;
      }
    }

    const inner = mathExtractGroup(out, cursor);
    if (!inner) break;
    const spokenInner = latexToSpeech(inner.content);
    out = `${out.slice(0, start)} ${rootPrefix} ${spokenInner} ${out.slice(inner.endIdx)}`;
  }

  return out;
}

/**
 * Converts a LaTeX expression string into natural spoken English.
 */
export function latexToSpeech(rawFormula) {
  if (!rawFormula || typeof rawFormula !== 'string') return '';

  let s = rawFormula.trim();
  if (!s) return '';

  // Remove environment wrappers and alignment markers
  s = s.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, ' ');
  s = s.replace(/\\\\/g, ', ');
  s = s.replace(/&/g, ' ');

  // Remove sizing & spacing decorators
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|textstyle)\b/g, ' ');
  s = s.replace(/\\(?:quad\b|qquad\b|[,;!:])/g, ' ');

  // Unwrap styling macros like \text{...}, \mathrm{...}, \mathbf{...}, \operatorname{...}
  let unwrapGuard = 0;
  while (/\\(?:text|textbf|textit|textrm|mathrm|mathbf|mathit|mathsf|mathcal|mathbb|operatorname|hat|bar|vec|tilde|overline)\s*\{/.test(s) && unwrapGuard < 16) {
    unwrapGuard++;
    s = s.replace(/\\(?:text|textbf|textit|textrm|mathrm|mathbf|mathit|mathsf|mathcal|mathbb|operatorname|hat|bar|vec|tilde|overline)\s*\{([^{}]*)\}/g, ' $1 ');
  }

  // Handle \frac and \sqrt recursively
  s = mathReplaceStructuredCommands(s);

  // Handle superscripts: ^{...} or ^token
  s = s.replace(/\^\{([^{}]+)\}/g, (_, exp) => {
    const e = exp.trim();
    if (e === '2') return ' squared ';
    if (e === '3') return ' cubed ';
    if (e === '-1') return ' inverse ';
    return ` to the power of ${latexToSpeech(e)} `;
  });
  s = s.replace(/\^([a-zA-Z0-9])/g, (_, exp) => {
    if (exp === '2') return ' squared ';
    if (exp === '3') return ' cubed ';
    return ` to the power of ${exp} `;
  });

  // Handle subscripts: _{...} or _token
  s = s.replace(/_\{([^{}]+)\}/g, (_, sub) => ` sub ${latexToSpeech(sub)} `);
  s = s.replace(/_([a-zA-Z0-9])/g, (_, sub) => ` sub ${sub} `);

  // Handle escaped symbols \% \$ \{ \}
  s = s.replace(/\\%/g, ' percent ');
  s = s.replace(/\\\$/g, ' dollars ');
  s = s.replace(/\\([{}])/g, ' ');

  // Replace known LaTeX commands (Greek + operators)
  s = s.replace(/\\([a-zA-Z]+)/g, (match, cmd) => {
    if (MATH_GREEK_LETTERS[cmd]) return ` ${MATH_GREEK_LETTERS[cmd]} `;
    if (MATH_OPERATORS[cmd]) return ` ${MATH_OPERATORS[cmd]} `;
    return ` ${cmd} `;
  });

  // Clean remaining braces
  s = s.replace(/[{}]/g, ' ');

  // Convert math operators to spoken words
  s = s.replace(/<=/g, ' is less than or equal to ');
  s = s.replace(/>=/g, ' is greater than or equal to ');
  s = s.replace(/!=/g, ' is not equal to ');
  s = s.replace(/≤/g, ' is less than or equal to ');
  s = s.replace(/≥/g, ' is greater than or equal to ');
  s = s.replace(/≠/g, ' is not equal to ');
  s = s.replace(/≈/g, ' is approximately ');
  s = s.replace(/±/g, ' plus or minus ');
  s = s.replace(/×/g, ' times ');
  s = s.replace(/÷/g, ' divided by ');
  s = s.replace(/∞/g, ' infinity ');
  s = s.replace(/=/g, ' equals ');
  s = s.replace(/\+/g, ' plus ');
  s = s.replace(/(?<=[\w)])\s*-\s*(?=[\w(])/g, ' minus ');
  s = s.replace(/(?<=[\w)])\s*\*\s*(?=[\w(])/g, ' times ');
  s = s.replace(/</g, ' is less than ');
  s = s.replace(/>/g, ' is greater than ');
  s = s.replace(/\s+\/\s+/g, ' over ');
  s = s.replace(/\|([^|]+)\|/g, ' absolute value of $1 ');

  // Separate common implicit multiplication like `mc` -> `m c`? Only for classic short variables like `2x` -> `2 x`, `mc squared` -> `m c squared`
  s = s.replace(/\b(\d+)([a-zA-Z])\b/g, '$1 $2');
  s = s.replace(/\bmc\b/g, 'm c');

  return s.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

/**
 * Formats a display math block ($$...$$ or \[...\]) according to user math mode.
 */
export function formatMathBlock(rawFormula, options = {}) {
  const mode = options.math || 'natural';
  const compact = String(rawFormula || '').trim().replace(/\s+/g, ' ');
  if (!compact) return null;

  if (mode === 'skip') {
    return { skipped: true, reason: 'math' };
  }

  if (mode === 'summarize') {
    return {
      blockType: 'math',
      badge: 'MATH',
      displayText: compact,
      spokenText: 'Mathematical formula omitted.',
      expandable: {
        kind: 'math',
        label: 'Read formula',
        segments: [
          {
            blockType: 'math',
            badge: 'MATH',
            displayText: compact,
            spokenText: ensureMathTerminalPunct(latexToSpeech(compact)),
          },
        ],
      },
    };
  }

  if (mode === 'literal') {
    return {
      blockType: 'math',
      badge: 'MATH',
      displayText: compact,
      spokenText: ensureMathTerminalPunct(compact),
    };
  }

  // 'natural' (Default)
  const spoken = latexToSpeech(compact);
  return {
    blockType: 'math',
    badge: 'MATH',
    displayText: compact,
    spokenText: ensureMathTerminalPunct(spoken || compact),
  };
}

function ensureMathTerminalPunct(str) {
  const t = String(str || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
