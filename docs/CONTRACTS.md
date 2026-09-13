# Internal contracts

The shapes every module agrees on. Change them here first.

## Trust model

- **Publisher, not literals.** An object is attributed to the address in its
  Verifiable Memory graph, `did:dkg:context-graph:<cg>/_verifiable_memory/<addr>/<n>`.
  That address is chain-bound: the KA id is `(author << 96) | n`, and sync rechecks
  the on-chain Merkle root. The self-declared `mandate:grantor` and
  `mandate:stateAuthor` literals must agree with the publisher or the object is a
  forgery.
- **An anchor** is the `<cg>/_meta` row set whose subject is a KA UAL
  (`dkg:kaUal` self-link) with `dkg:status "confirmed"`, `dkg:assertionGraph` equal
  to the graph derived from the UAL, and `dkg:publicTripleCount`. `prov:wasAttributedTo`
  exists only on the publishing node; when present it must equal the path address.
  `dkg:transactionHash` is absent on the finalized-materialization lane and is not
  required.
- **Self-certifying subjects.** `0x<40 lowercase hex>:<local>`, local matching
  `^[a-z0-9][a-z0-9-]{0,62}$`. A grant is accepted only when its publisher equals
  the subject's address and the address in `mandate:grantor`. A state assertion is
  accepted only when its publisher equals its grant's publisher.
- **Revocation is terminal per grant IRI.** Unknown state values count as revoked.
- **Tiers.** `vm` may permit or clear. `swm` revocations warn. A revocation seen
  only in the merged `<cg>/context/<id>` graph with no twin in any
  `_verifiable_memory` graph refuses.
- **Deny list.** `adult` / `sexual` and `deceptive-impersonation` are always refused.

## Read consistency

DKG v10.0.16 `/api/query` intermittently omits whole named graphs (docs/SPIKES.md).
A graph comes back whole or not at all; nothing is invented. Reads are therefore
scoped to one publisher's Verifiable Memory prefix,
`did:dkg:context-graph:<cg>/_verifiable_memory/<addr>/`, and each attempt runs:

1. `_meta` rows whose UAL path contains `/<addr>/`;
2. `COUNT(DISTINCT ?g)` over the prefix;
3. every triple under the prefix.

Attempts are merged: the union of `_meta` rows, the largest graph count, and the
fullest copy of each graph. The merged read is consistent when:

- the graph count is at least the confirmed anchors under the prefix, and at most
  that plus the unconfirmed ones (an unconfirmed graph is accounted for, and its
  content is never accepted);
- every confirmed anchor's graph returned exactly `publicTripleCount` rows;
- no returned graph lacks a `_meta` record;
- every UAL this machine has seen before for the prefix is still present.

A consistent non-empty read stops early. An empty read is believed only when
every attempt agrees. A row limit exceeded (`LIMIT max+1`) fails at once, with no
retry. After the last attempt, the gate refuses with `read-inconsistent` and the
verifier returns `INCONCLUSIVE`.

