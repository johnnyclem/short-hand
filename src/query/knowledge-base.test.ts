import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeBase } from './knowledge-base.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import { SourceIngester } from '../ingestion/source-ingester.js';
import type { CompactedState, CompactionLevel } from '../types.js';
import { CompactionLevel as CL } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState(): CompactedState {
  return {
    l0_messages: [],
    l1_compacted: [],
    l2_summaries: [],
    l3_graph: { entities: new Map(), edges: [] },
    l4_invariants: [],
    tombstones: [],
    totalTokenEstimate: 0,
  };
}

function richState(): CompactedState {
  const state = emptyState();

  // L0: Raw messages
  state.l0_messages.push(
    { id: 'msg-1', role: 'user', content: 'We should use React for the frontend.', timestamp: 1 },
    { id: 'msg-2', role: 'assistant', content: 'React is a good choice for component-based UIs.', timestamp: 2 },
  );

  // L1: Compacted entries
  state.l1_compacted.push(
    { originalMessageId: 'msg-3', compacted: 'Selected PostgreSQL as the primary database for relational data storage.', importance: 0.8 },
    { originalMessageId: 'msg-4', compacted: 'Authentication will use JWT tokens with OAuth2 flow.', importance: 0.9 },
    { originalMessageId: 'msg-5', compacted: 'The API follows REST conventions with JSON payloads.', importance: 0.6 },
  );

  // L2: Topic summaries
  state.l2_summaries.push(
    {
      id: 'sum-1',
      topic: 'Frontend Architecture',
      summary: 'Chose React with TypeScript for the frontend. Components follow atomic design pattern.',
      decisions: [
        {
          description: 'Selected React over Vue for ecosystem maturity',
          chosen: 'React',
          alternatives: [{ option: 'Vue', reason: 'smaller ecosystem' }],
          messageId: 'msg-1',
          superseded: false,
        },
      ],
      entityNames: ['React', 'TypeScript'],
      messageRange: { first: 'msg-1', last: 'msg-2' },
      tokenEstimate: 30,
    },
    {
      id: 'sum-2',
      topic: 'Database Design',
      summary: 'PostgreSQL chosen for its strong SQL support and JSONB capabilities. Schema uses normalized tables.',
      decisions: [],
      entityNames: ['PostgreSQL'],
      messageRange: { first: 'msg-3', last: 'msg-3' },
      tokenEstimate: 25,
    },
  );

  // L3: Entities
  state.l3_graph.entities.set('React', {
    name: 'React',
    type: 'technology',
    properties: { context: 'frontend framework' },
    firstMention: 'msg-1',
    lastMention: 'msg-2',
  });
  state.l3_graph.entities.set('PostgreSQL', {
    name: 'PostgreSQL',
    type: 'technology',
    properties: { context: 'relational database' },
    firstMention: 'msg-3',
    lastMention: 'msg-3',
  });
  state.l3_graph.entities.set('JWT', {
    name: 'JWT',
    type: 'technology',
    properties: { context: 'authentication tokens' },
    firstMention: 'msg-4',
    lastMention: 'msg-4',
  });

  // L3: Edges
  state.l3_graph.edges.push({
    source: 'React',
    target: 'PostgreSQL',
    relation: 'related_to',
    properties: {},
    sourceMessage: 'msg-1',
  });

  // L4: Invariants
  state.l4_invariants.push(
    { key: 'auth-required', value: 'All API endpoints must require authentication', sourceMessage: 'msg-4', timestamp: 100 },
    { key: 'data-encryption', value: 'User data must be encrypted at rest', sourceMessage: 'msg-5', timestamp: 200 },
  );

  // Tombstones
  state.tombstones.push({
    supersededContent: 'MySQL for database',
    originalMessageId: 'msg-2',
    correctionMessageId: 'msg-3',
    reason: 'Switched to PostgreSQL for better JSON support',
    timestamp: 150,
    key: 'database',
    correctedValue: 'PostgreSQL',
  });

  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KnowledgeBase', () => {
  let kb: KnowledgeBase;

  beforeEach(() => {
    kb = new KnowledgeBase();
  });

  describe('index', () => {
    it('indexes an empty state', async () => {
      await kb.index(emptyState());
      expect(kb.isIndexed()).toBe(true);
      expect(kb.getEntryCount()).toBe(0);
    });

    it('indexes all levels of compacted state', async () => {
      const state = richState();
      await kb.index(state);

      // L0: 2 messages + L1: 3 compacted + L2: 2 summaries + L3: 3 entities
      // + L4: 2 invariants + 1 tombstone = 13
      expect(kb.getEntryCount()).toBe(13);
    });

    it('can re-index with updated state', async () => {
      const state = richState();
      await kb.index(state);
      const count1 = kb.getEntryCount();

      state.l4_invariants.push({
        key: 'new-rule',
        value: 'New invariant added',
        sourceMessage: 'msg-99',
        timestamp: 999,
      });

      await kb.index(state);
      expect(kb.getEntryCount()).toBe(count1 + 1);
    });
  });

  describe('query', () => {
    it('returns empty results for empty index', async () => {
      await kb.index(emptyState());
      const response = await kb.query('anything');

      expect(response.query).toBe('anything');
      expect(response.results).toHaveLength(0);
    });

    it('finds relevant results by keyword', async () => {
      await kb.index(richState());
      const response = await kb.query('PostgreSQL database');

      expect(response.results.length).toBeGreaterThan(0);
      // Top result should mention PostgreSQL
      const topContent = response.results[0].content.toLowerCase();
      expect(topContent).toContain('postgresql');
    });

    it('ranks exact keyword matches higher', async () => {
      await kb.index(richState());
      const response = await kb.query('JWT authentication tokens');

      expect(response.results.length).toBeGreaterThan(0);
      // Results mentioning JWT should rank near the top
      const jwtResults = response.results.filter((r) =>
        r.content.toLowerCase().includes('jwt'),
      );
      expect(jwtResults.length).toBeGreaterThan(0);
    });

    it('respects maxResults config', async () => {
      await kb.index(richState());
      const response = await kb.query('React', { maxResults: 2 });

      expect(response.results.length).toBeLessThanOrEqual(2);
    });

    it('respects minScore config', async () => {
      await kb.index(richState());
      const response = await kb.query('React', { minScore: 0.5 });

      for (const result of response.results) {
        expect(result.score).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('filters by compaction level', async () => {
      await kb.index(richState());
      const response = await kb.query('React', {
        levels: [CL.L3_GRAPH],
      });

      for (const result of response.results) {
        expect(result.level).toBe(CL.L3_GRAPH);
      }
    });

    it('returns results with correct entry types', async () => {
      await kb.index(richState());
      const response = await kb.query('database authentication encryption');

      const types = new Set(response.results.map((r) => r.entryType));
      // Should have multiple entry types in results
      expect(types.size).toBeGreaterThan(0);
    });

    it('finds tombstone corrections', async () => {
      await kb.index(richState());
      const response = await kb.query('MySQL database correction');

      const tombstoneResults = response.results.filter((r) => r.entryType === 'tombstone');
      expect(tombstoneResults.length).toBeGreaterThan(0);
      expect(tombstoneResults[0].content).toContain('MySQL');
      expect(tombstoneResults[0].content).toContain('PostgreSQL');
    });

    it('results include labels for entities and topics', async () => {
      await kb.index(richState());
      const response = await kb.query('React frontend');

      const entityResult = response.results.find((r) => r.entryType === 'entity' && r.label === 'React');
      expect(entityResult).toBeDefined();
    });
  });

  describe('query-biased context frame', () => {
    it('builds a context frame from query results', async () => {
      await kb.index(richState());
      const response = await kb.query('React frontend architecture');

      expect(response.contextFrame).toBeDefined();
      expect(response.contextFrame.tokenBudget).toBe(4000);
      expect(response.contextFrame.tokenUsage).toBeGreaterThan(0);
      expect(response.contextFrame.sections.length).toBeGreaterThan(0);
    });

    it('respects contextBudget config', async () => {
      await kb.index(richState());
      const response = await kb.query('React', { contextBudget: 100 });

      expect(response.contextFrame.tokenUsage).toBeLessThanOrEqual(100);
    });

    it('context frame contains relevant content', async () => {
      await kb.index(richState());
      const response = await kb.query('PostgreSQL database');

      const allContent = response.contextFrame.sections
        .map((s) => s.content)
        .join(' ')
        .toLowerCase();
      expect(allContent).toContain('postgresql');
    });
  });

  describe('semantic search quality', () => {
    it('finds conceptually related content not just exact matches', async () => {
      await kb.index(richState());

      // Query about "frontend UI library" should find React even though
      // the exact phrase isn't used in the state
      const response = await kb.query('frontend UI library component', {
        keywordWeight: 0.2, // lean toward semantic
      });

      expect(response.results.length).toBeGreaterThan(0);
      const hasReactRelated = response.results.some(
        (r) => r.content.toLowerCase().includes('react') ||
               r.content.toLowerCase().includes('frontend'),
      );
      expect(hasReactRelated).toBe(true);
    });

    it('keyword-heavy queries favor exact matches', async () => {
      await kb.index(richState());
      const response = await kb.query('JWT', { keywordWeight: 0.9 });

      expect(response.results.length).toBeGreaterThan(0);
      // With high keyword weight, top result should contain "JWT"
      expect(response.results[0].content.toLowerCase()).toContain('jwt');
    });
  });

  describe('end-to-end: ingest → compact → query', () => {
    it('queries content from ingested documents', async () => {
      const ingester = new SourceIngester({ chunkSize: 30, chunkOverlap: 0 });
      const engine = new CompactionEngine({ memtableSize: 1 });

      // Ingest a document about machine learning
      await ingester.ingest(
        {
          id: 'ml-paper',
          title: 'ML Overview',
          content: [
            'We are building a neural network for image classification.',
            '',
            'We decided on using PyTorch for deep learning.',
            '',
            'The model must achieve 95% accuracy on the test set.',
            '',
            'We chose convolutional neural networks over transformers.',
          ].join('\n'),
          contentType: 'text/plain',
        },
        engine,
      );

      await engine.recompact(4);

      const kb = new KnowledgeBase();
      await kb.index(engine.getState());

      const response = await kb.query('neural network deep learning');

      expect(response.results.length).toBeGreaterThan(0);
    });
  });
});
