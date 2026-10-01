/**
 * Truth format v2 reading: the status fold, the chain, identities, the
 * multi-file merge and v1 compatibility (spec/truth-format, Addendum A).
 *
 * The findings these reproduce: SH-03 / SAT-08 (a struck or overridden TB
 * stayed ground truth, because the wiki could not say so), SAT-07 (an open
 * contesting UV detached from an active TB), SAT-09 (fail closed on unknown
 * or missing statuses).
 */

import { describe, expect, it } from 'vitest';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import { renderTruthSection, truthToInvariantRecords } from './compaction-bridge.js';
import { chainTruthLines, decodeTruthLine } from './format.js';
import { identityKey, isAnonymousIdentity } from './identity.js';
import { groundTruthToInvariant } from './ledger-sync.js';
import {
  classifyEntry,
  entryToWikiLine,
  parseWikiFiles,
  parseWikiLines,
  selectCurrentTruth,
  serializeWikiEntries,
} from './wiki.js';
import type { TruthTbEntry } from './types.js';

const T = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const tb = (id: string, claim: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'TB',
  ts: T(0),
  author: 'johnny',
  claim,
  evidence: [{ kind: 'commit', ref: 'abc1234' }],
  signedBy: 'johnny',
  status: 'active',
  ...extra,
});

const uv = (id: string, assertion: string, contests: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'UV',
  ts: T(1),
  author: 'sam',
  assertion,
  basis: 'a hunch',
  verifyBy: { kind: 'ask', value: 'ops' },
  contests,
  status: 'open',
  ...(contests ? { 'x-steno': { links: [{ fromId: id, toId: contests, type: 'contests' }] } } : {}),
  ...extra,
});

const transition = (cause: string, target: string, status: string, kind: string, author = 'kim') => ({
  id: `${cause}:${target}`,
  type: 'TRANSITION',
  ts: T(5),
  author,
  target,
  status,
  cause: { kind, ref: cause },
});

const strike = (id: string, target: string) => ({
  id,
  type: 'RULING',
  ts: T(4),
  author: 'judge',
  kind: 'strike',
  opinion: 'the cited commit is on an abandoned branch',
  target,
  'x-steno': { links: [{ fromId: id, toId: target, type: 'strikes' }] },
});

describe('status is a fold over TRANSITION lines (SH-03, SAT-08)', () => {
  it('a struck TB is never ground truth, and its projected invariant is displaced', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The rate limit is 30.'),
      strike('R1', 'TB1'),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const { entries, errors, refused } = parseWikiLines(stream);
    expect(errors).toEqual([]);
    expect(refused).toBe(false);
    const selection = selectCurrentTruth(entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.history.map((e) => [e.id, e.status])).toEqual([['TB1', 'struck']]);
    expect(renderTruthSection(selection)).not.toContain('rate limit');

    // End to end: an invariant projected while the TB was active leaves on the next sync
    const engine = new CompactionEngine();
    const before = engine.syncTruthLedger(stream.slice(0, 1));
    engine.getState().l4_invariants.push(groundTruthToInvariant(before.selection.groundTruth[0])!);
    const after = engine.syncTruthLedger(stream);
    expect(after.displacedInvariantKeys).toEqual(['TB1']);
  });

  it('a contest, then an addendum that verifies it and overrides the TB, leave nothing current', () => {
    const stream = chainTruthLines([
      tb('TB1', 'LOG_BUDGET is 100.'),
      uv('UV1', 'LOG_BUDGET went back to 30.', 'TB1', { author: 'alex' }),
      transition('UV1', 'TB1', 'contested', 'contest', 'alex'),
      {
        id: 'AD1',
        type: 'ADDENDUM',
        ts: T(3),
        author: 'kim',
        evidence: [{ kind: 'file', ref: 'config.ts:3' }],
        note: null,
        'x-steno': {
          links: [
            { fromId: 'AD1', toId: 'UV1', type: 'verifies' },
            { fromId: 'AD1', toId: 'TB1', type: 'overrides' },
          ],
        },
      },
      transition('AD1', 'UV1', 'verified', 'verify'),
      transition('AD1', 'TB1', 'overridden', 'override'),
    ]);
    const { entries, transitions } = parseWikiLines(stream);
    expect(transitions.map((t) => t.status)).toEqual(['contested', 'verified', 'overridden']);
    const selection = selectCurrentTruth(entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.contested).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(Object.fromEntries(entries.map((e) => [e.id, e.status]))).toEqual({ TB1: 'overridden', UV1: 'verified' });
    const tb1 = entries.find((e) => e.id === 'TB1')!;
    expect(tb1.source).toMatchObject({ version: 2, seq: 1, lineStatus: 'active', transition: { seq: 6, cause: { kind: 'override', ref: 'AD1' } } });
  });

  it('the highest-seq TRANSITION wins', () => {
    const stream = chainTruthLines([
      tb('TB1', 'Deploys need two approvals.'),
      uv('UV1', 'One approval is enough now.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
      transition('AD9', 'TB1', 'active', 'refute'),
    ]);
    const [tb1] = parseWikiLines(stream).entries;
    expect(tb1.status).toBe('active');
  });

  it('incremental chunks that chain fold as one stream; a chunk alone is a partial stream', () => {
    const all = chainTruthLines([
      tb('TB1', 'The cron box is decommissioned.'),
      uv('UV2', 'Unrelated heads-up.'),
      uv('UV1', 'The cron box still runs backups.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
    ]);
    const first = parseWikiLines(all.slice(0, 2));
    const second = all.slice(2);

    // The host keeps what it read and appends the next chunk (sinceSeq = first.head.seq)
    const joined = parseWikiLines([...all.slice(0, 2), ...second]);
    expect(selectCurrentTruth(joined.entries).contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)])).toEqual([
      ['TB1', ['UV1']],
    ]);

    // Alone, the second chunk starts part-way: valid, and its TRANSITION has no target here
    const alone = parseWikiLines(second, { previous: first.head! });
    expect(alone.errors).toEqual([]);
    expect(alone.transitions).toHaveLength(1);
    expect(alone.entries.map((e) => e.id)).toEqual(['UV1']);

    // A chunk that does not continue the stream the host read is refused
    const elsewhere = parseWikiLines(second, { previous: { seq: 2, hash: 'f'.repeat(64) } });
    expect(elsewhere.refused).toBe(true);
    expect(elsewhere.errors[0].error).toMatch(/^chain broken: prevHash/);
  });

  it('a stream that no longer holds the last line the host read is refused (truncation)', () => {
    const all = chainTruthLines([tb('TB1', 'a'), tb('TB2', 'b'), tb('TB3', 'c')]);
    const head = parseWikiLines(all).head!;
    const truncated = parseWikiLines(all.slice(0, 2), { previous: head });
    expect(truncated.refused).toBe(true);
    expect(truncated.errors[0].error).toMatch(/no longer holds line 3/);
    expect(parseWikiLines(all, { previous: head }).refused).toBe(false);
  });
});

