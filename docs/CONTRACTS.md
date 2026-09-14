# Internal contracts

The shapes every module agrees on. Change them here first.

## Trust model

- **Publisher, not literals.** An object is attributed to the address in its
  Verifiable Memory graph, `did:dkg:context-graph:<cg>/_verifiable_memory/<addr>/<n>`.
  That address is chain-bound: the KA id is `(author << 96) | n`, and sync rechecks
  the on-chain Merkle root. The self-declared `mandate:grantor` and
  `mandate:stateAuthor` literals never decide authorship.
- **An anchor** is the `<cg>/_meta` row set whose subject is a KA UAL
  (`dkg:kaUal` self-link) with `dkg:status "confirmed"`, `dkg:assertionGraph` equal
  to the graph derived from the UAL, and `dkg:publicTripleCount`. `prov:wasAttributedTo`
  exists only on the publishing node; when present it must equal the path address.
  `dkg:transactionHash` is absent on the finalized-materialization lane and is not
  required.
- **Self-certifying subjects.** `0x<40 lowercase hex>:<local>`, local matching
  `^[a-z0-9][a-z0-9-]{0,62}$`. A grant is accepted only when its publisher, the
  subject's address, the address in its id and the address in `mandate:grantor` are
  all the same (compared case-insensitively). A grant id published more than once is
  refused by the gate and verifies `TAINTED / MALFORMED`.
- **States.** A `GrantState` whose `mandate:stateOf` reads as exactly one current-format
  grant IRI owned by the anchoring publisher always counts:
  `{ state, tier: 'vm', publisher, stateOf, ual, malformed?, problems }`, with `state`
  `'active'` only when the value is exactly the plain string `active` and nothing else
  is wrong, and `'revoked'` otherwise (a missing, duplicated or unreadable `stateAt`,
  `state` or `stateAuthor`, or a `stateAuthor` naming another address). A state about a
  grant owned by another address is a forgery. A `GrantState` in the grantor's own
  prefix whose `stateOf` cannot be read makes the read inconsistent.
- **Revocation is terminal per grant IRI.** `active` has no effect.
- **Tiers.** `vm` may permit or clear. `swm` revocations warn. A revocation seen
  only in the merged `<cg>/context/<id>` graph with no twin in any
  `_verifiable_memory` graph is honoured (tier `context`).
- **Deny list.** `PROHIBITED_USE_CLASSES` (`src/policy.mjs`): `adult`, `sexual`,
  `deceptive-impersonation` and synonyms. A request's use-class label is normalised
  (lowercase; spaces, underscores and dots become hyphens) and refused when the whole
  label, the label without hyphens, or any hyphenated word is on the list. It is a
  check on the declared label only.

## Read consistency

DKG v10.0.16 `/api/query` intermittently omits whole named graphs (docs/SPIKES.md).
A graph comes back whole or not at all; nothing is invented. Reads that decide are
therefore scoped to one publisher's Verifiable Memory prefix,
`did:dkg:context-graph:<cg>/_verifiable_memory/<addr>/`, and each attempt runs:

1. `_meta` rows whose UAL path contains `/<addr>/`;
2. `COUNT(DISTINCT ?g)` over the prefix;
3. every triple under the prefix.

Queries 1 and 3 are ordered and paged: `max` rows per page (default 5000), and at
most `maxRows` rows for the whole prefix (default 250000). Past `maxRows` the read
fails at once, with no retry.

Attempts are merged: the union of `_meta` rows and content rows across pages and
attempts, and the largest graph count. The merged read is consistent when:

- the graph count is at least the confirmed anchors under the prefix, and at most
  that plus the unconfirmed ones;
- every confirmed anchor's graph returned exactly `publicTripleCount` rows;
- no returned graph lacks a `_meta` record;
- no anchor is left pending or unconfirmed (these prefixes are the grantor's and
  trusted producers', so a `_meta` record missing one row is not set aside;
  deliberate trade-off: a publish left tentative blocks that publisher until it
  confirms);
- no row or cell is unreadable (a cell that does not parse is kept as invalid, so it
  is never read as missing);
- with a `stateStore`, every UAL this machine has seen before for the prefix is still
  present. Without one, there is nothing to compare against.

