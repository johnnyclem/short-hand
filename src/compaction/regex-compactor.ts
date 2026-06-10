/**
 * Tier 0: RegexCompactor
 *
 * Rule-based extraction using pattern matching. Zero external dependencies.
 * Catches obvious patterns like "chose X," "rejected Y because Z," "actually, use W."
 * Estimated recall: ~20-30% of real-world decisions.
 */

import type {
  Compactor,
  CompactedState,
  CompactionLevel,
  ConversationMessage,
  Decision,
  Entity,
  Tombstone,
  TopicSummary,
  Invariant,
} from '../types.js';
import { estimateTokens, generateId } from '../utils.js';

/** Deep clone a CompactedState, preserving Map types. */
function cloneState(state: CompactedState): CompactedState {
  const cloned: CompactedState = {
    l0_messages: state.l0_messages.map((m) => ({ ...m })),
    l1_compacted: state.l1_compacted.map((e) => ({ ...e })),
    l2_summaries: state.l2_summaries.map((s) => ({
      ...s,
      decisions: s.decisions.map((d) => ({
        ...d,
        alternatives: d.alternatives.map((a) => ({ ...a })),
      })),
      entityNames: [...s.entityNames],
      messageRange: { ...s.messageRange },
    })),
    l3_graph: {
      entities: new Map(
        Array.from(state.l3_graph.entities.entries()).map(([k, v]) => [
          k,
          { ...v, properties: { ...v.properties } },
        ]),
      ),
      edges: state.l3_graph.edges.map((e) => ({ ...e, properties: { ...e.properties } })),
    },
    l4_invariants: state.l4_invariants.map((i) => ({ ...i })),
    tombstones: state.tombstones.map((t) => ({ ...t })),
    totalTokenEstimate: state.totalTokenEstimate,
  };
  return cloned;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface PatternMatch {
  type: 'decision' | 'correction' | 'entity' | 'constraint';
  content: string;
  details: Record<string, string>;
}

const DECISION_PATTERNS: Array<{ regex: RegExp; extract: (m: RegExpMatchArray) => PatternMatch }> = [
  {
    regex: /(?:let'?s?|we(?:'ll)?|I(?:'ll)?)\s+(?:go with|use|choose|pick|stick with)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { chosen: m[1].trim() },
    }),
  },
  {
    regex: /(?:chose|decided on|going with|selected|picked)\s+(.+?)(?:\s+(?:over|instead of|rather than)\s+(.+?))?(?:\.|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { chosen: m[1].trim(), ...(m[2] ? { rejected: m[2].trim() } : {}) },
    }),
  },
  {
    regex: /(?:rejected|ruled out|eliminated|won't use|not going with)\s+(.+?)(?:\s+because\s+(.+?))?(?:\.|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { rejected: m[1].trim(), ...(m[2] ? { reason: m[2].trim() } : {}) },
    }),
  },
];

const CORRECTION_PATTERNS: Array<{ regex: RegExp; extract: (m: RegExpMatchArray) => PatternMatch }> = [
  {
    regex: /(?:actually|wait|correction|no,?\s+(?:let's|we should)|instead|scratch that|change that to)\s*[,:]?\s*(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      type: 'correction',
      content: m[0],
      details: { correctedTo: m[1].trim() },
    }),
  },
  {
    regex: /(?:(?:swap|change|switch|replace)\s+(.+?)\s+(?:to|with|for)\s+(.+?))(?:\.|$)/gi,
    extract: (m) => ({
      type: 'correction',
      content: m[0],
      details: { from: m[1].trim(), to: m[2].trim() },
    }),
  },
];

const ENTITY_PATTERNS: Array<{ regex: RegExp; extract: (m: RegExpMatchArray) => PatternMatch }> = [
  {
    regex: /(?:using|implement(?:ing)?|build(?:ing)?|creat(?:e|ing))\s+(?:a\s+)?(.+?)(?:\s+(?:for|to|with|in)\s+(.+?))?(?:\.|$)/gi,
    extract: (m) => ({
      type: 'entity',
      content: m[0],
      details: { name: m[1].trim(), ...(m[2] ? { context: m[2].trim() } : {}) },
    }),
  },
];

const CONSTRAINT_PATTERNS: Array<{ regex: RegExp; extract: (m: RegExpMatchArray) => PatternMatch }> = [
  {
    regex: /(?:must|should|need to|required to|has to|cannot|must not|should not)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      type: 'constraint',
      content: m[0],
      details: { constraint: m[1].trim() },
    }),
  },
];

// ---------------------------------------------------------------------------
// Noise detection
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^(?:ok(?:ay)?|sure|thanks?|thank you|got it|sounds good|great|perfect|yes|no|right|exactly|yep|yup|nope)\.?$/i,
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[\s!.]*$/i,
  /^(?:let me know|feel free|no worries|no problem)[\s.]*$/i,
];