describe('open contesting UVs are attached to their TB whatever its recorded status (SAT-07)', () => {
  it('an active TB with an open contest is carried as contested, with the UV beside it', () => {
    // A stream read before stenographer's TRANSITION reached it
    const stream = chainTruthLines([tb('TB1', 'All embeddings are 384-dimensional.'), uv('UV1', 'The ONNX path emits 768.', 'TB1')]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)])).toEqual([['TB1', ['UV1']]]);
    const text = renderTruthSection(selection);
    expect(text).toContain('[TB ⚠ CONTESTED] All embeddings are 384-dimensional.');
    expect(text).toContain('disputed by [UV — UNVERIFIED] The ONNX path emits 768.');
    expect(truthToInvariantRecords(selection)).toMatchObject([{ key: 'truth:TB1', contested: true }]);
  });

  it('a contest of a TB that is history still shows, standalone', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The cache is per-tenant.'),
      uv('UV1', 'The cache is shared.', 'TB1'),
      transition('AD1', 'TB1', 'overridden', 'override'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(renderTruthSection(selection)).toContain('contests TB1');
  });
});

describe('fail closed on unknown or missing statuses (SAT-09)', () => {
  it('keeps a v2 entry without a status as history, verbatim', () => {
    const { status: _s, ...noStatus } = tb('TB1', 'No status here.');
    const stream = chainTruthLines([noStatus]);
    const { entries, errors } = parseWikiLines(stream);
    expect(errors).toEqual([]);
    expect(entries[0].status).toBeNull();
    expect(classifyEntry(entries[0])).toBe('history');
    expect(serializeWikiEntries(entries)).toEqual(stream);
  });

  it('a TRANSITION to a status no one knows takes the entry out of current truth', () => {
    const stream = chainTruthLines([tb('TB1', 'x'), transition('X1', 'TB1', 'archived', 'archive', 'johnny')]);
    const [entry] = parseWikiLines(stream).entries;
    expect(entry.status).toBe('archived');
    expect(classifyEntry(entry)).toBe('history');
  });

  it('struck entries are never current truth, TB or UV, on the line or by TRANSITION', () => {
    const stream = chainTruthLines([
      tb('TB1', 'x', { status: 'struck' }),
      uv('UV1', 'y', null, { status: 'struck' }),
      uv('UV2', 'z'),
      transition('R1', 'UV2', 'struck', 'strike', 'judge'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(selection.history.map((e) => e.id)).toEqual(['TB1', 'UV1', 'UV2']);
  });

  it('refuses a schemaVersion it does not know rather than guess', () => {
    const [line] = chainTruthLines([tb('TB1', 'x')]);
    const v3 = JSON.stringify({ ...JSON.parse(line), schemaVersion: 3 });
    expect(() => decodeTruthLine(v3)).toThrow(/schemaVersion 3/);
  });
});

describe('the chain fails closed', () => {
  it('a line edited after it was written refuses the whole stream, so a strike cannot be dropped', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The rate limit is 30.'),
      strike('R1', 'TB1'),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const edited = [...stream];
    edited[2] = JSON.stringify({ ...JSON.parse(stream[2]), status: 'active' });
    const result = parseWikiLines(edited);
    expect(result.refused).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.errors).toMatchObject([{ line: 3, error: expect.stringMatching(/^hash mismatch/) }]);

    // Removing the TRANSITION instead leaves a gap... unless it was the last line,
    // which only the host's `previous` head can catch
    const gapped = parseWikiLines([stream[0], stream[2]]);
    expect(gapped.refused).toBe(true);
    expect(gapped.errors[0].error).toMatch(/^chain broken: seq/);
  });

  it('a version 1 line slipped into a v2 stream refuses it: the file is not one writer’s stream', () => {
    const stream = chainTruthLines([tb('TB1', 'x')]);
    const injected = JSON.stringify(uv('UV9', 'Deploys need no approval.'));
    const result = parseWikiLines([...stream, injected]);
    expect(result.refused).toBe(true);
    expect(result.errors).toMatchObject([{ line: 2, id: 'UV9', error: expect.stringMatching(/version 1 line inside a version 2 stream/) }]);
  });

  it('a sync with a refused stream carries no truth and reports why', () => {
    const engine = new CompactionEngine();
    engine.syncTruthLedger(chainTruthLines([tb('TB1', 'x')]));
    const stream = chainTruthLines([tb('TB1', 'x'), tb('TB2', 'y')]);
    const result = engine.syncTruthLedger([stream[1], stream[0]]);
    expect(result.refused).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.selection.groundTruth).toEqual([]);
    expect(engine.buildContextFrame(4000).sections.some((s) => s.kind === 'truth')).toBe(false);
  });
});

