/**
 * Completion menu for the chat prompt: slash commands, /model and /skills arguments,
 * and prompt templates or history matches for free text.
 */
import { loadAvailableSkills, SLASH_COMMANDS } from '../../tools.js';

export const DEFAULT_PROMPTS = [
  'tell me about rails models and controllers', 'tell me about the architecture of this agent', 'tell me about available MCP tools and skills',
  'how to test and run the agent', 'what tools and skills are available', 'refactor this component for KISS', 'write unit tests for this function',
];

export function getMenuOptions(input: string, models: string[], ghost?: string, pool: string[] = []): Array<{ name: string; args?: string; desc: string }> {
  if (!input) return [];
  const low = input.toLowerCase();
  if (input.startsWith('/')) {
    if (!input.includes(' ')) return SLASH_COMMANDS.filter((c) => c.name.startsWith(low));
    if (input.startsWith('/model ')) return models.filter((m) => m.toLowerCase().includes(input.slice(7).toLowerCase())).map((m) => ({ name: `/model ${m}`, desc: `Switch to ${m}` }));
    if (input.startsWith('/skills ')) return loadAvailableSkills().filter((s) => s.name.includes(input.slice(8).toLowerCase())).slice(0, 10).map((s) => ({ name: `/skills ${s.name}`, desc: `${s.family}` }));
    return input.startsWith('/style ') ? ['box', 'line'].filter((s) => s.startsWith(input.slice(7))).map((s) => ({ name: `/style ${s}`, desc: `Style: ${s}` })) : [];
  }
  if (input.trim().length < 2) return [];
  const items: Array<{ name: string; desc: string }> = [];
  if (ghost && ghost !== input && ghost.toLowerCase().startsWith(low)) items.push({ name: ghost, desc: 'AI completion' });
  const seen = new Set(items.map((i) => i.name.toLowerCase()));
  const words = low.trim().split(/\s+/).filter(Boolean);
  for (const p of pool) {
    const pLow = p.toLowerCase();
    if (p !== input && words.every((w) => pLow.includes(w)) && !seen.has(pLow)) {
      items.push({ name: p, desc: pLow.startsWith(low) ? 'Prompt template' : 'History match' });
      seen.add(pLow);
      if (items.length >= 4) break;
    }
  }
  return items;
}
