/**
 * AgentMemory — per-agent compaction state using CRDT primitives.
 *
 * Each agent maintains an AgentMemory instance containing all CRDT layers.
 * Memories can be serialized, transmitted, and merged with other agents' memories.
 */

import type { Entity, TopicSummary } from '../types.js';
import { LWWRegister } from './lww-register.js';
import { ORSet } from './or-set.js';
import { GSet } from './g-set.js';
import { ActiveEngramStore } from './active-engram-store.js';
import { nextLamport, updateLamport } from '../utils.js';
import type { SerializedActiveEngramStore } from './active-engram-store.js';

export interface SerializedAgentMemory {
  agentId: string;
  invariants: Array<[string, { value: string; timestamp: number; agentId: string }]>;
  entities: { elements: Array<[string, { value: Entity; tag: string; agentId: string }]>; removed: string[] };
  summaries: Array<[string, TopicSummary]>;
  activeEngrams?: SerializedActiveEngramStore;
}

export class AgentMemory {
  /** L4: Core invariants — LWW-Register. */
  readonly invariants: LWWRegister<string>;
  /** L3: Knowledge graph entities — OR-Set (add-wins). */
  readonly entities: ORSet<Entity>;
  /** L2: Topic summaries — G-Set (grow-only). */
  readonly summaries: GSet<TopicSummary>;
  /** Agential memory entries — interpret before inject. */
  readonly activeEngrams: ActiveEngramStore;

  constructor(readonly agentId: string) {
    this.invariants = new LWWRegister<string>(agentId);
    this.entities = new ORSet<Entity>(agentId);
    this.summaries = new GSet<TopicSummary>();
    this.activeEngrams = new ActiveEngramStore();
  }

  // -----------------------------------------------------------------------
  // L4: Invariants
  // -----------------------------------------------------------------------

  setInvariant(key: string, value: string): void {
    this.invariants.set(key, value, nextLamport());
  }

  getInvariant(key: string): string | undefined {
    return this.invariants.get(key);
  }

  // -----------------------------------------------------------------------
  // L3: Entities
  // -----------------------------------------------------------------------

  addEntity(entity: Entity): void {
    this.entities.add(entity);
  }

  getEntities(): Entity[] {
    return this.entities.values();
  }

  hasEntity(name: string): boolean {
    return this.entities.values().some((e) => e.name === name);
  }

  // -----------------------------------------------------------------------
  // L2: Summaries
  // -----------------------------------------------------------------------

  addSummary(summary: TopicSummary): void {
    this.summaries.add(summary);
  }

  getSummaries(): TopicSummary[] {
    return this.summaries.values();
  }

  // -----------------------------------------------------------------------
  // Merge
  // -----------------------------------------------------------------------

  mergeFrom(serialized: SerializedAgentMemory): void {
    // Merge invariants
    const otherInvariants = LWWRegister.deserialize<string>(serialized.agentId, serialized.invariants);
    this.invariants.merge(otherInvariants);

    // Update Lamport clock from received timestamps
    for (const [, entry] of serialized.invariants) {
      updateLamport(entry.timestamp);
    }

    // Merge entities
    const otherEntities = ORSet.deserialize<Entity>(serialized.agentId, serialized.entities);
    this.entities.merge(otherEntities);

    // Merge summaries
    const otherSummaries = GSet.deserialize<TopicSummary>(serialized.summaries);
    this.summaries.merge(otherSummaries);

    // Merge active engrams (union by id)
    if (serialized.activeEngrams) {
      this.activeEngrams.mergeFrom(serialized.activeEngrams);
    }
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize(): SerializedAgentMemory {
    return {
      agentId: this.agentId,
      invariants: this.invariants.serialize(),
      entities: this.entities.serialize(),
      summaries: this.summaries.serialize(),
      activeEngrams: this.activeEngrams.serialize(),
    };
  }

  static deserialize(data: SerializedAgentMemory): AgentMemory {
    const memory = new AgentMemory(data.agentId);
    memory.mergeFrom(data);
    return memory;
  }
}
