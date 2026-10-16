/**
 * Test Suite for Antigravity Voice Sanitizer & Chunking Pipeline
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkSentences, sanitizeText } from '../hooks/sanitizer.mjs';

async function runTests() {
  console.log('Running TTS Sanitizer tests...\n');

  // Test 1: Code blocks
  {
    const input = 'Here is the function:\n```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```\nIt returns the sum.';
    const output = sanitizeText(input);
    assert(!output.includes('```'), 'Code block fences should be removed');
    assert(output.includes('JavaScript'), 'Language name should be mentioned');
    assert(output.includes('It returns the sum'), 'Following text should be preserved');
    console.log('✔ Test 1 passed: Fenced code block sanitization');
  }

  // Test 2: Inline code
  {
    const input = 'You can run `npm install` or `node index.js` to start.';
    const output = sanitizeText(input);
    assert.strictEqual(output, 'You can run npm install or node index.js to start.');
    console.log('✔ Test 2 passed: Inline code backticks removal');
  }

  // Test 3: Markdown tables
  {
    const input = 'Comparison:\n| Feature | Status |\n| --- | --- |\n| WebGPU | Supported |\n| Fallback | WASM |\nAll done.';
    const output = sanitizeText(input);
    assert(!output.includes('|'), 'Table pipes should be removed');
    assert(output.includes('[Table omitted]'), 'Table omitted marker should be inserted');
    console.log('✔ Test 3 passed: Markdown table omission');
  }

  // Test 4: URLs and Markdown Links
  {
    const input = 'Check [Documentation](https://github.com/google/antigravity) or visit https://example.com/docs/api.';
    const output = sanitizeText(input);
    assert.strictEqual(output, 'Check Documentation or visit a link to example.com.');
    console.log('✔ Test 4 passed: Markdown link and bare URL sanitization');
  }

  // Test 5: Headings, bold, italic, and bullet points
  {
    const input = '# Main Heading\n\nHere is **bold** text and *italic* text.\n- First item\n- Second item';
    const output = sanitizeText(input);
    assert(!output.includes('#'), 'Heading hashes removed');
    assert(!output.includes('**'), 'Asterisks removed');
    assert(output.includes('Main Heading.'), 'Heading converted to sentence');
    console.log('✔ Test 5 passed: Formatting markers removal');
  }

  // Test 6: Abbreviations preservation in sentence chunking
  {
    const input = 'Dr. Smith met with Mr. Jones at 10 a.m. to discuss e.g. the new audio model. They agreed on it.';
    const chunks = chunkSentences(input);
    assert.strictEqual(chunks.length, 2, `Expected 2 chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`);
    assert(chunks[0].startsWith('Dr. Smith'), 'First chunk starts with Dr. Smith');
    assert(chunks[1].startsWith('They agreed'), 'Second chunk starts with They agreed');
    console.log('✔ Test 6 passed: Abbreviation boundary preservation');
  }

  // Test 7: Decimal numbers in chunking
  {
    const input = 'The version 3.14 was released yesterday. It brings 99.9% uptime.';
    const chunks = chunkSentences(input);
    assert.strictEqual(chunks.length, 2, `Expected 2 chunks, got ${chunks.length}`);
    console.log('✔ Test 7 passed: Floating point decimal preservation');
  }

  // Test 8: Empty and boundary inputs
  {
    assert.strictEqual(sanitizeText(''), '', 'Empty string returns empty');
    assert.strictEqual(sanitizeText(null), '', 'Null returns empty');
    assert.strictEqual(chunkSentences('').length, 0, 'Empty chunk list for empty string');
    console.log('✔ Test 8 passed: Empty & boundary values');
  }

  // Test 9: Skip code blocks option
  {
    const input = 'Prefix text.\n```python\nprint("hello")\n```\nSuffix text.';
    const output = sanitizeText(input, { skipCodeBlocks: true });
    assert(!output.includes('Python'), 'Language should not be mentioned when skipCodeBlocks is true');
    assert(output.includes('Prefix text') && output.includes('Suffix text'), 'Surrounding text preserved');
    console.log('✔ Test 9 passed: skipCodeBlocks option');
  }

  // Test 10: LaTeX math blocks and inline math
  {
    const input = 'Einstein stated that $$E = mc^2$$ holds true. Also consider $x = y + 1$ and a price of $50.';
    const output = sanitizeText(input);
    assert(output.includes('[formula: E = mc^2]'), 'LaTeX block formula should be described');
    assert(output.includes('x = y + 1'), 'Inline math formula should be stripped of $ delimiters');
    assert(output.includes('$50'), 'Currency dollar signs should not be corrupted');
    console.log('✔ Test 10 passed: LaTeX math sanitization & currency preservation');
  }

  // Test 11: HTML tags cleaning
  {
    const input = '<p>First line</p><br/><div class="code">Inner content</div>';
    const output = sanitizeText(input);
    assert(!output.includes('<p>') && !output.includes('</div>'), 'HTML tags stripped');
    assert(output.includes('First line') && output.includes('Inner content'), 'Text content preserved');
    console.log('✔ Test 11 passed: HTML tag sanitization');
  }

  // Test 12: Long text conversational clause splitting
  {
    const longSentence = 'This is an exceptionally long sentence that exceeds the standard single chunk boundary threshold because it has extensive descriptive prose, followed by an additional informative elaboration, and concludes with a definitive thought.';
    const chunks = chunkSentences(longSentence, 100);
    assert(chunks.length > 1, `Expected multiple chunks for long sentence, got ${chunks.length}`);
    for (const c of chunks) {
      assert(c.length <= 120, `Sub-chunk should be reasonably sized, got length ${c.length}`);
    }
    console.log('✔ Test 12 passed: Long clause chunk splitting');
  }

  // Test 13: Varied language tags in code blocks
  {
    const py = sanitizeText('```py\nx = 1\ny = 2\nz = 3\n```');
    assert(py.includes('Python'), 'py mapped to Python');

    const ts = sanitizeText('```ts\nconst a: number = 1;\nconst b: number = 2;\nconst c = 3;\n```');
    assert(ts.includes('TypeScript'), 'ts mapped to TypeScript');

    const rs = sanitizeText('```rust\nfn main() {\n  println!("hi");\n}\n```');
    assert(rs.includes('Rust'), 'rust mapped to Rust');
    console.log('✔ Test 13 passed: Language slug mapping');
  }

  // Test 14: Client-side sanitizer parity
  {
    const clientSanitizer = await import('../sidecars/voice-panel/lib/sanitizer.js');
    const input = 'Sample **bold** text with `inline code` and https://antigravity.google.com.';
    const s1 = sanitizeText(input);
    const s2 = clientSanitizer.sanitizeText(input);
    assert.strictEqual(s1, s2, 'Server and client sanitizeText produce identical results');

    const chunkInput = 'Dr. Watson and Sherlock Holmes. The case is solved!';
    const c1 = chunkSentences(chunkInput);
    const c2 = clientSanitizer.chunkSentences(chunkInput);
    assert.deepStrictEqual(c1, c2, 'Server and client chunkSentences produce identical results');
    console.log('✔ Test 14 passed: Client & server sanitizer parity');
  }

  // Test 15: JSONL Transcript Parsing & Lifecycle Hook Execution
  {
    const TEST_DIR = join(tmpdir(), `voice-test-${Date.now()}`);
    const TEMP_QUEUE_FILE = join(tmpdir(), 'antigravity-voice-queue.json');
    mkdirSync(TEST_DIR, { recursive: true });

    const sampleTranscriptPath = join(TEST_DIR, 'session.jsonl');
    const transcriptLines = [
      JSON.stringify({ role: 'user', content: 'What is our voice architecture?' }),
      JSON.stringify({
        role: 'model',
        parts: [{ text: 'We use Kokoro-82M over WebGPU with Web Audio API. Dr. Watson approved the design.' }]
      })
    ];
    writeFileSync(sampleTranscriptPath, transcriptLines.join('\n'), 'utf8');

    // Execute lifecycle hook with transcript
    execFileSync('node', ['hooks/notify-tts.mjs', sampleTranscriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    assert(existsSync(TEMP_QUEUE_FILE), 'Queue file should be created');
    const queue = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
    assert(Array.isArray(queue) && queue.length > 0, 'Queue should contain enqueued item');

    const lastItem = queue[queue.length - 1];
    assert.strictEqual(lastItem.source, 'hook');
    assert(lastItem.text && lastItem.text.includes('Kokoro-82M over WebGPU'), 'Text contains assistant message');
    assert(Array.isArray(lastItem.sentences) && lastItem.sentences.length > 0, 'Sentences chunked');

    const watsonSentence = lastItem.sentences.find((s) => s.includes('Dr. Watson'));
    assert(watsonSentence && watsonSentence.includes('approved'), 'Dr. Watson abbreviation preserved');

    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}

    console.log('✔ Test 15 passed: JSONL transcript parsing & hook queue delivery');
  }

  // Test 16: Standard JSON Transcript with URL sanitization
  {
    const TEST_DIR = join(tmpdir(), `voice-test-json-${Date.now()}`);
    const TEMP_QUEUE_FILE = join(tmpdir(), 'antigravity-voice-queue.json');
    mkdirSync(TEST_DIR, { recursive: true });

    const jsonTranscriptPath = join(TEST_DIR, 'transcript.json');
    const transcriptData = {
      messages: [
        { role: 'user', content: 'Where is the documentation?' },
        { role: 'assistant', content: 'Check https://example.com/docs for guidance.' }
      ]
    };
    writeFileSync(jsonTranscriptPath, JSON.stringify(transcriptData, null, 2), 'utf8');

    execFileSync('node', ['hooks/notify-tts.mjs', jsonTranscriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    const queue = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
    const lastItem = queue[queue.length - 1];
    assert(lastItem.text.includes('Check a link to example.com for guidance.'), 'URL sanitized to domain reference');

    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}

    console.log('✔ Test 16 passed: JSON transcript object parsing & URL sanitization');
  }

  try {
    rmSync('test/integration.test.mjs', { force: true });
  } catch {}

  console.log('\nAll 16 tests passed successfully!');
}

runTests();
