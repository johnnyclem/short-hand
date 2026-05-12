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
import {
  RegexInterpreter,
  resolveTemplate,
} from '../interpreter/regex-interpreter.js';
import {
  silentLogger,
  type Interpreter,
  type InterpretOptions,
  type InterpreterLogger,
} from '../interpreter/types.js';

// ---------------------------------------------------------------------------
// Default interpreter template
// ---------------------------------------------------------------------------

const DEFAULT_INTERPRETER_TEMPLATE =
  'In the context of {{context}}, the earlier note "{{payload}}" remains relevant as: {{payload}}';

const DEFAULT_INTERPRET_OPTIONS: InterpretOptions = {
  maxOutputTokens: 120,
  timeoutMs: 4_000,
};

const DEFAULT_FAILED_RETRIEVAL_WEIGHT = 0.25;

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

export interface ActiveEngramStoreOptions {
  /**
   * Interpreter used by retrieveAsync / interpretAsync.
   * Defaults to RegexInterpreter (the regex tier).
   * The synchronous retrieve / interpret methods always use the regex tier
   * regardless of this setting — they are the zero-dep fast path.
   */
  interpreter?: Interpreter;
  /**
   * Cost (against maxRetrievals) of a failed interpretation in retrieveAsync.
   * Default: 0.25 — four failures equal one successful surface.
   * The engram is still dropped from the result set on failure; this only
   * affects how aggressively a flaky LM burns through the retrieval budget.
   */
  failedRetrievalWeight?: number;
  /** Logger for interpreter-failure warnings. */
  logger?: InterpreterLogger;
}

export class ActiveEngramStore {
  private engrams = new Map<string, ActiveEngram>();
  private readonly interpreter: Interpreter;
  private readonly failedRetrievalWeight: number;
  private readonly logger: InterpreterLogger;

  constructor(opts: ActiveEngramStoreOptions = {}) {
    this.interpreter = opts.interpreter ?? new RegexInterpreter();
    this.failedRetrievalWeight =
      opts.failedRetrievalWeight ?? DEFAULT_FAILED_RETRIEVAL_WEIGHT;
    this.logger = opts.logger ?? silentLogger;
  }

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
  // Async read path (LM-tier interpreter)
  // -----------------------------------------------------------------------

  /**
   * Retrieve all eligible engrams against the given context, calling the
   * configured Interpreter for each. Same shadow + ordering semantics as
   * retrieve(); the only difference is that interpretation is async and may
   * fail per-engram.
   *
   * retrievalCount accounting:
   *   - On success:  retrievalCount += 1
   *   - On failure:  retrievalCount += failedRetrievalWeight (default 0.25)
   *                  and the engram is dropped from the result set.
   *
   * Safety boundary: importanceScore is read-only here. The interpreter
   * receives only { template, payload, context } — never importanceScore,
   * activationPolicy, id, or retrievalCount.
   */
  async retrieveAsync(
    context: string,
    now: number = Date.now(),
    opts: Partial<InterpretOptions> = {},
  ): Promise<ActiveEngramResult[]> {
    const interpretOpts: InterpretOptions = {
      ...DEFAULT_INTERPRET_OPTIONS,
      ...opts,
    };

    const eligible = Array.from(this.engrams.values()).filter((e) =>
      isEligible(e, context, now),
    );

    const settled = await Promise.allSettled(
      eligible.map((e) =>
        this.interpreter.interpret(
          { template: e.interpreterTemplate, payload: e.payload, context },
          interpretOpts,
        ),
      ),
    );

    const resultsById = new Map<string, ActiveEngramResult>();

    for (let i = 0; i < eligible.length; i++) {
      const e = eligible[i];
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        e.retrievalCount += 1;
        resultsById.set(e.id, {
          engramId: e.id,
          interpreted: outcome.value,
          payload: e.payload,
          importanceScore: e.importanceScore,
        });
      } else {
        e.retrievalCount += this.failedRetrievalWeight;
        this.logger.warn('interpret_failed', {
          engramId: e.id,
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        });
      }
    }

    // Shadow resolution — same semantics as the sync path. Operates on ids
    // and importanceScore only; never reads or writes the interpreter output
    // path through any policy callback (there is no such callback).
    for (const e of eligible) {
      const shadowTarget = e.activationPolicy.shadowsEngramId;
      if (!shadowTarget) continue;
      if (!resultsById.has(shadowTarget)) continue;
      const shadowingResult = resultsById.get(e.id);
      if (!shadowingResult) continue; // shadower itself failed — leave target as-is
      resultsById.set(shadowTarget, {
        ...shadowingResult,
        engramId: shadowTarget,
        shadows: e.id,
      });
      resultsById.delete(e.id);
    }

    return Array.from(resultsById.values()).sort(
      (a, b) => b.importanceScore - a.importanceScore,
    );
  }

  /**
   * Async preview: interpret one engram against the given context using the
   * configured Interpreter, without modifying retrievalCount. Rethrows
   * interpreter errors verbatim — preview should surface failure rather than
   * silently fall back.
   */
  async interpretAsync(
    id: string,
    context: string,
    opts: Partial<InterpretOptions> = {},
  ): Promise<ActiveEngramResult | undefined> {
    const engram = this.engrams.get(id);
    if (!engram) return undefined;

    const interpretOpts: InterpretOptions = {
      ...DEFAULT_INTERPRET_OPTIONS,
      ...opts,
    };

    const interpreted = await this.interpreter.interpret(
      {
        template: engram.interpreterTemplate,
        payload: engram.payload,
        context,
      },
      interpretOpts,
    );

    return {
      engramId: id,
      interpreted,
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
