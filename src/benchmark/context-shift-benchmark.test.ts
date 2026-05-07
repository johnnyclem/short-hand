/**
 * Context-shift benchmark tests.
 *
 * All tests use RegexInterpreter — deterministic, no network, CI-safe.
 * These tests document the regex-tier baseline: contextShiftGain ≈ 0.
 * LM-tier tests require live API keys and are covered in docs/qa-guide.md.
 */

import { describe, it, expect } from 'vitest';
import {
  KeywordCoverageScorer,
  BenchmarkRunner,
  type ContextShiftTask,
} from './context-shift-benchmark.js';
import { RegexInterpreter } from '../crdt/engram-interpreter.js';
import { CONTEXT_SHIFT_TASKS } from './tasks.js';

// ---------------------------------------------------------------------------
// KeywordCoverageScorer
// ---------------------------------------------------------------------------

describe('KeywordCoverageScorer', () => {
  const scorer = new KeywordCoverageScorer();

  it('scores 1.0 when all keywords are present', () => {
    expect(scorer.score('use redis for caching in the web app', ['redis', 'caching', 'web'])).toBe(1.0);
  });

  it('scores 0.0 when no keywords are present', () => {
    expect(scorer.score('unrelated text about databases', ['fastapi', 'gcp', 'svelte'])).toBe(0.0);
  });

  it('scores fractionally for partial coverage', () => {
    const score = scorer.score('use redis for the app', ['redis', 'caching', 'web']);
    expect(score).toBeCloseTo(1 / 3);
  });

  it('is case-insensitive', () => {
    expect(scorer.score('We use REDIS and Caching', ['redis', 'caching'])).toBe(1.0);
  });

  it('returns 1.0 for an empty keywords array', () => {
    expect(scorer.score('any text', [])).toBe(1.0);
  });

  it('matches keywords as substrings', () => {
    // "pub/sub" contains "/" which is valid substring
    expect(scorer.score('use pub/sub for messaging', ['pub/sub'])).toBe(1.0);
  });

  it('score is in [0, 1]', () => {
    const score = scorer.score('some text', ['a', 'b', 'c', 'd']);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// BenchmarkRunner
// ---------------------------------------------------------------------------

describe('BenchmarkRunner', () => {
  it('returns one BenchmarkResult per task', async () => {
    const runner = new BenchmarkRunner();
    const tasks: ContextShiftTask[] = [CONTEXT_SHIFT_TASKS[0], CONTEXT_SHIFT_TASKS[1]];
    const results = await runner.run(tasks, { regex: new RegexInterpreter() });
    expect(results).toHaveLength(2);
  });

  it('each BenchmarkResult has one InterpreterBenchmarkResult per interpreter', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run(
      [CONTEXT_SHIFT_TASKS[0]],
      { regexA: new RegexInterpreter(), regexB: new RegexInterpreter() },
    );
    expect(results[0].results).toHaveLength(2);
  });

  it('result tier label matches the key in the interpreters map', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run([CONTEXT_SHIFT_TASKS[0]], { 'my-tier': new RegexInterpreter() });
    expect(results[0].results[0].tier).toBe('my-tier');
  });

  it('interpretedScore is in [0, 1]', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run([CONTEXT_SHIFT_TASKS[0]], { regex: new RegexInterpreter() });
    const { interpretedScore } = results[0].results[0];
    expect(interpretedScore).toBeGreaterThanOrEqual(0);
    expect(interpretedScore).toBeLessThanOrEqual(1);
  });

  it('rawPayloadScore is in [0, 1]', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run([CONTEXT_SHIFT_TASKS[0]], { regex: new RegexInterpreter() });
    const { rawPayloadScore } = results[0].results[0];
    expect(rawPayloadScore).toBeGreaterThanOrEqual(0);
    expect(rawPayloadScore).toBeLessThanOrEqual(1);
  });

  it('contextShiftGain = interpretedScore - rawPayloadScore (numeric identity)', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run([CONTEXT_SHIFT_TASKS[0]], { regex: new RegexInterpreter() });
    const { contextShiftGain, interpretedScore, rawPayloadScore } = results[0].results[0];
    expect(contextShiftGain).toBeCloseTo(interpretedScore - rawPayloadScore);
  });

  it('rawPayload matches the task payload verbatim', async () => {
    const runner = new BenchmarkRunner();
    const task = CONTEXT_SHIFT_TASKS[0];
    const results = await runner.run([task], { regex: new RegexInterpreter() });
    expect(results[0].results[0].rawPayload).toBe(task.payload);
  });

  it('result.task matches the input task', async () => {
    const runner = new BenchmarkRunner();
    const task = CONTEXT_SHIFT_TASKS[2];
    const results = await runner.run([task], { regex: new RegexInterpreter() });
    expect(results[0].task.id).toBe(task.id);
  });

  it('interpreted output is a non-empty string', async () => {
    const runner = new BenchmarkRunner();
    const results = await runner.run([CONTEXT_SHIFT_TASKS[0]], { regex: new RegexInterpreter() });
    expect(results[0].results[0].interpreted).toBeTruthy();
    expect(typeof results[0].results[0].interpreted).toBe('string');
  });

  it('runs all CONTEXT_SHIFT_TASKS without error (smoke test)', async () => {
    const runner = new BenchmarkRunner();
    await expect(
      runner.run(CONTEXT_SHIFT_TASKS, { regex: new RegexInterpreter() }),
    ).resolves.toHaveLength(CONTEXT_SHIFT_TASKS.length);
  });

  it('regex tier contextShiftGain is ≤ 0.1 on average (documents baseline)', async () => {
    // The regex interpreter can only substitute {{payload}} and {{context}} —
    // it cannot inject domain-specific read-time vocabulary. The expected
    // keywords in each task are absent from the raw payload, so the interpreted
    // output (which contains the payload + literal context string) won't match
    // them either. Mean gain should be at or near zero.
    const runner = new BenchmarkRunner();
    const results = await runner.run(CONTEXT_SHIFT_TASKS, { regex: new RegexInterpreter() });
    const gains = results.map((r) => r.results[0].contextShiftGain);
    const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
    expect(mean).toBeLessThanOrEqual(0.1);
  });
});

// ---------------------------------------------------------------------------
// CONTEXT_SHIFT_TASKS suite shape
// ---------------------------------------------------------------------------

describe('CONTEXT_SHIFT_TASKS', () => {
  it('contains exactly 6 tasks', () => {
    expect(CONTEXT_SHIFT_TASKS).toHaveLength(6);
  });

  it('each task has a unique id', () => {
    const ids = CONTEXT_SHIFT_TASKS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('each task has at least one expectedKeyword', () => {
    for (const task of CONTEXT_SHIFT_TASKS) {
      expect(task.expectedKeywords.length).toBeGreaterThan(0);
    }
  });

  it('each task payload does not contain all expected keywords verbatim', () => {
    // This validates the task design: raw payload should score < 1.0 so
    // there is room for an LM interpreter to show improvement.
    const scorer = new KeywordCoverageScorer();
    for (const task of CONTEXT_SHIFT_TASKS) {
      const rawScore = scorer.score(task.payload, task.expectedKeywords);
      expect(rawScore).toBeLessThan(1.0);
    }
  });

  it('each task has a non-empty interpreterTemplate with {{payload}} placeholder', () => {
    for (const task of CONTEXT_SHIFT_TASKS) {
      expect(task.interpreterTemplate).toContain('{{payload}}');
    }
  });
});
