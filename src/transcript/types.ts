/**
 * src/transcript/types.ts
 *
 * The full transcript event model for agent-tui. This is the artifact that
 * survives step 1's throwaway PoC — the discriminated-union event types and
 * the action types that the reducer consumes.
 *
 * DESIGN RULE (enforced by `callbacks.ts`): the agent engine NEVER touches
 * UI state directly. It calls `cb.add(...)`, `cb.append(...)`, `cb.patch(...)`,
 * `cb.finish(...)` on a callbacks object. That contract is what lets us
 * later swap renderers (TUI today, the HTTP SSE server tomorrow) without
 * touching engine code — every renderer consumes the same action stream.
 *
 * Every future feature (metrics dashboard, elicitation dialog, DiffView,
 * MCP events, context compaction) is just a new event kind plus a renderer.
 * Add it here first, then add a renderer in the UI layer.
 */

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

/** Task lifecycle status — mirrors `TaskStatus` from src/tasks.ts. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

/** Tool execution status (mirrors what `executeToolCalls` produces). */
export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'blocked';

/** MCP server connection status. */
export type McpStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** User response to an elicitation prompt. */
export type ElicitationChoice = 'allow_once' | 'allow_session' | 'deny';

/** Token usage scopes (matches ollama-sdk's `UsageScope`). */
export type UsageScope = 'input' | 'output' | 'thinking' | 'total';

/** File operation kind — drives DiffView rendering in step 4. */
export type FileOpKind = 'read' | 'write' | 'edit' | 'delete' | 'rename';

/* ------------------------------------------------------------------ *
 * Event kinds
 *
 * Every event has a stable `id` (engine-generated, monotonically increasing
 * within a session) and a `kind` for the discriminated union. Events that
 * stream (`thinking`, `assistant`) carry a `streaming` flag that `finish`
 * flips to false. All other events are atomic.
 * ------------------------------------------------------------------ */

export interface UserEvent {
  readonly kind: 'user';
  readonly id: number;
  readonly text: string;
  readonly timestamp: number;
}

export interface ThinkingEvent {
  readonly kind: 'thinking';
  readonly id: number;
  /** Accumulated reasoning tokens. The `append` action patches this in place. */
  readonly text: string;
  /** True while the model is still producing thinking tokens. */
  readonly streaming: boolean;
  readonly timestamp: number;
  /** Set when `finish` runs — wall-clock duration of the thinking phase. */
  readonly durationMs?: number;
}

export interface AssistantEvent {
  readonly kind: 'assistant';
  readonly id: number;
  /** Accumulated answer tokens. The `append` action patches this in place. */
  readonly text: string;
  readonly streaming: boolean;
  readonly timestamp: number;
  /** Tool calls attached to this assistant turn (added when the model emits them). */
  readonly toolCallIds?: readonly number[];
  /** Set when `finish` runs — wall-clock duration of the answer phase. */
  readonly durationMs?: number;
}

export interface PlanEvent {
  readonly kind: 'plan';
  readonly id: number;
  readonly taskId: string;
  readonly title: string;
  readonly objective: string;
  readonly status: PlanStatus;
  /** Attempts so far (matches Task.attempts). */
  readonly attempts: number;
  /** Max attempts before blocking (matches Task.maxAttempts). */
  readonly maxAttempts: number;
  readonly timestamp: number;
  /** Patched when the task fails — short reason. */
  readonly failureReason?: string;
  /** Patched when the task completes — short note. */
  readonly note?: string;
}

export interface ToolEvent {
  readonly kind: 'tool';
  readonly id: number;
  /** SDK-synthesized tool call id (see ollama-sdk ToolCall.id). */
  readonly toolCallId?: string;
  readonly name: string;
  /** Args as the model emitted them (JSON object). */
  readonly arguments: Record<string, unknown>;
  readonly status: ToolStatus;
  readonly timestamp: number;
  /** Patched when execution finishes — stringified result (possibly truncated). */
  readonly result?: string;
  /** Patched when execution errors — short reason. */
  readonly error?: string;
  /** Wall-clock duration of the call, patched on completion. */
  readonly durationMs?: number;
}

