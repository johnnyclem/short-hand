import { describe, it, expect } from 'vitest';
import { CompactionEngine } from './compaction-engine.js';
import { CompactionLevel, type ConversationMessage } from '../types.js';
import { ActiveEngramStore } from '../crdt/active-engram-store.js';

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

  it('budgets corrections before derived levels under a tight budget', async () => {
    const engine = new CompactionEngine({ memtableSize: 1 });
    await engine.addMessages([
      msg('1', 'user', "Let's use PostgreSQL."),
      msg('2', 'user', 'The service must stay under 200ms p99 latency.'),
      msg('3', 'user', 'Actually, switch PostgreSQL to SQLite.'),
      ...Array.from({ length: 20 }, (_, i) =>
        msg(`f${i}`, 'user', `We chose option ${i} for the widget layer over the legacy one.`),
      ),
    ]);

    const frame = engine.buildContextFrame(60);
    const contents = frame.sections.map((s) => s.content);
    const correctionIdx = contents.findIndex((c) => c.startsWith('[correction]'));
    const invariantIdx = contents.findIndex((c) => c.startsWith('[invariant]'));

    expect(correctionIdx).toBe(0);
    expect(contents[correctionIdx]).toContain('"SQLite"');
    // Output order: corrections ahead of invariants
    if (invariantIdx !== -1) expect(invariantIdx).toBeGreaterThan(correctionIdx);
  });

  it('does not emit L1 lines a correction superseded', async () => {
    const engine = new CompactionEngine({ memtableSize: 1 });
    await engine.addMessages([
      msg('1', 'user', 'We decided to use MySQL for storage.'),
      msg('2', 'assistant', 'Got it, LOG_BUDGET = 30.'),
      msg('3', 'user', 'Switch MySQL to Postgres.'),
      msg('4', 'user', 'Change the log budget to 100.'),
      msg('5', 'user', 'Now write the migration scripts.'),
    ]);

    const l1 = engine
      .buildContextFrame(5000)
      .sections.filter((s) => s.level === 1)
      .map((s) => s.content)
      .join('\n');

    expect(l1).toContain('Switch MySQL to Postgres.');
    expect(l1).toContain('Change the log budget to 100.');
    expect(l1).not.toContain('We decided to use MySQL');
    expect(l1).not.toContain('LOG_BUDGET = 30');
  });

  it('does not emit decision summaries a correction superseded', async () => {
    const engine = new CompactionEngine({ memtableSize: 1 });
    await engine.addMessages([
      msg('1', 'user', "Let's use MySQL for storage."),
      msg('2', 'user', "Actually, we're using Postgres, not MySQL."),
      msg('3', 'user', 'Now write the migration scripts.'),
    ]);
    await engine.recompact(CompactionLevel.L3_GRAPH);

    const frame = engine.buildContextFrame(5000);
    const text = frame.sections.map((s) => s.content).join('\n');
    expect(text).not.toContain('[Decision: MySQL');
    expect(text).toContain('Postgres');
  });

  it('selects L1 by importance first, most recent first on ties', () => {
    const engine = new CompactionEngine();
    const l1 = engine.getState().l1_compacted;
    l1.push(
      { originalMessageId: 'a', compacted: 'low importance line aaaa', importance: 0.1 },
      { originalMessageId: 'b', compacted: 'high importance line bbb', importance: 0.9 },
      { originalMessageId: 'c', compacted: 'mid importance older ccc', importance: 0.5 },
      { originalMessageId: 'd', compacted: 'mid importance newer ddd', importance: 0.5 },
    );

    // Each line is 6 tokens; room for exactly two
    const content = engine.buildContextFrame(12).sections.map((s) => s.content).join('\n');

    // Emitted in conversation order
    expect(content).toBe('high importance line bbb\nmid importance newer ddd');
  });

  it('reserves budget for the most recent L0 message', async () => {
    const engine = new CompactionEngine({ memtableSize: 2 });
    for (let i = 0; i < 30; i++) {
      await engine.addMessage(
        msg(`${i}`, 'user', `Component ${i} of the rendering pipeline is now documented in the wiki.`),
      );
    }
    await engine.addMessage(msg('latest', 'user', 'Ship it today.'));

    const frame = engine.buildContextFrame(200);
    const last = frame.sections[frame.sections.length - 1];

    expect(frame.tokenUsage).toBeLessThanOrEqual(200);
    expect(frame.sections.some((s) => s.level === 1)).toBe(true);
    expect(last.level).toBe(0);
    expect(last.content).toContain('user: Ship it today.');
  });

  it('budgets active engrams where they are emitted, after corrections', async () => {
    const engine = new CompactionEngine({ memtableSize: 1 });
    const store = new ActiveEngramStore();
    store.add('deploy target is Fly.io');
    engine.attachActiveEngrams(store);
    await engine.addMessages([
      msg('1', 'user', "Let's use PostgreSQL."),
      msg('2', 'user', 'Actually, switch PostgreSQL to SQLite.'),
      msg('3', 'user', 'Continue.'),
    ]);

    const contents = engine.buildContextFrame(5000).sections.map((s) => s.content);
    const correctionIdx = contents.findIndex((c) => c.startsWith('[correction]'));
    const memoryIdx = contents.findIndex((c) => c.startsWith('[memory]'));

    expect(correctionIdx).toBe(0);
    expect(memoryIdx).toBeGreaterThan(correctionIdx);
  });
});
