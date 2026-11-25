/**
 * Antigravity Voice Panel - Main Frontend Controller
 * Coordinates UI, Web Audio API, Kokoro WebGPU Engine, and Sidecar IPC.
 */

import { AudioQueueController } from './lib/audio-queue.js';
import { KokoroEngine, KOKORO_VOICES } from './lib/kokoro-tts.js';
import {
  DEFAULT_FILTER_OPTIONS,
  OUTPUT_PROFILES,
  formatFilterStatsSummary,
  processForSpeech,
  resolveFilterOptions,
} from './lib/sanitizer.js';

const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

const THEME_STORAGE_KEY = 'antigravity-voice-theme-tokens';
const THEME_TOKEN_NAMES = [
  '--background',
  '--foreground',
  '--card',
  '--card-border',
  '--border',
  '--secondary',
  '--secondary-foreground',
  '--muted-foreground',
  '--primary',
  '--primary-foreground',
  '--accent',
];

function snapshotThemeTokens() {
  try {
    const style = getComputedStyle(document.documentElement);
    const snapshot = {};
    let count = 0;
    for (const name of THEME_TOKEN_NAMES) {
      const val = style.getPropertyValue(name).trim();
      if (val) {
        snapshot[name] = val;
        count++;
      }
    }
    if (count > 0) {
      sessionStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(snapshot));
    }
  } catch {}
}

function restoreThemeTokensIfMissing() {
  try {
    const rootStyle = document.documentElement.style;
    const computed = getComputedStyle(document.documentElement);
    // If the host didn't re-inject --background (e.g. after an iframe reload), restore saved tokens
    const currentBg = computed.getPropertyValue('--background').trim();
    const savedRaw = sessionStorage.getItem(THEME_STORAGE_KEY);
    if (!savedRaw) return;
    const saved = JSON.parse(savedRaw);
    const looksResetToLight = !currentBg || /^#?fff(?:fff)?$/i.test(currentBg) || /^rgb\(255,\s*255,\s*255\)$/i.test(currentBg);
    if (looksResetToLight && saved['--background'] && !/^#?fff(?:fff)?$/i.test(saved['--background'])) {
      for (const [k, v] of Object.entries(saved)) {
        if (v) rootStyle.setProperty(k, v);
      }
    }
  } catch {}
}

const SANDBOX_PRESETS = {
  greeting: 'Hello! Antigravity Voice v2.1 is online with smart output filtering and smooth natural speech.',
  table: `### TTS Engine Comparison

| Engine | Speed | Quality | Offline |
| :--- | :--- | :--- | :--- |
| Kokoro-82M | ~150ms | ✅ Studio | Yes |
| Native SAPI | Instant | Good | Yes |
| Cloud API | 400ms | Studio | ❌ No |`,
  symbols: `  - Semicolon (;) Skipped in Part 1: Part 1 stays strictly a–z + Space + Backspace, while the right pinky rests on its home anchor (; / Č / Ö).
  - Error Handling & Touch Backspace: Sub-drills 1–3 (new key intro) block on error so beginners don't look down for Backspace; press Ctrl+C → Copy & Save (≥ 150ms, 1920×1080).`,
  structured: `## Structured .md Guide

- **Heading Levels** (#–######, Setext ===/---) split cleanly without breaking flow.
  - Nested bullets and \`snake_case_vars\` stay readable and never mangle underscores.
- [x] Fix single-word orphan cuts so sentences like the toggle only changes whether the transcript box displays the cleaner visual symbols or the exact expanded words being sent to the voice engine stay intact.
- [ ] Switch to Room Listen mode to read every table across the room.

> [!WARNING] Breaking change in \`sidecars/voice-panel/lib/sanitizer.js\` — reload panel to apply.`,
  code: `Update \`idle_unload_minutes\` in \`sidecars/voice-panel/app.js\` and inspect the pipeline below:

\`\`\`typescript
export function processTurn(raw: string, profile: string) {
  const filters = resolveFilterOptions({ profile });
  const result = processForSpeech(raw, filters);
  if (result.segments.length === 0) {
    return null;
  }
  return result;
}
\`\`\`

Then run \`npm test\` to verify all checks pass.`,
  math: `Einstein showed that $$E = mc^2$$ and for averages we have $$\\frac{a^2 + b^2}{2} \\leq \\pi$$ while pricing stays at $50 [1][2].

See documentation at https://github.com/Page0s/antigravity-voice for setup details.`,
};

// ---------------------------------------------------------------------------
// State & Instances
// ---------------------------------------------------------------------------

const audioQueue = new AudioQueueController();
const kokoroEngine = new KokoroEngine();

let currentSettings = {
  autoSpeak: true,
  engine: 'kokoro',
  kokoroVoice: 'af_sky',
  webSpeechVoice: '',
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  skipCodeBlocks: false,
  stripUrls: true,
  transcriptView: 'readable', // 'readable' | 'spoken'
  outputFilters: { ...DEFAULT_FILTER_OPTIONS },
  idleUnloadMinutes: 10,
  collapsedCards: [],
};

let currentRawText = '';
let currentTaskId = '';
let currentFilterStats = null;
let customRulesDebounce = null;

let webSpeechVoices = [];
let nativeSystemVoices = [];
let isMuted = false;
let pollingInterval = null;
let idleCheckInterval = null;

// Whether this iframe belongs to an active conversation (or standalone browser window),
// as opposed to Antigravity's hidden prewarmed iframe which has no conversationId.
const isActiveInstance = Boolean(sidecar?.conversationId) || window.parent === window;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, { method = 'GET', body } = {}) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  try {
    const res = sidecar ? await sidecar.fetch(path, options) : await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  } catch (err) {
    console.warn(`API call ${path} failed:`, err.message);
    throw err;
  }
}

let toastTimer;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Canvas Visualizer
// ---------------------------------------------------------------------------

function setupVisualizer() {
  const canvas = $('visualizer-canvas');
  const ctx = canvas.getContext('2d');
  const bufferLen = 64;
  const freqData = new Uint8Array(bufferLen);
  const timeData = new Uint8Array(bufferLen);

  function draw() {
    requestAnimationFrame(draw);

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    audioQueue.getFrequencyData(freqData);
    audioQueue.getTimeDomainData(timeData);

    const isSpeaking = audioQueue.isProcessing && !audioQueue.isPaused;

    // Draw background subtle grid line
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!isSpeaking) {
      // Idle gentle sine wave
      const time = Date.now() / 1000;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x < width; x += 4) {
        const y = height / 2 + Math.sin(x * 0.05 + time * 2) * 3;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }

    // Active Frequency Spectrum Bars
    const barWidth = (width / bufferLen) * 2;
    let barX = 0;

    for (let i = 0; i < bufferLen; i++) {
      const v = freqData[i] / 255.0;
      const barHeight = Math.max(3, v * (height * 0.85));

      const grad = ctx.createLinearGradient(0, height, 0, height - barHeight);
      grad.addColorStop(0, '#6366f1');
      grad.addColorStop(0.7, '#8b5cf6');
      grad.addColorStop(1, '#ec4899');

      ctx.fillStyle = grad;
      ctx.fillRect(barX, (height - barHeight) / 2, barWidth - 1, barHeight);
      barX += barWidth;
    }
  }

  draw();
}

