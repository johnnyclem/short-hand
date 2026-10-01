# Changelog

All notable changes to `@shorthand/core` are documented here. See [MIGRATION.md](./MIGRATION.md) for upgrade steps.

## [1.0.0] - Unreleased

1.0 makes this repository the one canonical `@shorthand/core`: smallchat's vendored copy (`smallchat/shorthand`, published nowhere, installed through `file:./shorthand`) is merged in, and the package formerly named `short-hand` is renamed. Breaking changes are grouped by area; most entries apply to users of both former codebases, and MIGRATION.md says which apply to whom.

### Breaking

**Package and runtime**

- **Package renamed** from `short-hand` to `@shorthand/core`, published from this repository with `publishConfig.access: public`. smallchat's vendored copy will be replaced by a dependency on this package.
- **Node.js 22 or later** (`engines.node: ">=22"`; Node 18 and 20 are end-of-life). CI runs on Node 22 and 24. The package stays ESM-only with zero runtime dependencies.
- **Subpath exports**: `@shorthand/core/compaction`, `/crdt`, `/importance`, `/truth`, `/wiki`, `/ingestion`, `/interpreter`, `/verification`, `/benchmark`. Only these (and `./package.json`) are importable; deep imports into `dist/` are blocked by `exports`.
- **Benchmark moved out of the root export** to `@shorthand/core/benchmark`.
- **`CompactionLevel`** is the runtime enum's name (was `CompactionLevelEnum`), now exported as a value.
- **`ConversationMessage.timestamp` is `number | string`**; use `normalizeTimestamp`. Tombstone and invariant timestamps stay epoch ms.

**LSM compaction and context frames**

- **Context frames are typed**: `ContextSection` gains `kind`, `items` (each with `sources`) and `omitted`; `ContextFrame` gains `omitted`. Sections fill item by item instead of all-or-nothing, L2 lines render as `[summary] <topic>: <text>` (was `[<topic>] <text>`), and untrusted text is escaped (`\[TB]`). (SH-04, SH-14)
- **`tokenUsage` is the rendered frame's estimate and is at most the budget** (`estimateTokens(renderContextFrame(frame))`, newlines included); corrections lost their 5% overflow allowance, so a frame for the same budget can hold slightly less. (SH-22)
- **L1 keeps messages verbatim**: no hedge/filler stripping, code blocks stay in the text (no `[code block]`), short replies are kept (folded into the question they answer). L1 text is longer than before. (SH-06, SH-07, SH-08)
- **Corrections are level-complete and archived**: superseded L1–L4 items move to `state.archive` instead of being deleted (L4 invariants and L3 entities/edges are now displaced too). `RegexCompactor` tombstones carry `id` and `confidence: 'inferred'`; corrections without a superseded value, or with a pronoun/function-word one, produce no tombstone. Questions no longer become decisions, corrections or invariants. (SH-01, SH-02, SH-16)
- **`recompact(L2)` drains summarized L1 entries** into the archive; discussion blocks are keyed `l2:<first>..<last>` and numbered stably; L3 edges are deduplicated. (SH-20)
- **Proposal export skips inferred corrections** unless `includeInferred: true`. (SH-16)
- **Extraction reads at most 16 KB of prose per message** (RegexCompactor and the importance state delta), in sentence windows of at most 400 characters. (SH-21, SAT-13)
- **`InvariantChecker` checks L1–L4** (and a frame, if given) with the compactor's matcher; a tombstone without a superseded value fails `tombstone-consistency`; `temporal-ordering` checks real order. `RecallTester` no longer credits tombstone text and accepts a `ContextFrame`. (SH-25)
- **Ingestion**: chunk ids are `<sourceId>@<version>-chunk-<n>`; `IngestionEvent` gains `version`, `retractedChunks`, `skipped`; `entitiesDiscovered` lists only entities the source added; re-ingesting a changed source retracts the previous version. (SH-27)
- **`WikiRenderer` escapes what it renders and gives every page its own path**: names and text are markdown/HTML-escaped; colliding slugs (`C++`/`C#`, two summaries of one topic, empty slugs) get a hash suffix; slugs keep non-Latin letters; links are relative to their page. (SH-24)