Attempts continue while any of these fail. A consistent non-empty read stops early.
An empty read is believed only when every attempt answered. After the last attempt,
the gate refuses with `read-inconsistent` and the verifier returns `INCONCLUSIVE`.

With `checkFreshness` (the CLI's default), each context graph is first compared
with the chain through `POST /api/context-graph/reconcile`, which needs a
node-admin token:

- a node holding fewer assets than `headOrdinal` is a stale view, and the read is
  inconsistent however consistent its answers;
- a watermark ahead of the head (or status `watermark-ahead`), a head or watermark
  that is not a non-negative integer, a node with no reconcile call, and any HTTP
  error (including 0, 404, 409, 429 and 5xx) are inconsistent too;
- only a 403 is a warning: the check could not run, and a stale node can still permit.

A context graph that reads empty everywhere is checked against the node's
subscriptions: an id the node does not hold, or holds in another case, is
inconsistent. If subscriptions cannot be listed, that is a warning.

Outside the publisher's prefix, `readKnowledge` only discovers things; it never
reads other graphs in full. Discovery queries use `SELECT DISTINCT`, send grant ids
in batches of 50, and must answer on some attempt. A discovery query that does not
answer, or returns more than `max` rows, makes the read inconsistent: someone who can
write to an open graph can deny service this way, but never obtain a permit.

| Found | Where | Effect |
|---|---|---|
| State about a candidate grant | another address's VM graph | forgery `state-not-by-grantor` (`misplaced-state` in a derivations graph) |
| Grant for the subject | another address's VM graph | forgery `grant-not-by-subject` (`misplaced-grant` in a derivations graph) |
| State about a candidate grant | the grantor's own VM graph, absent from the grantor read | read inconsistent |
| States about candidate grants published by the grantor, on a node that holds a merged view of that graph | the merged view (`<cg>/context/`) left out of every answer | read inconsistent |
| The one-row probe for whether the node holds any merged view of that graph | never answered | read inconsistent |
| Non-`active` state | `_shared_memory/…` | warning only |
| Non-`active` state | merged view (`<cg>/context/<id>`) with no VM copy anywhere | revocation, tier `context` |
| Derivation for a file | an untrusted address's VM graph | shown in `untrusted`, never believed |

Discovered forgeries carry their UAL, and the transaction hash where their `_meta`
anchor can be read.

Live v10.0.16 nodes build a merged view only for data they published themselves, so
a grantor's states show there on the grantor's node and nowhere else. A node that
holds no merged view of a graph can hold no merged-view-only revocation, and is not
expected to show one. A node that leaves that one-row probe out of every attempt as
well is not caught by this check; that is a deliberate trade-off.

## Wire terms

`/api/query` cells: IRIs are bare strings; literals are `"lexical"`,
`"lexical"^^<datatype>` or `"lexical"@lang` with N-Triples escaping. Cells may
also be SPARQL-JSON `{value, type, datatype}`. `src/rdf-term.mjs` owns parsing and
the strict coercions shared by writer and reader:

| Function | Accepts |
|---|---|
| `asDecimal` | `^(0|[1-9]\d*)(\.\d+)?$` — else `NaN` |
| `asDateTime` | ISO-8601 with `Z` or `±hh:mm`, and a real calendar date and time (no 2026-02-31, hour 24, second 60, or offset over 14 h) — else `NaN` |
| `agentAddress(did)` | `did:dkg:agent:0x<40hex>` → lowercase address, else `null` |
| `subjectAddress(subject)` | self-certifying subject → lowercase address, else `null` |

Writers refuse a date `asDateTime` would not read. Decimals are written in plain
notation with at most six decimals; extra precision is rounded **up** to the next
micro-dollar, so a positive amount is never written as `0`.

## Identifiers

| Object | IRI |
|---|---|
| grant | `urn:mandate:grant:<addr>:<local>:<nonce16>` |
| state | `urn:mandate:state:<nonce16>` |
| derivation | `urn:mandate:derivation:<sha16>:<nonce16>`, where `sha16` is the first 16 hex of `outputSha256` |

`nonce16` is 16 lowercase hex characters from `crypto.randomBytes(8)`. A derivation's
asset name is `derivation-<sha16>-<nonce16>`.

## Knowledge (reader output)

`readKnowledge(node, cfg, scope)`:

- `cfg = { grantsCg?, grantsCgs?, derivationsCgs, trustedProducers?, stateStore?, checkFreshness?, attempts?, backoffMs?, max?, maxRows?, sleep? }`
- `grantsCg` (one id) and `grantsCgs` (a list) are merged; at least one is required.
  Graph lists and producers are deduplicated.
- `trustedProducers` defaults to the derivations graphs' own addresses.
- `scope` is exactly one of `{ subject }` (render), `{ grantId }` (blast radius) or `{ sha256 }` (verify).

```js
{
  scope,
  grantsCgs: [contextGraphId],
  anchors: [{ ual, graph, publisher, number, contextGraphId, publicTripleCount,
              txHash, materializedVersion, confirmationKind }],
  grants: [{ id, ual, txHash, graph, publisher, subject, subjectAddress, grantor,
             grantorAddress, permitsCapability, permitsUseClass, forbidsUseClass,
             territory, validFrom, validUntil, maxSpendUsd, consentClipSha256,
             tier: 'vm' }],
  states: [{ id, ual, txHash, graph, publisher, stateOf, state: 'active'|'revoked',
             stateAuthor, stateAt, materializedVersion, tier: 'vm'|'context',
             malformed?: true, problems?: [string], source?: 'local-state' }],
  derivations: [{ id, ual, txHash, graph, publisher, trusted, outputSha256,
                  servedCapability, servedModelId, authorizedUnder, jobId,
                  billedUsd, derivedAt }],
  forgeries: [{ kind, detail, id, graph, ual, txHash, publisher, trusted, anchored?,
                claims: { subject, stateOf, outputSha256, authorizedUnder, billedUsd } }],
  unresolvedGrants: [grantId],
  warnings: [string],
  trustedProducers: [address],
  freshness: [{ contextGraphId, headOrdinal, watermark, status }] | null,
  consistency: { ok, reason, reasons: [string], attempts },
  reads: [{ contextGraphId, publisher, role, anchors, consistency }],
}
```

- Dates are normalised to UTC ISO strings. `derivedAt` is required on a derivation.
- Each `claims` field is a list of what the object claimed.
- `forgery.trusted` is true when the object sits in a derivations graph under a trusted
  producer's prefix, or in a grants graph under the address that owns the grant or
  subject it claims. A trusted producer's derivation that is rejected for any reason is
  a trusted forgery, never only a warning.
- Forgery kinds: `grant-not-by-subject`, `grantor-literal-mismatch`, `grant-id-mismatch`,
  `grant-subject-invalid`, `state-not-by-grantor`, `misplaced-grant`, `misplaced-state`,
  `misplaced-derivation`, `derivation-id-mismatch`, `legacy-format` (a trusted producer's
  record in the 0.1.0 id format), `unanchored`, `malformed`.
- `unresolvedGrants` lists grant ids cited by trusted derivations whose owner address
  (compared case-insensitively) has no configured grants graph namespaced under it. A
  grant missing from a configured grants graph that was read consistently is not
  unresolved.

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

- Grants are checked independently, in id order then UAL order. A refusal names the
  furthest clause any grant reached.
- A grant id held by more than one authentic grant is refused at `grant-exists`.
- Clause lists must be arrays (`null` is empty); anything else refuses at that clause.
- `priorSpendFor(grantId, derivations, forgeries = []) → { usd, unknown, derivations }`:
  summed from trusted derivations **in the derivations graphs this read covers**, so
  the ceiling counts only producers and graphs the gate is configured with. `unknown`
  when any carries no billed amount, or when a trusted forgery claims the grant in
  `claims.authorizedUnder`.
- Money is compared in whole micro-dollars (BigInt): prior spend and the estimate are
  summed rounded up (any positive amount is at least 1), the ceiling rounded down, and
  compared once.
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

- Only trusted producers' edges are judged, plus a `TAINTED / MALFORMED` judgement for
  each trusted forgery whose `claims.outputSha256` includes the file's hash, whatever
  its kind.
- An edge citing a grant in `knowledge.unresolvedGrants` is judged `UNKNOWN`: the grant
  is recorded in a graph this verifier does not read.
- The file is `TAINTED` if any judgement is (the headline is the most serious
  sub-status, in the order listed above), otherwise `UNKNOWN` if any is, otherwise
  `CLEAR`. With no judgement at all it is `UNKNOWN`.
- `INCONCLUSIVE` when `consistency.ok` is not true, or `grants`, `states` or
  `derivations` is not a list.
- A grant with an unreadable validity bound, or a trusted edge with no readable
  `derivedAt`, is `MALFORMED`.
- `derivedAt` is the producer's own claim, so it is believed only when it
  incriminates: a render before `validFrom` is `NOT_YET_VALID`, after `validUntil`
  `UNAUTHORISED`.
- `EXPIRED`: the recorded render time is inside the window, but `now` is past
  `validUntil`. The grant lapsed; consent was not withdrawn.
- `CLEAR` establishes the grant's publisher, that it is not revoked, the serving
  capability, and the window (now and `derivedAt`). It does **not** check use class,
  territory, prohibited uses or the spend ceiling, which derivations do not record.
- `forgeries` includes those about these bytes and state forgeries whose
  `claims.stateOf` names a cited grant; a malformed state about a cited grant adds a
  warning.

`blastRadius(grantId, derivations, forgeries = []) → { grantId, assets, totalBilledUsd, billedUnknown, unreadable }`
lists trusted edges only, by exact bytes. `unreadable` counts trusted forgeries
claiming the grant; when it is non-zero, `billedUnknown` is true.

## Spoken scope

`checkSpokenScope(transcript, requested) → { checks, missing, contradicted, covered, total, empty, affirmative, unchecked, note }`

- `checks[0]` is consent: matched only by an affirmative first-person clause (I or we,
  optionally an adverb, then consent, agree, authorise/authorize, allow, give
  [my/our] permission, am/are happy for). A question, a conditional or reported speech
  is not affirmative; a refusal is contradicted. `affirmative` is that match.
- Every check has `{ kind, term, matched, contradicted, heard, notes }`. A negation
  anywhere in a clause contradicts every term in that clause; a refusal or retraction
  anywhere contradicts consent. Deliberate trade-off: some harmless phrasings are
  refused.
- `unchecked` always lists `validity` and `ceiling`, plus `territory-unrestricted`,
  `use-class-unrestricted` or `capability-unrestricted` when that list is empty. The
  CLI makes the operator confirm each by typing it.

## Rendering

`src/execute.mjs`:

- `RenderError { kind: 'tool'|'payment'|'timeout'|'no-media'|'unknown-status', jobId, structured, mayHaveStarted }`.
  `mayHaveStarted` means the render may be running or billed; the caller keeps it
  recoverable. An inline call that times out on the client with no job id throws
  `kind 'timeout'`, `jobId null`, `mayHaveStarted true`.
- `dispatchRender(client, { capability, inputs, prompt, sourceUrl, idempotencyKey, mode, onJob, poll }) → { url, jobId, replay, mode, servedCapability, costUsdEstimated }`.
  Polls whenever there is a job id and no structured media URL.
- `pollJob(client, jobId, { inputUrls, pollIntervalMs, maxWaitMs, sleep, now, onStatus }) → { url, structured, text, status, capability }`.
  An unrecognised status throws `unknown-status`; a failed poll is retried until
  `maxWaitMs`.
- `extractMediaUrl(structured, text, inputUrls)` never returns one of the inputs
  (compared by origin and path); `collectInputUrls(value)` walks nested objects and
  arrays; `served(structured, requested)` is the capability the platform says served.
- `classifyFailure(structured, text)` prefers a structured error code over text.

## DKG writes

`DkgNode.sealShareAnchor({ name, contextGraphId, quads, expectAuthor, resume = false }) → { name, ual, txHash, merkleRoot, … }`

- `DkgWriteError { name (the asset name, when known), assetName, stage, status, body, ual, txHash, mayHaveSent }`.
  Stages: `create`, `author`, `share`, `publish`, `publish-transport`, `unbound`,
  `resume-refused`.
- Without `resume`, an existing asset of that name is refused at `create`. With it:
  `wm-sealed` goes on to share and publish; `swm-shared` goes on to publish;
  `vm-confirmed` with a verified anchor returns `{ name, ual, txHash: null, resumed: true }`;
  anything unbound, tentative or unverifiable throws `resume-refused` and never
  publishes again. Resume finishes the content already sealed under that name, not the
  quads passed in.
- A lost publish response (status 0, 503, 504, a body cut off or over the limit) is
  success only when the descriptor is `vm-confirmed` with a chain-confirmed (not
  tentative) UAL under the sealing author, its `vmCurrentAssertion` equals the sealed
  merkle root where exposed, and `<cg>/_meta` shows exactly one confirmed anchor for the
  UAL's graph. The publishing node's token must be able to read that `_meta`. Otherwise
  `publish-transport` with `mayHaveSent: true`.
- Response bodies are capped at `maxResponseBytes` (default 32 MiB); a larger body
  throws `ResponseTooLargeError`, a `ReadTruncatedError`.
- A missing or unreadable `auth.token` throws `NodeTokenError` when the token is first needed.

`recordDerivation(node, contextGraphId, { outputUrl | outputSha256, servedCapability, servedModelId?, authorizedUnder, billedUsd?, jobId?, derivedAt?, expectAuthor?, id?, name?, resume?, fetchOptions? }) → { id, name, outputSha256, ual, txHash, … }`

- `id` and `name` from an earlier attempt must carry the output's hash prefix and one
  shared nonce; `billedUsd` must be null or a finite non-negative amount; both are
  checked before anything is fetched. On failure the error also carries
  `derivationId`.
- `reconcile({ billedJobs, derivations })` counts only derivations with `trusted === true`.

## CLI exit codes

| Code | Meaning |
|---|---|
| 0 | success, permitted, CLEAR; `help`, `-h`, `--help` and `--version` |
| 1 | usage or configuration error (`UsageError`, `TermError`, `ConfigError`) |
| 2 | refused by the gate; TAINTED or UNKNOWN |
| 3 | consent not confirmed: transcription failed, no affirmative first-person consent, terms missing, the typed consent confirmation wrong, or not possible off a terminal |
| 4 | render succeeded but its derivation failed to commit; the result carries `stage`, `asset`, `derivationId`, `ual`, `txHash`, `mayHaveSent` |
| 5 | render failed (tool error, no media), or a rerun found the render `submitted` with a job id or `rendered` |
| 6 | DKG write failed before anchoring |
| 7 | DKG anchor not confirmed (`unbound`, `publish`, `publish-transport`, `resume-refused`) |
| 8 | consent contradicted; never overridable |
| 9 | INCONCLUSIVE: node unreachable, stale or read inconsistent; `DkgHttpError`, `ReadTruncatedError`, `FetchBytesError`; an unreadable `auth.token` (`NodeTokenError`) or local state file (`StateReadError`); a Livepeer failure that is not about credentials; `RenderError` `unknown-status`; `record` on a render whose outcome is unknown |
| 10 | Livepeer payment or credential problem |

- `--force` (grant) overrides only requested capabilities, use classes and territories
  that were not said. It never overrides a failed transcription, a missing affirmative
  consent or a contradiction, and a forced grant is published **without**
  `consentClipSha256`; the result carries `consent.sha256`, `consent.forced` and
  `consent.publishedClipHash`.
- `--yes` skips only the typed "publish" confirmation. It never skips confirming a
  consent clip: the operator types `matches`, then each `unchecked` item (the end date
  as `YYYY-MM-DD`, the ceiling or `none`, `anywhere`).
- `render --at` decides as of another time and is refused with `--execute`.

## Local state

`~/.mandate` (`MANDATE_HOME` overrides). The `pending/` and `state/` directories are
mode 0700 and their files 0600, written atomically; `~/.mandate` itself is not changed.

- `pending/<key>.json` holds a render record written before dispatch. Status moves
  `dispatching` → `submitted` (with a job id, or `mayHaveStarted`) → `rendered` →
  `recorded`, or `failed`. `pending.create` refuses to overwrite `submitted`,
  `rendered` or `recorded` (`PendingConflictError`). `derivationAttempt` keeps the
  derivation's `id`, `name`, `ual`, `txHash`, `stage` and `mayHaveSent`; name and id
  never change once set, and `mayHaveSent` stays true.
- `state/<context-graph>.json` is
  `{ version: 1, knownUals: { <addr>: [ual] }, revocations: { <grantId>: { id, ual, txHash, publisher, stateOf, stateAt } } }`.
  It is updated only after a consistent read, and entries are never removed.
