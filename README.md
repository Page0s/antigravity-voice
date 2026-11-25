# Antigravity Voice TTS (`v2.1.0`)

> **Local Neural Text-to-Speech Sidecar Plugin for Google Antigravity** — powered by **Kokoro-82M** (WebGPU / WASM) and native OS speech synthesis, featuring a **smart Markdown & model-output filter pipeline**, **Dual Readable / Spoken transcript view**, **Reading Profiles (Balanced, Room Listen, Prose Only, Minimal)**, on-demand table/code expansion, transport & repeat controls, conversation turn browser, and smart VRAM auto-unloading.

---

## 🎧 Overview

**Antigravity Voice TTS** gives Google Antigravity a real-time, locally running neural voice. It combines a lifecycle `Stop` hook with an Auxiliary Sidecar UI panel so assistant responses can be spoken automatically as turns finish—or browsed and played on demand from any current or past conversation.

```text
Assistant Finishes Turn
         │
         ▼
Lifecycle Stop Hook (hooks/notify-tts.mjs)
  ├── Reads latest turn from transcript.jsonl / transcript_full.jsonl
  ├── Sanitizes Markdown, tables, links, LaTeX & code blocks
  └── Enqueues speech payload (tagged with conversationId)
         │
         ▼
Sidecar Node.js Server (sidecars/voice-panel/main.mjs)
  ├── Serves classic-script client bundle (plugin:// CORS-safe)
  ├── Scans ~/.gemini/antigravity/brain for Conversation Turns & *.md Artifacts
  └── Provides Native OS WAV synthesis & SAPI voice discovery fallback
         │
         ▼
Voice TTS Sidecar Panel (WebGPU + Web Audio API)
  ├── Real-time frequency spectrum visualizer + Interactive Segmented Reader
  ├── Transport Controls: Back, Play/Pause, Next, Repeat (Off / 1 / All), Stop, Mute
  ├── Kokoro-82M v1.0 ONNX Neural Engine (WebGPU fp32 / WASM q8 fallback)
  ├── Manual Unload & Configurable Inactivity Auto-Unload Timer (VRAM saver)
  └── Retractable / Collapsible Windows with Live Header Status Pills
```

---

## ✨ Key Features in v2.1.0

- **🎛️ Smart Model-Output Filter Engine & Reading Profiles**
  - **4 Quick-Switch Profiles** plus per-content-type controls for **Tables**, **Code & Diffs**, **Diagrams & ASCII Trees**, **Math & LaTeX**, **Links & URLs**, **File Paths**, **Symbols & Units**, **Callouts & Quotes**, **Emojis**, **Citations**, **UUIDs/Hashes**, and **Custom Pronunciation / Skip Rules**:
    - **Balanced (Default):** Smart tables (reads small tables ≤ 6×4 naturally row-by-row; summarizes large tables with headers), concise code summaries, natural LaTeX & symbol expansion.
    - **Room Listen (Hands-Free):** Reads all tables row-by-row, announces structure & callouts, and speaks paths thoroughly for listening away from the screen.
    - **Prose Only:** Skips tables, code blocks, diagrams, and bare URLs for fast listening.
    - **Minimal:** Light Markdown cleanup with minimal rewriting.
  - **On-Demand Expand (`Read rows ▶` / `Read lines ▶`):** Summarized large tables, diffs, code blocks, or formulas include an inline expand button right in the Live Monitor transcript to unfold and speak them anytime.
- **👁️ Dual Readable / Spoken Transcript View + Orphan-Free Chunking**
  - Shows clean **Readable** text with original symbols on screen by default while sending smooth normalized speech (`a–z` → *"a to z"*, `Ctrl+C` → *"Control plus C"*, `~150ms` → *"about 150 milliseconds"*, `→` → *"to"*) to Kokoro-82M.
  - Toggle to **Spoken** anytime to inspect the exact normalized speech script.
  - Block-aware, parenthesis-safe balanced sentence chunking prevents mid-parenthesis splits and single-word orphan rows.
- **🧠 Local Kokoro-82M Neural Audio (WebGPU & WASM)**
  - Runs [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) directly inside Antigravity's sidecar pane using WebGPU (`fp32`) with automatic quantized WASM (`q8`) fallback.
  - Zero cloud API keys, zero external Python servers, and automatic local `CacheStorage` persistence after the first download.
- **📖 Interactive Segmented Transcript Reader**
  - Every spoken response is split into numbered sentence segments displayed right below the audio spectrum visualizer.
  - The active sentence highlights and scrolls into view as it plays.
  - **Click any sentence segment** to immediately jump to and play from that exact point.
- **⏯️ Full Transport & Repeat Mode Controls**
  - **Back (`⏮`) / Next (`⏭`)**: Step backward or forward sentence-by-sentence.
  - **Play / Pause (`▶ / ⏸`)**: Pause and resume audio at the exact millisecond.
  - **Repeat Mode (`🔁`)**: Cycle between **Repeat: Off**, **Repeat: 1** (loop the current sentence segment continuously), and **Repeat: All** (loop the entire response).
- **🗂️ Past & Current Conversation Turns + Artifact Browser**
  - Automatically detects the active conversation (`★ [Current Chat]`) and lists every assistant response turn (`Turn #1`, `Turn #2`, … paired with your prompt) plus any Markdown artifacts (`📄 *.md`).
  - Switch the dropdown to **any past conversation** stored in `~/.gemini/antigravity/brain/`—even conversations created before installing the plugin.
  - Click **Load** to inspect a turn's sentence segments in the reader first, or click **▶** to listen immediately.
