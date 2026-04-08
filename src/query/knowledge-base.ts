/**
 * KnowledgeBase — query engine for compacted knowledge.
 *
 * Indexes all levels of CompactedState and supports hybrid search:
 *   - BM25-style keyword matching (exact term relevance)
 *   - TF-IDF semantic similarity (conceptual relevance)
 *
 * Returns ranked QueryResults and can build query-biased ContextFrames
 * that prioritize content relevant to the query.
 */

import type {
  CompactedState,
  CompactionLevel,
  ContextFrame,
  ContextSection,
  QueryConfig,
  QueryResponse,
  QueryResult,
} from '../types.js';
import { CompactionLevel as CL, DEFAULT_QUERY_CONFIG } from '../types.js';
import { estimateTokens } from '../utils.js';
import { TfIdfEmbedder, cosineSimilarity } from '../embedding/tfidf-embedder.js';

// ---------------------------------------------------------------------------
// Internal searchable entry
// ---------------------------------------------------------------------------

interface SearchEntry {
  /** The searchable text content. */
  text: string;
  /** Pre-computed embedding vector. */
  vector: Float32Array | null;
  /** Metadata for building QueryResult. */
  level: CompactionLevel;
  entryType: QueryResult['entryType'];
  label?: string;
  sourceMessageId?: string;
}

// ---------------------------------------------------------------------------
// BM25-style keyword scoring
// ---------------------------------------------------------------------------

/** Tokenize for BM25 matching — lowercase, split, filter short words. */
function bm25Tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * BM25 score for a query against a document.
 * Simplified single-document BM25 (no corpus-level IDF — that's handled
 * by the TF-IDF embedder side). This captures exact term-match relevance.
 *
 * Parameters: k1=1.5, b=0.75 (standard defaults).
 */
function bm25Score(queryTerms: string[], docText: string, avgDocLength: number): number {
  const docTokens = bm25Tokenize(docText);
  const docLength = docTokens.length;
  if (docLength === 0) return 0;

  // Term frequency map for the document
  const tf = new Map<string, number>();
  for (const token of docTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  for (const term of queryTerms) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    // BM25 term score (without IDF component — using simple presence weight)
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLength / avgDocLength));
    score += numerator / denominator;
  }

  // Normalize by number of query terms for consistent 0-1ish scaling
  return queryTerms.length > 0 ? score / queryTerms.length : 0;
}

// ---------------------------------------------------------------------------
// KnowledgeBase
// ---------------------------------------------------------------------------

export class KnowledgeBase {
  private config: QueryConfig;
  private embedder: TfIdfEmbedder;
  private entries: SearchEntry[] = [];
  private indexed = false;

  constructor(config: Partial<QueryConfig> = {}) {
    this.config = { ...DEFAULT_QUERY_CONFIG, ...config };
    this.embedder = new TfIdfEmbedder();
  }

  /**
   * Index a CompactedState for querying.
   * Extracts searchable text from all levels, fits the TF-IDF model,
   * and pre-computes embedding vectors.
   *
   * Can be called again to re-index after new content is added.
   */
  async index(state: CompactedState): Promise<void> {
    this.entries = [];
    this.embedder.reset();

    // Extract all searchable entries
    this.extractEntries(state);

    // Fit the TF-IDF model on all entry texts
    const texts = this.entries.map((e) => e.text);
    this.embedder.fit(texts);

    // Pre-compute embeddings
    for (const entry of this.entries) {
      entry.vector = this.embedder.embedSync(entry.text);
    }

    this.indexed = true;
  }

  /**
   * Query the knowledge base.
   *
   * Hybrid scoring: combines BM25 keyword match with TF-IDF semantic
   * similarity, weighted by config.keywordWeight.
   *
   * Returns ranked results and a query-biased context frame.
   */
  async query(queryText: string, config?: Partial<QueryConfig>): Promise<QueryResponse> {
    const cfg = { ...this.config, ...config };

    if (!this.indexed || this.entries.length === 0) {
      return {
        query: queryText,
        results: [],
        contextFrame: { tokenBudget: cfg.contextBudget, tokenUsage: 0, sections: [] },
      };
    }

    // Compute query embedding
    const queryVector = this.embedder.embedSync(queryText);
    const queryTerms = bm25Tokenize(queryText);

    // Average document length for BM25 normalization
    const avgDocLength =
      this.entries.reduce((sum, e) => sum + bm25Tokenize(e.text).length, 0) /
      this.entries.length;

    // Score all entries
    const scored: Array<{ entry: SearchEntry; score: number }> = [];

    for (const entry of this.entries) {
      // Filter by level if specified
      if (cfg.levels && !cfg.levels.includes(entry.level)) continue;

      // BM25 keyword score
      const keyword = bm25Score(queryTerms, entry.text, avgDocLength);

      // Semantic similarity score
      let semantic = 0;
      if (entry.vector) {
        semantic = Math.max(0, cosineSimilarity(queryVector, entry.vector));
      }

      // Hybrid score
      const score = cfg.keywordWeight * keyword + (1 - cfg.keywordWeight) * semantic;

      if (score >= cfg.minScore) {
        scored.push({ entry, score });
      }
    }

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, cfg.maxResults);

    // Build QueryResult objects
    const results: QueryResult[] = topResults.map(({ entry, score }) => ({
      content: entry.text,
      score,
      level: entry.level,
      entryType: entry.entryType,
      label: entry.label,
      sourceMessageId: entry.sourceMessageId,
    }));

    // Build a query-biased context frame
    const contextFrame = this.buildBiasedContextFrame(results, cfg.contextBudget);

