/**
 * Truth Ledger Interop — JSONL codec and consumption-rule selection
 *
 * Reads and writes stenographer's append-only wiki JSONL format
 * losslessly. One entry per line; later lines for the same id supersede
 * earlier ones (the ledger is append-only, so a status change arrives as
 * a re-emitted line). Fields this package does not interpret — the
 * namespaced `x-steno` key, unknown top-level keys, unknown status values —
 * are preserved modulo JSON key order, so
 * `serializeWikiEntries(parseWikiLines(lines))` round-trips.
 *
 * Fail closed: a line without a status, a TB without a claim or a UV
 * without an assertion is reported as an error, and a status outside the
 * known vocabulary is kept but classified as history — never as truth.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ConsumptionAction,
  TruthEvidence,
  TruthLedgerEntry,
  TruthSelection,
  TruthTbEntry,
  TruthTombstonedLiteral,
  TruthUvEntry,
  TruthVerifyBy,
  WikiEntryLine,
} from './types.js';

// ---------------------------------------------------------------------------
// Line ↔ entry conversion
// ---------------------------------------------------------------------------

function isDistinctiveIdentifier(value: string): boolean {
  return value.length >= 4 && /[A-Za-z]/.test(value);
}

/**
 * Stenographer's write-time rule for a tombstoned literal
 * (`TombstonedLiteralSchema`): every present field is a non-blank string,
 * and a literal without a `subject` must be a distinctive identifier
 * (≥4 chars, contains a letter) — a bare value like "30" can't be matched
 * safely without naming what it's the value of. Returns the reason it's
 * invalid, or null.
 */
export function literalValidationError(literal: unknown): string | null {
  if (!literal || typeof literal !== 'object' || Array.isArray(literal)) return 'a literal must be an object';
  const { dead, subject, current } = literal as Record<string, unknown>;
  if (typeof dead !== 'string' || dead.trim().length === 0) return 'a literal needs a dead value';
  if (subject !== undefined && (typeof subject !== 'string' || subject.trim().length === 0)) {
    return "a literal's subject must be a non-blank string";
  }
  if (current !== undefined && (typeof current !== 'string' || current.trim().length === 0)) {
    return "a literal's current value must be a non-blank string";
  }
  if (subject === undefined && !isDistinctiveIdentifier(dead.trim())) {
    return 'a literal without a subject must be a distinctive identifier (≥4 chars, contains a letter) — name the subject of bare values';
  }
  return null;
}

/** Rejects the whole line when any literal is invalid, as stenographer's import does. */
function validLiterals(literals: unknown[], id: string): TruthTombstonedLiteral[] {
  for (const literal of literals) {
    const reason = literalValidationError(literal);
    if (reason) throw new Error(`entry ${id}: invalid literals — ${reason}`);
  }
  // Keep the wiki's objects as-is so the round trip stays byte-stable
  return literals as TruthTombstonedLiteral[];
}

/** Keys the codec maps to typed fields; anything else rides in `extra`. */
const TB_KEYS = new Set(['id', 'type', 'ts', 'author', 'claim', 'evidence', 'signedBy', 'literals', 'status', 'x-steno']);
const UV_KEYS = new Set(['id', 'type', 'ts', 'author', 'assertion', 'basis', 'verifyBy', 'contests', 'status', 'x-steno']);

function extraKeys(line: WikiEntryLine, known: Set<string>): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(line)) {
    if (known.has(key)) continue;
    (extra ??= {})[key] = value;
  }
  return extra;
}

/**
 * Convert one parsed wiki line to a typed entry. Throws on a line that
 * cannot be consumed safely: not an object, no id, an unsupported type,
 * no status, a TB without a claim, a UV without an assertion, or invalid
 * literals. An unknown status is kept verbatim (see `classifyEntry`).
 */
export function wikiLineToEntry(line: WikiEntryLine): TruthLedgerEntry {
  if (typeof line !== 'object' || line === null || Array.isArray(line)) {
    throw new Error('entry is not an object');
  }
  if (!line.id || typeof line.id !== 'string') {
    throw new Error('wiki entry is missing an id');
  }
  if (line.type !== 'TB' && line.type !== 'UV') {
    throw new Error(`unsupported entry type: ${String((line as { type?: unknown }).type)}`);
  }
  if (typeof line.status !== 'string' || line.status.length === 0) {
    throw new Error('missing status');
  }

  if (line.type === 'TB') {
    if (typeof line.claim !== 'string') throw new Error('TB entry missing claim');
    const entry: TruthTbEntry = {
      id: line.id,
      type: 'TB',
      ts: line.ts ?? '',
      author: line.author ?? '',
      claim: line.claim,
      evidence: (line.evidence as TruthEvidence[]) ?? [],
      signedBy: line.signedBy ?? null,
      status: line.status,
    };
    if (Array.isArray(line.literals) && line.literals.length > 0) {
      entry.literals = validLiterals(line.literals, line.id);
    }
    if (line['x-steno'] !== undefined) entry.xSteno = line['x-steno'];
    const extra = extraKeys(line, TB_KEYS);
    if (extra) entry.extra = extra;
    return entry;
  }

  if (typeof line.assertion !== 'string') throw new Error('UV entry missing assertion');
  const entry: TruthUvEntry = {
    id: line.id,
    type: 'UV',
    ts: line.ts ?? '',
    author: line.author ?? '',
    assertion: line.assertion,
    basis: line.basis ?? '',
    verifyBy: (line.verifyBy as TruthVerifyBy) ?? { kind: 'ask', value: line.author ?? '' },
    contests: line.contests ?? null,
    status: line.status,
  };
  if (line['x-steno'] !== undefined) entry.xSteno = line['x-steno'];
  const extra = extraKeys(line, UV_KEYS);
  if (extra) entry.extra = extra;
  return entry;
}

