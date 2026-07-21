# short-hand

Progressive context compaction for LLMs. Old computer science for new constraints.

- **LSM-tree compaction** — five levels, from a raw memtable down to core invariants, with corrections tracked explicitly (tombstones) so overridden facts don't quietly resurface.
- **Active engrams** — agential memories that get *reinterpreted* at recall time instead of just replayed, backed by a pluggable regex/local/host interpreter tier and a benchmark that measures whether the reinterpretation actually helps.
- **CRDT primitives** — LWW-Register, OR-Set, G-Set, and a per-agent `AgentMemory` for merging memory across agents.
- **Zero runtime dependencies.** Fully typed. ESM-only.

## Why

Long conversations with LLMs accumulate context that eventually hits token limits. Naive truncation loses important information. Short-hand applies database-inspired compaction instead: recent messages stay verbatim, older messages progressively condense into summaries, a knowledge graph, and core invariants.

Some memories shouldn't be compacted at all — they need to be restated every time they're recalled, in light of whatever the conversation is about *now*. Short-hand's active-engram subsystem exists for exactly that case, and ships with a benchmark that measures whether the restatement step actually helps versus dumping the raw memory back in.

## Install

```bash
npm install short-hand
```

## Quick Start

```typescript
import { CompactionEngine } from 'short-hand';

const engine = new CompactionEngine({
  memtableSize: 10,   // messages to keep verbatim
  contextBudget: 4000, // max tokens in context frame
});

// Add messages as they arrive
await engine.addMessage({
  id: '1',
  role: 'user',
  content: 'We decided to use PostgreSQL instead of MySQL.',
  timestamp: Date.now(),
});

await engine.addMessage({
  id: '2',
  role: 'assistant',
  content: 'Got it. I\'ll use PostgreSQL for the database layer.',
  timestamp: Date.now(),
});

// When L0 overflows, compaction happens automatically.
// Or force it:
await engine.flush();

// Build a token-budgeted context frame for your next LLM call
const frame = engine.buildContextFrame(2000);
// frame.sections is ordered L4 invariants → L3 graph → L2 summaries → L1 compacted → L0 raw,
// with any tombstone corrections and active-engram recalls surfaced first when present.
// frame.tokenUsage stays within your budget.
// frame.sections contains L4 invariants → L3 graph → L2 summaries → L1 compacted → L0 raw
// frame.tokenUsage stays within your budget
```

## Architecture

Short-hand models conversation memory as a five-level LSM-tree:

| Level | Name | Contents | Fidelity |
|-------|------|----------|----------|
| **L0** | Memtable | Raw recent messages | Verbatim |
| **L1** | Compacted | Noise-stripped, deduplicated | High |
| **L2** | Summaries | Topic-clustered with entity/decision extraction | Medium |
| **L3** | Graph | Entity-relationship knowledge graph | Structural |
| **L4** | Invariants | Core facts that must survive indefinitely | Minimal |

Messages enter L0 and progressively compact into deeper levels as the conversation grows. When building a context frame, levels are prioritized L4 → L0 (invariants first, recent messages last) within your token budget.

### Tombstones

