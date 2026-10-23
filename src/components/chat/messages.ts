/**
 * Builds the message list sent to the model: the system prompt, an optional
 * skill body, then the token-budgeted history.
 */
import { readFileSync } from 'node:fs';
import { findSkillFile } from '../../tools.js';
import { budgetMessages } from '../../utils/context.js';
import { GENUI_SYSTEM_INSTRUCTIONS } from '../../toolbox/genui.js';
import { defaultChatSystemPrompt, withUntrustedContentRule } from '../../prompts.js';
import type { ChatMessage } from './types.js';

const DEFAULT_SYSTEM_PROMPT = withUntrustedContentRule(defaultChatSystemPrompt(process.cwd(), GENUI_SYSTEM_INSTRUCTIONS));
export const prepareMessages = (h: ChatMessage[], skillName?: string, budget = 9000, compactionHint?: string | null): ChatMessage[] => {
  let prompt = DEFAULT_SYSTEM_PROMPT;
  if (skillName) {
    const file = findSkillFile(skillName);
    if (file) {
      try {
        const raw = readFileSync(file, 'utf8');
        const snippet = raw.length > 2500 ? raw.slice(0, 2500) + '\n...' : raw;
        prompt += `\n\n[AUTHORITATIVE SKILL: ${skillName}]\n${snippet}`;
      } catch {}
    }
  }
  return budgetMessages(h.some((m) => m.role === 'system') ? h : [{ role: 'system', content: prompt, timestamp: Date.now() }, ...h], budget, compactionHint);
};