export function entryToWikiLine(entry: TruthLedgerEntry): WikiEntryLine {
  const base = {
    id: entry.id,
    type: entry.type,
    ts: entry.ts,
    author: entry.author,
  };

  if (entry.type === 'TB') {
    const line: WikiEntryLine = {
      ...base,
      claim: entry.claim,
      evidence: entry.evidence,
      signedBy: entry.signedBy,
      // Only present when given, so literal-free TBs keep their exact shape
      ...(entry.literals && entry.literals.length > 0 ? { literals: entry.literals } : {}),
      status: entry.status,
    };
    if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
    return entry.extra ? { ...entry.extra, ...line } : line;
  }

  const line: WikiEntryLine = {
    ...base,
    assertion: entry.assertion,
    basis: entry.basis,
    verifyBy: entry.verifyBy,
    contests: entry.contests,
    status: entry.status,
  };
  if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
  return entry.extra ? { ...entry.extra, ...line } : line;
}

// ---------------------------------------------------------------------------
// Parsing & serialization
// ---------------------------------------------------------------------------

export interface WikiParseResult {
  /** Deduplicated entries — the LAST line for each id wins (append-only ledger). */
  entries: TruthLedgerEntry[];
  /** Lines that could not be parsed; the rest of the file is still usable. */
  errors: Array<{ line: number; error: string }>;
}

/** Parse raw JSONL lines (or one blob with newlines) into ledger entries. */
export function parseWikiLines(input: string | string[]): WikiParseResult {
  const lines = Array.isArray(input) ? input : input.split('\n');
  const byId = new Map<string, TruthLedgerEntry>();
  const errors: WikiParseResult['errors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;
    try {
      const entry = wikiLineToEntry(JSON.parse(raw) as WikiEntryLine);
      // Later lines supersede earlier ones; re-insert to keep append order.
      byId.delete(entry.id);
      byId.set(entry.id, entry);
    } catch (err) {
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries: Array.from(byId.values()), errors };
}

/** Serialize entries back to JSONL lines (no trailing newline handling). */
export function serializeWikiEntries(entries: TruthLedgerEntry[]): string[] {
  return entries.map((e) => JSON.stringify(entryToWikiLine(e)));
}

/** Read and parse a wiki JSONL file. */
export function readWikiFile(path: string): WikiParseResult {
  return parseWikiLines(readFileSync(path, 'utf8'));
}

/** Write entries to a wiki JSONL file (one entry per line). */
export function writeWikiFile(path: string, entries: TruthLedgerEntry[]): void {
  writeFileSync(path, serializeWikiEntries(entries).map((l) => l + '\n').join(''));
}

// ---------------------------------------------------------------------------
// Consumption rules (§7)
// ---------------------------------------------------------------------------

/**
 * Classify a single entry per the §7 consumption rules. Fails closed:
 * anything but an active/contested TB or an open UV — including a status
 * this package does not know — is history.
 */
export function classifyEntry(entry: TruthLedgerEntry): ConsumptionAction {
  if (entry.type === 'TB') {
    if (entry.status === 'active') return 'ground-truth';
    if (entry.status === 'contested') return 'contested';
    return 'history'; // overridden, struck, or unknown
  }
  // UV: open is a flag; verified minted a TB elsewhere, refuted is dead —
  // both are history here, as is any unknown status.
  return entry.status === 'open' ? 'flag' : 'history';
}

/**
 * Partition ledger entries into the selection compaction consumes.
 * Contested TBs are paired with their live contesting UVs so both carry
 * through compaction — the dispute is never resolved silently.
 */
export function selectCurrentTruth(entries: TruthLedgerEntry[]): TruthSelection {
  const selection: TruthSelection = {
    groundTruth: [],
    contested: [],
    unverified: [],
    history: [],
  };

  const openContestsByTb = new Map<string, TruthUvEntry[]>();
  for (const entry of entries) {
    if (entry.type === 'UV' && entry.status === 'open' && entry.contests) {
      const list = openContestsByTb.get(entry.contests) ?? [];
      list.push(entry);
      openContestsByTb.set(entry.contests, list);
    }
  }

  for (const entry of entries) {
    switch (classifyEntry(entry)) {
      case 'ground-truth':
        selection.groundTruth.push(entry as TruthTbEntry);
        break;
      case 'contested':
        selection.contested.push({
          tombstone: entry as TruthTbEntry,
          contestedBy: openContestsByTb.get(entry.id) ?? [],
        });
        break;
      case 'flag':
        selection.unverified.push(entry as TruthUvEntry);
        break;
      case 'history':
        selection.history.push(entry);
        break;
    }
  }

  return selection;
}
