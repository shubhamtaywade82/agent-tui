export interface ContextMessage {
  role?: any;
  content: string;
  tool_calls?: readonly any[] | any[];
  tool_call_id?: string;
  timestamp?: number;
  [key: string]: any;
}

export const estimateTokens = (text: string): number => Math.ceil((text || '').length / 3.5);

/** llama.cpp-style expansion: tool JSON in prompt ≈ chars / 2.2 */
export function estimateToolSchemaTokens(toolDefs: unknown): number {
  if (!toolDefs) return 0;
  try {
    return Math.ceil(JSON.stringify(toolDefs).length / 2.2);
  } catch {
    return 0;
  }
}

/**
 * Message history token budget from model window minus tools, response reserve,
 * and configured ceiling (AGENT_CONTEXT_BUDGET).
 */
export function resolveMessageTokenBudget(params: {
  configuredBudget: number;
  numCtx?: number;
  toolDefs?: unknown;
  reserveTokens?: number;
  minBudget?: number;
}): number {
  const min = params.minBudget ?? 2048;
  const reserve = params.reserveTokens ?? 4096;
  const toolTokens = estimateToolSchemaTokens(params.toolDefs);
  if (params.numCtx && params.numCtx > 0) {
    const fromWindow = params.numCtx - toolTokens - reserve;
    return Math.max(min, Math.min(params.configuredBudget, fromWindow));
  }
  const headroom = Math.max(min, params.configuredBudget - toolTokens);
  return headroom;
}

export function truncateToolOutput(raw: string, maxChars = 3500): string {
  if (!raw || raw.length <= maxChars) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 15) {
        const sliced = arr.slice(-15);
        const header = `[Showing latest 15 of ${arr.length} records for context efficiency]:\n`;
        const res = header + JSON.stringify(sliced, null, 2);
        if (res.length <= maxChars) return res;
      }
    } catch {}
  }
  const slicePoint = Math.max(0, maxChars - 80);
  const cleanSlice = raw.slice(0, slicePoint);
  return `${cleanSlice}\n... [truncated ${raw.length - slicePoint} chars to fit context window]`;
}

export function budgetMessages<T extends ContextMessage>(
  messages: T[],
  maxTokens = 9000,
  compactionHint?: string | null,
): T[] {
  if (!messages.length) return [];
  let systemMsg = messages.find((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (!nonSystem.length) return systemMsg ? [systemMsg] : [];

  const pruned: T[] = nonSystem.map((msg, idx) => {
    const isLatestTurn = idx >= nonSystem.length - 2;
    if (!isLatestTurn && msg.role === 'tool' && (msg.content || '').length > 200) {
      return { ...msg, content: `[Tool execution completed: output compacted for context budget]` };
    }
    return msg;
  });

  let totalTokens = (systemMsg ? estimateTokens(systemMsg.content) : 0) + pruned.reduce((acc, m) => acc + estimateTokens(m.content), 0);
  let startIdx = 0;
  while (totalTokens > maxTokens && startIdx < pruned.length - 1) {
    totalTokens -= estimateTokens(pruned[startIdx]!.content);
    startIdx++;
  }

  const windowed = startIdx > 0 ? pruned.slice(startIdx) : pruned;
  if (startIdx > 0 && compactionHint) {
    const extra = `\n\n${compactionHint}`;
    if (systemMsg) {
      systemMsg = { ...systemMsg, content: (systemMsg.content || '') + extra };
    } else {
      systemMsg = { role: 'system', content: compactionHint } as T;
    }
  }
  return systemMsg ? [systemMsg, ...windowed] : windowed;
}
