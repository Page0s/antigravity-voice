/**
 * Fenced Code, Diff, Structured Data, Diagram & ASCII Tree Handler
 * Supports modes: 'smart' | 'summarize' | 'read' | 'skip' (code)
 *                 'summarize' | 'skip' (diagrams & ASCII trees)
 */

const CODE_LANGUAGE_NAMES = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  python: 'Python',
  sh: 'shell script',
  shell: 'shell script',
  bash: 'Bash',
  zsh: 'Z shell',
  fish: 'Fish shell',
  ps1: 'PowerShell',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  bat: 'batch script',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  vue: 'Vue',
  svelte: 'Svelte',
  json: 'JSON',
  jsonc: 'JSON',
  jsonl: 'JSON Lines',
  yaml: 'YAML config',
  yml: 'YAML config',
  toml: 'TOML config',
  ini: 'INI config',
  env: 'environment config',
  xml: 'XML',
  svg: 'SVG',
  csv: 'CSV data',
  tsv: 'TSV data',
  cpp: 'C plus plus',
  'c++': 'C plus plus',
  cc: 'C plus plus',
  cxx: 'C plus plus',
  hpp: 'C plus plus header',
  c: 'C code',
  h: 'C header',
  cs: 'C sharp',
  'c#': 'C sharp',
  csharp: 'C sharp',
  fs: 'F sharp',
  fsharp: 'F sharp',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go code',
  golang: 'Go code',
  rb: 'Ruby',
  ruby: 'Ruby',
  php: 'PHP',
  sql: 'SQL query',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  prisma: 'Prisma schema',
  proto: 'Protobuf',
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  tex: 'LaTeX',
  latex: 'LaTeX',
  java: 'Java',
  kotlin: 'Kotlin',
  kt: 'Kotlin',
  swift: 'Swift',
  dart: 'Dart',
  scala: 'Scala',
  r: 'R code',
  lua: 'Lua',
  perl: 'Perl',
  zig: 'Zig',
  elixir: 'Elixir',
  ex: 'Elixir',
  erlang: 'Erlang',
  haskell: 'Haskell',
  hs: 'Haskell',
  ocaml: 'OCaml',
  clojure: 'Clojure',
  solidity: 'Solidity',
  sol: 'Solidity',
  dockerfile: 'Dockerfile',
  docker: 'Docker',
  makefile: 'Makefile',
  make: 'Makefile',
  cmake: 'CMake',
  hcl: 'HCL',
  terraform: 'Terraform',
  tf: 'Terraform',
  nginx: 'Nginx config',
  regex: 'regular expression',
  diff: 'code diff',
  patch: 'code patch',
  http: 'HTTP request',
  log: 'log output',
  text: 'plain text',
  txt: 'plain text',
  plaintext: 'plain text',
};

const CODE_DIAGRAM_LANGS = new Set([
  'mermaid',
  'graphviz',
  'dot',
  'plantuml',
  'puml',
  'd2',
  'ascii',
  'tree',
  'diagram',
  'flowchart',
  'sequence',
]);

const CODE_SHELL_LANGS = new Set(['sh', 'shell', 'bash', 'zsh', 'fish', 'ps1', 'powershell', 'pwsh', 'cmd', 'bat']);

export function formatCodeLanguageName(lang) {
  if (!lang) return 'code';
  const key = String(lang).trim().toLowerCase();
  return CODE_LANGUAGE_NAMES[key] || `${lang.trim()} code`;
}

/**
 * Checks whether plain/text block content is an ASCII directory tree or box-drawing diagram.
 */
