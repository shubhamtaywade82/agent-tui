/**
 * Tree-sitter code indexer — §12.1 (Repository Understanding).
 *
 * Builds a symbol index from source files using tree-sitter. The index
 * powers the §6 retrieval layer (chunks are emitted with namespace
 * `code:${projectId}`) and the §8 context builder (file snippets can be
 * trimmed to symbol signatures).
 *
 * Supported languages: TypeScript, JavaScript, Python. Adding a new
 * language is a one-liner: register its grammar in `LANGUAGES`.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';
import type { HybridRetriever } from '../context/retrieval.js';

const LANGUAGES = {
  '.ts': { parser: TypeScript.typescript, name: 'typescript' },
  '.tsx': { parser: TypeScript.tsx, name: 'typescript' },
  '.mts': { parser: TypeScript.typescript, name: 'typescript' },
  '.js': { parser: JavaScript, name: 'javascript' },
  '.jsx': { parser: JavaScript, name: 'javascript' },
  '.mjs': { parser: JavaScript, name: 'javascript' },
  '.py': { parser: Python, name: 'python' },
} as const;

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'import';
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  language: string;
}

export interface IndexedFile {
  path: string;
  language: string;
  sizeBytes: number;
  symbols: SymbolInfo[];
  chunks: Array<{ startLine: number; endLine: number; content: string }>;
}

export class CodeIndexer {
  constructor(private readonly retriever?: HybridRetriever) {}

  /**
   * Index a single file. Returns the parsed symbols and the chunks that
   * should be ingested into the retrieval index. If a `HybridRetriever`
   * is wired in, chunks are also ingested under namespace `code:<projectId>`.
   */
  async indexFile(
    filePath: string,
    opts: { projectId?: string; root?: string } = {},
  ): Promise<IndexedFile> {
    const ext = extname(filePath).toLowerCase();
    const lang = LANGUAGES[ext as keyof typeof LANGUAGES];
    if (!lang) {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    const source = readFileSync(filePath, 'utf8');
    const parser = new Parser();
    // Cast to satisfy the tree-sitter Language type — the grammar modules
    // export a compatible shape even when their .d.ts disagrees slightly.
    parser.setLanguage(lang.parser as unknown as Parameters<Parser['setLanguage']>[0]);
    const tree = parser.parse(source);
    const symbols = this.extractSymbols(tree.rootNode, source, filePath, lang.name);

    const root = opts.root ?? resolve('.');
    const relPath = relative(root, filePath).split(sep).join('/');

    // Chunk the file into ~50-line windows aligned on symbol boundaries
    const chunks = this.chunkFile(source, symbols, 50);

    if (this.retriever && opts.projectId) {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        await this.retriever.ingest({
          namespace: `code:${opts.projectId}`,
          sourceUri: `file://${relPath}#L${c.startLine}-L${c.endLine}`,
          content: c.content,
          metadata: {
            file: relPath,
            language: lang.name,
            startLine: c.startLine,
            endLine: c.endLine,
          },
        });
      }
    }

    return {
      path: relPath,
      language: lang.name,
      sizeBytes: statSync(filePath).size,
      symbols,
      chunks,
    };
  }

  private extractSymbols(
    node: Parser.SyntaxNode,
    source: string,
    filePath: string,
    language: string,
  ): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const SYMBOL_TYPES = new Set([
      'function_declaration',
      'function_definition',
      'class_declaration',
      'class_definition',
      'method_definition',
      'method_declaration',
      'import_statement',
    ]);

    const walk = (n: Parser.SyntaxNode) => {
      if (SYMBOL_TYPES.has(n.type)) {
        const nameNode =
          n.childForFieldName('name') ??
          n.children.find((c) => c.type === 'identifier' || c.type === 'property_identifier');
        const name = nameNode?.text ?? '<anonymous>';
        const kind = this.classifySymbol(n.type);
        const signature = this.extractSignature(source, n);
        symbols.push({
          name,
          kind,
          filePath,
          startLine: n.startPosition.row + 1,
          endLine: n.endPosition.row + 1,
          signature,
          language,
        });
      }
      for (const child of n.children) walk(child);
    };
    walk(node);
    return symbols;
  }

  private classifySymbol(nodeType: string): SymbolInfo['kind'] {
    if (nodeType.includes('class')) return 'class';
    if (nodeType.includes('method')) return 'method';
    if (nodeType.includes('import')) return 'import';
    return 'function';
  }

  private extractSignature(source: string, node: Parser.SyntaxNode): string {
    const lines = source.split('\n');
    const start = node.startPosition.row;
    // Take the first non-empty line up to the first `{` or `:`
    for (let i = start; i < Math.min(start + 3, lines.length); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const stop = line.search(/[{:]/);
      return stop >= 0 ? line.slice(0, stop).trim() : line;
    }
    return lines[start]?.trim();
  }

  private chunkFile(
    source: string,
    symbols: SymbolInfo[],
    targetLines: number,
  ): Array<{ startLine: number; endLine: number; content: string }> {
    const lines = source.split('\n');
    const chunks: Array<{ startLine: number; endLine: number; content: string }> = [];

    // Align chunks to symbol boundaries where possible
    const boundaries = [0, ...symbols.map((s) => s.startLine - 1), lines.length];
    for (let i = 0; i < boundaries.length - 1; i++) {
      let start = boundaries[i]!;
      const end = boundaries[i + 1]!;
      // If the symbol is much larger than targetLines, sub-chunk it
      while (end - start > targetLines * 2) {
        const mid = start + targetLines;
        chunks.push({
          startLine: start + 1,
          endLine: mid,
          content: lines.slice(start, mid).join('\n'),
        });
        start = mid;
      }
      if (end > start) {
        chunks.push({
          startLine: start + 1,
          endLine: end,
          content: lines.slice(start, end).join('\n'),
        });
      }
    }
    return chunks;
  }
}
