/**
 * Supersession matching — the one matcher the compactor, the correction
 * API, InvariantChecker and RecallTester share, so "does this text still
 * state a corrected value?" has a single answer everywhere.
 */

import type { Tombstone } from '../types.js';
import { sha256Hex } from '../utils.js';

/** Lowercase, treat _/- as spaces, drop a leading article: "the LOG_BUDGET" → "log budget". */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '');
}

/** Case-sensitive whole-word matcher for an already-normalized phrase. */
export function wholeWordRe(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`);
}

/**
 * Pronouns, determiners and function words. A correction whose superseded
 * value consists only of these ("change it to blue", "replace that with
 * X") names nothing and must never produce a tombstone.
 */
const NON_SUBJECT_WORDS = new Set([
  'it', 'its', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'there', 'here',
  'he', 'she', 'him', 'her', 'his', 'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my',
  'one', 'ones', 'something', 'anything', 'everything', 'nothing', 'stuff', 'thing', 'things',
  'what', 'which', 'who', 'whom', 'whatever',
  'the', 'a', 'an', 'some', 'any', 'all', 'both', 'each', 'every', 'other', 'another',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'so',
  'not', 'no', 'yes', 'ok', 'okay', 'please', 'just', 'also', 'too', 'back', 'up', 'over',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
]);

/** Superseded values longer than this are sentences, not values. */
const MAX_SUBJECT_WORDS = 8;

/**
 * True when `text` can name a superseded value: at least two characters
 * after normalization, at most eight words, and at least one word that is
 * not a pronoun, determiner or function word.
 */
export function isValidCorrectionSubject(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  if (normalized.length < 2) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_SUBJECT_WORDS) return false;
  return words.some((w) => /[a-z0-9]/.test(w) && !NON_SUBJECT_WORDS.has(w.replace(/[^a-z0-9']/g, '')));
}

/**
 * Returns a predicate that is true when a text mentions the tombstone's
 * superseded value (whole word, case-insensitive) without also mentioning
 * the corrected value. A tombstone without a superseded value matches
 * nothing.
 */
export function supersededMatcher(tombstone: Pick<Tombstone, 'supersededContent' | 'correctedValue'>): (text: string) => boolean {
  const old = normalizeForMatch(tombstone.supersededContent ?? '');
  if (!old) return () => false;
  const oldRe = wholeWordRe(old);
  const corrected = normalizeForMatch(tombstone.correctedValue ?? '');
  const correctedRe = corrected ? wholeWordRe(corrected) : undefined;
  return (raw: string) => {
    const text = normalizeForMatch(raw);
    return oldRe.test(text) && !correctedRe?.test(text);
  };
}

/** True when `text` states only the value `tombstone` superseded. */
export function statesOnlySuperseded(
  text: string,
  tombstone: Pick<Tombstone, 'supersededContent' | 'correctedValue'>,
): boolean {
  return supersededMatcher(tombstone)(text);
}

/**
 * Content-derived tombstone id: the same correction from the same message
 * always gets the same id, so re-applying it is a no-op.
 */
export function tombstoneId(parts: Array<string | undefined>): string {
  return `tomb_${sha256Hex(JSON.stringify(parts.map((p) => p ?? null))).slice(0, 16)}`;
}
