/**
 * Lifecycle Hook Handler: notify-tts.mjs
 * Triggered by Antigravity on PostInvocation or Stop events.
 * Extracts the latest assistant response from transcript, cleans it,
 * and notifies the Voice Sidecar via HTTP and queue persistence.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processForSpeech } from './sanitizer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..');
const TEMP_SERVER_FILE = join(tmpdir(), 'antigravity-voice-server.json');
const TEMP_QUEUE_FILE = join(tmpdir(), 'antigravity-voice-queue.json');

async function main() {
  let hookOutput = { decision: 'allow' };
  try {
    // 1. Read input from stdin or argv
    const inputPayload = await readInput();
    const { transcriptPath, conversationId, isPostInvocation } = parseHookInput(inputPayload);
    if (isPostInvocation) {
      hookOutput = { injectSteps: [] };
    }

    if (transcriptPath && existsSync(transcriptPath)) {
      // 2. Read and extract the assistant's final response from the current turn
      const extracted = extractLastAssistantMessage(transcriptPath);
      const lastResponseText = extracted?.text || '';
      const stepIndex = extracted?.stepIndex ?? null;

      if (lastResponseText && lastResponseText.trim()) {
        // 3. Sanitize markdown and chunk into streaming sentences using unified v2.1 pipeline
        const processed = processForSpeech(lastResponseText);
        const cleanText = processed.cleanText;
        if (cleanText) {
          // Check deduplication (prevent duplicate triggers for the same step or rapid repeats)
          const LAST_SENT_FILE = join(tmpdir(), 'antigravity-voice-last-sent.json');
          try {
            if (existsSync(LAST_SENT_FILE)) {
              const last = JSON.parse(readFileSync(LAST_SENT_FILE, 'utf8'));
              const sameTranscript = last.transcriptPath === transcriptPath;
              const sameStep = stepIndex !== null && last.stepIndex === stepIndex;
              const sameTextRecent = last.text === cleanText && Date.now() - last.timestamp < 60000;
              if (sameTranscript && (sameStep || sameTextRecent)) {
                return;
              }
            }
          } catch {}

          const sentences = processed.segments.map((seg) => seg.spokenText);
          const speechItem = {
            id: `speech-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            conversationId: conversationId || '',
            stepIndex,
            text: cleanText,
            cleanText,
            rawText: lastResponseText,
            sentences,
            source: 'hook',
            timestamp: Date.now(),
            status: 'pending',
          };

          try {
            writeFileSync(
              LAST_SENT_FILE,
              JSON.stringify({ text: cleanText, transcriptPath, stepIndex, timestamp: Date.now() }),
              'utf8'
            );
          } catch {}

          // 4. Save to persistent queue for resilient delivery
          enqueueMessage(speechItem);

          // 5. Attempt direct HTTP delivery to active sidecar server
          const serverInfo = findActiveServer();
          if (serverInfo && serverInfo.port) {
            await sendToSidecar(serverInfo.port, speechItem, serverInfo.token);
          } else {
            console.error('[antigravity-voice hook] Sidecar offline, enqueued speech item.');
          }
        }
      } else {
        console.error('[antigravity-voice hook] No assistant message found in current turn.');
      }
    } else {
      console.error(`[antigravity-voice hook] Invalid or missing transcript path: ${transcriptPath}`);
    }
  } catch (err) {
    console.error(`[antigravity-voice hook] Error: ${err.message}`);
  } finally {
    // Satisfy Antigravity hook stdout protojson contract (Stop vs PostInvocation)
    process.stdout.write(JSON.stringify(hookOutput));
  }
}

/**
 * Reads full input from stdin or process.argv
 */
async function readInput() {
  if (process.argv[2]) {
    return process.argv[2];
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      return resolve('');
    }

    let data = '';
    const timer = setTimeout(() => {
      stdin.pause();
      resolve(data.trim());
    }, 400);

    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data.trim());
    });
    stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data.trim());
    });
  });
}

/**
 * Resolves transcriptPath, conversationId, and hook type from JSON or plaintext input
 */