export function detectAsciiVisualType(code) {
  if (!code || typeof code !== 'string') return null;
  const lines = code.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const treeLines = lines.filter((l) => /[├└│┌┐┘┬┴┼]/.test(l) || /^\s*(?:\|--|\+--|`--|\|\s)/.test(l));
  if (treeLines.length >= 2) {
    // Distinguish directory tree vs box/flow diagram
    const hasArrowsOrBoxes = lines.some((l) => /[▼▲◄►┌┐┘]|\+---+\+|---+[>v]/.test(l));
    return hasArrowsOrBoxes ? 'ascii-diagram' : 'ascii-tree';
  }

  const boxLines = lines.filter((l) => /\+[-=]{2,}\+|[┌┐└┘─━═]{3,}|^\s*[▼▲↓↑]\s*$/.test(l));
  if (boxLines.length >= 2) {
    return 'ascii-diagram';
  }

  return null;
}

/**
 * Checks whether a code block looks like a unified diff.
 */
function codeLooksLikeDiff(lang, code) {
  const l = String(lang || '').trim().toLowerCase();
  if (l === 'diff' || l === 'patch') return true;
  const lines = code.split(/\r?\n/);
  const hasHunk = lines.some((line) => /^@@\s+-\d+/.test(line));
  const plusMinus = lines.filter((line) => /^[+-][^+-]/.test(line)).length;
  return hasHunk || (plusMinus >= 3 && lines.some((line) => /^\+\+\+\s|^---\s/.test(line)));
}

/**
 * Builds readable spoken lines for `read` mode (or on-demand "Read code" expansion).
 */
function codeBuildReadSegments(code, langName) {
  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // Group short lines cleanly so playback isn't choppy
  const segments = [
    {
      blockType: 'code',
      badge: 'CODE',
      displayText: `${langName} (${lines.length} ${lines.length === 1 ? 'line' : 'lines'}):`,
      spokenText: `${langName}, ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}.`,
    },
  ];

  // Cap on-demand reading cleanly to avoid massive 200-line blocks freezing TTS
  const capped = lines.slice(0, 40);
  for (const line of capped) {
    const cleanSpoken = line
      .replace(/===|==/g, ' equals ')
      .replace(/!==|!=/g, ' not equals ')
      .replace(/=>/g, ' arrow ')
      .replace(/->/g, ' arrow ')
      .replace(/&&/g, ' and ')
      .replace(/\|\|/g, ' or ')
      .replace(/[{}()[\];]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanSpoken) continue;
    segments.push({
      blockType: 'code',
      badge: 'CODE',
      displayText: line,
      spokenText: /[.!?]$/.test(cleanSpoken) ? cleanSpoken : `${cleanSpoken}.`,
    });
  }

  if (lines.length > 40) {
    segments.push({
      blockType: 'code-summary',
      badge: 'CODE',
      displayText: `... and ${lines.length - 40} more lines.`,
      spokenText: `And ${lines.length - 40} more lines omitted.`,
    });
  }

  return segments;
}

/**
 * Handles a diagram or ASCII tree block (`mermaid`, box-drawing diagram, directory tree).
 */
export function renderDiagramBlock(kind, lang, rawContent, options = {}, stats = null) {
  const mode = options.diagrams || 'summarize';
  if (mode === 'skip') {
    if (stats) stats.diagramsFiltered = (stats.diagramsFiltered || 0) + 1;
    return [];
  }

  if (stats) stats.diagramsFiltered = (stats.diagramsFiltered || 0) + 1;

  const lines = String(rawContent || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let summary = 'Diagram omitted.';
  if (kind === 'ascii-tree') {
    const itemCount = lines.filter((l) => /[├└]/.test(l) || /\.\w+/.test(l) || /\/$/.test(l)).length || lines.length;
    summary = `Directory tree with ${itemCount} ${itemCount === 1 ? 'item' : 'items'} omitted.`;
  } else if (String(lang || '').toLowerCase() === 'mermaid') {
    const first = (lines[0] || '').toLowerCase();
    let diagramType = 'Mermaid diagram';
    if (first.startsWith('flowchart') || first.startsWith('graph')) diagramType = 'Mermaid flowchart';
    else if (first.startsWith('sequencediagram')) diagramType = 'Mermaid sequence diagram';
    else if (first.startsWith('statediagram')) diagramType = 'Mermaid state diagram';
    else if (first.startsWith('classdiagram')) diagramType = 'Mermaid class diagram';
    else if (first.startsWith('erdiagram')) diagramType = 'Mermaid entity diagram';
    summary = `${diagramType} omitted.`;
  } else if (kind === 'ascii-diagram') {
    summary = 'Architecture diagram omitted.';
  } else if (lang) {
    summary = `${lang} diagram omitted.`;
  }

  return [
    {
      blockType: 'diagram',
      badge: 'DIAGRAM',
      displayText: summary,
      spokenText: summary,
    },
  ];
}

/**
 * Renders a fenced code block into structured segments based on `options.codeBlocks` and `options.diagrams`.
 */
export function renderCodeBlock(lang, rawCode, options = {}, stats = null) {
  const cleanLang = String(lang || '').trim();
  const lowerLang = cleanLang.toLowerCase();
  const trimmedCode = String(rawCode || '').trim();
  const lines = trimmedCode ? trimmedCode.split(/\r?\n/).filter((l) => l.trim().length > 0) : [];

  if (lines.length === 0) return [];

  // 1. Check if this fenced block is actually a Mermaid/PlantUML diagram or ASCII tree/flow
  if (CODE_DIAGRAM_LANGS.has(lowerLang)) {
    return renderDiagramBlock('diagram', cleanLang, trimmedCode, options, stats);
  }
  if (!lowerLang || lowerLang === 'text' || lowerLang === 'txt' || lowerLang === 'plaintext') {
    const asciiKind = detectAsciiVisualType(trimmedCode);
    if (asciiKind) {
      return renderDiagramBlock(asciiKind, cleanLang, trimmedCode, options, stats);
    }
  }

  // 2. Apply user `codeBlocks` filter policy
  const mode = options.codeBlocks || 'smart';
  if (mode === 'skip') {
    if (stats) stats.codeSkipped = (stats.codeSkipped || 0) + 1;
    return [];
  }

  // 3. Detect diffs for richer summary
  if (codeLooksLikeDiff(lowerLang, trimmedCode)) {
    if (mode === 'read') {
      if (stats) stats.codeRead = (stats.codeRead || 0) + 1;
      return codeBuildReadSegments(trimmedCode, 'Code diff');
    }
    if (stats) stats.codeSummarized = (stats.codeSummarized || 0) + 1;
    const added = lines.filter((l) => /^\+[^+]/.test(l)).length;
    const removed = lines.filter((l) => /^-[^-]/.test(l)).length;
    const diffSummary = `Code diff with ${added} ${added === 1 ? 'addition' : 'additions'} and ${removed} ${removed === 1 ? 'deletion' : 'deletions'}.`;
    return [
      {
        blockType: 'code-summary',
        badge: 'DIFF',
        displayText: diffSummary,
        spokenText: diffSummary,
        expandable: {
          kind: 'code',
          label: 'Read diff',
          segments: codeBuildReadSegments(trimmedCode, 'Code diff'),
        },
      },
    ];
  }

  const languageName = formatCodeLanguageName(cleanLang);

  // 4. Read mode: read code aloud
  if (mode === 'read') {
    if (stats) stats.codeRead = (stats.codeRead || 0) + 1;
    return codeBuildReadSegments(trimmedCode, languageName);
  }

  // 5. Smart mode: read short 1-2 line snippets (< 80 chars), summarize longer blocks with on-demand expansion
  if (mode === 'smart' && lines.length <= 2 && trimmedCode.length < 80) {
    if (stats) stats.codeRead = (stats.codeRead || 0) + 1;
    const inlineOneLine = lines.join(' ');
    const prefix = CODE_SHELL_LANGS.has(lowerLang) ? 'Command' : languageName;
    const text = `${prefix}: ${inlineOneLine}.`;
    return [
      {
        blockType: 'code',
        badge: 'CODE',
        displayText: text,
        spokenText: text,
      },
    ];
  }

  // 6. Summarize mode (or long block in smart mode) with on-demand `Read code` button!
  if (stats) stats.codeSummarized = (stats.codeSummarized || 0) + 1;
  const lineWord = lines.length === 1 ? 'line' : 'lines';
  const summary = `Code block omitted: ${languageName}, ${lines.length} ${lineWord}.`;

  return [
    {
      blockType: 'code-summary',
      badge: 'CODE',
      displayText: summary,
      spokenText: summary,
      expandable: {
        kind: 'code',
        label: `Read ${lines.length} ${lineWord}`,
        segments: codeBuildReadSegments(trimmedCode, languageName),
      },
    },
  ];
}
