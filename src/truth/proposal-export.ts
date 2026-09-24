/**
 * Proposal export — short-hand's write path toward the truth ledger.
 *
 * Short-hand may only propose, never assert: candidate invariants and
 * detected corrections go out as PROPOSAL drafts for an accountable author
 * to sign (or dismiss) on the stenographer side. An L4 invariant is very
 * often actually a UV — tribal knowledge that compacted well but was never
 * verified — so candidates are drafted as UVs, not TBs.
 *
 * Entries that were themselves projected from the ledger are skipped:
 * proposing the ledger's own truth back to it would be a corroboration
 * loop, and stenographer's provenance-independence check exists precisely
 * to reject that.
 */

import type { CompactedState } from '../types.js';
import type { ProposalDraftLine } from './types.js';
import { TRUTH_SOURCE_PREFIX } from './types.js';

/** Drafts one UV proposal per L4 invariant not sourced from the ledger. */
export function invariantsToProposalDrafts(state: CompactedState): ProposalDraftLine[] {
  const drafts: ProposalDraftLine[] = [];

  for (const inv of state.l4_invariants) {
    if (inv.sourceMessage.startsWith(TRUTH_SOURCE_PREFIX)) continue;

    drafts.push({
      kind: 'uv',
      draft: {
        assertion: `The invariant "${inv.key}" holds: ${inv.value}.`,
        basis: `Survived short-hand compaction to L4 (established in message ${inv.sourceMessage}).`,
        verifyBy: {
          kind: 'inspect',
          value: `message:${inv.sourceMessage}`,
          detail: 'confirm the source message still supports this invariant',
        },
      },
      signal: {
        source: 'compaction-candidate',
        detail: `short-hand L4 invariant "${inv.key}"`,
      },
      targetRef: `shorthand:invariant:${inv.key}`,
      provenance: { kind: 'sourceMessageId', ref: inv.sourceMessage },
    });
  }

  return drafts;
}

/** Drafts one tombstone proposal per detected correction. */
export function tombstonesToProposalDrafts(state: CompactedState): ProposalDraftLine[] {
  const drafts: ProposalDraftLine[] = [];

  for (const tomb of state.tombstones) {
    const replacement = tomb.correctedValue ? ` — superseded by "${tomb.correctedValue}"` : '';
    drafts.push({
      kind: 'tombstone',
      draft: {
        claim: `"${tomb.supersededContent}" no longer holds${replacement}. Reason: ${tomb.reason}.`,
        evidence: [
          {
            kind: 'message',
            ref: tomb.correctionMessageId,
            detail: tomb.reason,
          },
        ],
        signedBy: null,
      },
      signal: {
        source: 'compaction-candidate',
        detail: 'short-hand correction tombstone',
      },
      targetRef: `shorthand:tombstone:${tomb.originalMessageId}`,
      provenance: { kind: 'sourceMessageId', ref: tomb.correctionMessageId },
    });
  }

  return drafts;
}

/**
 * Serializes the full candidate set as JSONL lines, one draft per line.
 * Write these to a file stenographer's proposal intake reads.
 */
export function exportProposalDrafts(state: CompactedState): string[] {
  return [...invariantsToProposalDrafts(state), ...tombstonesToProposalDrafts(state)].map((d) =>
    JSON.stringify(d),
  );
}
