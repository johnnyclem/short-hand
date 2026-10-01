/**
 * Context-frame rendering — the single escaping renderer.
 *
 * Every frame line starts with a fixed marker that says what it is and
 * where it came from: the suite's frozen truth markers (`[TB]`,
 * `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`, RELEASE-PLAN Addendum A) and
 * this package's section markers (`[correction]`, `[invariant]`,
 * `[memory]`, `[code …]`, `[entity]`, `[edge]`, `[summary]`). Text that
 * comes from messages, tool output, ledger fields or engrams is untrusted:
 * it goes through `escapeUntrusted`, so it can never produce a marker — a
 * tool result containing "\n[TB] …" renders as "\[TB] …", never as ledger
 * truth.
 */

import type { CodeSpan, CompactedEntry, ContextFrame } from '../types.js';
import { estimateTokens } from '../utils.js';

/** Frozen truth markers, escaped wherever they appear in untrusted text. */
const FROZEN_MARKER_RE = /\[(?=[ \t]*(?:TB|UV)\b)/g;

/** Section markers, escaped when untrusted text puts them at a line start. */
const LINE_MARKER_RE =
  /^([ \t>*+-]*)\[(?=[ \t]*(?:truth|correction|invariant|memory|code|entity|edge|summary|history|recent)\b)/gim;

/** The truth-section heading, escaped when untrusted text reproduces it. */
const TRUTH_HEADING_RE = /^([ \t]*)(#{1,6}[ \t]*Asserted Truth\b)/gim;

/** Fenced code blocks: inside them only the frozen markers are escaped. */
const FENCE_RE = /```[\s\S]*?```/g;

export interface EscapeOptions {
  /**
   * Collapse line breaks to single spaces. Used for single-line items
   * (ledger fields, corrections, invariants, memories, graph and summary
   * lines); multi-line items (messages, code) keep their newlines.
   */
  singleLine?: boolean;
}

function escapeProse(text: string): string {
  return text
    .replace(FROZEN_MARKER_RE, '\\[')
    .replace(LINE_MARKER_RE, '$1\\[')
    .replace(TRUTH_HEADING_RE, '$1\\$2');
}

/**
 * Neutralize marker syntax in untrusted text: a `\` goes in front of any
 * frozen truth marker (`[TB…`, `[UV…`, anywhere), any section marker at a
 * line start, and a reproduced truth heading. Inside fenced code blocks
 * only the frozen markers are escaped, so code (an INI `[memory]` section,
 * a `# Asserted Truth` comment) keeps its text. Everything else is left
 * byte-for-byte.
 */
export function escapeUntrusted(text: string, options: EscapeOptions = {}): string {
  if (options.singleLine) {
    return escapeProse(text.replace(/[ \t]*(?:\r\n|[\r\n\u2028\u2029])+[ \t]*/g, ' '));
  }
  let out = '';
  let last = 0;
  for (const fence of text.matchAll(FENCE_RE)) {
    out += escapeProse(text.slice(last, fence.index));
    out += fence[0].replace(FROZEN_MARKER_RE, '\\[');
    last = fence.index! + fence[0].length;
  }
  return out + escapeProse(text.slice(last));
}

/** The frame as one string: section contents joined by newlines. */
export function renderContextFrame(frame: ContextFrame): string {
  return frame.sections.map((s) => s.content).join('\n');
}

/** Short form of a span hash shown in references. */
export function spanRef(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Exact budget accounting for a frame rendered as lines joined by `\n`.
 * `tokens()` always equals `estimateTokens(renderContextFrame(frame))`.
 */
export class FrameBudget {
  private chars = 0;
  private lines = 0;

  constructor(private readonly budget: number) {}

  /** Characters `texts` would add as new lines. */
  private cost(texts: string[]): number {
    let added = 0;
    let lines = this.lines;
    for (const text of texts) {
      added += (lines > 0 ? 1 : 0) + text.length;
      lines += 1;
    }
    return added;
  }

  /** True when all `texts` fit, leaving `reserveChars` untouched. */
  fits(texts: string[], reserveChars = 0): boolean {
    return Math.ceil((this.chars + this.cost(texts) + reserveChars) / 4) <= this.budget;
  }

  take(texts: string[]): void {
    this.chars += this.cost(texts);
    this.lines += texts.length;
  }

  tokens(): number {
    return Math.ceil(this.chars / 4);
  }
}

/**
 * Render an L1 entry. Code spans are kept verbatim; with `referenceSpans`
 * (all of them, or the given hashes) a span is replaced by a
 * `[code sha256:…]` reference that `CompactionEngine.getSpan` resolves.
 */
export function renderEntry(
  entry: CompactedEntry,
  spans: Record<string, CodeSpan> | undefined,
  referenceSpans: boolean | Set<string> = false,
): string {
  const segments: Array<{ text: string; span?: CodeSpan }> = [];
  let rest = entry.compacted;
  for (const hash of entry.spanIds ?? []) {
    const span = spans?.[hash];
    if (!span) continue;
    const at = rest.indexOf(span.text);
    if (at === -1) continue;
    if (at > 0) segments.push({ text: rest.slice(0, at) });
    segments.push({ text: span.text, span });
    rest = rest.slice(at + span.text.length);
  }
  if (rest) segments.push({ text: rest });

  return segments
    .map(({ text, span }) => {
      const reference =
        span && (referenceSpans === true || (referenceSpans instanceof Set && referenceSpans.has(span.hash)));
      if (!reference) return escapeUntrusted(text);
      return `[code sha256:${spanRef(span!.hash)} — ${estimateTokens(span!.text)} tokens, not shown]`;
    })
    .join('');
}
