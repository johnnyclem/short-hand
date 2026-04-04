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
// frame.tokenEstimate stays within your budget
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
  memtableSize: 10,      // L0 capacity before auto-flush (default: 10)
  contextBudget: 4096,   // token budget for context frames (default: 4096)
  compactorTier: 'regex', // compaction strategy (default: 'regex')
});

await engine.addMessage(message);        // add one message
await engine.addMessages(messages);      // add many
await engine.flush();                    // force L0 → L1 compaction
await engine.recompact(level);           // deeper recompaction (L1→L2, etc.)
const frame = engine.buildContextFrame(budget); // build context within token budget
const state = engine.getState();         // inspect current compacted state
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
const score = detector.score(message, conversationHistory);
// { total: 0.72, stateδ: 0.85, referenceFreq: 0.4, trajectoryDisc: 0.8 }
```

### CRDT Primitives

Distributed-friendly data structures for multi-agent scenarios.

```typescript
import { AgentMemory, LWWRegister, ORSet, GSet } from 'short-hand';

// Per-agent memory combining all CRDT types
const memory = new AgentMemory({ id: 'agent-1', name: 'Coder' });

// Last-Writer-Wins Register (L4 invariants)
const reg = new LWWRegister('db', 'PostgreSQL', 1);
reg.set('MySQL', 2); // newer timestamp wins

// Observed-Remove Set (L3 entities, add-wins)
const orset = new ORSet<string>();
orset.add('React');
orset.remove('React');

// Grow-Only Set (L2 summaries)
const gset = new GSet<string>();
gset.add('Session covered auth flow');

// Merge across agents
const merged = memory.merge(otherMemory.serialize());
```

### Verification

Safety checks and recall testing for compacted state.

```typescript
import { InvariantChecker, RecallTester } from 'short-hand';

// Check five safety invariants against compacted state
const checker = new InvariantChecker();
const results = checker.check(compactedState, originalMessages);
// [{ name: 'correction-propagation', passed: true, details: '...' }, ...]

// Generate quiz questions and test recall
const tester = new RecallTester();
const questions = tester.generateQuestions(originalMessages);
const score = tester.evaluateRecall(compactedState, questions);
// 0.85 (85% recall)
```

### Utilities

```typescript
import { estimateTokens, generateId } from 'short-hand';

estimateTokens('Hello world'); // ~3 (4 chars per token heuristic)
generateId(); // 'msg_1712345678901_a1b2c3'
```

## Compactor Tiers

Short-hand supports a tiered compaction strategy with automatic fallback:

| Tier | Strategy | Status | Dependencies |
|------|----------|--------|-------------|
| **0** | Regex | Stable | None |
| **1** | Local LM | Planned | ONNX runtime |
| **2** | Host LLM | Planned | LLM API access |

The engine defaults to Tier 0 (regex) and will fall back gracefully if a higher tier is unavailable.

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
