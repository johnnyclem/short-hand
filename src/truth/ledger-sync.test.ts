import { describe, it, expect } from 'vitest';
import {
  parseTruthLedgerJsonl,
  buildTruthLedgerView,
  renderTruthSection,
  citableToInvariant,
  displaceStaleInvariants,
} from './ledger-sync.js';
import {
  exportProposalDrafts,
  invariantsToProposalDrafts,
  tombstonesToProposalDrafts,
} from './proposal-export.js';
import { TRUTH_SOURCE_PREFIX, type TruthLedgerLine } from './types.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import type { CompactedState, Invariant } from '../types.js';

// Line shapes mirror stenographer's exportWikiEntries output.
function tb(id: string, status: string, claim: string, signedBy = 'johnny'): TruthLedgerLine {
  return {
    id,
    type: 'TB',
    ts: '2026-09-19T12:00:00.000Z',
    author: 'johnny',
    claim,
    evidence: [{ kind: 'commit', ref: 'abc123' }],
    signedBy,
    status,
    'x-steno': { origin: 'local', provenance: { kind: 'manual' }, agentSessionId: null, links: [] },
  };
}

function uv(id: string, status: string, assertion: string, contests: string | null = null): TruthLedgerLine {
  return {
    id,
    type: 'UV',
    ts: '2026-09-19T12:00:00.000Z',
    author: 'johnny',
    assertion,
    basis: 'seen in production',
    verifyBy: { kind: 'ask', value: 'johnny' },
    contests,
    status,
    'x-steno': { origin: 'local', provenance: { kind: 'manual' }, agentSessionId: null, links: [] },
  };
}

