# CRDT wire format and guarantees

**Status:** experimental API, `schemaVersion: 1`. The merge laws below are property-tested; the limits in [What is not guaranteed](#what-is-not-guaranteed) are why the surface is still marked experimental.

`@shorthand/core/crdt` holds state-based CRDTs: a replica serializes its whole state, sends it however it likes (file, HTTP, message bus), and any other replica merges it in any order. This page is the contract for that serialized state: what each field means, how a merge resolves it, what a merge refuses, and the exact properties replicas get.

## Guarantees

For the LWW-Register, OR-Set, G-Set (with the default merge function), RGA, `AgentMemory` and the replicated part of `ActiveEngramStore`, under the [preconditions](#preconditions):

- **Convergence.** Two replicas that have merged the same set of states hold the same replicated state, whatever the order and grouping of the merges and whatever ran concurrently. This covers equal-counter ties between agents, concurrent inserts at the same RGA position (the head included) and, for the LWW-Register only, two writers that share an agent id.
- **Join laws.** On every reachable state, `merge` is commutative, associative and idempotent: merging a state twice changes nothing and returns `false`.
- **Restore.** A replica restored with `from` / `AgentMemory.from` / `ActiveEngramStore.deserialize` from its own serialized state behaves exactly like the original afterwards: it issues the same next timestamps, tags and ids (engram ids are random UUIDs unless the store's `generateId` option is deterministic), and holds the same state after the same operations.
- **Fail-closed merges.** A state that is not well formed (wrong types, a non-integer or negative counter, an RGA node that is not causally after its predecessor, a newer `schemaVersion`) makes `merge` throw a `TypeError` before it changes anything. `ActiveEngramStore.mergeFrom` instead drops and reports individual invalid engrams.

`src/crdt/crdt-properties.test.ts` checks each of these with fast-check on random histories of three replicas (local operations interleaved with pairwise syncs, every state crossing a JSON round trip); `src/crdt/convergence.test.ts` pins the audited regressions.

### Preconditions

1. **One live writer per replica id.** Every replica that writes has its own agent id, and a process that restarts restores its saved state (`from`) before it writes again. Lamport counters, OR-Set tags, G-Set ids and RGA node ids are `(agentId, counter)` pairs; a second writer with the same id issues the same pairs. What happens if it does: the LWW-Register still converges (see its tie-break) but a write may lose to an older one; an OR-Set tag can collide, so removing one element can remove another; an RGA merge throws (`node a:1 differs between replicas`) rather than diverge silently.
2. **Honest peers.** Merges validate structure, not authority. Any peer can win an LWW key by claiming a large counter, tombstone any OR-Set tag or engram, and claim any engram `origin`. Authenticate peers at the transport and merge only from peers you trust (see the [engram trust model](#activeengramstore)).
3. **Total-order merge functions.** A custom `GSet` merge function must return the greater of its two arguments under a total order. The default does.

## Common conventions

- **`schemaVersion`** — `1` on every state written by 1.0. A state without it is pre-1.0 and still loads (see [Compatibility](#compatibility-with-pre-10-states)); any other value is rejected.
- **Lamport timestamp** — `{ counter, agentId }`, `counter` a non-negative safe integer. Each CRDT instance owns its clock (there is no process-global clock and no API takes a caller-supplied timestamp). Order: `counter`, then `agentId` by UTF-16 code units.
- **`clock`** — the serializing replica's Lamport counter. `from` restores it, and every merge advances the local clock to at least the remote `clock` and every counter it sees, so later local events are ordered after everything observed and a restored replica never reissues a counter.
- **Vector clock** — `{ [agentId]: counter }`; a missing entry means 0.
- **Canonical JSON** — object keys sorted by UTF-16 code units, no whitespace, `undefined` members dropped. Used for tie-breaks and equality, so key order never matters.
- **Ordering of serialized collections** — sorted (keys, tags, tombstones, entries by key, engrams by id), except RGA nodes, which are in sequence order. Converged replicas therefore serialize identically apart from per-replica fields (`clock`, engram `retrievalCount` / `importanceScore`, `AgentMemory.agentId`).

## LWW-Register

```json
{
  "schemaVersion": 1,
  "clock": 3,
  "vc": { "agent-a": 3, "agent-b": 1 },
  "entries": {
    "database": { "value": "PostgreSQL", "timestamp": { "counter": 3, "agentId": "agent-a" }, "vc": { "agent-a": 3, "agent-b": 1 } },
    "cache":    { "deleted": true, "timestamp": { "counter": 2, "agentId": "agent-a" }, "vc": { "agent-a": 2 } }
  }
}
```

- `entries[key].value` — the value; absent on a tombstone (`deleted: true`, written by `delete`). A pre-1.0 entry without a value is a tombstone.
- `entries[key].vc` — the writer's vector clock when it wrote the entry (this write included). `ConflictDetector` uses it to tell a causal overwrite from a concurrent write.
- `vc` — join of every vector clock the replica has observed.
- **Merge:** per key, the greater entry in this total order wins: Lamport timestamp; then a tombstone over a value; then the canonical JSON of the whole entry. The last two steps only decide between entries with an identical `(counter, agentId)` — two writers sharing an id — and make that case converge too. `has(key)` is false for a tombstoned key.

## OR-Set

```json
{
  "schemaVersion": 1,
  "clock": 4,
  "elements": [{ "element": { "id": "pg", "name": "PostgreSQL", "type": "database" }, "tags": ["agent-a:1", "agent-b:4"] }],
  "removed": ["agent-a:2"]
}
```

- Elements are identified by their canonical JSON. Each `add` issues a tag `<agentId>:<counter>`; `remove` moves every tag it has observed for the element into `removed`.
- **Merge:** union of tags minus union of `removed`; an element is present while it has a tag nobody removed (a concurrent add wins over a remove). The clock advances past every tag counter seen.

## G-Set

```json
{
  "schemaVersion": 1,
  "clock": 2,
  "entries": [
    { "value": { "topic": "api", "content": "use REST", "timestamp": "…" }, "sourceAgent": "agent-a", "isDirectParticipant": true, "dedupeKey": "api" },
    { "value": "keyless note", "sourceAgent": "agent-a", "isDirectParticipant": false, "dedupeKey": "__id:agent-a:2" }
  ]
}
```

- Every entry has an explicit id, `dedupeKey`: the caller's key, or `__id:<replicaId>:<counter>` issued by `add` (`replicaId` is the `GSet` option, defaulting to the entry's `sourceAgent`). Values are never used as keys. Keys starting with `__` are reserved. `clock` is the last issued counter.
- **Merge:** union by key; two entries with the same key are resolved by the merge function. The default keeps the direct participant's entry, then the longer value, then the entry whose canonical JSON sorts last.

## RGA

```json
{
  "schemaVersion": 1,
  "clock": 3,
  "nodes": [
    { "id": { "agentId": "b", "counter": 1 }, "value": "A",  "timestamp": { "counter": 1, "agentId": "b" }, "parent": null, "deleted": false },
    { "id": { "agentId": "b", "counter": 2 }, "value": "A1", "timestamp": { "counter": 2, "agentId": "b" }, "parent": { "agentId": "b", "counter": 1 }, "deleted": false },
    { "id": { "agentId": "a", "counter": 1 }, "value": "B",  "timestamp": { "counter": 1, "agentId": "a" }, "parent": null, "deleted": false }
  ]
}
```

- A node's `timestamp` equals its `id`; `parent` is the node it was inserted after (`null` = the head). Deleted nodes stay as tombstones (`deleted: true`).
- **Placement:** a node goes right after its parent, past every node with a greater timestamp. Since a node's timestamp is always greater than its parent's, this skips concurrent siblings inserted later together with everything that follows them, at the head as anywhere else. The sequence is a function of the node set (the pre-order of the parent tree with siblings newest first), not of arrival order.
- **Merge:** new nodes are integrated in ascending timestamp order; `deleted` is or-ed. `merge` throws on a node whose timestamp differs from its id, a node not causally after its parent, a parent that is in neither replica, or an id whose value or parent differs between the two sides (a replica id reused without restoring). `insertAfter` throws on an unknown reference node.

## ActiveEngramStore

```json
{
  "schemaVersion": 1,
  "engrams": [{
    "id": "6f1c…", "origin": "agent-a", "payload": "The user is on the free tier.",
    "interpreterTemplate": "Earlier note, still relevant: {{payload}}",
    "activationPolicy": { "surfaceWhenTopics": ["billing"] },
    "importanceScore": 0.8, "createdAt": 1733000000000, "retrievalCount": 2
  }],
  "removed": ["0a9e…"]
}
```

- Ids are random UUIDs (or the store's `generateId` option); `origin` is the agent id of the creating store (`AgentMemory` passes its own).
- **Replicated:** the set of engrams by id, each with immutable content (`payload`, `interpreterTemplate`, `activationPolicy`, `createdAt`, `derivedFrom`, `origin`), minus the union of `removed` tombstones.
- **Per replica:** `retrievalCount` (how often this replica surfaced the engram) and `importanceScore` after first receipt (host-controlled; only `setImportance` changes it). Replicas do not converge on these.

### Trust model (`mergeFrom(state, { from })`)

A peer's state can:

- add engrams the store has never seen — each is schema-validated (invalid ones are listed in the report's `rejected` and not stored), unknown fields are dropped, `importanceScore` is clamped to [0, 1] (non-finite is rejected), and `retrievalCount` starts at 0;
- delete any engram by tombstoning its id — removal is not authority-checked, so a "forget X" on any replica reaches every replica, and a tombstoned id never comes back;
- correct only its own memories: `shadowsEngramId` takes effect only between engrams of the same `origin`.

It cannot change an engram the store already holds (a differing copy of a known id is rejected), change a stored importance score or retrieval count, or resurrect a tombstoned engram. `origin` is asserted by the state, not authenticated: a peer that forges raw state can claim any origin. `from` (the transport-authenticated peer id) is used as the origin of pre-1.0 engrams that carry none. `loadFrom` / `deserialize` restore a store's own saved state and keep its counts and scores.

### Corrections (shadowing)

Engrams linked by `shadowsEngramId` (same origin, correcting engram not expired) form a chain rooted at the corrected engram. A chain produces at most one recall slot, addressed under the root's id and interpreted from its newest correction (latest `createdAt`, then greatest id). The slot surfaces when any member of the chain would be eligible on its own and the newest correction is within its `maxRetrievals`. A corrected engram never surfaces with its own text, in any context; if the correction's interpreter fails (`retrieveAsync`) the slot is dropped rather than falling back to the stale text. Correction links that form a cycle are ignored.

## AgentMemory

```json
{
  "schemaVersion": 1,
  "agentId": "agent-a",
  "vectorClock": { "agent-a": 7, "agent-b": 2 },
  "l4": { "layer": "L4", "state": { "…": "LWW-Register<string>" } },
  "l3": { "layer": "L3", "nodes": { "…": "OR-Set<L3Entity>" }, "edges": { "…": "LWW-Register<L3Edge>" } },
  "l2": { "…": "G-Set<L2Summary>" },
  "l1": { "…": "RGA<L1Context>" },
  "l0": { "…": "RGA<L0Message>" },
  "activeEngrams": { "…": "ActiveEngramStore" }
}
```

Each layer is the state of the CRDT above and merges independently; `vectorClock` (one tick per operation) merges component-wise. `mergeFrom` passes `agentId` to the engram store as `from`. A layer that fails validation throws after the layers before it have merged; each layer is still a valid state. `AgentMemory.from` restores every layer, clock and engram (with its counts).

`ConflictDetector` reports an L4 or L3 conflict only for two entries of the same key whose writes were concurrent (neither writer's `vc` covers the other's timestamp) or that share a timestamp with different content. A causal overwrite — an update made after seeing the old value, directly or through a relay — is not reported. L2 has no causal metadata; its check stays structural.

## Compatibility with pre-1.0 states

States without `schemaVersion` load: LWW entries without `vc` (treated as concurrent by `ConflictDetector`) and with `value: undefined` (tombstones), OR-Sets without `removed`, G-Set entries keyed `__content:…` or `__auto_<n>` (kept as-is), RGA states without `clock` (the clock is taken from the node counters) and engrams without `origin` (they take the merging peer's `from`, or the restoring store's own origin). A G-Set entry without `dedupeKey` is rejected. short-hand 0.1 `AgentMemory` snapshots (a different format altogether) do not load.

## What is not guaranteed

- Byzantine peers: nothing is signed, so the [preconditions](#preconditions) on honest peers and unique replica ids are assumptions, not checks (beyond the RGA collision error).
- Tombstones (LWW tombstones, OR-Set `removed`, RGA deleted nodes, engram `removed`) are never collected; state grows with the history.
- `importanceScore` and `retrievalCount` of engrams, and the order of equal-importance recall results when those scores differ, are per replica.
- `ConflictDetector` L2 checks and its `threshold` are structural placeholders, not semantic detection.