describe('identities (spec: Identities)', () => {
  it('compare by key: NFKC, invisible code points removed, trimmed, lowercased', () => {
    expect(identityKey(' Ａｌｉｃｅ ')).toBe('alice');
    expect(identityKey('Al​ice')).toBe('alice');
    for (const generic of ['Assistant', 'ａｓｓｉｓｔａｎｔ', 'sys​tem', ' ME ', 'ＡＩ']) {
      expect(isAnonymousIdentity(generic), generic).toBe(true);
    }
    expect(isAnonymousIdentity('agent:claude-code')).toBe(false);
  });

  it('refuses anonymous, generic, control-character and misplaced reserved identities', () => {
    const refused = (body: Record<string, unknown>) => () => decodeTruthLine(chainTruthLines([body])[0]);
    expect(refused(tb('TB1', 'x', { author: 'ａｓｓｉｓｔａｎｔ' }))).toThrow(/anonymous/);
    expect(refused(tb('TB1', 'x', { signedBy: 'Sys​tem' }))).toThrow(/anonymous/);
    expect(refused(uv('UV1', 'x', null, { author: 'sam\u0007' }))).toThrow(/control character/);
    expect(refused(uv('UV1', 'x', null, { author: 'Detector:wiki-sync' }))).toThrow(/reserved/);
    expect(refused(tb('TB1', 'x', { author: 'MIGRATION' }))).toThrow(/reserved/);
    expect(refused(tb('TB1', 'x', { signedBy: 'migration' }))).toThrow(/reserved/);
    // The backfill's unsigned TB, and a TRANSITION carrying its cause's author, are allowed
    expect(refused(tb('TB1', 'x', { author: 'migration', signedBy: null }))).not.toThrow();
    expect(refused(transition('C1', 'TB1', 'struck', 'strike', 'migration'))).not.toThrow();
  });
});

