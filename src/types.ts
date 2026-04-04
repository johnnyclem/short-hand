/**
 * Core types for @shorthand/core
 * Progressive context compaction for LLMs.
 */

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  /** Optional metadata attached by the host application. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compaction levels (LSM-tree model)
// ---------------------------------------------------------------------------

/** The five compaction levels, from hot (L0) to cold (L4). */
export enum CompactionLevel {
  /** Raw recent messages, verbatim. Full fidelity. */
  L0_MEMTABLE = 0,
  /** Conversational noise stripped, deduplication applied. */
  L1_COMPACTED = 1,
  /** Topic-clustered summaries with entity/decision extraction. */
  L2_SUMMARIES = 2,
  /** Entity-relationship graph. Nodes and edges only. */
  L3_GRAPH = 3,
  /** Core invariants that must survive indefinitely. */
  L4_INVARIANTS = 4,
}

// ---------------------------------------------------------------------------
// Tombstones (correction tracking)
// ---------------------------------------------------------------------------

export interface Tombstone {
  /** The content that was superseded. */
  supersededContent: string;
  /** Message ID where the original (now-wrong) statement was made. */
  originalMessageId: string;
  /** Message ID where the correction was made. */
  correctionMessageId: string;
  /** Why the original was invalidated. */
  reason: string;
  /** Timestamp of the correction. */
  timestamp: number;
  /** The entity or key being corrected, if identifiable. */
  key?: string;
  /** The new/corrected value. */
  correctedValue?: string;
}

// ---------------------------------------------------------------------------
// Entity-relationship graph (L3)
// ---------------------------------------------------------------------------

export type EntityType =
  | 'component'
  | 'schema'
  | 'decision'
  | 'constraint'
  | 'technology'
  | 'person'
  | 'concept'
  | 'artifact'
  | 'custom';

export interface Entity {
  name: string;
  type: EntityType;
  properties: Record<string, string>;
  /** Message ID where this entity was first mentioned. */
  firstMention: string;
  /** Message ID where this entity was last mentioned. */
  lastMention: string;
}

export type EdgeRelation =
  | 'depends_on'
  | 'replaces'
  | 'implements'
  | 'constrains'
  | 'rejected_in_favor_of'
  | 'related_to'
  | 'custom';

export interface Edge {
  source: string;
  target: string;
  relation: EdgeRelation;
  properties: Record<string, string>;
  /** Message ID where this relationship was established. */
  sourceMessage: string;
}

