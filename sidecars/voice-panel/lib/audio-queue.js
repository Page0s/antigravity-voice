/**
 * Audio Queue and Playback Controller
 * Handles Web Audio API, AnalyserNode, Kokoro-82M streaming, and Web Speech API fallback.
 */

export class AudioQueueController {
  constructor() {
    this.audioCtx = null;
    this.gainNode = null;
    this.analyser = null;
    this.currentSource = null;

    this.queue = [];
    this.currentTask = null;
    this.isProcessing = false;
    this.isPaused = false;
    this.isMuted = false;
    this.volume = 1.0;
    this.repeatMode = 'off'; // 'off' | 'segment' | 'all'

    this.currentText = '';
    this.currentSentenceIndex = 0;
    this.totalSentences = 0;
    this._navigationTarget = null;
    this._directWaitResolve = null;

    this.onStateChange = () => {};
    this.onProgress = () => {};
    this.onTaskLoad = () => {};
    this.onQueueEmpty = () => {};
    this.onRepeatModeChange = () => {};

    // Web Speech API fallback tracker
    this.speechSynthesisUtterance = null;
    this.simulatedAudioTimer = null;
  }

  ensureAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
      this.gainNode = this.audioCtx.createGain();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.applyVolume();
    }

    if (this.audioCtx.state === 'suspended' && !this.isPaused) {
      this.audioCtx.resume();
    }
  }

  applyVolume() {
    if (this.gainNode) {
      this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    this.applyVolume();
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    this.applyVolume();
  }

  setRepeatMode(mode) {
    const valid = ['off', 'segment', 'all'];
    this.repeatMode = valid.includes(mode) ? mode : 'off';
    this.onRepeatModeChange(this.repeatMode);
    return this.repeatMode;
  }

  cycleRepeatMode() {
    const order = ['off', 'segment', 'all'];
    const nextIdx = (order.indexOf(this.repeatMode) + 1) % order.length;
    return this.setRepeatMode(order[nextIdx]);
  }

  /**
   * Normalizes string or structured segment items into canonical segment objects.
   */
  _normalizeSegments(items) {
    const list = Array.isArray(items) ? items : [items];
    const valid = [];
    for (const item of list) {
      if (typeof item === 'string') {
        const t = item.trim();
        if (t) {
          valid.push({
            text: t,
            spokenText: t,
            displayText: t,
            blockType: 'paragraph',
            badge: '',
            expandable: null,
          });
        }
      } else if (item && typeof item === 'object') {
        const spk = String(item.spokenText || item.text || '').trim();
        if (spk) {
          valid.push({
            text: spk,
            spokenText: spk,
            displayText: String(item.displayText || spk).trim(),
            blockType: item.blockType || 'paragraph',
            badge: item.badge || '',
            expandable: item.expandable || null,
          });
        }
      }
    }
    return valid;
  }

  /**
   * Enqueue a full speech task (array of segment objects or sentence strings)
   */
  enqueue(sentences, metadata = {}) {
    const valid = this._normalizeSegments(sentences);
    if (valid.length === 0) return;

    const task = {
      id: metadata.id || `task-${Date.now()}`,
      sentences: valid,
      metadata,
      startIndex: typeof metadata.startIndex === 'number' ? metadata.startIndex : 0,
    };

    this.queue.push(task);

    if (!this.isProcessing && !this.isPaused) {
      this.processNextTask();
    } else if (!this.currentTask) {
      this.currentTask = task;
      this.totalSentences = valid.length;
      this.onTaskLoad({
        sentences: valid,
        activeIndex: 0,
        metadata,
      });
    }
  }

  /**
   * Expands a summarized segment (e.g. large table or code block) in-place and starts playing it.
   */
  expandSegmentAt(index, { autoPlay = true } = {}) {
    if (!this.currentTask || !Array.isArray(this.currentTask.sentences)) return false;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.currentTask.sentences.length) return false;

    const target = this.currentTask.sentences[idx];
    const expandedRaw = target?.expandable?.segments;
    if (!Array.isArray(expandedRaw) || expandedRaw.length === 0) return false;

    const replacement = this._normalizeSegments(expandedRaw);
    if (replacement.length === 0) return false;

    this.currentTask.sentences.splice(idx, 1, ...replacement);
    this.totalSentences = this.currentTask.sentences.length;

    this.onTaskLoad({
      sentences: this.currentTask.sentences,
      activeIndex: autoPlay ? idx : -1,
      metadata: this.currentTask.metadata,
    });

    if (autoPlay) {
      this.jumpToSentence(idx);
    }
    return true;
  }

  async processNextTask() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.onStateChange('idle');
      this.onQueueEmpty();
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();
    this.currentTask = task;
    const sentences = task.sentences;
    this.totalSentences = sentences.length;

    let i = typeof task.startIndex === 'number' ? task.startIndex : 0;
    delete task.startIndex;
    this._navigationTarget = null;

    this.onTaskLoad({
      sentences,
      activeIndex: i,
      metadata: task.metadata,
    });

    while (i < sentences.length && this.isProcessing) {
      while (this.isPaused && this.isProcessing && this._navigationTarget === null) {
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!this.isProcessing) break;

      if (this._navigationTarget !== null) {
        i = this._navigationTarget;
        this._navigationTarget = null;
        if (i < 0 || i >= sentences.length) break;
      }

      const currentSeg = sentences[i];
      const spokenStr = typeof currentSeg === 'string' ? currentSeg : currentSeg.spokenText || currentSeg.text;
      const displayStr = typeof currentSeg === 'string' ? currentSeg : currentSeg.displayText || spokenStr;

      this.currentSentenceIndex = i;
      this.currentText = spokenStr;

      this.onProgress({
        index: i + 1,
        activeIndex: i,
        total: sentences.length,
        text: spokenStr,
        displayText: displayStr,
        segment: currentSeg,
        sentences,
        metadata: task.metadata,
      });

      this.onStateChange(this.isPaused ? 'paused' : 'speaking');

      try {
        await this.playSentence(spokenStr, task.metadata);
      } catch (err) {
        console.error('Error playing sentence:', err);
      }

      if (!this.isProcessing) break;

      if (this._navigationTarget !== null) {
        i = this._navigationTarget;
        this._navigationTarget = null;
      } else if (this.repeatMode === 'segment') {
        // Repeat the same sentence index `i`
      } else {
        i++;
        if (i >= sentences.length && this.repeatMode === 'all' && this.queue.length === 0) {
          i = 0;
        }
      }
    }

    // Task finished; check next
    if (this.isProcessing) {
      this.processNextTask();
    }
  }

  /**
   * Plays a single sentence using chosen engine
   */
  async playSentence(text, options = {}) {
    this.ensureAudioContext();

    const engine = options.engine || 'kokoro';
    const kokoroInstance = options.kokoroInstance;

    // 1. Neural Kokoro-82M (WebGPU / WASM)
    if (engine === 'kokoro' && kokoroInstance) {
      if (kokoroInstance.state === 'idle' || kokoroInstance.state === 'loading') {
        try {
          await kokoroInstance.init(options.onKokoroProgress);
        } catch (initErr) {
          console.warn('Kokoro auto-init failed:', initErr);
        }
      }

      if (!this.isProcessing || this._navigationTarget !== null) return;

      if (kokoroInstance.state === 'ready') {
        try {
          const audioData = await kokoroInstance.generate(
            text,
            options.kokoroVoice || 'af_sky',
            options.rate || 1.0
          );

          if (!this.isProcessing || this._navigationTarget !== null) return;

          if (audioData) {
            await this.playAudioData(audioData);
            return;
          }
        } catch (kokoroErr) {
          console.warn('Kokoro generation failed, falling back to Native WAV synthesis:', kokoroErr);
        }
      }
    }

    if (!this.isProcessing || this._navigationTarget !== null) return;

    // 2. High-Fidelity Native WAV Synthesis via Sidecar Server (Web Audio API + Visualizer)
    try {
      const voiceParam = options.webSpeechVoice ? `&voice=${encodeURIComponent(options.webSpeechVoice)}` : '';
      const url = `/api/synthesize?text=${encodeURIComponent(text)}&rate=${options.rate || 1.0}${voiceParam}`;
      const fetchFn = typeof window !== 'undefined' && window.sidecar ? window.sidecar.fetch : fetch;
      const res = await fetchFn(url);
      if (!this.isProcessing || this._navigationTarget !== null) return;
      if (res && res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        if (!this.isProcessing || this._navigationTarget !== null) return;
        if (arrayBuffer && arrayBuffer.byteLength > 100) {
          await this.playAudioData(arrayBuffer);
          return;
        }
      }
    } catch (synthErr) {
      console.warn('Native WAV synthesis failed:', synthErr);
    }

    if (!this.isProcessing || this._navigationTarget !== null) return;

    // 3. Fallback: Direct System Speakers Dispatch
    try {
      const postFn = typeof window !== 'undefined' && window.sidecar ? window.sidecar.fetch : fetch;
      await postFn('/api/speak-direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          rate: options.rate || 1.0,
          voice: options.webSpeechVoice || '',
        }),
      });
      const approxDurationMs = Math.max(1000, (text.split(/\s+/).length / 2.5) * 1000);
      await new Promise((resolve) => {
        this._directWaitResolve = resolve;
        setTimeout(() => {
          if (this._directWaitResolve === resolve) this._directWaitResolve = null;
          resolve();
        }, approxDurationMs);
      });
      return;
    } catch (directErr) {
      console.warn('Direct speech dispatch failed:', directErr);
    }

    // 4. Fallback: Browser Web Speech API
    await this.playWebSpeech(text, options);
  }

  /**
   * Play Float32Array, AudioBuffer, Blob, or ArrayBuffer through Web Audio API
   */
  async playAudioData(audioData) {
    if (!audioData || !this.isProcessing || this._navigationTarget !== null) return;
    this.ensureAudioContext();
    const ctx = this.audioCtx;
    if (!ctx) return;

    let buffer;
    if (audioData.audio && audioData.sampling_rate) {
      const float32 = audioData.audio instanceof Float32Array ? audioData.audio : new Float32Array(audioData.audio);
      buffer = ctx.createBuffer(1, float32.length, audioData.sampling_rate);
      buffer.copyToChannel(float32, 0);
    } else if (audioData instanceof AudioBuffer) {
      buffer = audioData;
    } else if (typeof Blob !== 'undefined' && audioData instanceof Blob) {
      const arrayBuffer = await audioData.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
    } else if (typeof ArrayBuffer !== 'undefined' && audioData instanceof ArrayBuffer) {
      buffer = await ctx.decodeAudioData(audioData.slice(0));
    } else {
      return;
    }

    if (!this.isProcessing || this._navigationTarget !== null) return;

    return new Promise((resolve, reject) => {
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);

        this.currentSource = source;

        source.onended = () => {
          if (this.currentSource === source) {
            this.currentSource = null;
          }
          resolve();
        };

        source.start(0);
        if (this.isPaused && ctx.state === 'running') {
          ctx.suspend();
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Play speech using the browser's built-in Web Speech API
   */
  playWebSpeech(text, options = {}) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        console.warn('speechSynthesis not supported');
        return resolve();
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.rate || 1.0;
      utterance.pitch = options.pitch || 1.0;
      utterance.volume = this.isMuted ? 0 : this.volume;

      if (options.webSpeechVoice) {
        const voices = window.speechSynthesis.getVoices();
        const found = voices.find((v) => v.name === options.webSpeechVoice || v.voiceURI === options.webSpeechVoice);
        if (found) utterance.voice = found;
      }

      this.speechSynthesisUtterance = utterance;

      utterance.onend = () => {
        this.speechSynthesisUtterance = null;
        resolve();
      };

      utterance.onerror = (e) => {
        console.warn('speechSynthesis error:', e);
        this.speechSynthesisUtterance = null;
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  _cancelCurrentAudio() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch {}
      this.currentSource = null;
    }
    if (this._directWaitResolve) {
      const r = this._directWaitResolve;
      this._directWaitResolve = null;
      r();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      this.speechSynthesisUtterance = null;
    }
  }

  pause() {
    if (!this.isProcessing) return;
    this.isPaused = true;
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend();
    }
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
    }
    this.onStateChange('paused');
  }

  resume() {
    this.isPaused = false;
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if ('speechSynthesis' in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
    this.onStateChange(this.isProcessing ? 'speaking' : 'idle');
    if (!this.isProcessing && this.queue.length > 0) {
      this.processNextTask();
    }
  }

  stop() {
    this.isProcessing = false;
    this.isPaused = false;
    this.queue = [];
    this._navigationTarget = null;
    this._cancelCurrentAudio();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    this.onStateChange('idle');
  }

  /**
   * Jump directly to a specific sentence index in the current task (0-based)
   */
  jumpToSentence(index) {
    if (!this.currentTask || !Array.isArray(this.currentTask.sentences) || this.currentTask.sentences.length === 0) {
      return false;
    }
    const targetIdx = Math.max(0, Math.min(this.currentTask.sentences.length - 1, Number(index) || 0));

    if (this.isProcessing) {
      this._navigationTarget = targetIdx;
      if (this.isPaused) {
        this.isPaused = false;
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume();
        }
      }
      this._cancelCurrentAudio();
    } else {
      this.isPaused = false;
      this.queue.unshift({
        ...this.currentTask,
        startIndex: targetIdx,
      });
      this.processNextTask();
    }
    return true;
  }

  /**
   * Step back to the previous sentence segment (or restart segment 0)
   */
  prevSentence() {
    if (!this.currentTask || !this.currentTask.sentences?.length) return false;
    const targetIdx = Math.max(0, this.currentSentenceIndex - 1);
    return this.jumpToSentence(targetIdx);
  }

  /**
   * Step forward to the next sentence segment
   */
  nextSentence() {
    if (!this.currentTask || !this.currentTask.sentences?.length) return false;
    const len = this.currentTask.sentences.length;

    if (this.isProcessing) {
      if (this.currentSentenceIndex + 1 < len) {
        return this.jumpToSentence(this.currentSentenceIndex + 1);
      } else if (this.repeatMode === 'all') {
        return this.jumpToSentence(0);
      } else {
        this._navigationTarget = len;
        if (this.isPaused) {
          this.isPaused = false;
          if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
          }
        }
        this._cancelCurrentAudio();
        return true;
      }
    } else {
      const nextIdx = this.currentSentenceIndex + 1 < len ? this.currentSentenceIndex + 1 : 0;
      return this.jumpToSentence(nextIdx);
    }
  }

  skipCurrent() {
    return this.nextSentence();
  }

  /**
   * Retrieves byte frequency data for the canvas visualizer
   */
  getFrequencyData(array) {
    if (this.analyser) {
      this.analyser.getByteFrequencyData(array);
    }

    // Synthesize visualizer formant feedback if Web Speech API is speaking or no signal
    if (this.isProcessing && !this.isPaused) {
      let hasSignal = false;
      for (let i = 0; i < array.length; i++) {
        if (array[i] > 0) { hasSignal = true; break; }
      }
      if (!hasSignal) {
        const t = Date.now() / 120;
        for (let i = 0; i < array.length; i++) {
          const formant = Math.sin(t * 1.6 + i * 0.35) * 0.5 + 0.5;
          const decay = Math.exp(-i / 20);
          array[i] = Math.floor(formant * decay * 210 + Math.random() * 25);
        }
      }
    }
  }

  /**
   * Retrieves time domain (waveform) data for the canvas visualizer
   */
  getTimeDomainData(array) {
    if (this.analyser) {
      this.analyser.getByteTimeDomainData(array);
    }
  }
}
