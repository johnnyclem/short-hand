/**
 * short-hand
 *
 * Progressive context compaction for LLMs.
 * Old computer science for new constraints.
 */

// Core types
export type {
  ConversationMessage,
  MessageRole,
  CompactedState,
  CompactionLevel,
  CompactionConfig,
  Compactor,
  CompactorTier,
  ContextFrame,
  ContextSection,
  Tombstone,
  Entity,
  EntityType,
  Edge,
  EdgeRelation,
  KnowledgeGraph,
  Decision,
  TopicSummary,
  Invariant,
  ImportanceScore,
  ImportanceWeights,
  VerificationResult,
  AgentProfile,
} from './types.js';

export {
  CompactionLevel as CompactionLevelEnum,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_IMPORTANCE_WEIGHTS,
} from './types.js';

// Compaction engine
export { CompactionEngine } from './compaction/compaction-engine.js';
export { RegexCompactor } from './compaction/regex-compactor.js';

// Importance detection
export { ImportanceDetector } from './importance/importance-detector.js';

// CRDT primitives
export { LWWRegister } from './crdt/lww-register.js';
export { ORSet } from './crdt/or-set.js';
export { GSet } from './crdt/g-set.js';
export { AgentMemory } from './crdt/agent-memory.js';
export type { SerializedAgentMemory } from './crdt/agent-memory.js';

// Verification
export { InvariantChecker } from './verification/invariant-checker.js';
export { RecallTester } from './verification/recall-tester.js';

// Embedding (stub)
export { StubEmbedder } from './embedding/index.js';
export type { Embedder, EmbeddingResult } from './embedding/index.js';

// Utilities
export { estimateTokens, generateId } from './utils.js';
