/**
 * `npm run supervisor:migrate` — idempotent schema bootstrap for a clean DB.
 *
 * Each subsystem owns its own `CREATE TABLE IF NOT EXISTS` DDL so schema and
 * code cannot drift (state §4, retrieval §6, memory §7); this runs every init
 * path in dependency order. Safe to re-run: all statements are idempotent.
 */

import { supervisorConfig } from '../config.js';
import { MemoryService } from '../context/memory.js';
import { HybridRetriever } from '../context/retrieval.js';
import { logger } from '../observability/logger.js';
import { PgStateStore } from '../state/store.js';

async function migrate(): Promise<void> {
  const dbUrl = supervisorConfig.database.url.replace(/:[^:@]+@/, ':***@');
  logger.info({ db: dbUrl }, 'applying supervisor schema');

  const store = new PgStateStore(supervisorConfig.database.url);
  await store.init(); // runs, steps, tool_calls, artifacts, events, approvals
  const retriever = new HybridRetriever();
  await retriever.init(); // chunks
  const memory = new MemoryService();
  await memory.init(); // memories, context_snapshots, checkpoints

  await Promise.all([store.close(), retriever.close(), memory.close()]);
  logger.info('schema up to date');
}

migrate().catch((e) => {
  logger.error({ err: e }, 'migration failed');
  process.exit(1);
});
