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
import type { ActiveEngramStore } from '../crdt/active-engram-store.js';
import type { TruthLedgerLine, TruthLedgerView, TruthSyncResult } from '../truth/types.js';
import {
  buildTruthLedgerView,
  displaceStaleInvariants,
  parseTruthLedgerJsonl,
  renderTruthSection,
} from '../truth/ledger-sync.js';

/**
 * Share of the context budget held back for the most recent raw (L0)
 * messages before L3–L1 fill, so a large L1 can't crowd them out.
 */
const L0_RESERVE_SHARE = 0.25;

export class CompactionEngine {
  private config: CompactionConfig;
  private compactor: Compactor;
  private state: CompactedState;
  private activeEngramStore?: ActiveEngramStore;
  private truthView?: TruthLedgerView;

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

  /**
   * Sync a truth-ledger snapshot (stenographer TB/UV v2 JSONL export).
   *
   * The synced view lives beside the LSM levels, not inside them:
   * recompaction can rewrite L4, but it can never rewrite ledger truth,
   * and a UV must never compact into something that reads as proven.
   * Syncing also displaces any L4 invariant projected from an entry that
   * has since been overridden, refuted, or contested.
   */
  syncTruthLedger(input: string | string[] | TruthLedgerLine[]): TruthSyncResult {
    let entries: TruthLedgerLine[];
    let errors: TruthSyncResult['errors'] = [];

    if (typeof input === 'string' || typeof input[0] === 'string' || input.length === 0) {
      const parsed = parseTruthLedgerJsonl(input as string | string[]);
      entries = parsed.entries;
      errors = parsed.errors;
    } else {
      entries = input as TruthLedgerLine[];
    }

    const view = buildTruthLedgerView(entries);
    const { kept, displacedKeys } = displaceStaleInvariants(this.state.l4_invariants, view);
    this.state.l4_invariants = kept;
    this.truthView = view;

    return { view, displacedInvariantKeys: displacedKeys, errors };
  }

  /** The most recently synced truth-ledger view, if any. */
  getTruthView(): TruthLedgerView | undefined {
    return this.truthView;
  }

  /** Build a context frame within the token budget. */
  buildContextFrame(tokenBudget?: number): ContextFrame {
    const budget = tokenBudget ?? this.config.contextBudget;
    const sections: ContextSection[] = [];
    let used = 0;

    // Truth ledger: asserted truth outranks everything derived — it takes
    // budget first, and contested entries always carry both sides.
    if (this.truthView) {
      const truthLines = renderTruthSection(this.truthView);
      if (truthLines.length > 0) {
        const content = truthLines.join('\n');
        const tokens = estimateTokens(content);
        if (used + tokens <= budget) {
          sections.push({ level: CL.L4_INVARIANTS, content, tokenEstimate: tokens });
          used += tokens;
        }
      }
    }

    // Tombstone annotations: corrections outrank every derived level, so
    // they take budget right after the ledger. Newest corrections win when
    // they don't all fit (5% overflow allowed); emitted oldest-first.
    if (this.state.tombstones.length > 0) {
      const tombstoneLines: string[] = [];
      let tombstoneTokens = 0;
      for (const t of [...this.state.tombstones].reverse()) {
        const line = `[correction] "${t.supersededContent}" was corrected to "${t.correctedValue ?? '(unspecified)'}" — ${t.reason}`;
        const lineTokens = estimateTokens(line);
        if (used + tombstoneTokens + lineTokens > budget * 1.05) break;
        tombstoneLines.unshift(line);
        tombstoneTokens += lineTokens;
      }
      if (tombstoneLines.length > 0) {
        sections.push({
          level: CL.L4_INVARIANTS,
          content: tombstoneLines.join('\n'),
          tokenEstimate: tombstoneTokens,
        });
        used += tombstoneTokens;
      }
    }

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

    // L0 reservation: hold back up to L0_RESERVE_SHARE of the budget for
    // the most recent raw messages so derived levels can't starve them.
    // L0 is still emitted last; the reserve only caps what L3–L1 may take.
    const l0Reserve = Math.min(budget - used, Math.floor(budget * L0_RESERVE_SHARE));
    let reservedL0Tokens = 0;
    for (const msg of [...this.state.l0_messages].reverse()) {
      const lineTokens = estimateTokens(`${msg.role}: ${msg.content}`);
      if (reservedL0Tokens + lineTokens > l0Reserve) break;
      reservedL0Tokens += lineTokens;
    }
    const derivedBudget = budget - reservedL0Tokens;

    // Active engrams — interpreter step runs here, before injection.
    // Emitted at L4 level, so budgeted where they're emitted (after the
    // L0 reserve, ahead of L3–L1).
    if (this.activeEngramStore) {
      // Build a brief context string from the most recent L0 messages
      const recentContext = this.state.l0_messages
        .slice(-3)
        .map((m) => m.content)
        .join(' ');
      const results = this.activeEngramStore.retrieve(recentContext);
      if (results.length > 0) {
        const lines = results.map(
          (r) => `[memory] ${r.interpreted}`,
        );
        const content = lines.join('\n');
        const tokens = estimateTokens(content);
        if (used + tokens <= derivedBudget) {
          sections.push({ level: CL.L4_INVARIANTS, content, tokenEstimate: tokens });
          used += tokens;
        }
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
      if (used + tokens <= derivedBudget) {
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
      if (used + l2Tokens + lineTokens > derivedBudget) break;
      l2Lines.push(line);
      l2Tokens += lineTokens;
    }
    if (l2Lines.length > 0) {
      const content = l2Lines.join('\n');
      sections.push({ level: CL.L2_SUMMARIES, content, tokenEstimate: l2Tokens });
      used += l2Tokens;
    }

    // L1: Compacted history. Selected high importance first (ties: most
    // recent first), then emitted in conversation order.
    const rankedL1 = this.state.l1_compacted
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.importance - a.entry.importance || b.index - a.index);
    const selectedL1: Array<{ entry: CompactedState['l1_compacted'][number]; index: number }> = [];
    let l1Tokens = 0;
    for (const item of rankedL1) {
      const lineTokens = estimateTokens(item.entry.compacted);
      if (used + l1Tokens + lineTokens > derivedBudget) break;
      selectedL1.push(item);
      l1Tokens += lineTokens;
    }
    if (selectedL1.length > 0) {
      const content = selectedL1
        .sort((a, b) => a.index - b.index)
        .map((item) => item.entry.compacted)
        .join('\n');
      sections.push({ level: CL.L1_COMPACTED, content, tokenEstimate: l1Tokens });
      used += l1Tokens;
    }

    // L0: Raw recent messages (always last; the reserved share is
    // guaranteed, and older messages fill whatever budget remains)
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

  /** Attach an ActiveEngramStore so agential memories participate in context frames. */
  attachActiveEngrams(store: ActiveEngramStore): void {
    this.activeEngramStore = store;
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
