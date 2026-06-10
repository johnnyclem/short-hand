# QA Engineering Guide — ActiveEngram Interpreter & Context-Shift Benchmark

This guide is for the engineer who maintains the LM-tier interpreter (regex / local / host) and the held-out context-shift benchmark. If you change `src/interpreter/`, `src/crdt/active-engram-store.ts`, or `src/benchmark/`, you are the audience for this document.

## Test taxonomy

| Tier | What it covers | Where | Network? | API key? |
|---|---|---|---|---|
| Unit | Single class/function in isolation | `src/**/*.test.ts` | No | No |
| Contract | Each `Interpreter` implementation honors the bounded contract | `src/interpreter/*.test.ts` | No | No |
| Integration | `ActiveEngramStore` × interpreter; benchmark wiring | `src/crdt/active-engram-store.async.test.ts`, `src/benchmark/*.test.ts` | No | No |
| Live | Real Anthropic API call | `src/interpreter/host-interpreter.live.test.ts` (gated) | Yes | Yes (`ANTHROPIC_API_KEY`) |
| Benchmark | Held-out context-shift suite | CLI, not vitest | Optional | Optional |

## Running tests locally and in CI

```bash
npm test                           # all offline tests; live test is skipped
npm run lint                       # type check, including @ts-expect-error pins
ANTHROPIC_API_KEY=... npm test     # also runs the live host integration test
```

CI runs without an API key. The live test detects the missing key via `it.skipIf(!process.env.ANTHROPIC_API_KEY)` and skips silently.

## Running the benchmark

**Offline (deterministic, CI-safe):**

```bash
npm run benchmark
npm run benchmark -- --out artifacts/benchmark-offline.json
```

The offline run wires `RegexInterpreter` + `KeywordJudge` + `echoAnswerer`. With the starter fixtures, it should print `winRate >= 0.6`, `meanLift > 0`, and a Wilson 95% lower bound `> 0.5`. The baseline fixture (`baseline-raw-wins-01`) is excluded from the win-rate denominator — raw is expected to tie or win there.

**Live (Anthropic-backed):**

```bash
ANTHROPIC_API_KEY=sk-ant-... npm install @anthropic-ai/sdk   # one-time
ANTHROPIC_API_KEY=sk-ant-... npm run benchmark:live -- --out artifacts/benchmark-live.json
```

The SDK is a structural dependency, not a declared one — install it yourself in your environment. Optional env vars:

- `SHORTHAND_BENCHMARK_MODEL` — default `claude-3-5-haiku-latest`.

## Authoring a new context-shift fixture

Schema is in `src/benchmark/types.ts` (`BenchmarkFixture`).

**Do:**
- Pick exactly one shift axis (`shiftType`). If your fixture exercises two axes, split it.
- Make `interpreterTemplate` carry the read-time-relevant material in plain prose. The template gets substituted with `{{context}}` and `{{payload}}` and the result becomes the injected text — it is what the judge sees.
- Make `task.expectedAnswer` a short phrase containing the read-context-relevant terms you expect the interpreted output to surface.
- Add at least one `expectRawWins: true` calibration fixture per new shift type. Calibration fixtures are short, verbatim payloads (UUIDs, fingerprints, exact strings) where interpretation cannot help and may hurt.

**Don't:**
- Don't leak the answer into the template via `{{payload}}` interpolation tricks. The benchmark measures whether the interpreter (regex or LM) writes a contextualized restatement. If the template literally embeds the answer, you're testing the fixture, not the interpreter.
- Don't write fixtures whose `expectedAnswer` is identical to `payload` for non-baseline cases. That's a baseline by definition.
- Don't put fixture `id` collisions in the suite — IDs are used in artifact diffs.

## Authoring a new interpreter tier