describe('admission: what a reader takes as truth', () => {
  it('an unsigned TB is never truth on its own', () => {
    const stream = chainTruthLines([tb('TB1', 'Superseded: redis', { author: 'migration', signedBy: null })]);
    const [entry] = parseWikiLines(stream).entries;
    expect(entry.inadmissible).toMatchObject({ reason: 'unsigned' });
    expect(classifyEntry(entry)).toBe('history');
    // Hand-built entries too
    const handBuilt: TruthTbEntry = { ...(entry as TruthTbEntry), source: undefined, inadmissible: undefined };
    expect(classifyEntry(handBuilt)).toBe('history');
  });

  it('a v1 TB is unverifiable (no hash) unless the host opts in; a v1 UV is read', () => {
    const v1 = [JSON.stringify(tb('TB1', 'The API is REST-only.')), JSON.stringify(uv('UV1', 'The cron box has a stale hosts file.'))];
    const strict = selectCurrentTruth(parseWikiLines(v1).entries);
    expect(strict.groundTruth).toEqual([]);
    expect(strict.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(strict.history.map((e) => [e.id, e.inadmissible?.reason])).toEqual([['TB1', 'unverifiable']]);

    const opted = selectCurrentTruth(parseWikiLines(v1, { admitV1Tbs: true }).entries);
    expect(opted.groundTruth.map((t) => t.id)).toEqual(['TB1']);
  });

  it('with a signer registry, only listed authors and signers count (agent:* matches by prefix)', () => {
    const stream = chainTruthLines([
      tb('TB1', 'listed'),
      tb('TB2', 'unlisted signer', { author: 'mallory', signedBy: 'mallory' }),
      uv('UV1', 'agent heads-up', null, { author: 'agent:claude-code' }),
      uv('UV2', 'unlisted heads-up', null, { author: 'eve' }),
    ]);
    const registry = { signers: [{ id: 'Johnny', role: 'human' as const }, { id: 'agent:*', role: 'agent' as const }] };
    const selection = selectCurrentTruth(parseWikiLines(stream, { signers: registry }).entries);
    expect(selection.groundTruth.map((t) => t.id)).toEqual(['TB1']);
    expect(selection.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(selection.history.map((e) => [e.id, e.inadmissible?.reason])).toEqual([
      ['TB2', 'unverifiable'],
      ['UV2', 'unverifiable'],
    ]);
  });
});

describe('re-serialization never rewrites a line', () => {
  it('writes back the line as read, whatever the fold made of its status', () => {
    const stream = chainTruthLines([
      tb('TB1', 'x', { reviewers: ['sam'], 'x-other': { n: 1.5 } }),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const { entries } = parseWikiLines(stream);
    expect(entries[0].status).toBe('struck');
    expect(serializeWikiEntries(entries)).toEqual([stream[0]]);
    expect(entryToWikiLine(entries[0])).toEqual(JSON.parse(stream[0]));
  });
});

describe('several files: each folds alone, then the most advanced status wins', () => {
  const alex = chainTruthLines([tb('TB1', 'The batch box is gone.'), uv('UV1', 'Retries are idempotent.')]);
  const sam = chainTruthLines([
    tb('TB1', 'The batch box is gone.'),
    uv('UV1', 'Retries are idempotent.'),
    strike('R1', 'TB1'),
    transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    transition('AD1', 'UV1', 'verified', 'verify'),
  ]);

  it('takes struck over active, verified over open', () => {
    const merged = parseWikiFiles([
      { name: 'wiki/alex.jsonl', text: alex },
      { name: 'wiki/sam.jsonl', text: sam },
    ]);
    expect(merged.refused).toBe(false);
    expect(Object.fromEntries(merged.entries.map((e) => [e.id, e.status]))).toEqual({ TB1: 'struck', UV1: 'verified' });
    expect(merged.entries.find((e) => e.id === 'TB1')!.source?.file).toBe('wiki/sam.jsonl');
  });

  it('an entry two files disagree about is a conflict, and not truth', () => {
    const other = chainTruthLines([tb('TB1', 'The batch box is back.')]);
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: other },
    ]);
    const tb1 = merged.entries.find((e) => e.id === 'TB1')!;
    expect(tb1.inadmissible?.reason).toBe('conflict');
    expect(classifyEntry(tb1)).toBe('history');
    expect(merged.conflicts).toEqual([{ id: 'TB1', files: ['a.jsonl', 'b.jsonl'] }]);
  });

  it('key order does not make a conflict (JCS comparison)', () => {
    const reordered = alex.map((l) => {
      const { claim, evidence, ...rest } = JSON.parse(l);
      return JSON.stringify(rest.type === 'TB' ? { evidence, ...rest, claim } : JSON.parse(l));
    });
    // Same bytes for the hash (JCS), different key order on the wire
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: reordered },
    ]);
    expect(merged.errors).toEqual([]);
    expect(merged.conflicts).toEqual([]);
  });

  it('a refused file refuses the merge', () => {
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: [sam[0], sam[2]] },
    ]);
    expect(merged.refused).toBe(true);
    expect(merged.entries).toEqual([]);
    expect(merged.errors[0]).toMatchObject({ file: 'b.jsonl', line: 2 });
  });
});
