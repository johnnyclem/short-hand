/**
 * Context-shift benchmark for ActiveEngram interpretation.
 *
 * Thesis: when context has shifted between write-time and read-time, an LM-tier
 * interpreter should produce output that more accurately reflects the read-time
 * context than the raw payload alone. This module measures that gain.
 *
 * Primary metric: contextShiftGain = interpretedScore - rawPayloadScore
 *   > 0  → interpretation added value the raw payload lacked
 *   = 0  → interpretation matched the payload's natural coverage
 *   < 0  → interpretation was destructive (rare; indicates a bad template)
 *
 * Scoring is intentionally lexical (keyword coverage) so the benchmark runs
 * without any external dependencies or embeddings. When the LM tier achieves
 * mean contextShiftGain > +0.2 vs the regex baseline, the interpretation
 * framing is validated.
 */

import type { EngramInterpreter, InterpreterBound } from '../crdt/engram-interpreter.js';
import { DEFAULT_BOUND } from '../crdt/engram-interpreter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextShiftTask {
  /** Stable identifier for the scenario. */
  id: string;
  /** Human-readable description of the shift being tested. */
  description: string;
  /** The fact as stored at write-time — the engram payload. */
  payload: string;
  /** Context at write-time (used in the template to frame the original note). */
  writeContext: string;
  /** Context at retrieval time — this is what has shifted. */
  readContext: string;
  /**
   * Keywords a good interpretation of the shifted context should surface.
   * These should be absent from the raw payload (or only partially present)
   * so that contextShiftGain > 0 represents a genuine improvement.
   */
  expectedKeywords: string[];
  /** The interpreter template to use (becomes the LM prompt for LM tiers). */
  interpreterTemplate: string;
}

export interface InterpreterBenchmarkResult {
  /** Interpreter label (e.g. "regex", "local/mistral", "host/claude-haiku"). */
  tier: string;
  /** The interpreted output produced by this interpreter. */
  interpreted: string;
  /** KeywordCoverageScorer score for the interpreted output. 0.0–1.0. */
  interpretedScore: number;
  /** The raw payload, unchanged. */
  rawPayload: string;
  /** KeywordCoverageScorer score for the raw payload. Establishes baseline. */
  rawPayloadScore: number;
  /**
   * Primary metric: interpretedScore - rawPayloadScore.
   * Positive = interpretation surfaced keywords the raw payload lacked.
   */
  contextShiftGain: number;
}

export interface BenchmarkResult {
  task: ContextShiftTask;
  results: InterpreterBenchmarkResult[];
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Measures keyword coverage of a text against a set of expected keywords.
 *
 * Score = fraction of expectedKeywords present as case-insensitive substrings.
 * Range: 0.0 (none present) to 1.0 (all present).
 *
 * Deterministic and dependency-free. Suitable for CI.
 */
export class KeywordCoverageScorer {
  score(text: string, keywords: string[]): number {
    if (keywords.length === 0) return 1.0;
    const lower = text.toLowerCase();
    const hits = keywords.filter((kw) => lower.includes(kw.toLowerCase()));
    return hits.length / keywords.length;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class BenchmarkRunner {
  private readonly scorer = new KeywordCoverageScorer();

  /**
   * Run all tasks against each named interpreter and return results.
   *
   * @param tasks         - The scenario suite (e.g. CONTEXT_SHIFT_TASKS).
   * @param interpreters  - Map of label → EngramInterpreter to compare.
   * @param bound         - Shared bound applied to all LM calls.
   */
  async run(
    tasks: ContextShiftTask[],
    interpreters: Record<string, EngramInterpreter>,
    bound: InterpreterBound = DEFAULT_BOUND,
  ): Promise<BenchmarkResult[]> {
    const benchmarkResults: BenchmarkResult[] = [];

    for (const task of tasks) {
      const taskResults: InterpreterBenchmarkResult[] = [];

      for (const [label, interpreter] of Object.entries(interpreters)) {
        const interpreted = await interpreter.interpret(
          task.interpreterTemplate,
          task.payload,
          task.readContext,
          bound,
        );

        const interpretedScore = this.scorer.score(interpreted, task.expectedKeywords);
        const rawPayloadScore = this.scorer.score(task.payload, task.expectedKeywords);
        const contextShiftGain = interpretedScore - rawPayloadScore;

        taskResults.push({
          tier: label,
          interpreted,
          interpretedScore,
          rawPayload: task.payload,
          rawPayloadScore,
          contextShiftGain,
        });
      }

      benchmarkResults.push({ task, results: taskResults });
    }

    return benchmarkResults;
  }
}
