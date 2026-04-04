import { describe, it, expect } from 'vitest';
import { InvariantChecker } from './invariant-checker.js';
import { RecallTester } from './recall-tester.js';
import { RegexCompactor } from '../compaction/regex-compactor.js';
import type { CompactedState, ConversationMessage } from '../types.js';
import { CompactionLevel } from '../types.js';

function msg(id: string, role: 'user' | 'assistant', content: string, ts = Date.now()): ConversationMessage {
  return { id, role, content, timestamp: ts };
}

describe('InvariantChecker', () => {
  const checker = new InvariantChecker();

  it('passes on a clean state', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = checker.verify(state);
    expect(result.passed).toBe(true);
  });

  it('passes when entities have provenance', async () => {
    const compactor = new RegexCompactor();
    const messages = [
      msg('1', 'user', "Let's build a REST API using Express."),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    const result = checker.verify(state);

    const provenanceCheck = result.checks.find((c) => c.name === 'entity-provenance');
    expect(provenanceCheck?.passed).toBe(true);
  });

  it('reports temporal ordering issues', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: {
        entities: new Map([
          ['test', { name: 'test', type: 'component', properties: {}, firstMention: '', lastMention: '1' }],
        ]),
        edges: [],
      },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = checker.verify(state);
    const temporalCheck = result.checks.find((c) => c.name === 'temporal-ordering');
    expect(temporalCheck?.passed).toBe(false);
  });
});

describe('RecallTester', () => {
  const tester = new RecallTester();

  it('generates questions from conversation', () => {
    const messages = [
      msg('1', 'user', "Let's use PostgreSQL for the database."),
      msg('2', 'user', 'We rejected MySQL because of licensing concerns.'),
    ];

    const questions = tester.generateQuestions(messages);
    expect(questions.length).toBeGreaterThan(0);
  });

  it('evaluates recall against compacted state', async () => {
    const compactor = new RegexCompactor();
    const messages = [
      msg('1', 'user', "We chose PostgreSQL for the database.", 1000),
      msg('2', 'user', 'We rejected MySQL because of licensing.', 2000),
      msg('3', 'user', 'Actually, switch to SQLite instead.', 3000),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    const questions = tester.generateQuestions(messages);
    const result = tester.evaluateRecall(questions, state);

    expect(result.recallScore).toBeDefined();
    expect(result.recallScore!).toBeGreaterThanOrEqual(0);
    expect(result.recallScore!).toBeLessThanOrEqual(1);
  });

  it('returns perfect recall when no questions generated', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = tester.evaluateRecall([], state);
    expect(result.passed).toBe(true);
    expect(result.recallScore).toBe(1.0);
  });
});
