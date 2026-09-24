/**
 * Truth-ledger interop types (stenographer TB/UV v2, Option B seam).
 *
 * Short-hand consumes stenographer's append-only JSONL export and emits
 * candidate invariants back as proposal drafts. Format-level contract only —
 * no code dependency on stenographer, no shared schema module.
 *
 * The one rule that must survive any refactor here: every consumed entry
 * carries two axes — provenance (where it came from) and confidence type
 * (TB = provable, UV = believed-but-unverified). Collapsing both into a
 * single "invariant" bucket is a regression, not a simplification.
 */

// ---------------------------------------------------------------------------
// Wire format — one line of stenographer's exported JSONL
// ---------------------------------------------------------------------------

/** Confidence type: the second axis. */
export type TruthConfidence = 'TB' | 'UV';

export type TbStatus = 'active' | 'contested' | 'overridden';
export type UvStatus = 'open' | 'verified' | 'refuted';

/**
 * Structural mirror of stenographer's `WikiEntryLine`. Fields short-hand
 * does not consume (embeddings, links) travel under `x-steno` and are
 * carried through untouched.
 */
export interface TruthLedgerLine {
  id: string;
  type: TruthConfidence;
  ts: string;
  author: string;
  status: string;
  // TB fields
  claim?: string;
  evidence?: unknown[];
  signedBy?: string | null;
  // UV fields
  assertion?: string;
  basis?: string;
  verifyBy?: unknown;
  contests?: string | null;
  /** Stenographer-namespaced extras; opaque to short-hand. */
  'x-steno'?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Consumption view — the §7 rules, made structural
// ---------------------------------------------------------------------------

/** An entry short-hand may cite as ground truth (active or contested TB). */
export interface CitableTruth {
  entry: TruthLedgerLine;
  /** Open UVs disputing this TB. Non-empty exactly when status is contested.
   *  Both sides ride through compaction together — never resolve silently. */
  contestedBy: TruthLedgerLine[];
}

/** The consumption-rule buckets for one synced ledger snapshot. */
export interface TruthLedgerView {
  /** Active + contested TBs, in ledger order. Ground truth (with asterisks). */
  citable: CitableTruth[];
  /** Open UVs not attached to a contested TB. Flag, don't block — these must
   *  never render as proven. */
  flags: TruthLedgerLine[];
  /** Overridden TBs, refuted UVs, verified UVs (superseded by their minted
   *  TB). History: excluded from current truth, never citable. */
  displaced: TruthLedgerLine[];
}

export interface TruthSyncResult {
  view: TruthLedgerView;
  /** L4 invariants removed because their backing ledger entry was displaced. */
  displacedInvariantKeys: string[];
  /** Lines that failed to parse; the rest of the sync proceeds. */
  errors: Array<{ line: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Export direction — candidate invariants as proposal drafts
// ---------------------------------------------------------------------------

/**
 * One line of the proposal-draft JSONL short-hand emits for stenographer.
 * Stenographer files each as a PROPOSAL — short-hand has no write path to
 * truth itself, and drafts never carry an author (the intake supplies its
 * own detector identity; a proposal nobody signs stays a proposal forever).
 */
export interface ProposalDraftLine {
  kind: 'tombstone' | 'uv';
  /** The full TB or UV body being proposed, per stenographer's schema. */
  draft: Record<string, unknown>;
  signal: {
    source: 'compaction-candidate';
    detail?: string;
  };
  /** Dedupe key so re-exports don't pile up duplicate open proposals. */
  targetRef?: string;
  /** Where the candidate came from, when short-hand knows. */
  provenance?: { kind: 'sourceMessageId'; ref: string };
}

/** Prefix marking an L4 invariant as projected from a ledger entry. */
export const TRUTH_SOURCE_PREFIX = 'truth:';
