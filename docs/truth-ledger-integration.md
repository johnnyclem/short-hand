# Truth-Ledger Integration (stenographer TB/UV v2 — Q6 seam)

**Status:** Option B implemented (JSONL sync at the seam). Option A (ledger as L4's backing store) deliberately deferred, not rejected — the final call on convergence is reserved (stenographer PRD §13 Q6) and stays open until this seam produces evidence either way.

## Context

Stenographer's TB/UV v2 (its PR #7) split truth into detection (machine, proposal-only) and assertion (accountable, signed), stored in an append-only ledger with two axes per entry: **provenance** (where it came from) and **confidence type** (`TB` = provable, `UV` = believed-but-unverified). Short-hand's L4 is the adjacent construct: the durable residue that survives every compaction. The handoff's framing question: does the ledger *become* L4, or do the tools stay separate and sync at a format seam?

## Decision (working posture)

**Option B.** Short-hand consumes the ledger's JSONL export as high-priority context input and emits its own candidates back as proposal drafts. No code dependency in either direction — the contract is the line format, protected by tests on both sides plus stenographer's round-trip invariant.

Why B first:

- It proves or disproves the useful claim cheaply: *do asserted-truth entries actually improve compaction quality?* Option A is an architectural commitment (schema dependency, signing workflow inside the compaction loop) that should be bought with evidence, not adjacency.
- Short-hand ships with zero runtime dependencies; A would end that or force a partial vendoring of stenographer's schema.
- Short-hand's own ecosystem review reached the same posture independently: "a translation layer … do not conflate the two schemas."

## What's implemented

### Read direction: `CompactionEngine.syncTruthLedger(jsonl)`

Parses stenographer's `export_wiki_entries` JSONL (`src/truth/ledger-sync.ts`; last line wins per id, since statuses evolve in an append-only file) and buckets entries per the §7 consumption rules:

| Ledger state | Bucket | Behavior in short-hand |
|---|---|---|
| Active `TB` | `citable` | Rendered as `[truth] …`, first in every context frame |
| Contested `TB` | `citable` + attached UVs | Rendered with its contesting UV(s) — both sides travel together, never silently resolved |
| Open `UV` | `flags` | Rendered `[unverified] …` — flag, don't block; never reads as proven |
| Overridden `TB`, refuted/verified `UV` | `displaced` | Excluded from current truth; cached projections are evicted on sync |

The synced view lives **beside** the LSM levels, not inside them: recompaction can rewrite L4, but it cannot rewrite ledger truth, and no compaction path can promote a UV into something that reads as proven. Hosts that want ledger truth *in* L4 can opt in via `citableToInvariant` (uncontested TBs only — an invariant row can't carry the contested asterisk); such projections get a `truth:<id>` source marker, and the next sync displaces any whose entry was overridden.

### Write direction: `exportProposalDrafts(state)`

L4 invariants (drafted as **UVs** — an invariant is usually tribal knowledge that compacted well, which is exactly what UV means) and detected correction tombstones go out as JSONL proposal drafts. Stenographer's `importProposalDrafts` files each as a `PROPOSAL` under a `detector:short-hand` identity:

- Proposals only — there is no external write path to TB or UV.
- Drafts carry no author; accountability is supplied at intake, and the detector identity cannot sign its own intake (the contempt check rejects it).
- `targetRef` (`shorthand:invariant:<key>` / `shorthand:tombstone:<msgId>`) makes re-imports idempotent while proposals stay open.
- Invariants that were themselves projected from the ledger are never proposed back (corroboration loop).

## What would justify revisiting Option A

- The sync cadence becomes a real problem (stale truth between syncs causing bad compactions).
- Signed truth measurably beats derived invariants in the context-shift benchmark, making the signing workflow worth embedding in the compaction loop.
- Stenographer resolves its open signer question (§13 #2) in a way that lets a compactor's promotions be signed without a human in every loop.

## Open items inherited from stenographer's §13 (affect this seam)

1. **UV TTL** — open UVs never expire; the `flags` bucket can grow without bound. If frames get noisy, cap or age-weight flags on this side.
2. **Signer rules** — today every short-hand candidate needs a human (or independent `command` evidence) to become truth. Fine at current volume; revisit if the proposal queue backs up.
3. **Contested-TB posture** — currently authoritative-with-asterisk, and short-hand renders it that way. If stenographer downgrades contested TBs to UV-grade trust, `renderTruthSection` and the `citable` bucketing are the two places to change.
