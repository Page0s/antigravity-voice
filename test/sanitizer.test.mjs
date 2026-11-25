/**
 * Comprehensive Test Suite for Antigravity Voice v2.1.0
 * Covers: Modular Text Pipeline, Tables, Symbols, Structured .md, Math, Code/Diffs,
 *         Diagrams, Dual Display/Spoken View, Orphan-Free Chunking, Profiles,
 *         AudioQueue Expandable Blocks, Classic Client Bundle Integrity, and Lifecycle Hook.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  OUTPUT_PROFILES,
  chunkSentences,
  formatFilterStatsSummary,
  processForSpeech,
  resolveFilterOptions,
  sanitizeText,
} from '../hooks/sanitizer.mjs';
import { AudioQueueController } from '../sidecars/voice-panel/lib/audio-queue.js';
import { buildClientBundle } from '../sidecars/voice-panel/lib/bundle.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✔ Test ${passed} passed: ${name}`);
}

async function runTests() {
  console.log('Running Antigravity Voice v2.1.0 Pipeline & Bundle Tests...\n');

  // 1. Fenced code blocks (smart summary + expandable + modes)
  await test('Fenced code block smart summary & on-demand expansion', () => {
    const input = 'Here is the function:\n```javascript\nfunction add(a, b) {\n  const sum = a + b;\n  return sum;\n}\n```\nIt returns the sum.';
    const res = processForSpeech(input);
    assert(!res.cleanText.includes('```'), 'Code block fences should be removed');
    assert(res.cleanText.includes('JavaScript'), 'Language name should be mentioned');
    assert(res.cleanText.includes('It returns the sum'), 'Following text should be preserved');
    const codeSeg = res.segments.find((s) => s.blockType === 'code-summary');
    assert(codeSeg && codeSeg.expandable && codeSeg.expandable.segments.length > 1, 'Summarized code block should carry expandable segments');
    assert.strictEqual(res.stats.codeSummarized, 1);

    // Short 1-line command in smart mode is read concisely
    const shortRes = processForSpeech('Run:\n```bash\nnpm test\n```');
    assert(shortRes.cleanText.includes('npm test'), 'Short shell command should be spoken in smart mode');

    // Skip mode omits entirely
    const skipped = sanitizeText(input, { codeBlocks: 'skip' });
    assert(!skipped.includes('JavaScript'), 'Skip mode should omit code summary');
    assert(skipped.includes('It returns the sum'), 'Surrounding prose preserved');

    // Read mode speaks code lines
    const readRes = processForSpeech(input, { codeBlocks: 'read' });
    assert(readRes.cleanText.includes('return sum'), 'Read mode should speak code contents');
  });

  // 2. Legacy skipCodeBlocks option backwards compatibility
  await test('Legacy skipCodeBlocks option compatibility', () => {
    const input = 'Prefix text.\n```python\nprint("hello")\n```\nSuffix text.';
    const output = sanitizeText(input, { skipCodeBlocks: true });
    assert(!output.includes('Python'), 'Language should not be mentioned when skipCodeBlocks is true');
    assert(output.includes('Prefix text') && output.includes('Suffix text'), 'Surrounding text preserved');
  });

  // 3. Inline code backticks & snake_case underscore protection
  await test('Inline code removal without mangling snake_case underscores', () => {
    const input = 'You can run `npm install` or update `idle_unload_minutes` and `my_cool_var` in `node index.js`.';
    const res = processForSpeech(input);
    assert(!res.cleanText.includes('`'), 'Backticks removed');
    assert(res.displayText.includes('idle_unload_minutes'), 'Display text preserves snake_case intact');
    assert(res.cleanText.includes('idle_unload_minutes'), 'Spoken text does not strip middle underscores as italics');
    assert(res.cleanText.includes('my_cool_var'), 'Multiple underscores not corrupted');

    // With humanizeIdentifiers enabled
    const humanized = processForSpeech(input, { humanizeIdentifiers: true });
    assert(humanized.cleanText.includes('idle unload minutes'), 'Humanize splits snake_case');
    assert(humanized.displayText.includes('idle_unload_minutes'), 'Display still shows original identifier');
  });

  // 4. Small 2-column Markdown table in Smart mode (reads naturally!)
  await test('Small 2-column Markdown table reads naturally in Smart mode', () => {
    const input = 'Comparison:\n| Feature | Status |\n| --- | --- |\n| WebGPU | ✅ Supported |\n| Fallback | WASM |\nAll done.';
    const res = processForSpeech(input);
    assert(!res.cleanText.includes('|'), 'Table pipes removed');
    assert(res.cleanText.includes('WebGPU: Supported.'), `Expected natural key-value row, got: ${res.cleanText}`);
    assert(res.cleanText.includes('Fallback: WASM.'), `Expected second row, got: ${res.cleanText}`);
    assert(res.cleanText.includes('All done.'), 'Trailing prose preserved');
    assert.strictEqual(res.stats.tablesRead, 1);
    assert(res.segments.some((s) => s.badge === 'TABLE'), 'Table segments carry TABLE badge');
  });

  // 5. Multi-column table + empty cells + Smart large-table summary + Room Listen full read
  await test('Multi-column table linearization, large-table Smart summary & Room Listen full read', () => {
    const rows = Array.from({ length: 8 }, (_, idx) => `| Item ${idx + 1} | Active | ${idx % 2 === 0 ? '—' : 'Fast'} |`).join('\n');
    const bigTable = `| Name | State | Notes |\n| :--- | :---: | ---: |\n${rows}`;

    // Smart mode (> 6 rows): summarizes with expandable rows!
    const smartRes = processForSpeech(bigTable, { tables: 'smart' });
    assert.strictEqual(smartRes.stats.tablesSummarized, 1);
    assert(smartRes.cleanText.includes('Table with 8 rows and 3 columns: Name, State, Notes.'), `Unexpected summary: ${smartRes.cleanText}`);
    const summarySeg = smartRes.segments[0];
    assert(summarySeg.expandable && summarySeg.expandable.segments.length === 9, 'Expandable should contain intro + 8 rows');

    // Room Listen (full profile): reads all 8 rows naturally & skips `—` empty cells cleanly!
    const fullRes = processForSpeech(bigTable, { profile: 'full' });
    assert.strictEqual(fullRes.stats.tablesRead, 1);
    assert(fullRes.cleanText.includes('Item 1: State is Active.'), `Empty dash cell should be skipped cleanly: ${fullRes.cleanText}`);
    assert(fullRes.cleanText.includes('Item 2: State is Active, Notes is Fast.'), `Non-empty cells paired with headers: ${fullRes.cleanText}`);

    // Skip mode: silent
    const skipRes = processForSpeech(bigTable, { tables: 'skip' });
    assert.strictEqual(skipRes.segments.length, 0);
    assert.strictEqual(skipRes.stats.tablesSkipped, 1);
  });

  // 6. Indented, pipe-less Markdown tables & HTML <table>
  await test('Pipe-less Markdown tables and HTML tables', () => {
    const pipeless = 'Key | Value\n--- | ---\nPort | 4545\nHost | localhost';
    const res1 = processForSpeech(pipeless);
    assert(res1.cleanText.includes('Port: 4545.'), `Pipe-less table not parsed: ${res1.cleanText}`);

    const htmlTable = '<table><tr><th>Lang</th><th>Engine</th></tr><tr><td>JS</td><td>Kokoro</td></tr></table>';
    const res2 = processForSpeech(htmlTable);
    assert(res2.cleanText.includes('JS: Kokoro.'), `HTML table not parsed: ${res2.cleanText}`);
  });

  // 7. Regression: User's 1st screenshot (typing curriculum bullets, ranges, symbols, parens, diacritics)
  await test('Regression: Typing curriculum screenshot (indented bullets, a–z, +, &, 1–3, (; / Č / Ö))', () => {
    const input = [
      '  - Semicolon (;) Skipped in Part 1: Part 1 stays strictly a–z + Space + Backspace, while the right pinky rests on its home anchor (; / Č / Ö).',
      "  - Error Handling & Touch Backspace: Sub-drills 1–3 (new key intro) block on error so beginners don't look down for Backspace;",
    ].join('\n');

    const res = processForSpeech(input);
    assert.strictEqual(res.segments.length, 2, `Expected 2 clean segments (no mid-paren break!), got ${res.segments.length}: ${JSON.stringify(res.segments.map((s) => s.spokenText))}`);

    const s1 = res.segments[0];
    const s2 = res.segments[1];

    // No leading `- `
    assert(!s1.displayText.startsWith('-'), `Leading dash should be stripped in display: ${s1.displayText}`);
    assert(!s1.spokenText.startsWith('-'), `Leading dash should be stripped in spoken: ${s1.spokenText}`);
    assert(!s2.displayText.startsWith('-'), `Second bullet dash should be stripped: ${s2.displayText}`);

    // Display keeps visual symbols; Spoken expands smoothly!
    assert(s1.displayText.includes('a–z + Space + Backspace'), `Display keeps original symbols: ${s1.displayText}`);
    assert(s1.displayText.includes('(; / Č / Ö)'), `Display keeps anchor intact: ${s1.displayText}`);
    assert(s1.spokenText.includes('a to z plus Space plus Backspace'), `Spoken expands range and plus: ${s1.spokenText}`);
    assert(s1.spokenText.includes('semicolon, Č, or Ö'), `Spoken expands slash list smoothly with diacritics: ${s1.spokenText}`);
    assert(!s1.spokenText.includes('(;)'), `Redundant bare (;) removed in speech: ${s1.spokenText}`);

    assert(s2.displayText.includes('Error Handling & Touch Backspace'), `Display keeps &: ${s2.displayText}`);
    assert(s2.spokenText.includes('Error Handling and Touch Backspace'), `Spoken expands &: ${s2.spokenText}`);
    assert(s2.spokenText.includes('Sub-drills 1 to 3'), `Spoken keeps Sub-drills hyphen & expands 1–3: ${s2.spokenText}`);
    assert(s2.spokenText.endsWith('.'), 'Trailing semicolon on bullet normalized to period');
  });

  // 8. Regression: User's 2nd & 3rd screenshots (no solo "engine." orphan, no "Structured.md" glue, no harsh ###/=== reading)
  await test('Regression: No solo "engine." orphan word and clean Structured .md symbol handling', () => {
    const soloWordInput =
      'The toggle only changes whether the transcript box displays the cleaner visual symbols or the exact expanded words being sent to the voice engine.';
    const res1 = processForSpeech(soloWordInput);
    assert.strictEqual(
      res1.segments.length,
      1,
      `147-char sentence must NOT be cut into solo "engine." chunk! Got: ${JSON.stringify(res1.segments.map((s) => s.spokenText))}`
    );

    const mdLine =
      '- **Structured `.md` files:** Heading levels (`#`–`######`, Setext `===`/`---`), nested bullet & numbered lists (fixing the indented `- ` bug from your screenshot).';
    const res2 = processForSpeech(mdLine);
    const fullDisp = res2.displayText;
    const fullSpk = res2.cleanText;

    assert(!fullDisp.includes('Structured.md'), `Must NOT glue .md onto Structured: ${fullDisp}`);
    assert(fullDisp.includes('Structured .md files'), `Display preserves .md cleanly: ${fullDisp}`);
    assert(fullSpk.includes('Structured dot M D files'), `Spoken verbalizes .md cleanly: ${fullSpk}`);
    assert(!fullSpk.includes('######') && !fullSpk.includes('==='), `Spoken removes harsh repeated syntax runs: ${fullSpk}`);
    assert(fullSpk.includes('indented dash bug'), `Inline code dash verbalized cleanly: ${fullSpk}`);
    for (const seg of res2.segments) {
      assert(seg.spokenText.split(/\s+/).length >= 4, `No tiny orphan segments allowed: "${seg.spokenText}"`);
    }
  });

  // 9. Balanced splitting on genuinely very long sentences (orphan guard!)
  await test('Long sentence balanced clause splitting with zero orphan fragments', () => {
    const longSentence =
      'This is an exceptionally long sentence that exceeds the standard chunk ceiling threshold because it includes extensive descriptive prose, followed by an additional informative elaboration on technical architectures, and finally concludes with a clear definitive summary statement for listeners.';
    const chunks = chunkSentences(longSentence, 120);
    assert(chunks.length >= 2, `Expected multiple chunks, got ${chunks.length}`);
    for (const c of chunks) {
      assert(c.length <= 265, `Chunk exceeds Kokoro-safe ceiling: ${c.length}`);
      assert(c.split(/\s+/).length >= 4, `Chunk should never be an orphan fragment: "${c}"`);
      assert(!/^[,;:)]/.test(c), `Chunk must never start with dangling delimiter: "${c}"`);
    }
  });

  // 10. URLs, Markdown links, Autolinks, Citations & File Paths
  await test('Links, autolinks, bare URLs, citations, and file path modes', () => {
    const input = 'Check [Documentation](https://github.com/google/antigravity) [1][2] or visit <https://example.com/docs/api>.';
    const res = processForSpeech(input);
    assert.strictEqual(res.cleanText, 'Check Documentation or visit a link to example.com.');
    assert.strictEqual(res.stats.citationsStripped, 1);

    const pathInput = 'Edit `sidecars/voice-panel/lib/sanitizer.js` now.';
    const fnameRes = processForSpeech(pathInput, { filePaths: 'filename' });
    assert(fnameRes.displayText.includes('sanitizer.js'), `Filename display: ${fnameRes.displayText}`);
    assert(fnameRes.cleanText.includes('sanitizer dot J S'), `Filename spoken: ${fnameRes.cleanText}`);

    const natRes = processForSpeech(pathInput, { filePaths: 'natural' });
    assert(natRes.cleanText.includes('voice panel lib sanitizer dot J S'), `Natural path spoken: ${natRes.cleanText}`);

    const skipUrlRes = processForSpeech('Visit https://example.com/test today.', { urls: 'skip' });
    assert(!skipUrlRes.cleanText.includes('example.com'), `Skip URLs should omit bare URL: ${skipUrlRes.cleanText}`);
  });

  // 11. Headings (? and ! preserved!), Setext headings, Task Lists & Callouts
  await test('Headings (?/! preserved), Setext headings, task checklists & GitHub alerts', () => {
    const input = [
      '# What is New?',
      'Subtitle',
      '--------',
      '- [x] Fix bullet dashes',
      '- [ ] Add room listen mode',
      '> [!WARNING] Breaking change ahead',
    ].join('\n');

    const res = processForSpeech(input);
    assert(res.cleanText.includes('What is New?'), `Question mark must NOT be overwritten by period: ${res.cleanText}`);
    assert(res.segments.some((s) => s.badge === 'H1'), 'ATX heading gets H1 badge');
    assert(res.segments.some((s) => s.badge === 'H2' && s.displayText.includes('Subtitle')), 'Setext heading parsed as H2');
    assert(res.cleanText.includes('Done: Fix bullet dashes.'), 'Checked task announced as Done');
    assert(res.cleanText.includes('To do: Add room listen mode.'), 'Unchecked task announced as To do');
    assert(res.cleanText.includes('Warning: Breaking change ahead.'), 'GitHub callout alert announced');

    const skipCallout = processForSpeech('> [!WARNING] Hidden', { callouts: 'skip' });
    assert.strictEqual(skipCallout.segments.length, 0);
  });

  // 12. Abbreviations, decimals, versions & dotted tech names in chunking
  await test('Abbreviations, decimals, versions & Node.js preservation in chunking', () => {
    const abbrevInput = 'Dr. Smith met with Mr. Jones at 10 a.m. to discuss e.g. Node.js and v2.0.0 metrics. They agreed on 3.14 and 99.9% uptime.';
    const chunks = chunkSentences(abbrevInput);
    assert.strictEqual(chunks.length, 2, `Expected 2 chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`);
    assert(chunks[0].startsWith('Dr. Smith'), 'First chunk starts with Dr. Smith');
    assert(chunks[1].startsWith('They agreed'), 'Second chunk starts with They agreed');
  });

  // 13. LaTeX math ($$, $, \[, \() & currency preservation
  await test('LaTeX natural speech conversion and currency preservation', () => {
    const input = 'Einstein stated that $$E = mc^2$$ holds true. Also consider $\\frac{a^2 + b^2}{2} \\leq \\pi$ and \\(x_1 + y_2\\) at a price of $50 or \\$100.';
    const res = processForSpeech(input);
    assert(res.cleanText.includes('E equals m c squared'), `Block math natural: ${res.cleanText}`);
    assert(res.cleanText.includes('a squared plus b squared over 2 is less than or equal to pi'), `Inline frac/greek math: ${res.cleanText}`);
    assert(res.cleanText.includes('x sub 1 plus y sub 2'), `Paren inline math: ${res.cleanText}`);
    assert(res.cleanText.includes('$50'), `Currency $50 preserved: ${res.cleanText}`);
    assert(res.cleanText.includes('$100'), `Escaped currency preserved: ${res.cleanText}`);

    const sumMath = processForSpeech('$$E = mc^2$$', { math: 'summarize' });
    assert(sumMath.cleanText.includes('Mathematical formula omitted.'), 'Math summarize mode');
    assert(sumMath.segments[0].expandable, 'Summarized math is expandable');

    const skipMath = processForSpeech('$$E = mc^2$$', { math: 'skip' });
    assert.strictEqual(skipMath.segments.length, 0, 'Math skip mode');
  });

  // 14. Diagrams (Mermaid), ASCII directory trees, diffs, Carousels, <think>, HTML entities
  await test('Diagrams, ASCII trees, diffs, carousels, <think> tags & HTML entities', () => {
    const mermaid = 'Overview:\n```mermaid\nflowchart TD\n  A --> B\n```\nNext step.';
    const mRes = processForSpeech(mermaid);
    assert(mRes.cleanText.includes('Mermaid flowchart omitted.'), `Mermaid summary: ${mRes.cleanText}`);

    const tree = 'Project layout:\n```\nantigravity-voice/\n├── hooks/\n└── sidecars/\n```';
    const tRes = processForSpeech(tree);
    assert(tRes.cleanText.includes('Directory tree with'), `ASCII tree detected: ${tRes.cleanText}`);

    const diff = '```diff\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n```';
    const dRes = processForSpeech(diff);
    assert(dRes.cleanText.includes('Code diff with 2 additions and 1 deletion.'), `Diff summary: ${dRes.cleanText}`);
    assert.strictEqual(dRes.segments[0].badge, 'DIFF');

    const noisy = '<think>internal reasoning</think><style>.x{color:red}</style><p>Rock &amp; Roll &rarr; Jazz</p>';
    const nRes = processForSpeech(noisy);
    assert(!nRes.cleanText.includes('internal reasoning'), '<think> block stripped');
    assert(!nRes.cleanText.includes('color:red'), '<style> block stripped');
    assert(nRes.cleanText.includes('Rock and Roll to Jazz'), `HTML entities decoded & normalized: ${nRes.cleanText}`);
  });

  // 15. Units, Keyboard shortcuts, Operators, UUIDs, Emojis & Custom Pronunciation Rules
  await test('Units, shortcuts, operators, UUID stripping, emojis & custom pronunciation/skip rules', () => {
    const input = 'Press Ctrl+Shift+P → Run (≥ 150ms, 80MB, 1920×1080) 🚀 in session 12345678-1234-4123-8123-123456789abc.';
    const res = processForSpeech(input);
    assert(res.cleanText.includes('Control plus Shift plus P'), `Shortcut normalized: ${res.cleanText}`);
    assert(res.cleanText.includes('greater than or equal to 150 milliseconds'), `Comparison & unit: ${res.cleanText}`);
    assert(res.cleanText.includes('80 megabytes'), `MB expanded: ${res.cleanText}`);
    assert(res.cleanText.includes('1920 by 1080'), `Dimensions expanded: ${res.cleanText}`);
    assert(!res.cleanText.includes('🚀'), 'Decorative emoji stripped');
    assert(!res.cleanText.includes('12345678'), 'UUID stripped');

    // Custom pronunciation + skip rules
    const customInput = 'DEBUG: internal trace\n\nDeploy with kubectl on Kokoro.';
    const cRes = processForSpeech(customInput, {
      customRules: 'kubectl => kube control\nKokoro => Koh-koh-roh\nskip: DEBUG:',
    });
    assert(!cRes.cleanText.includes('internal trace'), 'skip: rule omits matching block');
    assert(cRes.cleanText.includes('kube control'), 'Custom pronunciation applied');
    assert(cRes.cleanText.includes('Koh-koh-roh'), 'Second custom pronunciation applied');
  });

  // 16. Reading Profiles & Filter Stats Summary
  await test('All 4 Reading Profiles (balanced, full, prose, minimal) & filter stats', () => {
    assert.strictEqual(resolveFilterOptions({ profile: 'balanced' }).profile, 'balanced');
    assert.strictEqual(resolveFilterOptions({ profile: 'full' }).profile, 'full');
    assert.strictEqual(resolveFilterOptions({ profile: 'prose' }).profile, 'prose');
    assert.strictEqual(resolveFilterOptions({ profile: 'minimal' }).profile, 'minimal');
    assert.strictEqual(resolveFilterOptions({ profile: 'balanced', tables: 'skip' }).profile, 'custom');

    const richDoc = 'Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet a=1;\nlet b=2;\nlet c=3;\n```\n\nDone [1].';
    const proseRes = processForSpeech(richDoc, { profile: 'prose' });
    assert(!proseRes.cleanText.includes('Table') && !proseRes.cleanText.includes('JavaScript'), 'Prose Only skips tables & code');
    const summaryStr = formatFilterStatsSummary(proseRes.stats);
    assert(summaryStr.includes('1 table skipped') && summaryStr.includes('1 code block skipped'), `Stats summary: ${summaryStr}`);
    assert(Object.keys(OUTPUT_PROFILES).length === 4);
  });

  // 17. AudioQueueController expandable segment in-place expansion
  await test('AudioQueueController.expandSegmentAt expands summarized table in-place', () => {
    const q = new AudioQueueController();
    const rows = Array.from({ length: 7 }, (_, i) => `| K${i + 1} | V${i + 1} |`).join('\n');
    const res = processForSpeech(`Intro.\n\n| Key | Val |\n| - | - |\n${rows}\n\nOutro.`);
    assert.strictEqual(res.segments.length, 3, 'Intro + Table summary + Outro');

    q.currentTask = { id: 'test-1', sentences: [...res.segments], metadata: {} };
    q.totalSentences = res.segments.length;

    const expanded = q.expandSegmentAt(1, { autoPlay: false });
    assert.strictEqual(expanded, true);
    assert.strictEqual(q.currentTask.sentences.length, 10, 'Intro + (Table intro + 7 rows) + Outro = 10');
    assert(q.currentTask.sentences[2].spokenText.includes('K1: V1.'), 'Expanded row 1 in place');
    assert.strictEqual(q.currentTask.sentences[9].spokenText, 'Outro.');
  });

  // 18. Empty & boundary inputs + Client/Server parity
  await test('Empty/boundary inputs and server/client sanitizer parity', async () => {
    assert.strictEqual(sanitizeText(''), '');
    assert.strictEqual(sanitizeText(null), '');
    assert.strictEqual(chunkSentences('').length, 0);

    const clientSanitizer = await import('../sidecars/voice-panel/lib/sanitizer.js');
    const sample = 'Sample **bold** text with `snake_case` and https://antigravity.google.com [1].';
    assert.deepStrictEqual(processForSpeech(sample), clientSanitizer.processForSpeech(sample));
  });

  // 19. Classic-script Client Bundle Syntax & Zero-Collision VM Compilation Check
  await test('buildClientBundle compiles cleanly with zero module leaks or identifier collisions', () => {
    const bundle = buildClientBundle();
    assert(bundle.length > 10000, 'Bundle should contain full pipeline and UI controller');
    assert(!/^\s*import\s+/m.test(bundle), 'Bundle must not contain top-level import statements');
    assert(!/^\s*export\s+/m.test(bundle), 'Bundle must not contain top-level export statements');

    // Compile in Node vm.Script to verify zero SyntaxError / duplicate const/function collisions!
    assert.doesNotThrow(() => {
      new vm.Script(bundle, { filename: 'app.bundle.js' });
    }, 'Client classic-script IIFE bundle must parse with zero SyntaxErrors');
  });

  // 20. Lifecycle Hook JSONL & JSON Transcript Delivery
  await test('JSONL & JSON transcript parsing and lifecycle hook queue delivery', () => {
    const TEST_DIR = join(tmpdir(), `voice-test-${Date.now()}`);
    const TEMP_QUEUE_FILE = join(tmpdir(), 'antigravity-voice-queue.json');
    mkdirSync(TEST_DIR, { recursive: true });

    const sampleTranscriptPath = join(TEST_DIR, 'session.jsonl');
    const transcriptLines = [
      JSON.stringify({ role: 'user', content: 'What is our voice architecture?' }),
      JSON.stringify({
        role: 'model',
        parts: [{ text: 'We use Kokoro-82M over WebGPU with Web Audio API. Dr. Watson approved the design.' }],
      }),
    ];
    writeFileSync(sampleTranscriptPath, transcriptLines.join('\n'), 'utf8');

    execFileSync('node', ['hooks/notify-tts.mjs', sampleTranscriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert(existsSync(TEMP_QUEUE_FILE), 'Queue file should be created');
    const queue = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
    const lastItem = queue[queue.length - 1];
    assert.strictEqual(lastItem.source, 'hook');
    assert(lastItem.text.includes('Kokoro-82M over WebGPU'), 'Text contains assistant message');
    assert(lastItem.rawText.includes('Dr. Watson'), 'rawText preserved for live re-filtering');
    const watsonSentence = lastItem.sentences.find((s) => s.includes('Dr. Watson'));
    assert(watsonSentence && watsonSentence.includes('approved'), 'Dr. Watson abbreviation preserved');

    // Also test standard JSON transcript
    const jsonTranscriptPath = join(TEST_DIR, 'transcript.json');
    writeFileSync(
      jsonTranscriptPath,
      JSON.stringify({
        messages: [
          { role: 'user', content: 'Where is the documentation?' },
          { role: 'assistant', content: 'Check https://example.com/docs for guidance.' },
        ],
      }),
      'utf8'
    );

    execFileSync('node', ['hooks/notify-tts.mjs', jsonTranscriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    const queue2 = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
    const lastItem2 = queue2[queue2.length - 1];
    assert(lastItem2.text.includes('Check a link to example.com for guidance.'), 'URL sanitized to domain reference');

    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  console.log(`\nAll ${passed} test suites passed successfully!`);
}

runTests();
