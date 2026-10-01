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

### Added

- Snapshot compaction (`DefaultCompactor`) with recall testing, pluggable invariant checks (`checkInvariants`, `VerificationHarness` `invariants` option), information-theoretic analysis and the `VerificationHarness`.
- CRDT: `LamportClock`, `compareLamport`, vector clocks, `RGA`, `MemoryMerge`, `ConflictDetector`; `AgentMemory.hasEntity`.
- Importance: `EntityGraph`, `ReferenceGraph`, `TrajectoryTracker`, `RunningStats`, `cosineSimilarity`, `cosineDistance`.
- Truth: tombstoned-literal validation and lossless `x-steno` / unknown-key round-trip, `TruthAwareCompactor`, `applyTruthToSnapshot`, `truthToInvariantRecords`, `proposeInvariants`, `appendProposalsFile`, `TbStatus` `struck`.
- `ConversationMessage` optional `embedding`, `toolCall` and `supersedes`; `normalizeTimestamp`.

### Fixed

- OR-Set removes propagate through merges (tombstoned tags travel with the state), and a replica restored with `ORSet.from` never reissues a used tag.
- LWW-Register replicas converge on concurrent writes with equal counters (tie broken by agent id); `AgentMemory` no longer stamps writes from one process-global counter.
- G-Set entries without a `dedupeKey` from different replicas no longer overwrite each other on merge.
- Open UVs contesting a TB the ledger has not (yet) marked contested are rendered and projected instead of dropped; unsigned TBs render as `unsigned` instead of `signed: <author>`.

### Deprecated

- `applyTruthToCompactedState` (use `applyTruthToSnapshot`) and `InvariantProposalLine` (use `UvProposalLine`), kept for smallchat's existing re-exports.
