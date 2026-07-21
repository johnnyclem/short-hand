/**
 * Observed-Remove Set (OR-Set)
 *
 * Used for L3 knowledge graph nodes. Add-wins semantics:
 * if one replica adds an element while another removes it, the add wins.
 */

interface TaggedElement<T> {
  value: T;
  /** Unique tag per add operation. */
  tag: string;
  agentId: string;
}

export class ORSet<T> {
  private elements = new Map<string, TaggedElement<T>>();
  private removed = new Set<string>();
  private tagCounter = 0;

  constructor(private agentId: string) {}

  private makeTag(): string {
    return `${this.agentId}:${++this.tagCounter}`;
  }

  /** Serialize value to a stable key for lookup. */
  private keyOf(value: T): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  add(value: T): string {
    const tag = this.makeTag();
    this.elements.set(tag, { value, tag, agentId: this.agentId });
    return tag;
  }

  remove(value: T): void {
    const key = this.keyOf(value);
    for (const [tag, elem] of this.elements) {
      if (this.keyOf(elem.value) === key) {
        this.removed.add(tag);
        this.elements.delete(tag);
      }
    }
  }

  has(value: T): boolean {
    const key = this.keyOf(value);
    for (const elem of this.elements.values()) {
      if (this.keyOf(elem.value) === key) return true;
    }
    return false;
  }

  values(): T[] {
    // Deduplicate by value key
    const seen = new Set<string>();
    const result: T[] = [];
    for (const elem of this.elements.values()) {
      const key = this.keyOf(elem.value);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(elem.value);
      }
    }
    return result;
  }

  get size(): number {
    return this.values().length;
  }

  merge(other: ORSet<T>): void {
    // Add-wins: add all elements from other that we haven't removed
    for (const [tag, elem] of other.elements) {
      if (!this.removed.has(tag)) {
        this.elements.set(tag, { ...elem });
      }
    }

    // Apply other's removes to our elements
    for (const tag of other.removed) {
      this.removed.add(tag);
      this.elements.delete(tag);
    }
  }

  serialize(): { elements: Array<[string, TaggedElement<T>]>; removed: string[] } {
    return {
      elements: Array.from(this.elements.entries()),
      removed: Array.from(this.removed),
    };
  }

  static deserialize<T>(agentId: string, data: { elements: Array<[string, TaggedElement<T>]>; removed: string[] }): ORSet<T> {
    const set = new ORSet<T>(agentId);
    for (const [tag, elem] of data.elements) {
      set.elements.set(tag, elem);
    }
    for (const tag of data.removed) {
      set.removed.add(tag);
    }
    // Restore the tag counter past any tags this agent already issued, so new
    // adds after a round-trip cannot collide with existing (or removed) tags.
    const prefix = `${agentId}:`;
    for (const tag of [...set.elements.keys(), ...set.removed]) {
      if (tag.startsWith(prefix)) {
        const n = Number(tag.slice(prefix.length));
        if (Number.isFinite(n) && n > set.tagCounter) {
          set.tagCounter = n;
        }
      }
    }
    return set;
  }
}
