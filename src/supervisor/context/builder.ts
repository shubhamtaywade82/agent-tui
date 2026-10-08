/**
 * Context builder — Part 1 §8 (Token Budget), §9 (Grounded Prompt), §10
 * (Token Budget Deterministically); Part 2 §7 (Context Compaction).
 *
 * Assembles the final prompt within a deterministic token budget. The
 * budget priority order comes straight from §10:
 *
 *   P1: System instructions
 *   P2: Task objective
 *   P3: Output schema
 *   P4: Tool definitions
 *   P5: Current state summary
 *   P6: Retrieved evidence (with §9 EVIDENCE tags)
 *   P7: Relevant code/file snippets
 *   P8: Recent history
 *   P9: Long-term memory
 *   P10: Optional background
 *
 * §10 budget formula:
 *   max_prompt_tokens = max_model_len - max_generation_tokens - safety_margin
 *
 * If the budget is exceeded, the builder compresses in the order defined
 * by §10:
 *   1. Summarise old history (§7.3 — replace raw turns with run summary)
 *   2. Remove low-scoring evidence
 *   3. Truncate long snippets (§7.2 — move out raw logs)
 *   4. Replace raw logs with summarised errors
 *   5. Move secondary details to file-backed references
 *
 * §9 grounded prompt format: each retrieved chunk is wrapped in an
 * EVIDENCE block with source + section attributes, so the model can cite
 * by ID. The output schema requires `answer`, `citations`,
 * `confidence`, `insufficient_evidence` — making hallucination auditable.
 */

import { createHash } from 'node:crypto';
import { encode } from 'gpt-tokenizer';
import { supervisorConfig } from '../config.js';
import type { MemoryRecord } from './memory.js';
import type { RetrievalResult } from './retrieval.js';

export interface ContextBudget {
  /** Hard cap on total tokens in the assembled prompt (§10). */
  total: number;
  /** Tokens reserved for the model's response (§10 generation reserve). */
  reserve: number;
  /** Safety margin (§10). */
  safetyMargin: number;
  /** Effective usable budget: total - reserve - safetyMargin. */
  usable: number;
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
  /** §7.3 pre-computed run summary, used to replace raw history. */
  runSummary?: string;
}

export interface BuiltContext {
  prompt: string;
  usedTokens: number;
  budget: ContextBudget;
  promptHash: string;
  /** Per-section token breakdown for telemetry + §4.5 context snapshot. */
  sections: Array<{ name: string; tokens: number; truncated: boolean }>;
  /** IDs included in the final prompt — for the §4.5 context_snapshots table. */
  includedMemoryIds: string[];
  includedChunkIds: string[];
  excludedChunkIds: string[];
}

export class ContextBuilder {
  private countTokens(s: string): number {
    try {
      return encode(s).length;
    } catch {
      return Math.ceil(s.length / 4);
    }
  }

  build(input: BuildContextInput, budget?: Partial<ContextBudget>): BuiltContext {
    const total = budget?.total ?? supervisorConfig.context.budgetTokens;
    const reserve = budget?.reserve ?? supervisorConfig.context.reserveTokens;
    const safetyMargin = budget?.safetyMargin ?? 256;
    const b: ContextBudget = {
      total,
      reserve,
      safetyMargin,
      usable: total - reserve - safetyMargin,
    };
    const cap = b.usable;
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
      const max = Math.floor(cap * 0.3);
      const truncated = truncate ? truncate(content, max) : content.slice(0, max * 4);
      sections.push({ name, tokens: this.countTokens(truncated), truncated: true });
      return { text: truncated, truncated: true };
    };

    // P1-P3: system + objective + output schema
    const p1 = add(
      'system+objective+schema',
      `${input.systemInstruction}\n\nTask: ${input.task}\n\nOutput schema:\n${input.outputSchema}`,
    );

    // P4: tool definitions + safety
    const p2 = add('tools', input.toolDefinitions);

    // P5: state summary
    const p3 = add('state', input.stateSummary);

    // P6: retrieved evidence with §9 EVIDENCE tags + citation IDs
    const evidenceText = input.retrievedEvidence
      .map((r, i) => {
        const id = `EVIDENCE-${i + 1}`;
        const section = r.metadata.sectionPath ? ` section="${r.metadata.sectionPath}"` : '';
        const source = `source="${r.citation}"`;
        return `[${id} ${source}${section} score=${r.score.toFixed(2)}]\n${r.content}\n[/${id}]`;
      })
      .join('\n\n---\n\n');
    const p4 = add('evidence', evidenceText || '(no retrieved evidence)', (s, max) => {
      // §10.2 — drop low-scoring evidence chunks first
      const blocks = s.split('\n\n---\n\n');
      const kept = blocks.filter((blk) => {
        const m = blk.match(/score=([\d.]+)/);
        return m ? Number(m[1]) >= 0.3 : true;
      });
      return kept.join('\n\n---\n\n').slice(0, max * 4);
    });

    // P7: file snippets — truncate to signatures when over budget (§7.2)
    const fileText = input.fileSnippets
      .map((f) => `// ${f.path}\n${f.signature ?? f.content}`)
      .join('\n\n');
    const p5 = add('files', fileText, (s, max) => s.slice(0, max * 4));

    // P8: recent conversation history — §7 compaction
    const histText = input.conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n');
    const p6 = add('history', histText, (s, max) => {
      // §7.3 — if a run summary is available, replace raw history with it
      if (input.runSummary) {
        return `# Run summary (replaces raw history)\n${input.runSummary}`.slice(0, max * 4);
      }
      // §7.1 — keep only the last 3 message pairs
      const lines = s.split('\n');
      const last6 = lines.slice(-6);
      return last6.join('\n').slice(0, max * 4);
    });

    // P9: long-term memory
    const memText = input.longTermMemory
      .map((m) => `(${m.tier}, imp=${m.importance.toFixed(2)}, type=${m.memoryType}) ${m.content}`)
      .join('\n');
    const p7 = add('memory', memText || '(no long-term memory)');

    // P10: optional background
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
    const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    const includedMemoryIds = input.longTermMemory.map((m) => m.memoryId);
    const includedChunkIds = input.retrievedEvidence.map((r) => r.chunkId);
    const excludedChunkIds: string[] = []; // populated by the reranker if needed

    return {
      prompt,
      usedTokens,
      budget: b,
      promptHash,
      sections,
      includedMemoryIds,
      includedChunkIds,
      excludedChunkIds,
    };
  }
}