With `checkFreshness` (the CLI's default), each context graph is first compared
with the chain through `POST /api/context-graph/reconcile`: a node holding fewer
assets than `headOrdinal` is a stale view and the read is inconsistent, however
consistent its answers. If the node cannot report (no admin token, older node),
that is a warning.

Outside the publisher's prefix, `readKnowledge` only discovers things; it never
reads other graphs in full:

| Found | Where | Effect |
|---|---|---|
| State about a candidate grant | another address's VM graph | forgery `state-not-by-grantor` (`misplaced-state` in a derivations graph) |
| Grant for the subject | another address's VM graph | forgery `grant-not-by-subject` (`misplaced-grant` in a derivations graph) |
| State about a candidate grant | the grantor's own VM graph, absent from the grantor read | read inconsistent |
| Non-`active` state | `_shared_memory/…` | warning only |
| Non-`active` state | merged view (`<cg>/context/<id>`) with no VM copy anywhere | revocation, tier `context` |
| Derivation for a file | an untrusted address's VM graph | shown in `untrusted`, never believed |

Discovered forgeries carry their UAL, and the transaction hash where their `_meta`
anchor can be read.

## Wire terms

`/api/query` cells: IRIs are bare strings; literals are `"lexical"`,
`"lexical"^^<datatype>` or `"lexical"@lang` with N-Triples escaping. Cells may
also be SPARQL-JSON `{value, type, datatype}`. `src/rdf-term.mjs` owns parsing and
the strict coercions shared by writer and reader:

| Function | Accepts |
|---|---|
| `asDecimal` | `^(0|[1-9]\d*)(\.\d+)?$` — else `NaN` |
| `asDateTime` | ISO-8601 with `Z` or `±hh:mm` — else `NaN` |
| `agentAddress(did)` | `did:dkg:agent:0x<40hex>` → lowercase address, else `null` |
| `subjectAddress(subject)` | self-certifying subject → lowercase address, else `null` |

## Identifiers

| Object | IRI |
|---|---|
| grant | `urn:mandate:grant:<addr>:<local>:<nonce16>` |
| state | `urn:mandate:state:<nonce16>` |
| derivation | `urn:mandate:derivation:<sha16>:<nonce16>` |

`nonce16` is 16 lowercase hex characters from `crypto.randomBytes(8)`.

## Knowledge (reader output)

`readKnowledge(node, cfg, scope)`:

- `cfg = { grantsCg, derivationsCgs, trustedProducers?, stateStore?, attempts?, backoffMs?, max?, sleep? }`
- `trustedProducers` defaults to the derivations graphs' own addresses.
- `scope` is exactly one of `{ subject }` (render), `{ grantId }` (blast radius) or `{ sha256 }` (verify).

```js
{
  scope,
  anchors: [{ ual, graph, publisher, number, contextGraphId, publicTripleCount,
              txHash, materializedVersion, confirmationKind }],
  grants: [{ id, ual, txHash, graph, publisher, subject, subjectAddress, grantor,
             grantorAddress, permitsCapability, permitsUseClass, forbidsUseClass,
             territory, validFrom, validUntil, maxSpendUsd, consentClipSha256,
             tier: 'vm' }],
  states: [{ id, ual, txHash, graph, publisher, stateOf, state: 'active'|'revoked',
             stateAuthor, stateAt, materializedVersion, tier: 'vm'|'context',
             source?: 'local-state' }],
  derivations: [{ id, ual, txHash, graph, publisher, trusted, outputSha256,
                  servedCapability, servedModelId, authorizedUnder, jobId,
                  billedUsd, derivedAt }],
  forgeries: [{ kind, detail, id, graph, ual, txHash, publisher, anchored?,
                claims: { subject?, stateOf?, state?, outputSha256?, authorizedUnder? } }],
  warnings: [string],
  trustedProducers: [address],
  freshness: [{ contextGraphId, headOrdinal, watermark, status }] | null,
  consistency: { ok, reason, attempts },
  reads: [{ contextGraphId, publisher, role, anchors, consistency }],
}
```

Dates are normalised to UTC ISO strings. A state value other than exactly
`active` is `revoked`.

## Decision

```js
decide(request, knowledge) → {
  permit, clause, reason,
  grantId, grantUal, grantTx, publisher, tier,
  forgeries, warnings,
  spend: { priorUsd, estimateUsd, ceilingUsd, unknown },
}
```

`request = { subject, capability, useClass, territory, at, estimatedUsd }`. Every
field is required. `estimatedUsd` may be `null`, meaning the price is unknown.

Clause order: `malformed-request`, `use-class-prohibited`, `read-inconsistent`,
`grant-exists`, `capability-permitted`, `use-class-permitted`,
`territory-permitted`, `validity-window`, `not-revoked`, `spend-ceiling`.

- Grants are checked independently, in id order. A refusal names the furthest
  clause any grant reached.
- Prior spend is summed per grant from trusted derivations, in integer
  micro-dollars.
- Under a ceiling, an unknown estimate or an unknown prior spend refuses.

## Verdict

```js
verifyKnowledge(knowledge, sha256, { now }) → {
  verdict: 'CLEAR' | 'TAINTED' | 'UNKNOWN' | 'INCONCLUSIVE',
  subStatus: 'REVOKED' | 'UNAUTHORISED' | 'MALFORMED' | 'NOT_YET_VALID' | 'EXPIRED' | null,
  sha256, reason, grantId?, grantUal?, grantor?,
  judgements: [{ derivation, derivationUal, publisher, grant, grantUal, grantor, verdict, subStatus, reason }],
  untrusted: [{ derivation, derivationUal, publisher, grant }],
  forgeries, warnings,
}
```

Only trusted producers' edges are judged. A file is CLEAR only when every trusted
edge is clear; otherwise the headline is the most serious sub-status, in the order
listed above. `derivedAt` is the producer's own claim, so it is believed only when
it incriminates: a render before `validFrom` or after `validUntil`.

`blastRadius(grantId, derivations) → { grantId, assets, totalBilledUsd, billedUnknown }`
lists trusted edges only.

## CLI exit codes

| Code | Meaning |
|---|---|
| 0 | success, permitted, CLEAR |
| 1 | usage error |
| 2 | refused by the gate; TAINTED or UNKNOWN |
| 3 | consent not confirmed (ASR failed, terms missing); `--force` overrides missing terms only |
| 4 | render succeeded but its derivation failed to commit |
| 5 | render failed (tool error, no media, timeout) |
| 6 | DKG write failed before anchoring |
| 7 | DKG anchor not confirmed (unbound 207, timeout after send) |
| 8 | consent contradicted (negation); never overridable |
| 9 | node unreachable or read inconsistent (INCONCLUSIVE) |
| 10 | Livepeer payment or credential problem |

## Local state

`~/.mandate` (mode 0700; `MANDATE_HOME` overrides):

- `pending/` holds render records written before dispatch.
- `state/<context-graph>.json` (mode 0600, written atomically) is
  `{ version: 1, knownUals: { <addr>: [ual] }, revocations: { <grantId>: { id, ual, txHash, publisher, stateOf, stateAt } } }`.
  It is updated only after a consistent read, and entries are never removed.
