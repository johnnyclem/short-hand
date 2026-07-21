/**
 * ImportanceDetector — three-signal importance scoring.
 *
 * Signal 1: State Delta — how much a message mutates the entity-relationship graph.
 * Signal 2: Reference Frequency — how often later messages reference this one.
 * Signal 3: Trajectory Discontinuity — semantic direction change (simplified without embeddings).
 *
 * In v0.1.0, signals 2 and 3 use heuristic approximations rather than embeddings.
 */

import type {
  ConversationMessage,
  ImportanceScore,
  ImportanceWeights,
} from '../types.js';
import { DEFAULT_IMPORTANCE_WEIGHTS } from '../types.js';

// ---------------------------------------------------------------------------
// Entity extraction (lightweight, for state delta)
// ---------------------------------------------------------------------------

/** Simple entity extraction via regex — good enough for importance scoring. */
function extractMentionedEntities(content: string): string[] {
  const entities: string[] = [];

  // Capitalized terms (likely proper nouns / tech names)
  const caps = content.match(/\b[A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]+)*/g);
  if (caps) entities.push(...caps);

  // Backtick-quoted identifiers
  const backticks = content.match(/`([^`]+)`/g);
  if (backticks) entities.push(...backticks.map((b) => b.replace(/`/g, '')));

  // Known tech patterns
  const techPatterns = /\b(?:React|Vue|Angular|Node|Express|PostgreSQL|MySQL|SQLite|MongoDB|Redis|Docker|Kubernetes|JWT|OAuth|REST|GraphQL|gRPC|AWS|GCP|Azure|TypeScript|JavaScript|Python|Rust|Go)\b/gi;
  const techMatches = content.match(techPatterns);
  if (techMatches) entities.push(...techMatches);

  // Deduplicate
  return [...new Set(entities.map((e) => e.trim()).filter((e) => e.length > 1))];
}

// ---------------------------------------------------------------------------
// Override/correction detection
// ---------------------------------------------------------------------------

