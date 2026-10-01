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

- **Unknown statuses are no longer coerced.** A TB whose status is not `active`/`contested`/`overridden`/`struck` used to become `active`, and an unknown UV status became `open`. Both are now kept verbatim and classified as `history`: never ground truth, never a flag. `TruthTbEntry.status` and `TruthUvEntry.status` are typed `TbStatus | UnknownStatus | null` / `UvStatus | UnknownStatus | null` accordingly.
- **A line without a status is history** (`status: null`), not `active`/`open`. A TB without a claim or a UV without an assertion is refused into `WikiParseResult.errors`.
- `TbStatus` and `UvStatus` add `struck`.
- Top-level keys the codec does not interpret (the v2 `schemaVersion`, `seq`, `prevHash`, `hash`, or another tool's `x-*` namespace) are preserved in `entry.extra`, and an entry read from a stream is written back as the exact line it was read from.
- An unsigned TB (the migration backfill) is never truth on its own; it used to be rendered as ground truth labelled `signed: <author>`.
- An open UV that contests a TB is attached to that TB whatever the TB's recorded status: a current TB with an open contest is carried as contested. A UV contesting a TB that is not current truth is rendered standalone with `contests <id>`. Both used to drop the UV.
- The truth format is stenographer's v2 (hash-chained streams, TRANSITION lines); see [Everyone: truth format v2](#everyone-truth-format-v2) for what that changes.
- PROPOSAL lines use the suite's single envelope, hash-chained: they gain `schemaVersion: 2`, `seq`, `prevHash` and `hash`, `signal.source` is `'compaction-candidate'` (was `'shorthand-compaction'`), and `targetRef` is always present (`string | null`). There is no top-level `provenance` field.

New in the truth module: `renderTruthLines` (the section without its heading), `TRUTH_SECTION_HEADING`, `TRUTH_SOURCE_PREFIX`, `groundTruthToInvariant`, `displaceStaleInvariants`, and the LSM proposal export (`invariantsToProposalDrafts`, `tombstonesToProposalDrafts`, `exportProposalDrafts`, `uvProposal`, `tbProposal`).

### CRDT

The API is the vendored one. Wire-format and behavior changes:

- **OR-Set removes propagate.** `ORSetState` gains `removed` (tombstoned tags). A remove used to delete locally only, so the element came back on the next merge with any replica that had seen it. States without `removed` still load. `ORSet.from` advances the tag clock past every tag in the state, so a restored replica never reissues a tag.
- **G-Set entries without a `dedupeKey` get a replica-scoped id** (`__id:<replicaId>:<counter>`) instead of a per-replica counter (`__auto_<n>`), so keyless entries from different agents no longer overwrite each other on merge. Entries in old serialized states keep the `__auto_<n>` key they were stamped with. See [CRDT convergence](#everyone-crdt-convergence-and-the-v1-wire-format) for the rest of the G-Set changes.
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

The serialized formats changed (Lamport timestamps are `{ counter, agentId }`, OR-Set state is `{ elements, removed }`, G-Set state is `{ entries }`), so 0.1 `AgentMemory` snapshots do not load in 1.0. `memory.activeEngrams` keeps the `ActiveEngramStore` API, with the replication changes listed under [CRDT convergence](#everyone-crdt-convergence-and-the-v1-wire-format).

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
- Proposals use the suite's PROPOSAL envelope: each line carries `schemaVersion: 2`, `seq`, a ULID `id`, `type: 'PROPOSAL'`, `ts`, an accountable `author` (generic identities throw), `kind` (`'tombstone'` → `'tb'`), `draft`, `targetRef`, `signal`, `agentSessionId`, `prevHash` and `hash`. The top-level `provenance` field is gone (the source message is in the draft's evidence or `verifyBy`).
- The 0.1 truth reader took any JSONL line as truth; 1.0 reads stenographer's truth format v2 — see [Everyone: truth format v2](#everyone-truth-format-v2).
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

## Everyone: truth format v2

`@shorthand/core/truth` reads stenographer's truth format v2 (`spec/truth-format` in the stenographer repo; the golden fixtures are copied to `test/fixtures/truth-format/` and run in this repo's tests). Stenographer 1.0 exports it; 0.x exports (version 1 lines) are still read.

### Reading

- **A stream is hash-chained and refused whole when it doesn't verify.** Every v2 line carries `seq`, `prevHash` and `hash` (SHA-256 of its RFC 8785 JCS form without `hash`). `parseWikiLines` refuses a line whose hash doesn't match, an identity it must refuse, or a broken chain (a missing, repeated, reordered or foreign line), and then refuses the whole stream: `result.refused` is true and `entries` is empty, so a dropped TRANSITION can never revive a struck TB. `engine.syncTruthLedger` then syncs no truth at all and reports why (`result.refused`, `result.errors`). A version 1 file keeps its per-line tolerance (it has no chain); a v1 line inside a v2 stream refuses the stream.
- **Status is a fold, not "last line wins".** In a v2 stream an entry line is written once, and each status change is an appended `TRANSITION` line. An entry's `status` is the status of the highest-seq TRANSITION targeting it, else the line's own; `entry.source.lineStatus` keeps what the line says and `entry.source.transition` names the TRANSITION that moved it. Struck entries (`struck`, TB or UV) are never current truth. Version 1 files are still read last-line-wins.
- **What a reader does not take as truth, whatever the status** (`entry.inadmissible`, classified `history`):
  - an unsigned TB (`signedBy: null`, the backfill's TB) — `reason: 'unsigned'`;
  - a version 1 TB — `reason: 'unverifiable'`: it carries no hash. Stenographer itself files them for a person to sign. **To keep reading a 0.x export's TBs as truth, pass `{ admitV1Tbs: true }`** to `parseWikiLines` / `readWikiFile` / `engine.syncTruthLedger`, or export a v2 stream from stenographer 1.0. Version 1 UVs are still read;
  - with `{ signers }` (stenographer's `signers.json` shape), a TB whose author or signer, or a UV whose author, the registry doesn't list — `reason: 'unverifiable'`;
  - an id two lines (or two files) give different content — `reason: 'conflict'`.
- **Identities** are refused when anonymous or generic, when they contain a control character, or when reserved where they don't belong (`migration` only on an unsigned TB, `detector:*` only on PROPOSAL lines). They compare by key — NFKC, invisible code points removed, trimmed, lowercased — so `ａｓｓｉｓｔａｎｔ` and `Sys\u200Btem` are refused too. `isAnonymousIdentity` and `assertAccountableAuthor` moved to `identity.ts` (still exported from `@shorthand/core/truth`) and use the key; `assertAccountableAuthor` now also refuses control characters and `migration`, and accepts `detector:<name>`.
- **Version 1 lines are validated as stenographer 0.x wrote them**: a TB needs a claim and at least one piece of evidence with a known kind, a UV needs an author, assertion, basis and `verifyBy`. Error messages name the field (`'claim: must be a non-empty string'`, `'a line is a JSON object'`, `'type: a version 1 line is a TB or UV …'`) instead of `'TB entry missing claim'` / `'entry is not an object'` / `'unsupported entry type'`. v1 `command` evidence reads as `claimed-command` in the typed entry (the line itself is not rewritten).
- **Several files** (one per teammate): `parseWikiFiles([{ name, text }, …])` folds each on its own and takes the most advanced status per entry (TB `active < contested < overridden < struck`, UV `open < verified < refuted < struck`); a refused file refuses the merge.
- **Incremental reads**: keep `result.head` and pass it back as `{ previous }`: the next read must continue it (stenographer's `sinceSeq` export) or still hold it (a re-read of the whole file), which catches lines removed from the end.
- **Never rewritten**: `serializeWikiEntries` / `entryToWikiLine` give back the exact line an entry was read from — even when the fold moved its `status`. To write a whole stream back (TRANSITION lines included), use `result.lines` or `writeWikiFile(path, result)`. Entries you build by hand are still written in the version 1 shape.
- `wikiLineToEntry(line, options?)` validates the line with the v2/v1 codec and throws `TruthLineError` on a line a reader must refuse.
- `TruthSyncResult` gains `refused`; error entries may carry `id` and `file`.

### Writing proposals

- **A proposals file is one writer's hash-chained stream.** `serializeProposals(proposals, { head? })` and `exportProposalDrafts(state, { author, head? })` return chained lines (seq 1…, or continuing `head`). `appendProposalsFile` continues the file's own stream in one write and returns `{ written, skipped, head }`. It **refuses a file that isn't one valid proposals stream** — including a pre-1.0 file of bare lines — and leaves it untouched: start a new proposals file.
- **Dedupe is by (kind, targetRef, normalized claim or assertion)**, not `targetRef` alone, so a corrected value (`LOG_BUDGET is 60.`) is proposed even when an earlier value for the same target was (SAT-10). `proposeInvariants` no longer proposes tautologies (`postgres is postgres.`).
- The envelope is exactly the spec's: no top-level `provenance`, and a `tb` draft is `{ claim, evidence, literals? }` (`signedBy: null` is gone from `TbProposalDraft`; nothing short-hand drafts is signed). `ProposalSpec` lost `sourceMessageId`. Builders throw on an incomplete draft.
- `parseProposalLines` reads proposals files: suite envelope lines (chained and hash-checked) and, read-only, the bare pre-1.0 line and the `shorthand-compaction` source (`kind: 'tombstone'` reads as `'tb'`).

### Rendering

- `applyTruthToSnapshot` (and `TruthAwareCompactor`) escape the compacted summary they put truth beside, so a message or tool output that reproduces `- [TB] … (signed: cto)` or `## Asserted Truth (ledger)` renders as `- \[TB] …` / `\## Asserted Truth …` (SH-04).
- `escapeUntrusted` is idempotent (an already-escaped `\[TB]` is left alone) and also escapes look-alikes: full-width `［ＴＢ］` and markers with invisible code points before the letters.
- `WikiRenderer` escapes every name and text it renders (`\[`, `\]`, `&lt;`, `&gt;`; a line-start `#` in multi-line text; the frozen markers), so ingested text can't become a link, an image, raw HTML or a heading (SH-24). Page paths are Unicode-aware slugs (`entities/日本語.md`); names that slug alike (`C++` and `C#`, or two summaries of one topic) get a short hash suffix (`entities/c-1a2b3c4d.md`) instead of overwriting each other; links are relative to the page they are on (`../topics/x.md` from an entity page). Paths of names that collided, and links, change.

## Everyone: CRDT convergence and the v1 wire format

The CRDT layer now converges under concurrent writes (property-tested; see [docs/crdt-format.md](./docs/crdt-format.md) for the exact guarantees and their preconditions). That changed some behavior and the serialized format.

### Wire format

- Every state carries `schemaVersion: 1` and `clock` (the replica's Lamport counter); `from` restores the clock. LWW states also carry `vc` (observed vector clock), and each LWW entry carries the writer's `vc`; a tombstone is `{ timestamp, deleted: true }` without a value. States without `schemaVersion` still load; a state with another version is rejected.
- `merge` validates the whole state first and throws `TypeError` on anything malformed (non-integer or negative counters, wrong types, a newer version), without changing the replica. Code that merged hand-built states must make them well formed: G-Set entries need `dedupeKey`, RGA nodes need `timestamp` equal to `id`, `deleted` booleans, and parents that exist.
- Serialized collections are sorted (keys, tags, tombstones, entries by key, engrams by id). Do not depend on insertion order in `serialize()`, `value()` or `keys()`.

### Restart a replica from its saved state

Every live replica needs its own agent id. A process that restarts must restore before it writes, or its new writes reuse old ids:

```diff
- const memory = new AgentMemory('coder');
+ const memory = saved ? AgentMemory.from(saved) : new AgentMemory('coder');
```

An RGA merge now throws `TypeError: … differs between replicas: two writers share replica id "coder"` when that happens, instead of leaving replicas diverged.

### API changes

| Before | 1.0 |
|---|---|
| `lww.has(key)` true for a deleted key | false; `keys()` still lists tombstoned keys |
| `lww.set(key, undefined)` wrote a tombstone-like entry | throws; use `delete(key)` |
| `LWWEntry.value: V` | `value?: V` (absent on tombstones) plus `deleted?: true` and `vc?` |
| `new GSet(mergeFn)` | still accepted; also `new GSet({ replicaId, mergeFn })` |
| `gset.add(entry)` → `void`; keyless entries with equal values collapsed | → the entry's key; each keyless add is its own entry (`__id:<replicaId>:<counter>`) |
| `defaultMergeFn` kept the local entry on an equal-length tie | keeps the entry whose canonical JSON sorts last (same on every replica) |
| `rga.insertAfter(value, unknownId)` appended at the end | throws `RangeError` |
| `ConflictDetector` flagged every differing L4 value as `critical` | flags only concurrent writes; sequential updates are not conflicts |
| `store.get(id)` / `store.all()` returned live objects | frozen copies (`Readonly<ActiveEngram>`); use `setImportance` to change a score |
| `store.mergeFrom(state)` → `void` | `mergeFrom(state, { from? })` → `{ added, removed, rejected }` |
| `store.remove(id)` deleted locally only | also records a tombstone, so merges never bring the engram back |
| `retrievalCount` converged on the max across replicas | per replica: a merged engram starts at 0 |
| `MemoryMerge` `layerChanges` | gains `engrams` |

### Active engram corrections

- `shadowsEngramId` now hides the corrected engram everywhere: the correction speaks in its slot whenever either would have surfaced, and the corrected text never surfaces while an unexpired correction exists (it used to surface wherever the correction's own topics did not match). If an async correction fails to interpret, the slot is dropped.
- A correction applies only between engrams of the same `origin`. Engrams created by a store get its `origin` (`AgentMemory` uses its agent id; a standalone store uses `'local'` unless you pass `{ origin }`). To correct another agent's memory, `remove` it and `add` your own.
- `add` and `setImportance` throw `TypeError` on a non-finite score (finite scores are still clamped to [0, 1]). Engram ids are `crypto.randomUUID()` unless you pass `generateId`.

