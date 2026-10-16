# Antigravity Voice Plugin (Kokoro-82M / TTS) — Architecture & Brainstorm Spec

## 1. Executive Summary

This document captures the brainstorm and technical blueprint for giving Google Antigravity a voice by implementing a custom plugin. The primary candidate is **Kokoro-82M** (Apache-2.0) running client-side via **`kokoro-js`** over **WebGPU** (with WASM/CPU fallback), alongside native headless alternatives (Piper TTS, Kokoro-ONNX).

---

## 2. Antigravity Plugin Capabilities

Antigravity plugins reside in:
- **Windows**: `%USERPROFILE%\.gemini\config\plugins\<plugin-name>\`
- **Linux / macOS**: `~/.gemini/config/plugins/<plugin-name>/`

A single plugin can package:
1. **Sidecars with UI Extensions (`sidecars/`)**: Spawns a background Node.js process and hosts an HTML/JS web panel in Antigravity's auxiliary right-side pane. Chromium hosts this pane, granting access to **WebGPU**, **Web Audio API** (`AudioContext`), and **WASM**.
2. **Lifecycle Hooks (`hooks.json`)**: Intercepts `PostInvocation` and `Stop` events. Receives `transcriptPath` on `stdin` so an external script or sidecar can capture the assistant's final turn response automatically.
3. **MCP Servers (`mcp_config.json`)**: Exposes tool calls to the agent (e.g., `speak_text`, `pause_speech`) if conversational triggers are desired.
4. **Skills & Rules (`skills/`, `rules/AGENTS.md`)**: Directs the agent to provide concise summaries or strip code formatting for speech delivery.

---

## 3. Architecture Options

### Option A: WebGPU In-Browser Extension (Recommended for Kokoro-js)
*Zero external runtime dependencies; runs inside Antigravity's Chromium side pane.*

```
Agent Finishes Response
        │
        ▼
PostInvocation / Stop Hook
        │ (POST http://localhost:<port>/api/speak)
        ▼
Sidecar Node.js Server
        │ (SSE / WebSocket)
        ▼
Sidecar Web Panel (Iframe)
  ├── kokoro-js (ONNX Runtime Web / WebGPU)
  ├── Web Audio API (real-time playback)
  └── UI Controls (play/pause, mute, voice picker, waveform)
```

- **Inference**: WebGPU accelerated through ONNX Runtime Web.
- **Latency**: ~150–300 ms on modern GPUs.
- **Fallback**: WASM / CPU fallback if WebGPU is unavailable; Web Speech API (`window.speechSynthesis`) while the model downloads.
- **Voices**: Kokoro voices (e.g. `af_bella`, `af_sarah`, `am_adam`, `am_michael`).

---

### Option B: Headless Background TTS (Local Native Binary)
*Zero UI needed; runs completely in the background via system audio.*

```
Agent Turn Ends ──► hooks.json (Stop event) ──► Headless TTS Engine ──► Windows Audio Device
```

- **TTS Options**:
  - **Piper TTS**: Standalone C++ binary, ultra-fast CPU inference (< 50ms), minimal footprint.
  - **Kokoro-ONNX / sherpa-onnx**: DirectML / CPU Python/C++ engine running Kokoro locally.
  - **Edge-TTS**: Python wrapper for Microsoft Edge natural neural voices (requires internet).

---

### Option C: The Hybrid Pipeline (Best Experience)

1. **Lifecycle Hook (`hooks.json`)**:
   Fires on `PostInvocation` or `Stop`. Reads the latest assistant message from `transcript.jsonl`.
2. **Markdown / Text Sanitizer**:
   Strips code blocks, backticks, ASCII tables, and long URLs before sending text to TTS, replacing them with verbal cues (e.g., *"Here is the solution code:"*).
3. **Sentence Chunking**:
   Splits text by punctuation (`.`, `?`, `!`) to stream audio sentence-by-sentence for near-zero perceived latency.
4. **Sidecar UI**:
   Hosts the Web Audio player, voice selection dropdown, playback toggle, and volume slider.

---

## 4. TTS Engine Comparison

| Feature | Kokoro-82M (`kokoro-js`) | Piper TTS | Web Speech API | Edge-TTS |
| :--- | :--- | :--- | :--- | :--- |
| **Model Size** | ~80 MB (ONNX quantized) | ~15–60 MB | 0 MB (built-in OS) | 0 MB (cloud) |
| **Voice Quality** | **Studio quality** | Good / Functional | Robotic to Good | **Studio quality** |
| **Hardware** | WebGPU (or WASM) | CPU (extremely fast) | None | None |
| **Offline** | Yes | Yes | Yes | No (requires internet) |
| **License** | Apache-2.0 | MIT | Built-in | Unofficial MS API |

---

## 5. Recommended Plugin Directory Structure

```text
%USERPROFILE%\.gemini\config\plugins\antigravity-voice\
├── plugin.json
├── README.md
├── hooks.json                     # Triggers TTS on PostInvocation / Stop
├── assets\
│   └── logo.svg
└── sidecars\
    └── voice-panel\
        ├── sidecar.json           # Declares AUX_PANE web UI
        ├── package.json
        ├── main.mjs               # Node.js backend: receives speech events
        ├── index.html             # Frontend: loads kokoro-js & audio player
        ├── app.js                 # WebGPU pipeline & Web Audio playback
        └── styles.css
```

---

## 6. Implementation Checklist

- [ ] **Step 1: Scaffold Plugin**: Create `antigravity-voice` folder in `%USERPROFILE%\.gemini\config\plugins\`.
- [ ] **Step 2: Implement Sidecar**: Setup `main.mjs` and `index.html` loading `kokoro-js` with local or cached ONNX weights.
- [ ] **Step 3: Hook Integration**: Configure `hooks.json` to notify the sidecar backend when an agent response finishes.
- [ ] **Step 4: Text Cleaning**: Implement regex cleaning for markdown, code snippets, and terminal output.
- [ ] **Step 5: Audio Controls**: Add mute toggle, voice switcher, and stop/pause buttons in the side pane UI.
