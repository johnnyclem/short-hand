/**
 * Truth Ledger Interop — rendering and the snapshot compaction bridge
 *
 * Renders the current-truth selection with the suite's frozen markers
 * (`[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`) and wires it into
 * snapshot compaction: the selection rides every `CompactedSnapshot` as
 * high-priority input that survives every level, and compaction may emit
 * its candidate invariants back as PROPOSAL lines. (The LSM engine syncs
 * the same selection via `CompactionEngine.syncTruthLedger`.)
 *
 * The contract this bridge enforces (§7):
 *   - Active TB      → ground truth: compacted, citable.
 *   - Contested TB   → carried WITH its contesting UVs; the dispute is
 *                      never resolved silently in either direction.
 *   - Open UV        → flagged `UNVERIFIED`; compaction never promotes a
 *                      UV into something that reads as proven, and never
 *                      drops one.
 *   - History        → excluded; a stale cached copy is displaced on the
 *                      next sync because the section is always rebuilt.
 *
 * Write direction: proposals only. There is no anonymous write path —
 * generic identities are rejected before a line is ever emitted, and the
 * compactor cannot sign its own output.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type {
  CompactedSnapshot,
  SnapshotLevel,
  SnapshotCompactor,
  ConversationHistory,
} from '../compaction/snapshot/types.js';
import { estimateTokens } from '../utils.js';
import type {
  CompactedTruth,
  ProposalLine,
  TruthConfidence,
  TruthSelection,
  TruthTbEntry,
  TruthUvEntry,
  UvProposalLine,
} from './types.js';
import { TRUTH_SOURCE_PREFIX, assertAccountableAuthor } from './types.js';
import { uvProposal, type ProposeInvariantsOptions } from './proposal-export.js';

export type { ProposeInvariantsOptions } from './proposal-export.js';

// ---------------------------------------------------------------------------
// Rendering — the truth section that rides the compacted summary
// ---------------------------------------------------------------------------

/** Heading of the rendered truth section. */
export const TRUTH_SECTION_HEADING = '## Asserted Truth (ledger)';

function signature(tb: TruthTbEntry): string {
  return tb.signedBy ? `signed: ${tb.signedBy}` : 'unsigned';
}

function renderTb(tb: TruthTbEntry): string {
  return `- [TB] ${tb.claim} (${signature(tb)}, evidence: ${tb.evidence.length})`;
}

function renderUv(uv: TruthUvEntry): string {
  const contests = uv.contests ? `; contests ${uv.contests}` : '';
  return `- [UV — UNVERIFIED] ${uv.assertion} (basis: ${uv.basis}; verify by ${uv.verifyBy.kind}: ${uv.verifyBy.value}${contests})`;
}

/** Ids of open UVs that ride a contested TB in this selection. */
function attachedUvIds(selection: TruthSelection): Set<string> {
  const ids = new Set<string>();
  for (const { contestedBy } of selection.contested) {
    for (const uv of contestedBy) ids.add(uv.id);
  }
  return ids;
}

/**
 * Render a truth selection as marked lines, without the heading. Each
 * open UV appears exactly once: beside its TB when that TB is contested in
 * the selection, standalone otherwise — including a UV contesting a TB the
 * ledger has not (yet) re-emitted as contested.
 */
export function renderTruthLines(selection: TruthSelection): string[] {
  const lines: string[] = [];

  for (const tb of selection.groundTruth) {
    lines.push(renderTb(tb));
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    lines.push(`- [TB ⚠ CONTESTED] ${tombstone.claim} (${signature(tombstone)})`);
    for (const uv of contestedBy) {
      lines.push(`  - disputed by [UV — UNVERIFIED] ${uv.assertion} (${uv.author})`);
    }
  }

  const attached = attachedUvIds(selection);
  for (const uv of selection.unverified) {
    if (attached.has(uv.id)) continue;
    lines.push(renderUv(uv));
  }

  return lines;
}

