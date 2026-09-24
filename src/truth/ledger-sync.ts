/**
 * Ledger sync — parse stenographer's JSONL export and bucket entries by
 * the downstream consumption rules (stenographer PRD §7):
 *
 * - Active TB        → ground truth. Cite it, compact it, rely on it.
 * - Contested TB     → ground truth with a visible asterisk: the TB and its
 *                      contesting UV(s) travel together, always.
 * - Open UV          → flag, don't block. Never rendered as proven.
 * - Refuted UV /
 *   overridden TB    → history. Excluded from current truth; anything a
 *                      compaction level cached from one gets displaced.
 */

import type { Invariant } from '../types.js';
import type {
  CitableTruth,
  TruthLedgerLine,
  TruthLedgerView,
} from './types.js';
import { TRUTH_SOURCE_PREFIX } from './types.js';

export interface ParseResult {
  entries: TruthLedgerLine[];
  errors: Array<{ line: number; error: string }>;
}

/**
 * Parses append-only JSONL. The file is append-only, so a re-exported entry
 * can appear more than once as its status changes — the last occurrence of
 * an id wins.
 */
export function parseTruthLedgerJsonl(input: string | string[]): ParseResult {
  const lines = Array.isArray(input) ? input : input.split('\n');
  const byId = new Map<string, TruthLedgerLine>();
  const errors: ParseResult['errors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const validation = validateLine(parsed);
    if (validation !== null) {
      errors.push({ line: i + 1, error: validation });
      continue;
    }

    const entry = parsed as TruthLedgerLine;
    byId.delete(entry.id); // re-insert so later lines also win on ordering
    byId.set(entry.id, entry);
  }

  return { entries: Array.from(byId.values()), errors };
}

function validateLine(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'entry is not an object';
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return 'missing id';
  if (obj.type !== 'TB' && obj.type !== 'UV') return `unsupported entry type: ${String(obj.type)}`;
  if (typeof obj.status !== 'string' || obj.status.length === 0) return 'missing status';
  if (obj.type === 'TB' && typeof obj.claim !== 'string') return 'TB entry missing claim';
  if (obj.type === 'UV' && typeof obj.assertion !== 'string') return 'UV entry missing assertion';
  return null;
}

/** Buckets parsed entries per the consumption rules. */
export function buildTruthLedgerView(entries: TruthLedgerLine[]): TruthLedgerView {
  const citable: CitableTruth[] = [];
  const flags: TruthLedgerLine[] = [];
  const displaced: TruthLedgerLine[] = [];

  const openUvsByContest = new Map<string, TruthLedgerLine[]>();
  const attachedUvIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'UV' || entry.status !== 'open') continue;
    if (typeof entry.contests === 'string' && entry.contests.length > 0) {
      const list = openUvsByContest.get(entry.contests) ?? [];
      list.push(entry);
      openUvsByContest.set(entry.contests, list);
    }
  }

  for (const entry of entries) {
    if (entry.type === 'TB') {
      if (entry.status === 'active' || entry.status === 'contested') {
        const contestedBy = entry.status === 'contested' ? (openUvsByContest.get(entry.id) ?? []) : [];
        for (const uv of contestedBy) attachedUvIds.add(uv.id);
        citable.push({ entry, contestedBy });
      } else {
        displaced.push(entry);
      }
    }
  }

  for (const entry of entries) {
    if (entry.type !== 'UV') continue;
    if (entry.status === 'open') {
      if (!attachedUvIds.has(entry.id)) flags.push(entry);
    } else {
      // Refuted: never citable. Verified: superseded by the TB minted from
      // it — the TB carries the truth now, the UV is lineage.
      displaced.push(entry);
    }
  }

  return { citable, flags, displaced };
}

// ---------------------------------------------------------------------------
// Rendering — how ledger entries read inside a context frame
// ---------------------------------------------------------------------------

/**
 * Renders the view as context-frame lines, citable truth first, then
 * unverified flags. A UV line always says "unverified" — the dragon marker
 * only works if you can see it.
 */
export function renderTruthSection(view: TruthLedgerView): string[] {
  const lines: string[] = [];

  for (const { entry, contestedBy } of view.citable) {
    const signer = entry.signedBy ? ` (signed: ${entry.signedBy})` : '';
    if (contestedBy.length === 0) {
      lines.push(`[truth] ${entry.claim}${signer}`);
    } else {
      lines.push(`[truth, contested] ${entry.claim}${signer}`);
      for (const uv of contestedBy) {
        lines.push(`  [disputed by unverified assertion] ${uv.assertion}`);
      }
    }
  }

  for (const uv of view.flags) {
    const basis = uv.basis ? ` — basis: ${uv.basis}` : '';
    lines.push(`[unverified] ${uv.assertion}${basis}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// L4 projection — opt-in, displacement-aware
// ---------------------------------------------------------------------------

/**
 * Projects a citable TB into an L4 invariant for hosts that consume only
 * invariants. The `truth:` sourceMessage prefix is the displacement hook:
 * on the next sync, any projected invariant whose ledger entry is no longer
 * citable is removed. Contested TBs are deliberately not projectable — an
 * invariant row cannot carry the asterisk, so contested truth must flow
 * through the context-frame rendering, both sides visible.
 */
export function citableToInvariant(citable: CitableTruth): Invariant | null {
  if (citable.contestedBy.length > 0) return null;
  const entry = citable.entry;
  return {
    key: entry.id,
    value: entry.claim ?? '',
    sourceMessage: `${TRUTH_SOURCE_PREFIX}${entry.id}`,
    timestamp: Date.parse(entry.ts) || 0,
  };
}

/**
 * Removes invariants whose backing ledger entry is displaced or contested.
 * Returns the surviving invariants and the keys removed. Invariants not
 * sourced from the ledger are untouched.
 */
export function displaceStaleInvariants(
  invariants: Invariant[],
  view: TruthLedgerView,
): { kept: Invariant[]; displacedKeys: string[] } {
  const stillCitable = new Set(
    view.citable.filter((c) => c.contestedBy.length === 0).map((c) => c.entry.id),
  );
  const kept: Invariant[] = [];
  const displacedKeys: string[] = [];

  for (const inv of invariants) {
    if (!inv.sourceMessage.startsWith(TRUTH_SOURCE_PREFIX)) {
      kept.push(inv);
      continue;
    }
    const id = inv.sourceMessage.slice(TRUTH_SOURCE_PREFIX.length);
    if (stillCitable.has(id)) {
      kept.push(inv);
    } else {
      displacedKeys.push(inv.key);
    }
  }

  return { kept, displacedKeys };
}