export interface FileOpEvent {
  readonly kind: 'file_op';
  readonly id: number;
  readonly op: FileOpKind;
  readonly path: string;
  /** For `rename`, the destination path. */
  readonly toPath?: string;
  readonly timestamp: number;
  /** For `read`/`write`/`edit` — the content (possibly truncated). */
  readonly content?: string;
  /** For `edit` — the original content (DiffView `before`). */
  readonly before?: string;
  /** For `edit` — the new content (DiffView `after`). */
  readonly after?: string;
  /** Byte count of the affected file, for the metrics dashboard. */
  readonly bytes?: number;
}

export interface McpEvent {
  readonly kind: 'mcp';
  readonly id: number;
  readonly server: string;
  readonly status: McpStatus;
  readonly timestamp: number;
  /** For `error` status — short reason. */
  readonly error?: string;
  /** For tool-invoked events — the tool name + args. */
  readonly toolName?: string;
  readonly toolArgs?: Record<string, unknown>;
}

export interface ErrorEvent {
  readonly kind: 'error';
  readonly id: number;
  /** Short category (e.g. 'ollama_unreachable', 'tool_loop', 'rate_limit'). */
  readonly category: string;
  readonly message: string;
  readonly timestamp: number;
  /** Stack trace or longer context if available. */
  readonly detail?: string;
}

export interface ElicitationEvent {
  readonly kind: 'elicitation';
  readonly id: number;
  /** Tool name that triggered the prompt (e.g. 'write_file'). */
  readonly toolName: string;
  /** Args the model requested — shown to the user for confirmation. */
  readonly arguments: Record<string, unknown>;
  /** Short prompt text shown above the choices. */
  readonly prompt: string;
  readonly timestamp: number;
  /** Patched when the user responds. */
  readonly choice?: ElicitationChoice;
  /** Patched when the user responds — wall-clock duration of the prompt. */
  readonly resolvedAt?: number;
}

export interface UsageEvent {
  readonly kind: 'usage';
  readonly id: number;
  /** Scope of the tokens (input / output / thinking / total). */
  readonly scope: UsageScope;
  /** Token count for this scope. */
  readonly tokens: number;
  /** Model context window — used by the metrics dashboard to show remaining. */
  readonly contextWindow: number;
  readonly timestamp: number;
}

/* ------------------------------------------------------------------ *
 * The discriminated union
 * ------------------------------------------------------------------ */

export type TranscriptEvent =
  | UserEvent
  | ThinkingEvent
  | AssistantEvent
  | PlanEvent
  | ToolEvent
  | FileOpEvent
  | McpEvent
  | ErrorEvent
  | ElicitationEvent
  | UsageEvent;

/** Event kinds that accept `append` (streaming text). */
export type StreamingKind = 'thinking' | 'assistant';

/** All event kinds as a string literal union — useful for `assertNever` patterns. */
export type TranscriptKind = TranscriptEvent['kind'];

/* ------------------------------------------------------------------ *
 * Action types
 *
 * `append` is the hot path — it runs per token (up to ~50/sec in practice,
 * proven in scratch/transcript-poc.tsx). Keep it allocation-cheap: it
 * `map`s the events array, finds the matching id, and replaces the `text`
 * field. No deep clone.
 * ------------------------------------------------------------------ */

export interface AddAction {
  readonly type: 'add';
  readonly ev: TranscriptEvent;
}

export interface AppendAction {
  readonly type: 'append';
  readonly id: number;
  readonly delta: string;
}

export interface PatchAction {
  readonly type: 'patch';
  readonly id: number;
  /**
   * Partial patch merged onto the existing event. The reducer validates
   * that the patch's keys are legal for the event's kind — see reducer.
   */
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface FinishAction {
  readonly type: 'finish';
  readonly id: number;
  /** Optional duration to stamp onto the event (e.g. thinking/answer phase). */
  readonly durationMs?: number;
}

export interface TruncateAction {
  readonly type: 'truncate';
  /** Drop events at index < N. Used by context compaction. */
  readonly keepFromIndex: number;
}

export interface ClearAction {
  readonly type: 'clear';
}

export type TranscriptAction =
  | AddAction
  | AppendAction
  | PatchAction
  | FinishAction
  | TruncateAction
  | ClearAction;

/* ------------------------------------------------------------------ *
 * State shape
 * ------------------------------------------------------------------ */

export interface TranscriptState {
  readonly events: readonly TranscriptEvent[];
  /** Monotonic counter — engine reads this to mint new event ids. */
  readonly nextId: number;
}

export const initialTranscriptState: TranscriptState = { events: [], nextId: 1 };

/** Mint a new event id from the state's counter. */
export function mintId(state: TranscriptState): number {
  return state.nextId;
}
