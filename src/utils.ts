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
