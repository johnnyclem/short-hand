/**
 * Pluggable scorers for the context-shift benchmark.
 *
 * KeywordJudge — token-overlap F1 vs expectedAnswer. Deterministic, CI-safe.
 * LMJudge      — uses an injected Interpreter to grade against a strict rubric.
 */
import {
  silentLogger,
  type Interpreter,
  type InterpreterLogger,
} from '../interpreter/types.js';

export interface JudgeArgs {
  answer: string;
  expectedAnswer?: string;
  rubric?: string;
  readContext: string;
}

export interface Judge {
  readonly name: 'keyword' | 'lm';
  score(args: JudgeArgs): Promise<number>;
}

const TOKEN_RX = /[a-z0-9]+/g;
const STOPWORDS = new Set([
  'the','a','an','of','and','or','to','for','in','on','at','is','are','was','were',
  'be','been','being','it','this','that','as','with','by','from','into','about',
  'we','you','i','our','their','its','his','her',
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(TOKEN_RX) ?? []).filter((t) => !STOPWORDS.has(t));
}

function recall(answerTokens: string[], expectedTokens: string[]): number {
  if (expectedTokens.length === 0) return 0;
  const a = new Set(answerTokens);
  const e = new Set(expectedTokens);
  let overlap = 0;
  for (const t of e) if (a.has(t)) overlap++;
  return overlap / e.size;
}

/**
 * KeywordJudge — recall of expected tokens in the answer (with a substring
 * fallback for very short expected strings).
 *
 * Recall, not F1: we are scoring "did the injected text surface the right
 * information?", and a longer interpreted output that includes more relevant
 * terms is exactly the signal we want to reward. Penalizing length (F1)
 * would defeat the purpose for the echo-answerer benchmark setup.
 */
export class KeywordJudge implements Judge {
  readonly name = 'keyword' as const;

  async score(args: JudgeArgs): Promise<number> {
    const expected = args.expectedAnswer ?? args.rubric ?? '';
    if (!expected) return 0;

    // Verbatim short string (UUIDs, fingerprints): substring is the right test.
    if (expected.length <= 32 && /[A-Z0-9:]{6,}/.test(expected)) {
      return args.answer.includes(expected) ? 1 : 0;
    }

    const expectedTokens = tokenize(expected);
    const answerTokens = tokenize(args.answer);
    return recall(answerTokens, expectedTokens);
  }
}

export interface LMJudgeOptions {
  interpreter: Interpreter;
  maxOutputTokens?: number;
  timeoutMs?: number;
  logger?: InterpreterLogger;
}

export class LMJudge implements Judge {
  readonly name = 'lm' as const;

  private readonly interpreter: Interpreter;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly logger: InterpreterLogger;

  constructor(opts: LMJudgeOptions) {
    this.interpreter = opts.interpreter;
    this.maxOutputTokens = opts.maxOutputTokens ?? 80;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.logger = opts.logger ?? silentLogger;
  }

  async score(args: JudgeArgs): Promise<number> {
    const rubric =
      args.rubric ??
      (args.expectedAnswer
        ? `matches expectedAnswer: ${args.expectedAnswer}`
        : 'no rubric');

    // The judge uses the Interpreter contract structurally: template carries
    // the grading instructions, payload carries the answer, context carries
    // the read-time context.
    const template = `You are a strict grader. Score the ANSWER on a scale of 0.0 to 1.0 based on how well it satisfies the RUBRIC for the given READ-TIME CONTEXT.
Output ONLY a JSON object: {"score": <number 0..1>, "reason": "<≤20 words>"}.
RUBRIC: ${rubric}
READ-TIME CONTEXT: {{context}}
ANSWER: {{payload}}`;

    let raw: string;
    try {
      raw = await this.interpreter.interpret(
        { template, payload: args.answer, context: args.readContext },
        { maxOutputTokens: this.maxOutputTokens, timeoutMs: this.timeoutMs },
      );
    } catch (err) {
      this.logger.warn('lm_judge_unavailable', {
        message: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    return parseScore(raw, this.logger);
  }
}

function parseScore(raw: string, logger: InterpreterLogger): number {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn('lm_judge_unparseable', { raw });
    return 0;
  }
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown };
    if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
      logger.warn('lm_judge_no_score', { raw });
      return 0;
    }
    return Math.max(0, Math.min(1, parsed.score));
  } catch {
    logger.warn('lm_judge_unparseable', { raw });
    return 0;
  }
}