function parseHookInput(rawInput) {
  if (!rawInput) {
    return { transcriptPath: null, conversationId: null, isPostInvocation: false };
  }

  try {
    const parsed = JSON.parse(rawInput);
    const transcriptPath =
      parsed.transcriptPath || parsed.transcript_path || parsed.transcript || parsed.path || null;
    const conversationId = parsed.conversationId || parsed.conversation_id || null;
    const isPostInvocation =
      parsed.invocationNum !== undefined && parsed.terminationReason === undefined;
    return { transcriptPath, conversationId, isPostInvocation };
  } catch {
    // Input is likely a raw path
  }

  const cleaned = rawInput.trim().replace(/^["']|["']$/g, '');
  if (existsSync(cleaned) || cleaned.endsWith('.jsonl') || cleaned.endsWith('.json')) {
    return { transcriptPath: cleaned, conversationId: null, isPostInvocation: false };
  }

  return { transcriptPath: null, conversationId: null, isPostInvocation: false };
}

/**
 * Parses JSONL or JSON transcript file to find the last assistant/model response text
 * in the current turn (stopping at the most recent user message boundary).
 */
function extractLastAssistantMessage(filePath) {
  const content = readFileSync(filePath, 'utf8');

  // Check if transcript_full.jsonl exists alongside transcript.jsonl for untruncated content
  const fullPath = filePath.replace(/transcript\.jsonl$/i, 'transcript_full.jsonl');
  let fullLines = null;

  // Case 1: JSONL (line delimited JSON - primary Antigravity format)
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      // Stop if we hit a user input step so we never repeat an older turn's response
      if (entry.source === 'USER_EXPLICIT' || entry.type === 'USER_INPUT') {
        break;
      }
      const role = String(entry.role || entry.speaker || entry.author || entry.message?.role || '').toLowerCase();
      if (role === 'user' || role === 'human') {
        break;
      }

      // Check Antigravity transcript format: source === 'MODEL' && type === 'PLANNER_RESPONSE'
      if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
        let targetEntry = entry;
        if (
          Array.isArray(entry.truncated_fields) &&
          entry.truncated_fields.includes('content') &&
          fullPath !== filePath &&
          existsSync(fullPath)
        ) {
          try {
            if (!fullLines) {
              fullLines = readFileSync(fullPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            }
            const fullCandidate = fullLines[i] ? JSON.parse(fullLines[i]) : null;
            if (fullCandidate && fullCandidate.step_index === entry.step_index) {
              targetEntry = fullCandidate;
            }
          } catch {}
        }

        const text = extractTextFromEntry(targetEntry);
        if (text && text.trim()) {
          return { text, stepIndex: targetEntry.step_index ?? i };
        }
      }

      // Check legacy / standard role formats
      if (role === 'assistant' || role === 'model' || role === 'ai') {
        const text = extractTextFromEntry(entry);
        if (text && text.trim()) {
          return { text, stepIndex: entry.step_index ?? i };
        }
      }
    } catch {
      // Continue searching
    }
  }

  // Case 2: Full JSON array or object
  try {
    const data = JSON.parse(content);
    const messages = Array.isArray(data) ? data : (data.messages || data.turns || []);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.source === 'USER_EXPLICIT' || msg.type === 'USER_INPUT') {
        break;
      }
      const role = String(msg.role || msg.speaker || msg.author || msg.message?.role || '').toLowerCase();
      if (role === 'user' || role === 'human') {
        break;
      }
      if (msg.source === 'MODEL' && msg.type === 'PLANNER_RESPONSE') {
        const text = extractTextFromEntry(msg);
        if (text && text.trim()) return { text, stepIndex: msg.step_index ?? i };
      }
      if (role === 'assistant' || role === 'model' || role === 'ai') {
        const text = extractTextFromEntry(msg);
        if (text && text.trim()) return { text, stepIndex: msg.step_index ?? i };
      }
    }
  } catch {
    // Ignore JSON parse error
  }

  return null;
}

/**
 * Extracts raw string text from message structure
 */
function extractTextFromEntry(entry) {
  if (!entry) return '';
  if (entry.message && typeof entry.message === 'object') {
    return extractTextFromEntry(entry.message);
  }
  if (typeof entry.content === 'string') {
    return entry.content;
  }
  if (typeof entry.text === 'string') {
    return entry.text;
  }
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(entry.parts)) {
    return entry.parts
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (entry.response && typeof entry.response === 'string') {
    return entry.response;
  }
  return '';
}

/**
 * Discovers the active sidecar server info
 */
function findActiveServer() {
  const possiblePaths = [
    TEMP_SERVER_FILE,
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
      ? join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'server.json')
      : null,
    join(ROOT_DIR, 'sidecars', 'voice-panel', '.data', 'server.json'),
    join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-voice', 'voice-panel', 'data', 'server.json'),
  ].filter(Boolean);

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      try {
        const info = JSON.parse(readFileSync(path, 'utf8'));
        if (info.port) return info;
      } catch {
        // Continue searching
      }
    }
  }
  return null;
}

/**
 * Appends a speech item to the persistent queue file
 */
function enqueueMessage(item) {
  try {
    let queue = [];
    if (existsSync(TEMP_QUEUE_FILE)) {
      try {
        queue = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
        if (!Array.isArray(queue)) queue = [];
      } catch {
        queue = [];
      }
    }
    queue.push(item);
    if (queue.length > 20) queue = queue.slice(queue.length - 20);
    writeFileSync(TEMP_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (err) {
    console.error(`[antigravity-voice hook] Failed to enqueue message: ${err.message}`);
  }
}

/**
 * Sends speech item to the sidecar server via HTTP POST with auth token
 */
function sendToSidecar(port, item, token) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(item);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };
    if (token) {
      headers['x-sidecar-token'] = token;
    }

    const path = token ? `/api/speak?token=${encodeURIComponent(token)}` : '/api/speak';

    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on('error', (err) => {
      console.error(`[antigravity-voice hook] Could not reach sidecar: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

main();
