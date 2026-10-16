/**
 * src/transcript/index.ts — barrel re-exports.
 *
 * Engine code imports from this barrel:
 *   ```ts
 *   import { createTranscriptCallbacks, makeThinkingEvent } from './transcript/index.js';
 *   ```
 *
 * The reducer + state live in `reducer.ts` for testability (no React import
 * chain to chase). Callbacks live in `callbacks.ts` because they need
 * `Dispatch` from React. The Ollama bridge lives in `ollama-bridge.ts`
 * because it depends on the SDK types.
 */
export * from './types.js';
export * from './reducer.js';
export * from './callbacks.js';
export * from './ollama-bridge.js';
