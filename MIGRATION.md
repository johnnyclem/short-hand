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