When a correction is detected ("Actually, we're using Postgres, not MySQL"), short-hand creates a **tombstone** that tracks the superseded information. This prevents stale facts from resurfacing during compaction, and `InvariantChecker` (see [Verification](#verification)) mechanically checks that correction propagation actually held.

### Importance Scoring

A three-signal model determines which messages matter most:

- **State delta** (45%) — Does the message change the entity graph or override prior information?
- **Reference frequency** (25%) — How often are the message's entities referenced later?
- **Trajectory discontinuity** (30%) — Does the message shift the conversation's direction?

In `v0.1.0` these last two signals are lexical (Jaccard-similarity) approximations rather than embedding-based — see [Project Status](#project-status).

## Agential Memory: Active Engrams

An **active engram** is a memory that carries its own interpreter template and activation policy. Instead of injecting its payload verbatim, the store calls `interpret(context)` on every eligible engram before it enters a context frame — the same fact gets restated differently depending on what the conversation is about right now.

```typescript
import { ActiveEngramStore } from 'short-hand';

const store = new ActiveEngramStore();

// A memory that should be restated, not just replayed, at recall time
const id = store.add(
  'The user is on the free tier and hit the rate limit twice this week.',
  {
    interpreterTemplate:
      'Given that we are now discussing {{context}}, the earlier note "{{payload}}" means: ',
    activationPolicy: { surfaceWhenTopics: ['billing', 'upgrade', 'rate limit'] },
    importanceScore: 0.8,
  },
);

// Zero-dep synchronous recall (regex-tier template substitution)
const results = store.retrieve('the user is asking about upgrading their plan');
// [{ engramId, interpreted, payload, importanceScore }]

// A correction is just another engram whose policy shadows the original —
// same recall slot, new interpretation.
store.add('The user upgraded to Pro yesterday — the rate limit no longer applies.', {
  activationPolicy: { surfaceWhenTopics: ['billing'], shadowsEngramId: id },
});
```

Three rules are enforced structurally, not by convention:

1. **Interpret before inject** — the raw payload never reaches a context frame directly.
2. **Declarative activation** — `ActivationPolicy` (topics, `maxRetrievals`, `expiresAt`, `shadowsEngramId`) is evaluated by the store; the engram itself has no code path to influence it.
3. **Safety boundary** — `importanceScore` can only change via `store.setImportance(id, score)`. The interpreter only ever sees `{ template, payload, context }` — never the score, policy, id, or retrieval count.

For LM-backed restatement, use the async path with a configured [Interpreter](#interpreter-tiers):

```typescript
const store = new ActiveEngramStore({ interpreter: myInterpreter });
const results = await store.retrieveAsync(currentTopic, Date.now(), {
  maxOutputTokens: 120,
  timeoutMs: 4000,
});
```

Attach a store to a `CompactionEngine` so recalls fold into every context frame:

```typescript
engine.attachActiveEngrams(store);
```

`AgentMemory` (below) carries one `ActiveEngramStore` per agent automatically.

## Interpreter Tiers

The interpreter step is a **bounded LM call made at retrieval time** — separate from the [compactor tiers](#compactor-tiers) that govern L0→L1 write-time compaction. All three implementations share one contract: a hard `maxOutputTokens`/`timeoutMs` budget, and a promise to throw `InterpreterBudgetError` or `InterpreterUnavailableError` (never to hang or silently truncate) so `withFallback()` can route deterministically.

| Tier | Class | Backend | Status |
|------|-------|---------|--------|
| `regex` | `RegexInterpreter` | `{{payload}}`/`{{context}}` string substitution | Stable, zero-dep, always available |
| `local` | `LocalInterpreter` | Ollama HTTP endpoint (`/api/generate`), Node ≥18 `fetch` | Stable, requires a running Ollama server |
| `host` | `HostInterpreter` | Any Anthropic-shaped client you inject (`messages.create(...)`) | Stable, requires your own client + API key |

```typescript
import { HostInterpreter, LocalInterpreter, RegexInterpreter, withFallback } from 'short-hand';

const host = new HostInterpreter({
  client: anthropicClient, // any { messages: { create(req, opts?) } } shape — no SDK import required
  model: 'claude-3-5-haiku-latest',
});

const local = new LocalInterpreter({ model: 'llama3.2' }); // defaults to http://localhost:11434/api/generate

// Falls back host → regex on a budget/unavailable error.
// A caller-initiated AbortError always propagates instead of falling back.
const interpreter = withFallback(host, new RegexInterpreter());

const text = await interpreter.interpret(
  { template: engram.interpreterTemplate, payload: engram.payload, context: currentTopic },
  { maxOutputTokens: 120, timeoutMs: 4000 },
);
```

`HostInterpreter` is deliberately structural — it never imports `@anthropic-ai/sdk` — so you can point it at the real SDK, a proxy, or a test double without adding a dependency to this package.

## Context-Shift Benchmark

Interpretation-before-injection is a design bet: does restating a memory for the current context actually beat dumping the raw payload back in? `src/benchmark/` is a held-out suite that measures exactly that, across shift types (tech-stack, audience, tone, time-frame, scope-expansion, terminology) plus one calibration fixture where the raw payload is *expected* to win — if interpretation wins there too, the judge is rewarding fluff over fidelity.

Run it yourself:

```bash
npm run benchmark        # offline: regex tier + keyword judge + echo answerer, fully deterministic
npm run benchmark:live    # host tier: real Anthropic model + LM judge (needs ANTHROPIC_API_KEY + npm install @anthropic-ai/sdk)
```

Offline output, reproduced from this repo:

```
Context-Shift Benchmark — offline
tier: regex    judge: keyword
fixtures: 7

Per-fixture:
  tech-stack-shift-01          raw=0.400  interp=0.700  Δ=+0.300
  audience-shift-01            raw=0.000  interp=0.900  Δ=+0.900
  tone-shift-01                raw=0.250  interp=1.000  Δ=+0.750
  time-frame-shift-01          raw=0.000  interp=0.778  Δ=+0.778
  scope-expansion-01           raw=0.100  interp=1.000  Δ=+0.900
  terminology-shift-01         raw=0.000  interp=1.000  Δ=+1.000
  baseline-raw-wins-01         raw=1.000  interp=1.000  Δ=+0.000 [calibration]

Aggregate (excluding calibration): wins=6  ties=0  losses=0
  winRate=1.000  meanLift=+0.771  Wilson95=[0.610, 1.000]
```

`ContextShiftBenchmark`, `Judge` (`KeywordJudge` / `LMJudge`), and `Answerer` are all pluggable — swap in your own fixtures, judge, or downstream model to validate the same claim against your own workload.

## Source Ingestion

`SourceIngester` bridges raw documents into the compaction pipeline: it chunks a document (markdown-aware, respecting heading boundaries, with configurable overlap) into `ConversationMessage`s and feeds them through a `CompactionEngine`.

```typescript
import { CompactionEngine, SourceIngester } from 'short-hand';

const engine = new CompactionEngine();
const ingester = new SourceIngester({ chunkSize: 800, chunkOverlap: 100 });

const event = await ingester.ingest(
  {
    id: 'doc-1',
    title: 'Runbook: Incident Response',
    content: '# Incident Response\n\n...markdown content...',
    contentType: 'text/markdown',
  },
  engine,
);
// { sourceId: 'doc-1', chunkCount: 4, entitiesDiscovered: ['PagerDuty', 'Postgres'], ... }
```

`ingestAll(sources, engine)` ingests a batch sequentially; `getEvents()` returns the full ingestion log for use with `WikiRenderer` below.

## Wiki Rendering

`WikiRenderer` materializes a `CompactedState` as a set of interlinked markdown pages — entity pages, topic pages, an index, and an append-only ingestion log.

```typescript
import { WikiRenderer } from 'short-hand';

const wiki = new WikiRenderer({ wikiTitle: 'Project Knowledge Base' });
const pages = wiki.render(engine.getState(), ingester.getEvents());
// [{ path: 'entities/postgresql.md', title: 'PostgreSQL', category: 'entity', content: '...' }, ...]
// plus topics/*.md, index.md, and log.md
```

Each entity page cross-links its relationships, the topics that reference it, relevant invariants, and any corrections (tombstones) that touched it.

## API Reference

### CompactionEngine

The main orchestrator. Manages the full LSM-tree lifecycle.

```typescript
import { CompactionEngine } from 'short-hand';

const engine = new CompactionEngine({
  memtableSize: 10,        // L0 capacity before auto-flush (default: 10)
  contextBudget: 8000,     // token budget for context frames (default: 8000)
  preferredTier: 'regex',  // compaction strategy (default: 'regex')
  autoFallback: true,      // fall back to a lower tier instead of throwing (default: true)
});

await engine.addMessage(message);              // add one message
await engine.addMessages(messages);            // add many
await engine.flush();                          // force L0 → L1 compaction
await engine.recompact(level);                 // deeper recompaction (L1→L2, etc.)
const frame = engine.buildContextFrame(budget); // build context within token budget
const state = engine.getState();               // inspect current compacted state
engine.setCompactor(customCompactor);           // swap in a different Compactor
engine.attachActiveEngrams(activeEngramStore);  // fold active engrams into context frames
  memtableSize: 10,       // L0 capacity before auto-flush (default: 10)
  contextBudget: 8000,    // token budget for context frames (default: 8000)
  preferredTier: 'regex', // compaction strategy (default: 'regex')
});

await engine.addMessage(message);        // add one message
await engine.addMessages(messages);      // add many
await engine.flush();                    // force all of L0 through L1 compaction
await engine.recompact(level);           // deeper recompaction (L1→L2, etc.)
const frame = engine.buildContextFrame(budget); // build context within token budget
const state = engine.getState();         // inspect current compacted state
engine.attachActiveEngrams(store);       // surface agential memories in frames
```

### RegexCompactor

Tier 0 compactor — pattern-based extraction with zero external dependencies. Extracts decisions, corrections, entities, and constraints via regex. By its own estimate it catches roughly 20–30% of real-world decisions; it's a fast, dependency-free baseline, not a full extraction pipeline.

```typescript
import { RegexCompactor } from 'short-hand';

const compactor = new RegexCompactor();
const newState = await compactor.compact(messages, targetLevel, currentState);
const recompacted = await compactor.recompact(state, targetLevel);
```

### ImportanceDetector

Scores messages by importance to guide compaction decisions.

```typescript
import { ImportanceDetector } from 'short-hand';

const detector = new ImportanceDetector();
const score = detector.score(message);
// { overall: 0.72, stateDelta: 0.85, referenceFrequency: 0.4, trajectoryDiscontinuity: 0.8 }

detector.recompute();      // retrospectively recompute all scores
detector.getScore(msgId);  // look up a previously scored message
detector.getAllScores();   // all { messageId, score } pairs
const score = detector.score(message); // incremental — call once per message
// { overall: 0.72, stateDelta: 0.85, referenceFrequency: 0.4, trajectoryDiscontinuity: 0.8 }

// Retrospective pass: folds in how often later messages referenced each one
const updated = detector.recompute();
```

### CRDT Primitives

Distributed-friendly data structures for multi-agent scenarios.

```typescript
import { AgentMemory, LWWRegister, ORSet, GSet } from 'short-hand';

// Per-agent memory combining all CRDT layers (L4 invariants, L3 entities, L2 summaries, active engrams)
const memory = new AgentMemory('agent-1');
memory.setInvariant('db', 'PostgreSQL');
memory.addEntity({
  name: 'PostgreSQL',
  type: 'technology',
  properties: {},
  firstMention: 'm1',
  lastMention: 'm1',
});

// Last-Writer-Wins Register (L4 invariants) — what AgentMemory.invariants uses internally
const reg = new LWWRegister<string>('agent-1');
reg.set('db', 'PostgreSQL', 1);
reg.set('db', 'MySQL', 2); // newer Lamport timestamp wins
// Per-agent memory combining all CRDT types
const memory = new AgentMemory('agent-1');
memory.setInvariant('db', 'PostgreSQL');
memory.addEntity(entity);
memory.addSummary(summary);

// Last-Writer-Wins Register (L4 invariants)
const reg = new LWWRegister<string>('agent-1');
reg.set('db', 'PostgreSQL', 1);
reg.set('db', 'MySQL', 2); // newer timestamp wins

// Observed-Remove Set (L3 entities, add-wins)
const orset = new ORSet<string>('agent-1');
orset.add('React');
orset.remove('React');

// Grow-Only Set (L2 summaries)
const gset = new GSet<string>();
gset.add('Session covered auth flow');

// Merge another agent's serialized state into this one (mutates in place)
memory.mergeFrom(otherMemory.serialize());
// Merge another agent's serialized memory into this one
memory.mergeFrom(otherMemory.serialize());
```

### ActiveEngramStore

Agential memory entries: each engram carries its payload, an interpreter
template, and a declarative activation policy. On retrieval, the engram is
re-interpreted against the *current* context before injection — salience over
fidelity.

```typescript
import { ActiveEngramStore } from 'short-hand';

const store = new ActiveEngramStore();
const id = store.add('user prefers CLI tools', {
  activationPolicy: { surfaceWhenTopics: ['ux', 'interface'] },
  importanceScore: 0.8,
});

// Sync retrieval (regex-tier template substitution)
const results = store.retrieve('designing the settings interface');

// Async retrieval through a configured LM-tier interpreter
const lmStore = new ActiveEngramStore({ interpreter: hostInterpreter });
const interpreted = await lmStore.retrieveAsync('designing the settings interface');

// Plug into the engine so engrams surface in context frames
engine.attachActiveEngrams(store);
```

### Interpreters

Bounded LM step at engram-retrieval time, with three tiers and deterministic
fallback. Every call carries a `maxOutputTokens` cap and a `timeoutMs`.

```typescript
import {
  RegexInterpreter,   // zero-dep template substitution (terminal fallback)
  LocalInterpreter,   // Ollama HTTP endpoint
  HostInterpreter,    // Anthropic-shaped client (bring your own SDK instance)
  withFallback,
} from 'short-hand';

const interpreter = withFallback(
  new HostInterpreter({ client, model: 'claude-haiku-4-5-20251001' }),
  new RegexInterpreter(),
);
const text = await interpreter.interpret(
  { template: 'In {{context}}: {{payload}}', payload: '...', context: '...' },
  { maxOutputTokens: 120, timeoutMs: 4000 },
);
```

### Verification

Safety checks and recall testing for compacted state.

```typescript
import { InvariantChecker, RecallTester } from 'short-hand';

// Five structural safety checks against compacted state
const checker = new InvariantChecker();
const result = checker.verify(compactedState);
// { passed: true, checks: [{ name: 'correction-propagation', passed: true, message: '...' }, ...] }

// Generate quiz questions from the full history, then test whether the
// compacted state still holds enough information to answer them
const tester = new RecallTester();
const questions = tester.generateQuestions(originalMessages);
const recall = tester.evaluateRecall(questions, compactedState);
// { passed: true, checks: [...], recallScore: 0.85 }
// recall.recallScore → 0.85 (85% recall)
```

### Source Ingestion & Wiki Rendering

Feed documents through the compaction pipeline, then materialize the
compacted knowledge as interlinked markdown pages.

```typescript
import { SourceIngester, WikiRenderer } from 'short-hand';

const ingester = new SourceIngester({ chunkSize: 800, chunkOverlap: 100 });
const event = await ingester.ingest(
  { id: 'doc-1', title: 'Design Doc', content: markdownText },
  engine,
);

const renderer = new WikiRenderer({ wikiTitle: 'Project Knowledge' });
const pages = renderer.render(engine.getState(), ingester.getEvents());
// pages: entity pages, topic pages, index.md, log.md — persist however you like
```

### Context-Shift Benchmark

Measures whether interpret-at-retrieval beats raw payload injection when the
context has shifted since write time.

```bash
npm run benchmark        # offline: regex tier + keyword judge, deterministic
npm run benchmark:live   # Anthropic-backed (needs ANTHROPIC_API_KEY + @anthropic-ai/sdk)
```

### Utilities

```typescript
import { estimateTokens, generateId } from 'short-hand';

estimateTokens('Hello world'); // ~3 (4 chars per token heuristic)
generateId();                  // e.g. 'mdlk2h4c-9f2a1qz'
generateId(); // 'lx2f3a9b-k1m2n3o' (timestamp + random, base36)
```

## Tiers

Distinct from the [interpreter tiers](#interpreter-tiers) above — these govern **write-time** L0→L1 compaction inside `CompactionEngine`, not retrieval-time restatement.
Short-hand uses a tiered strategy with automatic fallback in two places:

**Compaction** (messages → compacted state):

| Tier | Strategy | Status | Configuration |
|------|----------|--------|----------------|
| **0** | Regex | Stable | None |
| **1** | Local LM | Planned | `localModel: { backend: 'llama.cpp' \| 'mlx' \| 'ollama' \| 'transformers.js', ... }` |
| **2** | Host LLM | Planned | `hostLLM: { provider: 'anthropic' \| 'openai' \| 'custom', ... }` |

Today, `CompactionEngine` only implements the regex compactor. Requesting `preferredTier: 'local'` or `'host'` silently falls back to regex when `autoFallback: true` (the default); set `autoFallback: false` to get a hard error instead of silent degradation.
| **1** | Local LM | Planned | Local model runtime |
| **2** | Host LLM | Planned | LLM API access |

The engine defaults to Tier 0 (regex) and falls back gracefully if a higher tier is unavailable.

**Interpretation** (engram retrieval — implemented today):

| Tier | Class | Backend |
|------|-------|---------|
| **regex** | `RegexInterpreter` | None (template substitution) |
| **local** | `LocalInterpreter` | Ollama HTTP endpoint |
| **host** | `HostInterpreter` | Any Anthropic-shaped client |

Compose tiers with `withFallback(primary, fallback)` for deterministic degradation.

## Types

All types are exported for use in your own code:

```typescript
import type {
  ConversationMessage,
  CompactedState,
  CompactionConfig,
  ContextFrame,
  Tombstone,
  Entity,
  KnowledgeGraph,
  Decision,
  TopicSummary,
  Invariant,
  ImportanceScore,
  ActiveEngram,
  ActivationPolicy,
  ActiveEngramResult,
  Source,
  IngestionEvent,
  WikiPage,
  Interpreter,
  InterpreterTier,
} from 'short-hand';
```

This is a curated subset — the full export surface (CRDT serialization types, benchmark fixtures/reports, host/local interpreter options, and more) is in `src/index.ts`.

## Development

```bash
git clone https://github.com/johnnyclem/short-hand.git
cd short-hand
npm install
npm run build           # compile TypeScript
npm test                 # run tests (vitest)
npm run lint              # type-check without emitting
npm run benchmark         # offline context-shift benchmark
npm run benchmark:live    # host-tier benchmark against a real model (needs ANTHROPIC_API_KEY)
```

## Project Status

short-hand is pre-1.0 (`0.1.0`) and single-maintainer. What's solid today: the five-level LSM compaction core, CRDT primitives, tombstones, and importance scoring, all running on the shipped regex tier with 150+ passing tests; the active-engram subsystem and its three interpreter tiers, each behind the same bounded, fallback-safe contract; source ingestion and wiki rendering; and the context-shift benchmark that backs the claims above.

What's still aspirational:

- **Compactor tiers** — `local`/`host` for L0→L1 write-time compaction accept configuration but currently fall back to `regex` (see [Compactor Tiers](#compactor-tiers)).
- **Embeddings** — there's no embedding model wired in yet; `ImportanceDetector`'s reference-frequency and trajectory-discontinuity signals use lexical (Jaccard) approximations, and `StubEmbedder` is an explicit placeholder returning zero vectors.
- **CI** — no workflow is configured in this repo yet; `npm test` and `npm run lint` are the gate for now.

## Ecosystem

Short-hand is one of four related projects by the same author. See
[`docs/ecosystem/executive-summary.md`](./docs/ecosystem/executive-summary.md) and
[`docs/ecosystem/engineering-guide.md`](./docs/ecosystem/engineering-guide.md) for a source-verified
evaluation of how it relates to [AgentVault](https://github.com/johnnyclem/AgentVault),
[SmallChat](https://github.com/johnnyclem/smallchat), and
[Stenographer](https://github.com/johnnyclem/stenographer) — including the finding that, as of this
writing, none of those integrations are actually wired up in this repo yet.

## License

MIT
