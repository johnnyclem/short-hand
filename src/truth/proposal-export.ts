/**
 * Proposal export — @shorthand/core's write path toward the truth ledger.
 *
 * The package may only propose, never assert: candidate invariants and
 * detected corrections go out as PROPOSAL lines (the suite's single
 * envelope, `schemaVersion: 2`) for an accountable author to sign (or
 * dismiss) on the stenographer side. An L4 invariant is very often
 * actually a UV — tribal knowledge that compacted well but was never
 * verified — so candidates are drafted as UVs, and corrections as
 * unsigned TBs. Pattern-inferred corrections are left out unless asked
 * for (`includeInferred`).
 *
 * Entries that were themselves projected from the ledger are skipped:
 * proposing the ledger's own truth back to it would be a corroboration
 * loop, and stenographer's provenance-independence check exists precisely
 * to reject that.
 */

import type { CompactedState } from '../types.js';
import type {
  ProposalLine,
  TbProposalDraft,
  TbProposalLine,
  UvProposalDraft,
  UvProposalLine,
} from './types.js';
import { TRUTH_SOURCE_PREFIX, assertAccountableAuthor, ulid } from './types.js';

/** Who stands behind emitted proposals, and when. */
export interface ProposeInvariantsOptions {
  /** Accountable author — anonymous/generic identities throw. */
  author: string;
  /** Agent session lineage for downstream provenance-independence checks. */
  agentSessionId?: string | null;
  /** Clock injection for deterministic tests. */
  now?: Date;
  /**
   * Also propose corrections that were only inferred by pattern matching
   * (`Tombstone.confidence === 'inferred'`). Default false: inferred
   * corrections are low-confidence suggestions, and filing them would flood
   * the ledger's proposal queue with false positives.
   */
  includeInferred?: boolean;
}

interface ProposalSpec {
  targetRef: string;
  detail: string;
  sourceMessageId?: string;
}

function envelope(spec: ProposalSpec, options: ProposeInvariantsOptions, ts: string) {
  return {
    schemaVersion: 2 as const,
    type: 'PROPOSAL' as const,
    id: ulid(),
    ts,
    author: options.author,
    targetRef: spec.targetRef,
    signal: { source: 'compaction-candidate' as const, detail: spec.detail },
    agentSessionId: options.agentSessionId ?? null,
    ...(spec.sourceMessageId
      ? { provenance: { kind: 'sourceMessageId' as const, ref: spec.sourceMessageId } }
      : {}),
  };
}

/** Build one UV PROPOSAL line. Throws on an anonymous author. */
export function uvProposal(
  draft: UvProposalDraft,
  spec: ProposalSpec,
  options: ProposeInvariantsOptions,
): UvProposalLine {
  assertAccountableAuthor(options.author);
  const ts = (options.now ?? new Date()).toISOString();
  return { ...envelope(spec, options, ts), kind: 'uv', draft };
}

/** Build one TB PROPOSAL line (always unsigned). Throws on an anonymous author. */
export function tbProposal(
  draft: Omit<TbProposalDraft, 'signedBy'>,
  spec: ProposalSpec,
  options: ProposeInvariantsOptions,
): TbProposalLine {
  assertAccountableAuthor(options.author);
  const ts = (options.now ?? new Date()).toISOString();
  return { ...envelope(spec, options, ts), kind: 'tb', draft: { ...draft, signedBy: null } };
}

/** Drafts one UV proposal per L4 invariant not sourced from the ledger. */
export function invariantsToProposalDrafts(
  state: CompactedState,
  options: ProposeInvariantsOptions,
): UvProposalLine[] {
  assertAccountableAuthor(options.author);
  const drafts: UvProposalLine[] = [];

  for (const inv of state.l4_invariants) {
    if (inv.sourceMessage.startsWith(TRUTH_SOURCE_PREFIX)) continue;

    drafts.push(
      uvProposal(
        {
          assertion: `The invariant "${inv.key}" holds: ${inv.value}.`,
          basis: `Survived short-hand compaction to L4 (established in message ${inv.sourceMessage}).`,
          verifyBy: {
            kind: 'inspect',
            value: `message:${inv.sourceMessage}`,
            detail: 'confirm the source message still supports this invariant',
          },
        },
        {
          targetRef: `shorthand:invariant:${inv.key}`,
          detail: `short-hand L4 invariant "${inv.key}"`,
          sourceMessageId: inv.sourceMessage,
        },
        options,
      ),
    );
  }

  return drafts;
}

/**
 * Drafts one (unsigned) TB proposal per correction: explicit ones (and
 * hand-built ones without a confidence), plus inferred ones only with
 * `includeInferred`. A tombstone without a superseded value is never
 * proposed.
 */
export function tombstonesToProposalDrafts(
  state: CompactedState,
  options: ProposeInvariantsOptions,
): TbProposalLine[] {
  assertAccountableAuthor(options.author);
  const drafts: TbProposalLine[] = [];

  for (const tomb of state.tombstones) {
    if (!tomb.supersededContent.trim()) continue;
    if (tomb.confidence === 'inferred' && !options.includeInferred) continue;
    const replacement = tomb.correctedValue ? ` — superseded by "${tomb.correctedValue}"` : '';
    drafts.push(
      tbProposal(
        {
          claim: `"${tomb.supersededContent}" no longer holds${replacement}. Reason: ${tomb.reason}.`,
          evidence: [
            {
              kind: 'message',
              ref: tomb.correctionMessageId,
              detail: tomb.reason,
            },
          ],
        },
        {
          targetRef: `shorthand:tombstone:${tomb.originalMessageId}`,
          detail: 'short-hand correction tombstone',
          sourceMessageId: tomb.correctionMessageId,
        },
        options,
      ),
    );
  }

  return drafts;
}

/**
 * Serializes the full candidate set as JSONL lines, one PROPOSAL per line.
 * Write these to a file stenographer's proposal intake reads.
 */
export function exportProposalDrafts(
  state: CompactedState,
  options: ProposeInvariantsOptions,
): string[] {
  const proposals: ProposalLine[] = [
    ...invariantsToProposalDrafts(state, options),
    ...tombstonesToProposalDrafts(state, options),
  ];
  return proposals.map((p) => JSON.stringify(p));
}