/**
 * Render a truth selection as the markdown section appended to compacted
 * summaries and placed first in context frames. Markers are load-bearing:
 * `[TB]` may be relied on, `[TB ⚠ CONTESTED]` carries its dispute,
 * `[UV — UNVERIFIED]` is the dragon marker and must never be dropped by
 * deeper compaction.
 */
export function renderTruthSection(selection: TruthSelection): string {
  const lines = renderTruthLines(selection);
  if (lines.length === 0) return `${TRUTH_SECTION_HEADING}\n(no current truth entries)`;
  return [TRUTH_SECTION_HEADING, ...lines].join('\n');
}

/**
 * Attach a truth selection to a compacted snapshot. The section is rebuilt
 * from scratch — any truth text a previous round carried is displaced,
 * which is how overridden TBs and refuted UVs leave the cache.
 */
export function applyTruthToSnapshot(
  state: CompactedSnapshot,
  selection: TruthSelection,
  now: Date = new Date(),
): CompactedSnapshot {
  const truth: CompactedTruth = {
    syncedAt: now.toISOString(),
    groundTruth: selection.groundTruth,
    contested: selection.contested,
    unverified: selection.unverified,
    sourceEntryCount:
      selection.groundTruth.length +
      selection.contested.length +
      selection.unverified.length +
      selection.history.length,
  };

  // Strip any truth section a previous round attached — it is always
  // rebuilt from the current selection, never carried forward as text.
  const markerIdx = state.summary.indexOf(TRUTH_SECTION_HEADING);
  const baseSummary = markerIdx >= 0 ? state.summary.slice(0, markerIdx).trimEnd() : state.summary;

  const summary = `${baseSummary}\n\n${renderTruthSection(selection)}`;

  return {
    ...state,
    summary,
    truth,
    compactedTokenCount: estimateTokens(summary),
  };
}

/** @deprecated Renamed to `applyTruthToSnapshot` (it takes a `CompactedSnapshot`). */
export const applyTruthToCompactedState = applyTruthToSnapshot;

// ---------------------------------------------------------------------------
// TruthAwareCompactor — a SnapshotCompactor decorator
// ---------------------------------------------------------------------------

/**
 * Wraps any SnapshotCompactor so every compacted snapshot carries the current truth
 * selection. The selection is re-applied on recompaction, so deeper levels
 * keep the full section (truth is the durable residue — it never compacts
 * away) and stale entries are displaced.
 */
export class TruthAwareCompactor implements SnapshotCompactor {
  constructor(
    private readonly inner: SnapshotCompactor,
    private selection: TruthSelection,
  ) {}

  /** Replace the selection (e.g. after re-reading the wiki JSONL). */
  sync(selection: TruthSelection): void {
    this.selection = selection;
  }

  async compact(history: ConversationHistory, level: SnapshotLevel): Promise<CompactedSnapshot> {
    const state = await this.inner.compact(history, level);
    return applyTruthToSnapshot(state, this.selection);
  }

  async recompact(state: CompactedSnapshot, targetLevel: SnapshotLevel): Promise<CompactedSnapshot> {
    const next = await this.inner.recompact(state, targetLevel);
    return applyTruthToSnapshot(next, this.selection);
  }
}

// ---------------------------------------------------------------------------
// L4 bridge — invariants with the confidence type riding along
// ---------------------------------------------------------------------------

/** An L4-ready invariant record. The confidence axis must ride along. */
export interface TruthInvariantRecord {
  /** LWW register key (the entry id keeps records collision-free). */
  key: string;
  /** Marked value — the marker travels inside the stored string because L4 registers hold strings. */
  value: string;
  confidence: TruthConfidence;
  contested: boolean;
}

/**
 * Project the current truth selection into L4-shaped invariant records.
 * An L4 invariant is very often actually a UV — tribal knowledge that
 * compacted well but was never verified — so the marker is embedded in
 * the value itself and survives any string-typed store.
 */
