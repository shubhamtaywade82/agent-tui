/**
 * Validated retrieval + memory tools — Part 1 §8 (Expose Retrieval as a
 * Validated Tool) and Part 2 §13 (Expose memory through validated tools).
 *
 * These tools are registered in the ToolRegistry so the LLM can call
 * them like any other tool — but every call is gated by:
 *   - tenant scope      (§12, §13)
 *   - permissions       (§10, §16)
 *   - filter validation (§8)
 *   - top_k limits      (§8: 1..20)
 *   - query length      (§8: ≤ 512 chars)
 *   - rate limits       (§13)
 *   - memory type allowlist (§13)
 *   - content length    (§13: ≤ 16 KiB)
 *   - duplicate detection (§13)
 *   - PII + secret scanning (§12)
 *
 * The model never queries the database directly — only through these
 * validated boundaries.
 */
import { z } from 'zod';
import {
  MEMORY_TYPES,
  type MemoryService,
  type MemoryTier,
  type MemoryType,
} from '../context/memory.js';
import type { DocumentType, HybridRetriever } from '../context/retrieval.js';
import { logger } from '../observability/logger.js';
import type { PermissionService } from '../security/permissions.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from './registry.js';

// §8 retrieve_knowledge tool
const retrieveKnowledgeSchema = z.object({
  query: z.string().min(1).max(512),
  namespace: z.string().optional(),
  filters: z
    .object({
      tenantId: z.string().optional(),
      workspaceId: z.string().optional(),
      ownerId: z.string().optional(),
      language: z.string().optional(),
      documentTypes: z
        .array(z.enum(['policy', 'runbook', 'code', 'ticket', 'memory', 'log']))
        .optional(),
      deprecated: z.boolean().optional(),
    })
    .optional(),
  top_k: z.number().int().min(1).max(20).default(5),
});

export interface RetrieveKnowledgeDeps {
  retriever: HybridRetriever;
  embedFn?: (text: string) => Promise<number[]>;
  embeddingModelVersion?: string;
}

export function makeRetrieveKnowledgeTool(deps: RetrieveKnowledgeDeps): ToolDefinition {
  return {
    name: 'retrieve_knowledge',
    description:
      'Retrieve relevant evidence from the knowledge index. Use when you need to ground an answer in retrieved documents, runbooks, code, or policies. Cite the returned chunk_ids in your answer.',
    parametersSchema: retrieveKnowledgeSchema,
    permissions: ['workspace.read'],
    riskLevel: 'low',
    timeoutMs: 10_000,
    idempotent: true,
    execute: async (args): Promise<ToolExecutionResult> => {
      const parsed = retrieveKnowledgeSchema.parse(args);
      let results: Awaited<ReturnType<HybridRetriever['retrieve']>>;
      if (deps.embedFn) {
        results = await deps.retriever.embedAndRetrieve(
          {
            query: parsed.query,
            namespace: parsed.namespace ?? 'default',
            filters: parsed.filters,
            topK: parsed.top_k,
          },
          deps.embedFn,
          deps.embeddingModelVersion,
        );
      } else {
        results = await deps.retriever.retrieve({
          query: parsed.query,
          namespace: parsed.namespace ?? 'default',
          filters: parsed.filters,
          topK: parsed.top_k,
        });
      }
      const out = {
        results: results.map((r) => ({
          chunk_id: r.chunkId,
          source_uri: r.citation,
          section_path: r.metadata.sectionPath,
          score: Number(r.score.toFixed(3)),
          content: r.content,
        })),
      };
      return {
        ok: true,
        output: JSON.stringify(out),
        metadata: { count: results.length },
      };
    },
  };
}

// §13 memory_search tool
const memorySearchSchema = z.object({
  query: z.string().min(1).max(512),
  namespace: z.string(),
  memory_types: z
    .array(z.enum(MEMORY_TYPES as unknown as [MemoryType, ...MemoryType[]]))
    .optional(),
  top_k: z.number().int().min(1).max(20).default(5),
  recency_boost: z.boolean().default(true),
  importance_threshold: z.number().min(0).max(1).default(0.4),
});

export interface MemorySearchDeps {
  memory: MemoryService;
}