function emptyState(): CompactedState {
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

describe('parseTruthLedgerJsonl', () => {
  it('parses valid lines and reports bad ones without aborting', () => {
    const lines = [
      JSON.stringify(tb('01A', 'active', 'We use PostgreSQL.')),
      'not json at all',
      JSON.stringify({ id: '01B', type: 'RULING', status: 'x' }),
      JSON.stringify(uv('01C', 'open', 'The cache TTL is 60 seconds.')),
    ];
    const { entries, errors } = parseTruthLedgerJsonl(lines);
    expect(entries.map((e) => e.id)).toEqual(['01A', '01C']);
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2);
    expect(errors[1].error).toContain('unsupported entry type');
  });

  it('is last-line-wins per id (append-only file, statuses evolve)', () => {
    const lines = [
      JSON.stringify(tb('01A', 'active', 'We use PostgreSQL.')),
      JSON.stringify(tb('01A', 'overridden', 'We use PostgreSQL.')),
    ];
    const { entries } = parseTruthLedgerJsonl(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('overridden');
  });

  it('accepts a single newline-joined string', () => {
    const blob = [tb('01A', 'active', 'A'), uv('01B', 'open', 'B')]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(parseTruthLedgerJsonl(blob).entries).toHaveLength(2);
  });
});

describe('buildTruthLedgerView (§7 consumption rules)', () => {
  it('buckets active TB as citable, open UV as flag, the rest as displaced', () => {
    const view = buildTruthLedgerView([
      tb('T1', 'active', 'We use PostgreSQL.'),
      tb('T2', 'overridden', 'We use MySQL.'),
      uv('U1', 'open', 'The importer is idempotent.'),
      uv('U2', 'refuted', 'The importer runs nightly.'),
      uv('U3', 'verified', 'Auth uses JWT.'),
    ]);
    expect(view.citable.map((c) => c.entry.id)).toEqual(['T1']);
    expect(view.flags.map((f) => f.id)).toEqual(['U1']);
    expect(view.displaced.map((d) => d.id).sort()).toEqual(['T2', 'U2', 'U3']);
  });

  it('carries the contesting UV with its contested TB, not as a standalone flag', () => {
    const view = buildTruthLedgerView([
      tb('T1', 'contested', 'Deploys go through CI.'),
      uv('U1', 'open', 'Hotfixes are deployed manually.', 'T1'),
      uv('U2', 'open', 'Unrelated open belief.'),
    ]);
    expect(view.citable).toHaveLength(1);
    expect(view.citable[0].contestedBy.map((u) => u.id)).toEqual(['U1']);
    expect(view.flags.map((f) => f.id)).toEqual(['U2']);
  });
});

describe('renderTruthSection', () => {
  it('never renders an open UV as proven, and shows both sides of a dispute', () => {
    const view = buildTruthLedgerView([
      tb('T1', 'active', 'We use PostgreSQL.'),
      tb('T2', 'contested', 'Deploys go through CI.'),
      uv('U1', 'open', 'Hotfixes are deployed manually.', 'T2'),
      uv('U2', 'open', 'The cache TTL is 60 seconds.'),
    ]);
    const lines = renderTruthSection(view);
    expect(lines[0]).toBe('[truth] We use PostgreSQL. (signed: johnny)');
    expect(lines[1]).toContain('[truth, contested] Deploys go through CI.');
    expect(lines[2]).toContain('disputed by unverified assertion');
    expect(lines[2]).toContain('Hotfixes are deployed manually.');
    const uvLine = lines.find((l) => l.includes('cache TTL'));
    expect(uvLine).toContain('[unverified]');
    expect(uvLine).not.toContain('[truth]');
  });

  it('renders nothing for displaced entries', () => {
    const view = buildTruthLedgerView([tb('T1', 'overridden', 'Old truth.')]);
    expect(renderTruthSection(view)).toEqual([]);
  });
});

describe('L4 projection and displacement', () => {
  it('projects an uncontested citable TB with the truth: source prefix', () => {
    const view = buildTruthLedgerView([tb('T1', 'active', 'We use PostgreSQL.')]);
    const inv = citableToInvariant(view.citable[0]);
    expect(inv).not.toBeNull();
    expect(inv!.sourceMessage).toBe(`${TRUTH_SOURCE_PREFIX}T1`);
    expect(inv!.value).toBe('We use PostgreSQL.');
  });

  it('refuses to project a contested TB (an invariant row cannot carry the asterisk)', () => {
    const view = buildTruthLedgerView([
      tb('T1', 'contested', 'Deploys go through CI.'),
      uv('U1', 'open', 'Hotfixes are deployed manually.', 'T1'),
    ]);
    expect(citableToInvariant(view.citable[0])).toBeNull();
  });

  it('displaces cached invariants whose entry was overridden, keeps the rest', () => {
    const invariants: Invariant[] = [
      { key: 'T1', value: 'Old truth.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T1`, timestamp: 1 },
      { key: 'T2', value: 'Live truth.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T2`, timestamp: 1 },
      { key: 'db', value: 'postgres', sourceMessage: 'msg-9', timestamp: 1 },
    ];
    const view = buildTruthLedgerView([
      tb('T1', 'overridden', 'Old truth.'),
      tb('T2', 'active', 'Live truth.'),
    ]);
    const { kept, displacedKeys } = displaceStaleInvariants(invariants, view);
    expect(displacedKeys).toEqual(['T1']);
    expect(kept.map((i) => i.key).sort()).toEqual(['T2', 'db']);
  });
});

describe('CompactionEngine.syncTruthLedger', () => {
  it('puts synced truth first in the context frame', async () => {
    const engine = new CompactionEngine({ memtableSize: 10, contextBudget: 4000 });
    await engine.addMessage({ id: 'm1', role: 'user', content: 'hello there', timestamp: Date.now() });

    const result = engine.syncTruthLedger([
      JSON.stringify(tb('T1', 'active', 'We use PostgreSQL.')),
      JSON.stringify(uv('U1', 'open', 'The cache TTL is 60 seconds.')),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.view.citable).toHaveLength(1);

    const frame = engine.buildContextFrame(2000);
    expect(frame.sections[0].content).toContain('[truth] We use PostgreSQL.');
    expect(frame.sections[0].content).toContain('[unverified] The cache TTL is 60 seconds.');
  });

  it('a later sync displaces truth the frame previously carried', () => {
    const engine = new CompactionEngine();
    engine.syncTruthLedger([JSON.stringify(tb('T1', 'active', 'We use PostgreSQL.'))]);
    const view = engine.getTruthView()!;
    engine.getState().l4_invariants.push(citableToInvariant(view.citable[0])!);

    const result = engine.syncTruthLedger([
      JSON.stringify(tb('T1', 'overridden', 'We use PostgreSQL.')),
    ]);
    expect(result.displacedInvariantKeys).toEqual(['T1']);
    expect(engine.getState().l4_invariants).toHaveLength(0);
    expect(engine.buildContextFrame(2000).sections.every((s) => !s.content.includes('PostgreSQL'))).toBe(true);
  });
});

describe('proposal export (write path is proposals only)', () => {
  it('drafts a UV per L4 invariant, skipping ledger-sourced ones', () => {
    const state = emptyState();
    state.l4_invariants = [
      { key: 'database', value: 'PostgreSQL', sourceMessage: 'msg-3', timestamp: 1 },
      { key: 'T9', value: 'From the ledger.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T9`, timestamp: 1 },
    ];
    const drafts = invariantsToProposalDrafts(state);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('uv');
    expect(drafts[0].draft.assertion).toBe('The invariant "database" holds: PostgreSQL.');
    expect(drafts[0].targetRef).toBe('shorthand:invariant:database');
    expect(drafts[0].provenance).toEqual({ kind: 'sourceMessageId', ref: 'msg-3' });
    // No author field anywhere — accountability is supplied at intake, not here.
    expect('author' in drafts[0]).toBe(false);
    expect('signedBy' in drafts[0].draft).toBe(false);
  });

  it('drafts a tombstone per correction with message evidence', () => {
    const state = emptyState();
    state.tombstones = [
      {
        supersededContent: 'We use MySQL',
        originalMessageId: 'm1',
        correctionMessageId: 'm5',
        reason: 'user correction',
        timestamp: Date.now(),
        correctedValue: 'PostgreSQL',
      },
    ];
    const drafts = tombstonesToProposalDrafts(state);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('tombstone');
    expect(drafts[0].draft.claim).toContain('"We use MySQL" no longer holds');
    expect(drafts[0].draft.claim).toContain('superseded by "PostgreSQL"');
    expect(drafts[0].draft.evidence).toEqual([
      { kind: 'message', ref: 'm5', detail: 'user correction' },
    ]);
    expect(drafts[0].draft.signedBy).toBeNull();
  });

  it('serializes to one JSON object per line', () => {
    const state = emptyState();
    state.l4_invariants = [{ key: 'db', value: 'postgres', sourceMessage: 'm1', timestamp: 1 }];
    const lines = exportProposalDrafts(state);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(JSON.parse(lines[0]).signal.source).toBe('compaction-candidate');
  });
});