export function truthToInvariantRecords(selection: TruthSelection): TruthInvariantRecord[] {
  const records: TruthInvariantRecord[] = [];

  for (const tb of selection.groundTruth) {
    records.push({
      key: `${TRUTH_SOURCE_PREFIX}${tb.id}`,
      value: `[TB] ${tb.claim}`,
      confidence: 'tb',
      contested: false,
    });
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    const disputes = contestedBy.map((uv) => uv.assertion).join(' | ');
    records.push({
      key: `${TRUTH_SOURCE_PREFIX}${tombstone.id}`,
      value: `[TB ⚠ CONTESTED] ${tombstone.claim}${disputes ? ` — disputed: ${disputes}` : ''}`,
      confidence: 'tb',
      contested: true,
    });
  }

  const attached = attachedUvIds(selection);
  for (const uv of selection.unverified) {
    if (attached.has(uv.id)) continue;
    records.push({
      key: `${TRUTH_SOURCE_PREFIX}${uv.id}`,
      value: `[UV — UNVERIFIED] ${uv.assertion}`,
      confidence: 'uv',
      contested: false,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Proposal emission — compaction's only write path toward the ledger
// ---------------------------------------------------------------------------

/**
 * Derive candidate invariants from a compacted state as PROPOSAL lines.
 * Entities that survived compaction with corrections settled, and
 * decisions that were never superseded, are exactly the "tribal knowledge
 * that compacted well but was never verified" the ledger models as UVs —
 * so they are proposed, never asserted.
 */
export function proposeInvariants(
  state: CompactedSnapshot,
  options: ProposeInvariantsOptions,
): UvProposalLine[] {
  assertAccountableAuthor(options.author);
  const proposals: UvProposalLine[] = [];
  const detail = `level ${state.level}, round ${state.roundNumber}, session ${state.sessionId}`;

  const push = (assertion: string, basis: string, targetRef: string, sourceMessageId: string): void => {
    proposals.push(
      uvProposal(
        {
          assertion,
          basis,
          verifyBy: {
            kind: 'inspect',
            value: `message:${sourceMessageId}`,
            detail: 'confirm the compacted value still holds in the source conversation',
          },
        },
        { targetRef, detail, sourceMessageId },
        options,
      ),
    );
  };

  for (const entity of state.entities) {
    if (entity.type !== 'configuration') continue;
    const settled =
      entity.corrections.length > 0
        ? ` (settled after ${entity.corrections.length} correction${entity.corrections.length === 1 ? '' : 's'})`
        : '';
    push(
      `${entity.name} is ${String(entity.value)}.`,
      `Compacted from session ${state.sessionId}${settled}; last mentioned in message ${entity.lastMention}.`,
      `entity:${state.sessionId}:${entity.name}`,
      entity.lastMention,
    );
  }

  for (const decision of state.decisions) {
    if (decision.supersededBy) continue;
    push(
      `Decision holds: ${decision.description}.`,
      `Recorded at message ${decision.madeAt} in session ${state.sessionId}; ${decision.alternatives.length} alternative(s) rejected.`,
      `decision:${state.sessionId}:${decision.id}`,
      decision.madeAt,
    );
  }

  return proposals;
}

/** Serialize proposals as JSONL lines. */
export function serializeProposals(proposals: ProposalLine[]): string[] {
  return proposals.map((p) => JSON.stringify(p));
}

/**
 * Append proposals to a JSONL file (created if absent), deduplicating by
 * `targetRef` against lines already present so repeated compaction rounds
 * do not re-propose the same invariant.
 */
export function appendProposalsFile(
  path: string,
  proposals: ProposalLine[],
): { written: number; skipped: number } {
  const existingRefs = new Set<string>();
  if (existsSync(path)) {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { targetRef?: string | null };
        if (parsed.targetRef) existingRefs.add(parsed.targetRef);
      } catch {
        // Foreign or malformed lines never block the append path.
      }
    }
  }

  const fresh = proposals.filter((p) => !p.targetRef || !existingRefs.has(p.targetRef));
  if (fresh.length > 0) {
    appendFileSync(path, serializeProposals(fresh).map((l) => l + '\n').join(''));
  }
  return { written: fresh.length, skipped: proposals.length - fresh.length };
}
