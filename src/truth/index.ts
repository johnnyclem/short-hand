/**
 * Truth Ledger Interop Module
 *
 * Consumer-side seam for stenographer's TB/UV asserted-truth ledger.
 * @shorthand/core reads signed TB/UV entries from the append-only wiki
 * JSONL, carries them through compaction under the §7 consumption rules
 * (failing closed on anything it does not understand), and may emit
 * candidate invariants back as PROPOSAL lines — never as signed truth.
 */

// Types
export type {
  TruthConfidence,
  TbStatus,
  UvStatus,
  UnknownStatus,
  TruthEvidence,
  TruthVerifyBy,
  WikiEntryLine,
  TruthTbEntry,
  TruthUvEntry,
  TruthTombstonedLiteral,
  TruthLedgerEntry,
  ConsumptionAction,
  TruthSelection,
  CompactedTruth,
  TruthSyncResult,
  ProposalSignalSource,
  ProposalLine,
  UvProposalLine,
  TbProposalLine,
  UvProposalDraft,
  TbProposalDraft,
  InvariantProposalLine,
} from './types.js';
export {
  CONSUMPTION_RULES,
  TRUTH_SOURCE_PREFIX,
  isAnonymousIdentity,
  assertAccountableAuthor,
  ulid,
} from './types.js';

// JSONL codec + consumption-rule selection
export type { WikiParseResult } from './wiki.js';
export {
  wikiLineToEntry,
  entryToWikiLine,
  literalValidationError,
  parseWikiLines,
  serializeWikiEntries,
  readWikiFile,
  writeWikiFile,
  classifyEntry,
  selectCurrentTruth,
} from './wiki.js';

// Rendering + snapshot compaction bridge
export type { TruthInvariantRecord, ProposeInvariantsOptions, TruthItem } from './compaction-bridge.js';
export {
  TRUTH_SECTION_HEADING,
  renderTruthItems,
  renderTruthLines,
  renderTruthSection,
  applyTruthToSnapshot,
  applyTruthToCompactedState,
  TruthAwareCompactor,
  truthToInvariantRecords,
  proposeInvariants,
  serializeProposals,
  appendProposalsFile,
} from './compaction-bridge.js';

// LSM pipeline: L4 projection + displacement
export { groundTruthToInvariant, displaceStaleInvariants } from './ledger-sync.js';

// LSM pipeline: proposal export
export {
  uvProposal,
  tbProposal,
  invariantsToProposalDrafts,
  tombstonesToProposalDrafts,
  exportProposalDrafts,
} from './proposal-export.js';
