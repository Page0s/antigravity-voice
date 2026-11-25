/**
 * Server/Hook Sanitizer Facade
 * Re-exports the single canonical text pipeline from sidecars/voice-panel/lib/sanitizer.js
 * so lifecycle hooks, tests, and the browser sidecar UI never drift out of sync.
 */

export {
  DEFAULT_FILTER_OPTIONS,
  OUTPUT_PROFILES,
  chunkSentences,
  detectMatchingProfile,
  formatFilterStatsSummary,
  processForSpeech,
  resolveFilterOptions,
  sanitizeText,
} from '../sidecars/voice-panel/lib/sanitizer.js';
