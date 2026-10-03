# Truth-Ledger Integration (stenographer truth format v2 — Q6 seam)

**Status:** Option B implemented (JSONL sync at the seam). Option A (ledger as L4's backing store) deliberately deferred, not rejected — the final call on convergence is reserved (stenographer PRD §13 Q6) and stays open until this seam produces evidence either way.

## Context

Stenographer's TB/UV v2 (its PR #7) split truth into detection (machine, proposal-only) and assertion (accountable, signed), stored in an append-only ledger with two axes per entry: **provenance** (where it came from) and **confidence type** (`TB` = provable, `UV` = believed-but-unverified). Short-hand's L4 is the adjacent construct: the durable residue that survives every compaction. The handoff's framing question: does the ledger *become* L4, or do the tools stay separate and sync at a format seam?

## Decision (working posture)

**Option B.** @shorthand/core consumes the ledger's JSONL export as high-priority context input and emits its own candidates back as proposal drafts. No code dependency in either direction — the contract is the line format, stenographer's truth format v2 (`spec/truth-format` in stenographer: README, JSON Schema, golden fixtures). This repo runs the same fixtures (`test/fixtures/truth-format/`, copied by `npm run sync:truth-fixtures`, source commit in `SOURCE`) in `src/truth/conformance.test.ts`.

Why B first:

- It proves or disproves the useful claim cheaply: *do asserted-truth entries actually improve compaction quality?* Option A is an architectural commitment (schema dependency, signing workflow inside the compaction loop) that should be bought with evidence, not adjacency.
- Short-hand ships with zero runtime dependencies; A would end that or force a partial vendoring of stenographer's schema.
- Short-hand's own ecosystem review reached the same posture independently: "a translation layer … do not conflate the two schemas."

## What's implemented

### Read direction: `CompactionEngine.syncTruthLedger(jsonl)`

`parseWikiLines` (`src/truth/wiki.ts`) reads stenographer's `export_wiki_entries` stream: one writer's JSONL where every line carries `seq`, `prevHash` and `hash` (SHA-256 of its RFC 8785 JCS form, `src/truth/jcs.ts`). The codec (`src/truth/format.ts`) checks each line's structure, hash, identities, links and agent quorum (`src/truth/quorum.ts`), and the chain across lines; a stream that fails any check is refused whole (`refused: true`), because a reader that skipped a refused TRANSITION would revive what it struck. Entry lines are written once; each status change is an appended `TRANSITION` line, and an entry's status is the highest-seq TRANSITION's, else its line's own. (Version 1 files from stenographer 0.x — no chain, status on the line, last line wins — are still read; their TBs carry no hash and are not truth unless the host passes `admitV1Tbs`.) `selectCurrentTruth` buckets entries per the §7 consumption rules, and `renderTruthSection` (`src/truth/compaction-bridge.ts`) renders the selection with the suite's frozen markers:

| Ledger state | Selection bucket | Rendered as |
|---|---|---|
| Active `TB` | `groundTruth` | `[TB] …`, first in every context frame |
| Contested `TB`, or an active one with an open contesting UV | `contested` (with its open contesting UVs) | `[TB ⚠ CONTESTED] …` with each `disputed by [UV — UNVERIFIED] …` beside it — both sides travel together, never silently resolved |
| Open `UV` | `unverified` | `[UV — UNVERIFIED] …` — flag, don't block; never reads as proven. A UV contesting a TB that is not current truth renders standalone with `contests <id>`, so it is never dropped |
| Overridden or struck `TB`, refuted/verified/struck `UV` | `history` | Not rendered; cached projections are evicted on sync |
| Missing or unknown status | `history` | Kept verbatim but never counts as truth |
| Unsigned `TB`, version 1 `TB`, an author or signer a given signer registry doesn't list, a `TB` an agent signed without a quorum of agents or citing an evidence kind this version doesn't know, an id two lines or files disagree about (unknown fields included) | `history` (`entry.inadmissible`) | Not truth whatever its status |

Several files (one per teammate) are read with `parseWikiFiles`: each folds on its own, then every entry takes the most advanced status on the lattice (TB `active < contested < overridden < struck`, UV `open < verified < refuted < struck`). A reader that syncs incrementally passes its last read as `base` (`parseWikiLines(moreLines, { base: read })`, `engine.syncTruthLedger(moreLines, { base: sync.read })`): the result is the whole stream so far, so an increment's TRANSITIONs apply to the entries read before, and the new lines must continue the base's head, so lines removed from the end of a stream it already read are noticed. (`{ previous: head }` alone checks that a chunk continues the stream; its entries are the chunk's only, and the engine refuses a part-way stream without its base.) The fold honours only what a stenographer stream can say: final statuses (overridden, struck, verified, refuted) never move back down, a TRANSITION must name a cause earlier in the stream, and with a signer registry a TRANSITION by an unlisted author is held, not applied.

The codec never rewrites a line: what it does not interpret — `x-steno`, other top-level keys, unknown statuses and kinds, tombstoned `literals` — is kept, and `serializeWikiEntries` gives back each entry's line exactly as read (the whole stream, TRANSITIONs included, is `result.lines`). The chain shows that lines are unchanged and from one stream; it does not authenticate who wrote them (signatures are planned for stenographer 1.x).

The synced selection lives **beside** the LSM levels, not inside them: recompaction can rewrite L4, but it cannot rewrite ledger truth, and no compaction path can promote a UV into something that reads as proven. Hosts that want ledger truth *in* L4 can opt in via `groundTruthToInvariant` (active TBs only — an invariant row can't carry the contested asterisk); such projections get a `truth:<id>` source marker, and the next sync displaces any whose entry is no longer ground truth. For string-typed L4 stores (e.g. `AgentMemory`'s LWW register), `truthToInvariantRecords` embeds the marker in the value itself.

Snapshot compaction (`DefaultCompactor`) gets the same selection through `TruthAwareCompactor` / `applyTruthToSnapshot`, which rebuild the truth section on every round so stale entries are displaced, and escape the compacted conversation they put it beside so quoted text can't pass for a `[TB]` line.

### Write direction: `exportProposalDrafts(state, { author })`

L4 invariants (drafted as **UVs** — an invariant is usually tribal knowledge that compacted well, which is exactly what UV means) and detected correction tombstones (drafted as unsigned **TBs**) go out as JSONL PROPOSAL lines in the suite's single envelope, exactly: `{schemaVersion: 2, seq, id, type: "PROPOSAL", ts, author, kind: "tb" | "uv", draft, targetRef, signal: {source: "compaction-candidate", detail}, agentSessionId, prevHash, hash}`. A proposals file is this writer's own hash-chained stream (`ProposalStream`, `appendProposalsFile`, `src/truth/proposals.ts`). `proposeInvariants` does the same for snapshot entities and decisions.

- Proposals only — there is no external write path to TB or UV.
- Every line names an accountable `author`; generic identities (`system`, `assistant`, `agent`, …) throw before a line is emitted, and nothing the compactor emits is signed.
- `appendProposalsFile` skips a proposal the file already holds by (kind, `targetRef`, normalized claim or assertion): a repeated round files nothing, a corrected value is proposed again. `targetRef` is `shorthand:invariant:<key>` / `shorthand:tombstone:<msgId>`, or `entity:` / `decision:` refs for snapshots; stenographer's intake files each envelope `id` once and refuses a different envelope under an `id` it filed, so `appendProposalsFile` and `ProposalStream` refuse to write one.
- Invariants that were themselves projected from the ledger are never proposed back (corroboration loop).

## What would justify revisiting Option A

- The sync cadence becomes a real problem (stale truth between syncs causing bad compactions).
- Signed truth measurably beats derived invariants in the context-shift benchmark, making the signing workflow worth embedding in the compaction loop.
- Stenographer's signer rules (§13 #2) change so that a compactor's promotions can be signed without a human in every loop. In 1.0 they can't: a person signs, or an agent quorum mints from agents' own drafts.

## Open items inherited from stenographer's §13 (affect this seam)

1. **UV TTL** — open UVs never expire; the `unverified` bucket can grow without bound. If frames get noisy, cap or age-weight flags on this side.
2. **Signer rules** — decided for 1.0: a person signs alone, and agents settle a claim only together, as an agent quorum (two or more agent sessions agreeing from different angles within 15 minutes, spec "Agent quorum"). Nothing signs for itself: `command` evidence is unchecked output, question-class. A compactor is neither: every short-hand candidate is a PROPOSAL a person notarizes (a quorum mints only from agents' own drafts). Revisit if the proposal queue backs up.
3. **Contested-TB posture** — currently authoritative-with-asterisk, and short-hand renders it that way. If stenographer downgrades contested TBs to UV-grade trust, `renderTruthSection` and `selectCurrentTruth` are the two places to change.
