import { describe, it, expect } from 'vitest';
import { CompactionEngine } from './compaction-engine.js';
import type { ConversationMessage } from '../types.js';

function msg(id: string, role: 'user' | 'assistant', content: string): ConversationMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('CompactionEngine', () => {
  it('creates with default config', () => {
    const engine = new CompactionEngine();
    expect(engine.getMemtable()).toHaveLength(0);
  });

  it('adds messages to L0 memtable', async () => {
    const engine = new CompactionEngine({ memtableSize: 5 });
    await engine.addMessage(msg('1', 'user', 'Hello world'));

    expect(engine.getMemtable()).toHaveLength(1);
  });

  it('auto-flushes when memtable exceeds size', async () => {
    const engine = new CompactionEngine({ memtableSize: 3 });

    for (let i = 0; i < 5; i++) {
      await engine.addMessage(msg(`${i}`, 'user', `Message number ${i} with some content.`));
    }

    // After adding 5 messages with memtableSize=3, L0 should have 3
    // and 2 should have been flushed to L1
    expect(engine.getMemtable().length).toBeLessThanOrEqual(3);
    expect(engine.getState().l1_compacted.length).toBeGreaterThan(0);
  });

  it('builds a context frame within budget', async () => {
    const engine = new CompactionEngine({ memtableSize: 10, contextBudget: 500 });

    await engine.addMessages([
      msg('1', 'user', "Let's build a web app."),
      msg('2', 'assistant', 'Sure, what tech stack?'),
      msg('3', 'user', "Let's go with React and Node."),
      msg('4', 'assistant', 'Great choices. The app must support authentication.'),
    ]);

    const frame = engine.buildContextFrame();

    expect(frame.tokenBudget).toBe(500);
    expect(frame.tokenUsage).toBeLessThanOrEqual(500);
    expect(frame.sections.length).toBeGreaterThan(0);
  });

  it('includes tombstone corrections in context frames', async () => {
    const engine = new CompactionEngine({ memtableSize: 2 });

    await engine.addMessages([
      msg('1', 'user', "Let's use PostgreSQL."),
      msg('2', 'user', 'Actually, switch PostgreSQL to SQLite.'),
      msg('3', 'user', 'Continue with the implementation.'),
    ]);

    const frame = engine.buildContextFrame(5000);
    const allContent = frame.sections.map((s) => s.content).join(' ').toLowerCase();

    // The tombstone should capture the switch from PostgreSQL to SQLite
    expect(allContent).toContain('switch');
    expect(allContent).toContain('sqlite');
  });

  it('respects custom context budget', async () => {
    const engine = new CompactionEngine({ memtableSize: 10 });

    for (let i = 0; i < 8; i++) {
      await engine.addMessage(
        msg(`${i}`, 'user', `This is a fairly long message number ${i} with plenty of content to fill the budget.`),
      );
    }

    const smallFrame = engine.buildContextFrame(200);
    const largeFrame = engine.buildContextFrame(2000);

    expect(smallFrame.tokenUsage).toBeLessThanOrEqual(200);
    expect(largeFrame.tokenUsage).toBeGreaterThanOrEqual(smallFrame.tokenUsage);
  });
});
