import { describe, it, expect, beforeEach } from 'vitest';
import { TfIdfEmbedder, cosineSimilarity } from './tfidf-embedder.js';

describe('TfIdfEmbedder', () => {
  let embedder: TfIdfEmbedder;

  beforeEach(() => {
    embedder = new TfIdfEmbedder(128);
  });

  describe('fit', () => {
    it('tracks document count and vocabulary', () => {
      embedder.fit(['The quick brown fox', 'The lazy dog']);
      expect(embedder.getDocCount()).toBe(2);
      expect(embedder.getVocabSize()).toBeGreaterThan(0);
    });

    it('can be called incrementally', () => {
      embedder.fit(['First document']);
      expect(embedder.getDocCount()).toBe(1);

      embedder.fit(['Second document']);
      expect(embedder.getDocCount()).toBe(2);
    });

    it('reset clears the model', () => {
      embedder.fit(['Some text']);
      embedder.reset();
      expect(embedder.getDocCount()).toBe(0);
      expect(embedder.getVocabSize()).toBe(0);
    });
  });

  describe('embed', () => {
    it('produces a vector of the configured dimensions', async () => {
      embedder.fit(['React is a frontend framework']);
      const result = await embedder.embed('React frontend');

      expect(result.dimensions).toBe(128);
      expect(result.vector).toBeInstanceOf(Float32Array);
      expect(result.vector.length).toBe(128);
    });

    it('produces a zero vector for empty text', async () => {
      const result = await embedder.embed('');

      expect(result.vector.every((v) => v === 0)).toBe(true);
    });

    it('produces L2-normalized vectors', async () => {
      embedder.fit(['React framework for building user interfaces']);
      const result = await embedder.embed('React framework');

      // L2 norm should be ~1.0 for non-zero vectors
      let norm = 0;
      for (const v of result.vector) norm += v * v;
      norm = Math.sqrt(norm);

      if (norm > 0) {
        expect(norm).toBeCloseTo(1.0, 4);
      }
    });
  });

  describe('embedBatch', () => {
    it('embeds multiple texts', async () => {
      embedder.fit(['React', 'Vue', 'Angular']);
      const results = await embedder.embedBatch(['React', 'Vue', 'Angular']);

      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.dimensions).toBe(128);
        expect(r.vector.length).toBe(128);
      });
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
      const vec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 4);
    });

    it('returns 0.0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0, 0]);
      const b = new Float32Array([0, 1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 4);
    });

    it('returns higher similarity for related texts', async () => {
      const corpus = [
        'React is a JavaScript library for building user interfaces',
        'Vue is a progressive JavaScript framework',
        'PostgreSQL is a relational database management system',
        'TypeScript adds static types to JavaScript',
        'Kubernetes orchestrates container deployments',
      ];
      embedder.fit(corpus);

      const reactVec = embedder.embedSync('React JavaScript UI library');
      const vueVec = embedder.embedSync('Vue JavaScript framework');
      const postgresVec = embedder.embedSync('PostgreSQL database SQL');

      const reactVueSim = cosineSimilarity(reactVec, vueVec);
      const reactPostgresSim = cosineSimilarity(reactVec, postgresVec);

      // React and Vue (both JS UI frameworks) should be more similar
      // than React and PostgreSQL (unrelated domains)
      expect(reactVueSim).toBeGreaterThan(reactPostgresSim);
    });

    it('self-similarity is highest', async () => {
      embedder.fit(['authentication security', 'database schema', 'API endpoint']);
      const vec = embedder.embedSync('authentication security');
      const otherVec = embedder.embedSync('database schema');

      const selfSim = cosineSimilarity(vec, vec);
      const otherSim = cosineSimilarity(vec, otherVec);

      expect(selfSim).toBeGreaterThan(otherSim);
    });
  });

  describe('implements Embedder interface', () => {
    it('works as a drop-in replacement for StubEmbedder', async () => {
      embedder.fit(['hello world']);
      const result = await embedder.embed('hello world');

      expect(result).toHaveProperty('vector');
      expect(result).toHaveProperty('dimensions');
      expect(result.vector).toBeInstanceOf(Float32Array);
    });
  });
});