// ---------------------------------------------------------------------------
// Voice Population & Engine Selection
// ---------------------------------------------------------------------------

function updateVoiceDropdown() {
  const select = $('select-voice');
  select.innerHTML = '';

  const engine = currentSettings.engine;

  if (engine === 'kokoro') {
    KOKORO_VOICES.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name}`;
      if (v.id === currentSettings.kokoroVoice) opt.selected = true;
      select.appendChild(opt);
    });
  } else {
    // Web Speech / Native SAPI Voices
    if (webSpeechVoices.length === 0 && 'speechSynthesis' in window) {
      webSpeechVoices = window.speechSynthesis.getVoices();
    }

    const availableVoices = webSpeechVoices.length > 0 ? webSpeechVoices : nativeSystemVoices;

    if (availableVoices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Default System Voice';
      select.appendChild(opt);
    } else {
      availableVoices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = v.lang ? `${v.name} (${v.lang})` : v.name;
        if (v.name === currentSettings.webSpeechVoice) opt.selected = true;
        select.appendChild(opt);
      });
      if (!currentSettings.webSpeechVoice && availableVoices[0]) {
        currentSettings.webSpeechVoice = availableVoices[0].name;
      }
    }
  }
}

async function initWebSpeech() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => {
      webSpeechVoices = window.speechSynthesis.getVoices();
      if (currentSettings.engine === 'webspeech') {
        updateVoiceDropdown();
      }
    };
    webSpeechVoices = window.speechSynthesis.getVoices();
  }

  try {
    const data = await apiFetch('/api/voices');
    if (Array.isArray(data.voices) && data.voices.length > 0) {
      nativeSystemVoices = data.voices;
      if (currentSettings.engine === 'webspeech') {
        updateVoiceDropdown();
      }
    }
  } catch {}
}

function syncKokoroUI() {
  const statusEl = $('kokoro-model-status');
  const detailsEl = $('kokoro-details');
  const progressContainer = $('kokoro-progress-container');
  const btnLoad = $('btn-load-kokoro');
  const btnUnload = $('btn-unload-kokoro');

  if (!btnLoad) return;

  if (kokoroEngine.state === 'ready') {
    btnLoad.disabled = true;
    btnLoad.textContent = 'Model Loaded';
    if (btnUnload) {
      btnUnload.classList.remove('hidden');
      btnUnload.disabled = false;
    }
    if (progressContainer) progressContainer.classList.add('hidden');
    if (statusEl) statusEl.textContent = `Kokoro-82M: ${kokoroEngine.statusMessage}`;
    updateIdleCountdownHint();
  } else if (kokoroEngine.state === 'loading') {
    btnLoad.disabled = true;
    btnLoad.textContent = 'Loading...';
    if (btnUnload) btnUnload.classList.add('hidden');
  } else {
    btnLoad.disabled = false;
    btnLoad.textContent = kokoroEngine.state === 'error' ? 'Retry Load' : 'Load Model';
    if (btnUnload) btnUnload.classList.add('hidden');
    if (progressContainer) progressContainer.classList.add('hidden');
    if (statusEl) {
      statusEl.textContent = `Kokoro-82M: ${kokoroEngine.statusMessage || 'Ready to load'}`;
    }
    if (detailsEl && kokoroEngine.state !== 'error') {
      detailsEl.textContent = 'Model is unloaded from memory. Will auto-load from local cache when needed.';
    }
  }
}

function updateIdleCountdownHint() {
  const detailsEl = $('kokoro-details');
  if (!detailsEl || kokoroEngine.state !== 'ready') return;

  const timeoutMins = Number(currentSettings.idleUnloadMinutes ?? 10);
  const devLabel = (kokoroEngine.device || 'webgpu').toUpperCase();

  if (timeoutMins <= 0) {
    detailsEl.textContent = `Active in ${devLabel} memory — Auto-unload disabled.`;
    return;
  }

  if (audioQueue.isProcessing) {
    kokoroEngine.lastUsedAt = Date.now();
    detailsEl.textContent = `Active in ${devLabel} memory — Speaking (idle timer paused).`;
    return;
  }

  const elapsedMs = Date.now() - (kokoroEngine.lastUsedAt || Date.now());
  const remainingMs = Math.max(0, timeoutMins * 60 * 1000 - elapsedMs);
  const remMins = Math.floor(remainingMs / 60000);
  const remSecs = Math.floor((remainingMs % 60000) / 1000);

  detailsEl.textContent = `Active in ${devLabel} memory — Auto-unloads in ${remMins}m ${String(remSecs).padStart(2, '0')}s of inactivity.`;
}

async function checkKokoroIdleUnload() {
  if (kokoroEngine.state !== 'ready') return;

  if (audioQueue.isProcessing) {
    kokoroEngine.lastUsedAt = Date.now();
    updateIdleCountdownHint();
    return;
  }

  const timeoutMins = Number(currentSettings.idleUnloadMinutes ?? 10);
  if (timeoutMins <= 0) {
    updateIdleCountdownHint();
    return;
  }

  const limitMs = timeoutMins * 60 * 1000;
  const elapsedMs = Date.now() - (kokoroEngine.lastUsedAt || Date.now());

  if (elapsedMs >= limitMs) {
    await unloadKokoroModel({ reason: 'idle' });
  } else {
    updateIdleCountdownHint();
  }
}

function handleKokoroProgress({ progress, message, error }) {
  const statusEl = $('kokoro-model-status');
  const detailsEl = $('kokoro-details');
  const progressContainer = $('kokoro-progress-container');
  const progressFill = $('kokoro-progress-fill');

  if (statusEl && message) {
    statusEl.textContent = `Kokoro-82M: ${message}`;
  }
  if (progressFill && progress !== undefined) {
    progressFill.style.width = `${progress}%`;
  }
  if (progressContainer && progress > 0 && progress < 100) {
    progressContainer.classList.remove('hidden');
  }
  syncKokoroUI();
  if (error && detailsEl) {
    detailsEl.textContent = `Error: ${error}`;
  }
}

async function loadKokoroModel({ silent = false } = {}) {
  const progressContainer = $('kokoro-progress-container');
  const btn = $('btn-load-kokoro');

  btn.disabled = true;
  btn.textContent = 'Loading...';
  progressContainer.classList.remove('hidden');

  const success = await kokoroEngine.init(handleKokoroProgress);
  syncKokoroUI();

  if (success) {
    if (!silent) showToast('Kokoro-82M neural model ready!');
  } else {
    if (!silent) showToast('Kokoro failed to load. Using Native SAPI fallback.');
  }
}

async function unloadKokoroModel({ reason = 'manual' } = {}) {
  if (kokoroEngine.state === 'idle' && !kokoroEngine.tts) return;
  await kokoroEngine.unload();
  syncKokoroUI();
  if (reason === 'idle') {
    showToast(`Kokoro-82M auto-unloaded after ${currentSettings.idleUnloadMinutes}m of inactivity`);
  } else {
    showToast('Kokoro-82M model unloaded from memory');
  }
}

// ---------------------------------------------------------------------------
// Playback State Listener & Queue Coordinator
// ---------------------------------------------------------------------------

function getSegmentTextForView(seg) {
  if (typeof seg === 'string') return seg;
  if (!seg) return '';
  return currentSettings.transcriptView === 'spoken'
    ? seg.spokenText || seg.text || ''
    : seg.displayText || seg.spokenText || seg.text || '';
}

function getBadgeStyleClass(blockType, badge) {
  if (!badge) return '';
  if (blockType?.startsWith('table')) return 'badge-table';
  if (blockType?.startsWith('code')) return badge === 'DIFF' ? 'badge-diff' : 'badge-code';
  if (blockType === 'math') return 'badge-math';
  if (blockType === 'heading') return 'badge-heading';
  if (blockType === 'callout' || blockType === 'quote') return 'badge-callout';
  if (blockType === 'diagram') return 'badge-diagram';
  return '';
}

function updateFilterStatsUI(stats) {
  const bar = $('filter-stats-bar');
  if (!bar) return;
  currentFilterStats = stats || null;
  const summary = formatFilterStatsSummary(stats);
  if (summary) {
    bar.textContent = summary;
    bar.title = summary;
    bar.classList.remove('hidden');
  } else {
    bar.textContent = '';
    bar.classList.add('hidden');
  }
}

function syncTranscriptViewToggleUI() {
  const isSpoken = currentSettings.transcriptView === 'spoken';
  const btnReadable = $('btn-view-readable');
  const btnSpoken = $('btn-view-spoken');
  if (btnReadable) btnReadable.classList.toggle('active', !isSpoken);
  if (btnSpoken) btnSpoken.classList.toggle('active', isSpoken);
}

function renderTranscriptSegments(sentences = [], activeIndex = -1) {
  const container = $('transcript-segments');
  if (!container) return;

  if (!Array.isArray(sentences) || sentences.length === 0) {
    container.innerHTML =
      '<div class="transcript-placeholder">Speech text segments will appear here and highlight as they play. Click any segment to play from there.</div>';
    return;
  }

  container.innerHTML = '';
  sentences.forEach((seg, idx) => {
    const shownText = getSegmentTextForView(seg);
    const badge = typeof seg === 'object' ? seg.badge || '' : '';
    const blockType = typeof seg === 'object' ? seg.blockType || 'paragraph' : 'paragraph';
    const expandable = typeof seg === 'object' ? seg.expandable : null;

    const row = document.createElement('div');
    let cls = 'transcript-segment';
    if (idx === activeIndex) cls += ' active';
    else if (activeIndex >= 0 && idx < activeIndex) cls += ' spoken';
    row.className = cls;
    row.dataset.index = String(idx);
    row.title =
      currentSettings.transcriptView === 'readable' && typeof seg === 'object' && seg.spokenText !== seg.displayText
        ? `Click to play • Spoken as: ${seg.spokenText}`
        : 'Click to play from this segment';

    const badgeHtml = badge
      ? `<span class="segment-badge ${getBadgeStyleClass(blockType, badge)}">${escapeHtml(badge)}</span>`
      : '';
    const expandHtml =
      expandable && Array.isArray(expandable.segments) && expandable.segments.length > 0
        ? `<button type="button" class="btn-expand-segment" title="Expand and read full block aloud">${escapeHtml(expandable.label || 'Read full')} ▶</button>`
        : '';

    row.innerHTML = `
      <span class="segment-num">${idx + 1}.</span>
      ${badgeHtml}
      <span class="segment-body">${escapeHtml(shownText)}</span>
      ${expandHtml}
    `;

    const expandBtn = row.querySelector('.btn-expand-segment');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        refreshCurrentTaskMetadata();
        audioQueue.ensureAudioContext();
        if (audioQueue.expandSegmentAt(idx, { autoPlay: true })) {
          showToast(`Expanded: ${expandable.label || 'full content'}`);
        }
      });
    }

    row.addEventListener('click', () => {
      refreshCurrentTaskMetadata();
      audioQueue.ensureAudioContext();
      audioQueue.jumpToSentence(idx);
    });
    container.appendChild(row);
  });

  if (activeIndex >= 0) {
    const activeEl = container.querySelector(`.transcript-segment[data-index="${activeIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function highlightTranscriptSegment(activeIndex) {
  const container = $('transcript-segments');
  if (!container) return;
  const rows = container.querySelectorAll('.transcript-segment');
  rows.forEach((row) => {
    const idx = Number(row.dataset.index);
    row.classList.toggle('active', idx === activeIndex);
    row.classList.toggle('spoken', activeIndex >= 0 && idx < activeIndex);
    if (idx === activeIndex) {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

function updateRepeatButtonUI(mode) {
  const btn = $('btn-repeat');
  const label = $('label-repeat');
  if (!btn || !label) return;

  if (mode === 'segment') {
    label.textContent = 'Repeat: 1';
    btn.title = 'Repeat mode: Repeat current segment';
    btn.classList.add('btn-repeat-active');
  } else if (mode === 'all') {
    label.textContent = 'Repeat: All';
    btn.title = 'Repeat mode: Repeat all segments';
    btn.classList.add('btn-repeat-active');
  } else {
    label.textContent = 'Repeat: Off';
    btn.title = 'Repeat mode: Off';
    btn.classList.remove('btn-repeat-active');
  }
}

function setupAudioQueueListeners() {
  const badge = $('status-badge');
  const playLabel = $('label-play');
  const iconPlay = $('icon-play');
  const iconPause = $('icon-pause');
  const currentCaption = $('current-caption');
  const sentenceCounter = $('sentence-counter');

  audioQueue.onStateChange = (state) => {
    badge.className = `badge ${state}`;
    badge.textContent = state.charAt(0).toUpperCase() + state.slice(1);

    if (state === 'speaking') {
      playLabel.textContent = 'Pause';
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
    } else if (state === 'paused') {
      playLabel.textContent = 'Resume';
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    } else {
      playLabel.textContent = 'Play';
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    }
  };

  audioQueue.onTaskLoad = ({ sentences, activeIndex }) => {
    renderTranscriptSegments(sentences, activeIndex);
  };

  audioQueue.onProgress = ({ index, activeIndex, total, text, displayText, segment, sentences }) => {
    sentenceCounter.textContent = `${index} / ${total}`;
    const captionStr =
      currentSettings.transcriptView === 'spoken' ? text : displayText || getSegmentTextForView(segment) || text;
    currentCaption.textContent = captionStr;

    const container = $('transcript-segments');
    const existingCount = container ? container.querySelectorAll('.transcript-segment').length : 0;
    if (existingCount !== total && Array.isArray(sentences)) {
      renderTranscriptSegments(sentences, activeIndex);
    } else {
      highlightTranscriptSegment(activeIndex);
    }
  };

  audioQueue.onQueueEmpty = () => {
    const total = audioQueue.currentTask?.sentences?.length || 0;
    if (total > 0) {
      currentCaption.textContent = 'Finished — Click any segment or Play to repeat';
      sentenceCounter.textContent = `${total} / ${total}`;
      highlightTranscriptSegment(-1);
    } else {
      currentCaption.textContent = 'Idle — Waiting for speech...';
      sentenceCounter.textContent = '0 / 0';
    }
  };

  audioQueue.onRepeatModeChange = (mode) => {
    updateRepeatButtonUI(mode);
  };
}

// ---------------------------------------------------------------------------
// Background Queue Poller & Hook Sync
// ---------------------------------------------------------------------------

async function pollQueue() {
  if (!isActiveInstance || !currentSettings.autoSpeak) return;

  try {
    const convParam = sidecar?.conversationId
      ? `?conversationId=${encodeURIComponent(sidecar.conversationId)}`
      : '';
    const data = await apiFetch(`/api/queue${convParam}`);
    const items = data.queue || [];

    if (items.length > 0) {
      const ackIds = [];

      for (const item of items) {
        ackIds.push(item.id);

        const rawSource = item.rawText || item.text || '';
        const processed = processForSpeech(rawSource, currentSettings.outputFilters);

        if (processed.segments.length > 0) {
          currentRawText = rawSource;
          currentTaskId = item.id;
          updateFilterStatsUI(processed.stats);

          audioQueue.enqueue(processed.segments, {
            id: item.id,
            rawText: rawSource,
            engine: currentSettings.engine,
            kokoroInstance: kokoroEngine,
            kokoroVoice: currentSettings.kokoroVoice,
            webSpeechVoice: currentSettings.webSpeechVoice,
            rate: currentSettings.rate,
            pitch: currentSettings.pitch,
            onKokoroProgress: handleKokoroProgress,
          });

          addHistoryItemUI({
            id: item.id,
            text: processed.displayText || processed.cleanText,
            rawText: rawSource,
            source: item.source || 'hook',
            timestamp: item.timestamp || Date.now(),
          });
        }
      }

      // Acknowledge received items so they are removed from server queue
      if (ackIds.length > 0) {
        await apiFetch('/api/queue/ack', { method: 'POST', body: { ids: ackIds } });
        // Refresh the conversation turns list if viewing the current conversation
        const convSelect = $('select-conversation');
        if (convSelect && (!sidecar?.conversationId || convSelect.value === sidecar.conversationId)) {
          loadConversationTurns(convSelect.value, { preloadIfIdle: false });
        }
      }
    }
  } catch {
    // Ignore periodic polling errors
  }
}

// ---------------------------------------------------------------------------
// Conversation Turns & Artifacts Browser
// ---------------------------------------------------------------------------

function loadTurnIntoSegments(item, { autoPlay = false, silent = false } = {}) {
  const rawSource = item.rawText || item.text || '';
  const processed = processForSpeech(rawSource, currentSettings.outputFilters);
  const sentences = processed.segments;
  if (sentences.length === 0) {
    if (!silent) showToast('No speakable text with current filters');
    return;
  }

  currentRawText = rawSource;
  currentTaskId = item.id || `turn-${Date.now()}`;
  updateFilterStatsUI(processed.stats);

  const metadata = {
    id: currentTaskId,
    rawText: rawSource,
    engine: currentSettings.engine,
    kokoroInstance: kokoroEngine,
    kokoroVoice: currentSettings.kokoroVoice,
    webSpeechVoice: currentSettings.webSpeechVoice,
    rate: currentSettings.rate,
    pitch: currentSettings.pitch,
    onKokoroProgress: handleKokoroProgress,
  };

  if (autoPlay) {
    audioQueue.stop();
    audioQueue.ensureAudioContext();
    audioQueue.enqueue(sentences, metadata);
  } else {
    audioQueue.stop();
    audioQueue.currentTask = {
      id: metadata.id,
      sentences,
      metadata,
    };
    audioQueue.currentSentenceIndex = 0;
    audioQueue.totalSentences = sentences.length;
    renderTranscriptSegments(sentences, -1);
    $('sentence-counter').textContent = `0 / ${sentences.length}`;
    $('current-caption').textContent = `Loaded ${sentences.length} segments — Click Play or any segment`;
    if (!silent) showToast(`Loaded ${sentences.length} segments into reader`);
  }
}

function renderConversationTurnsUI(turns = [], artifacts = []) {
  const list = $('conversation-turns-list');
  if (!list) return;
  list.innerHTML = '';

  const combined = [...artifacts, ...turns];
  if (combined.length === 0) {
    list.innerHTML = '<div class="empty-state">No assistant turns found in this conversation yet.</div>';
    return;
  }

  combined.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'turn-item';

    const isArtifact = item.type === 'artifact';
    const badgeLabel = isArtifact ? `📄 ${item.title}` : `Turn #${item.turnNumber}`;
    const promptText = isArtifact
      ? 'Markdown Artifact'
      : item.prompt
        ? `Q: ${item.prompt.replace(/\s+/g, ' ')}`
        : 'Assistant Response';
    const previewText = String(item.text || '').replace(/\s+/g, ' ').slice(0, 140);

    row.title = 'Click to load segments into reader, or click ▶ to play immediately';
    row.innerHTML = `
      <div class="turn-info">
        <div class="turn-header-line">
          <span class="turn-badge ${isArtifact ? 'artifact' : ''}">${escapeHtml(badgeLabel)}</span>
          <span class="turn-prompt">${escapeHtml(promptText)}</span>
        </div>
        <div class="turn-preview">${escapeHtml(previewText)}</div>
      </div>
      <div class="history-actions">
        <button class="btn btn-sm btn-ghost btn-load-turn" title="Load segments below graph without playing">Load</button>
        <button class="btn btn-sm btn-ghost btn-play-turn" title="Play this response now">▶</button>
      </div>
    `;

    row.querySelector('.turn-info').addEventListener('click', () => {
      loadTurnIntoSegments(item, { autoPlay: false });
    });

    row.querySelector('.btn-load-turn').addEventListener('click', (e) => {
      e.stopPropagation();
      loadTurnIntoSegments(item, { autoPlay: false });
    });

    row.querySelector('.btn-play-turn').addEventListener('click', (e) => {
      e.stopPropagation();
      loadTurnIntoSegments(item, { autoPlay: true });
    });

    list.appendChild(row);
  });
}

async function loadConversationTurns(convId, { preloadIfIdle = true } = {}) {
  if (!convId) {
    renderConversationTurnsUI([], []);
    return;
  }

  try {
    const data = await apiFetch(`/api/conversation-turns?conversationId=${encodeURIComponent(convId)}`);
    const turns = data.turns || [];
    const artifacts = data.artifacts || [];
    renderConversationTurnsUI(turns, artifacts);

    // If no segments are loaded in the reader yet, preload the latest turn from this conversation
    if (preloadIfIdle && !audioQueue.currentTask && turns[0]?.text) {
      loadTurnIntoSegments(turns[0], { autoPlay: false });
    }
  } catch {
    const list = $('conversation-turns-list');
    if (list) {
      list.innerHTML = '<div class="empty-state">Unable to load conversation turns.</div>';
    }
  }
}

async function loadConversationsAndTurns() {
  const select = $('select-conversation');
  if (!select) return;

  try {
    const activeId = sidecar?.conversationId || '';
    const query = activeId ? `?conversationId=${encodeURIComponent(activeId)}` : '';
    const data = await apiFetch(`/api/conversations${query}`);
    const conversations = data.conversations || [];

    select.innerHTML = '';

    if (conversations.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No conversations found';
      select.appendChild(opt);
      renderConversationTurnsUI([], []);
      return;
    }

    conversations.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const dateStr = c.updatedAt
        ? new Date(c.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      const prefix = c.isCurrent ? '★ [Current Chat] ' : dateStr ? `[${dateStr}] ` : '';
      opt.textContent = `${prefix}${c.title}`;
      if (c.isCurrent) opt.selected = true;
      select.appendChild(opt);
    });

    const selectedConvId = select.value || conversations[0].id;
    await loadConversationTurns(selectedConvId, { preloadIfIdle: true });
  } catch {
    renderConversationTurnsUI([], []);
  }
}

// ---------------------------------------------------------------------------
// History Rendering
// ---------------------------------------------------------------------------

function addHistoryItemUI(item) {
  const list = $('history-list');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  // Avoid duplicate DOM rows if the same history item id already exists
  if (item.id) {
    const existing = list.querySelector(`[data-history-id="${CSS.escape(item.id)}"]`);
    if (existing) existing.remove();
  }

  const div = document.createElement('div');
  div.className = 'history-item';
  if (item.id) div.dataset.historyId = item.id;
  div.innerHTML = `
    <div class="history-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</div>
    <span class="history-time">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    <div class="history-actions">
      <button class="btn btn-sm btn-ghost btn-replay" title="Replay speech">▶</button>
      <button class="btn btn-sm btn-ghost btn-delete-item" title="Delete speech">✕</button>
    </div>
  `;

  div.querySelector('.btn-replay').addEventListener('click', () => {
    const rawSource = item.rawText || item.text || '';
    loadTurnIntoSegments({ id: item.id, rawText: rawSource, text: rawSource }, { autoPlay: true });
  });

  div.querySelector('.btn-delete-item').addEventListener('click', async () => {
    div.remove();
    if (!list.querySelector('.history-item')) {
      list.innerHTML = '<div class="empty-state">No speech history yet.</div>';
    }
    if (item.id) {
      await apiFetch('/api/delete-history-item', {
        method: 'POST',
        body: { id: item.id },
      }).catch(() => {});
    }
  });

  list.prepend(div);
}

async function loadHistory() {
  try {
    const data = await apiFetch('/api/history');
    const items = data.history || [];
    const list = $('history-list');
    list.innerHTML = '';

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state">No speech history yet.</div>';
      return;
    }

    // Server returns newest first; append in reverse so newest ends up on top via prepend
    [...items].reverse().forEach((it) => addHistoryItemUI(it));

    // Preload the most recent history entry's segments into the transcript reader if idle
    if (!audioQueue.currentTask && items[0]?.text) {
      const rawSource = items[0].rawText || items[0].text;
      const processed = processForSpeech(rawSource, currentSettings.outputFilters);
      if (processed.segments.length > 0) {
        currentRawText = rawSource;
        currentTaskId = items[0].id || `history-${Date.now()}`;
        updateFilterStatsUI(processed.stats);
        audioQueue.currentTask = {
          id: currentTaskId,
          sentences: processed.segments,
          metadata: {
            rawText: rawSource,
            engine: currentSettings.engine,
            kokoroInstance: kokoroEngine,
            kokoroVoice: currentSettings.kokoroVoice,
            webSpeechVoice: currentSettings.webSpeechVoice,
            rate: currentSettings.rate,
            pitch: currentSettings.pitch,
            onKokoroProgress: handleKokoroProgress,
          },
        };
        audioQueue.totalSentences = processed.segments.length;
        renderTranscriptSegments(processed.segments, -1);
        $('sentence-counter').textContent = `0 / ${processed.segments.length}`;
      }
    }
  } catch {}
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

// ---------------------------------------------------------------------------
// Settings Management
// ---------------------------------------------------------------------------

function updateCardSummaries() {
  const summaryControls = $('summary-controls');
  if (summaryControls) {
    const volPct = Math.round((currentSettings.volume ?? 1) * 100);
    summaryControls.textContent = isMuted ? 'Muted' : `Vol ${volPct}%`;
  }

  const summaryConfig = $('summary-config');
  if (summaryConfig) {
    if (currentSettings.engine === 'kokoro') {
      const voiceObj = KOKORO_VOICES.find((v) => v.id === currentSettings.kokoroVoice);
      const shortVoice = voiceObj ? voiceObj.name.split(' ')[0] : currentSettings.kokoroVoice;
      summaryConfig.textContent = `Kokoro • ${shortVoice} • ${currentSettings.rate}x`;
    } else {
      const shortSys = (currentSettings.webSpeechVoice || 'System')
        .replace(/^Microsoft\s+/i, '')
        .replace(/\s+Desktop$/i, '');
      summaryConfig.textContent = `Native • ${shortSys} • ${currentSettings.rate}x`;
    }
  }

  const summaryOptions = $('summary-options');
  if (summaryOptions) {
    const profileId = currentSettings.outputFilters?.profile || 'balanced';
    const profileLabel = OUTPUT_PROFILES[profileId]?.shortLabel || 'Custom';
    summaryOptions.textContent = `${profileLabel} • ${currentSettings.autoSpeak ? 'Auto' : 'Manual'}`;
  }
}

function syncOutputFilterUI() {
  const f = resolveFilterOptions(currentSettings.outputFilters);
  currentSettings.outputFilters = f;

  // Keep legacy flags synced for backwards compatibility
  currentSettings.skipCodeBlocks = f.codeBlocks === 'skip';
  currentSettings.stripUrls = f.urls !== 'keep';

  const setVal = (id, val) => {
    const el = $(id);
    if (el) el.value = val;
  };
  const setChk = (id, val) => {
    const el = $(id);
    if (el) el.checked = Boolean(val);
  };

  setVal('filter-tables', f.tables);
  setVal('filter-code', f.codeBlocks);
  setVal('filter-diagrams', f.diagrams);
  setVal('filter-math', f.math);
  setVal('filter-urls', f.urls);
  setVal('filter-paths', f.filePaths);
  setVal('filter-symbols', f.symbols);
  setVal('filter-callouts', f.callouts);
  setVal('filter-emojis', f.emojis);
  setVal('filter-structure', f.structure);

  setChk('chk-strip-citations', f.stripCitations);
  setChk('chk-strip-hashes', f.stripHashesAndIds);
  setChk('chk-humanize-ids', f.humanizeIdentifiers);

  const rulesInput = $('input-custom-rules');
  if (rulesInput && document.activeElement !== rulesInput) {
    rulesInput.value = f.customRules || '';
  }

  document.querySelectorAll('.profile-btn[data-profile]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.profile === f.profile);
  });

  const customBadge = $('badge-custom-profile');
  if (customBadge) {
    customBadge.classList.toggle('hidden', f.profile !== 'custom');
  }

  const descEl = $('profile-desc');
  if (descEl) {
    const preset = OUTPUT_PROFILES[f.profile];
    descEl.textContent = preset
      ? `${preset.description}.`
      : 'Custom mix of output filters applied to tables, code, symbols, and Markdown blocks.';
  }

  syncTranscriptViewToggleUI();
  updateCardSummaries();
}

function reapplyFiltersToCurrentTask({ notify = false, force = false, resumeIfPlaying = false } = {}) {
  if (!currentRawText) {
    if (force) showToast('No transcript loaded yet to re-apply filters');
    return false;
  }

  const wasSpeaking = audioQueue.isProcessing && !audioQueue.isPaused;
  const prevIndex = audioQueue.currentSentenceIndex || 0;

  if (wasSpeaking && !force) {
    if (notify) showToast('Filter saved — click ↻ Re-apply to update current speech now');
    return false;
  }

  if (audioQueue.isProcessing) {
    audioQueue.stop();
  }

  const processed = processForSpeech(currentRawText, currentSettings.outputFilters);
  updateFilterStatsUI(processed.stats);

  if (processed.segments.length === 0) {
    audioQueue.currentTask = null;
    audioQueue.totalSentences = 0;
    renderTranscriptSegments([], -1);
    $('sentence-counter').textContent = '0 / 0';
    $('current-caption').textContent = 'All content filtered out by current profile';
    if (force) showToast('Filters re-applied (all content filtered)');
    return true;
  }

  const metadata = {
    id: currentTaskId || `filtered-${Date.now()}`,
    rawText: currentRawText,
    engine: currentSettings.engine,
    kokoroInstance: kokoroEngine,
    kokoroVoice: currentSettings.kokoroVoice,
    webSpeechVoice: currentSettings.webSpeechVoice,
    rate: currentSettings.rate,
    pitch: currentSettings.pitch,
    onKokoroProgress: handleKokoroProgress,
  };

  if (wasSpeaking && resumeIfPlaying) {
    const startIdx = Math.min(prevIndex, processed.segments.length - 1);
    audioQueue.ensureAudioContext();
    audioQueue.enqueue(processed.segments, { ...metadata, startIndex: startIdx });
    showToast(`Filters re-applied (${processed.segments.length} segments)`);
    return true;
  }

  audioQueue.currentTask = {
    id: metadata.id,
    sentences: processed.segments,
    metadata,
  };
  audioQueue.currentSentenceIndex = 0;
  audioQueue.totalSentences = processed.segments.length;
  renderTranscriptSegments(processed.segments, -1);
  $('sentence-counter').textContent = `0 / ${processed.segments.length}`;
  $('current-caption').textContent = `Updated (${processed.segments.length} segments) — Click Play or any segment`;
  if (force) {
    showToast(`Filters re-applied (${processed.segments.length} segments)`);
  }
  return true;
}

function applyOutputFilterPatch(patch, { notify = false } = {}) {
  currentSettings.outputFilters = resolveFilterOptions({
    ...currentSettings.outputFilters,
    ...patch,
  });
  syncOutputFilterUI();
  saveSettings();
  reapplyFiltersToCurrentTask({ notify });
}

function applyCollapsedCardsState() {
  const collapsedSet = new Set(
    Array.isArray(currentSettings.collapsedCards) ? currentSettings.collapsedCards : []
  );
  document.querySelectorAll('.card[data-card-id]').forEach((card) => {
    const id = card.dataset.cardId;
    card.classList.toggle('collapsed', collapsedSet.has(id));
  });
  updateToggleAllButtonLabel();
}

function updateToggleAllButtonLabel() {
  const btn = $('btn-toggle-all-cards');
  if (!btn) return;
  const secondaryIds = ['config', 'options', 'sandbox', 'history', 'info'];
  const collapsedSet = new Set(
    Array.isArray(currentSettings.collapsedCards) ? currentSettings.collapsedCards : []
  );
  const allSecondaryCollapsed = secondaryIds.every((id) => collapsedSet.has(id));
  btn.textContent = allSecondaryCollapsed ? 'Expand All' : 'Compact View';
}

function wireCollapsibleCards() {
  document.querySelectorAll('.card[data-card-id]').forEach((card) => {
    const header = card.querySelector('.collapsible-header');
    if (!header) return;

    header.addEventListener('click', (e) => {
      // Do not toggle collapse if clicking an inner action button (like Refresh or Clear)
      const clickedBtn = e.target.closest('button');
      if (clickedBtn && !clickedBtn.classList.contains('btn-collapse-card')) {
        return;
      }

      const id = card.dataset.cardId;
      const isNowCollapsed = card.classList.toggle('collapsed');
      const set = new Set(
        Array.isArray(currentSettings.collapsedCards) ? currentSettings.collapsedCards : []
      );
      if (isNowCollapsed) set.add(id);
      else set.delete(id);

      currentSettings.collapsedCards = Array.from(set);
      updateToggleAllButtonLabel();
      saveSettings();
    });
  });

  const btnToggleAll = $('btn-toggle-all-cards');
  if (btnToggleAll) {
    btnToggleAll.addEventListener('click', () => {
      const secondaryIds = ['config', 'options', 'sandbox', 'history', 'info'];
      const currentSet = new Set(
        Array.isArray(currentSettings.collapsedCards) ? currentSettings.collapsedCards : []
      );
      const allSecondaryCollapsed = secondaryIds.every((id) => currentSet.has(id));

      if (allSecondaryCollapsed) {
        currentSettings.collapsedCards = [];
        showToast('Expanded all sections');
      } else {
        currentSettings.collapsedCards = secondaryIds;
        showToast('Compact view enabled');
      }
      applyCollapsedCardsState();
      saveSettings();
    });
  }
}

async function loadSettings() {
  try {
    const saved = await apiFetch('/api/settings');
    const resolvedFilters = saved.outputFilters
      ? resolveFilterOptions(saved.outputFilters)
      : resolveFilterOptions({
          skipCodeBlocks: saved.skipCodeBlocks,
          stripUrls: saved.stripUrls,
        });
    currentSettings = {
      ...currentSettings,
      ...saved,
      transcriptView: saved.transcriptView === 'spoken' ? 'spoken' : 'readable',
      outputFilters: resolvedFilters,
    };
  } catch {}

  // Apply to UI elements
  $('chk-auto-speak').checked = currentSettings.autoSpeak;

  if (currentSettings.engine === 'kokoro') {
    $('engine-kokoro').checked = true;
  } else {
    $('engine-webspeech').checked = true;
  }

  $('slider-speed').value = currentSettings.rate;
  $('speed-val').textContent = `${currentSettings.rate}x`;

  $('slider-pitch').value = currentSettings.pitch;
  $('pitch-val').textContent = `${currentSettings.pitch}x`;

  $('slider-volume').value = currentSettings.volume;
  $('volume-val').textContent = `${Math.round(currentSettings.volume * 100)}%`;
  audioQueue.setVolume(currentSettings.volume);

  if (currentSettings.repeatMode) {
    audioQueue.setRepeatMode(currentSettings.repeatMode);
  }

  const idleSelect = $('select-idle-unload');
  if (idleSelect) {
    idleSelect.value = String(currentSettings.idleUnloadMinutes ?? 10);
  }

  updateVoiceDropdown();
  syncOutputFilterUI();
  applyCollapsedCardsState();
}

async function saveSettings() {
  await apiFetch('/api/settings', { method: 'POST', body: currentSettings }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

function refreshCurrentTaskMetadata() {
  if (audioQueue.currentTask) {
    audioQueue.currentTask.metadata = {
      ...audioQueue.currentTask.metadata,
      engine: currentSettings.engine,
      kokoroInstance: kokoroEngine,
      kokoroVoice: currentSettings.kokoroVoice,
      webSpeechVoice: currentSettings.webSpeechVoice,
      rate: currentSettings.rate,
      pitch: currentSettings.pitch,
      onKokoroProgress: handleKokoroProgress,
    };
  }
}

function wireEventListeners() {
  // Previous Segment
  $('btn-prev').addEventListener('click', () => {
    refreshCurrentTaskMetadata();
    audioQueue.ensureAudioContext();
    if (!audioQueue.prevSentence()) {
      showToast('No speech segments loaded yet');
    }
  });

  // Play / Pause
  $('btn-toggle-play').addEventListener('click', () => {
    refreshCurrentTaskMetadata();
    audioQueue.ensureAudioContext();
    if (audioQueue.isProcessing) {
      if (audioQueue.isPaused) audioQueue.resume();
      else audioQueue.pause();
    } else if (audioQueue.currentTask?.sentences?.length > 0 && !$('sandbox-input').value.trim()) {
      // Replay current loaded segments from the active or first segment
      const startIdx =
        audioQueue.currentSentenceIndex < audioQueue.currentTask.sentences.length
          ? audioQueue.currentSentenceIndex
          : 0;
      audioQueue.jumpToSentence(startIdx);
    } else {
      // Trigger speak on sandbox text if idle
      const text = $('sandbox-input').value.trim() || 'Antigravity Voice Sidecar is online and ready.';
      speakManualText(text);
    }
  });

  // Next / Skip Segment
  $('btn-skip').addEventListener('click', () => {
    refreshCurrentTaskMetadata();
    audioQueue.ensureAudioContext();
    if (!audioQueue.nextSentence()) {
      showToast('No speech segments loaded yet');
    }
  });

  // Repeat Mode (Off -> Segment -> All)
  $('btn-repeat').addEventListener('click', () => {
    const mode = audioQueue.cycleRepeatMode();
    currentSettings.repeatMode = mode;
    saveSettings();
    const labelMap = {
      off: 'Repeat Mode: Off',
      segment: 'Repeat Mode: Current Segment (1)',
      all: 'Repeat Mode: All Segments',
    };
    showToast(labelMap[mode] || 'Repeat Mode: Off');
  });

  // Stop
  $('btn-stop').addEventListener('click', () => {
    audioQueue.stop();
    highlightTranscriptSegment(-1);
  });

  // Mute
  $('btn-mute').addEventListener('click', () => {
    isMuted = !isMuted;
    audioQueue.setMuted(isMuted);
    $('icon-unmuted').classList.toggle('hidden', isMuted);
    $('icon-muted').classList.toggle('hidden', !isMuted);
    updateCardSummaries();
  });

  // Volume slider
  $('slider-volume').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    currentSettings.volume = val;
    $('volume-val').textContent = `${Math.round(val * 100)}%`;
    audioQueue.setVolume(val);
    updateCardSummaries();
    saveSettings();
  });

  // Speed slider
  $('slider-speed').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    currentSettings.rate = val;
    $('speed-val').textContent = `${val}x`;
    updateCardSummaries();
    saveSettings();
  });

  // Pitch slider
  $('slider-pitch').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    currentSettings.pitch = val;
    $('pitch-val').textContent = `${val}x`;
    saveSettings();
  });

  // Engine Radios
  $('engine-kokoro').addEventListener('change', () => {
    currentSettings.engine = 'kokoro';
    updateVoiceDropdown();
    updateCardSummaries();
    saveSettings();
    if (kokoroEngine.state === 'idle') {
      loadKokoroModel({ silent: true });
    }
  });

  $('engine-webspeech').addEventListener('change', () => {
    currentSettings.engine = 'webspeech';
    updateVoiceDropdown();
    updateCardSummaries();
    saveSettings();
  });

  // Kokoro Load & Unload Buttons
  $('btn-load-kokoro').addEventListener('click', () => loadKokoroModel({ silent: false }));
  const btnUnload = $('btn-unload-kokoro');
  if (btnUnload) {
    btnUnload.addEventListener('click', () => unloadKokoroModel({ reason: 'manual' }));
  }

  // Idle Auto-Unload Selector
  const idleSelect = $('select-idle-unload');
  if (idleSelect) {
    idleSelect.addEventListener('change', (e) => {
      const mins = Number(e.target.value);
      currentSettings.idleUnloadMinutes = mins;
      if (kokoroEngine.state === 'ready') {
        kokoroEngine.lastUsedAt = Date.now();
      }
      updateIdleCountdownHint();
      saveSettings();
      showToast(mins > 0 ? `Auto-unload set to ${mins} min` : 'Auto-unload disabled');
    });
  }

  // Voice Select
  $('select-voice').addEventListener('change', (e) => {
    if (currentSettings.engine === 'kokoro') {
      currentSettings.kokoroVoice = e.target.value;
    } else {
      currentSettings.webSpeechVoice = e.target.value;
    }
    updateCardSummaries();
    saveSettings();
  });

  // Auto-speak toggle
  $('chk-auto-speak').addEventListener('change', (e) => {
    currentSettings.autoSpeak = e.target.checked;
    updateCardSummaries();
    saveSettings();
  });

  // Panel Refresh / Reload button (header):
  // Click = fast in-app refresh (keeps theme & Kokoro VRAM intact)
  // Shift+Click = full page reload (preserving host theme tokens)
  $('btn-reload-panel')?.addEventListener('click', async (e) => {
    if (e.shiftKey) {
      snapshotThemeTokens();
      audioQueue.stop();
      window.location.reload();
      return;
    }
    await loadSettings();
    await loadConversationsAndTurns();
    await loadHistory();
    reapplyFiltersToCurrentTask({ force: true, resumeIfPlaying: true });
    showToast('Panel refreshed (Shift+Click for full reload)');
  });

  // Re-apply Filters button (immediately re-processes loaded text & resumes if speaking)
  $('btn-reapply-filters')?.addEventListener('click', (e) => {
    e.stopPropagation();
    reapplyFiltersToCurrentTask({ force: true, resumeIfPlaying: true });
  });

  // Transcript View Toggle: Readable (original symbols) vs Spoken (exact TTS text)
  const setTranscriptView = (mode) => {
    const next = mode === 'spoken' ? 'spoken' : 'readable';
    if (currentSettings.transcriptView === next) return;
    currentSettings.transcriptView = next;
    syncTranscriptViewToggleUI();
    saveSettings();

    if (audioQueue.currentTask?.sentences?.length) {
      const activeIdx = audioQueue.isProcessing ? audioQueue.currentSentenceIndex : -1;
      renderTranscriptSegments(audioQueue.currentTask.sentences, activeIdx);
      if (activeIdx >= 0 && audioQueue.currentTask.sentences[activeIdx]) {
        $('current-caption').textContent = getSegmentTextForView(audioQueue.currentTask.sentences[activeIdx]);
      }
    }
    showToast(next === 'spoken' ? 'Transcript: Spoken TTS view' : 'Transcript: Readable view');
  };

  $('btn-view-readable')?.addEventListener('click', () => setTranscriptView('readable'));
  $('btn-view-spoken')?.addEventListener('click', () => setTranscriptView('spoken'));

  // Reading Profile Presets
  document.querySelectorAll('.profile-btn[data-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.profile;
      const preset = OUTPUT_PROFILES[profileId];
      if (!preset) return;
      currentSettings.outputFilters = resolveFilterOptions({
        ...preset.options,
        profile: profileId,
        customRules: currentSettings.outputFilters?.customRules || '',
      });
      syncOutputFilterUI();
      saveSettings();
      reapplyFiltersToCurrentTask({ notify: true });
      showToast(`Profile: ${preset.label}`);
    });
  });

  // Per-Content-Type Output Filter Dropdowns
  const filterSelectMap = [
    ['filter-tables', 'tables'],
    ['filter-code', 'codeBlocks'],
    ['filter-diagrams', 'diagrams'],
    ['filter-math', 'math'],
    ['filter-urls', 'urls'],
    ['filter-paths', 'filePaths'],
    ['filter-symbols', 'symbols'],
    ['filter-callouts', 'callouts'],
    ['filter-emojis', 'emojis'],
    ['filter-structure', 'structure'],
  ];

  for (const [elId, optKey] of filterSelectMap) {
    $(elId)?.addEventListener('change', (e) => {
      applyOutputFilterPatch({ [optKey]: e.target.value, profile: undefined }, { notify: true });
    });
  }

  // Advanced Noise Filter Checkboxes
  const filterCheckMap = [
    ['chk-strip-citations', 'stripCitations'],
    ['chk-strip-hashes', 'stripHashesAndIds'],
    ['chk-humanize-ids', 'humanizeIdentifiers'],
  ];

  for (const [elId, optKey] of filterCheckMap) {
    $(elId)?.addEventListener('change', (e) => {
      applyOutputFilterPatch({ [optKey]: e.target.checked, profile: undefined }, { notify: true });
    });
  }

  // Custom Pronunciation & Skip Rules (debounced live apply)
  $('input-custom-rules')?.addEventListener('input', (e) => {
    const val = e.target.value;
    clearTimeout(customRulesDebounce);
    customRulesDebounce = setTimeout(() => {
      applyOutputFilterPatch({ customRules: val }, { notify: false });
    }, 350);
  });

  // Sandbox
  $('btn-speak-sandbox').addEventListener('click', () => {
    const text = $('sandbox-input').value.trim();
    if (!text) return showToast('Please enter text to speak');
    speakManualText(text);
  });

  $('btn-clear-sandbox').addEventListener('click', () => {
    $('sandbox-input').value = '';
  });

  // Preset Chips
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const presetKey = chip.dataset.preset;
      const sample = (presetKey && SANDBOX_PRESETS[presetKey]) || chip.dataset.text || '';
      if (!sample) return;
      $('sandbox-input').value = sample;
      speakManualText(sample);
    });
  });

  // Sandbox input Enter key
  $('sandbox-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      const text = $('sandbox-input').value.trim();
      if (text) speakManualText(text);
    }
  });

  // Conversation Turns selector & refresh
  const convSelect = $('select-conversation');
  if (convSelect) {
    convSelect.addEventListener('change', (e) => {
      loadConversationTurns(e.target.value, { preloadIfIdle: false });
    });
  }

  const btnRefreshTurns = $('btn-refresh-turns');
  if (btnRefreshTurns) {
    btnRefreshTurns.addEventListener('click', async () => {
      await loadConversationsAndTurns();
      showToast('Conversation turns refreshed');
    });
  }

  // Clear history
  $('btn-clear-history').addEventListener('click', async () => {
    await apiFetch('/api/clear-history', { method: 'POST' }).catch(() => {});
    $('history-list').innerHTML = '<div class="empty-state">No speech history yet.</div>';
    showToast('History cleared');
  });
}

