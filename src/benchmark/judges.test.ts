import { describe, it, expect, vi } from 'vitest';
import { KeywordJudge, LMJudge } from './judges.js';
import type { Interpreter } from '../interpreter/types.js';

describe('KeywordJudge', () => {
  const judge = new KeywordJudge();

  it('returns ~1.0 for identical content', async () => {
    const score = await judge.score({
      answer: 'user prefers CLI tools',
      expectedAnswer: 'user prefers CLI tools',
      readContext: 'irrelevant',
    });
    expect(score).toBeGreaterThan(0.9);
  });

  it('returns 0 for fully disjoint content', async () => {
    const score = await judge.score({
      answer: 'apples bananas oranges',
      expectedAnswer: 'rockets satellites probes',
      readContext: 'irrelevant',
    });
    expect(score).toBe(0);
  });

  it('substring fallback wins for short verbatim expected answers', async () => {
    const score = await judge.score({
      answer: 'the fingerprint is SHA256:9f2b3c5d7e1a in the rotation log',
      expectedAnswer: 'SHA256:9f2b3c5d7e1a',
      readContext: 'irrelevant',
    });
    expect(score).toBe(1);
  });

  it('returns 0 when no expectedAnswer or rubric is given', async () => {
    const score = await judge.score({ answer: 'x', readContext: 'c' });
    expect(score).toBe(0);
  });
});

function stubInterpreter(out: string): Interpreter {
  return { tier: 'host', interpret: async () => out };
}

describe('LMJudge', () => {
  it('parses a JSON score response', async () => {
    const j = new LMJudge({
      interpreter: stubInterpreter('{"score": 0.7, "reason": "ok"}'),
    });
    const score = await j.score({ answer: 'a', readContext: 'c', rubric: 'r' });
    expect(score).toBe(0.7);
  });

  it('clamps to [0, 1]', async () => {
    const j = new LMJudge({
      interpreter: stubInterpreter('{"score": 1.5, "reason": "x"}'),
    });
    expect(await j.score({ answer: 'a', readContext: 'c' })).toBe(1);
  });

  it('returns 0 on malformed JSON', async () => {
    const warn = vi.fn();
    const j = new LMJudge({
      interpreter: stubInterpreter('not json at all'),
      logger: { warn },
    });
    const score = await j.score({ answer: 'a', readContext: 'c' });
    expect(score).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('returns 0 when interpreter throws', async () => {
    const j = new LMJudge({
      interpreter: { tier: 'host', interpret: async () => { throw new Error('x'); } },
    });
    expect(await j.score({ answer: 'a', readContext: 'c' })).toBe(0);
  });
});
