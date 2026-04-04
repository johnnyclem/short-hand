/**
 * Grow-Only Set (G-Set)
 *
 * Used for L2 topic summaries. Elements can only be added, never removed.
 * Merge is set union. Simple and safe.
 */

export class GSet<T> {
  private elements = new Map<string, T>();

  /** Serialize value to a stable key. */
  private keyOf(value: T): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  add(value: T): void {
    this.elements.set(this.keyOf(value), value);
  }

  has(value: T): boolean {
    return this.elements.has(this.keyOf(value));
  }

  values(): T[] {
    return Array.from(this.elements.values());
  }

  get size(): number {
    return this.elements.size;
  }

  merge(other: GSet<T>): void {
    for (const [key, value] of other.elements) {
      if (!this.elements.has(key)) {
        this.elements.set(key, value);
      }
    }
  }

  serialize(): Array<[string, T]> {
    return Array.from(this.elements.entries());
  }

  static deserialize<T>(data: Array<[string, T]>): GSet<T> {
    const set = new GSet<T>();
    for (const [key, value] of data) {
      set.elements.set(key, value);
    }
    return set;
  }
}