const OVERRIDE_PATTERNS = [
  /\bactually\b/i,
  /\bwait\b/i,
  /\bcorrection\b/i,
  /\bscratch that\b/i,
  /\binstead\b/i,
  /\bchange\s+(?:that|this|it)\b/i,
  /\bno[,.]?\s+(?:let's|we should|use)\b/i,
  /\brather\s+than\b/i,
  /\bswap\b/i,
  /\breplace\b/i,
];

function hasOverrideIndicator(content: string): boolean {
  return OVERRIDE_PATTERNS.some((p) => p.test(content));
}

// ---------------------------------------------------------------------------
// Reference detection (heuristic, without embeddings)
// ---------------------------------------------------------------------------

const EXPLICIT_REFERENCE_PATTERNS = [
  /\bas (?:I|we|you) (?:said|mentioned|discussed|noted) (?:earlier|before|above|previously)\b/i,
  /\bgoing back to\b/i,
  /\bearlier\b/i,
  /\bpreviously\b/i,
  /\bas (?:discussed|mentioned|noted)\b/i,
  /\bremember when\b/i,
  /\blike (?:I|we) said\b/i,
];

function detectExplicitReferences(content: string): number {
  return EXPLICIT_REFERENCE_PATTERNS.filter((p) => p.test(content)).length;
}

// ---------------------------------------------------------------------------
// Trajectory discontinuity (lexical approximation)
// ---------------------------------------------------------------------------

/** Compute Jaccard distance between two token sets as a proxy for semantic shift. */
function tokenJaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

// ---------------------------------------------------------------------------
// ImportanceDetector
// ---------------------------------------------------------------------------

interface MessageRecord {
  message: ConversationMessage;
  entities: string[];
  score: ImportanceScore;
}

export class ImportanceDetector {
  private weights: ImportanceWeights;
  private history: MessageRecord[] = [];
  private entityGraph = new Map<string, Set<string>>(); // entity → set of message IDs
  private referenceCounts = new Map<string, number>(); // messageId → reference count

  constructor(weights?: Partial<ImportanceWeights>) {
    this.weights = { ...DEFAULT_IMPORTANCE_WEIGHTS, ...weights };
  }

  /** Score a new message incrementally. */
  score(message: ConversationMessage): ImportanceScore {
    const entities = extractMentionedEntities(message.content);
    const stateDelta = this.computeStateDelta(message, entities);
    const referenceFrequency = this.computeReferenceSignal(message);
    const trajectoryDiscontinuity = this.computeTrajectorySignal(message);

    const overall = Math.min(
      1.0,
      this.weights.stateDelta * stateDelta +
        this.weights.referenceFrequency * referenceFrequency +
        this.weights.trajectoryDiscontinuity * trajectoryDiscontinuity,
    );

    const scoreResult: ImportanceScore = {
      overall,
      stateDelta,
      referenceFrequency,
      trajectoryDiscontinuity,
    };

    // Record for future reference tracking
    this.history.push({ message, entities, score: scoreResult });

    // Update entity graph
    for (const entity of entities) {
      if (!this.entityGraph.has(entity)) {
        this.entityGraph.set(entity, new Set());
      }
      this.entityGraph.get(entity)!.add(message.id);
    }

    // Update reference counts for prior messages (entity reuse)
    this.updateReferenceCounts(message, entities);

    return scoreResult;
  }

  /**
   * Retrospectively recompute all scores. Unlike incremental score() calls,
   * this folds in the reference-frequency signal: messages whose entities
   * were re-mentioned by later messages get their referenceFrequency (and
   * overall score) boosted.
   */
  recompute(): ImportanceScore[] {
    const records = this.history;
    this.history = [];
    this.entityGraph.clear();
    this.referenceCounts.clear();

    // First pass: replay incrementally, rebuilding the entity graph and
    // reference counts across the full history.
    for (const record of records) {
      this.score(record.message);
    }

    // Second pass: now that reference counts reflect the whole conversation,
    // fold them into each message's reference-frequency signal.
    for (const record of this.history) {
      const refs = this.referenceCounts.get(record.message.id) ?? 0;
      if (refs === 0) continue;

      const referenceFrequency = Math.min(
        1.0,
        record.score.referenceFrequency + refs * 0.15,
      );
      const overall = Math.min(
        1.0,
        this.weights.stateDelta * record.score.stateDelta +
          this.weights.referenceFrequency * referenceFrequency +
          this.weights.trajectoryDiscontinuity * record.score.trajectoryDiscontinuity,
      );
      record.score = { ...record.score, referenceFrequency, overall };
    }

    return this.history.map((r) => r.score);
  }

  /** Get the current score for a message ID. */
  getScore(messageId: string): ImportanceScore | undefined {
    return this.history.find((r) => r.message.id === messageId)?.score;
  }

  /** Get all scores. */
  getAllScores(): Array<{ messageId: string; score: ImportanceScore }> {
    return this.history.map((r) => ({ messageId: r.message.id, score: r.score }));
  }

  // -----------------------------------------------------------------------
  // Signal 1: State Delta
  // -----------------------------------------------------------------------

  private computeStateDelta(message: ConversationMessage, entities: string[]): number {
    let delta = 0;

    // Node additions (new entities not seen before)
    for (const entity of entities) {
      if (!this.entityGraph.has(entity)) {
        delta += 1.0; // New entity
      } else {
        delta += 0.7; // Entity modification/re-mention
      }
    }

    // Override indicator boost
    if (hasOverrideIndicator(message.content)) {
      delta += 1.5;
    }

    // Normalize to 0-1 range (cap at ~5 significant mutations)
    return Math.min(1.0, delta / 5);
  }

  // -----------------------------------------------------------------------
  // Signal 2: Reference Frequency
  // -----------------------------------------------------------------------

  private computeReferenceSignal(message: ConversationMessage): number {
    // For newly arriving messages, reference frequency is zero.
    // The signal is retrospective — it grows as later messages arrive.
    // Here we check if THIS message references prior messages (explicit references).
    const explicitRefs = detectExplicitReferences(message.content);
    // Boost the referenced messages (handled in updateReferenceCounts).
    // For the current message, return a small signal if it's referencing others.
    return Math.min(1.0, explicitRefs * 0.3);
  }

  private updateReferenceCounts(message: ConversationMessage, entities: string[]): void {
    // Entity reuse: if this message mentions entities from prior messages, boost those messages
    for (const entity of entities) {
      const priorMessages = this.entityGraph.get(entity);
      if (priorMessages) {
        for (const msgId of priorMessages) {
          if (msgId !== message.id) {
            const current = this.referenceCounts.get(msgId) ?? 0;
            this.referenceCounts.set(msgId, current + 1);
          }
        }
      }
    }

    // Explicit reference detection would boost prior messages too,
    // but without message linking we can only count the patterns.
    if (detectExplicitReferences(message.content) > 0 && this.history.length > 1) {
      // Boost the most recent messages (heuristic: explicit refs likely point to recent context)
      const recentId = this.history[this.history.length - 2]?.message.id;
      if (recentId) {
        const current = this.referenceCounts.get(recentId) ?? 0;
        this.referenceCounts.set(recentId, current + 1);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Signal 3: Trajectory Discontinuity
  // -----------------------------------------------------------------------

  private computeTrajectorySignal(message: ConversationMessage): number {
    if (this.history.length === 0) return 0;

    // Compute lexical distance from the previous message
    const prev = this.history[this.history.length - 1].message.content;
    const distance = tokenJaccard(prev, message.content);

    // Also compute distance from the running "trajectory" (mean of last 3)
    const recentWindow = this.history.slice(-3).map((r) => r.message.content);
    const windowText = recentWindow.join(' ');
    const trajectoryDistance = tokenJaccard(windowText, message.content);

    // Use the max of pairwise and trajectory distance
    const rawSignal = Math.max(distance, trajectoryDistance);

    // Z-score approximation: track running mean/variance
    // For now, use a simpler threshold: distance > 0.7 is a big shift
    if (rawSignal > 0.8) return 1.0;
    if (rawSignal > 0.6) return 0.7;
    if (rawSignal > 0.4) return 0.4;
    return rawSignal * 0.5;
  }
}
