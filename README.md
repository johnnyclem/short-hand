# short-hand

Progressive context compaction for LLMs. Old computer science for new constraints.

Short-hand uses an **LSM-tree inspired architecture** to progressively compact conversation history across five levels, reducing token usage while preserving critical information like decisions, corrections, and entity relationships.

**Zero runtime dependencies.** Fully typed. ESM-only.

## Why

Long conversations with LLMs accumulate context that eventually hits token limits. Naive truncation loses important information. Short-hand solves this by applying database-inspired compaction: recent messages stay verbatim, older messages get progressively condensed into summaries, knowledge graphs, and core invariants.

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

When a correction is detected ("Actually, we're using Postgres, not MySQL"), short-hand creates a **tombstone** that tracks the superseded information. This prevents stale facts from resurfacing during compaction.

### Importance Scoring

A three-signal model determines which messages matter most:

- **State delta** (45%) — Does the message change the entity graph or override prior information?
- **Reference frequency** (25%) — How often are the message's entities referenced later?
- **Trajectory discontinuity** (30%) — Does the message shift the conversation's direction?

## API

### CompactionEngine

The main orchestrator. Manages the full LSM-tree lifecycle.

```typescript
import { CompactionEngine } from 'short-hand';

const engine = new CompactionEngine({
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

Tier 0 compactor — pattern-based extraction with zero external dependencies. Extracts decisions, corrections, entities, and constraints via regex. Filters conversational noise.

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
const score = detector.score(message); // incremental — call once per message
// { overall: 0.72, stateDelta: 0.85, referenceFrequency: 0.4, trajectoryDiscontinuity: 0.8 }

// Retrospective pass: folds in how often later messages referenced each one
const updated = detector.recompute();
```

### CRDT Primitives

Distributed-friendly data structures for multi-agent scenarios.

```typescript
import { AgentMemory, LWWRegister, ORSet, GSet } from 'short-hand';

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

// Check five safety invariants against compacted state
const checker = new InvariantChecker();
const result = checker.verify(compactedState);
// { passed: true, checks: [{ name: 'correction-propagation', passed: true, message: '...' }, ...] }

// Generate quiz questions and test recall
const tester = new RecallTester();
const questions = tester.generateQuestions(originalMessages);
const recall = tester.evaluateRecall(questions, compactedState);
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
generateId(); // 'lx2f3a9b-k1m2n3o' (timestamp + random, base36)
```

## Tiers

Short-hand uses a tiered strategy with automatic fallback in two places:

**Compaction** (messages → compacted state):

| Tier | Strategy | Status | Dependencies |
|------|----------|--------|-------------|
| **0** | Regex | Stable | None |
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
} from 'short-hand';
```

## Development

```bash
git clone https://github.com/johnnyclem/short-hand.git
cd short-hand
npm install
npm run build    # compile TypeScript
npm test         # run tests (vitest)
npm run lint     # type-check without emitting
```

## License

MIT
