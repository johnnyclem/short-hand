# QA Engineering Guide — ActiveEngram Interpreter & Context-Shift Benchmark

## 1. Overview

This guide covers quality assurance for two subsystems added in the second implementation weekend:

1. **`EngramInterpreter` abstraction** (`src/crdt/engram-interpreter.ts`) — three-tier LM interpretation replacing the private `resolveTemplate()` function as the extensible read-path mechanism.
2. **Context-shift benchmark** (`src/benchmark/`) — a held-out task suite measuring whether LM-tier interpretation adds value over the regex baseline when context has shifted between write-time and read-time.

### The thesis being validated

> When context shifts between write-time (when an engram was created) and read-time (when it is retrieved), an LM-tier interpreter should produce output that more accurately reflects the read-time framing than the raw payload alone.

**Pass criterion:** Mean `contextShiftGain` for LM tiers > **+0.2** compared to the regex baseline (mean ≈ 0) across the six canonical tasks. If this is not met, the interpretation framing needs re-evaluation — not more polish.

### Safety invariants that must never regress

- `retrieveAsync` increments `retrievalCount` (same semantics as `retrieve`)
- `interpretAsync` does NOT increment `retrievalCount` (preview semantics)
- `importanceScore` is never modified by retrieval (addiction-loop guard)
- `ActivationPolicy` remains a plain data interface — no callable properties

---

## 2. Automated tests

Run the full suite:

```bash
npm test
```

All tests are deterministic, network-free, and should pass in CI with no environment variables set.

### Test groups and what they verify

| File | Group | Key assertions |
|------|-------|----------------|
| `engram-interpreter.test.ts` | `RegexInterpreter` | Template substitution correctness, async interface, multiple occurrences |
| `engram-interpreter.test.ts` | `LocalLMInterpreter` | POST URL, body shape (`stream:false`, `num_predict`), `data.response.trim()`, HTTP error propagation, timeout abort |
| `engram-interpreter.test.ts` | `HostLMInterpreter — Anthropic` | `/v1/messages` URL, `x-api-key` + `anthropic-version` headers, text block extraction, custom `baseUrl`, HTTP error + timeout |
| `engram-interpreter.test.ts` | `HostLMInterpreter — OpenAI` | `/v1/chat/completions` URL, `Authorization: Bearer` header, `choices[0]` extraction, HTTP error + timeout |
| `engram-interpreter.test.ts` | `createInterpreter` | Each tier returns correct class; duck-type interface check |
| `engram-interpreter.test.ts` | `retrieveAsync` | Matches sync `retrieve()`, bumps retrievalCount, shadow resolution, error propagation from interpreter |
| `engram-interpreter.test.ts` | `interpretAsync` | Does NOT bump retrievalCount, undefined on missing id, context-dependent output |
| `context-shift-benchmark.test.ts` | `KeywordCoverageScorer` | Boundary scores, case-insensitivity, empty keywords, substring matching |
| `context-shift-benchmark.test.ts` | `BenchmarkRunner` | Result shape, score ranges, `contextShiftGain` identity, all 6 tasks smoke |
| `context-shift-benchmark.test.ts` | `BenchmarkRunner` — baseline | Regex mean `contextShiftGain ≤ 0.1` (documents the baseline) |
| `context-shift-benchmark.test.ts` | `CONTEXT_SHIFT_TASKS` | 6 unique tasks, each with expectedKeywords not fully present in payload |

**Fetch mocking strategy:** `vi.stubGlobal('fetch', vi.fn())` in each test that exercises LM tiers. Cleaned up by `afterEach(() => vi.unstubAllGlobals())`. Timeout tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` against a permanently-hanging fetch stub.

---

## 3. Manual LM-tier smoke tests

These require a running LM endpoint. Not run in CI by default.

### 3.1 Local tier — ollama

**Prerequisites:**
```bash
brew install ollama          # or https://ollama.com/download
ollama serve                 # keep running in background
ollama pull mistral          # ~4 GB; use llama3.2 for smaller download
```

**Smoke script** (Node REPL or a `ts-node`/`tsx` script):
```typescript
import { LocalLMInterpreter } from './src/crdt/engram-interpreter.js';

