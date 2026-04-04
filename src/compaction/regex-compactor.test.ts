import { describe, it, expect } from 'vitest';
import { RegexCompactor } from './regex-compactor.js';
import type { ConversationMessage, CompactedState } from '../types.js';
import { CompactionLevel } from '../types.js';

function msg(id: string, role: 'user' | 'assistant', content: string, ts = Date.now()): ConversationMessage {
  return { id, role, content, timestamp: ts };
}

describe('RegexCompactor', () => {
  const compactor = new RegexCompactor();

  it('has tier "regex"', () => {
    expect(compactor.tier).toBe('regex');
  });

  it('extracts decisions from messages', async () => {
    const messages = [
      msg('1', 'user', "Let's go with PostgreSQL for the database."),
      msg('2', 'assistant', 'Sounds good, PostgreSQL it is.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.l2_summaries.length).toBeGreaterThan(0);
    const decisionSummary = state.l2_summaries.find((s) => s.topic.includes('PostgreSQL'));
    expect(decisionSummary).toBeDefined();
    expect(decisionSummary!.decisions[0].chosen).toBe('PostgreSQL for the database');
  });

  it('creates tombstones for corrections', async () => {
    const messages = [
      msg('1', 'user', "Let's use PostgreSQL.", 1000),
      msg('2', 'user', 'Actually, switch PostgreSQL to SQLite.', 2000),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.tombstones.length).toBeGreaterThan(0);
    const tombstone = state.tombstones.find((t) => t.correctedValue === 'SQLite');
    expect(tombstone).toBeDefined();
    expect(tombstone!.reason).toContain('switch PostgreSQL to SQLite');
  });

  it('extracts constraints as L4 invariants', async () => {
    const messages = [
      msg('1', 'user', 'The API must support pagination.'),
      msg('2', 'user', 'We must not exceed 100 items per page.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.l4_invariants.length).toBe(2);
  });

  it('filters out noise messages', async () => {
    const messages = [
      msg('1', 'user', 'ok'),
      msg('2', 'user', 'thanks'),
      msg('3', 'user', "Let's use React for the frontend."),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    // Only the substantive message should produce L1 entries
    expect(state.l1_compacted.length).toBe(1);
    expect(state.l1_compacted[0].originalMessageId).toBe('3');
  });

  it('handles code blocks by indexing not summarizing', async () => {
    const messages = [
      msg('1', 'user', 'Here is the code:\n```typescript\nconst x = 42;\n```\nPlease review.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    // Code block should be replaced with placeholder in compacted text
    expect(state.l1_compacted[0].compacted).toContain('[code block]');
  });

  it('computes token estimates', async () => {
    const messages = [
      msg('1', 'user', 'We chose JWT with RS256 for authentication.'),
      msg('2', 'assistant', 'Good choice. I will implement JWT with RS256.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.totalTokenEstimate).toBeGreaterThan(0);
  });

  it('recompact promotes to deeper levels', async () => {
    const messages = [
      msg('1', 'user', "Let's use React.", 1000),
      msg('2', 'user', 'We chose PostgreSQL over MySQL.', 2000),
      msg('3', 'user', 'The app must support offline mode.', 3000),
    ];

    let state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    state = await compactor.recompact(state, CompactionLevel.L3_GRAPH);

    expect(state.l3_graph.entities.size).toBeGreaterThan(0);
  });
});
