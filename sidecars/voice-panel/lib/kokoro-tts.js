/**
 * Kokoro-82M WebGPU / WASM Client Adapter
 * Loads Kokoro neural TTS in-browser with WebGPU hardware acceleration.
 */

export const KOKORO_VOICES = [
  { id: 'af_sky', name: 'Sky (US Female - Default)', lang: 'en-us', gender: 'female' },
  { id: 'af_bella', name: 'Bella (US Female)', lang: 'en-us', gender: 'female' },
  { id: 'af_heart', name: 'Heart (US Female - Expressive)', lang: 'en-us', gender: 'female' },
  { id: 'af_sarah', name: 'Sarah (US Female)', lang: 'en-us', gender: 'female' },
  { id: 'af_nicole', name: 'Nicole (US Female)', lang: 'en-us', gender: 'female' },
  { id: 'am_adam', name: 'Adam (US Male)', lang: 'en-us', gender: 'male' },
  { id: 'am_michael', name: 'Michael (US Male)', lang: 'en-us', gender: 'male' },
  { id: 'am_echo', name: 'Echo (US Male)', lang: 'en-us', gender: 'male' },
  { id: 'bf_emma', name: 'Emma (British Female)', lang: 'en-gb', gender: 'female' },
  { id: 'bf_isabella', name: 'Isabella (British Female)', lang: 'en-gb', gender: 'female' },
  { id: 'bm_george', name: 'George (British Male)', lang: 'en-gb', gender: 'male' },
  { id: 'bm_lewis', name: 'Lewis (British Male)', lang: 'en-gb', gender: 'male' },
];

const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export class KokoroEngine {
  constructor() {
    this.tts = null;
    this.state = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
    this.device = null; // 'webgpu' | 'wasm'
    this.dtype = null; // 'fp32' | 'q8'
    this.loadProgress = 0;
    this.statusMessage = 'Not loaded';
    this.error = null;
    this.initPromise = null;
    this.lastUsedAt = 0;
    this.onStateChange = () => {};
  }

  /**
   * Checks whether WebGPU is supported in this browser context
   */
  async checkWebGpuSupport() {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return true;
      } catch (e) {
        console.warn('WebGPU check failed:', e);
      }
    }
    return false;
  }

  /**
   * Initializes the Kokoro TTS model (deduplicated if already loading)
   */
  async init(onProgress = () => {}) {
    if (this.state === 'ready' && this.tts) {
      onProgress({ progress: 100, message: this.statusMessage });
      return true;
    }
    if (this.state === 'loading' && this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInit(onProgress);
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async _doInit(onProgress = () => {}) {
    this.state = 'loading';
    this.error = null;
    this.statusMessage = 'Checking WebGPU acceleration...';
    onProgress({ progress: 10, message: this.statusMessage });

    try {
      const hasWebGpu = await this.checkWebGpuSupport();
      this.device = hasWebGpu ? 'webgpu' : 'wasm';
      this.dtype = hasWebGpu ? 'fp32' : 'q8';
      this.statusMessage = hasWebGpu
        ? 'WebGPU available! Loading Kokoro-82M neural model...'
        : 'WebGPU unavailable, loading quantized WASM model...';
      onProgress({ progress: 25, message: this.statusMessage });

      // Dynamic import from CDN
      let kokoroModule;
      try {
        kokoroModule = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.1.1/dist/kokoro.web.js');
      } catch (cdnErr) {
        try {
          kokoroModule = await import('https://esm.sh/kokoro-js@1.1.1');
        } catch {
          throw new Error(`Failed to load kokoro-js library: ${cdnErr.message}`);
        }
      }

      const KokoroTTS = kokoroModule.KokoroTTS || kokoroModule.default?.KokoroTTS || kokoroModule.default;
      if (!KokoroTTS) {
        throw new Error('KokoroTTS export not found in loaded bundle');
      }

      this.statusMessage = `Initializing neural weights (${this.device.toUpperCase()})...`;
      onProgress({ progress: 45, message: this.statusMessage });

      const progressCallback = (item) => {
        if (item && item.progress !== undefined) {
          const pct = Math.round(45 + item.progress * 0.5);
          this.loadProgress = pct;
          onProgress({
            progress: pct,
            message: `Loading model weights: ${Math.round(item.progress)}%`,
          });
        }
      };

      try {
        this.tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: this.dtype,
          device: this.device,
          progress_callback: progressCallback,
        });
      } catch (primaryErr) {
        if (this.device === 'webgpu') {
          console.warn('WebGPU model load failed, falling back to WASM q8:', primaryErr);
          this.device = 'wasm';
          this.dtype = 'q8';
          onProgress({ progress: 50, message: 'Falling back to WASM quantized model...' });
          this.tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: progressCallback,
          });
        } else {
          throw primaryErr;
        }
      }

      this.state = 'ready';
      this.statusMessage = `Ready (${this.device.toUpperCase()})`;
      this.loadProgress = 100;
      this.lastUsedAt = Date.now();
      onProgress({ progress: 100, message: this.statusMessage });
      this.onStateChange({ state: this.state, message: this.statusMessage });
      return true;
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.statusMessage = `Load Error: ${err.message}`;
      console.error('KokoroEngine initialization error:', err);
      onProgress({ progress: 0, message: this.statusMessage, error: err.message });
      this.onStateChange({ state: this.state, message: this.statusMessage, error: err.message });
      return false;
    }
  }

  /**
   * Unloads the Kokoro ONNX model from WebGPU / WASM memory
   */
  async unload() {
    if (this.state === 'idle' && !this.tts) return false;

    const modelRef = this.tts;
    this.tts = null;
    this.state = 'idle';
    this.loadProgress = 0;
    this.lastUsedAt = 0;
    this.statusMessage = 'Unloaded (Memory freed)';

    if (modelRef) {
      try {
        if (typeof modelRef.dispose === 'function') {
          await modelRef.dispose();
        } else if (modelRef.model && typeof modelRef.model.dispose === 'function') {
          await modelRef.model.dispose();
        } else if (modelRef.model?.sessions) {
          for (const sess of Object.values(modelRef.model.sessions)) {
            if (sess && typeof sess.release === 'function') {
              await sess.release();
            }
          }
        }
      } catch (err) {
        console.warn('Error releasing Kokoro ONNX session:', err);
      }
    }

    this.onStateChange({ state: this.state, message: this.statusMessage });
    return true;
  }

  /**
   * Generates audio from text
   * @param {string} text
   * @param {string} voice
   * @param {number} speed
   * @returns {Promise<object|null>}
   */
  async generate(text, voice = 'af_sky', speed = 1.0) {
    if (this.state !== 'ready' || !this.tts) {
      throw new Error('Kokoro TTS engine is not initialized');
    }

    const trimmed = text.trim();
    if (!trimmed) return null;

    this.lastUsedAt = Date.now();

    // kokoro-js generate returns an audio object with .audio (Float32Array) and .sampling_rate
    const result = await this.tts.generate(trimmed, {
      voice,
      speed,
    });

    this.lastUsedAt = Date.now();
    return result;
  }
}

