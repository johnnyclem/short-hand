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
  Source,
  IngestionConfig,
  IngestionEvent,
  WikiPage,
  WikiRenderConfig,
  ActiveEngram,
  ActivationPolicy,
  ActiveEngramResult,
} from './types.js';

export {
  CompactionLevel as CompactionLevelEnum,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_IMPORTANCE_WEIGHTS,
  DEFAULT_INGESTION_CONFIG,
  DEFAULT_WIKI_RENDER_CONFIG,
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
export { ActiveEngramStore } from './crdt/active-engram-store.js';
export type {
  SerializedActiveEngramStore,
  ActiveEngramStoreOptions,
} from './crdt/active-engram-store.js';

// Interpreter (bounded LM step at retrieval time)
export type {
  Interpreter,
  InterpreterTier,
  InterpretInput,
  InterpretOptions,
  InterpreterLogger,
  InterpreterBudgetReason,
} from './interpreter/index.js';
export {
  InterpreterBudgetError,
  InterpreterUnavailableError,
  silentLogger,
  isFallbackEligible,
  RegexInterpreter,
  resolveTemplate,
  HostInterpreter,
  LocalInterpreter,
  withFallback,
} from './interpreter/index.js';
export type {
  HostInterpreterOptions,
  AnthropicLikeClient,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  LocalInterpreterOptions,
  WithFallbackOptions,
} from './interpreter/index.js';

// Context-shift benchmark
export {
  ContextShiftBenchmark,
  echoAnswerer,
  wilson95,
  KeywordJudge,
  LMJudge,
  STARTER_FIXTURES,
} from './benchmark/index.js';
export type {
  BenchmarkFixture,
  ShiftType,
  ArmResult,
  FixtureResult,
  BenchmarkAggregate,
  BenchmarkReport,
  Answerer,
  AnswererArgs,
  ContextShiftBenchmarkOptions,
  RunOptions,
  Judge,
  JudgeArgs,
  LMJudgeOptions,
} from './benchmark/index.js';

// Verification
export { InvariantChecker } from './verification/invariant-checker.js';
export { RecallTester } from './verification/recall-tester.js';

// Embedding (stub)
export { StubEmbedder } from './embedding/index.js';
export type { Embedder, EmbeddingResult } from './embedding/index.js';

// Source ingestion
export { SourceIngester } from './ingestion/source-ingester.js';

// Wiki rendering
export { WikiRenderer } from './wiki/wiki-renderer.js';

// Utilities
export { estimateTokens, generateId } from './utils.js';
