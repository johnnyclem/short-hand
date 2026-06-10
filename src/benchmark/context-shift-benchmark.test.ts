/**
 * Context-shift benchmark — deterministic offline run.
 *
 * The five non-baseline fixtures have interpreterTemplates that surface
 * read-context-relevant terms that a raw payload-dump does not. With the
 * KeywordJudge + echo answerer, the interpreted arm should beat the raw arm
 * on each. The baseline fixture has a verbatim payload and a raw-favored
 * question — interpretation should not win there.
 */
import { describe, it, expect } from 'vitest';
import { ContextShiftBenchmark, wilson95 } from './context-shift-benchmark.js';
import { KeywordJudge } from './judges.js';
import { STARTER_FIXTURES } from './fixtures.js';
import { RegexInterpreter } from '../interpreter/regex-interpreter.js';

describe('ContextShiftBenchmark — offline regex+keyword', () => {
  it('runs all starter fixtures (6 non-baseline + 1 calibration)', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
      clock: () => 1_700_000_000_000,
      runIdFactory: () => 'fixed-run',
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.results).toHaveLength(7);
    expect(report.results.filter((r) => r.fixture.expectRawWins)).toHaveLength(1);
    expect(report.runId).toBe('fixed-run');
    expect(report.judge).toBe('keyword');
    expect(report.interpreterTier).toBe('regex');
  });

  it('interpreted arm beats raw on each non-baseline fixture', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    const nonBaseline = report.results.filter((r) => !r.fixture.expectRawWins);
    for (const r of nonBaseline) {
      expect(r.interp.score, `fixture ${r.fixture.id}`).toBeGreaterThan(r.raw.score);
    }
  });

  it('baseline fixture: raw >= interp', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    const baseline = report.results.find((r) => r.fixture.expectRawWins);
    expect(baseline).toBeDefined();
    expect(baseline!.raw.score).toBeGreaterThanOrEqual(baseline!.interp.score);
  });

  it('aggregate winRate >= 0.6 and meanLift > 0 (excluding baseline)', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.aggregate.winRate).toBeGreaterThanOrEqual(0.6);
    expect(report.aggregate.meanLift).toBeGreaterThan(0);
  });

  it('token accounting > 0 and finite for both arms', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.aggregate.tokensRaw).toBeGreaterThan(0);
    expect(report.aggregate.tokensInterp).toBeGreaterThan(0);
    expect(Number.isFinite(report.aggregate.tokensRaw)).toBe(true);
    expect(Number.isFinite(report.aggregate.tokensInterp)).toBe(true);
  });

  it('thesis-alive gate: Wilson 95% lower bound > 0.5', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.aggregate.wilson95[0]).toBeGreaterThan(0.5);
  });
});

describe('wilson95', () => {
  it('returns [0, 1] for n=0', () => {
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });

  it('returns a tight CI for 5/5', () => {
    const [lo, hi] = wilson95(5, 5);
    expect(lo).toBeGreaterThan(0.5);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it('center near 0.5 for 5/10', () => {
    const [lo, hi] = wilson95(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});
