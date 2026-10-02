/**
 * Embeddings & Retrieval-Augmented Generation (RAG) tools.
 *
 * `index_document` chunks and embeds a text file into a local vector store.
 * `semantic_search` finds the most relevant passages for a query and returns
 * them as context. Supports any provider that implements `embed()`
 * (Ollama or OpenAI-compatible).
 *
 * The vector store is a simple JSON file per corpus — no external database
 * required, which keeps the personal-use agent fully self-contained.
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';
import { getProviderAsync, type LLMProvider } from '../providers.js';
import { loadConfig, resolvePath } from '../config.js';
import { log } from '../logger.js';

interface VectorRecord { id: string; text: string; embedding: number[]; source: string; chunkIndex: number; }
interface VectorStore { model: string; dimension: number; records: VectorRecord[]; }

function storePath(name: string): string {
  const cfg = loadConfig();
  return resolvePath(`${cfg.sessionsDir.replace(/\/sessions$/, '/rag')}/${name}.json`);
}

function chunkText(text: string, size = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i += size - overlap;
  }
  return chunks.length ? chunks : [text];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; magA += a[i]! ** 2; magB += b[i]! ** 2; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

async function embedTexts(provider: LLMProvider, model: string, texts: string[]): Promise<number[][]> {
  const vectors = await provider.embed(model, texts);
  return vectors.map((v) => [...v]);
}

/** Index a document (file or directory) into a named vector store. */
export const indexDocumentTool = defineTool({
  name: 'index_document',
  description: 'Chunk and embed a text document (or all text files in a directory) into a local vector store for later semantic search. Supports .txt, .md, .json, .ts, .js, .py, .csv.',
  schema: z.object({
    path: z.string().describe('Path to a file or directory to index'),
    storeName: z.string().describe('Name for the vector store (e.g. "myproject")'),
    chunkSize: z.number().int().min(200).max(4000).optional().describe('Chunk size in chars (default 800)'),
    model: z.string().optional().describe('Embedding model (default nomic-embed-text for Ollama)'),
  }),
  timeoutMs: 180_000,
  execute: async ({ path, storeName, chunkSize, model }) => {
    const provider = await getProviderAsync();
    const embedModel = model ?? (provider.name === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small');
    const abs = resolvePath(path);
    if (!existsSync(abs)) return `Path not found: ${abs}`;

    const files = statSync(abs).isDirectory()
      ? readdirSync(abs).filter((f) => /\.(txt|md|json|ts|js|py|csv|tsx|jsx)$/i.test(extname(f))).map((f) => join(abs, f))
      : [abs];

    if (!files.length) return 'No text files found to index.';

    const allRecords: VectorRecord[] = [];
    const storeFile = storePath(storeName);
    let existing: VectorStore = { model: embedModel, dimension: 0, records: [] };
    if (existsSync(storeFile)) {
      try { existing = JSON.parse(readFileSync(storeFile, 'utf8')); } catch {}
    }

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const chunks = chunkText(text, chunkSize ?? 800);
      const vectors = await embedTexts(provider, embedModel, chunks);
      for (let i = 0; i < chunks.length; i++) {
        allRecords.push({
          id: `${basename(file)}#${i}`,
          text: chunks[i]!,
          embedding: vectors[i]!,
          source: file,
          chunkIndex: i,
        });
      }
    }

    existing.records = [...existing.records.filter((r) => !files.includes(r.source)), ...allRecords];
    existing.model = embedModel;
    existing.dimension = allRecords[0]?.embedding.length ?? existing.dimension;

    mkdirSync(resolve(storeFile, '..'), { recursive: true });
    writeFileSync(storeFile, JSON.stringify(existing), 'utf8');
    log.info('Document indexed', { store: storeName, files: files.length, chunks: allRecords.length, model: embedModel });
    return `Indexed ${files.length} file(s), ${allRecords.length} chunks into store "${storeName}" using ${embedModel}. Store saved to ${storeFile}`;
  },
});

/** Semantic search over an indexed vector store. */
export const semanticSearchTool = defineTool({
  name: 'semantic_search',
  description: 'Search a local vector store for passages semantically similar to a query. Returns the top-K most relevant chunks with their source and similarity score.',
  schema: z.object({
    query: z.string().describe('The search query'),
    storeName: z.string().describe('Name of the vector store to search'),
    topK: z.number().int().min(1).max(20).optional().describe('Number of results (default 5)'),
    model: z.string().optional().describe('Embedding model used at index time'),
  }),
  timeoutMs: 30_000,
  execute: async ({ query, storeName, topK, model }) => {
    const storeFile = storePath(storeName);
    if (!existsSync(storeFile)) return `Vector store "${storeName}" not found at ${storeFile}. Index documents first with index_document.`;
    const store: VectorStore = JSON.parse(readFileSync(storeFile, 'utf8'));
    if (!store.records.length) return `Store "${storeName}" is empty.`;

    const provider = await getProviderAsync();
    const embedModel = model ?? store.model;
    const [queryVec] = await embedTexts(provider, embedModel, [query]);

    const scored = store.records
      .map((r) => ({ record: r, score: cosineSimilarity(queryVec, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK ?? 5);

    const out = scored.map((s, i) =>
      `[${i + 1}] score=${s.score.toFixed(3)} | source=${s.record.source}#${s.record.chunkIndex}\n${s.record.text.slice(0, 400)}${s.record.text.length > 400 ? '...' : ''}`
    ).join('\n\n---\n\n');
    log.info('Semantic search', { store: storeName, query: query.slice(0, 50), results: scored.length });
    return out || 'No matching passages found.';
  },
});

/** List all available local vector stores. */
export const listStoresTool = defineTool({
  name: 'list_vector_stores',
  description: 'List all local RAG vector stores available for semantic_search.',
  schema: z.object({}),
  execute: async () => {
    const cfg = loadConfig();
    const dir = resolvePath(`${cfg.sessionsDir.replace(/\/sessions$/, '/rag')}`);
    if (!existsSync(dir)) return 'No vector stores found. Use index_document to create one.';
    const stores = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    if (!stores.length) return 'No vector stores found.';
    return stores.map((s, i) => `${i + 1}. ${s}`).join('\n');
  },
});

export const ragTools = [indexDocumentTool, semanticSearchTool, listStoresTool];
