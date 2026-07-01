# The Agent Stack: Engineering Guide (Short-Hand vantage)

Companion to [`executive-summary.md`](./executive-summary.md). Technical breakdown of how Short-Hand
relates to AgentVault, SmallChat, and Stenographer, what's actually wired up in *this* repo today
(nothing), and a phased path to closing the gaps from Short-Hand's side.

> **Sourcing note.** Short-Hand claims below are verified directly against this repo's source
> (`src/`, tests, `docs/qa-engineering.md`, git history, `package.json`). AgentVault claims are
> verified against its public source, fetched by raw URL
> (`src/orchestration/polytician-enricher.ts` and its ecosystem docs) — not README-derived. SmallChat
> and Stenographer claims are marked **[README]** and come only from their public READMEs and GitHub
> repository metadata; this session has no source-level access to either. Re-verify exact APIs
> against upstream source before writing integration code against them.
>
> Cross-reference:
> [AgentVault's engineering-guide.md](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md).
> That document is written from the opposite vantage (AgentVault source access, README-only for the
> other three, including Short-Hand). Where the two disagree about Short-Hand, this document is the
> more accurate one — it was written with direct source access to this repo.

## 1. Component reference

### Short-Hand (this repo) — verified from source

- **What it is:** a zero-runtime-dependency, ESM-only TypeScript library (`short-hand` on npm,
  `v0.1.0`) implementing progressive, database-inspired compaction of LLM conversation history, plus
  an independent agential-memory subsystem.
- **Compaction core** (`src/compaction/compaction-engine.ts`, `src/compaction/regex-compactor.ts`):
  `CompactionEngine` manages a five-level LSM-tree (`CompactionLevel` L0 memtable → L4 invariants,
  `src/types.ts:26-37`). `addMessage`/`addMessages` push into L0; `flush()` moves overflow through the
  active `Compactor` (only `RegexCompactor` is implemented — `local`/`host` tiers fall back to regex,
  `compaction-engine.ts:229-243`); `buildContextFrame(budget)` assembles a token-budgeted
  `ContextFrame` prioritizing L4 → L0, folding in `ActiveEngramStore` results and tombstone
  annotations if attached (`compaction-engine.ts:164-204`).
- **Importance scoring** (`src/importance/importance-detector.ts`): three-signal model — state delta
  (45%), reference frequency (25%), trajectory discontinuity (30%) — `DEFAULT_IMPORTANCE_WEIGHTS`
  (`types.ts:226-230`).
- **Tombstones / corrections** (`Tombstone` type, `types.ts:43-58`): tracks superseded content,
  originating/correcting message IDs, reason, and optional corrected value. Implemented and tested
  independently of any other project's correction model.
- **CRDT primitives** (`src/crdt/lww-register.ts`, `or-set.ts`, `g-set.ts`, `agent-memory.ts`):
  `LWWRegister` (L4 invariants), `ORSet` (L3 entities, add-wins), `GSet` (L2 summaries), and
  `AgentMemory` composing all three per-agent with a `merge()` for multi-agent scenarios.
- **Active engrams / agential memory** (`src/crdt/active-engram-store.ts`, `src/types.ts:293-370`):
  `ActiveEngramStore` holds `ActiveEngram` entries (payload + interpreter template + declarative
  `ActivationPolicy` + host-controlled `importanceScore`). On retrieval it evaluates eligibility
  (topic match, retrieval cap, expiry), resolves "shadowing" (one engram's output can override
  another's — the correction mechanism for this subsystem), and calls an `Interpreter` to restate the
  payload in light of current context before injection ("interpret before inject").
- **Tiered interpreter system** (`src/interpreter/`): `RegexInterpreter` (template substitution, zero
  deps), `LocalInterpreter`, `HostInterpreter` (structural Anthropic-shaped client — no
  `@anthropic-ai/sdk` import; caller injects any object matching
  `messages.create({model, max_tokens, system, messages})`), and `withFallback` for tier composition.
  Bounded contract: `InterpretInput` is exactly `{template, payload, context}` — nothing else, enforced
  by a compile-time `@ts-expect-error` pin (`docs/qa-engineering.md:84`); violations throw
  `InterpreterBudgetError` (`timeout` / `output_too_long`) or `InterpreterUnavailableError`; caller
  `AbortSignal` is honored.
- **Context-shift benchmark** (`src/benchmark/`): `ContextShiftBenchmark` runs fixtures through raw vs.
  interpreted arms, judged by `KeywordJudge` or `LMJudge`, scored by `wilson95` lower-bound win rate.
  Documented "thesis-alive gate" in `docs/qa-engineering.md:116-127`: `winRate >= 0.6`,
  `meanLift >= 0`, Wilson 95% lower bound `> 0.5` on the offline (regex) run. This is the most
  recently and actively developed part of the repo per git history (`feat: bounded LM interpreter and
  context-shift benchmark for ActiveEngram`).
- **Source ingestion** (`src/ingestion/source-ingester.ts`): `SourceIngester.ingest(source, engine)`
  chunks a `Source` (markdown-aware heading/paragraph/sentence splitting with configurable overlap)
  into `ConversationMessage[]`, feeds them to a `CompactionEngine`, flushes, and records an
  `IngestionEvent`. Comment self-describes this as bridging "Karpathy's 'raw sources' layer" —
  a reference to Andrej Karpathy's LLM-memory/wiki writing, not to any of the other three projects.
- **Wiki rendering** (`src/wiki/wiki-renderer.ts`): renders `CompactedState` into interlinked markdown
  pages (entities, topics, index, ingestion log) — also explicitly credited as "Karpathy-style," the
  same inspiration Stenographer's README credits **[README]**. Both projects independently implement a
  similar "compacted knowledge → markdown wiki" pattern with no shared code.
- **Embedding** (`src/embedding/index.ts`): `StubEmbedder` returns zero vectors; comment states real
  embedding (ONNX) is a future version, not current behavior. `ImportanceDetector` currently uses
  lexical (Jaccard) approximation instead.
- **Verification** (`src/verification/`): `InvariantChecker` (five safety checks against compacted
  state) and `RecallTester` (quiz-generation + recall scoring round-trip).
- **Maturity signal:** `v0.1.0`; 16 `*.test.ts` files, ~154 test cases by static grep (suite did not
  run in this environment — `node_modules` not installed, no network install attempted); 17 commits
  in the visible history; no `.github/workflows` directory (no CI configured in-repo); 0 GitHub stars,
  0 open issues, MIT license.
- **Naming nit:** `package.json` names the package `short-hand`; the header comment in `src/types.ts`
  ("Core types for `@shorthand/core`") uses a different, unpublished scoped name. Minor doc/comment
  drift, not a functional issue — flagging so nobody writes integration code against a package name
  that doesn't exist on npm.

### AgentVault — verified from source (public repo)

Per its own `docs/ecosystem/engineering-guide.md` and confirmed directly by fetching
`src/orchestration/polytician-enricher.ts`: `enrichWithPolyticianContext(prompt, config)` pulls
concepts from an MCP server, and its overflow handling is exactly the naive-truncation pattern
described — a character-count gate during accumulation
(`totalContextLength + blockLength > maxContextLength - prompt.length - 500`) and a final
`enrichedPrompt.slice(0, maxContextLength - 3) + '...'` if still over budget. This is the concrete,
source-verified target for Gap A below.

### SmallChat **[README]**

In-process deterministic tool dispatch (`ToolRuntime.dispatch(intent, args)` /
`runtime.intent<T>('...').withArgs(...).execContent<T>()`), explicitly positioned as *not* a
knowledge/RAG layer: "Use your knowledge engine for what the agent knows. Use smallchat for what the
agent does." Ships `@smallchat/core` (and a `@smallchat/core/inference`-only entry point that
excludes "token-era optimization satellites (compaction, memex, CRDT, …)" — notably, SmallChat's own
README uses the word "compaction" as something it explicitly separates itself from, which is a data
point against assuming a tight SmallChat↔Short-Hand coupling). No public type in its README takes or
returns anything resembling Short-Hand's `ContextFrame`.

### Stenographer **[README]**

MCP server that tails conversation logs (`jsonl`/`claude-code`/`anthropic`/`openai`/`generic`
adapters) and builds a GraphRAG index (local `all-MiniLM-L6-v2` embeddings via
`@xenova/transformers`, SQLite + `sqlite-vec`). Has its own decision-supersession/tombstone model
(independent implementation of the same concept as Short-Hand's `Tombstone`/`Decision` types) and 11
MCP tools including `search_conversation`, `get_decisions`, `get_context_frame`. Its README explicitly
states the ecosystem thesis as its own roadmap item: *"The Agent Stack — warm-state handoff to
short-hand (compaction), smallchat (tool dispatch), agentvault (deployment)."* — this is the actual
origin of the four-project narrative from a documentation standpoint; it is not Short-Hand's own
claim about itself.

## 2. Updated data-flow view

AgentVault's diagram (Stenographer → Short-Hand → LLM → SmallChat → AgentVault) is directionally
plausible but should be read as **two independently-verifiable claims, not one**, given what each
project's own source/README says about itself:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     Conversation / Session (raw log)                       │
└───────────────────────────────┬────────────────────────────────────────────┘
                                 │ jsonl / provider adapter               [README, Stenographer]
                                 ▼
                        ┌─────────────────┐
                        │   Stenographer   │  passive GraphRAG index;
                        │                  │  own tombstone/decision model
                        └────────┬─────────┘
                                 │ search_conversation / get_decisions (MCP)
                                 │ — NO adapter exists on either side today
                                 ▼
                        ┌─────────────────┐
                        │   Short-Hand     │  SourceIngester → CompactionEngine
                        │  (verified: no   │  → buildContextFrame(budget)
                        │  Stenographer-   │  ActiveEngramStore + tiered
                        │  aware code)     │  interpreter (regex/local/host)
                        └────────┬─────────┘
                                 │ ContextFrame  — shape is Short-Hand-specific;
                                 │ not documented as consumed by SmallChat
                                 ▼
                        ┌─────────────────┐
                        │   LLM (agent)    │
                        └────────┬─────────┘
                                 │ tool intent
                                 ▼
                        ┌─────────────────┐
                        │   SmallChat      │  dispatch(intent, args) — README
                        │                  │  explicitly scopes itself away
                        │                  │  from "compaction"/knowledge-layer work
                        └────────┬─────────┘
                                 ▼
                        ┌─────────────────┐
                        │   AgentVault     │  canister exec, wallet, VetKeys
                        └─────────────────┘
```

The Stenographer→Short-Hand edge and the Short-Hand→AgentVault edge (via `polytician-enricher.ts`)
are the two concretely buildable seams — both have a real producer/consumer shape on at least one
side. The Short-Hand→SmallChat edge is the weakest claim in the whole diagram: it rests on the
"Agent Stack" roadmap phrase, not on any documented type compatibility.

## 3. What's actually wired up in this repo today

**Nothing.** Confirmed by the same method AgentVault's own guide used on itself: a full,
case-insensitive search of `src/`, tests, docs, `package.json`, and `package-lock.json` for
`agentvault`, `smallchat`, `stenograph`, `short-hand`, `shorthand` returns matches only in
self-referential contexts (the package's own name in `README.md`/`package.json`/`git clone` examples).
No imports, no MCP client, no adapter interface, no documented integration guide.

### Where Short-Hand's existing shape would need extension

| File | Current shape | What integration would require |
|---|---|---|
| `src/ingestion/source-ingester.ts` | Consumes a generic `Source` (`{id, title, content, contentType, uri, metadata}`) — markdown/plain-text only | A new mapper (not a change to this file) that turns Stenographer's `search_conversation`/`get_decisions` results or AgentVault's Polytician "concepts" into `Source` objects |
| `src/compaction/compaction-engine.ts` | `buildContextFrame(budget): ContextFrame` — already token-budgeted, importance-ordered | Nothing structural needed on Short-Hand's side; the AgentVault-side change is swapping `polytician-enricher.ts`'s truncation branch for a call into this |
| `src/types.ts` (`Tombstone`, `Decision`) | Independent schema, no shared fields with Stenographer's decision model | A translation layer if Stenographer decisions are to flow in — do not conflate the two schemas |
| `src/crdt/active-engram-store.ts` | Regex-tier interpreter by default; async path supports `local`/`host` | Could host Stenographer-sourced "engrams" (e.g., surfaced decisions) if a Stenographer adapter feeds `add()` |
| `src/wiki/wiki-renderer.ts` | Renders Short-Hand's own `CompactedState` only | Not wired to Stenographer's own wiki output; would need reconciliation, not integration, if both are meant to produce one wiki |

## 4. Confirmation / refutation of the AgentVault-side guide's claims about Short-Hand

- **CONFIRMED, verified in source:** five-level LSM-tree architecture, tombstone-based correction
  tracking, three-signal importance scoring (with the exact 45/25/30 weights), `CompactionEngine` as
  orchestrator, regex-based compaction, token-budgeted context-frame generation, `ActiveEngramStore`
  for agentic memory with retrieval-time re-interpretation, CRDT primitives for multi-agent scenarios,
  zero runtime dependencies, MIT license, ESM-only, ships as a public npm package.
- **REFUTED as literally stated:** *"Explicit positioning: README self-describes as 'language
  middleware for Stenographer and SmallChat.'"* The shipped `README.md` contains no such sentence, or
  anything resembling it — confirmed by full-text read and by grep. What is true: this exact phrase
  is set as the **GitHub repository description/tagline** (repo metadata, not README prose), and a
  close variant of the surrounding narrative appears in **Stenographer's** README roadmap, not
  Short-Hand's own docs. This is the one place the AgentVault-side evaluation's use of "README" as a
  source materially overstated what the target repo's documentation actually says — worth being
  precise about, since it changes whether a reader should expect to find integration guidance inside
  Short-Hand's own docs (they will not).
- **NOT PREVIOUSLY COVERED, additive finding:** the tiered `Interpreter` system
  (`src/interpreter/`) and its companion context-shift benchmark (`src/benchmark/`) are substantially
  more developed than a one-line mention suggests. They have a formally specified bounded contract
  (fixed 3-field input, typed budget/unavailability errors, abort/timeout handling, a
  compile-time-enforced field-set pin), required smoke tests per new tier
  (`docs/qa-engineering.md:70-76`), and an empirical pass/fail gate for whether interpretation
  actually helps recall rather than just plausibly seeming like it should. Any integration work that
  routes Stenographer or Polytician content through Short-Hand should consider using this interpreter
  layer (not just the compaction engine) as the injection point, since it is precisely designed to
  restate retrieved-but-stale content in light of current context.
- **CONFIRMED, reinforces the risk flag:** AgentVault's guide calls these projects "single-maintainer,
  pre-1.0 ... low visibility." Verified for Short-Hand specifically: 0 GitHub stars, no CI workflow
  configured in-repo (tests exist but nothing runs them automatically on push/PR per this repo's own
  files), 0.1.0 version.

## 5. Suggested phased roadmap (from Short-Hand's side)

1. **Phase 1 — Prove the AgentVault seam concretely.** Write a `PolyticianConceptSource` (or
   generically named) adapter in `src/ingestion/` that maps an MCP "concept" result shape into
   `Source[]`, feeds `SourceIngester.ingestAll()`, and exposes `CompactionEngine.buildContextFrame()`
   through a small function whose signature could plausibly replace the truncation branch in
   AgentVault's `enrichWithPolyticianContext`. Add a unit test asserting importance-ranked survival
   under a tight token budget — mirroring the style AgentVault's own guide requests on its side
   (`tests/unit/smallchat-compression.test.ts`-shaped).
2. **Phase 2 — Reconcile, don't duplicate, the tombstone/decision model.** Before accepting
   Stenographer input, decide whether Short-Hand's `Tombstone`/`Decision` types should be
   extended/aligned with Stenographer's supersession model **[README]**, or kept deliberately separate
   with an explicit translation function at the ingestion boundary. Shipping two independently
   evolving "what got corrected" schemas across the stack without a translation layer is the
   duplication risk flagged in the executive summary.
3. **Phase 3 — Verify, then wire, the Stenographer edge.** Get source-level access to Stenographer (or
   its published `@stenographer/core` type declarations) to confirm the exact response shape of
   `search_conversation`/`get_decisions` before writing the adapter in Phase 1's spirit for this
   direction. Today this is unverified beyond the README's tool-name list.
4. **Phase 4 — Treat the SmallChat edge as an open question, not a roadmap item.** Get source or
   published-types access to `@smallchat/core` and check whether `ToolRuntime.dispatch()` or any
   adjacent API is documented to accept a `ContextFrame`-shaped input. If it does not, the "Agent
   Stack" diagram's Short-Hand→SmallChat arrow should be described as sequencing (compaction happens,
   then dispatch happens, in the same agent loop) rather than data-flow integration, until proven
   otherwise.
5. **Phase 5 — Close Short-Hand's own maturity gaps before depending on tiers that don't exist yet.**
   `local`/`host` compaction tiers currently fall back to `regex`; the embedding module is a stub. Any
   ecosystem integration plan that assumes Short-Hand already does LM-tier compaction end-to-end is
   building on the interpreter/benchmark subsystem (which is real and tested) rather than the
   `Compactor`/`CompactionEngine` tier system (which is not yet implemented beyond regex).

## 6. Risks and open questions

- **Single-maintainer, pre-1.0, uncertain CI:** confirmed for this repo specifically — no
  `.github/workflows` present, so the 16 test files are not verified to run automatically on every
  change today. Anyone depending on this package should run the suite themselves before pinning a
  version.
- **The ecosystem narrative is currently one-directional and metadata-level:** Stenographer's README
  names Short-Hand in its roadmap; Short-Hand's GitHub tagline names Stenographer and SmallChat;
  neither relationship is expressed in a single line of shipped code or a documented integration guide
  on any of the three repos evaluated with source access (AgentVault, Short-Hand) or by README
  (SmallChat, Stenographer). Build the bridges before assuming they're load-bearing.
- **Duplicate correction/tombstone models across the stack:** Short-Hand and Stenographer
  **[README]** each independently implement a decision-supersession concept. Resolve this explicitly
  (Phase 2) rather than letting a future integration silently pick one arbitrarily.
- **The SmallChat "not a knowledge/RAG layer" positioning deserves more weight than the AgentVault
  diagram gives it.** SmallChat's own README draws a fairly hard line between the "knowledge layer"
  and the "dispatch layer" and explicitly separates its inference-only entry point from "compaction"
  as a satellite concern. Confirm actual type-level compatibility before treating this as a solved
  integration.
