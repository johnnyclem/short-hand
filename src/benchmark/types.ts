/**
 * Context-shift benchmark schemas.
 */
import type { InterpreterTier } from '../interpreter/types.js';

export type ShiftType =
  | 'tech-stack'
  | 'audience'
  | 'tone'
  | 'time-frame'
  | 'scope-expansion'
  | 'terminology'
  | 'baseline';

export interface BenchmarkFixture {
  id: string;
  shiftType: ShiftType;
  payload: string;
  interpreterTemplate: string;
  writeContext: string;
  readContext: string;
  task: {
    question: string;
    expectedAnswer?: string;
    rubric?: string;
  };
  /**
   * Calibration fixtures: raw payload-dump should win this one. If
   * interpretation wins here, the judge is rewarding fluff over fidelity.
   * Excluded from win-rate / mean-lift aggregation.
   */
  expectRawWins?: boolean;
}

export interface ArmResult {
  arm: 'raw' | 'interpreted';
  injected: string;
  answer: string;
  score: number;
  tokensIn: number;
  tokensOut: number;
}

export interface FixtureResult {
  fixture: BenchmarkFixture;
  raw: ArmResult;
  interp: ArmResult;
  delta: number;
}

export interface BenchmarkAggregate {
  winRate: number;
  meanLift: number;
  wins: number;
  ties: number;
  losses: number;
  /** Wilson 95% CI on wins / (wins + losses). */
  wilson95: [number, number];
  tokensRaw: number;
  tokensInterp: number;
}

export interface BenchmarkReport {
  runId: string;
  startedAt: number;
  finishedAt: number;
  judge: 'keyword' | 'lm';
  interpreterTier: InterpreterTier;
  results: FixtureResult[];
  aggregate: BenchmarkAggregate;
}