const interp = new LocalLMInterpreter({
  endpoint: 'http://localhost:11434',
  model: 'mistral',
});

const result = await interp.interpret(
  'Given that we are now {{context}}, how does the earlier note "{{payload}}" apply? Restate it.',
  'We are using Express.js with TypeScript for the API layer.',
  'migrating all services to Python with FastAPI',
  { maxTokens: 256, timeoutMs: 30_000 },
);

console.log(result);
```

**Pass criterion:** Non-empty string that mentions Python, FastAPI, or migration concepts from the read-time context — not just a verbatim repeat of the payload. If the output is purely `"We are using Express.js..."`, the model is not following the prompt; try `mistral:7b-instruct` or a larger quantization.

### 3.2 Host tier — Anthropic

**Prerequisites:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Smoke script:**
```typescript
import { HostLMInterpreter } from './src/crdt/engram-interpreter.js';

const interp = new HostLMInterpreter({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const result = await interp.interpret(
  'Given that we are now {{context}}, reframe "{{payload}}" for this new audience.',
  'The p99 latency SLO is 200ms enforced via nginx rate-limiting.',
  'presenting to the VP of Product and CFO for budget approval',
  { maxTokens: 200, timeoutMs: 15_000 },
);

console.log(result);
```

**Pass criterion:** Output addresses cost, reliability, or business impact — not latency percentiles or nginx specifics.

### 3.3 Host tier — OpenAI

**Prerequisites:**
```bash
export OPENAI_API_KEY=sk-...
```

**Smoke script:**
```typescript
import { HostLMInterpreter } from './src/crdt/engram-interpreter.js';

const interp = new HostLMInterpreter({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY!,
});

const result = await interp.interpret(
  'Given that we are now {{context}}, what is the equivalent of "{{payload}}" in this environment?',
  'We use S3 for blob storage, SQS for message queues, and Lambda for event processing.',
  'full migration to Google Cloud Platform',
  { maxTokens: 200, timeoutMs: 15_000 },
);

console.log(result);
```

**Pass criterion:** Output mentions GCS, Pub/Sub, or Cloud Functions.

---

## 4. Benchmark procedure

### 4.1 Regex baseline (automated, always-green)

```bash
npm test -- --reporter=verbose src/benchmark/context-shift-benchmark.test.ts
```

The test `"regex tier contextShiftGain is ≤ 0.1 on average"` documents the baseline. It should always pass.

### 4.2 Full LM benchmark (manual, requires live endpoints)

Create `scripts/run-benchmark.ts` (not committed; adapt per environment):

```typescript
import { BenchmarkRunner } from './src/benchmark/context-shift-benchmark.js';
import { CONTEXT_SHIFT_TASKS } from './src/benchmark/tasks.js';
import { RegexInterpreter, LocalLMInterpreter, HostLMInterpreter } from './src/crdt/engram-interpreter.js';

const runner = new BenchmarkRunner();

const results = await runner.run(
  CONTEXT_SHIFT_TASKS,
  {
    regex: new RegexInterpreter(),
    'local/mistral': new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'mistral' }),
    'host/haiku': new HostLMInterpreter({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
  { maxTokens: 300, timeoutMs: 30_000 },
);

console.log('\n=== Context-Shift Benchmark Results ===\n');
for (const { task, results: r } of results) {
  console.log(`[${task.id}] ${task.description}`);
  for (const ir of r) {
    const gain = ir.contextShiftGain.toFixed(3);
    const sign = ir.contextShiftGain >= 0 ? '+' : '';
    console.log(`  ${ir.tier.padEnd(20)} gain=${sign}${gain}  "${ir.interpreted.slice(0, 80)}..."`);
  }
  console.log();
}

// Summary table
console.log('=== Mean contextShiftGain per tier ===');
const tiers = Object.keys(results[0].results.reduce((acc, r) => ({ ...acc, [r.tier]: true }), {}));
for (const tier of tiers) {
  const gains = results.map((r) => r.results.find((ir) => ir.tier === tier)!.contextShiftGain);
  const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
  const sign = mean >= 0 ? '+' : '';
  console.log(`  ${tier.padEnd(20)} mean gain=${sign}${mean.toFixed(3)}`);
}
```

**Thesis pass criterion:** The `host/*` and `local/*` tiers should each achieve mean `contextShiftGain > +0.2`. The tasks with the largest expected gain are `audience-shift` and `security-context` (payload vocabulary is most distant from expected keywords). If a tier fails on those, inspect the raw `interpreted` output — the template may need tuning before the model call.

---

## 5. Timeout and error-path verification

### 5.1 Verify timeout fires within bound

```typescript
import { LocalLMInterpreter } from './src/crdt/engram-interpreter.js';

// Point at a non-existent server to guarantee a hang
const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:19999', model: 'x' });
const start = Date.now();
try {
  await interp.interpret('{{payload}}', 'test', 'ctx', { maxTokens: 10, timeoutMs: 500 });
  console.log('ERROR: should have thrown');
} catch (e) {
  const elapsed = Date.now() - start;
  console.log(`Threw after ${elapsed}ms: ${(e as Error).message}`);
  // Expected: elapsed < 700ms (timeout fires at 500ms + TCP overhead)
}
```

### 5.2 Verify non-200 error messages include HTTP status

```typescript
import { HostLMInterpreter } from './src/crdt/engram-interpreter.js';

const interp = new HostLMInterpreter({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: 'intentionally-bad-key',
});
try {
  await interp.interpret('{{payload}}', 'test', 'ctx', { maxTokens: 10, timeoutMs: 5000 });
} catch (e) {
  console.log((e as Error).message);
  // Expected: "Anthropic API error 401: ..."
}
```

---

## 6. CI integration

### 6.1 Default CI (always-green, no secrets)

```yaml
# .github/workflows/test.yml
- name: Test
  run: npm test
```

The default `npm test` runs all tests. LM-tier tests use mocked fetch and require no API keys.

### 6.2 Extended CI with live LM calls (optional)

Create a separate Vitest config for LM integration tests:

```typescript
// vitest.lm.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.lm.test.ts'],
    testTimeout: 60_000,
  },
});
```

Gate behind environment variable:

```typescript
// src/crdt/host-lm.lm.test.ts
import { describe, it, expect } from 'vitest';
const runLMTests = process.env.CI_RUN_LM_TESTS === 'true';

describe.skipIf(!runLMTests)('HostLMInterpreter — live Anthropic', () => {
  it('interprets a context-shift prompt', async () => {
    // live test body
  });
});
```

```yaml
# .github/workflows/lm-test.yml
- name: LM integration tests
  if: github.event_name == 'workflow_dispatch'
  env:
    CI_RUN_LM_TESTS: 'true'
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: npx vitest run --config vitest.lm.config.ts
```

**Critical:** Never commit API keys. Use GitHub Actions Secrets exclusively.

---

## 7. Adding new benchmark tasks

Each task in `src/benchmark/tasks.ts` must satisfy:

1. **Payload vocabulary ≠ expected vocabulary.** Run the scorer manually to verify `rawPayloadScore < 0.5`. If the payload already contains most expected keywords, the task cannot show LM gain.
2. **Shift is semantically significant.** The `readContext` should change something fundamental (audience, platform, scale, security model) — not just surface rephrasing.
3. **Template contains `{{payload}}`** so the engram content is always grounded in the interpretation.
4. **Expected keywords are specific.** "python" and "fastapi" are better than "programming" and "framework" — specific keywords reduce ambiguity in scoring.

To verify a new task before committing:

```typescript
import { KeywordCoverageScorer } from './src/benchmark/context-shift-benchmark.js';
import { CONTEXT_SHIFT_TASKS } from './src/benchmark/tasks.js';

const scorer = new KeywordCoverageScorer();
for (const t of CONTEXT_SHIFT_TASKS) {
  const score = scorer.score(t.payload, t.expectedKeywords);
  console.log(`${t.id}: rawPayloadScore=${score.toFixed(2)}`);
  // All should be < 0.5 to leave room for LM gain
}
```
