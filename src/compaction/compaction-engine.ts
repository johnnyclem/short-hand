/**
 * CompactionEngine — orchestrates compaction across tiers and levels.
 *
 * Manages the LSM-tree lifecycle: messages enter L0, get compacted to L1,
 * and progressively merge into deeper levels as the conversation grows.
 */

import type {
  Compactor,
  CompactedState,
  CompactionConfig,
  CompactionLevel,
  ConversationMessage,
  ContextFrame,
  ContextSection,
  Entity,
} from '../types.js';
import { CompactionLevel as CL, DEFAULT_COMPACTION_CONFIG } from '../types.js';
import { estimateTokens } from '../utils.js';
import { RegexCompactor } from './regex-compactor.js';

export class CompactionEngine {
  private config: CompactionConfig;
  private compactor: Compactor;
  private state: CompactedState;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this.compactor = this.resolveCompactor();
    this.state = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };
  }

  /** Add a new message. Triggers compaction if L0 exceeds memtable size. */
  async addMessage(message: ConversationMessage): Promise<void> {
    this.state.l0_messages.push(message);

    if (this.state.l0_messages.length > this.config.memtableSize) {
      await this.flush();
    }
  }

  /** Add multiple messages at once. */
  async addMessages(messages: ConversationMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.addMessage(msg);
    }
  }

  /** Force a compaction pass, flushing L0 into L1+. */
  async flush(): Promise<void> {
    const overflow = this.state.l0_messages.splice(
      0,
      this.state.l0_messages.length - this.config.memtableSize,
    );

    if (overflow.length > 0) {
      this.state = await this.compactor.compact(overflow, CL.L1_COMPACTED, this.state);
    }
  }

  /** Trigger a deeper recompaction (L1→L2, L2→L3, etc.). */
  async recompact(targetLevel: CompactionLevel): Promise<void> {
    this.state = await this.compactor.recompact(this.state, targetLevel);
  }

  /** Build a context frame within the token budget. */
  buildContextFrame(tokenBudget?: number): ContextFrame {
    const budget = tokenBudget ?? this.config.contextBudget;
    const sections: ContextSection[] = [];
    let used = 0;

    // L4: Core invariants (always included, minimal cost)
    if (this.state.l4_invariants.length > 0) {
      const content = this.state.l4_invariants
        .map((inv) => `[invariant] ${inv.key}: ${inv.value}`)
        .join('\n');
      const tokens = estimateTokens(content);
      if (used + tokens <= budget) {
        sections.push({ level: CL.L4_INVARIANTS, content, tokenEstimate: tokens });
        used += tokens;
      }
    }

    // L3: Entity-relationship graph (relevant subset)
    if (this.state.l3_graph.entities.size > 0) {
      const entities = Array.from(this.state.l3_graph.entities.values());
      const edges = this.state.l3_graph.edges;
      const graphLines: string[] = [];
      for (const entity of entities) {
        graphLines.push(`[entity] ${entity.name} (${entity.type})`);
      }
      for (const edge of edges) {
        graphLines.push(`[edge] ${edge.source} --${edge.relation}--> ${edge.target}`);
      }
      const content = graphLines.join('\n');
      const tokens = estimateTokens(content);
      if (used + tokens <= budget) {
        sections.push({ level: CL.L3_GRAPH, content, tokenEstimate: tokens });
        used += tokens;
      }
    }

    // L2: Topic summaries (most recent first)
    const sortedSummaries = [...this.state.l2_summaries].reverse();
    const l2Lines: string[] = [];
    let l2Tokens = 0;
    for (const summary of sortedSummaries) {
      const line = `[${summary.topic}] ${summary.summary}`;
      const lineTokens = estimateTokens(line);
      if (used + l2Tokens + lineTokens > budget) break;
      l2Lines.push(line);
      l2Tokens += lineTokens;
    }
    if (l2Lines.length > 0) {
      const content = l2Lines.join('\n');
      sections.push({ level: CL.L2_SUMMARIES, content, tokenEstimate: l2Tokens });
      used += l2Tokens;
    }

    // L1: Compacted history (most recent first, high importance first)
    const sortedL1 = [...this.state.l1_compacted]
      .sort((a, b) => b.importance - a.importance)
      .reverse();
    const l1Lines: string[] = [];
    let l1Tokens = 0;
    for (const entry of sortedL1) {
      const lineTokens = estimateTokens(entry.compacted);
      if (used + l1Tokens + lineTokens > budget) break;
      l1Lines.push(entry.compacted);
      l1Tokens += lineTokens;
    }
    if (l1Lines.length > 0) {
      const content = l1Lines.join('\n');
      sections.push({ level: CL.L1_COMPACTED, content, tokenEstimate: l1Tokens });
      used += l1Tokens;
    }

    // L0: Raw recent messages (always last, fill remaining budget)
    const l0Lines: string[] = [];
    let l0Tokens = 0;
    for (const msg of [...this.state.l0_messages].reverse()) {
      const line = `${msg.role}: ${msg.content}`;
      const lineTokens = estimateTokens(line);
      if (used + l0Tokens + lineTokens > budget) break;
      l0Lines.unshift(line);
      l0Tokens += lineTokens;
    }
    if (l0Lines.length > 0) {
      const content = l0Lines.join('\n');
      sections.push({ level: CL.L0_MEMTABLE, content, tokenEstimate: l0Tokens });
      used += l0Tokens;
    }

    // Tombstone annotations
    if (this.state.tombstones.length > 0) {
      const tombstoneContent = this.state.tombstones
        .map(
          (t) =>
            `[correction] "${t.supersededContent}" was corrected to "${t.correctedValue ?? '(unspecified)'}" — ${t.reason}`,
        )
        .join('\n');
      const tombstoneTokens = estimateTokens(tombstoneContent);
      // Tombstones are critical — always try to include them
      if (used + tombstoneTokens <= budget * 1.05) {
        // Allow 5% overflow for tombstones
        sections.unshift({
          level: CL.L4_INVARIANTS,
          content: tombstoneContent,
          tokenEstimate: tombstoneTokens,
        });
        used += tombstoneTokens;
      }
    }

    return { tokenBudget: budget, tokenUsage: used, sections };
  }

  /** Get the current compacted state. */
  getState(): CompactedState {
    return this.state;
  }

  /** Get the current L0 messages. */
  getMemtable(): ConversationMessage[] {
    return this.state.l0_messages;
  }

  /** Replace the compactor (e.g., when upgrading from regex to host LLM). */
  setCompactor(compactor: Compactor): void {
    this.compactor = compactor;
  }

  private resolveCompactor(): Compactor {
    // For v0.1.0, only regex is implemented
    switch (this.config.preferredTier) {
      case 'regex':
        return new RegexCompactor();
      case 'local':
      case 'host':
        if (this.config.autoFallback) {
          return new RegexCompactor();
        }
        throw new Error(`Compactor tier "${this.config.preferredTier}" not yet implemented`);
      default:
        return new RegexCompactor();
    }
  }
}
