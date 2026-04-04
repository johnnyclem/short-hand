import { describe, it, expect, beforeEach } from 'vitest';
import { LWWRegister } from './lww-register.js';
import { ORSet } from './or-set.js';
import { GSet } from './g-set.js';
import { AgentMemory } from './agent-memory.js';
import { resetLamport } from '../utils.js';
import type { Entity, TopicSummary } from '../types.js';

beforeEach(() => {
  resetLamport();
});

describe('LWWRegister', () => {
  it('stores and retrieves values', () => {
    const reg = new LWWRegister<string>('agent-a');
    reg.set('db', 'PostgreSQL', 1);
    expect(reg.get('db')).toBe('PostgreSQL');
  });

  it('last writer wins on conflict', () => {
    const reg = new LWWRegister<string>('agent-a');
    reg.set('db', 'PostgreSQL', 1);
    reg.set('db', 'SQLite', 2);
    expect(reg.get('db')).toBe('SQLite');
  });

  it('ignores older writes', () => {
    const reg = new LWWRegister<string>('agent-a');
    reg.set('db', 'SQLite', 2);
    reg.set('db', 'PostgreSQL', 1);
    expect(reg.get('db')).toBe('SQLite');
  });

  it('merges two registers', () => {
    const a = new LWWRegister<string>('agent-a');
    const b = new LWWRegister<string>('agent-b');

    a.set('db', 'PostgreSQL', 1);
    b.set('db', 'SQLite', 2);
    b.set('cache', 'Redis', 1);

    a.merge(b);

    expect(a.get('db')).toBe('SQLite'); // B's later timestamp wins
    expect(a.get('cache')).toBe('Redis');
  });

  it('serializes and deserializes', () => {
    const a = new LWWRegister<string>('agent-a');
    a.set('db', 'PostgreSQL', 1);

    const serialized = a.serialize();
    const b = LWWRegister.deserialize<string>('agent-b', serialized);

    expect(b.get('db')).toBe('PostgreSQL');
  });
});

describe('ORSet', () => {
  it('adds and checks elements', () => {
    const set = new ORSet<string>('agent-a');
    set.add('React');
    expect(set.has('React')).toBe(true);
    expect(set.has('Vue')).toBe(false);
  });

  it('removes elements', () => {
    const set = new ORSet<string>('agent-a');
    set.add('React');
    set.remove('React');
    expect(set.has('React')).toBe(false);
  });

  it('add-wins on concurrent add/remove', () => {
    const a = new ORSet<string>('agent-a');
    const b = new ORSet<string>('agent-b');

    a.add('React');
    // B doesn't know about A's add, so B has no React to remove
    b.add('React'); // B independently adds React

    a.remove('React'); // A removes React

    // Merge: B's add should win over A's remove (add-wins)
    a.merge(b);
    expect(a.has('React')).toBe(true);
  });

  it('merges two sets with unique elements', () => {
    const a = new ORSet<string>('agent-a');
    const b = new ORSet<string>('agent-b');

    a.add('React');
    b.add('Vue');

    a.merge(b);

    expect(a.has('React')).toBe(true);
    expect(a.has('Vue')).toBe(true);
    expect(a.size).toBe(2);
  });

  it('deduplicates values', () => {
    const set = new ORSet<string>('agent-a');
    set.add('React');
    set.add('React');
    expect(set.values()).toHaveLength(1);
  });
});

describe('GSet', () => {
  it('adds elements (grow-only)', () => {
    const set = new GSet<string>();
    set.add('summary-1');
    set.add('summary-2');
    expect(set.size).toBe(2);
  });

  it('deduplicates identical elements', () => {
    const set = new GSet<string>();
    set.add('summary-1');
    set.add('summary-1');
    expect(set.size).toBe(1);
  });

  it('merges via set union', () => {
    const a = new GSet<string>();
    const b = new GSet<string>();

    a.add('summary-1');
    b.add('summary-2');

    a.merge(b);
    expect(a.size).toBe(2);
    expect(a.has('summary-1')).toBe(true);
    expect(a.has('summary-2')).toBe(true);
  });
});

describe('AgentMemory', () => {
  const makeEntity = (name: string): Entity => ({
    name,
    type: 'component',
    properties: {},
    firstMention: '1',
    lastMention: '1',
  });

  it('stores and retrieves invariants', () => {
    const memory = new AgentMemory('agent-a');
    memory.setInvariant('database', 'PostgreSQL');
    expect(memory.getInvariant('database')).toBe('PostgreSQL');
  });

  it('stores and retrieves entities', () => {
    const memory = new AgentMemory('agent-a');
    memory.addEntity(makeEntity('users-table'));
    expect(memory.hasEntity('users-table')).toBe(true);
    expect(memory.getEntities()).toHaveLength(1);
  });

  it('merges two agent memories', () => {
    const a = new AgentMemory('agent-a');
    const b = new AgentMemory('agent-b');

    a.setInvariant('database', 'PostgreSQL');
    a.addEntity(makeEntity('users-table'));

    b.setInvariant('database', 'SQLite'); // Later correction
    b.addEntity(makeEntity('auth-module'));

    a.mergeFrom(b.serialize());

    // B's later timestamp wins for 'database'
    expect(a.getInvariant('database')).toBe('SQLite');
    // Both entities retained (OR-Set add-wins)
    expect(a.hasEntity('users-table')).toBe(true);
    expect(a.hasEntity('auth-module')).toBe(true);
  });

  it('serializes and deserializes', () => {
    const a = new AgentMemory('agent-a');
    a.setInvariant('project', 'shorthand');
    a.addEntity(makeEntity('compactor'));

    const serialized = a.serialize();
    const b = AgentMemory.deserialize(serialized);

    expect(b.getInvariant('project')).toBe('shorthand');
    expect(b.hasEntity('compactor')).toBe(true);
  });
});