export interface KnowledgeGraph {
  entities: Map<string, Entity>;
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Decision tracking
// ---------------------------------------------------------------------------

export interface Decision {
  /** What was decided. */
  description: string;
  /** The chosen option. */
  chosen: string;
  /** Alternatives that were considered and rejected. */
  alternatives: Array<{ option: string; reason: string }>;
  /** Message ID where the decision was made. */
  messageId: string;
  /** Whether this decision was later superseded. */
  superseded: boolean;
  /** If superseded, the tombstone that invalidated it. */
  tombstoneId?: string;
}

// ---------------------------------------------------------------------------
// Topic summaries (L2)
// ---------------------------------------------------------------------------

export interface TopicSummary {
  /** Unique ID for this summary. */
  id: string;
  /** Short label for the topic. */
  topic: string;
  /** Structured summary of what happened. */
  summary: string;
  /** Decisions made within this topic. */
  decisions: Decision[];
  /** Entities referenced. */
  entityNames: string[];
  /** Range of message IDs covered. */
  messageRange: { first: string; last: string };
  /** Estimated token count of this summary. */
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Core invariants (L4)
// ---------------------------------------------------------------------------

export interface Invariant {
  key: string;
  value: string;
  /** Message ID where this invariant was established. */
  sourceMessage: string;
  /** Lamport timestamp for CRDT ordering. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Compacted state (the full picture across all levels)
// ---------------------------------------------------------------------------

export interface CompactedState {
  /** L0: Raw recent messages. */
  l0_messages: ConversationMessage[];
  /** L1: Compacted recent history entries. */
  l1_compacted: Array<{
    originalMessageId: string;
    compacted: string;
    importance: number;
  }>;
  /** L2: Topic-clustered summaries. */
  l2_summaries: TopicSummary[];
  /** L3: Entity-relationship graph. */
  l3_graph: KnowledgeGraph;
  /** L4: Core invariants. */
  l4_invariants: Invariant[];
  /** Tombstones across all levels. */
  tombstones: Tombstone[];
  /** Total token estimate for the compacted state. */
  totalTokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Context frame (token-budgeted slice for the next LLM call)
// ---------------------------------------------------------------------------

export interface ContextFrame {
  /** Token budget this frame was built for. */
  tokenBudget: number;
  /** Actual token usage. */
  tokenUsage: number;
  /** Content sections from each level, ordered L4 → L0. */
  sections: ContextSection[];
}

export interface ContextSection {
  level: CompactionLevel;
  content: string;
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Importance scoring
// ---------------------------------------------------------------------------

export interface ImportanceScore {
  /** Overall importance (0.0 to 1.0). */
  overall: number;
  /** Signal 1: State delta — how much this message mutates the entity graph. */
  stateDelta: number;
  /** Signal 2: Reference frequency — how often later messages reference this one. */
  referenceFrequency: number;
  /** Signal 3: Trajectory discontinuity — semantic direction change. */
  trajectoryDiscontinuity: number;
}

export interface ImportanceWeights {
  stateDelta: number;
  referenceFrequency: number;
  trajectoryDiscontinuity: number;
}

export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceWeights = {
  stateDelta: 0.45,
  referenceFrequency: 0.25,
  trajectoryDiscontinuity: 0.30,
};

// ---------------------------------------------------------------------------
// Compactor interface (tiered: regex, local LM, host LLM)
// ---------------------------------------------------------------------------

export type CompactorTier = 'regex' | 'local' | 'host';

export interface Compactor {
  readonly tier: CompactorTier;

  /** Compact a sequence of messages into a lower level. */
  compact(
    messages: ConversationMessage[],
    targetLevel: CompactionLevel,
    currentState?: CompactedState,
  ): Promise<CompactedState>;

  /** Re-compact existing state (e.g., L1 → L2 merge). */
  recompact(
    state: CompactedState,
    targetLevel: CompactionLevel,
  ): Promise<CompactedState>;
}

// ---------------------------------------------------------------------------
// Compaction configuration
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  /** Which tier to prefer. Falls back automatically. */
  preferredTier: CompactorTier;
  /** For Tier 1: local model configuration. */
  localModel?: {
    backend: 'llama.cpp' | 'mlx' | 'ollama' | 'transformers.js';
    modelPath: string;
    quantization?: '4bit' | '8bit' | 'f16';
  };
  /** For Tier 2: host LLM configuration. */
  hostLLM?: {
    provider: 'anthropic' | 'openai' | 'custom';
    model: string;
    toolName?: string;
  };
  /** Automatically fall back to lower tiers on failure. */
  autoFallback: boolean;
  /** Number of recent messages to keep verbatim in L0. */
  memtableSize: number;
  /** Token budget for context frames. */
  contextBudget: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  preferredTier: 'regex',
  autoFallback: true,
  memtableSize: 10,
  contextBudget: 8000,
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
  /** Recall score from round-trip testing (0.0 to 1.0), if computed. */
  recallScore?: number;
}

// ---------------------------------------------------------------------------
// Agent profile (for per-agent semantic mapping)
// ---------------------------------------------------------------------------

export interface AgentProfile {
  agentId: string;
  /** Entity types this agent cares about. */
  entityTypes: EntityType[];
  /** Custom importance weights. */
  importanceWeights: ImportanceWeights;
  /** Regex patterns that boost importance. */
  boostPatterns: RegExp[];
  /** Regex patterns that demote importance. */
  demotePatterns: RegExp[];
}