**Snapshot compaction** (smallchat's vendored pipeline)

- **Types renamed**: `CompactedState` → `CompactedSnapshot`, `CompactionLevel` → `SnapshotLevel`, `Compactor` → `SnapshotCompactor`, `Decision` → `SnapshotDecision`, `VerificationResult` → `SnapshotVerificationResult` (the old names now refer to the LSM types). `Tombstone` is shared and gains a required `timestamp`.
- **Verification scores the summary only**: `DefaultQuizEvaluator` no longer falls back to structured entities/decisions, `decisionCompleteness` ignores the structured decision list, and `measureEntityRetention` derives the entities to retain from the history. (SAT-12)

**Active engrams and interpreters**

- **Default interpreter template** no longer interpolates `{{context}}` (`Earlier note, still relevant: {{payload}}`); frames count a retrieval only for memories they include. (SH-23)
- **`ActiveEngramStore`**: `get()` / `all()` return frozen copies (typed `Readonly<ActiveEngram>`); `mergeFrom(state, { from })` validates each engram, clamps importance to [0, 1], starts peer engrams at `retrievalCount` 0, never rewrites an engram it holds and returns an `EngramMergeReport` (was `void`); `remove` records a tombstone (`removed` in the serialized state) so merges never bring the engram back; a correction (`shadowsEngramId`) applies only between engrams of the same `origin` and hides the corrected engram in every context; `retrieveAsync` interprets one engram per slot and drops a slot whose correction fails; `add` / `setImportance` throw on a non-finite score; engram ids are random UUIDs; results with equal importance are ordered by `createdAt`, then id. (SH-11, SH-12)
- **Interpreters** throw `InterpreterBudgetError('output_too_long')` on `stop_reason: 'max_tokens'` / `'model_context_window_exceeded'` and Ollama `done_reason: 'length'`, and `InterpreterUnavailableError` on `refusal`. (SH-17)

**Importance** (short-hand 0.1 users)

- `ImportanceDetector` is the modular detector (`addMessage`, `recomputeScores`, `ImportanceScore.importance`, `SignalWeights`, `DEFAULT_IMPORTANCE_CONFIG`). The lexical trajectory approximation is gone; trajectory and semantic-reference signals need `message.embedding`.

**CRDT**

- **State-based API** (short-hand 0.1 users): per-replica Lamport clocks (`set(key, value)`, `merge(state)`, `from(...)`); `AgentMemory` has L0–L4 layers (`l4`, `l3Nodes`, `l3Edges`, `l2`, `l1`, `l0`) plus `activeEngrams`. Serialized 0.1 `AgentMemory` states do not load.
- **Wire format v1**: every serialized state carries `schemaVersion: 1` and its replica's Lamport `clock` (restored by `from`); LWW entries carry the writer's vector clock (`vc`) and tombstones are `{ deleted: true }` without a value; `ORSetState` gains `removed`; `AgentMemoryState` gains `activeEngrams`. `merge` throws `TypeError` before changing anything on a malformed state or a newer `schemaVersion`. Pre-1.0 vendored states still load. See [docs/crdt-format.md](./docs/crdt-format.md). (SH-09, SAT-03, SAT-05)
- **LWW-Register**: entries with the same `(counter, agentId)` — two writers sharing an id — are ordered tombstone first, then by canonical JSON, so they converge (the analogue of smallchat-swift SC-SW-29); `has(key)` is false for a deleted key; `set(key, undefined)` throws; `LWWEntry.value` is optional; `getEntry` returns a copy; `value()` / `keys()` / `serialize()` are ordered by key. (SAT-05)
- **OR-Set** elements are identified by canonical JSON (an object's key order no longer makes it a different element); `value()` and `serialize()` are sorted.
- **G-Set entries have explicit ids**: a keyless `add` issues `__id:<replicaId>:<counter>` (was a per-replica `__auto_<n>` counter), so two keyless adds of the same value are two entries; `add` returns the key; the constructor takes `{ replicaId?, mergeFn? }` (a bare merge function still works); `defaultMergeFn` breaks equal-length ties by canonical JSON instead of keeping the local entry; merged entries without a `dedupeKey` are rejected; `value()` is ordered by key. (SAT-04)
- **RGA**: `insertAfter` throws `RangeError` for an unknown reference node (it used to park the node at the end, where replicas disagreed); `merge` throws `TypeError` on a node that is not causally after its predecessor, a predecessor in neither replica, or a node id with different content on the two sides (a replica id reused without restoring). (SAT-02)
- **ConflictDetector** reports an L4 or L3 conflict only for concurrent writes; an update made after seeing the old value (directly or relayed) is no longer reported, and deleted edges are skipped. (SAT-06)
- **AgentMemory**: `from` restores engrams with their retrieval counts; `mergeFrom` merges engrams with the remote `agentId` as the peer origin. `MemoryMerge` reports `layerChanges.engrams` and orders agents by code units (was `localeCompare`).

**Truth**

- **Typed codec** (short-hand 0.1 users): `parseWikiLines`, `selectCurrentTruth`, `TruthSelection` replace `parseTruthLedgerJsonl` / `buildTruthLedgerView` / `TruthLedgerView`; `renderTruthLines` / `renderTruthSection` use the suite's frozen markers (`[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`); `citableToInvariant` → `groundTruthToInvariant`; `CompactionEngine.getTruthView` → `getTruthSelection`. (Vendored names `applyTruthToCompactedState` and `InvariantProposalLine` remain as deprecated aliases of `applyTruthToSnapshot` and `UvProposalLine`.)
- **Fail closed**: unknown statuses are kept verbatim but classified as history instead of becoming `active`/`open`; a line without a status is history (`status: null`); lines without a TB claim or UV assertion are refused. (SAT-09)
- **Truth format v2** (stenographer `spec/truth-format`): streams are hash-chained (`seq`, `prevHash`, `hash` over RFC 8785 JCS) and a stream with a bad hash, a refused identity or a broken chain is refused whole (`WikiParseResult.refused`, `TruthSyncResult.refused`; no truth is synced from it). Status is folded from `TRANSITION` lines (highest seq wins, else the line's own) instead of "last line wins" (still used for version 1 files). `TruthTbEntry.status` / `TruthUvEntry.status` add `null`; `TbStatus` and `UvStatus` add `struck`. Unsigned TBs are never truth on their own; version 1 TBs are unverifiable and not truth unless `{ admitV1Tbs: true }`; with `{ signers }`, unlisted authors and signers are not truth; ids with conflicting content are not truth. An open UV contesting a current TB carries that TB as contested. Identities compare by NFKC key and refuse control characters and misplaced reserved names. Version 1 lines are validated as stenographer 0.x wrote them, and codec error messages changed. `entryToWikiLine` / `serializeWikiEntries` give back the exact line an entry was read from. `isAnonymousIdentity` / `assertAccountableAuthor` moved to `truth/identity.ts` (same exports); `assertAccountableAuthor` also refuses control characters and `migration`, and accepts `detector:<name>`. (SH-03, SAT-07, SAT-08, SAT-09, XSUITE-03, XSUITE-04, XSUITE-08)
- **Proposals use the suite PROPOSAL envelope, exactly** (`schemaVersion: 2`, `seq`, `id`, `type: 'PROPOSAL'`, `ts`, `author`, `kind: 'tb' | 'uv'`, `draft`, `targetRef`, `signal.source: 'compaction-candidate'`, `agentSessionId`, `prevHash`, `hash`), written as one writer's hash-chained stream. Proposal export requires an accountable `author`. The top-level `provenance` field and the `tb` draft's `signedBy: null` are gone; `ProposalSpec.sourceMessageId` is removed. `serializeProposals` and `exportProposalDrafts` return chained lines; `appendProposalsFile` refuses (and leaves untouched) a file that is not one valid proposals stream, such as a pre-1.0 file of bare lines, dedupes by (kind, targetRef, normalized claim or assertion) instead of `targetRef` alone, and returns the stream `head`. (SAT-10, XSUITE-17)
- **`applyTruthToSnapshot` escapes the compacted summary** it puts truth beside, and `escapeUntrusted` also escapes full-width and invisible-character look-alikes of the frozen markers. (SH-04)

**Benchmark** (`@shorthand/core/benchmark`)

- **Starter fixtures share one neutral template** (`STARTER_TEMPLATE`, the store's default wording) instead of templates that spelled out the expected answer. Offline (regex tier) runs now tie on every fixture instead of reporting wins. (SH-18)
- **`BenchmarkReport` gains `answerer` and `gate`**; `BenchmarkAggregate` gains `calibrationFailures` and `interpretFailures`; `FixtureResult` gains `interpretError`. A calibration fixture (`expectRawWins`) must now tie: an interpreted arm that loses it fails the gate too. (SH-18)
- **`LMJudge` takes `{ client, model, maxOutputTokens?, timeoutMs? }`** (was `{ interpreter, … }`) and makes its own grading call; it throws `ModelCallError` on a failed, truncated, refused or unparseable grade, or a score outside [0, 1], instead of returning 0 or clamping. (SH-19)
- **Live runs** (`npm run benchmark:live`) default to `claude-haiku-4-5` (was the retired `claude-3-5-haiku-latest`), use the host interpreter with no regex fallback, and stop when the answerer fails instead of echoing the injected text. The CLI exits 1 when a live interpretation fails, and with `--require-gate` when the gate is not met. (SH-19)

### Added

- **Compaction**: `CompactionEngine.correct({ from, to, sourceMessageId, key?, reason? })` — explicit corrections with content-derived tombstone ids; `revertCorrection(id)`; `retract(messageIds)`; `getSpan` / `pinSpan` / `unpinSpan` for the content-addressed code-span store (`state.spans`). `escapeUntrusted` and `renderContextFrame` (the single escaping frame renderer, which `WikiRenderer` also uses), `statesOnlySuperseded` / `isValidCorrectionSubject` (the shared supersession matcher), `applyTombstone` / `revertTombstone` / `retractMessages`, `renderTruthItems`. Types `CompactedEntry`, `CodeSpan`, `ArchivedItem`, `ArchiveReason`, `ContextSectionKind`, `ContextItem`, `CorrectionInput`; `Tombstone.id` / `confidence`, `Invariant.displacedBy`.
- **Snapshot compaction** (`DefaultCompactor`) with recall testing, pluggable invariant checks (`checkInvariants`, `VerificationHarness` `invariants` option), information-theoretic analysis and the `VerificationHarness`, for short-hand users.
- **Messages**: `ConversationMessage` optional `embedding`, `toolCall`, `supersedes` and `metadata`; `normalizeTimestamp`.
- **Active engrams and verification**: `ActiveEngramStore.select` (side-effect-free `retrieve`) and `markSurfaced`; `ReferenceGraph.getMaxWeightedScore`; `InvariantChecker.verify(state, { frame })`; `SourceIngester.versionOf`.
- **CRDT**: `LamportClock` (with `observe`), `compareLamport`, vector clocks, `RGA`, `MemoryMerge`, `ConflictDetector`; `CRDT_SCHEMA_VERSION`, `compareLWWEntries`, `isLWWTombstone`, `GSetOptions`; `AgentMemory.hasEntity` and `mergeLayersFrom` (`MemoryLayerChanges`); `ActiveEngram.origin`, `ActiveEngramStoreOptions.origin` / `generateId`, `ActiveEngramStore.deserialize(data, options)`, `EngramMergeOptions`, `EngramMergeReport`. [docs/crdt-format.md](./docs/crdt-format.md) specifies the wire format, merge rules and engram trust model, and fast-check property tests cover every CRDT (convergence, commutativity, associativity, idempotence, restore-and-continue).
- **Importance**: `EntityGraph`, `ReferenceGraph`, `TrajectoryTracker`, `RunningStats`, `cosineSimilarity`, `cosineDistance`.
- **Truth**: tombstoned-literal validation and lossless `x-steno` / unknown-key round-trip, `TruthAwareCompactor`, `applyTruthToSnapshot`, `truthToInvariantRecords`, `proposeInvariants`, `appendProposalsFile`. The truth format v2 reader and writer: `decodeTruthLine`, `checkTruthChain`, `truthLineHash`, `canonicalizeJcs` (RFC 8785, zero-dependency), `TruthLineError`, `parseWikiFiles` (multi-file merge on the status lattice), `truthStatusTable`, `TruthReadOptions` (`signers`, `admitV1Tbs`, `previous`), `WikiParseResult.transitions` / `lines` / `head` / `conflicts` / `refused`, `TruthEntrySource`, `TruthInadmissible`, `TruthTransition`; identities (`identityKey`, `identityIssue`, `isReservedIdentity`, `hasControlCharacters`, `createSignerRegistry`); proposals (`ProposalStream`, `parseProposalLines` with read-only bare-format compatibility, `proposalDedupeKey`, `proposalDraftIssue`, `COMPACTION_DETECTOR`, `WrittenProposalLine`).
- **Truth-format conformance**: stenographer's golden fixtures are copied to `test/fixtures/truth-format/` (with their source commit and hashes in `SOURCE`) by `npm run sync:truth-fixtures -- <stenographer checkout>`, and `src/truth/conformance.test.ts` checks every fixture's expected outcome, the spec's worked hash example, and that the zero-dependency codec never accepts a line the JSON Schema refuses (property test against `ajv`, a dev dependency). (XSUITE-19)
- **Benchmark**: `evaluateGate` / `GateOptions` / `DEFAULT_MIN_DECIDED` (the gate: an interpreting tier, a downstream answerer, no failed interpretations, tied calibration fixtures, at least 30 decided fixtures, a Wilson 95% lower bound above 0.5); `createLiveBenchmark`, `createAnthropicAnswerer`, `DEFAULT_LIVE_MODEL`, `LIVE_INTERPRET_OPTIONS`; `ModelCallError` and `callModelText`; `STARTER_TEMPLATE`; the CLI's `--require-gate`. `AnthropicMessageRequest` gains optional `output_config` (structured output; `HostInterpreter` never sets it).
- **Release checks**: CI on Node 22 and 24, and `npm run smoke:pack` — packs the tarball, checks its file list (no tests, every `exports` target and source-map source present, zero runtime dependencies), installs it into an empty project, imports every subpath export at runtime, and typechecks a consumer plus every name the README imports under `moduleResolution` Node16 and Bundler with `skipLibCheck` off. The tarball ships `src` (without tests) so its source and declaration maps resolve, and `npm run build` cleans `dist` first.

### Fixed

- Corrections reach L3 and L4: a corrected requirement no longer stays in every frame as an `[invariant]`, and `InvariantChecker` no longer reports correction propagation as passed when it did not happen. (SH-01)
- "Change it to blue" no longer deletes every compacted message containing "it". (SH-02)
- A struck or overridden TB no longer stays in every frame as ground truth: the wiki stream now says so with a TRANSITION line, and the reader folds it. (SH-03, SAT-08)
- Ledger, tool or message text can no longer forge a `[TB]` line in a frame, and a tool output or message quoted in a compacted snapshot can no longer pass for a `[TB]` line or the truth heading. (SH-04)
- Concurrent `addMessage` calls no longer lose messages (state changes are serialized). (SH-05)
- A large truth section, invariant set or graph no longer vanishes from the frame whole, and an oversized L1 entry no longer blocks smaller ones. (SH-14)
- "await" and "Factually" are no longer correction keywords; rejection-only decisions are titled `Rejected: <option>`. (SH-16)
- Truncated interpreter output is never returned as a memory. (SH-17)
- The offline benchmark no longer passes its gate by construction: an interpreter that ignored payload and context won every starter fixture (Wilson 95% lower bound 0.566), because each template spelled out its expected answer. The offline run is now reported as a wiring smoke test, and the README shows the measured output, token counts included. (SH-18)
- `npm run benchmark:live` no longer produces a report labelled `host` in which every interpretation fell back to the regex tier, every failed answer echoed the injected text and every failed grade scored 0, and the judge no longer runs under the interpreter's one-sentence system prompt while asking for JSON. (SH-19)
- Repeated `recompact()` calls no longer grow L2 and the edge list. (SH-20)
- Linear-time extraction and chunking: a 256 KB unterminated message, a 64 KB tool output scored for importance, and a 200 KB unpunctuated paragraph (or minified JSON) no longer block the event loop for seconds; `chunkSize` is enforced and trailing text without a terminator is kept. (SH-13, SH-21, SAT-13)
- Frames no longer exceed their token budget. (SH-22)
- Wiki pages built from ingested or conversational text no longer overwrite each other (`C++`/`C#`, non-Latin names) or render attacker-controlled HTML or `javascript:` links. (SH-24)
- The README's API reference no longer has a duplicated, syntactically broken `CompactionEngine` block or duplicated tier and utility sections, the `#compactor-tiers` links resolve, install instructions name `@shorthand/core`, importance scoring is no longer described as driving compaction, and stale weights, model ids and Node 18 references are gone. (SH-26)
- Importance scoring no longer sorts every reference score, or scans every edge, per message, so scoring a conversation is no longer quadratic in its length. (SH-29)
- OR-Set removes propagate through merges (tombstoned tags travel with the state), and a replica restored with `ORSet.from` never reissues a used tag. (SAT-03, SH-10)
- LWW-Register replicas converge on concurrent writes with equal counters (tie broken by agent id); `AgentMemory` no longer stamps writes from one process-global counter. (SH-09)
- G-Set entries without a `dedupeKey` from different replicas no longer overwrite each other on merge, and two replicas holding equal-length summaries for one topic converge. (SAT-04)
- RGA replicas converge on concurrent inserts at the head of the sequence (the first append of every fresh log): another agent's message is no longer interleaved between a message and its reply. (SAT-02)
- A restored LWW-Register, OR-Set, G-Set or RGA continues from its saved clock, so its new writes are ordered after the ones it saved and no tag or id is reissued. (SH-09, SH-10, SAT-05)
- A sequential update of an invariant is no longer flagged as a `critical` conflict. (SAT-06)
- Open UVs contesting a TB the ledger has not (yet) marked contested are no longer dropped: the TB is carried as contested with them, or, when the TB is not current truth, they render standalone with `contests <id>`. Unsigned TBs no longer render as ground truth `signed: <author>`. (SAT-07, SAT-31)
- A corrected value is proposed again instead of being blocked forever by its targetRef, and the compactor no longer proposes `postgres is postgres.` (SAT-10)
- `applyTruthToSnapshot` strips only the truth section it appended, instead of truncating the summary at the first quoted `## Asserted Truth (ledger)`. (SAT-11)
- A corrected engram no longer resurfaces with its stale text in contexts the correction's topics do not match, and the README example now retrieves. (SH-11)
- A peer's engram state can no longer set an arbitrary or NaN importance, a negative retrieval count, rewrite or shadow another agent's memory, or bring back a removed engram; `get()` results can no longer be mutated to change the store. (SH-12)
- Rehydrating or merging a long RGA log is linear (50k nodes: about 57 s before, well under a second now), and `MemoryMerge` tracks changed layers from the merge results instead of stringifying every layer twice per remote. (SAT-30)
- `LocalInterpreter`'s error without a global `fetch` names the supported runtime (Node ≥22) instead of Node ≥18.
