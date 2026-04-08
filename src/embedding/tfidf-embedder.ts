/**
 * TF-IDF Embedder — zero-dependency semantic vector generation.
 *
 * Implements the existing Embedder interface with real TF-IDF vectors.
 * Builds a vocabulary from a corpus of documents, then produces dense
 * Float32Array vectors via hashed term projection. This enables genuine
 * cosine-similarity search without any external model or runtime.
 *
 * Design choices:
 * - Uses sublinear TF (1 + log(tf)) to dampen high-frequency terms
 * - IDF with smoothing: log(1 + N / (1 + df))
 * - Hashed feature projection into a fixed-dimension dense vector
 *   (avoids vocabulary-dimension coupling, caps memory)
 * - L2-normalized output for cosine similarity via dot product
 */

import type { Embedder, EmbeddingResult } from './index.js';

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------

/** Common English stop words to filter out. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they',
  'me', 'us', 'him', 'her', 'them', 'my', 'our', 'your', 'his', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
  'just', 'about', 'also', 'into', 'over', 'after', 'before',
  'between', 'under', 'above', 'up', 'down', 'out', 'off',
  'more', 'most', 'some', 'any', 'each', 'all', 'both',
  'as', 'such', 'like',
]);

/** Tokenize text into normalized terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Simple FNV-1a hash for mapping terms to vector dimensions.
 * Returns a positive integer in [0, mod).
 */
function fnv1a(str: string, mod: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % mod;
}

/**
 * Secondary hash for sign — determines if a term adds or subtracts
 * from a dimension (reduces hash collision damage).
 */
function signHash(str: string): 1 | -1 {
  let hash = 0x6c62272e;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return (hash & 1) === 0 ? 1 : -1;
}

/** L2-normalize a vector in place. */
function l2Normalize(vec: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
}

/** Compute cosine similarity between two L2-normalized vectors (= dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ---------------------------------------------------------------------------
// TF-IDF Embedder
// ---------------------------------------------------------------------------

export class TfIdfEmbedder implements Embedder {
  private dimensions: number;
  /** Document frequency: term → number of documents containing it. */
  private df = new Map<string, number>();
  /** Total number of documents in the corpus. */
  private docCount = 0;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
  }

  /**
   * Build (or update) the IDF model from a corpus of documents.
   * Call this before embedding queries for best results.
   * Can be called incrementally — new documents add to existing counts.
   */
  fit(documents: string[]): void {
    for (const doc of documents) {
      this.docCount++;
      const terms = new Set(tokenize(doc));
      for (const term of terms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
  }

  /** Get the IDF weight for a term. */
  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    // Smoothed IDF: log(1 + N / (1 + df))
    return Math.log(1 + this.docCount / (1 + df));
  }

  /**
   * Embed a single text string into a dense vector.
   *
   * Pipeline: tokenize → compute TF-IDF weights → hash-project into
   * fixed-dimension vector → L2-normalize.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const vec = this.embedSync(text);
    return { vector: vec, dimensions: this.dimensions };
  }

  /** Synchronous embed for internal use. */
  embedSync(text: string): Float32Array {
    const tokens = tokenize(text);
    const vec = new Float32Array(this.dimensions);

    if (tokens.length === 0) {
      return vec;
    }

    // Compute term frequencies
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Project TF-IDF weights into the dense vector via feature hashing
    for (const [term, count] of tf) {
      const tfidf = (1 + Math.log(count)) * this.idf(term);
      const dim = fnv1a(term, this.dimensions);
      const sign = signHash(term);
      vec[dim] += sign * tfidf;
    }

    l2Normalize(vec);
    return vec;
  }

  /** Batch embed multiple texts. */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      vector: this.embedSync(text),
      dimensions: this.dimensions,
    }));
  }

  /** Get the number of documents the model has been fit on. */
  getDocCount(): number {
    return this.docCount;
  }

  /** Get the vocabulary size (number of unique terms seen). */
  getVocabSize(): number {
    return this.df.size;
  }

  /** Reset the model to its initial state. */
  reset(): void {
    this.df.clear();
    this.docCount = 0;
  }
}
