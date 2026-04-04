/**
 * Last-Writer-Wins Register (LWW-Register)
 *
 * Used for L4 core invariants and L3 graph edge properties.
 * Merge semantics: latest Lamport timestamp wins.
 */

export interface LWWEntry<T> {
  value: T;
  timestamp: number;
  agentId: string;
}

export class LWWRegister<T> {
  private entries = new Map<string, LWWEntry<T>>();

  constructor(private agentId: string) {}

  set(key: string, value: T, timestamp: number): void {
    const existing = this.entries.get(key);
    if (!existing || timestamp > existing.timestamp) {
      this.entries.set(key, { value, timestamp, agentId: this.agentId });
    }
  }

  get(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  getEntry(key: string): LWWEntry<T> | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  values(): Array<{ key: string; value: T; timestamp: number }> {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({
      key,
      value: entry.value,
      timestamp: entry.timestamp,
    }));
  }

  merge(other: LWWRegister<T>): void {
    for (const [key, otherEntry] of other.entries) {
      const existing = this.entries.get(key);
      if (!existing || otherEntry.timestamp > existing.timestamp) {
        this.entries.set(key, { ...otherEntry });
      }
    }
  }

  serialize(): Array<[string, LWWEntry<T>]> {
    return Array.from(this.entries.entries());
  }

  static deserialize<T>(agentId: string, data: Array<[string, LWWEntry<T>]>): LWWRegister<T> {
    const register = new LWWRegister<T>(agentId);
    for (const [key, entry] of data) {
      register.entries.set(key, entry);
    }
    return register;
  }
}
