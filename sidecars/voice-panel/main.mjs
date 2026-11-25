/**
 * Antigravity Voice Sidecar Server
 * Built with Sidecar SDK.
 * Serves the Aux Pane web UI, manages speech events queue, settings, and history.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { buildClientBundle } from './lib/bundle.mjs';
import { getInstalledVoices, synthesizeWav, speakDirect } from './lib/native-tts.js';
import { DEFAULT_FILTER_OPTIONS, resolveFilterOptions } from './lib/pipeline/presets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const TEMP_SERVER_FILE = join(tmpdir(), 'antigravity-voice-server.json');
const TEMP_QUEUE_FILE = join(tmpdir(), 'antigravity-voice-queue.json');

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const STARTED_AT = Date.now();

// Default settings
const DEFAULT_SETTINGS = {
  autoSpeak: true,
  engine: 'kokoro', // 'kokoro' (WebGPU/WASM) or 'webspeech' (Native)
  kokoroVoice: 'af_sky',
  webSpeechVoice: '',
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  skipCodeBlocks: false,
  stripUrls: true,
  transcriptView: 'readable', // 'readable' | 'spoken'
  outputFilters: { ...DEFAULT_FILTER_OPTIONS },
  streamingSentenceChunks: true,
  idleUnloadMinutes: 10,
  collapsedCards: [],
};

// In-memory queues & history
let speechQueue = [];
let speechHistory = [];
let settings = { ...DEFAULT_SETTINGS };

// Ensure sidecar environment variables have fallbacks for dev/test execution
if (!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '4545';
}
if (!process.env.ANTIGRAVITY_LS_ADDRESS) {
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:0';
}
if (!process.env.ANTIGRAVITY_CSRF_TOKEN) {
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'voice-sidecar-csrf-token';
}

mkdirSync(DATA_DIR, { recursive: true });
loadPersistedState();

const app = new SidecarApp();

// ---------------------------------------------------------------------------
// Static Files & Classic Script Bundler
// ---------------------------------------------------------------------------
const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => buildClientBundle(HERE));
app.page('/lib/sanitizer.js', () => readLocal('lib/sanitizer.js'));
app.page('/lib/audio-queue.js', () => readLocal('lib/audio-queue.js'));
app.page('/lib/kokoro-tts.js', () => readLocal('lib/kokoro-tts.js'));

app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// GET /api/status - Heartbeat and runtime metadata
app.api('/api/status', () => ({
  status: 'online',
  node: process.version,
  platform: `${platform()} ${release()}`,
  uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  queueLength: speechQueue.length,
  historyCount: speechHistory.length,
}), 'GET');

// GET /api/voices - Installed native system TTS voices
app.api('/api/voices', async () => {
  const voices = await getInstalledVoices();
  return { voices };
}, 'GET');

// GET /api/settings - User preferences
app.api('/api/settings', () => settings, 'GET');

// POST /api/settings - Update preferences
app.api('/api/settings', (data) => {
  const incoming = data && typeof data === 'object' ? data : {};
  const mergedFilters = incoming.outputFilters
    ? resolveFilterOptions({ ...settings.outputFilters, ...incoming.outputFilters })
    : settings.outputFilters;
  settings = {
    ...settings,
    ...incoming,
    outputFilters: mergedFilters,
  };
  saveSettings();
  return { success: true, settings };
});

// GET /api/queue - Poll for pending speech requests
app.api('/api/queue', (data) => {
  // Merge any items written to the temp queue by the lifecycle hook
  checkTempQueue();

  const reqConvId = String(data?.conversationId || '').trim();
  const now = Date.now();

  const matching = speechQueue.filter((item) => {
    if (!item.conversationId || !reqConvId) return true;
    if (item.conversationId === reqConvId) return true;
    // Fallback: if an item hasn't been claimed by its target conversation after 3s, allow any active pane to claim it
    return now - (item.timestamp || 0) > 3000;
  });

  return { queue: matching };
}, 'GET');

// POST /api/queue/ack - Acknowledge items processed by the UI
app.api('/api/queue/ack', (data) => {
  const ids = Array.isArray(data.ids) ? data.ids : (data.id ? [data.id] : []);
  if (ids.length > 0) {
    const idSet = new Set(ids);
    speechQueue = speechQueue.filter((item) => !idSet.has(item.id));
  }
  return { success: true, remaining: speechQueue.length };
});

// POST /api/speak - Enqueue new speech item (from hook or frontend manual test)
app.api('/api/speak', (data) => {
  const text = String(data.text || data.cleanText || data.rawText || '').trim();
  if (!text) {
    return { error: 'No text provided' };
  }

  const item = {
    id: data.id || `speech-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    conversationId: data.conversationId || '',
    text,
    rawText: data.rawText || text,
    cleanText: data.cleanText || text,
    sentences: Array.isArray(data.sentences) && data.sentences.length > 0 ? data.sentences : [],
    source: data.source || 'api',
    timestamp: data.timestamp || Date.now(),
    status: 'pending',
  };

  if (!data.historyOnly) {
    speechQueue.push(item);
  }
  addToHistory(item);

  return { success: true, item };
});

// GET /api/history - Retrieve speech history
app.api('/api/history', () => ({ history: speechHistory.slice(-30).reverse() }), 'GET');

// POST /api/clear-history - Clear recent history
app.api('/api/clear-history', () => {
  speechHistory = [];
  saveHistory();
  return { success: true };
});

// POST /api/delete-history-item - Delete a single history entry by id
app.api('/api/delete-history-item', (data) => {
  const id = String(data?.id || '').trim();
  if (!id) {
    return { error: 'No history item id provided' };
  }
  const before = speechHistory.length;
  speechHistory = speechHistory.filter((item) => item.id !== id);
  if (speechHistory.length !== before) {
    saveHistory();
  }
  return { success: true, remaining: speechHistory.length };
});

// GET /api/conversations - List available conversations from ~/.gemini/antigravity/brain
app.api('/api/conversations', (data) => {
  const activeId = String(data?.conversationId || '').trim();
  return {
    activeConversationId: activeId,
    conversations: listAvailableConversations(activeId),
  };
}, 'GET');

// GET /api/conversation-turns - Retrieve assistant turns and Markdown artifacts for a conversation
app.api('/api/conversation-turns', (data) => {
  const convId = String(data?.conversationId || '').trim();
  if (!convId || !/^[\w-]+$/.test(convId)) {
    return { error: 'Invalid or missing conversationId', turns: [], artifacts: [] };
  }
  return loadConversationTurnsAndArtifacts(convId);
}, 'GET');

// GET /api/synthesize - Generates WAV speech audio for Web Audio API playback
app.api('/api/synthesize', async (data) => {
  const text = String(data.text || '').trim();
  if (!text) {
    return new Response(Buffer.alloc(0), { contentType: 'audio/wav', status: 400 });
  }
  try {
    const wavBuffer = await synthesizeWav(text, {
      rate: Number(data.rate) || 1.0,
      voice: data.voice || '',
    });
    return new Response(wavBuffer, { contentType: 'audio/wav', headers: { 'Cache-Control': 'no-cache' } });
  } catch (err) {
    console.error('Synthesis error:', err);
    return new Response(Buffer.alloc(0), { contentType: 'audio/wav', status: 500 });
  }
}, 'GET');

// POST /api/synthesize - Generates WAV speech audio
app.api('/api/synthesize', async (data) => {
  const text = String(data.text || '').trim();
  if (!text) {
    return { error: 'No text provided' };
  }
  try {
    const wavBuffer = await synthesizeWav(text, {
      rate: Number(data.rate) || 1.0,
      voice: data.voice || '',
    });
    return new Response(wavBuffer, { contentType: 'audio/wav' });
  } catch (err) {
    return { error: err.message };
  }
});

// POST & GET /api/speak-direct - Speaks text directly through system speakers as fallback
app.api('/api/speak-direct', (data) => {
  const text = String(data.text || '').trim();
  if (text) {
    speakDirect(text, { rate: Number(data.rate) || 1.0, voice: data.voice || '' });
  }
  return { success: true };
}, 'GET');

app.api('/api/speak-direct', (data) => {
  const text = String(data.text || '').trim();
  if (text) {
    speakDirect(text, { rate: Number(data.rate) || 1.0, voice: data.voice || '' });
  }
  return { success: true };
}, 'POST');

// ---------------------------------------------------------------------------
// Helpers & State Persistence
// ---------------------------------------------------------------------------

function loadPersistedState() {
  if (existsSync(SETTINGS_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      const migratedFilters = saved.outputFilters
        ? resolveFilterOptions(saved.outputFilters)
        : resolveFilterOptions({
            skipCodeBlocks: saved.skipCodeBlocks,
            stripUrls: saved.stripUrls,
          });
      settings = {
        ...DEFAULT_SETTINGS,
        ...saved,
        outputFilters: migratedFilters,
      };
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  if (existsSync(HISTORY_FILE)) {
    try {
      speechHistory = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(speechHistory)) speechHistory = [];
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }

  checkTempQueue();
}

function checkTempQueue() {
  if (existsSync(TEMP_QUEUE_FILE)) {
    try {
      const items = JSON.parse(readFileSync(TEMP_QUEUE_FILE, 'utf8'));
      if (Array.isArray(items) && items.length > 0) {
        const existingIds = new Set(speechQueue.map((q) => q.id));
        for (const it of items) {
          if (!existingIds.has(it.id)) {
            const normalized = {
              ...it,
              text: String(it.text || it.cleanText || it.rawText || '').trim(),
              rawText: it.rawText || it.text || '',
              cleanText: it.cleanText || it.text || '',
            };
            speechQueue.push(normalized);
            addToHistory(normalized);
          }
        }
        // Clear temp queue
        writeFileSync(TEMP_QUEUE_FILE, JSON.stringify([], null, 2), 'utf8');
      }
    } catch {
      // Ignore
    }
  }
}

function saveSettings() {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function addToHistory(item) {
  const text = String(item.text || item.cleanText || item.rawText || '').trim();
  const rawText = String(item.rawText || text).trim();
  if (!text) return;
  if (speechHistory.some((h) => h.id === item.id)) return;
  speechHistory.push({
    id: item.id,
    text,
    rawText,
    source: item.source || 'unknown',
    timestamp: item.timestamp || Date.now(),
  });
  if (speechHistory.length > 50) {
    speechHistory = speechHistory.slice(-50);
  }
  saveHistory();
}

function saveHistory() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(speechHistory, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save history:', e);
  }
}

function extractCleanPrompt(raw) {
  const str = String(raw || '');
  const match = str.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return str
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function listAvailableConversations(activeId = '') {
  if (!existsSync(BRAIN_DIR)) return [];

  try {
    const entries = readdirSync(BRAIN_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[\w-]+$/.test(d.name));

    const candidates = [];

    for (const dir of entries) {
      const convDir = join(BRAIN_DIR, dir.name);
      const transcriptPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
      const hasTranscript = existsSync(transcriptPath);

      let mdFiles = [];
      try {
        mdFiles = readdirSync(convDir).filter(
          (f) => f.endsWith('.md') && !f.includes('.resolved')
        );
      } catch {}

      if (!hasTranscript && mdFiles.length === 0 && dir.name !== activeId) {
        continue;
      }

      let updatedAt = 0;
      try {
        const st = statSync(hasTranscript ? transcriptPath : convDir);
        updatedAt = st.mtimeMs;
      } catch {}

      candidates.push({
        id: dir.name,
        hasTranscript,
        transcriptPath,
        mdFiles,
        updatedAt,
        isCurrent: dir.name === activeId,
      });
    }

    candidates.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return b.updatedAt - a.updatedAt;
    });

    return candidates.slice(0, 25).map((c) => {
      let title = '';
      if (c.hasTranscript) {
        try {
          const head = readFileSync(c.transcriptPath, 'utf8').slice(0, 16384);
          const firstLines = head.split(/\r?\n/);
          for (const line of firstLines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'USER_INPUT' && obj.content) {
                const prompt = extractCleanPrompt(obj.content).replace(/\s+/g, ' ');
                if (prompt) {
                  title = prompt.slice(0, 65) + (prompt.length > 65 ? '…' : '');
                  break;
                }
              }
            } catch {}
          }
        } catch {}
      }

      if (!title && c.mdFiles.length > 0) {
        title = `Artifacts (${c.mdFiles.join(', ').slice(0, 45)})`;
      }
      if (!title) {
        title = `Conversation ${c.id.slice(0, 8)}`;
      }

      return {
        id: c.id,
        title,
        updatedAt: c.updatedAt,
        isCurrent: c.isCurrent,
        artifactCount: c.mdFiles.length,
      };
    });
  } catch (err) {
    console.error('Failed to list conversations:', err);
    return [];
  }
}

function loadConversationTurnsAndArtifacts(conversationId) {
  const convDir = join(BRAIN_DIR, conversationId);
  if (!existsSync(convDir)) {
    return { conversationId, turns: [], artifacts: [] };
  }

  const transcriptPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
  const fullTranscriptPath = join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');

  const turns = [];
  let fullLines = null;

  if (existsSync(transcriptPath)) {
    try {
      const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
      let lastUserPrompt = '';

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();
        if (!line) continue;

        let step;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }

        if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
          const cleanPrompt = extractCleanPrompt(step.content || '');
          if (cleanPrompt) {
            lastUserPrompt = cleanPrompt;
          }
          continue;
        }

        if (step.type === 'PLANNER_RESPONSE' && String(step.content || '').trim().length > 0) {
          let fullText = String(step.content || '').trim();

          if (
            Array.isArray(step.truncated_fields) &&
            step.truncated_fields.includes('content') &&
            existsSync(fullTranscriptPath)
          ) {
            try {
              if (!fullLines) {
                fullLines = readFileSync(fullTranscriptPath, 'utf8').split(/\r?\n/);
              }
              if (fullLines[idx]) {
                const fullStep = JSON.parse(fullLines[idx]);
                if (fullStep && fullStep.content) {
                  fullText = String(fullStep.content).trim();
                }
              }
            } catch {}
          }

          if (fullText) {
            turns.push({
              id: `turn-${conversationId}-${step.step_index ?? idx}`,
              type: 'turn',
              turnNumber: turns.length + 1,
              stepIndex: step.step_index ?? idx,
              prompt: lastUserPrompt,
              text: fullText,
              timestamp: step.created_at ? new Date(step.created_at).getTime() : Date.now(),
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to parse transcript turns:', err);
    }
  }

  const artifacts = [];
  try {
    const files = readdirSync(convDir).filter(
      (f) => f.endsWith('.md') && !f.includes('.resolved')
    );
    for (const file of files) {
      try {
        const fullPath = join(convDir, file);
        const st = statSync(fullPath);
        const content = readFileSync(fullPath, 'utf8').trim();
        if (content) {
          artifacts.push({
            id: `artifact-${conversationId}-${file}`,
            type: 'artifact',
            title: file,
            prompt: `Artifact: ${file}`,
            text: content,
            timestamp: st.mtimeMs,
          });
        }
      } catch {}
    }
  } catch {}

  return {
    conversationId,
    turns: turns.reverse(), // Newest turns first
    artifacts,
  };
}

function publishServerInfo() {
  const port = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  const info = {
    port: port ? Number(port) : null,
    token,
    pid: process.pid,
    startedAt: STARTED_AT,
  };

  try {
    writeFileSync(TEMP_SERVER_FILE, JSON.stringify(info, null, 2), 'utf8');
    writeFileSync(join(DATA_DIR, 'server.json'), JSON.stringify(info, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write server info:', err);
  }
}

// Write server info on start
publishServerInfo();

// Clean up server info on exit
process.on('exit', () => {
  try {
    if (existsSync(TEMP_SERVER_FILE)) unlinkSync(TEMP_SERVER_FILE);
  } catch {}
});

app.run();
