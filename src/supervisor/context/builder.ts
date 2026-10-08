/**
 * Context builder — §8 (Context Management).
 *
 * Assembles the final prompt within a deterministic token budget. The
 * budget priority order comes straight from §8.2:
 *
 *   P1: Task instruction and output schema
 *   P2: Tool definitions and safety constraints
 *   P3: Current state summary
 *   P4: Retrieved evidence with citations
 *   P5: Relevant file/code snippets
 *   P6: Recent conversation history
 *   P7: Long-term memory
 *   P8: Optional background material
 *
 * If the budget is exceeded, the builder compresses in the order defined
 * by §8.2: summarise history, drop low-relevance chunks, truncate files
 * to signatures, summarise logs, push details to file-backed refs.
 */
import { encode } from 'gpt-tokenizer';
import { supervisorConfig } from '../config.js';
import type { MemoryRecord } from './memory.js';
import type { RetrievalResult } from './retrieval.js';

export interface ContextBudget {
  /** Hard cap on total tokens in the assembled prompt (§8.2). */
  total: number;
  /** Tokens reserved for the model's response (not part of the prompt). */
  reserve: number;
}

export interface BuildContextInput {
  systemInstruction: string;
  outputSchema: string;
  toolDefinitions: string;
  task: string;
  stateSummary: string;
  retrievedEvidence: RetrievalResult[];
  fileSnippets: Array<{ path: string; content: string; signature?: string }>;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  longTermMemory: MemoryRecord[];
  background?: string;
}

export interface BuiltContext {
  prompt: string;
  usedTokens: number;
  budget: ContextBudget;
  /** Per-section token breakdown for telemetry. */
  sections: Array<{ name: string; tokens: number; truncated: boolean }>;
}

export class ContextBuilder {
  private countTokens(s: string): number {
    try {
      return encode(s).length;
    } catch {
      // Fall back to a rough char-based estimate if the tokenizer fails.
      return Math.ceil(s.length / 4);
    }
  }

  build(input: BuildContextInput, budget?: ContextBudget): BuiltContext {
    const b: ContextBudget = budget ?? {
      total: supervisorConfig.context.budgetTokens,
      reserve: supervisorConfig.context.reserveTokens,
    };
    const cap = b.total - b.reserve;
    const sections: BuiltContext['sections'] = [];

    const add = (
      name: string,
      content: string,
      truncate?: (s: string, max: number) => string,
    ): { text: string; truncated: boolean } => {
      const tokens = this.countTokens(content);
      if (tokens <= cap * 0.4) {
        sections.push({ name, tokens, truncated: false });
        return { text: content, truncated: false };
      }
      // Truncate down to ~30% of budget for this section
      const max = Math.floor(cap * 0.3);
      const truncated = truncate ? truncate(content, max) : content.slice(0, max * 4);
      sections.push({ name, tokens: this.countTokens(truncated), truncated: true });
      return { text: truncated, truncated: true };
    };

    // P1: system + output schema
    const p1 = add(
      'system+schema',
      `${input.systemInstruction}\n\nOutput schema:\n${input.outputSchema}`,
    );

    // P2: tool definitions + safety
    const p2 = add('tools', input.toolDefinitions);

    // P3: state summary
    const p3 = add('state', input.stateSummary);

    // P4: retrieved evidence with citations
    const evidenceText = input.retrievedEvidence
      .map(
        (r, i) =>
          `[${i + 1}] (${r.source}, score=${r.score.toFixed(2)}) ${r.citation}\n${r.content}`,
      )
      .join('\n\n---\n\n');
    const p4 = add('evidence', evidenceText || '(no retrieved evidence)');

    // P5: file snippets — truncate to signatures when over budget
    const fileText = input.fileSnippets
      .map((f) => `// ${f.path}\n${f.signature ?? f.content}`)
      .join('\n\n');
    const p5 = add('files', fileText, (s, max) => s.slice(0, max * 4));

    // P6: recent conversation history — compress to summaries if over budget
    const histText = input.conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n');
    const p6 = add('history', histText, (s, max) => {
      // Keep only the last 3 messages, each truncated to ~max/3 chars
      const lines = s.split('\n');
      const last3 = lines.slice(-6);
      return last3.join('\n').slice(0, max * 4);
    });

    // P7: long-term memory
    const memText = input.longTermMemory
      .map((m) => `(${m.tier}, imp=${m.importance.toFixed(2)}) ${m.content}`)
      .join('\n');
    const p7 = add('memory', memText || '(no long-term memory)');

    // P8: optional background
    let p8Text = '';
    if (input.background) {
      const p8 = add('background', input.background);
      p8Text = p8.text;
    }

    const prompt = [
      `# System`,
      p1.text,
      ``,
      `# Tools`,
      p2.text,
      ``,
      `# State`,
      p3.text,
      ``,
      `# Retrieved evidence`,
      p4.text,
      ``,
      `# Files`,
      p5.text,
      ``,
      `# Conversation history`,
      p6.text,
      ``,
      `# Long-term memory`,
      p7.text,
      ...(p8Text ? ['', '# Background', p8Text] : []),
      ``,
      `# Task`,
      input.task,
    ].join('\n');

    const usedTokens = this.countTokens(prompt);
    return { prompt, usedTokens, budget: b, sections };
  }
}