function isNoise(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 5) return true;
  return NOISE_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Code block detection
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /```[\s\S]*?```/g;

function containsCode(content: string): boolean {
  // A `g`-flagged regex is stateful under .test(); search() is not.
  return content.search(CODE_BLOCK_RE) !== -1;
}

// ---------------------------------------------------------------------------
// RegexCompactor
// ---------------------------------------------------------------------------

function extractPatterns(content: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const patterns of [DECISION_PATTERNS, CORRECTION_PATTERNS, ENTITY_PATTERNS, CONSTRAINT_PATTERNS]) {
    for (const { regex, extract } of patterns) {
      // Reset lastIndex for global regexes
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        matches.push(extract(m));
      }
    }
  }

  return matches;
}

function createEmptyState(): CompactedState {
  return {
    l0_messages: [],
    l1_compacted: [],
    l2_summaries: [],
    l3_graph: { entities: new Map(), edges: [] },
    l4_invariants: [],
    tombstones: [],
    totalTokenEstimate: 0,
  };
}

export class RegexCompactor implements Compactor {
  readonly tier = 'regex' as const;

  async compact(
    messages: ConversationMessage[],
    targetLevel: CompactionLevel,
    currentState?: CompactedState,
  ): Promise<CompactedState> {
    const state = currentState ? cloneState(currentState) : createEmptyState();

    for (const msg of messages) {
      this.processMessage(msg, state);
    }

    state.totalTokenEstimate = this.computeTokenEstimate(state);
    return state;
  }

