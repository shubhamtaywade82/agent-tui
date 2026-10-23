/**
 * Message shapes used by the TUI chat and its helpers.
 */
import type { Message } from '@nemesis-oss/ollama-sdk';

export interface ChatMessage extends Message { timestamp?: number; thinking?: string; tokens?: number; skill?: string; }
