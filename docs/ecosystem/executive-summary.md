# The Agent Stack: Executive Summary (Short-Hand vantage)

**Scope:** AgentVault, SmallChat, Stenographer, and Short-Hand — evaluated as a single ecosystem,
from inside this repo (Short-Hand).
**Audience:** stakeholders deciding whether/how to integrate these projects.
**Companion:** [`engineering-guide.md`](./engineering-guide.md) in this directory.

> **Sourcing note.** This session's GitHub access is scoped to `johnnyclem/short-hand` only.
> Short-Hand was evaluated directly from source (every file under `src/`, `docs/qa-engineering.md`,
> `package.json`, git history). AgentVault is public, so its ecosystem docs and the specific source
> files this evaluation cites (`polytician-enricher.ts`) were fetched and read directly by raw URL —
> those claims are source-verified, not README-derived. SmallChat and Stenographer were evaluated from
> their public READMEs and GitHub repository metadata only — no source-level access. Claims about
> those two are flagged **[README]** throughout both documents; treat them as directionally accurate,
> not verified against code.
>
> This document extends and corrects
> [AgentVault's executive-summary.md](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md),
> which was written from the opposite vantage point (source access to AgentVault only, README-only for
> the other three). Read that one first — this one does not repeat its content, only what Short-Hand's
> source can add or correct.

## What each project is, in one line

| Project | One-line role | Language | License | Maturity | Access |
|---|---|---|---|---|---|
| **AgentVault** | Deploys AI agents to Internet Computer canisters for durable, sovereign execution | TypeScript / Motoko | MIT | Active, public docs | Source (via raw fetch) |
| **SmallChat** | Deterministic, in-process semantic tool dispatch — no schema stuffing | TypeScript (+ Swift port) | MIT | `@smallchat/core`, ~5 stars, actively versioned (0.5.0 in README) | **[README]** |
| **Stenographer** | Passive MCP "court reporter" — tails conversation logs, builds a GraphRAG index of entities/relations/decisions | TypeScript | — | `0.1.0-alpha.2`, 0 stars, `master` default branch | **[README]** |
| **Short-Hand** (this repo) | Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame, plus an agential-memory (`ActiveEngram`) subsystem with a tiered (regex/local/host) interpreter | TypeScript | MIT | `0.1.0`, 16 test files (~154 cases), 0 stars, 0 open issues, no CI workflow configured | **Source** |

## The thesis, and where it actually comes from

AgentVault's docs propose a four-layer model — AgentVault as the body, SmallChat as the reflexes,
Stenographer as the memory, Short-Hand as working memory — and describe Short-Hand as "explicitly
billed as 'language middleware for Stenographer and SmallChat.'" Having read Short-Hand's actual
source and shipped docs, the finding is more nuanced than that phrasing suggests:

- Short-Hand's shipped `README.md` **never uses that phrase, or any variant of it.** It describes
  itself purely as "Progressive context compaction for LLMs. Old computer science for new
  constraints." It does not mention AgentVault, SmallChat, or Stenographer by name anywhere in prose.
- The phrase **does** exist — as this repository's GitHub description/tagline metadata
  ("Language middleware for stenographer and smallchat"), which is a one-line label set at the
  repo-settings level, separate from the README a developer actually reads.
- The "Agent Stack" framing itself is not authored on the Short-Hand side at all. It traces to
  **Stenographer's** README roadmap section **[README]**: *"The Agent Stack — warm-state handoff to
  short-hand (compaction), smallchat (tool dispatch), agentvault (deployment)."* Short-Hand is named
  as a destination in someone else's roadmap; it does not reciprocate the reference anywhere in its
  own docs or code.
- A full case-insensitive repo-wide search of Short-Hand's source, tests, docs, and package files for
  `agentvault`, `smallchat`, `stenograph`, `short-hand`, `shorthand` turns up **zero hits outside
  self-references** (its own name in the README/package.json) and zero hits in `src/`.

**Net effect:** the four-layer thesis is real as an aspiration, and it is directionally sound given
what each project's code actually does. But it is currently a claim asserted *about* Short-Hand by a
tagline and by a sibling project's roadmap section — not a claim Short-Hand makes about itself, and
not backed by one line of integration code in this repo. This is the single correction this document
adds to the AgentVault-side executive summary, which took the README-self-description claim about
Short-Hand at face value.

## Key finding: from Short-Hand's side, the ecosystem is zero-wired, not partially wired

AgentVault's summary found "one bridge built (AgentVault ↔ SmallChat, partially), two bridges
missing." From Short-Hand's vantage the count for *this* repo is simpler: **zero bridges to any of
the other three exist in source.** Short-Hand has no adapter, no MCP client, no import, and no
documented integration guide referencing Stenographer, SmallChat, or AgentVault. What it does have
that's relevant:

- `src/ingestion/source-ingester.ts` — a generic document-to-message adapter (`Source` → chunked
  `ConversationMessage[]` → `CompactionEngine`). This is the shape a Stenographer- or
  Polytician-flavored adapter would extend, but today it only knows about plain markdown/text
  documents, not any MCP tool response shape.
- `src/crdt/active-engram-store.ts` + `src/interpreter/` — a three-tier (`regex` → `local` → `host`)
  bounded-LM interpretation system with a formal safety contract, plus a dedicated
  "context-shift benchmark" (`src/benchmark/`) that empirically measures whether interpretation helps
  or hurts recall. This is more developed than a passing mention suggests — it is the most recently
  and actively worked-on part of the repo — and it is a second, independent candidate surface for
  ecosystem integration beyond simple truncation replacement (see the engineering guide, Gap A+).
- Its own `Tombstone` and `Decision` types (`src/types.ts`), which duplicate — independently,
  with no shared schema — the exact "supersession" concept Stenographer's README **[README]**
  describes for its own decision tracking. Two projects in this stack have each built their own
  correction/tombstone model from scratch. That is a duplication risk symmetric to the
  MemoryRepo/Polytician overlap AgentVault's own docs flag on their side.

## Why this matters

- **The Gap A opportunity (Short-Hand → AgentVault's `polytician-enricher.ts`) is real and
  verified.** Fetching that file directly confirms the AgentVault-side claim precisely: overflow is
  handled by a character-count check (`totalContextLength + blockLength > maxContextLength -
  prompt.length - 500`) and a final `enrichedPrompt.slice(0, maxContextLength - 3) + '...'`
  truncation. Short-Hand's `CompactionEngine.buildContextFrame(budget)` already produces a
  token-budgeted, importance-ordered `ContextFrame` — the shape that truncation branch should be
  replaced with. `SourceIngester` already knows how to turn arbitrary text into `ConversationMessage`s,
  so the plumbing from "Polytician concept" to "message CompactionEngine can score" is closer to
  existing than AgentVault's guide implies, once a thin adapter is written.
- **The SmallChat handoff arrow in AgentVault's data-flow diagram should not be assumed proven.**
  SmallChat's own README **[README]** is explicit: *"smallchat is not a knowledge engine or a RAG
  layer... Use your knowledge engine for what the agent knows. Use smallchat for what the agent
  does."* Nothing in SmallChat's public interface (`ToolRuntime.dispatch(intent, args)`,
  `runtime.intent<T>(...)`) is documented as consuming a `ContextFrame`-shaped object, and nothing in
  Short-Hand emits one shaped for SmallChat's dispatch call. The two may be adjacent phases of one
  agent loop without being an actual data-flow edge — this needs verification against SmallChat
  source before treating it as integration work rather than sequencing.
- **Short-Hand's own local/host tiers are still partially aspirational,** independent of any
  ecosystem question: `CompactorTier: 'local' | 'host'` both fall back to regex today
  (`compaction-engine.ts`), and the embedding module is an explicit stub returning zero vectors. Any
  integration plan should not assume Short-Hand's advertised tiered compaction is fully live; the
  regex tier is what ships.

## Recommendation

1. Correct the ecosystem narrative before acting on it: Short-Hand's "language middleware" framing is
   a tagline and a Stenographer-side roadmap reference, not a documented or implemented contract on
   Short-Hand's side. Treat it as a target to build toward, not a description of current behavior.
2. If pursuing AgentVault's Phase 1 (replace `polytician-enricher.ts` truncation), do it as a
   Short-Hand-side adapter first: a `PolyticianConceptSource` mapper that turns MCP concept results
   into `Source` objects for `SourceIngester`, then feeds `CompactionEngine.buildContextFrame()`.
   This is buildable using primitives that exist today.
3. Before wiring Stenographer as a Short-Hand input, resolve the duplicate tombstone/decision models
   (§ engineering guide, Phase 2) rather than letting two independently-evolving "what got corrected"
   schemas coexist across the stack.
4. Do not assume a Short-Hand → SmallChat data edge is real; get source access to SmallChat (or read
   its published `@smallchat/core` type declarations) before designing around the diagram's arrow.
5. Treat Short-Hand itself as pre-1.0 and single-maintainer for planning purposes: no CI workflow is
   configured in this repo, `local`/`host` compaction tiers fall back to `regex` in the shipped
   engine, and the embedding module is a stub. The regex/CRDT/context-frame/interpreter-tier-with-
   fallback core is what's safe to depend on today.

See [`engineering-guide.md`](./engineering-guide.md) for the technical detail behind these
recommendations, including file-level references and a phased roadmap from Short-Hand's side.
