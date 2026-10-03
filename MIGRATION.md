# Migrating to @shorthand/core 1.0

1.0 merges the two codebases that shared the `@shorthand/core` identity into this repository:

- **short-hand** (this repo, published nowhere yet, package name `short-hand`): the LSM compaction engine, active engrams, interpreters, ingestion, wiki rendering and benchmark.
- **smallchat's vendored copy** (`smallchat/shorthand`, package name `@shorthand/core`, installed through `file:./shorthand`): the snapshot compactor and its verification harness, the clock/RGA/conflict-detector CRDT layer, the modular importance detector and the truth codec.

Where the two had the same concept with different APIs, 1.0 keeps one. This guide lists every rename and behavior change, grouped by where you are coming from. The sections headed **Everyone** apply whichever codebase you come from; read [Everyone: package and runtime](#everyone-package-and-runtime) first.

## Everyone: package and runtime

- **Node.js 22 or later.** `engines.node` is `>=22` (it was `>=18` in short-hand 0.1). Node 18 and 20 are end-of-life; CI runs on 22 and 24. `LocalInterpreter` still needs a global `fetch` (or an injected one).
- **Install** `npm i @shorthand/core` (`^1.0.0`).
- **ESM-only**, as before: `import`, not `require`. There is no CommonJS build.
- **Import from the package root or one of its subpaths** — `@shorthand/core`, `/compaction`, `/crdt`, `/importance`, `/truth`, `/wiki`, `/ingestion`, `/interpreter`, `/verification`, `/benchmark`. `exports` blocks every other path (`@shorthand/core/dist/...` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`). TypeScript needs `moduleResolution` `node16`, `nodenext` or `bundler` to resolve the subpaths; the release's smoke test typechecks a consumer under Node16 and Bundler.
- The declarations need no Node types: a bundler project with the DOM lib and no `@types/node` typechecks.

## Coming from smallchat's vendored copy

Import paths are unchanged: `@shorthand/core`, `@shorthand/core/compaction`, `/crdt`, `/importance` and `/truth` resolve every value and type smallchat re-exports today, and smallchat's current re-export blocks compile unchanged under `moduleResolution: Node16` (this repo's tests and pack smoke test typecheck exact copies of them). **Compiling is not the same as meaning the same:** five of the compaction type names in those blocks — `CompactedState`, `CompactionLevel`, `Compactor`, `Decision` and `VerificationResult` (re-exported as `CompactionVerificationResult`) — now name the LSM pipeline's types, so they no longer match the `DefaultCompactor` and `VerificationHarness` values re-exported beside them. Rename them as [below](#compaction-snapshot-types-were-renamed). Replace the dependency:

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

The API is unchanged. The state-delta signal now reads at most 16 KB of prose per message, in sentence windows (see [LSM compaction](#lsm-compaction)), and scoring is no longer quadratic in conversation length.

### Messages

`ConversationMessage` is the same superset plus an optional `metadata` record. `normalizeTimestamp` is exported from the root and `@shorthand/core/compaction`.

## Coming from short-hand 0.1 (`short-hand`)

### Package

- Install `@shorthand/core` instead of `short-hand` and change imports from `'short-hand'` to `'@shorthand/core'`.
- The context-shift benchmark is no longer exported from the root. Import `ContextShiftBenchmark`, `echoAnswerer`, `wilson95`, `KeywordJudge`, `LMJudge`, `STARTER_FIXTURES` and their types from `@shorthand/core/benchmark`. See [Benchmark](#benchmark) for what changed in it.
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
| `gset.values()` → `T[]` | `gset.value()` → `GSetEntry<V>[]` (read `entry.value`) |
| `gset.has(value)` | removed: `gset.getByKey(dedupeKey)`, or `gset.value().some((e) => …)` |
| `AgentMemory.invariants` / `.entities` / `.summaries` | `.l4` / `.l3Nodes` + `.l3Edges` / `.l2`, plus `.l1` and `.l0` RGA logs |
| `memory.addEntity(entity: Entity)` | `memory.addEntity({ id, type, name, properties? })` (`L3Entity`) |
| `memory.addSummary(summary: TopicSummary)` | `memory.addSummary(topic, content, isDirectParticipant)` |
| `memory.getEntities()` → `Entity[]` | `memory.getEntities()` → `Set<L3Entity>`: no `.length`, `.map` or indexing (`[...memory.getEntities()]`, `.size`) |
| `memory.getSummaries()` → `TopicSummary[]` | `memory.getSummaries()` → `GSetEntry<L2Summary>[]`: `s.topic` is now `s.value.topic` (and `s.value.content`) |
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

### Benchmark

The 0.1 benchmark's numbers measured its fixtures, not interpretation (SH-18), and its live mode hid failures (SH-19). Results from 0.1 are not comparable with 1.0 runs.

- **Starter fixtures** all use one neutral template (`STARTER_TEMPLATE`, `Earlier note, still relevant: {{payload}}`). The 0.1 templates spelled out each expected answer. The offline run now ties on every fixture (`wins=0 ties=6`) where 0.1 printed `winRate=1.000`; that is the correct result for the regex tier. If you copied the starter fixtures into your own suite, rewrite their templates the same way: a template is written before the read context exists.
- **The gate is `report.gate`** (`{ passed, reasons }`, from `evaluateGate`), not a Wilson bound you check yourself. It requires an interpreting tier (not `regex`), a downstream answerer (not `echoAnswerer`), no failed interpretations, tied calibration fixtures, at least 30 decided fixtures (`GateOptions.minDecided`) and a Wilson 95% lower bound above 0.5. The starter set never passes it. Code that asserted `report.aggregate.wilson95[0] > 0.5` on the offline run should drop the assertion; it only ever measured the templates.
- **Calibration fixtures must tie.** An `expectRawWins` fixture used to pass whenever raw won or tied; an interpreted arm that loses it (the interpretation dropped the fact) now fails the gate, like one that wins it.
- **Interpretation failures are recorded.** A fixture whose interpretation throws gets `interpretError`, `aggregate.interpretFailures` counts it, and the gate fails; the arm still injects the raw payload. Don't wrap the interpreter in `withFallback` for a benchmark: a fallback inside it is invisible to the report.
- **`LMJudge`** takes a client, not an interpreter:

  ```diff
  - new LMJudge({ interpreter: hostInterpreter })
  + new LMJudge({ client: anthropicClient, model: 'claude-haiku-4-5' })
  ```

  It grades with its own system prompt and a JSON schema (`output_config`), and throws `ModelCallError` where it used to return 0 (failed call, unparseable grade) or clamp (score outside [0, 1]).
- **Live runs**: `npm run benchmark:live` defaults to `claude-haiku-4-5` (`DEFAULT_LIVE_MODEL`; 0.1 defaulted to the retired `claude-3-5-haiku-latest`), and `SHORTHAND_BENCHMARK_MODEL` still overrides it. There is no regex fallback, the answerer is its own call (`createAnthropicAnswerer`) and its failures stop the run instead of echoing the injected text. `createLiveBenchmark({ client, model })` builds the same wiring in code; pass `{ interpretOpts: LIVE_INTERPRET_OPTIONS }` to `run`.
- **CLI exit codes**: a live run exits 1 when any interpretation failed; `--require-gate` exits 1 unless the gate passed. The output adds an answerer column, failed-interpretation and calibration markers, and the gate with its reasons; `--out` JSON adds `mode` (and `model` for live runs), `answerer`, `gate`, `aggregate.calibrationFailures` and `aggregate.interpretFailures`.

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
- Untrusted text (messages, tool output, ledger fields, engrams) is escaped: `[TB…` / `[UV…` anywhere, section markers at a line start and a reproduced `## Asserted Truth` heading get a leading `\`. Markers are matched as a model reads them — any case (`[tb]`), width (`[ＴB]`), a bracket whose NFKC form is `[` (`［`, `﹇`), Cyrillic, Greek and other homoglyph letters (`[ТВ]`), invisible code points or combining marks anywhere in the marker, and a line start behind indentation, `>`/list marks, non-breaking spaces or invisible code points — so more text gets a `\` than before. Use `renderContextFrame(frame)` (or join `section.content`) — the content is already escaped.
- Active engrams: a frame counts a retrieval (`maxRetrievals`) only for memories it includes. The default interpreter template is now `Earlier note, still relevant: {{payload}}` (it used to paste the recent conversation into every memory); pass `interpreterTemplate` to keep the old one. `ActiveEngramStore.select` / `markSurfaced` split `retrieve` into its pure and counting halves.

### LSM compaction

- **L1 is verbatim.** `RegexCompactor` no longer strips "I think", "maybe", "probably", "just" and similar words, no longer replaces code blocks with `[code block]`, and no longer drops messages under 5 characters (only pure acknowledgements and greetings are dropped; "8080", "v2" are kept, and a short reply to the other role's question is folded in as `question → answer`). Expect longer L1 text.
- `CompactedState.l1_compacted` entries are `CompactedEntry` (adds optional `timestamp`, `role`, `spanIds`, `foldedMessageIds`). `CompactedState` gains optional `archive` (`ArchivedItem[]`) and `spans` (code spans keyed by sha256). States you build by hand need neither.
- **Corrections archive instead of delete, at every level.** A tombstone now also displaces L4 invariants (archived with `displacedBy`) and L3 entities and their edges, not just L1/L2. Items go to `state.archive` with `by: <tombstone id>`; `engine.revertCorrection(id)` restores them — except what another correction still present supersedes too (recorded as `alsoBy` on the archived item or `Decision`), which stays archived under that correction.
- **Extraction keeps dotted values whole.** Decision, correction, entity and constraint captures end at sentence punctuation followed by whitespace (or the end of the sentence), not at the first `.`: `Python 3.12`, `10.0.0.5`, `Node 22.4.1` and `config.prod.yaml` are captured whole, so L2 topics, L4 invariant keys and inferred tombstones change for such text.
- **Supersession matching treats a dotted value as one token** (`20` no longer matches inside `20.11`, nor `10.0.0` inside `10.0.0.5`), and a text that mentions the old value is stale unless it names the new value *outside* those mentions — so a correction to a sub-phrase of the old value (`v2.1.0-beta` → `v2.1.0`, `postgres 15` → `postgres`) now archives the old statements instead of nothing.
- `engine.correct()` takes its before/after cutoff when it is called: a message added right after it, before the queued correction runs, counts as after the correction and is not archived.
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
- `IngestionEvent` gains `version`, `retractedChunks` and `skipped`; `entitiesDiscovered` lists only the entities this ingestion added. Re-ingesting an unchanged source is a no-op (`skipped: true`, not logged); re-ingesting a changed one retracts the previous version's chunks first (`engine.retract`). Ingests of one source id run one at a time in call order, so overlapping calls (a file watcher firing twice) retract each other's versions; different sources still run concurrently.
- Every chunk is now at most `chunkSize` tokens (oversized paragraphs are split by sentence, then whitespace, then hard cuts), and trailing text without a sentence terminator is kept.

### Interpreters

`HostInterpreter` throws `InterpreterBudgetError('output_too_long')` when the response's `stop_reason` is `max_tokens` or `model_context_window_exceeded`, and `InterpreterUnavailableError` on `refusal`; `LocalInterpreter` throws `InterpreterBudgetError` on Ollama's `done_reason: 'length'`. `withFallback` routes both. Stubs that return truncated text with those stop reasons now fail.

## Everyone: truth format v2

`@shorthand/core/truth` reads stenographer's truth format v2 (`spec/truth-format` in the stenographer repo; the golden fixtures are copied to `test/fixtures/truth-format/` and run in this repo's tests). Stenographer 1.0 exports it; 0.x exports (version 1 lines) are still read.

### Reading

- **A stream is hash-chained and refused whole when it doesn't verify.** Every v2 line carries `seq`, `prevHash` and `hash` (SHA-256 of its RFC 8785 JCS form without `hash`). `parseWikiLines` refuses a line whose hash doesn't match, an identity it must refuse, or a broken chain (a missing, repeated, reordered or foreign line), and then refuses the whole stream: `result.refused` is true and `entries` is empty, so a dropped TRANSITION can never revive a struck TB. `engine.syncTruthLedger` then syncs no truth at all and reports why (`result.refused`, `result.errors`). A version 1 file keeps its per-line tolerance (it has no chain); a v1 line inside a v2 stream refuses the stream.
- **Status is a fold, not "last line wins".** In a v2 stream an entry line is written once, and each status change is an appended `TRANSITION` line. An entry's `status` is the status of the highest-seq TRANSITION targeting it that the reader honours, else the line's own; `entry.source.lineStatus` keeps what the line says and `entry.source.transition` names the TRANSITION that moved it. Struck entries (`struck`, TB or UV) are never current truth. Version 1 files are still read last-line-wins.
- **What a TRANSITION may do.** Overridden and struck TBs, and verified, refuted and struck UVs, are final: a later TRANSITION may only move them up the lattice (overridden → struck), never back to `active`, `contested` or `open`. With `{ signers }`, a TRANSITION whose author the registry doesn't list is not applied. Both are reported in `result.held` (`{ line, id, reason }`) and change nothing. A TRANSITION whose `cause.ref` is not null and not an earlier line of the stream refuses the stream, as in stenographer's import.
- **What a reader does not take as truth, whatever the status** (`entry.inadmissible`, classified `history`):
  - an unsigned TB (`signedBy: null`, the backfill's TB) — `reason: 'unsigned'`;
  - a version 1 TB — `reason: 'unverifiable'`: it carries no hash. Stenographer itself files them for a person to sign. **To keep reading a 0.x export's TBs as truth, pass `{ admitV1Tbs: true }`** to `parseWikiLines` / `readWikiFile` / `engine.syncTruthLedger`, or export a v2 stream from stenographer 1.0. Version 1 UVs are still read;
  - with `{ signers }` (stenographer's `signers.json` shape), a TB whose author or signer, or a UV whose author, the registry doesn't list — `reason: 'unverifiable'`;
  - a TB an agent signed without a `quorum` whose members are all agents — `reason: 'agent-without-quorum'` (see the next item). This holds for a version 1 TB read with `{ admitV1Tbs: true }` too: a version 1 line carries no quorum, and stenographer files such a TB for a person to sign;
  - a TB an agent signed that cites an evidence kind this version doesn't know, on its line or in its quorum — `reason: 'unknown-value'`. The quorum rules don't refuse a line over such a kind (it may be a newer writer's settling kind), so this reader can't tell that the members agree from different angles, and fails closed, as stenographer's import does. A person's TB may cite any kind. Code that switches over `inadmissible.reason` needs both new cases;
  - an id two lines (or two files) give different content — `reason: 'conflict'`. Content is the entry's fields compared as JCS, unknown fields included (as stenographer's import compares them), and neither the chain fields (`schemaVersion`, `seq`, `prevHash`, `hash`) nor `x-steno`: so one entry in two writers' streams is not a conflict, while two copies that differ only in a field a newer writer added are.
- **Agents settle claims only together** (stenographer's spec, "Agent quorum"). One agent's signature makes nothing truth: a TB an agent signs is truth only when its line carries a `quorum`, the two or more agent sessions that agreed from different angles within 15 minutes, every member is an agent, and it cites only evidence kinds this version knows (`'unknown-value'` above). With `{ signers }`, an agent is an identity the registry lists with role `agent` (its role decides, not its name); without a registry, an identity whose key starts with `agent:`. `decodeTruthLine` refuses a line whose `quorum` breaks the spec's rules 1–6, a `quorum` on any line but a version 2 TB or ADDENDUM, and a version 1 line carrying one, so a stream holding such a line is refused whole. The typed entry carries the members as `TruthTbEntry.quorum`; an entry you build by hand can't carry one to a line (see "Never rewritten" below). For a line that carries a `quorum`, `checkQuorum(line)` returns the rules it breaks (empty when it keeps them all; call it only on such a line, since on any other it reports that the quorum is missing or misplaced). `evidenceClass(kind)` says whether a kind can settle a claim (`commit`, `file`, `test`, `claimed-command`, `wiki`) or is question-class (`message`, `chat`, `ticket`, `doc`, pre-1.0 `command`, and any kind this version doesn't know). A version 1 entry's typed evidence reads `command` as `claimed-command` (below), so classify such an entry by the kinds in its line (`entry.source.text`). The classes bind agents only: a person may sign on evidence of any class. A reader otherwise relies on the writer for who may change a status, so a TRANSITION is folded whoever caused it, as before.
- **`CONSUMPTION_RULES` says how an agent settles a UV now**, in stenographer 1.0's words: "If your current task can check the UV, file your verdict and evidence with resolve_uv: it settles only when another agent session agrees from a different angle (other evidence, another kind) within 15 minutes, or when a person rules." It used to tell an agent to settle the UV itself. Update any prompt or snapshot that embeds the old text.
- **Evidence kinds `chat`, `ticket` and `doc` are known** (a chat message or thread, an issue or ticket, a document outside the truth ledger), so version 1 lines may cite them too. `wiki` evidence names an entry in a truth ledger; a team wiki page is a `doc`.
- **A signer registry may list `keys`** on an entry (`[{ alg, id, publicKey }]`, reserved for key signing in 1.x). This version accepts and ignores them, so a registry that lists keys reads unchanged.
- **Identities** are refused when anonymous or generic, when they contain a control character, or when reserved where they don't belong (`migration` only on an unsigned TB, `detector:*` only on PROPOSAL lines; a TRANSITION, which carries its cause's author, never by either). They compare by key — NFKC, invisible code points removed, trimmed, lowercased — so `ａｓｓｉｓｔａｎｔ` and `Sys\u200Btem` are refused too. `isAnonymousIdentity` and `assertAccountableAuthor` moved to `identity.ts` (still exported from `@shorthand/core/truth`) and use the key; `assertAccountableAuthor` now also refuses control characters and `migration`, and accepts `detector:<name>`.
- **Version 1 lines are validated as stenographer 0.x wrote them**: a TB needs a claim and at least one piece of evidence with a kind this version knows, a UV needs an author, assertion, basis and `verifyBy`. Error messages name the field (`'claim: must be a non-empty string'`, `'a line is a JSON object'`, `'type: a version 1 line is a TB or UV …'`) instead of `'TB entry missing claim'` / `'entry is not an object'` / `'unsupported entry type'`. v1 `command` evidence reads as `claimed-command` in the typed entry (the line itself is not rewritten).
- **Several files** (one per teammate): `parseWikiFiles([{ name, text }, …])` folds each on its own and takes the most advanced status per entry (TB `active < contested < overridden < struck`, UV `open < verified < refuted < struck`); a refused file refuses the merge.
- **Incremental reads fold into the earlier read.** Pass the earlier result as `{ base }` (with the same `signers` / `admitV1Tbs`): `read = parseWikiLines(moreLines, { base: read, signers })` gives the whole stream so far — the base's entries with the new TRANSITIONs applied to them (a strike that arrives in an increment demotes a TB from the earlier read). `previous` defaults to `base.head`, so the new lines must continue it (stenographer's `sinceSeq` export). `parseWikiLines(moreLines, { previous })` without a base only checks that a chunk continues the stream: its entries are the chunk's alone, so don't select truth from it or concatenate entries across reads. With `previous`, an input with no v2 line (an emptied file, or one rewritten as version 1 lines) is refused.
- **`engine.syncTruthLedger` needs the whole stream.** It refuses a stream that starts part-way (first `seq` above 1) unless you pass the read it continues: `sync = engine.syncTruthLedger(moreLines, { base: sync.read })`. `TruthSyncResult` gains `read` (the stream read, or null).
- **Leap seconds** (`ts` with `:60`) are refused, as stenographer's codec refuses them.
- **Never rewritten**: `serializeWikiEntries` / `entryToWikiLine` give back the exact line an entry was read from — even when the fold moved its `status`. To write a whole stream back (TRANSITION lines included), use `result.lines` or `writeWikiFile(path, result)`. Entries you build by hand are still written in the version 1 shape, which carries no quorum: one with a `quorum` (or an `extra` field of that name) throws `TruthLineError` instead of giving a line every reader refuses, and `writeWikiFile` then leaves the file untouched.
- `wikiLineToEntry(line, options?)` validates the line with the v2/v1 codec and throws `TruthLineError` on a line a reader must refuse.
- `TruthSyncResult` gains `refused`; error entries may carry `id` and `file`.

### Writing proposals

- **A proposals file is one writer's hash-chained stream.** `serializeProposals(proposals, { head? })` and `exportProposalDrafts(state, { author, head? })` return chained lines (seq 1…, or continuing `head`). `appendProposalsFile` continues the file's own stream in one write and returns `{ written, skipped, head }`. It **refuses a file that isn't one valid proposals stream** — including a pre-1.0 file of bare lines — and leaves it untouched: start a new proposals file.
- **Dedupe is by (kind, targetRef, normalized claim or assertion)**, not `targetRef` alone, so a corrected value (`LOG_BUDGET is 60.`) is proposed even when an earlier value for the same target was (SAT-10). `proposeInvariants` no longer proposes tautologies (`postgres is postgres.`).
- **An id names one envelope.** Stenographer's intake files a line once by its `id` and refuses a different envelope under an `id` it filed, so `appendProposalsFile` (file and batch) and `ProposalStream.append` (what it wrote or `resume` read) throw `TruthLineError` on a proposal that reuses an id for a different envelope, and write nothing. `appendProposalsFile` skips the same envelope again; `ProposalStream.append` and `serializeProposals` write it again as a new line, which stenographer's intake files once. The builders (`uvProposal`, `tbProposal`, `exportProposalDrafts`) issue a fresh ULID per proposal, so only hand-built `ProposalLine`s with reused ids are affected.
- The envelope is exactly the spec's: no top-level `provenance`, and a `tb` draft is `{ claim, evidence, literals? }` (`signedBy: null` is gone from `TbProposalDraft`; nothing short-hand drafts is signed). `ProposalSpec` lost `sourceMessageId`. Builders throw on an incomplete draft.
- `parseProposalLines` reads proposals files: suite envelope lines (chained and hash-checked) and, read-only, the bare pre-1.0 line and the `shorthand-compaction` source (`kind: 'tombstone'` reads as `'tb'`).

### Rendering

- `applyTruthToSnapshot` (and `TruthAwareCompactor`) escape the compacted summary they put truth beside, so a message or tool output that reproduces `- [TB] … (signed: cto)` or `## Asserted Truth (ledger)` renders as `- \[TB] …` / `\## Asserted Truth …` (SH-04).
- `escapeUntrusted` is idempotent (an already-escaped `\[TB]` is left alone) and matches markers on a folded copy of the text: NFKC, default-ignorable code points and combining marks dropped, case-folded, and Cyrillic, Greek, Armenian, Cherokee and Lisu homoglyphs of T, B, U and V mapped to Latin. So `［ＴＢ］`, `[ＴB]`, `[T\u200BB]`, `[tb]`, `﹇TB]` and Cyrillic `[ТВ]` are escaped; `[TBD]` and `[tb1]` are words and are not. Look-alikes outside that set (other brackets such as `【`, homoglyphs from other scripts) are not.
- `WikiRenderer` escapes every name and text it renders (`\[`, `\]`, `&amp;`, `&lt;`, `&gt;`; a line-start `#` and a line of only `=` or `-` in multi-line text; the frozen markers), so ingested text can't become a link, an image, raw HTML, an entity such as `&#91;` or a heading (SH-24). Page paths are Unicode-aware slugs (`entities/日本語.md`); names that slug alike (`C++` and `C#`, or two summaries of one topic) get a short hash suffix (`entities/c-1a2b3c4d.md`) instead of overwriting each other; links are relative to the page they are on (`../topics/x.md` from an entity page). Paths of names that collided, and links, change.

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

