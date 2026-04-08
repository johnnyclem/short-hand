/**
 * SourceIngester — adapts raw documents into the compaction pipeline.
 *
 * Accepts Source documents (markdown, plain text), chunks them into
 * ConversationMessages, and feeds them through the CompactionEngine.
 * This bridges Karpathy's "raw sources" layer with short-hand's LSM-tree.
 */

import type {
  ConversationMessage,
  IngestionConfig,
  IngestionEvent,
  Source,
} from '../types.js';
import { DEFAULT_INGESTION_CONFIG } from '../types.js';
import { estimateTokens, generateId } from '../utils.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';

// ---------------------------------------------------------------------------
// Markdown-aware chunking
// ---------------------------------------------------------------------------

/** A heading boundary in the source text. */
interface HeadingBoundary {
  level: number;
  title: string;
  startOffset: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

/** Find all markdown heading positions in the text. */
function findHeadingBoundaries(text: string): HeadingBoundary[] {
  const boundaries: HeadingBoundary[] = [];
  let match: RegExpExecArray | null;
  HEADING_RE.lastIndex = 0;
  while ((match = HEADING_RE.exec(text)) !== null) {
    boundaries.push({
      level: match[1].length,
      title: match[2].trim(),
      startOffset: match.index,
    });
  }
  return boundaries;
}

/**
 * Split text into sections at markdown heading boundaries.
 * Each section includes its heading (if any) and body text.
 */
function splitByHeadings(text: string): Array<{ heading: string; body: string }> {
  const boundaries = findHeadingBoundaries(text);
  if (boundaries.length === 0) {
    return [{ heading: '', body: text }];
  }

  const sections: Array<{ heading: string; body: string }> = [];

  // Content before the first heading
  if (boundaries[0].startOffset > 0) {
    const preamble = text.slice(0, boundaries[0].startOffset).trim();
    if (preamble) {
      sections.push({ heading: '', body: preamble });
    }
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].startOffset;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].startOffset : text.length;
    const sectionText = text.slice(start, end).trim();
    sections.push({ heading: boundaries[i].title, body: sectionText });
  }

  return sections;
}

/**
 * Split a text block into chunks that fit within a token budget.
 * Splits on paragraph boundaries (double newline), falling back to
 * sentence boundaries, then hard character splits.
 */
function chunkText(text: string, maxTokens: number, overlapTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const combined = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(combined) <= maxTokens) {
      current = combined;
    } else {
      if (current) {
        chunks.push(current);
        // Overlap: keep the tail of the current chunk
        if (overlapTokens > 0) {
          const overlapChars = overlapTokens * 4; // inverse of token estimation
          current = current.slice(-overlapChars) + '\n\n' + para;
          // If even with overlap it's too big, just start fresh with para
          if (estimateTokens(current) > maxTokens) {
            current = para;
          }
        } else {
          current = para;
        }
      } else {
        // Single paragraph exceeds budget — split by sentences
        const sentences = para.match(/[^.!?]+[.!?]+\s*/g) ?? [para];
        for (const sentence of sentences) {
          const combined2 = current ? `${current} ${sentence}` : sentence;
          if (estimateTokens(combined2) <= maxTokens) {
            current = combined2;
          } else {
            if (current) chunks.push(current);
            current = sentence;
          }
        }
      }
    }
  }

  if (current.trim()) {
    chunks.push(current);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// SourceIngester
// ---------------------------------------------------------------------------

export class SourceIngester {
  private config: IngestionConfig;
  private events: IngestionEvent[] = [];

  constructor(config: Partial<IngestionConfig> = {}) {
    this.config = { ...DEFAULT_INGESTION_CONFIG, ...config };
  }

  /**
   * Ingest a source document into a CompactionEngine.
   *
   * 1. Chunks the document respecting markdown structure
   * 2. Converts chunks to ConversationMessages with source metadata
   * 3. Feeds them into the engine (triggering auto-flush/compaction)
   * 4. Records an ingestion event for the wiki log
   */
  async ingest(source: Source, engine: CompactionEngine): Promise<IngestionEvent> {
    const chunks = this.chunkSource(source);
    const messages = this.chunksToMessages(chunks, source);

    await engine.addMessages(messages);

    // Flush to ensure content moves through the pipeline
    await engine.flush();

    // Record the entities discovered
    const state = engine.getState();
    const entityNames = Array.from(state.l3_graph.entities.keys());

    const event: IngestionEvent = {
      timestamp: Date.now(),
      sourceId: source.id,
      sourceTitle: source.title,
      chunkCount: chunks.length,
      entitiesDiscovered: entityNames,
    };

    this.events.push(event);
    return event;
  }

  /**
   * Ingest multiple sources sequentially.
   */
  async ingestAll(sources: Source[], engine: CompactionEngine): Promise<IngestionEvent[]> {
    const events: IngestionEvent[] = [];
    for (const source of sources) {
      events.push(await this.ingest(source, engine));
    }
    return events;
  }

  /** Get all ingestion events recorded by this ingester. */
  getEvents(): IngestionEvent[] {
    return [...this.events];
  }

  /**
   * Chunk a source document into text segments.
   */
  chunkSource(source: Source): string[] {
    const isMarkdown =
      source.contentType === 'text/markdown' ||
      (!source.contentType && this.looksLikeMarkdown(source.content));

    if (isMarkdown && this.config.respectMarkdownBoundaries) {
      return this.chunkMarkdown(source.content);
    }

    return chunkText(source.content, this.config.chunkSize, this.config.chunkOverlap);
  }

  /**
   * Convert text chunks into ConversationMessages suitable for the engine.
   * Each message carries source metadata so provenance is preserved through
   * the compaction pipeline.
   */
  chunksToMessages(chunks: string[], source: Source): ConversationMessage[] {
    const baseTimestamp = source.createdAt ?? Date.now();

    return chunks.map((chunk, index) => ({
      id: `${source.id}-chunk-${index}`,
      role: 'system' as const,
      content: chunk,
      timestamp: baseTimestamp + index, // Monotonic ordering within source
      metadata: {
        sourceId: source.id,
        sourceTitle: source.title,
        sourceUri: source.uri,
        chunkIndex: index,
        totalChunks: chunks.length,
      },
    }));
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private chunkMarkdown(content: string): string[] {
    const sections = splitByHeadings(content);
    const allChunks: string[] = [];

    for (const section of sections) {
      const sectionChunks = chunkText(
        section.body,
        this.config.chunkSize,
        this.config.chunkOverlap,
      );
      allChunks.push(...sectionChunks);
    }

    return allChunks.filter((c) => c.trim().length > 0);
  }

  private looksLikeMarkdown(content: string): boolean {
    // Quick heuristic: contains headings, links, or code fences
    return /^#{1,6}\s/m.test(content) || /\[.+\]\(.+\)/.test(content) || /```/.test(content);
  }
}