    return { query: queryText, results, contextFrame };
  }

  /**
   * Get the number of indexed entries.
   */
  getEntryCount(): number {
    return this.entries.length;
  }

  /**
   * Check if the knowledge base has been indexed.
   */
  isIndexed(): boolean {
    return this.indexed;
  }

  /**
   * Provide access to the underlying embedder for advanced use cases
   * (e.g., computing similarity between two arbitrary texts).
   */
  getEmbedder(): TfIdfEmbedder {
    return this.embedder;
  }

  // -----------------------------------------------------------------------
  // Entry extraction
  // -----------------------------------------------------------------------

  private extractEntries(state: CompactedState): void {
    // L0: Raw messages
    for (const msg of state.l0_messages) {
      this.entries.push({
        text: msg.content,
        vector: null,
        level: CL.L0_MEMTABLE,
        entryType: 'message',
        sourceMessageId: msg.id,
      });
    }

    // L1: Compacted entries
    for (const entry of state.l1_compacted) {
      this.entries.push({
        text: entry.compacted,
        vector: null,
        level: CL.L1_COMPACTED,
        entryType: 'compacted',
        sourceMessageId: entry.originalMessageId,
      });
    }

    // L2: Topic summaries
    for (const summary of state.l2_summaries) {
      // Index the summary text
      const summaryText = this.flattenSummary(summary);
      this.entries.push({
        text: summaryText,
        vector: null,
        level: CL.L2_SUMMARIES,
        entryType: 'summary',
        label: summary.topic,
      });
    }

    // L3: Entity graph — each entity becomes a searchable entry
    for (const [name, entity] of state.l3_graph.entities) {
      const entityText = this.flattenEntity(name, entity, state);
      this.entries.push({
        text: entityText,
        vector: null,
        level: CL.L3_GRAPH,
        entryType: 'entity',
        label: name,
        sourceMessageId: entity.firstMention,
      });
    }

    // L4: Invariants
    for (const inv of state.l4_invariants) {
      this.entries.push({
        text: `${inv.key}: ${inv.value}`,
        vector: null,
        level: CL.L4_INVARIANTS,
        entryType: 'invariant',
        label: inv.key,
        sourceMessageId: inv.sourceMessage,
      });
    }

    // Tombstones (corrections) — searchable so queries can find superseded info
    for (const tombstone of state.tombstones) {
      const text = `Correction: "${tombstone.supersededContent}" was corrected to "${tombstone.correctedValue ?? '(removed)'}". Reason: ${tombstone.reason}`;
      this.entries.push({
        text,
        vector: null,
        level: CL.L4_INVARIANTS, // Tombstones are highest-priority like invariants
        entryType: 'tombstone',
        label: tombstone.key,
        sourceMessageId: tombstone.correctionMessageId,
      });
    }
  }

  private flattenSummary(summary: import('../types.js').TopicSummary): string {
    const parts = [summary.topic, summary.summary];
    for (const decision of summary.decisions) {
      parts.push(`Decision: ${decision.chosen} — ${decision.description}`);
      for (const alt of decision.alternatives) {
        parts.push(`Rejected: ${alt.option} (${alt.reason})`);
      }
    }
    if (summary.entityNames.length > 0) {
      parts.push(`Entities: ${summary.entityNames.join(', ')}`);
    }
    return parts.join('. ');
  }

  private flattenEntity(
    name: string,
    entity: import('../types.js').Entity,
    state: CompactedState,
  ): string {
    const parts = [`${name} (${entity.type})`];

    // Properties
    for (const [key, value] of Object.entries(entity.properties)) {
      parts.push(`${key}: ${value}`);
    }

    // Relationships
    const related = state.l3_graph.edges.filter(
      (e) => e.source === name || e.target === name,
    );
    for (const edge of related) {
      const other = edge.source === name ? edge.target : edge.source;
      parts.push(`${edge.relation} ${other}`);
    }

    return parts.join('. ');
  }

  // -----------------------------------------------------------------------
  // Query-biased context frame
  // -----------------------------------------------------------------------

  /**
   * Build a ContextFrame that prioritizes content matching query results.
   * Unlike CompactionEngine.buildContextFrame() which prioritizes by level,
   * this orders by relevance score and packs the most relevant content first.
   */
  private buildBiasedContextFrame(results: QueryResult[], budget: number): ContextFrame {
    const sections: ContextSection[] = [];
    let used = 0;

    // Group results by level for structured output
    const byLevel = new Map<CompactionLevel, QueryResult[]>();
    for (const result of results) {
      const group = byLevel.get(result.level) ?? [];
      group.push(result);
      byLevel.set(result.level, group);
    }

    // Emit sections in level order (L4 → L0) but only with matched content
    const levelOrder = [
      CL.L4_INVARIANTS,
      CL.L3_GRAPH,
      CL.L2_SUMMARIES,
      CL.L1_COMPACTED,
      CL.L0_MEMTABLE,
    ];

    for (const level of levelOrder) {
      const group = byLevel.get(level);
      if (!group || group.length === 0) continue;

      const lines: string[] = [];
      for (const result of group) {
        const prefix = result.label ? `[${result.label}] ` : '';
        const line = `${prefix}${result.content}`;
        const lineTokens = estimateTokens(line);
        if (used + estimateTokens(lines.join('\n')) + lineTokens > budget) break;
        lines.push(line);
      }

      if (lines.length > 0) {
        const content = lines.join('\n');
        const tokens = estimateTokens(content);
        sections.push({ level, content, tokenEstimate: tokens });
        used += tokens;
      }
    }

    return { tokenBudget: budget, tokenUsage: used, sections };
  }
}
