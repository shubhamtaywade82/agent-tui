/**
 * Golden task suite — §15.3 (Evaluation Strategy).
 *
 * A fixed set of tasks with known-good expectations, used to detect
 * regressions when prompts, retrieval indexes, or models change. The
 * suite is run by `npm run supervisor:evals` against the MockBackend so
 * no GPU cycles are spent on regression runs.
 */
import type { Intent } from '../state/models.js';

export interface GoldenTask {
  id: string;
  description: string;
  query: string;
  expectedIntent: Intent;
  /** Substrings the final response must contain (case-insensitive). */
  expectedResponseContains?: string[];
  /** Tools the run is expected to invoke (in any order). */
  expectedToolsCalled?: string[];
  /** True if the task should escalate to the fallback model. */
  expectedEscalates?: boolean;
  /** Tags for grouping in the eval dashboard. */
  tags: string[];
}

const TASKS: GoldenTask[] = [
  {
    id: 'qa-001',
    description: 'Simple Q&A — should route to analyst, no-think mode',
    query: 'What is the capital of France?',
    expectedIntent: 'GENERAL_QUERY',
    expectedResponseContains: ['paris'],
    tags: ['qa', 'routing', 'no-think'],
  },
  {
    id: 'sum-001',
    description: 'Log summarisation — should route to summarizer',
    query:
      'Summarize these logs:\n2026-01-01 ERROR db connection refused\n2026-01-01 WARN retry in 5s',
    expectedIntent: 'LOG_SUMMARIZATION',
    expectedResponseContains: ['db', 'connection'],
    tags: ['summarization', 'routing'],
  },
  {
    id: 'tool-001',
    description: 'Tool execution — should produce a tool call',
    query: 'Check the status of deployment pipeline for checkout-service.',
    expectedIntent: 'TOOL_EXECUTION',
    expectedToolsCalled: ['get_pipeline_status'],
    tags: ['tool', 'routing'],
  },
  {
    id: 'extract-001',
    description: 'Data extraction — should route to analyst with retrieval',
    query: 'Extract all error codes from this runbook: https://example.com/runbook',
    expectedIntent: 'DATA_EXTRACTION',
    tags: ['extraction', 'routing'],
  },
  {
    id: 'review-001',
    description: 'Code review — security-sensitive, should engage think mode',
    query:
      'Review this function for security flaws: def get_user(id): return db.query(f"SELECT * FROM users WHERE id = {id}")',
    expectedIntent: 'CODE_REVIEW',
    expectedResponseContains: ['sql', 'injection'],
    tags: ['review', 'security', 'think'],
  },
  {
    id: 'esc-001',
    description: 'Multi-file refactor — should escalate to fallback',
    query:
      'Refactor the entire authentication subsystem across all microservices to use OAuth2 with PKCE.',
    expectedIntent: 'CODE_REVIEW',
    expectedEscalates: true,
    tags: ['escalation', 'complex'],
  },
  {
    id: 'esc-002',
    description: 'Production deploy — should escalate and require approval',
    query: 'Deploy the new payment service to production and roll back if error rate exceeds 1%.',
    expectedIntent: 'TOOL_EXECUTION',
    expectedEscalates: true,
    tags: ['escalation', 'production', 'approval'],
  },
  {
    id: 'unknown-001',
    description: 'Ambiguous query — should fall back to UNKNOWN intent',
    query: 'foo bar baz qux',
    expectedIntent: 'UNKNOWN',
    tags: ['routing', 'unknown'],
  },
  {
    id: 'repair-001',
    description: 'Repair loop — invalid tool args should be repaired',
    query: 'Send an email to the team about the failed deployment.',
    expectedIntent: 'TOOL_EXECUTION',
    expectedToolsCalled: ['send_email'],
    tags: ['repair', 'tool'],
  },
  {
    id: 'rag-001',
    description: 'RAG-grounded answer — must cite retrieved evidence',
    query: 'What is the on-call escalation policy for the checkout service?',
    expectedIntent: 'GENERAL_QUERY',
    expectedResponseContains: ['evidence'],
    tags: ['rag', 'citation'],
  },
];

export class GoldenTaskSuite {
  all(): readonly GoldenTask[] {
    return TASKS;
  }

  byId(id: string): GoldenTask | undefined {
    return TASKS.find((t) => t.id === id);
  }

  byTag(tag: string): GoldenTask[] {
    return TASKS.filter((t) => t.tags.includes(tag));
  }
}
