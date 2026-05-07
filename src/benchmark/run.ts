/**
 * CLI runner for the context-shift benchmark.
 *
 *   npm run benchmark              — offline (regex tier + KeywordJudge + echo answerer)
 *   npm run benchmark:live         — host tier (Anthropic) + LMJudge + Anthropic-backed answerer
 *
 * Live mode requires ANTHROPIC_API_KEY and a user-installed @anthropic-ai/sdk.
 * The SDK is dynamically imported; if it's not installed, the script exits
 * with a clear message rather than crashing.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContextShiftBenchmark } from './context-shift-benchmark.js';
import { KeywordJudge, LMJudge } from './judges.js';
import { STARTER_FIXTURES } from './fixtures.js';
import { RegexInterpreter } from '../interpreter/regex-interpreter.js';
import { HostInterpreter, type AnthropicLikeClient } from '../interpreter/host-interpreter.js';
import { withFallback } from '../interpreter/with-fallback.js';
import type { BenchmarkReport } from './types.js';
import type { Answerer } from './context-shift-benchmark.js';
import type { Interpreter } from '../interpreter/types.js';

interface CliArgs {
  live: boolean;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function loadAnthropicClient(): Promise<AnthropicLikeClient> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  // Indirect string defeats static module resolution: @anthropic-ai/sdk is an
  // optional peer of this package, not a declared dependency.
  const moduleName = '@anthropic-ai/sdk';
  let mod: { default: new (opts: { apiKey: string }) => AnthropicLikeClient };
  try {
    mod = (await import(moduleName)) as unknown as typeof mod;
  } catch {
    throw new Error(
      '@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk',
    );
  }
  return new mod.default({ apiKey });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let interpreter: Interpreter;
  let judge: KeywordJudge | LMJudge;
  let answerer: Answerer | undefined;
  let mode: 'offline' | 'live';

  if (args.live) {
    const client = await loadAnthropicClient();
    const model = process.env.SHORTHAND_BENCHMARK_MODEL ?? 'claude-3-5-haiku-latest';
    const host = new HostInterpreter({
      client,
      model,
      defaultMaxOutputTokens: 120,
      defaultTimeoutMs: 8_000,
    });
    interpreter = withFallback(host, new RegexInterpreter());
    judge = new LMJudge({ interpreter: host });

    // Live answerer: ask the host LM the fixture's question with the injected
    // context as the only knowledge source.
    answerer = async ({ question, injected, readContext }) => {
      const tmpl = `Use ONLY the MEMORY below to answer the QUESTION. Do not invent facts.
Output one short sentence.
MEMORY: {{payload}}
READ-TIME CONTEXT: {{context}}
QUESTION: ${question}
ANSWER:`;
      try {
        return await host.interpret(
          { template: tmpl, payload: injected, context: readContext },
          { maxOutputTokens: 80, timeoutMs: 8_000 },
        );
      } catch {
        return injected; // fall back to echo on LM failure
      }
    };
    mode = 'live';
  } else {
    interpreter = new RegexInterpreter();
    judge = new KeywordJudge();
    mode = 'offline';
  }

  const benchmark = new ContextShiftBenchmark({
    interpreter,
    judge,
    answerer,
  });

  const report = await benchmark.run(STARTER_FIXTURES);
  printSummary(mode, report);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${args.out}`);
  }
}

function printSummary(mode: 'offline' | 'live', report: BenchmarkReport): void {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(`Context-Shift Benchmark — ${mode}`);
  lines.push(`runId: ${report.runId}`);
  lines.push(`tier: ${report.interpreterTier}    judge: ${report.judge}`);
  lines.push(`fixtures: ${report.results.length}`);
  lines.push('');
  lines.push('Per-fixture:');
  for (const r of report.results) {
    const flag = r.fixture.expectRawWins ? ' [calibration]' : '';
    lines.push(
      `  ${r.fixture.id.padEnd(28)} raw=${r.raw.score.toFixed(3)}  ` +
        `interp=${r.interp.score.toFixed(3)}  Δ=${signed(r.delta)}${flag}`,
    );
  }
  lines.push('');
  lines.push(
    `Aggregate (excluding calibration): wins=${a.wins}  ties=${a.ties}  losses=${a.losses}`,
  );
  lines.push(
    `  winRate=${a.winRate.toFixed(3)}  meanLift=${signed(a.meanLift)}  ` +
      `Wilson95=[${a.wilson95[0].toFixed(3)}, ${a.wilson95[1].toFixed(3)}]`,
  );
  lines.push(`  tokens raw=${a.tokensRaw}  interp=${a.tokensInterp}`);
  console.log(lines.join('\n'));
}

function signed(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
