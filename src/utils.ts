/**
 * Shared utilities for @shorthand/core.
 */

/**
 * Estimate token count from a string.
 * Uses the ~4 chars per token heuristic (conservative for English).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate a unique ID (simple, no external deps).
 *
 * Not cryptographically secure and not collision-proof — callers that key
 * a Map/Set by this ID (e.g. ActiveEngramStore) can silently overwrite an
 * existing entry on collision. Fine for the current use (message/engram/
 * summary identifiers, not auth tokens or anything security-sensitive);
 * swap for a stronger generator if collision resistance ever matters.
 */
export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Monotonically increasing Lamport timestamp.
 */
let lamportClock = 0;

export function nextLamport(): number {
  return ++lamportClock;
}

export function updateLamport(received: number): void {
  lamportClock = Math.max(lamportClock, received) + 1;
}

/** Reset for testing. */
export function resetLamport(): void {
  lamportClock = 0;
}
