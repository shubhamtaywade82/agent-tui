/**
 * Parser for tool calls written as text, for models that do not emit native
 * `tool_calls`. Two forms are recognised:
 *
 *   <function name="run_shell"><param name="command">ls</param></function>
 *   <tool_call>{"name": "run_shell", "arguments": {"command": "ls"}}</tool_call>
 *
 * Shared by the provider layer (which turns text into calls) and the TUI
 * (which renders them). Keeping one copy stops the two from drifting apart.
 */
import { log } from '../logger.js';

export interface TextToolCall {
  function: { name: string; arguments: any };
}

export function parseTextToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const fnRe = /<function\s+name="([^"]+)">([\s\S]*?)<\/function>/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text)) !== null) {
    const args: Record<string, any> = {};
    const paramRe = /<param\s+name="([^"]+)">([\s\S]*?)<\/param>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(m[2]!)) !== null) args[pm[1]!] = pm[2]!.trim();
    calls.push({ function: { name: m[1]!, arguments: args } });
  }
  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((m = tcRe.exec(text)) !== null) {
    try {
      const p = JSON.parse(m[1]!.trim());
      if (p.name) calls.push({ function: { name: p.name, arguments: p.arguments || {} } });
      else log.debug('ignored <tool_call> without a name');
    } catch (err) {
      // A malformed call is dropped, but the drop is visible in the log.
      log.debug('ignored malformed <tool_call>', { error: (err as Error).message });
    }
  }
  return calls;
}