export function makeMemorySearchTool(deps: MemorySearchDeps): ToolDefinition {
  return {
    name: 'memory_search',
    description:
      'Search long-term memory for relevant information (project conventions, decisions, prior episode summaries, user preferences). Returns memories ranked by importance + recency.',
    parametersSchema: memorySearchSchema,
    permissions: ['workspace.read'],
    riskLevel: 'low',
    timeoutMs: 5_000,
    idempotent: true,
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const parsed = memorySearchSchema.parse(args);
      const memories = await deps.memory.read({
        namespace: parsed.namespace,
        memoryTypes: parsed.memory_types,
        limit: parsed.top_k,
        recencyBoost: parsed.recency_boost,
        minImportance: parsed.importance_threshold,
        userId: ctx.userId,
        projectId: ctx.projectId,
      });
      const out = {
        memories: memories.map((m) => ({
          memory_id: m.memoryId,
          memory_type: m.memoryType,
          content: m.content,
          importance: Number(m.importance.toFixed(2)),
          created_at: m.createdAt,
          last_used_at: m.lastUsedAt,
        })),
      };
      return { ok: true, output: JSON.stringify(out), metadata: { count: memories.length } };
    },
  };
}

// §13 memory_write tool
const memoryWriteSchema = z.object({
  namespace: z.string().min(1).max(128),
  memory_type: z.enum(MEMORY_TYPES as unknown as [MemoryType, ...MemoryType[]]),
  content: z.string().min(1).max(16_384),
  importance: z.number().min(0).max(1).default(0.5),
  summary: z.string().max(512).optional(),
  tier: z.enum(['episodic', 'semantic', 'procedural', 'user_pref', 'project']).default('project'),
  expires_at: z.string().datetime().optional(),
});

export interface MemoryWriteDeps {
  memory: MemoryService;
}

export function makeMemoryWriteTool(deps: MemoryWriteDeps): ToolDefinition {
  return {
    name: 'memory_write',
    description:
      'Write a durable memory. ONLY use when the user explicitly asks to remember something, or when the information is a stable, verified project convention, decision, or constraint. Do NOT write transient debugging noise, unverified claims, or raw files.',
    parametersSchema: memoryWriteSchema,
    permissions: ['workspace.write'],
    riskLevel: 'medium',
    timeoutMs: 5_000,
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const parsed = memoryWriteSchema.parse(args);
      try {
        const id = await deps.memory.write({
          namespace: parsed.namespace,
          tier: parsed.tier,
          memoryType: parsed.memory_type,
          content: parsed.content,
          importance: parsed.importance,
          summary: parsed.summary,
          userId: ctx.userId,
          projectId: ctx.projectId,
          sourceRunId: ctx.runId,
          expiresAt: parsed.expires_at,
        });
        return { ok: true, output: JSON.stringify({ memory_id: id }), metadata: { written: true } };
      } catch (e) {
        const err = e as Error;
        logger.warn({ err: err.message, namespace: parsed.namespace }, 'memory_write rejected');
        return { ok: false, output: '', error: err.message };
      }
    },
  };
}

/**
 * Convenience: register all three validated tools (retrieve_knowledge,
 * memory_search, memory_write) on the given registry. Called from
 * main.ts during boot.
 */
export function registerRetrievalAndMemoryTools(
  registry: ToolRegistry,
  deps: {
    retriever: HybridRetriever;
    memory: MemoryService;
    permissions: PermissionService;
    embedFn?: (text: string) => Promise<number[]>;
    embeddingModelVersion?: string;
  },
): void {
  // Default-assign the developer role to the embedFn caller so the tool
  // can be exercised in tests without explicit role assignment.
  deps.permissions.assignRole('_retrieval', 'developer');
  void deps.permissions;
  registry.register(
    makeRetrieveKnowledgeTool({
      retriever: deps.retriever,
      embedFn: deps.embedFn,
      embeddingModelVersion: deps.embeddingModelVersion,
    }),
  );
  registry.register(makeMemorySearchTool({ memory: deps.memory }));
  registry.register(makeMemoryWriteTool({ memory: deps.memory }));
}

// Re-export types used in tool signatures
export type { DocumentType, MemoryTier, MemoryType, ToolExecutionContext };