async function speakManualText(text) {
  audioQueue.ensureAudioContext();
  if (audioQueue.audioCtx && audioQueue.audioCtx.state === 'suspended') {
    await audioQueue.audioCtx.resume().catch(() => {});
  }

  const processed = processForSpeech(text, currentSettings.outputFilters);
  if (processed.segments.length === 0) {
    showToast('No speakable text with current filters');
    return;
  }

  const manualId = `manual-${Date.now()}`;
  currentRawText = text;
  currentTaskId = manualId;
  updateFilterStatsUI(processed.stats);

  audioQueue.stop();
  audioQueue.enqueue(processed.segments, {
    id: manualId,
    rawText: text,
    engine: currentSettings.engine,
    kokoroInstance: kokoroEngine,
    kokoroVoice: currentSettings.kokoroVoice,
    webSpeechVoice: currentSettings.webSpeechVoice,
    rate: currentSettings.rate,
    pitch: currentSettings.pitch,
    onKokoroProgress: handleKokoroProgress,
  });

  addHistoryItemUI({
    id: manualId,
    text: processed.displayText || processed.cleanText,
    rawText: text,
    source: 'manual',
    timestamp: Date.now(),
  });

  // Persist to server history without re-queueing for pollers
  apiFetch('/api/speak', {
    method: 'POST',
    body: {
      id: manualId,
      text: processed.displayText || processed.cleanText,
      cleanText: processed.cleanText,
      rawText: text,
      source: 'manual',
      historyOnly: true,
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Restore Antigravity host theme tokens if page was hard-reloaded, and snapshot once host styles settle
  restoreThemeTokensIfMissing();
  setTimeout(snapshotThemeTokens, 400);

  // Populate default voices immediately before async calls complete
  updateVoiceDropdown();
  updateCardSummaries();

  kokoroEngine.onStateChange = () => {
    syncKokoroUI();
  };

  setupVisualizer();
  setupAudioQueueListeners();
  wireEventListeners();
  wireCollapsibleCards();

  await loadSettings();
  await initWebSpeech();
  await loadConversationsAndTurns();
  await loadHistory();

  if (isActiveInstance) {
    // Auto-load Kokoro model in the background if Kokoro engine is selected
    if (currentSettings.engine === 'kokoro') {
      loadKokoroModel({ silent: true });
    }
    // Start queue polling every 600ms
    pollingInterval = setInterval(pollQueue, 600);
    // Check model inactivity timer every 5 seconds
    idleCheckInterval = setInterval(checkKokoroIdleUnload, 5000);
  }
}

init();

