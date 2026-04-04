/**
 * RecallTester — round-trip recall testing framework.
 *
 * Generates quiz questions from the full conversation history,
 * then evaluates whether the compacted state retains enough information
 * to answer them correctly.
 *
 * Quiz categories:
 * - Entity recall: "What database was chosen?"
 * - Decision recall: "What was rejected and why?"
 * - Correction recall: "What was the original value before the correction?"
 * - Temporal recall: "What was decided before vs. after message N?"
 */

import type {
  CompactedState,
  ConversationMessage,
  VerificationResult,
} from '../types.js';

export interface RecallQuestion {
  category: 'entity' | 'decision' | 'correction' | 'temporal';
  question: string;
  /** The ground-truth answer, extracted from the full conversation. */
  expectedAnswer: string;
  /** Message IDs relevant to this question. */
  sourceMessages: string[];
}

export class RecallTester {
  /**
   * Generate quiz questions from the full conversation history.
   * In v0.1.0, this uses heuristic extraction (same patterns as RegexCompactor).
   */
  generateQuestions(messages: ConversationMessage[]): RecallQuestion[] {
    const questions: RecallQuestion[] = [];

    for (const msg of messages) {
      // Entity questions from technology mentions
      const techPattern = /(?:chose|use|using|selected|going with|picked)\s+(\w+(?:\s+\w+)?)/gi;
      let m: RegExpExecArray | null;
      while ((m = techPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'entity',
          question: `What technology/approach was selected for: ${m[1]}?`,
          expectedAnswer: m[1].trim(),
          sourceMessages: [msg.id],
        });
      }

      // Correction questions
      const correctionPattern = /(?:actually|wait|correction|instead|scratch that)\s*[,:]?\s*(?:use|go with|switch to|change to)\s+(.+?)(?:\.|$)/gi;
      while ((m = correctionPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'correction',
          question: `What was the correction made regarding: ${m[1]}?`,
          expectedAnswer: m[1].trim(),
          sourceMessages: [msg.id],
        });
      }

      // Decision questions from rejection patterns
      const rejectPattern = /(?:rejected|ruled out|won't use)\s+(.+?)(?:\s+because\s+(.+?))?(?:\.|$)/gi;
      while ((m = rejectPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'decision',
          question: `What was rejected and why: ${m[1]}?`,
          expectedAnswer: `${m[1].trim()}${m[2] ? ` because ${m[2].trim()}` : ''}`,
          sourceMessages: [msg.id],
        });
      }
    }

    return questions;
  }

  /**
   * Evaluate recall: check whether the compacted state contains
   * the information needed to answer each question.
   *
   * In v0.1.0, this is a simple string-matching test.
   * Future versions will use LLM-based evaluation.
   */
  evaluateRecall(
    questions: RecallQuestion[],
    state: CompactedState,
  ): VerificationResult {
    if (questions.length === 0) {
      return {
        passed: true,
        checks: [{ name: 'recall', passed: true, message: 'No questions generated' }],
        recallScore: 1.0,
      };
    }

    // Flatten all compacted state text for searching
    const stateText = this.flattenState(state).toLowerCase();

    let recalled = 0;
    const checks = questions.map((q) => {
      const answer = q.expectedAnswer.toLowerCase();
      // Check if the key terms from the expected answer appear in the state
      const keyTerms = answer.split(/\s+/).filter((t) => t.length > 2);
      const found = keyTerms.length > 0 && keyTerms.every((term) => stateText.includes(term));

      if (found) recalled++;

      return {
        name: `recall:${q.category}`,
        passed: found,
        message: found
          ? `Recalled: ${q.question}`
          : `Missing: ${q.question} (expected: ${q.expectedAnswer})`,
      };
    });

    const recallScore = recalled / questions.length;

    return {
      passed: recallScore >= 0.9,
      checks,
      recallScore,
    };
  }

  private flattenState(state: CompactedState): string {
    const parts: string[] = [];

    // L0
    for (const msg of state.l0_messages) {
      parts.push(msg.content);
    }

    // L1
    for (const entry of state.l1_compacted) {
      parts.push(entry.compacted);
    }

    // L2
    for (const summary of state.l2_summaries) {
      parts.push(summary.summary);
      for (const decision of summary.decisions) {
        parts.push(decision.description);
        parts.push(decision.chosen);
        for (const alt of decision.alternatives) {
          parts.push(alt.option);
          parts.push(alt.reason);
        }
      }
    }

    // L3
    for (const [, entity] of state.l3_graph.entities) {
      parts.push(entity.name);
      parts.push(JSON.stringify(entity.properties));
    }

    // L4
    for (const inv of state.l4_invariants) {
      parts.push(inv.key);
      parts.push(inv.value);
    }

    // Tombstones
    for (const t of state.tombstones) {
      parts.push(t.supersededContent);
      parts.push(t.correctedValue ?? '');
      parts.push(t.reason);
    }

    return parts.join(' ');
  }
}