- **🧹 Smart VRAM / RAM Management**
  - One-click **Unload** button to free GPU/RAM memory on demand.
  - Configurable **Auto-unload when idle** timer (`2 min`, `5 min`, `10 min (Default)`, `15 min`, `30 min`, `60 min`, or `Never`) with a live countdown that pauses while audio is playing and automatically reloads from disk cache in ~1–2s when needed again.
- **🪟 Retractable / Collapsible UI Windows**
  - Every card window can be retracted down to its title bar by clicking its header or chevron icon, while displaying live summary pills (`Kokoro • Sky • 1.0x`, `Vol 100%`, `Auto-speak: On`).
  - Includes a one-click **Compact View / Expand All** button in the top header and persists your layout across sessions.

---

## 📁 Project Structure

```text
antigravity-voice/
├── plugin.json                 # Antigravity plugin manifest (v2.0.0)
├── hooks.json                  # Lifecycle hook manifest (Stop event)
├── package.json                # Root package & test runner
├── LICENSE                     # MIT License
├── README.md                   # Documentation & setup guide
├── assets/
│   └── logo.svg                # Plugin icon
├── hooks/
│   ├── notify-tts.mjs          # Extracts latest assistant turn & dispatches to sidecar
│   └── sanitizer.mjs           # Re-export facade to the single canonical text pipeline
├── sidecars/
│   └── voice-panel/
│       ├── sidecar.json        # Declares AUX_PANE web UI
│       ├── package.json        # Sidecar ES module manifest
│       ├── main.mjs            # SidecarApp server, settings & transcript API
│       ├── index.html          # Collapsible UI layout, Reading Filters & user guide
│       ├── styles.css          # Antigravity theme-aware styles
│       ├── app.js              # Frontend controller & live re-filtering
│       └── lib/
│           ├── bundle.mjs      # Classic-script IIFE bundler for plugin:// compatibility
│           ├── sanitizer.js    # Pipeline orchestrator & processForSpeech API
│           ├── pipeline/       # Modular zero-dependency output filters
│           │   ├── presets.js          # Reading profiles & custom rules parser
│           │   ├── block-parser.js     # Typed Markdown/HTML/callout/tree block parser
│           │   ├── table-reader.js     # Adaptive 2-col & multi-col table linearizer
│           │   ├── code-handler.js     # Code, diff, Mermaid & ASCII tree handler
│           │   ├── math-reader.js      # LaTeX-to-English speech converter
│           │   ├── inline-normalizer.js# Dual display/spoken symbol, path & URL normalizer
│           │   └── chunker.js          # Balanced, parenthesis-safe, orphan-free chunker
│           ├── audio-queue.js  # Web Audio API queue, expand-in-place & repeat modes
│           ├── kokoro-tts.js   # Kokoro-82M WebGPU/WASM loader & memory manager
│           └── native-tts.js   # Native OS WAV synthesis (UTF-8 BOM safe) & SAPI voices
└── test/
    └── sanitizer.test.mjs      # 20-suite pipeline, regression & bundle verification suite
```

---

## 🚀 Installation & Setup

### 1. Copy or Clone into Antigravity Plugins Directory

Clone or copy this repository into your Antigravity plugins folder:

- **Windows**:
  ```powershell
  git clone https://github.com/Page0s/antigravity-voice.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-voice"
  ```
- **macOS / Linux**:
  ```bash
  git clone https://github.com/Page0s/antigravity-voice.git ~/.gemini/config/plugins/antigravity-voice
  ```

### 2. Enable in Antigravity Customizations
1. Open **Google Antigravity**.
2. Open **Customizations** → **Plugins** (or **Installed**).
3. Enable **Antigravity Voice**.

### 3. Open the Voice TTS Panel
- Click the **⋮** menu in the top-right corner of any conversation and select **Extensions** → **Voice TTS**, or click a `[Voice TTS](sidecar://antigravity-voice/voice-panel/)` link in chat.

---

## 🎙️ Included Voices

### Kokoro-82M Neural Voices (WebGPU / WASM)
| Voice ID | Name | Accent / Gender |
| :--- | :--- | :--- |
| `af_sky` | **Sky (Default)** | US Female |
| `af_bella` | **Bella** | US Female |
| `af_heart` | **Heart (Expressive)** | US Female |
| `af_sarah` | **Sarah** | US Female |
| `af_nicole` | **Nicole** | US Female |
| `am_adam` | **Adam** | US Male |
| `am_michael` | **Michael** | US Male |
| `am_echo` | **Echo** | US Male |
| `bf_emma` | **Emma** | British Female |
| `bf_isabella` | **Isabella** | British Female |
| `bm_george` | **George** | British Male |
| `bm_lewis` | **Lewis** | British Male |

### Native System TTS Fallback
Automatically discovers installed OS voices (such as `Microsoft David Desktop`, `Microsoft Zira Desktop`, and system Web Speech voices) for zero-download offline synthesis.

---

## 🧪 Running Tests

```bash
npm test
# or
node test/sanitizer.test.mjs
```

---

## 📄 License

Released under the [MIT License](LICENSE).
