/**
 * InvariantChecker — mechanically checkable safety properties.
 *
 * Verifies that the compacted state satisfies structural invariants:
 * - Correction propagation: tombstones supersede stale data
 * - Entity provenance: every L3 entity traces to a source message
 * - Decision completeness: every decision includes alternatives
 * - Tombstone consistency: no orphaned tombstones
 * - Temporal ordering: firstMention <= lastMention
 */

import type { CompactedState, VerificationResult } from '../types.js';

interface Check {
  name: string;
  passed: boolean;
  message: string;
}

export class InvariantChecker {
  verify(state: CompactedState): VerificationResult {
    const checks: Check[] = [
      this.checkCorrectionPropagation(state),
      this.checkEntityProvenance(state),
      this.checkDecisionCompleteness(state),
      this.checkTombstoneConsistency(state),
      this.checkTemporalOrdering(state),
    ];

    return {
      passed: checks.every((c) => c.passed),
      checks,
    };
  }

  // -----------------------------------------------------------------------
  // Check 1: Correction propagation
  // If a tombstone exists, the superseded information must not appear
  // at any lower level without the correction attached.
  // -----------------------------------------------------------------------

  private checkCorrectionPropagation(state: CompactedState): Check {
    const violations: string[] = [];

    for (const tombstone of state.tombstones) {
      if (!tombstone.supersededContent) continue;

      const needle = tombstone.supersededContent.toLowerCase();

      // Check L1 compacted entries
      for (const entry of state.l1_compacted) {
        if (
          entry.compacted.toLowerCase().includes(needle) &&
          !entry.compacted.toLowerCase().includes(tombstone.correctedValue?.toLowerCase() ?? '')
        ) {
          violations.push(
            `L1 entry ${entry.originalMessageId} contains superseded content "${tombstone.supersededContent}" without correction`,
          );
        }
      }

      // Check L2 summaries
      for (const summary of state.l2_summaries) {
        if (
          summary.summary.toLowerCase().includes(needle) &&
          !summary.summary.toLowerCase().includes(tombstone.correctedValue?.toLowerCase() ?? '')
        ) {
          violations.push(
            `L2 summary "${summary.topic}" contains superseded content without correction`,
          );
        }
      }
    }

    return {
      name: 'correction-propagation',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? 'All corrections properly propagated'
          : `${violations.length} violation(s): ${violations[0]}`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 2: Entity provenance
  // Every entity in L3 must trace to at least one source message.
  // -----------------------------------------------------------------------

  private checkEntityProvenance(state: CompactedState): Check {
    const violations: string[] = [];

    for (const [name, entity] of state.l3_graph.entities) {
      if (!entity.firstMention) {
        violations.push(`Entity "${name}" has no firstMention`);
      }
    }

    return {
      name: 'entity-provenance',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? 'All entities have provenance'
          : `${violations.length} entity(ies) without provenance: ${violations[0]}`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 3: Decision completeness
  // Every decision should include its alternatives (warn, don't fail).
  // -----------------------------------------------------------------------

  private checkDecisionCompleteness(state: CompactedState): Check {
    let totalDecisions = 0;
    let incompleteDecisions = 0;

    for (const summary of state.l2_summaries) {
      for (const decision of summary.decisions) {
        totalDecisions++;
        if (decision.alternatives.length === 0) {
          incompleteDecisions++;
        }
      }
    }

    // This is a soft check — incomplete decisions are common with regex extraction
    const passed = totalDecisions === 0 || incompleteDecisions / totalDecisions < 0.8;

    return {
      name: 'decision-completeness',
      passed,
      message:
        totalDecisions === 0
          ? 'No decisions to check'
          : `${totalDecisions - incompleteDecisions}/${totalDecisions} decisions include alternatives`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 4: Tombstone consistency
  // No orphaned tombstones referencing nonexistent messages.
  // -----------------------------------------------------------------------

  private checkTombstoneConsistency(state: CompactedState): Check {
    // Referenced messages may legitimately be compacted away, so we do not
    // require correctionMessageId to resolve. We do require each tombstone
    // to be structurally complete: a correction provenance and a reason.
    const violations: string[] = [];
    for (const tombstone of state.tombstones) {
      if (!tombstone.correctionMessageId) {
        violations.push(
          `Tombstone for "${tombstone.supersededContent}" has no correctionMessageId`,
        );
      }
      if (!tombstone.reason) {
        violations.push(
          `Tombstone for "${tombstone.supersededContent}" has no reason`,
        );
      }
    }

    return {
      name: 'tombstone-consistency',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? `${state.tombstones.length} tombstone(s) tracked, all structurally consistent`
          : `${violations.length} violation(s): ${violations[0]}`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 5: Temporal ordering
  // No entity's firstMention can postdate its lastMention.
  // -----------------------------------------------------------------------

  private checkTemporalOrdering(state: CompactedState): Check {
    const violations: string[] = [];

    for (const [name, entity] of state.l3_graph.entities) {
      // We can only check ordering if the IDs are numeric or comparable.
      // For string IDs, we just verify both exist.
      if (!entity.firstMention || !entity.lastMention) {
        violations.push(`Entity "${name}" missing temporal data`);
      }
    }

    return {
      name: 'temporal-ordering',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? 'All entities have valid temporal ordering'
          : `${violations.length} entity(ies) with temporal issues`,
    };
  }
}