  async recompact(
    state: CompactedState,
    targetLevel: CompactionLevel,
  ): Promise<CompactedState> {
    const result = cloneState(state);

    if (targetLevel >= 2) {
      result.l2_summaries = this.buildTopicSummaries(result);
    }
    if (targetLevel >= 3) {
      this.promoteToGraph(result);
    }
    if (targetLevel >= 4) {
      this.promoteToInvariants(result);
    }

    result.totalTokenEstimate = this.computeTokenEstimate(result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Internal processing
  // -----------------------------------------------------------------------

  private processMessage(msg: ConversationMessage, state: CompactedState): void {
    const patterns = extractPatterns(msg.content);
    const hasCode = containsCode(msg.content);

    // Handle corrections → create tombstones
    for (const match of patterns.filter((p) => p.type === 'correction')) {
      const tombstone: Tombstone = {
        supersededContent: match.details.from ?? '',
        originalMessageId: this.findRelatedMessage(match, state) ?? msg.id,
        correctionMessageId: msg.id,
        reason: match.content,
        timestamp: msg.timestamp,
        key: match.details.from,
        correctedValue: match.details.to ?? match.details.correctedTo,
      };
      state.tombstones.push(tombstone);
    }

    // Handle decisions
    for (const match of patterns.filter((p) => p.type === 'decision')) {
      const decision: Decision = {
        description: match.content,
        chosen: match.details.chosen ?? '',
        alternatives: match.details.rejected
          ? [{ option: match.details.rejected, reason: match.details.reason ?? '' }]
          : [],
        messageId: msg.id,
        superseded: false,
      };
      // Check if this decision supersedes a previous one
      this.checkDecisionSupersession(decision, state);
      // Store as L2 summary fragment
      const summary: TopicSummary = {
        id: generateId(),
        topic: `Decision: ${match.details.chosen}`,
        summary: match.content,
        decisions: [decision],
        entityNames: [],
        messageRange: { first: msg.id, last: msg.id },
        tokenEstimate: estimateTokens(match.content),
      };
      state.l2_summaries.push(summary);
    }

    // Handle entities → add to L3 graph
    for (const match of patterns.filter((p) => p.type === 'entity')) {
      const entityName = match.details.name;
      if (entityName && entityName.length > 1) {
        const existing = state.l3_graph.entities.get(entityName);
        if (existing) {
          existing.lastMention = msg.id;
        } else {
          const entity: Entity = {
            name: entityName,
            type: 'artifact',
            properties: match.details.context ? { context: match.details.context } : {},
            firstMention: msg.id,
            lastMention: msg.id,
          };
          state.l3_graph.entities.set(entityName, entity);
        }
      }
    }

    // Handle constraints → promote to L4 if strong enough
    for (const match of patterns.filter((p) => p.type === 'constraint')) {
      const invariant: Invariant = {
        key: match.details.constraint.slice(0, 50),
        value: match.content,
        sourceMessage: msg.id,
        timestamp: msg.timestamp,
      };
      state.l4_invariants.push(invariant);
    }

    // L1 compaction: strip noise, keep substance
    if (!isNoise(msg.content)) {
      const importance = this.quickImportance(patterns, hasCode);
      let compacted = msg.content;

      // Strip code blocks from compacted text (they're indexed separately)
      if (hasCode) {
        compacted = compacted.replace(CODE_BLOCK_RE, '[code block]');
      }

      // For low-importance messages, strip further
      if (importance < 0.3) {
        compacted = this.stripToEssence(compacted);
      }

      if (compacted.trim()) {
        state.l1_compacted.push({
          originalMessageId: msg.id,
          compacted: compacted.trim(),
          importance,
        });
      }
    }
  }

  private quickImportance(patterns: PatternMatch[], hasCode: boolean): number {
    let score = 0;
    if (patterns.some((p) => p.type === 'correction')) score += 0.4;
    if (patterns.some((p) => p.type === 'decision')) score += 0.3;
    if (patterns.some((p) => p.type === 'constraint')) score += 0.2;
    if (patterns.some((p) => p.type === 'entity')) score += 0.1;
    if (hasCode) score += 0.2;
    return Math.min(1.0, score);
  }

  private stripToEssence(content: string): string {
    // Remove filler phrases
    return content
      .replace(/\b(?:I think|maybe|perhaps|probably|basically|essentially|just|simply)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private findRelatedMessage(match: PatternMatch, state: CompactedState): string | undefined {
    if (!match.details.from) return undefined;
    const needle = match.details.from.toLowerCase();
    for (const entry of state.l1_compacted) {
      if (entry.compacted.toLowerCase().includes(needle)) {
        return entry.originalMessageId;
      }
    }
    return undefined;
  }

  private checkDecisionSupersession(decision: Decision, state: CompactedState): void {
    // Check if any existing decision covers the same topic and should be superseded
    for (const summary of state.l2_summaries) {
      for (const existingDecision of summary.decisions) {
        if (
          existingDecision.chosen &&
          decision.alternatives.some((a) => a.option === existingDecision.chosen)
        ) {
          existingDecision.superseded = true;
        }
      }
    }
  }

  private buildTopicSummaries(state: CompactedState): TopicSummary[] {
    // Group L1 entries into topic clusters by proximity
    // For regex tier, this is a simple windowed approach
    const windowSize = 5;
    const summaries: TopicSummary[] = [...state.l2_summaries];
    const entries = state.l1_compacted;

    for (let i = 0; i < entries.length; i += windowSize) {
      const window = entries.slice(i, i + windowSize);
      if (window.length === 0) continue;

      const combined = window.map((e) => e.compacted).join(' ');
      const avgImportance = window.reduce((sum, e) => sum + e.importance, 0) / window.length;

      if (avgImportance > 0.2) {
        summaries.push({
          id: generateId(),
          topic: `Discussion block ${Math.floor(i / windowSize) + 1}`,
          summary: combined.slice(0, 500),
          decisions: [],
          entityNames: [],
          messageRange: {
            first: window[0].originalMessageId,
            last: window[window.length - 1].originalMessageId,
          },
          tokenEstimate: estimateTokens(combined.slice(0, 500)),
        });
      }
    }

    return summaries;
  }

  private promoteToGraph(state: CompactedState): void {
    // Extract entity relationships from L2 summaries
    for (const summary of state.l2_summaries) {
      for (const decision of summary.decisions) {
        if (decision.chosen) {
          const entityName = decision.chosen;
          if (!state.l3_graph.entities.has(entityName)) {
            state.l3_graph.entities.set(entityName, {
              name: entityName,
              type: 'decision',
              properties: { description: decision.description },
              firstMention: decision.messageId,
              lastMention: decision.messageId,
            });
          }

          // Add rejection edges
          for (const alt of decision.alternatives) {
            if (alt.option) {
              if (!state.l3_graph.entities.has(alt.option)) {
                state.l3_graph.entities.set(alt.option, {
                  name: alt.option,
                  type: 'technology',
                  properties: {},
                  firstMention: decision.messageId,
                  lastMention: decision.messageId,
                });
              }
              state.l3_graph.edges.push({
                source: entityName,
                target: alt.option,
                relation: 'rejected_in_favor_of',
                properties: { reason: alt.reason },
                sourceMessage: decision.messageId,
              });
            }
          }
        }
      }
    }
  }

  private promoteToInvariants(state: CompactedState): void {
    // Deduplicate invariants by key, keeping latest
    const byKey = new Map<string, Invariant>();
    for (const inv of state.l4_invariants) {
      const existing = byKey.get(inv.key);
      if (!existing || inv.timestamp > existing.timestamp) {
        byKey.set(inv.key, inv);
      }
    }
    state.l4_invariants = Array.from(byKey.values());
  }

  private computeTokenEstimate(state: CompactedState): number {
    let total = 0;
    for (const msg of state.l0_messages) {
      total += estimateTokens(msg.content);
    }
    for (const entry of state.l1_compacted) {
      total += estimateTokens(entry.compacted);
    }
    for (const summary of state.l2_summaries) {
      total += summary.tokenEstimate;
    }
    for (const [, entity] of state.l3_graph.entities) {
      total += estimateTokens(JSON.stringify(entity));
    }
    for (const inv of state.l4_invariants) {
      total += estimateTokens(inv.value);
    }
    return total;
  }
}
