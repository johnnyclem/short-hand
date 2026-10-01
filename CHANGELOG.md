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

### Deprecated

- `applyTruthToCompactedState` (use `applyTruthToSnapshot`) and `InvariantProposalLine` (use `UvProposalLine`), kept for smallchat's existing re-exports.
