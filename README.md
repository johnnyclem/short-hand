# @shorthand/core

Progressive context compaction for LLMs. Old computer science for new constraints.

- **LSM-tree compaction** — five levels, from a raw memtable down to core invariants, with corrections tracked explicitly (tombstones) so overridden facts don't quietly resurface.
- **Snapshot compaction with verification** — compact a whole history to one summary at L0–L3, then check it with recall tests, pluggable invariants and information-theoretic bounds.
- **Active engrams** — agential memories that get *reinterpreted* at recall time instead of just replayed, backed by a pluggable regex/local/host interpreter tier and a benchmark harness for testing whether the reinterpretation helps (the bundled starter set is a wiring smoke test; it has not shown that it does).
- **CRDT memory** — Lamport and vector clocks, LWW-Register, OR-Set, G-Set, RGA, and a per-agent `AgentMemory` (L0–L4 plus active engrams) for merging memory across agents, with a structural conflict detector.
- **Importance detection** — a standalone scorer with three domain-agnostic signals (state delta, reference frequency, trajectory discontinuity).
- **Truth-ledger interop** — read [stenographer](https://github.com/johnnyclem/stenographer)'s truth format v2 (hash-chained TB/UV streams with TRANSITION status lines) as first-class context, checked against stenographer's golden fixtures; fail closed on anything unrecognized or unverifiable; and emit candidates back as a hash-chained PROPOSAL stream.
- **Zero runtime dependencies.** Fully typed. ESM-only. Node ≥22.

This repository is the one canonical home of `@shorthand/core`. smallchat's former vendored copy (`smallchat/shorthand`) was merged into it; see [MIGRATION.md](./MIGRATION.md) for every rename.

## Why

Long conversations with LLMs accumulate context that eventually hits token limits. Naive truncation loses important information. Short-hand applies database-inspired compaction instead: recent messages stay verbatim, older messages progressively condense into summaries, a knowledge graph, and core invariants.

Some memories shouldn't be compacted at all — they need to be restated every time they're recalled, in light of whatever the conversation is about *now*. Short-hand's active-engram subsystem exists for that case, and ships with a benchmark harness for testing, on your own fixtures, whether the restatement step helps versus dumping the raw memory back in.

## Install

```bash
npm i @shorthand/core
```

Requirements: Node.js 22 or later. The package is ESM-only (`import`, not `require`). TypeScript users need `moduleResolution` `node16`, `nodenext` or `bundler`, which read the `exports` map; the subpaths below are the only importable entry points.

Every module is also available on its own subpath:

| Subpath | What it holds |
|---|---|
| `@shorthand/core` | Everything below except the benchmark |
| `@shorthand/core/compaction` | `CompactionEngine`, `RegexCompactor`, `DefaultCompactor` and the snapshot verification strategies |
| `@shorthand/core/crdt` | Clocks, LWW-Register, OR-Set, G-Set, RGA, `AgentMemory`, `MemoryMerge`, `ConflictDetector`, `ActiveEngramStore` |
| `@shorthand/core/importance` | `ImportanceDetector` and its three signals |
| `@shorthand/core/truth` | Truth-ledger codec, selection, rendering, proposals |
| `@shorthand/core/wiki` | `WikiRenderer` |
| `@shorthand/core/ingestion` | `SourceIngester` |
| `@shorthand/core/interpreter` | Regex/local/host interpreters and `withFallback` |
| `@shorthand/core/verification` | `InvariantChecker`, `RecallTester` (LSM state) |
| `@shorthand/core/benchmark` | The context-shift benchmark (dev tool; not in the root export) |

## Quick Start

```typescript
import { CompactionEngine, renderContextFrame } from '@shorthand/core';

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
// frame.sections: ledger truth → corrections → L4 invariants → memories → pinned code
// → L3 graph → L2 summaries → L1 history → L0 raw, each with a `kind`, its `items`
// (with source ids) and an `omitted` count.
// frame.tokenUsage === estimateTokens(renderContextFrame(frame)) <= 2000
// (estimateTokens is a ~4 chars/token heuristic, not a model tokenizer).
const prompt = renderContextFrame(frame);
```

## Architecture

Short-hand models conversation memory as a five-level LSM-tree:

| Level | Name | Contents | Fidelity |
|-------|------|----------|----------|
| **L0** | Memtable | Raw recent messages | Verbatim |
| **L1** | Compacted | Messages kept verbatim (pure acks dropped, short replies folded into their question); code indexed by hash | High |
| **L2** | Summaries | Topic-clustered with entity/decision extraction | Medium |
| **L3** | Graph | Entity-relationship knowledge graph | Structural |
| **L4** | Invariants | Core facts that must survive indefinitely | Minimal |

Messages enter L0 and progressively compact into deeper levels as the conversation grows. L1 never rewrites a message: no words are stripped, and fenced code blocks stay byte-for-byte (they are also stored in a content-addressed span store, `state.spans`). Recompacting L1 into L2 moves the summarized entries to `state.archive`, so repeated recompaction is idempotent. Mutations (`addMessage` compaction, `flush`, `recompact`, `correct`, …) run on one internal queue, so concurrent callers never lose messages.

### Context frames

`buildContextFrame(budget)` fills sections in priority order — synced ledger truth, corrections, L4 invariants, then (after holding back up to 25% of the budget for the newest raw messages) memories, pinned code, L3, L2 and L1 — **item by item**: an item that does not fit is skipped and counted in `section.omitted`, and the next one is tried. A contested TB and the UVs disputing it are one item. L0 fills newest-first and stays contiguous.

The budget is a ceiling on the rendered frame: `frame.tokenUsage` is `estimateTokens(renderContextFrame(frame))` and is at most the budget (tested at budgets from 0 to 600 tokens, in steps of 7, on a frame with every section kind). The estimate is the package's ~4 characters per token heuristic, not a model tokenizer count, so leave headroom when a model's real context limit is tight.

Each section has a `kind` with one fixed marker:

| kind | marker | from |
|---|---|---|
| `truth` | `## Asserted Truth (ledger)`, `[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]` | synced ledger |
| `correction` | `[correction]` | tombstones (`(inferred)` when pattern-detected) |
| `invariant` | `[invariant]` | L4 |
| `memory` | `[memory]` | active engrams |
| `code` | `[code sha256:…]` | pinned code spans |
| `graph` | `[entity]`, `[edge]` | L3 |
| `summary` | `[summary]` | L2 |
| `history` | (message text) | L1 |
| `recent` | `role: text` | L0 |

Text from messages, tool output, ledger fields and engrams goes through one escaping renderer (`escapeUntrusted`): a `\` is put in front of any `[TB…` / `[UV…` marker, any section marker at a line start and any reproduced `## Asserted Truth` heading, so a tool result containing `\n[TB] … (signed: cto)` renders as `\[TB] …` in the frame instead of reading as a ledger line. Markers are matched on a folded copy of the text — NFKC, invisible code points and combining marks dropped, any case, and Cyrillic, Greek, Armenian, Cherokee and Lisu look-alikes of T, B, U and V read as Latin — so `[ＴB]`, `[T\u200BB]`, `[tb]`, `﹇TB]` and Cyrillic `[ТВ]` are escaped too, as is a marker behind a non-breaking or invisible line prefix. Brackets and homoglyphs outside those sets (`【TB】`, other scripts) are not. Every item carries `sources` (message, ledger entry, tombstone, engram or span ids).

An L1 entry whose code does not fit is shown with `[code sha256:<12 hex> — N tokens, not shown]` references; `engine.getSpan(hash)` returns the exact text, and `engine.pinSpan(hash)` gives a span its own frame section.

### Tombstones

A correction creates a **tombstone** that records the superseded value, and every level that still states only that value is updated: L1 entries, L2 summaries and decisions, L3 entities and the edges touching them, and L4 invariants are moved to `state.archive` under the tombstone's id — archived, never deleted. `InvariantChecker` (see [Verification](#verification)) checks all of L1–L4, and optionally the rendered frame, for values that should have been superseded.

Corrections come from two places:

- **Declared by the host** (`confidence: 'explicit'`) — the explicit path: no pattern matching, and the same inputs always give the same tombstone id:

  ```typescript
  const tombstone = await engine.correct({ key: 'region', from: 'us-east-1', to: 'eu-west-1', sourceMessageId: 'msg-42' });
  await engine.revertCorrection(tombstone.id!); // restores what it archived, unless another correction supersedes it too
  ```

  The tombstone id derives from the inputs, so declaring the same correction twice is a no-op. Older messages still in L0 get the correction when they compact; messages added after `correct()` is called are after the correction and may restate the old value. A text is stale when it mentions `from` and names `to` nowhere outside those mentions (so `v2.1.0-beta` → `v2.1.0` works), matching whole tokens: `20` does not match inside `20.11`.
- **Inferred by `RegexCompactor`** (`confidence: 'inferred'`) from phrasing such as "Actually, use Postgres instead of MySQL" or "switch MySQL to Postgres". These are low-confidence suggestions: applied reversibly, rendered as `(inferred)`, and not proposed to the truth ledger unless you pass `includeInferred: true`. Keyword-only corrections ("Wait, …") and corrections whose superseded value is empty, a pronoun or a function word ("change it to blue") never produce a tombstone.

### Importance scoring

`ImportanceDetector` scores messages on three signals (default weights in `DEFAULT_IMPORTANCE_CONFIG`):

- **State delta** (0.4) — does the message change the entity graph or override prior information?
- **Reference frequency** (0.25) — how often do later messages refer back to it?
- **Trajectory discontinuity** (0.35) — does it turn away from the conversation's direction? Needs `message.embedding`.

It is a standalone tool: `CompactionEngine` does not call it. L1 ranks entries by the regex compactor's own per-entry estimate (decisions, corrections, constraints and code raise it). See [ImportanceDetector](#importancedetector).

## Agential Memory: Active Engrams

An **active engram** is a memory that carries its own interpreter template and activation policy. Instead of injecting its payload verbatim, the store calls `interpret(context)` on every eligible engram before it enters a context frame — the same fact gets restated differently depending on what the conversation is about right now.

```typescript
import { ActiveEngramStore } from '@shorthand/core';

const store = new ActiveEngramStore();

// A memory that should be restated, not just replayed, at recall time
const id = store.add(
  'The user is on the free tier and hit the rate limit twice this week.',
  {
    interpreterTemplate:
      'Given that we are now discussing {{context}}, the earlier note "{{payload}}" means: ',
    activationPolicy: { surfaceWhenTopics: ['billing', 'plan', 'rate limit'] },
    importanceScore: 0.8,
  },
);

// Zero-dep synchronous recall (regex-tier template substitution)
const results = store.retrieve('the user is asking about upgrading their plan');
// [{ engramId, interpreted, payload, importanceScore }]

// A correction is just another engram whose policy shadows the original —
// same recall slot, new interpretation. The original never surfaces again:
// wherever it would have matched ('rate limit', 'plan', 'billing'), the
// correction speaks in its place.
store.add('The user upgraded to Pro yesterday — the rate limit no longer applies.', {
  activationPolicy: { surfaceWhenTopics: ['billing'], shadowsEngramId: id },
});
store.retrieve('why am I hitting the rate limit again?');
// [{ engramId: id, shadows: <correction id>, interpreted: '…upgraded to Pro…', … }]
```

Three rules hold by construction of the store's API (in process: they are not a sandbox against code that reaches the store's internals):

1. **Interpret before inject** — an engram reaches a context frame only as its interpreter's output. With the regex tier that output is the template with the payload substituted in.
2. **Declarative activation** — `ActivationPolicy` (topics, `maxRetrievals`, `expiresAt`, `shadowsEngramId`) is evaluated by the store; the engram itself has no code path to influence it.
3. **Safety boundary** — `importanceScore` can only change via `store.setImportance(id, score)` (clamped to [0, 1]); `get()` and `all()` hand out frozen copies. The interpreter only ever sees `{ template, payload, context }` — never the score, policy, id, or retrieval count.

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

The interpreter step is a **bounded LM call made at retrieval time** — separate from the [compactor tiers](#compactor-tiers) that govern L0→L1 write-time compaction. All three implementations share one contract: a `maxOutputTokens`/`timeoutMs` budget per call, and errors instead of hanging past the timeout or returning truncated text — `InterpreterBudgetError` or `InterpreterUnavailableError` — so `withFallback()` routes on the error type alone (a budget or unavailable error falls back; a caller's `AbortError` propagates). Output the backend cut off — Anthropic `stop_reason` `max_tokens` or `model_context_window_exceeded`, Ollama `done_reason: "length"` — throws `InterpreterBudgetError('output_too_long')`; an Anthropic `refusal` throws `InterpreterUnavailableError`.

| Tier | Class | Backend | Status |
|------|-------|---------|--------|
| `regex` | `RegexInterpreter` | `{{payload}}`/`{{context}}` string substitution | Stable, zero-dep, always available |
| `local` | `LocalInterpreter` | Ollama HTTP endpoint (`/api/generate`) over the global `fetch` | Stable, requires a running Ollama server |
| `host` | `HostInterpreter` | Any Anthropic-shaped client you inject (`messages.create(...)`) | Stable, requires your own client + API key |

```typescript
import { HostInterpreter, LocalInterpreter, RegexInterpreter, withFallback } from '@shorthand/core';

const host = new HostInterpreter({
  client: anthropicClient, // any { messages: { create(req, opts?) } } shape — no SDK import required
  model: 'claude-haiku-4-5',
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

Interpretation-before-injection is a design bet: does restating a memory for the current context beat injecting the raw payload? `@shorthand/core/benchmark` is a harness for testing that bet on your own fixtures. **It has not shown that the bet pays off**: the seven bundled starter fixtures are a wiring smoke test, and no live result is published here.

For each fixture the harness runs two arms — the raw payload, and the payload interpreted for the fixture's read context — asks an answerer the fixture's question with that arm's text as its memory, and scores both answers with a judge. Shift types: tech-stack, audience, tone, time-frame, scope-expansion, terminology. A calibration fixture (a fingerprint the question needs verbatim) must tie: losing it means the interpretation dropped the fact; winning it means the judge rewards restatement over fidelity. Every starter fixture uses the same neutral template, written before the read context exists, so the answer terms appear only in the expected answer.

`report.gate` (`evaluateGate`) passes only when a run could support the claim at all:

- a tier that interprets (the regex tier only substitutes the template);
- a downstream answerer (the echo answerer scores the injected text itself);
- no failed interpretations;
- every calibration fixture ties;
- at least 30 decided (won or lost) non-calibration fixtures;
- a Wilson 95% lower bound on wins / (wins + losses) above 0.5.

Passing says the run could have shown the lift and did, on those fixtures, under that judge. It does not generalize past them. The starter set has six non-calibration fixtures, so it never passes on its own; bring a held-out set of your own.

```bash
npm run benchmark                     # offline: regex tier, keyword judge, echo answerer — a wiring smoke test
npm run benchmark -- --out report.json
npm run benchmark:live                # host tier, model answerer, LM judge (ANTHROPIC_API_KEY + npm i @anthropic-ai/sdk)
npm run benchmark:live -- --require-gate   # exit 1 unless the gate passed
```

Offline output, reproduced from this repo (only `runId` changes between runs). The regex tier ties the raw arm on every fixture, as it should — it adds nothing a keyword judge can see:

```
Context-Shift Benchmark — offline (wiring smoke test, not evidence for or against interpretation)
runId: run-muoy4qim
tier: regex    judge: keyword    answerer: echo
fixtures: 7

Per-fixture:
  tech-stack-shift-01          raw=0.400  interp=0.400  Δ=+0.000
  audience-shift-01            raw=0.000  interp=0.000  Δ=+0.000
  tone-shift-01                raw=0.250  interp=0.250  Δ=+0.000
  time-frame-shift-01          raw=0.000  interp=0.000  Δ=+0.000
  scope-expansion-01           raw=0.100  interp=0.100  Δ=+0.000
  terminology-shift-01         raw=0.000  interp=0.000  Δ=+0.000
  baseline-raw-wins-01         raw=1.000  interp=1.000  Δ=+0.000 [calibration]

Aggregate (excluding calibration): wins=0  ties=6  losses=0
  winRate=0.000  meanLift=+0.000  Wilson95=[0.000, 1.000]
  tokens raw=272  interp=380

Gate: not met
  - regex tier: it substitutes the template and nothing else, so the run cannot show that interpretation helps (wiring smoke test)
  - echo answerer: it scores the injected text itself, not a downstream answer
  - 0 decided fixtures (fewer than 30): too few to support a claim
  - Wilson 95% lower bound 0.000 is not above 0.5
```

The live run uses one model for the interpreter, the answerer and the judge — `SHORTHAND_BENCHMARK_MODEL`, default `claude-haiku-4-5` (`DEFAULT_LIVE_MODEL`) — so that model's biases enter at all three steps. Nothing falls back: a failed interpretation is recorded on the fixture, fails the gate and makes the CLI exit 1; a failed, truncated or refused answer or grade (`ModelCallError`) stops the run. The judge grades with its own prompt and a JSON schema (structured output).

`ContextShiftBenchmark`, `evaluateGate`, `Judge` (`KeywordJudge` / `LMJudge`), `Answerer` and `createLiveBenchmark` are exported from `@shorthand/core/benchmark`. Pass the interpreter itself, not a `withFallback` wrapper: a fallback inside the interpreter is invisible to the report.

## Source Ingestion

`SourceIngester` bridges raw documents into the compaction pipeline: it chunks a document (markdown-aware, respecting heading boundaries, with configurable overlap) into `ConversationMessage`s and feeds them through a `CompactionEngine`.

```typescript
import { CompactionEngine, SourceIngester } from '@shorthand/core';

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
// { sourceId: 'doc-1', chunkCount: 4, entitiesDiscovered: ['PagerDuty', 'Postgres'], version: '3f1c…', retractedChunks: 0 }
```

Every chunk is at most `chunkSize` tokens (paragraphs, then sentences, then whitespace or hard cuts; no text is dropped), and chunking is linear in document size. `entitiesDiscovered` lists only the L3 entities this ingestion added. Sources are versioned by content hash (chunk ids are `<sourceId>@<version>-chunk-<n>`): re-ingesting an unchanged source returns `{ skipped: true }`, and ingesting an edited one first retracts the previous version's chunks (`engine.retract`) so stale text does not stay live beside the update. Ingests of one source run one at a time, in call order.

`ingestAll(sources, engine)` ingests a batch sequentially; `getEvents()` returns the full ingestion log for use with `WikiRenderer` below.

## Wiki Rendering

`WikiRenderer` materializes a `CompactedState` as a set of interlinked markdown pages — entity pages, topic pages, an index, and an append-only ingestion log.

```typescript
import { WikiRenderer } from '@shorthand/core';

const wiki = new WikiRenderer({ wikiTitle: 'Project Knowledge Base' });
const pages = wiki.render(engine.getState(), ingester.getEvents());
// [{ path: 'entities/postgresql.md', title: 'PostgreSQL', category: 'entity', content: '...' }, ...]
// plus topics/*.md, index.md, and log.md
```

Each entity page cross-links its relationships, the topics that reference it, relevant invariants, and any corrections (tombstones) that touched it.

Everything a page shows comes from conversations, tool output or ingested documents, so it is escaped by the same renderer as context frames (`src/compaction/frame.ts`): it can't become a link, an image, raw HTML, a heading or a frozen truth marker. Page paths are Unicode-aware slugs (`entities/日本語.md`); names that slug alike (`C++` and `C#`) get a short hash suffix (`entities/c-1a2b3c4d.md`) so no page overwrites another, and links are relative to the page they are on.

## API Reference

### CompactionEngine

The main orchestrator. Manages the full LSM-tree lifecycle.

```typescript
import { CompactionEngine } from '@shorthand/core';

const engine = new CompactionEngine({
  memtableSize: 10,        // L0 capacity before auto-flush (default: 10)
  contextBudget: 8000,     // token budget for context frames (default: 8000)
  preferredTier: 'regex',  // compaction strategy (default: 'regex'; the only implemented tier)
  autoFallback: true,      // fall back to regex instead of throwing for 'local'/'host' (default: true)
});

await engine.addMessage(message);              // add one message
await engine.addMessages(messages);            // add many
await engine.flush();                          // force all of L0 through L1 compaction
await engine.recompact(level);                 // deeper recompaction (L1→L2, etc.)
const frame = engine.buildContextFrame(budget); // build context within token budget
const state = engine.getState();               // inspect current compacted state
engine.setCompactor(customCompactor);          // swap in a different Compactor
engine.attachActiveEngrams(activeEngramStore); // fold active engrams into context frames
await engine.correct({ from, to, sourceMessageId }); // declare a correction (explicit tombstone)
await engine.revertCorrection(tombstoneId);    // undo one, restoring what it archived
await engine.retract(messageIds);              // revert their corrections, archive what derives only from them
engine.getSpan(hash); engine.pinSpan(hash); engine.unpinSpan(hash); // exact code spans; pin one into every frame
engine.syncTruthLedger(jsonl);                 // read a truth-ledger stream (see Truth-Ledger Interop)
```

### RegexCompactor

Tier 0 compactor — pattern-based extraction with zero external dependencies. Extracts decisions, corrections, entities, and constraints via regex. By its own estimate it catches roughly 20–30% of real-world decisions; it's a fast, dependency-free baseline, not a full extraction pipeline.

```typescript
import { RegexCompactor } from '@shorthand/core';

const compactor = new RegexCompactor();
const newState = await compactor.compact(messages, targetLevel, currentState);
const recompacted = await compactor.recompact(state, targetLevel);
```

### Snapshot compaction and verification

`DefaultCompactor` compacts a whole `ConversationHistory` into one `CompactedSnapshot` at a `SnapshotLevel` (`'L0'`–`'L3'`), and three strategies check the result against the original conversation.

```typescript
import { DefaultCompactor, VerificationHarness, checkInvariants, BUILTIN_INVARIANTS } from '@shorthand/core';

const compactor = new DefaultCompactor();
const snapshot = await compactor.compact({ sessionId: 's1', messages }, 'L2');
const deeper = await compactor.recompact(snapshot, 'L3');

// Recall test + invariant checks + information-theoretic retention, in one pass
const result = new VerificationHarness({ minRecallScore: 0.85 }).verify(deeper, { sessionId: 's1', messages });

// Invariants are pluggable: add your own beside the built-ins
const report = checkInvariants(deeper, history, [...BUILTIN_INVARIANTS, myInvariant]);
```

These checks are heuristics over extracted entities, decisions and tombstones, not proofs: a pass means the checked properties held for what the extractors found. Recall, decision completeness and entity retention are scored against the snapshot's `summary` — the text the model receives — with the entities to retain extracted from the original history, so a snapshot whose summary dropped the facts fails even when its structured fields still list them.

### ImportanceDetector

Scores each message on three domain-agnostic signals: how much it mutates a running entity-relationship graph (state delta), how often later messages refer back to it (reference frequency), and how sharply it turns away from the conversation's trajectory in embedding space (trajectory discontinuity).

```typescript
import { ImportanceDetector } from '@shorthand/core';

const detector = new ImportanceDetector();
const score = detector.addMessage(message); // incremental — call once per message, in order
// { messageId, importance: 0.72, stateDelta, referenceFrequency, trajectoryDiscontinuity, dominantSignal: 'state_delta' }

detector.recomputeScores();          // retrospective pass: folds in later references
detector.getScore(msgId);            // look up a previously scored message
detector.getImportantMessages(0.5);  // scores at or above a threshold, highest first
```

The trajectory signal and semantic references need `message.embedding` (a `Float32Array` your host computes; no model ships with this package). Without embeddings those contributions are 0 and the score rests on state delta and explicit references.

### CRDT Primitives

State-based CRDTs for multi-agent memory: each replica serializes its state, and `merge` accepts any other replica's state in any order. Each primitive owns a Lamport clock (no API takes a caller-supplied timestamp); equal counters are ordered by agent id, and the clock is part of the serialized state, so `from` restores it.

```typescript
import { AgentMemory, MemoryMerge, LWWRegister, ORSet, GSet, RGA } from '@shorthand/core';

// Per-agent memory across all layers: L4 invariants (LWW), L3 graph
// (OR-Set nodes + LWW edges), L2 summaries (G-Set), L1/L0 logs (RGA),
// plus the agent's active engrams.
const memory = new AgentMemory('agent-1');
memory.setInvariant('db', 'PostgreSQL');
memory.addEntity({ id: 'pg', type: 'technology', name: 'PostgreSQL' });
memory.addSummary('storage', 'We settled on PostgreSQL for storage.', true);
memory.appendMessage('m1', 'user', 'Use PostgreSQL.');

// Merge another agent's serialized state (mutates in place)
memory.mergeFrom(otherMemory.serialize());
const restored = AgentMemory.from(memory.serialize());

// Merge several agents and get a report of semantic conflicts (same
// invariant key with different values, contradictory edges, divergent summaries)
const report = new MemoryMerge().mergeAll(memory, [a.serialize(), b.serialize()]);

// The primitives on their own
const reg = new LWWRegister<string>('agent-1');
reg.set('db', 'PostgreSQL');               // stamped with the register's Lamport clock

const orset = new ORSet<string>('agent-1'); // add-wins; removes travel as tombstones
orset.add('React');
orset.remove('React');

const gset = new GSet<string>({ replicaId: 'agent-1' }); // grow-only; one entry per dedupeKey
gset.add({ value: 'Session covered auth flow', sourceAgent: 'agent-1', isDirectParticipant: true });
// → '__id:agent-1:1' (keyless entries get an issued id, never a content key)

const log = new RGA<string>('agent-1');     // replicated sequence
log.append('first');
```

What merges guarantee, exactly as property-tested (fast-check, 150 random histories per property, in `src/crdt/crdt-properties.test.ts`) for the LWW-Register, OR-Set, G-Set, RGA, `AgentMemory` and `ActiveEngramStore` merges, with every state crossing a JSON round trip:

- **Convergence:** replicas that have merged the same states hold the same replicated state, in any merge order — including equal-counter ties, concurrent inserts at the same RGA position (the head included) and LWW writers that share an agent id.
- **Join laws** on reachable states: `merge` is commutative, associative and idempotent (merging a state twice changes nothing).
- **Restore and continue:** a replica restored with `from` behaves like the original from then on.
- **Conflicts:** `ConflictDetector` reports no L4 conflict when every write follows a sync of everything before it (property-tested), and reports an invariant or edge only when the two writes were concurrent (unit-tested).

Malformed states (and a newer `schemaVersion`) make a primitive's `merge` throw a `TypeError` before it changes anything (unit-tested). `AgentMemory.mergeFrom` validates layer by layer, so a malformed later layer throws after the earlier layers merged; `ActiveEngramStore.mergeFrom` drops and reports invalid engrams instead. The wire format, merge rules and the active-engram trust model are in [`docs/crdt-format.md`](./docs/crdt-format.md).

The CRDT surface is still **experimental** because these hold only under preconditions it cannot check: every live writer has its own agent id (a restarted agent restores with `from` before writing — otherwise an LWW write can lose to an older one and an OR-Set tag can collide; an RGA merge throws on the collision), peers are honest (nothing is signed: a peer can win any LWW key with a large counter, delete any element or engram, and claim any engram origin), and a custom `GSet` merge function picks the greater entry under a total order. Tombstones are never garbage-collected, and engram retrieval counts and importance scores are per replica.

### ActiveEngramStore

Agential memory entries: each engram carries its payload, an interpreter
template, and a declarative activation policy. On retrieval, the engram is
re-interpreted against the *current* context before injection — salience over
fidelity.

```typescript
import { ActiveEngramStore } from '@shorthand/core';

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

// Replicate between agents: union by id minus removal tombstones
const peer = new ActiveEngramStore({ origin: 'agent-b' });
const report = peer.mergeFrom(store.serialize(), { from: 'local' }); // { added, removed, rejected }
```

Merging is a trust boundary: a peer's state can add memories (schema-validated, importance clamped to [0, 1], retrieval count reset) and delete any memory (`remove` leaves a tombstone, so a deletion is never undone by the next sync), but it cannot rewrite a memory the store already holds, change its importance, or correct (`shadowsEngramId`) a memory of another origin. Origins are asserted, not authenticated — see [`docs/crdt-format.md`](./docs/crdt-format.md#activeengramstore).

### Interpreters

Bounded LM step at engram-retrieval time, with three tiers and a fallback
that routes on the error type. Every call carries a `maxOutputTokens` cap
and a `timeoutMs`.

```typescript
import {
  RegexInterpreter,   // zero-dep template substitution (terminal fallback)
  LocalInterpreter,   // Ollama HTTP endpoint
  HostInterpreter,    // Anthropic-shaped client (bring your own SDK instance)
  withFallback,
} from '@shorthand/core';

const interpreter = withFallback(
  new HostInterpreter({ client, model: 'claude-haiku-4-5' }),
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
import { InvariantChecker, RecallTester } from '@shorthand/core';

// Structural safety checks against compacted state: correction propagation
// across L1–L4, entity provenance, decision completeness, tombstone
// consistency, temporal ordering — plus frame staleness when given a frame
const checker = new InvariantChecker();
const frame = engine.buildContextFrame(4000);
const result = checker.verify(engine.getState(), { frame });
// { passed: true, checks: [{ name: 'correction-propagation', passed: true, message: '...' }, ...] }

// Generate quiz questions from the full history, then test whether what the
// model will see — the frame, so budget truncation counts — answers them.
// Superseded values never count as recalled.
const tester = new RecallTester();
const questions = tester.generateQuestions(originalMessages);
const recall = tester.evaluateRecall(questions, frame, { tombstones: engine.getState().tombstones });
// { passed: true, checks: [...], recallScore: 0.85 }
```

Both checks are heuristic string matching (whole-word, case-insensitive), not proofs: a passing run means no superseded value or missing answer was found by that matcher.

### Source Ingestion & Wiki Rendering

Feed documents through the compaction pipeline, then materialize the
compacted knowledge as interlinked markdown pages.

```typescript
import { SourceIngester, WikiRenderer } from '@shorthand/core';

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

See [Context-Shift Benchmark](#context-shift-benchmark) above: a harness and a gate, with a starter set that is a wiring smoke test.

```typescript
import { createLiveBenchmark, LIVE_INTERPRET_OPTIONS } from '@shorthand/core/benchmark';

const report = await createLiveBenchmark({ client, model: 'claude-haiku-4-5' })
  .run(myHeldOutFixtures, { interpretOpts: LIVE_INTERPRET_OPTIONS });
report.gate; // { passed, reasons }
```

### Utilities

```typescript
import { estimateTokens, generateId } from '@shorthand/core';

estimateTokens('Hello world'); // 3 (ceil of chars / 4, a heuristic)
generateId();                  // e.g. 'mdlk2h4c-9f2a1qz' (timestamp + random, base36)
```

## Compactor Tiers

Distinct from the [interpreter tiers](#interpreter-tiers) above — these govern **write-time** L0→L1 compaction inside `CompactionEngine`, not retrieval-time restatement.

| Tier | Strategy | Status | Configuration |
|------|----------|--------|----------------|
| **0** | Regex | Implemented | None |
| **1** | Local LM | Planned | `preferredTier: 'local'`, `localModel: { backend, modelPath, quantization? }` |
| **2** | Host LLM | Planned | `preferredTier: 'host'`, `hostLLM: { provider, model, toolName? }` |

Today `CompactionEngine` implements only the regex compactor; `localModel` and `hostLLM` are accepted but unused. Requesting `preferredTier: 'local'` or `'host'` falls back to regex when `autoFallback: true` (the default); set `autoFallback: false` to get an error instead. `engine.setCompactor(compactor)` plugs in your own `Compactor`.

**Interpretation** (engram retrieval — implemented today):

| Tier | Class | Backend |
|------|-------|---------|
| **regex** | `RegexInterpreter` | None (template substitution) |
| **local** | `LocalInterpreter` | Ollama HTTP endpoint |
| **host** | `HostInterpreter` | Any Anthropic-shaped client |

Compose tiers with `withFallback(primary, fallback)`: a budget or unavailable error from the primary runs the fallback; a caller's `AbortError` propagates.

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
} from '@shorthand/core';
```

This is a curated subset — the full export surface (CRDT serialization types, snapshot verification types, host/local interpreter options, and more) is in `src/index.ts`; benchmark fixtures and reports are on `@shorthand/core/benchmark`.

## Development

```bash
git clone https://github.com/johnnyclem/short-hand.git
cd short-hand
npm install
npm run build           # compile TypeScript
npm test                 # run tests (vitest)
npm run lint              # type-check without emitting
npm run smoke:pack        # after build: pack, install, import every subpath, typecheck a consumer
npm run benchmark         # offline context-shift benchmark (wiring smoke test)
npm run benchmark:live    # host-tier benchmark against a real model (needs ANTHROPIC_API_KEY)
npm run sync:truth-fixtures -- ../stenographer   # re-copy the truth-format golden fixtures
```

## Truth-Ledger Interop

@shorthand/core reads [stenographer's](https://github.com/johnnyclem/stenographer) truth ledger at a JSONL seam — no code dependency in either direction. The contract is stenographer's **truth format v2** (`spec/truth-format` there): its golden fixtures are copied into `test/fixtures/truth-format/`, and `src/truth/conformance.test.ts` checks each fixture's expected outcome as it applies to a reader (stenographer's own import routing is its own), the spec's worked hash example, and that the codec never accepts a line the JSON Schema refuses.

```typescript
import { parseWikiLines, parseWikiFiles, selectCurrentTruth, renderTruthSection, appendProposalsFile, exportProposalDrafts } from '@shorthand/core';

// Read: stenographer's export (one writer's hash-chained stream) as high-priority context
let sync = engine.syncTruthLedger(jsonl);           // { selection, displacedInvariantKeys, errors, refused, read }
sync = engine.syncTruthLedger(moreLines, { base: sync.read! }); // later: only the lines after sync.read.head (sinceSeq)
const frame = engine.buildContextFrame();           // asserted truth renders first

// Or work with the stream directly
const read = parseWikiLines(jsonl, { signers });    // signers: stenographer's signers.json, optional
const selection = selectCurrentTruth(read.entries); // groundTruth / contested / unverified / history
const section = renderTruthSection(selection);      // '## Asserted Truth (ledger)' + marked lines
const next = parseWikiLines(moreLines, { base: read, signers }); // incremental: the whole stream so far, new TRANSITIONs applied
const team = parseWikiFiles([{ name: 'wiki/alex.jsonl', text: a }, { name: 'wiki/sam.jsonl', text: b }]);

// Write: candidates go out as PROPOSAL lines (proposals only — nothing becomes
// truth until an accountable person signs it in stenographer)
appendProposalsFile('proposals.jsonl', proposals);  // continues the file's chain, skips duplicates
const proposalLines = exportProposalDrafts(engine.getState(), { author: 'detector:short-hand' });
```

What the reader guarantees, and where that stops:

- **Integrity of a stream, not authorship.** Every v2 line carries `seq`, `prevHash` and `hash` (SHA-256 of its RFC 8785 JCS form). A stream with a line whose hash doesn't match, a broken chain, or an identity the spec refuses is refused whole (`refused: true`, no entries). An accepted stream shows that no line was edited, removed, reordered or inserted between its first and last line, and that the lines come from one stream. A valid chain does not show who wrote the lines — anyone can compute the hashes — and it does not show lines removed from the end unless you pass back the `head` you kept (`{ previous }`, or the read itself as `{ base }`); with one, an emptied stream or one rewritten as version 1 lines is refused too.
- **Status is a fold.** An entry's status is the highest-seq `TRANSITION` that targets it, else its line's own — among the TRANSITIONs a reader honours. Overridden and struck TBs and verified, refuted and struck UVs are final: a later TRANSITION can only move them up the lattice, never revive them. With `{ signers }`, a TRANSITION by someone the registry doesn't list changes nothing. Both are reported in `result.held`. A TRANSITION must name a cause that is an earlier line of the stream (or none), or the stream is refused. An increment read with `{ base }` folds into the earlier read; `engine.syncTruthLedger` refuses a stream that starts part-way without one. Active TBs render as `[TB]`; contested TBs as `[TB ⚠ CONTESTED]` with every open UV disputing them beside them (an open contest attaches to its TB whatever the TB's recorded status); open UVs as `[UV — UNVERIFIED]`, which never read as proven. Overridden, struck, refuted and verified entries are history, and a sync displaces any L4 invariant projected from them.
- **Fail closed.** A missing or unknown status, an unsigned TB, a version 1 TB (no hash; pass `{ admitV1Tbs: true }` to read a stenographer 0.x export's TBs as truth), an author or signer a given signer registry doesn't list, and an id two lines or files disagree about are never current truth. Unknown fields and values are kept, never coerced, and an entry is always written back as the exact line it was read from.
- **Several files**, one per teammate, fold one by one; each entry then takes the most advanced status any file reached (`active < contested < overridden < struck`, `open < verified < refuted < struck`).
- **Proposals** use the suite's single PROPOSAL envelope, written as this writer's own hash-chained stream; a corrected value is proposed again, a repeated one is skipped (dedupe by kind, `targetRef` and the claim or assertion). Pre-1.0 bare proposal lines are read, never written.

Ledger text is untrusted in every renderer: a field containing `\n[TB] … (signed: cto)` renders as `\[TB] …`. Snapshot compaction gets the same selection through `TruthAwareCompactor`. See [`docs/truth-ledger-integration.md`](./docs/truth-ledger-integration.md) for the design.

## Project Status

@shorthand/core 1.0.0 (unreleased; see [CHANGELOG.md](./CHANGELOG.md) and [MIGRATION.md](./MIGRATION.md)), single-maintainer. CI runs lint, the vitest suite and the build on Node 22 and 24, plus a pack-and-install smoke test that imports every subpath of the packed tarball and typechecks a consumer under `moduleResolution` Node16 and Bundler.

What 1.0 covers: the five-level LSM compaction core with explicit and inferred corrections, typed context frames under a token ceiling, snapshot compaction and its verification heuristics, the active-engram store and its three interpreter tiers behind one bounded contract, source ingestion and wiki rendering, importance scoring, and a truth-format v2 reader and proposal writer checked against stenographer's golden fixtures.

What is still open:

- **CRDT layer** — convergence and the merge laws are property-tested, but the surface stays experimental: they rely on unique replica ids and honest peers, and tombstones are never collected; see [CRDT Primitives](#crdt-primitives).
- **Compactor tiers** — `local`/`host` for L0→L1 write-time compaction accept configuration but currently fall back to `regex` (see [Compactor Tiers](#compactor-tiers)).
- **Interpretation lift** — unmeasured. The [benchmark](#context-shift-benchmark) is a harness and a gate; the starter set is a wiring smoke test.
- **Embeddings** — no embedding model ships with this package (it stays zero-dependency). `ImportanceDetector` uses `message.embedding` when the host supplies one; `StubEmbedder` is an explicit placeholder returning zero vectors.
- **Extraction** — the regex compactor finds decisions, corrections, entities and constraints by pattern; it misses phrasings its patterns don't cover.

## Ecosystem

Short-hand is part of the smallchat suite. [smallchat](https://github.com/johnnyclem/smallchat) imports `@shorthand/core` (its vendored copy was merged here, and smallchat is replacing it with a dependency on this package), and the truth-ledger seam with [stenographer](https://github.com/johnnyclem/stenographer) is wired: this package reads stenographer's truth format v2 and writes PROPOSAL streams for it (see [Truth-Ledger Interop](#truth-ledger-interop)). Neither is a code dependency of this package.

[`docs/ecosystem/`](./docs/ecosystem/) holds an archived pre-1.0 evaluation of how short-hand related to [AgentVault](https://github.com/johnnyclem/AgentVault), SmallChat and Stenographer; its findings about this repo (no CI, no integrations, the `short-hand` package name) are out of date.

## License

MIT
