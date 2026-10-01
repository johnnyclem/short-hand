# Migrating to @shorthand/core 1.0

1.0 merges the two codebases that shared the `@shorthand/core` identity into this repository:

- **short-hand** (this repo, published nowhere yet, package name `short-hand`): the LSM compaction engine, active engrams, interpreters, ingestion, wiki rendering and benchmark.
- **smallchat's vendored copy** (`smallchat/shorthand`, package name `@shorthand/core`, installed through `file:./shorthand`): the snapshot compactor and its verification harness, the clock/RGA/conflict-detector CRDT layer, the modular importance detector and the truth codec.

Where the two had the same concept with different APIs, 1.0 keeps one. This guide lists every rename and behavior change, grouped by where you are coming from.

## Coming from smallchat's vendored copy

Import paths are unchanged: `@shorthand/core`, `@shorthand/core/compaction`, `/crdt`, `/importance` and `/truth` resolve every value smallchat re-exports today, and smallchat's current re-export blocks compile unchanged under `moduleResolution: Node16`. Replace the dependency:

```diff
- "@shorthand/core": "file:./shorthand"
+ "@shorthand/core": "^1.0.0"
```

then delete `shorthand/`. Keep `src/embedding` in smallchat: the ONNX embedding module is not part of this package (it stays zero-dependency), so there is no `@shorthand/core/embedding` subpath.

### Compaction: snapshot types were renamed

In 1.0, `CompactedState`, `CompactionLevel`, `Compactor`, `Decision` and `VerificationResult` name the LSM pipeline's types (they are the root types of this repo). The snapshot pipeline's types — what `DefaultCompactor` returns — were renamed. A re-export of the old names still compiles but now exports different types, so rename them:

| Vendored name | 1.0 name |
|---|---|
| `CompactedState` | `CompactedSnapshot` |
| `CompactionLevel` (`'L0'`–`'L3'`) | `SnapshotLevel` |
| `Compactor` | `SnapshotCompactor` |
| `Decision` | `SnapshotDecision` |
| `VerificationResult` | `SnapshotVerificationResult` |

For smallchat's `src/index.ts` that is:

```diff
 export type {
-  CompactedState,
+  CompactedSnapshot,
   CompactionInvariant,
-  CompactionLevel,
+  SnapshotLevel,
   CompactionVerificationConfig,
-  Compactor,
+  SnapshotCompactor,
   ConversationHistory,
   ConversationMessage,
-  Decision,
+  SnapshotDecision,
   ...
 } from '@shorthand/core/compaction';
-export type { VerificationResult as CompactionVerificationResult } from '@shorthand/core/compaction';
+export type { SnapshotVerificationResult as CompactionVerificationResult } from '@shorthand/core/compaction';
```

(Alias them back to the old names in the re-export if smallchat wants to keep its own public names.)

Other compaction changes:

- `Tombstone` is shared by both pipelines. It gains a required `timestamp` (epoch ms of the correction) and optional `key` and `correctedValue`; `detectTombstones` fills all three. Code that builds tombstones by hand must add `timestamp`.
- Invariants are pluggable: `CompactionInvariant.category` accepts any string (built-ins are typed as `BuiltinInvariantCategory`), and `VerificationHarness` takes `invariants` in its config (default `BUILTIN_INVARIANTS`).

### Truth

| Vendored | 1.0 |
|---|---|
| `applyTruthToCompactedState` | `applyTruthToSnapshot` (the old name is kept as a `@deprecated` alias) |
| `InvariantProposalLine` | `UvProposalLine`; `ProposalLine` is the union with `TbProposalLine` (the old name is kept as a `@deprecated` alias) |

Behavior changes (all in the fail-closed direction):

