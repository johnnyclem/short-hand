/**
 * ActiveEngramStore — manages agential memory entries (ActiveEngrams).
 *
 * Three design rules encoded here:
 *   1. Interpret before inject: interpret(context) is called on every matched
 *      engram before its text enters a context frame.
 *   2. Activation policy is declarative data evaluated by the store, never
 *      by the engram itself.
 *   3. Safety boundary: activation policies cannot write to importanceScore.
 *      Only setImportance() (a host-controlled method) may do so.
 */

import type { ActiveEngram, ActiveEngramResult, ActivationPolicy } from '../types.js';
import { generateId } from '../utils.js';

// ---------------------------------------------------------------------------
// Default interpreter template
// ---------------------------------------------------------------------------

const DEFAULT_INTERPRETER_TEMPLATE =
  'In the context of {{context}}, the earlier note "{{payload}}" remains relevant as: {{payload}}';

// ---------------------------------------------------------------------------
// Template resolution (regex tier — no LM call)
// ---------------------------------------------------------------------------

function resolveTemplate(template: string, payload: string, context: string): string {
  return template
    .replace(/\{\{payload\}\}/g, payload)
    .replace(/\{\{context\}\}/g, context);
}

// ---------------------------------------------------------------------------
// Activation policy evaluation (pure function, no side-effects on the engram)
// ---------------------------------------------------------------------------

function isEligible(
  engram: ActiveEngram,
  context: string,
  now: number,
): boolean {
  const { activationPolicy, retrievalCount } = engram;

  if (activationPolicy.expiresAt !== undefined && now >= activationPolicy.expiresAt) {
    return false;
  }

  if (
    activationPolicy.maxRetrievals !== undefined &&
    retrievalCount >= activationPolicy.maxRetrievals
  ) {
    return false;
  }

  if (activationPolicy.surfaceWhenTopics.length > 0) {
    const lower = context.toLowerCase();
    const matches = activationPolicy.surfaceWhenTopics.some((topic) =>
      lower.includes(topic.toLowerCase()),
    );
    if (!matches) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// ActiveEngramStore
// ---------------------------------------------------------------------------

export interface SerializedActiveEngramStore {
  engrams: ActiveEngram[];
}

export class ActiveEngramStore {
  private engrams = new Map<string, ActiveEngram>();

  // -----------------------------------------------------------------------
  // Write path (host-controlled)
  // -----------------------------------------------------------------------

  /** Add a new ActiveEngram. Returns the assigned ID. */
  add(
    payload: string,
    options: {
      interpreterTemplate?: string;
      activationPolicy?: Partial<ActivationPolicy>;
      importanceScore?: number;
      derivedFrom?: string;
    } = {},
  ): string {
    const id = generateId();
    const engram: ActiveEngram = {
      id,
      payload,
      interpreterTemplate: options.interpreterTemplate ?? DEFAULT_INTERPRETER_TEMPLATE,
      activationPolicy: {
        surfaceWhenTopics: [],
        ...options.activationPolicy,
      },
      importanceScore: options.importanceScore ?? 0.5,
      createdAt: Date.now(),
      retrievalCount: 0,
      derivedFrom: options.derivedFrom,
    };
    this.engrams.set(id, engram);
    return id;
  }

  /**
   * Set the importance score for an engram.
   * This is the ONLY path by which importanceScore may change.
   * Activation policies cannot call this — enforced by the type system
   * (ActivationPolicy has no method access to the store).
   */
  setImportance(id: string, score: number): void {
    const engram = this.engrams.get(id);
    if (!engram) return;
    engram.importanceScore = Math.max(0, Math.min(1, score));
  }

  /** Remove an engram. */
  remove(id: string): boolean {
    return this.engrams.delete(id);
  }

  get(id: string): ActiveEngram | undefined {
    return this.engrams.get(id);
  }

  all(): ActiveEngram[] {
    return Array.from(this.engrams.values());
  }

  // -----------------------------------------------------------------------
  // Read path (retrieval + interpretation)
  // -----------------------------------------------------------------------

  /**
   * Retrieve all active engrams eligible for the given context, then apply
   * each engram's interpreter to produce contextualized results.
   *
   * Shadow resolution: if engram B shadows engram A, A's result is replaced
   * by B's result in the output — same slot, new interpretation.
   *
   * Results are sorted descending by importanceScore.
   */
  retrieve(context: string, now: number = Date.now()): ActiveEngramResult[] {
    const eligible = Array.from(this.engrams.values()).filter((e) =>
      isEligible(e, context, now),
    );

    // Bump retrieval counts (side-effect owned by the store, not the policy)
    for (const e of eligible) {
      e.retrievalCount += 1;
    }

    // Build raw results
    const resultsById = new Map<string, ActiveEngramResult>();
    for (const e of eligible) {
      const interpreted = resolveTemplate(e.interpreterTemplate, e.payload, context);
      resultsById.set(e.id, {
        engramId: e.id,
        interpreted,
        payload: e.payload,
        importanceScore: e.importanceScore,
      });
    }

    // Shadow resolution: engram B shadows engram A → replace A's slot with B's output
    for (const e of eligible) {
      const shadowTarget = e.activationPolicy.shadowsEngramId;
      if (shadowTarget && resultsById.has(shadowTarget)) {
        const shadowingResult = resultsById.get(e.id)!;
        resultsById.set(shadowTarget, {
          ...shadowingResult,
          engramId: shadowTarget,
          shadows: e.id,
        });
        resultsById.delete(e.id);
      }
    }

    return Array.from(resultsById.values()).sort(
      (a, b) => b.importanceScore - a.importanceScore,
    );
  }

  /**
   * Interpret a single engram against the given context without modifying
   * retrieval counts. Useful for preview/testing.
   */
  interpret(id: string, context: string): ActiveEngramResult | undefined {
    const engram = this.engrams.get(id);
    if (!engram) return undefined;
    return {
      engramId: id,
      interpreted: resolveTemplate(engram.interpreterTemplate, engram.payload, context),
      payload: engram.payload,
      importanceScore: engram.importanceScore,
    };
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize(): SerializedActiveEngramStore {
    return { engrams: Array.from(this.engrams.values()) };
  }

  /** Populate this store from serialized data, replacing all current entries. */
  loadFrom(data: SerializedActiveEngramStore): void {
    this.engrams.clear();
    for (const engram of data.engrams) {
      this.engrams.set(engram.id, { ...engram });
    }
  }

  static deserialize(data: SerializedActiveEngramStore): ActiveEngramStore {
    const store = new ActiveEngramStore();
    store.loadFrom(data);
    return store;
  }
}
