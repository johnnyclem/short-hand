# Changelog

All notable changes to `@shorthand/core` are documented here. See [MIGRATION.md](./MIGRATION.md) for upgrade steps.

## [1.0.0] — Unreleased

### Breaking

- **Package renamed** from `short-hand` to `@shorthand/core`, published from this repository. It is now the only `@shorthand/core`: smallchat's vendored copy (`smallchat/shorthand`) is merged here and will be replaced by a dependency on this package.
- **Subpath exports**: `@shorthand/core/compaction`, `/crdt`, `/importance`, `/truth`, `/wiki`, `/ingestion`, `/interpreter`, `/verification`, `/benchmark`.
- **Benchmark moved out of the root export** to `@shorthand/core/benchmark`.
- **`CompactionEngine` runtime enum exported as `CompactionLevel`** (was `CompactionLevelEnum`).
- **`ConversationMessage.timestamp` is `number | string`**; use `normalizeTimestamp`. Tombstone and invariant timestamps stay epoch ms.
- **Importance**: `ImportanceDetector` is the modular detector (`addMessage`, `recomputeScores`, `ImportanceScore.importance`, `SignalWeights`, `DEFAULT_IMPORTANCE_CONFIG`). The lexical trajectory approximation is gone; trajectory and semantic-reference signals need `message.embedding`.
- **CRDT**: state-based API with per-replica Lamport clocks (`set(key, value)`, `merge(state)`, `from(...)`); `AgentMemory` has L0–L4 layers (`l4`, `l3Nodes`, `l3Edges`, `l2`, `l1`, `l0`) plus `activeEngrams`. Serialized 0.1 `AgentMemory` states do not load.
- **Truth**: typed codec (`parseWikiLines`, `selectCurrentTruth`, `TruthSelection`) replaces `parseTruthLedgerJsonl` / `buildTruthLedgerView` / `TruthLedgerView`; `renderTruthLines` / `renderTruthSection` use the suite's frozen markers (`[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`); `citableToInvariant` → `groundTruthToInvariant`; `CompactionEngine.getTruthView` → `getTruthSelection`.
- **Proposals use the suite PROPOSAL envelope** (`schemaVersion: 2`, `type: 'PROPOSAL'`, `id`, `ts`, `author`, `kind: 'tb' | 'uv'`, `targetRef`, `signal.source: 'compaction-candidate'`). Proposal export requires an accountable `author`.
- **Snapshot compaction types renamed** (for users of smallchat's vendored copy): `CompactedState` → `CompactedSnapshot`, `CompactionLevel` → `SnapshotLevel`, `Compactor` → `SnapshotCompactor`, `Decision` → `SnapshotDecision`, `VerificationResult` → `SnapshotVerificationResult`. `Tombstone` gains a required `timestamp`.
- **Truth codec fails closed** (for users of smallchat's vendored copy): unknown statuses are kept verbatim but classified as history instead of becoming `active`/`open`; lines without a status, TB claim or UV assertion are rejected.
- **Context frames are typed**: `ContextSection` gains `kind`, `items` (each with `sources`) and `omitted`; `ContextFrame` gains `omitted`. Sections fill item by item instead of all-or-nothing, L2 lines render as `[summary] <topic>: <text>` (was `[<topic>] <text>`), and untrusted text is escaped (`\[TB]`). (SH-04, SH-14)
- **`tokenUsage` is the rendered frame's estimate and never exceeds the budget** (`estimateTokens(renderContextFrame(frame))`, newlines included); corrections lost their 5% overflow allowance, so a frame for the same budget can hold slightly less. (SH-22)
- **L1 keeps messages verbatim**: no hedge/filler stripping, code blocks stay in the text (no `[code block]`), short replies are kept (folded into the question they answer). L1 text is longer than before. (SH-06, SH-07, SH-08)
- **Corrections are level-complete and archived**: superseded L1–L4 items move to `state.archive` instead of being deleted (L4 invariants and L3 entities/edges are now displaced too). `RegexCompactor` tombstones carry `id` and `confidence: 'inferred'`; corrections without a superseded value, or with a pronoun/function-word one, produce no tombstone. Questions no longer become decisions, corrections or invariants. (SH-01, SH-02, SH-16)
- **`recompact(L2)` drains summarized L1 entries** into the archive; discussion blocks are keyed `l2:<first>..<last>` and numbered stably; L3 edges are deduplicated. (SH-20)
- **Proposal export skips inferred corrections** unless `includeInferred: true`. (SH-16)
- **`InvariantChecker` checks L1–L4** (and a frame, if given) with the compactor's matcher; a tombstone without a superseded value fails `tombstone-consistency`; `temporal-ordering` checks real order. `RecallTester` no longer credits tombstone text and accepts a `ContextFrame`. (SH-25)
- **Snapshot verification scores the summary only**: `DefaultQuizEvaluator` no longer falls back to structured entities/decisions, `decisionCompleteness` ignores the structured decision list, and `measureEntityRetention` derives the entities to retain from the history. (SAT-12)
- **Ingestion**: chunk ids are `<sourceId>@<version>-chunk-<n>`; `IngestionEvent` gains `version`, `retractedChunks`, `skipped`; `entitiesDiscovered` lists only entities the source added; re-ingesting a changed source retracts the previous version. (SH-27)
- **Active engrams**: the default interpreter template no longer interpolates `{{context}}`; frames count a retrieval only for memories they include. (SH-23)
- **Interpreters** throw `InterpreterBudgetError('output_too_long')` on `stop_reason: 'max_tokens'` / `'model_context_window_exceeded'` and Ollama `done_reason: 'length'`, and `InterpreterUnavailableError` on `refusal`. (SH-17)
- **Extraction reads at most 16 KB of prose per message** (RegexCompactor and the importance state delta), in sentence windows of at most 400 characters. (SH-21, SAT-13)
- **CRDT wire format v1**: every serialized state carries `schemaVersion: 1` and its replica's Lamport `clock` (restored by `from`); LWW entries carry the writer's vector clock (`vc`) and tombstones are `{ deleted: true }` without a value. `merge` throws `TypeError` before changing anything on a malformed state or a newer `schemaVersion`. Pre-1.0 states still load. See [docs/crdt-format.md](./docs/crdt-format.md). (SH-09, SAT-05)
- **LWW-Register**: entries with the same `(counter, agentId)` — two writers sharing an id — are ordered tombstone first, then by canonical JSON, so they converge (the analogue of smallchat-swift SC-SW-29); `has(key)` is false for a deleted key; `set(key, undefined)` throws; `LWWEntry.value` is optional; `getEntry` returns a copy; `value()` / `keys()` / `serialize()` are ordered by key. (SAT-05)
- **OR-Set** elements are identified by canonical JSON (an object's key order no longer makes it a different element); `value()` and `serialize()` are sorted.
- **G-Set entries have explicit ids**: a keyless `add` issues `__id:<replicaId>:<counter>` (was a content key), so two keyless adds of the same value are two entries; `add` returns the key; the constructor takes `{ replicaId?, mergeFn? }` (a bare merge function still works); `defaultMergeFn` breaks equal-length ties by canonical JSON instead of keeping the local entry; merged entries without a `dedupeKey` are rejected; `value()` is ordered by key. (SAT-04)
- **RGA**: `insertAfter` throws `RangeError` for an unknown reference node (it used to park the node at the end, where replicas disagreed); `merge` throws `TypeError` on a node that is not causally after its predecessor, a predecessor in neither replica, or a node id with different content on the two sides (a replica id reused without restoring). (SAT-02)
- **ConflictDetector** reports an L4 or L3 conflict only for concurrent writes; an update made after seeing the old value (directly or relayed) is no longer reported, and deleted edges are skipped. (SAT-06)
- **ActiveEngramStore**: `get()` / `all()` return frozen copies (typed `Readonly<ActiveEngram>`); `mergeFrom(state, { from })` validates each engram, clamps importance to [0, 1], starts peer engrams at `retrievalCount` 0, never rewrites an engram it holds and returns an `EngramMergeReport` (was `void`); `remove` records a tombstone (`removed` in the serialized state) so merges never bring the engram back; a correction (`shadowsEngramId`) applies only between engrams of the same `origin` and hides the corrected engram in every context; `retrieveAsync` interprets one engram per slot and drops a slot whose correction fails; `add` / `setImportance` throw on a non-finite score; engram ids are random UUIDs; results with equal importance are ordered by `createdAt`, then id. (SH-11, SH-12)
- **AgentMemory**: `from` restores engrams with their retrieval counts; `mergeFrom` merges engrams with the remote `agentId` as the peer origin. `MemoryMerge` reports `layerChanges.engrams` and orders agents by code units (was `localeCompare`).

### Added

- `CompactionEngine.correct({ from, to, sourceMessageId, key?, reason? })` — explicit, deterministic corrections (content-derived tombstone ids); `revertCorrection(id)`; `retract(messageIds)`; `getSpan` / `pinSpan` / `unpinSpan` for the content-addressed code-span store (`state.spans`).
- `escapeUntrusted` and `renderContextFrame` (the single escaping frame renderer), `statesOnlySuperseded` / `isValidCorrectionSubject` (the shared supersession matcher), `applyTombstone` / `revertTombstone` / `retractMessages`, `renderTruthItems`.
- `ActiveEngramStore.select` (side-effect-free `retrieve`) and `markSurfaced`; `ReferenceGraph.getMaxWeightedScore`; `InvariantChecker.verify(state, { frame })`; `SourceIngester.versionOf`.
- Types: `CompactedEntry`, `CodeSpan`, `ArchivedItem`, `ArchiveReason`, `ContextSectionKind`, `ContextItem`, `CorrectionInput`; `Tombstone.id` / `confidence`, `Invariant.displacedBy`.
- Snapshot compaction (`DefaultCompactor`) with recall testing, pluggable invariant checks (`checkInvariants`, `VerificationHarness` `invariants` option), information-theoretic analysis and the `VerificationHarness`.
- CRDT: `LamportClock`, `compareLamport`, vector clocks, `RGA`, `MemoryMerge`, `ConflictDetector`; `AgentMemory.hasEntity`.
- Importance: `EntityGraph`, `ReferenceGraph`, `TrajectoryTracker`, `RunningStats`, `cosineSimilarity`, `cosineDistance`.
- Truth: tombstoned-literal validation and lossless `x-steno` / unknown-key round-trip, `TruthAwareCompactor`, `applyTruthToSnapshot`, `truthToInvariantRecords`, `proposeInvariants`, `appendProposalsFile`, `TbStatus` `struck`.
- `ConversationMessage` optional `embedding`, `toolCall` and `supersedes`; `normalizeTimestamp`.
- CRDT: `CRDT_SCHEMA_VERSION`, `LamportClock.observe`, `compareLWWEntries`, `isLWWTombstone`, `GSetOptions`, `AgentMemory.mergeLayersFrom` (`MemoryLayerChanges`), `ActiveEngram.origin`, `ActiveEngramStoreOptions.origin` / `generateId`, `ActiveEngramStore.deserialize(data, options)`, `EngramMergeOptions`, `EngramMergeReport`; [docs/crdt-format.md](./docs/crdt-format.md) (wire format, merge rules, engram trust model); fast-check property tests for every CRDT (convergence, commutativity, associativity, idempotence, restore-and-continue).

### Fixed

- Corrections reach L3 and L4: a corrected requirement no longer stays in every frame as an `[invariant]`, and `InvariantChecker` no longer reports correction propagation as passed when it did not happen. (SH-01)
- "Change it to blue" no longer deletes every compacted message containing "it". (SH-02)
- Concurrent `addMessage` calls no longer lose messages (state changes are serialized). (SH-05)
- Ledger, tool or message text can no longer forge a `[TB]` line in a frame. (SH-04)
- A large truth section, invariant set or graph no longer vanishes from the frame whole, and an oversized L1 entry no longer blocks smaller ones. (SH-14)
- "await" and "Factually" are no longer correction keywords; rejection-only decisions are titled `Rejected: <option>`. (SH-16)
- Repeated `recompact()` calls no longer grow L2 and the edge list. (SH-20)
- Linear-time extraction and chunking: a 256 KB unterminated message, a 64 KB tool output scored for importance, and a 200 KB unpunctuated paragraph (or minified JSON) no longer block the event loop for seconds; `chunkSize` is enforced and trailing text without a terminator is kept. (SH-13, SH-21, SAT-13)
- Importance scoring no longer sorts every reference score, or scans every edge, per message, so scoring a conversation is no longer quadratic in its length. (SH-29)
- `applyTruthToSnapshot` strips only the truth section it appended, instead of truncating the summary at the first quoted `## Asserted Truth (ledger)`. (SAT-11)
- Truncated interpreter output is never returned as a memory. (SH-17)
- OR-Set removes propagate through merges (tombstoned tags travel with the state), and a replica restored with `ORSet.from` never reissues a used tag.
- LWW-Register replicas converge on concurrent writes with equal counters (tie broken by agent id); `AgentMemory` no longer stamps writes from one process-global counter.
- G-Set entries without a `dedupeKey` from different replicas no longer overwrite each other on merge.
- Open UVs contesting a TB the ledger has not (yet) marked contested are rendered and projected instead of dropped; unsigned TBs render as `unsigned` instead of `signed: <author>`.
- RGA replicas converge on concurrent inserts at the head of the sequence (the first append of every fresh log): another agent's message is no longer interleaved between a message and its reply. (SAT-02)
- Two G-Set replicas holding equal-length summaries for one topic converge. (SAT-04)
- A restored LWW-Register, OR-Set, G-Set or RGA continues from its saved clock, so its new writes are ordered after the ones it saved and no tag or id is reissued. (SH-09, SH-10, SAT-05)
- A sequential update of an invariant is no longer flagged as a `critical` conflict. (SAT-06)
- A corrected engram no longer resurfaces with its stale text in contexts the correction's topics do not match, and the README example now retrieves. (SH-11)
- A peer's engram state can no longer set an arbitrary or NaN importance, a negative retrieval count, rewrite or shadow another agent's memory, or bring back a removed engram; `get()` results can no longer be mutated to change the store. (SH-12)
- Rehydrating or merging a long RGA log is linear (50k nodes: about 57 s before, well under a second now), and `MemoryMerge` tracks changed layers from the merge results instead of stringifying every layer twice per remote. (SAT-30)

### Deprecated

- `applyTruthToCompactedState` (use `applyTruthToSnapshot`) and `InvariantProposalLine` (use `UvProposalLine`), kept for smallchat's existing re-exports.