- **Unknown statuses are no longer coerced.** A TB whose status is not `active`/`contested`/`overridden`/`struck` used to become `active`, and an unknown UV status became `open`. Both are now kept verbatim (they round-trip) and classified as `history`: never ground truth, never a flag. `TruthTbEntry.status` and `TruthUvEntry.status` are typed `TbStatus | UnknownStatus` / `UvStatus | UnknownStatus` accordingly.
- **Lines missing a status, a TB claim or a UV assertion are rejected** into `WikiParseResult.errors` (`'missing status'`, `'TB entry missing claim'`, `'UV entry missing assertion'`) instead of defaulting to `active`/`open`/`''`.
- `TbStatus` adds `struck`.
- Top-level keys the codec does not interpret (for example v2 `schemaVersion`, `seq`, `prevHash`, `hash`, or another tool's `x-*` namespace) are preserved in `entry.extra` and re-emitted by `entryToWikiLine`.
- `renderTruthSection` renders an unsigned TB as `unsigned` (it used to print `signed: <author>`, so a migration backfill read as signed).
- An open UV that contests a TB the selection does not hold as `contested` (for example an incremental export that delivered the UV before the TB's re-emitted line) is now rendered standalone with `contests <id>`, and `truthToInvariantRecords` emits a record for it. Both used to drop it.
- PROPOSAL lines use the suite's single envelope: they gain `schemaVersion: 2`, `signal.source` is `'compaction-candidate'` (was `'shorthand-compaction'`), `targetRef` is always present (`string | null`), and a `provenance` field names the source message.

New in the truth module: `renderTruthLines` (the section without its heading), `TRUTH_SECTION_HEADING`, `TRUTH_SOURCE_PREFIX`, `groundTruthToInvariant`, `displaceStaleInvariants`, and the LSM proposal export (`invariantsToProposalDrafts`, `tombstonesToProposalDrafts`, `exportProposalDrafts`, `uvProposal`, `tbProposal`).

### CRDT

The API is the vendored one. Wire-format and behavior changes:

- **OR-Set removes propagate.** `ORSetState` gains `removed` (tombstoned tags). A remove used to delete locally only, so the element came back on the next merge with any replica that had seen it. States without `removed` still load. `ORSet.from` advances the tag clock past every tag in the state, so a restored replica never reissues a tag.
- **G-Set entries without a `dedupeKey` are keyed by content** (`__content:<JSON of value>`) instead of a per-replica counter (`__auto_<n>`), so keyless entries from different agents no longer overwrite each other on merge, and identical keyless values collapse. Entries in old serialized states keep the `__auto_<n>` key they were stamped with.
- `AgentMemory` carries an `ActiveEngramStore` (`memory.activeEngrams`), serialized as the optional `AgentMemoryState.activeEngrams` and merged as a union by engram id. New `hasEntity(name)`. `appendMessage` and `L0Message.role` accept `'tool'`.

### Importance

Unchanged.

### Messages

`ConversationMessage` is the same superset plus an optional `metadata` record. `normalizeTimestamp` is exported from the root and `@shorthand/core/compaction`.

## Coming from short-hand 0.1 (`short-hand`)

### Package

- Install `@shorthand/core` instead of `short-hand` and change imports from `'short-hand'` to `'@shorthand/core'`.
- The context-shift benchmark is no longer exported from the root. Import `ContextShiftBenchmark`, `echoAnswerer`, `wilson95`, `KeywordJudge`, `LMJudge`, `STARTER_FIXTURES` and their types from `@shorthand/core/benchmark`. `npm run benchmark` is unchanged.
- `CompactionLevelEnum` → `CompactionLevel`. The enum is now exported as a value under its own name (it was only exported as a type).

### Messages

- `ConversationMessage.timestamp` is `number | string` (epoch ms or ISO 8601). Code that does arithmetic on it should call `normalizeTimestamp(message.timestamp)`. The compactors already do: tombstone and invariant timestamps are always epoch ms.
- New optional fields: `embedding` (`Float32Array`), `toolCall`, `supersedes`.

### Importance

`ImportanceDetector` is the modular detector (state delta, reference graph, trajectory tracker):

| 0.1 | 1.0 |
|---|---|
| `new ImportanceDetector(weights)` | `new ImportanceDetector({ weights })` (`Partial<ImportanceDetectorConfig>`) |
| `detector.score(message)` | `detector.addMessage(message)` |
| `detector.recompute()` → `ImportanceScore[]` | `detector.recomputeScores()` → `Map<messageId, ImportanceScore>` |
| `detector.getAllScores()` → `{ messageId, score }[]` in arrival order | `detector.getAllScores()` → `ImportanceScore[]`, highest importance first |
| `ImportanceScore.overall` | `ImportanceScore.importance` (plus `messageId` and `dominantSignal`) |
| `ImportanceWeights` | `SignalWeights` (also `AgentProfile.importanceWeights`) |
| `DEFAULT_IMPORTANCE_WEIGHTS` (0.45 / 0.25 / 0.30) | `DEFAULT_IMPORTANCE_CONFIG.weights` (0.4 / 0.25 / 0.35) |

The trajectory-discontinuity and semantic-reference signals now use `message.embedding`; the lexical (Jaccard) approximation is gone. Without embeddings those signals are 0.

### CRDT

| 0.1 | 1.0 |
|---|---|
| `reg.set(key, value, timestamp)` | `reg.set(key, value)` — each register owns a Lamport clock; equal counters are ordered by agent id, so replicas converge |
| `reg.merge(otherRegister)` | `reg.merge(otherRegister.serialize())` (returns whether anything changed); same for `ORSet`, `GSet`, `RGA` |
| `reg.values()` | `reg.value()` (a `Map`) |
| `LWWRegister.deserialize(agentId, data)` | `LWWRegister.from(agentId, state)`; likewise `ORSet.from`, `GSet.from(state, mergeFn?)`, `AgentMemory.from(state)` |
| `orset.values()` (array) | `orset.value()` (a `Set`) |
| `new GSet<T>()` holding plain values | `GSet<V>` holding `GSetEntry<V>` (`{ value, sourceAgent, isDirectParticipant, dedupeKey? }`) with a pluggable merge function |
| `AgentMemory.invariants` / `.entities` / `.summaries` | `.l4` / `.l3Nodes` + `.l3Edges` / `.l2`, plus `.l1` and `.l0` RGA logs |
| `memory.addEntity(entity: Entity)` | `memory.addEntity({ id, type, name, properties? })` (`L3Entity`) |
| `memory.addSummary(summary: TopicSummary)` | `memory.addSummary(topic, content, isDirectParticipant)` |
| `SerializedAgentMemory` | `AgentMemoryState` |

The serialized formats changed (Lamport timestamps are `{ counter, agentId }`, OR-Set state is `{ elements, removed }`, G-Set state is `{ entries }`), so 0.1 `AgentMemory` snapshots do not load in 1.0. `memory.activeEngrams` and the `ActiveEngramStore` API are unchanged.

### Truth

| 0.1 | 1.0 |
|---|---|
| `parseTruthLedgerJsonl(input)` → raw `TruthLedgerLine[]` | `parseWikiLines(input)` → typed `TruthLedgerEntry[]` |
| `buildTruthLedgerView(entries)` → `{ citable, flags, displaced }` | `selectCurrentTruth(entries)` → `{ groundTruth, contested, unverified, history }` |
| `CitableTruth` | `TruthTbEntry` (ground truth) / `{ tombstone, contestedBy }` (contested) |
| `renderTruthSection(view)` → `string[]` | `renderTruthLines(selection)` → `string[]`, or `renderTruthSection(selection)` → the section with its heading |
| `citableToInvariant(citable)` | `groundTruthToInvariant(tb)` |
| `displaceStaleInvariants(invariants, view)` | `displaceStaleInvariants(invariants, selection)` |
| `engine.getTruthView()` | `engine.getTruthSelection()` |
| `TruthSyncResult.view` | `TruthSyncResult.selection` |
| `TruthLedgerLine` | `WikiEntryLine` (wire) / `TruthLedgerEntry` (parsed) |
| `TruthConfidence` `'TB' \| 'UV'` | `'tb' \| 'uv'` |
| `ProposalDraftLine` | `ProposalLine` (`UvProposalLine \| TbProposalLine`) |
| `exportProposalDrafts(state)` (and the two `*ToProposalDrafts`) | `exportProposalDrafts(state, { author })` |

- Frame markers changed to the suite's frozen ones: `[truth]` → `[TB]`, `[truth, contested]` → `[TB ⚠ CONTESTED]`, `[unverified]` / `[disputed by unverified assertion]` → `[UV — UNVERIFIED]`. The truth section in a context frame starts with `## Asserted Truth (ledger)`.
- Proposals use the suite's PROPOSAL envelope: each line carries `schemaVersion: 2`, `type: 'PROPOSAL'`, a ULID `id`, `ts`, an accountable `author` (generic identities throw), `kind` (`'tombstone'` → `'tb'`), `draft`, `targetRef`, `signal` and `agentSessionId`. `provenance` is unchanged.
- Literals on TBs are validated with stenographer's write-time rule, and a TB with invalid literals is rejected like stenographer rejects it.

### New in 1.0 for short-hand users

- The snapshot pipeline: `DefaultCompactor` and its verification strategies (`runRecallTest`, `checkInvariants` with pluggable invariants, `analyzeInformationTheoretic`, `VerificationHarness`), and `TruthAwareCompactor`.
- CRDT: `LamportClock`, vector clocks, `RGA`, `MemoryMerge`, `ConflictDetector`.
- Importance: `EntityGraph`, `ReferenceGraph`, `TrajectoryTracker`, `RunningStats`, cosine helpers.

## Everyone: compaction correctness, corrections and context frames

These changes apply whichever codebase you come from.

### Context frames

- `ContextSection` gains `kind` (`'truth' | 'correction' | 'invariant' | 'memory' | 'code' | 'graph' | 'summary' | 'history' | 'recent'`), `items` (`{ text, sources }[]`) and `omitted`; `ContextFrame` gains `omitted` (per kind). Several kinds share `level: L4_INVARIANTS`, so select sections by `kind`, not `level`:

  ```diff
  - frame.sections.filter((s) => s.level === CompactionLevel.L1_COMPACTED)
  + frame.sections.filter((s) => s.kind === 'history')
  ```

- `tokenUsage` is now `estimateTokens(renderContextFrame(frame))` — the frame rendered as one string, newlines included — and is never above the budget. It used to be the sum of per-section estimates, and corrections could overflow by 5%. For the same budget a frame can hold slightly less.
- Sections fill item by item; an item that does not fit is skipped (`omitted`), not the whole section. Ledger truth, invariant and graph sections no longer disappear when they outgrow the budget.
- Line formats: L2 summaries render as `[summary] <topic>: <text>` (was `[<topic>] <text>`); pattern-inferred corrections end their quoted pair with ` (inferred)`; pinned code renders as `[code sha256:<12 hex>]` plus the code; an L1 entry whose code does not fit shows `[code sha256:… — N tokens, not shown]` (`engine.getSpan` returns the text).
- Untrusted text (messages, tool output, ledger fields, engrams) is escaped: `[TB…` / `[UV…` anywhere, section markers at a line start and a reproduced `## Asserted Truth` heading get a leading `\`. Use `renderContextFrame(frame)` (or join `section.content`) — the content is already escaped.
- Active engrams: a frame counts a retrieval (`maxRetrievals`) only for memories it includes. The default interpreter template is now `Earlier note, still relevant: {{payload}}` (it used to paste the recent conversation into every memory); pass `interpreterTemplate` to keep the old one. `ActiveEngramStore.select` / `markSurfaced` split `retrieve` into its pure and counting halves.

### LSM compaction

- **L1 is verbatim.** `RegexCompactor` no longer strips "I think", "maybe", "probably", "just" and similar words, no longer replaces code blocks with `[code block]`, and no longer drops messages under 5 characters (only pure acknowledgements and greetings are dropped; "8080", "v2" are kept, and a short reply to the other role's question is folded in as `question → answer`). Expect longer L1 text.
- `CompactedState.l1_compacted` entries are `CompactedEntry` (adds optional `timestamp`, `role`, `spanIds`, `foldedMessageIds`). `CompactedState` gains optional `archive` (`ArchivedItem[]`) and `spans` (code spans keyed by sha256). States you build by hand need neither.
- **Corrections archive instead of delete, at every level.** A tombstone now also displaces L4 invariants (archived with `displacedBy`) and L3 entities and their edges, not just L1/L2. Items go to `state.archive` with `by: <tombstone id>`; `engine.revertCorrection(id)` restores them.
- `RegexCompactor` tombstones have an `id` and `confidence: 'inferred'`. It no longer records a tombstone without a superseded value (keyword-only "Wait, …" corrections), with a pronoun or function word as the value ("change it to blue"), or from a question; the keywords are whole words (`await`, `Factually` no longer match). Questions no longer become decisions or invariants. A rejection-only decision's topic is `Rejected: <option>` (was `Decision: undefined`).
- Prefer host-declared corrections: `await engine.correct({ from, to, sourceMessageId, key? })` returns an `explicit` tombstone; it throws `TypeError` for an empty or pronoun `from`.
- `recompact(L2_SUMMARIES)` moves the L1 entries it summarizes into the archive (`reason: 'summarized'`), so repeated calls are idempotent. Discussion-block summaries have ids `l2:<first>..<last>` and stable numbers; L3 edges are deduplicated by (source, relation, target).
- `addMessage` adds the message to L0 synchronously and queues compaction behind earlier operations; all state changes run on one queue. Concurrent calls no longer lose messages.
- Extraction reads at most 16 KB of prose per message (code blocks excluded), in sentence windows of at most 400 characters. Decisions, corrections, entities and constraints past that point are no longer extracted (the text itself is kept).

### Proposals

`exportProposalDrafts` / `tombstonesToProposalDrafts` skip tombstones with `confidence: 'inferred'` unless you pass `includeInferred: true`, and never propose a tombstone without a superseded value. Hand-built tombstones (no `confidence`) are proposed as before.

### Verification

- `InvariantChecker.verify(state, { frame? })` checks correction propagation across L1–L4 (it checked only L1/L2 by substring) using the compactor's whole-word matcher, ignoring items restated after the correction; with a frame it adds a `frame-staleness` check. `tombstone-consistency` fails on a tombstone with an empty superseded value; `temporal-ordering` now checks order, not just field presence. States that passed before can fail.
- `RecallTester.evaluateRecall(questions, stateOrFrame, { tombstones? })` accepts a `ContextFrame`; tombstone text no longer counts as recall, and questions whose answer is a superseded value are reported as `recall:superseded` and left out of the score.
- Snapshot pipeline: `DefaultQuizEvaluator` answers from `summary` only (no fallback to `entities` / `decisions`), `decisionCompleteness` (INV-003) checks the summary only, and `measureEntityRetention` takes the entities to retain from the original history. Recall and retention scores can drop for snapshots whose summary omits facts.
- `applyTruthToSnapshot` strips only the truth section it appended (the trailing one matching `state.truth`), not everything after the first `## Asserted Truth (ledger)` in the summary.

### Ingestion

- Chunk message ids are `<sourceId>@<version>-chunk-<n>` (was `<sourceId>-chunk-<n>`); `metadata.sourceVersion` carries the version (first 12 hex of the content's sha256).
- `IngestionEvent` gains `version`, `retractedChunks` and `skipped`; `entitiesDiscovered` lists only the entities this ingestion added. Re-ingesting an unchanged source is a no-op (`skipped: true`, not logged); re-ingesting a changed one retracts the previous version's chunks first (`engine.retract`).
- Every chunk is now at most `chunkSize` tokens (oversized paragraphs are split by sentence, then whitespace, then hard cuts), and trailing text without a sentence terminator is kept.

### Interpreters

`HostInterpreter` throws `InterpreterBudgetError('output_too_long')` when the response's `stop_reason` is `max_tokens` or `model_context_window_exceeded`, and `InterpreterUnavailableError` on `refusal`; `LocalInterpreter` throws `InterpreterBudgetError` on Ollama's `done_reason: 'length'`. `withFallback` routes both. Stubs that return truncated text with those stop reasons now fail.