1. Implement `Interpreter` from `src/interpreter/types.ts`.
2. Constructor accepts an injectable client (HTTP client, SDK instance, etc.) — never reach for global state.
3. `InterpretInput` is `{ template, payload, context }` and **only those three fields**. Adding any field is a structural break of the safety boundary; tests will fail.
4. Honor `InterpretOptions.maxOutputTokens` and `InterpretOptions.timeoutMs`. On violation, throw `InterpreterBudgetError` with reason `'output_too_long'` or `'timeout'`.
5. Honor `InterpretOptions.signal`. Throw `AbortError` when the caller cancels.
6. On backend unavailability (no API key, network refused, missing model), throw `InterpreterUnavailableError` so `withFallback` routes deterministically.
7. Required smoke tests before merge:
   - happy path
   - timeout
   - backend error → `InterpreterUnavailableError`
   - output cap exceeded → `InterpreterBudgetError('output_too_long')`
   - caller signal abort → `AbortError`
   - serialized request body contains no fields besides what comes from `InterpretInput`

## Safety regression checklist

Before merging changes that touch `src/interpreter/`, `src/crdt/active-engram-store.ts`, or anything that calls them, verify each of these:

- [ ] `ActivationPolicy` (in `src/types.ts`) has zero method-typed fields. Check by reading the interface and by `Object.keys(policy).filter(k => typeof policy[k] === 'function')` in a test.
- [ ] `importanceScore` is mutated only by `ActiveEngramStore.setImportance()`. Search the codebase for `importanceScore =` — there should be exactly one assignment outside the type/test files (in `setImportance`) and the initialization in `add()`.
- [ ] `InterpretInput` has only `template`, `payload`, `context`. The compile-time `@ts-expect-error` pin in `src/crdt/active-engram-store.async.test.ts` enforces this — if it stops erroring, you have a regression.
- [ ] No interpreter implementation reads `importanceScore`, `activationPolicy`, `id`, or `retrievalCount`. Wire-level test in `host-interpreter.test.ts` enforces this for the host tier; replicate the test for any new tier.
- [ ] The bounded contract is enforced. Every interpreter has tests for timeout, output-cap, and abort.

## Constructing your own Anthropic client

`HostInterpreter` accepts a structural client to keep this package zero-runtime-deps. Construct your own with the SDK:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { HostInterpreter } from 'short-hand';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const interpreter = new HostInterpreter({
  client,
  model: 'claude-3-5-haiku-latest',
});
```

Or wire any fetch-based client that exposes `messages.create({ model, max_tokens, system, messages })`.

## Debugging a failed benchmark run

Each run writes a `BenchmarkReport` JSON when `--out` is given. Per-fixture entries include both arms' `injected` text, the `answer`, `score`, and `delta`.

To debug a regression:

1. Diff `injected` between the failing run and the last-good run for the same fixture id. The interpreter output is the variable.
2. Re-run a single fixture by importing `STARTER_FIXTURES`, filtering by id, and running `ContextShiftBenchmark.run([fixture])` in a one-off script.
3. If the live run regresses but offline doesn't, inspect the host model's output text. The bounded contract caps tokens — output that gets truncated mid-sentence is the most common cause of score drops. Bump `maxOutputTokens` if the cap was the problem; otherwise revise the system prompt.
4. If the safety regression tests fail, treat as a release blocker. The structural boundary is the entire reason `ActivationPolicy` is methodless.

## Pass/fail thresholds

Documented as the **thesis-alive gate** in `src/benchmark/context-shift-benchmark.test.ts`:

> Excluding fixtures marked `expectRawWins: true`:
> - `winRate >= 0.6`
> - `meanLift >= 0`
> - Wilson 95% lower bound on `wins / (wins + losses)` > 0.5

If those fail on the offline run after a clean change, the change broke something concrete and obvious. Investigate before merging.

If those fail on the live run after a clean change, the framing might be wrong, OR the fixture suite is too narrow, OR the judge prompt is too strict. Keep at least one of the failing fixtures and a copy of the report; the failure is the result you paid for.

## How to add an LM provider beyond Anthropic / Ollama

1. Create `src/interpreter/<provider>-interpreter.ts` implementing `Interpreter`.
2. Take a structural client in the constructor — no SDK import.
3. Reuse the system + user prompt shape from `host-interpreter.ts` for consistency across providers.
4. Map provider-specific failures into `InterpreterBudgetError` / `InterpreterUnavailableError` per the contract.
5. Add tests matching the smoke set above.
6. Re-export from `src/interpreter/index.ts` and `src/index.ts`.
7. The benchmark CLI (`src/benchmark/run.ts`) demonstrates the live wiring shape — copy that pattern for your provider and document the env vars in this file.
