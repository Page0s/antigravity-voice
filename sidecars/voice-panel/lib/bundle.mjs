/**
 * Classic-Script Client Bundle Builder
 * Strips local ES module import/export syntax and concatenates client files
 * in dependency order into a single classic IIFE for Electron `plugin://` compatibility.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_ROOT = join(HERE, '..');

export const CLIENT_BUNDLE_FILES = [
  'lib/pipeline/presets.js',
  'lib/pipeline/math-reader.js',
  'lib/pipeline/inline-normalizer.js',
  'lib/pipeline/table-reader.js',
  'lib/pipeline/code-handler.js',
  'lib/pipeline/block-parser.js',
  'lib/pipeline/chunker.js',
  'lib/sanitizer.js',
  'lib/kokoro-tts.js',
  'lib/audio-queue.js',
  'app.js',
];

export function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s+[\s\S]*?from\s+['"]\.{1,2}\/[^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[\s\S]*?\}(?:\s*from\s*['"][^'"]+['"])?;?\s*$/gm, '')
    .replace(/^\s*export\s+(class|function|const|let|var)\s+/gm, '$1 ');
}

export function buildClientBundle(baseDir = PANEL_ROOT) {
  const parts = CLIENT_BUNDLE_FILES.map((relPath) => {
    const raw = readFileSync(join(baseDir, relPath), 'utf8');
    return `// --- ${relPath} ---\n${stripModuleSyntax(raw)}`;
  });

  return `(function() {\n'use strict';\n${parts.join('\n\n')}\n})();\n`;
}
