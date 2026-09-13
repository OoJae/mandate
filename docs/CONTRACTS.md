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

DKG v10.0.16 `/api/query` intermittently omits whole named graphs. Each read
attempt checks:

1. The `_meta` anchor set is non-empty when local state says anchors exist, and
   contains every anchor previously seen for that context graph (anchors are
   append-only).
2. `COUNT(DISTINCT ?g)` over the `_verifiable_memory/` prefix equals the number
   of anchors for that prefix.
3. Every content graph returned has exactly `publicTripleCount` rows.

On failure: retry with backoff; after the last attempt the gate refuses with
`read-inconsistent` and verify returns `INCONCLUSIVE`. Accepted revocations are
persisted and never forgotten.

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

```js
{
  anchors: [{ ual, graph, publisher, number, status, confirmationKind, txHash,
              materializedVersion, publicTripleCount, contextGraphId }],
  grants: [{ id, ual, publisher, subject, grantor, grantorAddress,
             permitsCapability, permitsUseClass, forbidsUseClass, territory,
             validFrom, validUntil, maxSpendUsd, consentClipSha256, tier }],
  states: [{ id, ual, publisher, stateOf, state, stateAt, tier }],
  derivations: [{ id, ual, publisher, outputSha256, servedCapability,
                  servedModelId, authorizedUnder, billedUsd, jobId, derivedAt,
                  trusted }],
  forgeries: [{ kind, graph, ual, publisher, subject, detail }],
  warnings: [string],
  consistency: { ok, attempts, reason },
}
```

## Decision

```js
decide(request, knowledge) → {
  permit, clause, reason,
  grantId, grantUal, grantTx, publisher, tier,
  forgeries, warnings,
  spend: { priorUsd, estimateUsd, ceilingUsd, unknown },
}
```

`request = { subject, capability, useClass, territory, at, estimatedUsd }`.

Clause order: `malformed-request`, `use-class-prohibited`, `read-inconsistent`,
`grant-exists`, `capability-permitted`, `use-class-permitted`,
`territory-permitted`, `validity-window`, `not-revoked`, `spend-ceiling`.

## Verdict

```js
verifyKnowledge(knowledge, sha256, { now }) → {
  verdict: 'CLEAR' | 'TAINTED' | 'UNKNOWN' | 'INCONCLUSIVE',
  subStatus: 'REVOKED' | 'EXPIRED' | 'NOT_YET_VALID' | 'UNAUTHORISED' | 'MALFORMED' | null,
  sha256, reason, judgements, untrusted,
}
```

Only edges from trusted producers (`MANDATE_TRUSTED_PRODUCERS`, default the
derivations context-graph address prefixes) decide the verdict.

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

`~/.mandate` (mode 0700): `pending/` holds render records written before dispatch;
`state/<context-graph>.json` holds known anchors and accepted revocations.
