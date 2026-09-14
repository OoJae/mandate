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
- **A grantor's statement about its own grant is a state, whatever else it is.** In a
  grants graph, an object typed `GrantState` (with any other types), or any object whose
  one `stateOf` names a current grant owned by the anchoring publisher, is read as a state
  before it is considered as a grant. Other types on it (also `LikenessGrant`,
  `Derivation` or `Refusal`, no `GrantState` type, an unknown Mandate type) are problems,
  so the state is malformed and counts as a revocation.
- **Revocation is terminal per grant IRI.** `active` has no effect.
- **Tiers.** `vm` may permit or clear. `swm` revocations warn. A revocation seen
  only in the merged `<cg>/context/<id>` graph with no twin in any
  `_verifiable_memory` graph is honoured (tier `context`). For hand-built knowledge, the
  gate and verifier count a state from the grant's publisher with no tier or an
  unrecognised one, or a `vm` state with `malformed: true`, as a revocation whatever its
  `state` says.
- **Deny list.** `PROHIBITED_USE_CLASSES` (`src/policy.mjs`): `adult`, `sexual`,
  `deceptive-impersonation` and synonyms. A request's use-class label is normalised
  (lowercase; spaces, underscores and dots become hyphens) and split into letter-only
  words at hyphens and digits. It is refused when any word, or any run of adjacent words
  joined together, is on the list, either as written or with one common inflection
  removed (`s`, `es`, `ing`, `ed`, `ised`, `ized`, `ly`, `ness`, `y` and similar, with and
  without a restored final `e`). Deliberate trade-off: innocent labels such as
  `adult-education` are refused. It is a check on the declared label only.

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

A context graph that reads empty everywhere, and that the freshness check did not
already find current under that exact id, is checked against the node's subscriptions:
an id the node does not hold, or holds in another case, is inconsistent. If the
subscriptions cannot be listed (a transport error, 404, 5xx, or an answer of an
unexpected shape), the empty read is inconsistent too. Deliberate trade-off (fail-open):
a 403, or a node with no subscriptions call, is only a warning, because a token without
node-admin rights gets 403 here and from reconcile, and refusing would block every
decision against a graph that is legitimately empty. On such a node a mis-typed or
unsubscribed graph id still reads as empty. `checkFreshness` is off unless the caller
sets it (the CLI does).

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
| States about candidate grants published by the grantor, on a node shown (by the probe or a view row, on any attempt) to hold a merged view of that graph | the merged view (`<cg>/context/`) left out of every answer | read inconsistent |
| The one-row probe for whether the node holds any merged view of that graph, while no attempt has shown one | not answered on every attempt | read inconsistent |
| A state with any row whose value is not exactly `active` | `_shared_memory/…` | warning only |
| A state with any row whose value is not exactly `active` | merged view (`<cg>/context/<id>`) with no VM copy anywhere | revocation, tier `context` |
| Derivation for a file | an untrusted address's VM graph | shown in `untrusted`, never believed |

Discovered forgeries carry their UAL, and the transaction hash where their `_meta`
anchor can be read.

Live v10.0.16 nodes build a merged view only for data they published themselves, so
a grantor's states show there on the grantor's node and nowhere else. A node that
holds no merged view of a graph can hold no merged-view-only revocation, and is not
expected to show one.

An empty probe looks exactly like a probe whose view graph was left out, so one empty
answer settles nothing: "this node holds no merged view" is believed only when the probe
answered, empty, on every attempt, and discovery keeps retrying until then. The check
runs only for grants graphs whose grantor read holds a Verifiable Memory state about the
grants in question; without one, no view is expected. Deliberate trade-offs:

- a node that never materialises views (a producer or verifier node) spends every
  attempt here (about 1.75 s of backoff with the defaults) whenever the check runs;
- a node that leaves the view out of the probe and out of the state query on every single
  attempt is not caught, because nothing else distinguishes it from a node that holds no
  view. Remembering per node that a view was once seen would close that for later reads;
  it is not done.

## Wire terms

`/api/query` cells: IRIs are bare strings; literals are `"lexical"`,
`"lexical"^^<datatype>` or `"lexical"@lang` with N-Triples escaping. Cells may
also be SPARQL-JSON `{value, type, datatype}`. `src/rdf-term.mjs` owns parsing and
the strict coercions shared by writer and reader:

| Function | Accepts |
|---|---|
| `asDecimal` | `^(0|[1-9]\d*)(\.\d+)?$` — else `NaN` |
| `asDateTime` | ISO-8601 with `Z` or `±hh:mm`, a real calendar date and time (no 2026-02-31, hour 24, second 60, or offset above 14:00), and an instant from 0000-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z in UTC — else `NaN` |
| `agentAddress(did)` | `did:dkg:agent:0x<40hex>` → lowercase address, else `null` |
| `subjectAddress(subject)` | self-certifying subject → lowercase address, else `null` |

Writers refuse a date `asDateTime` would not read (the writer round-trips its own output
through it). Decimals are written in plain notation with at most six decimals; extra
precision is rounded **up** to the next micro-dollar, so a positive amount is never
written as `0` (anything above 0 and below 0.000001 is written `0.000001`). A number too
large to write as a plain decimal (`1e21`) is refused.

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
- Each `claims` field is the list of every distinct value the object claimed, uncapped
  (bounded only by the prefix read's row limits), so a grant named fifth is still named.
- `forgery.trusted` is true when the object sits in a derivations graph under a trusted
  producer's prefix, or in a grants graph under the address that owns the grant or
  subject it claims. A trusted producer's derivation that is rejected for any reason is
  a trusted forgery, never only a warning. So is any object under a trusted producer's
  prefix in a derivations graph that carries Mandate predicates but is not typed
  `Derivation` (no `rdf:type`, another namespace's type, a later version's type): kind
  `malformed`, with its claims. The one exception is a plain `Refusal` that claims no
  hash, grant or bill.
- Forgery kinds: `grant-not-by-subject`, `grantor-literal-mismatch`, `grant-id-mismatch`,
  `grant-subject-invalid`, `state-not-by-grantor`, `misplaced-grant`, `misplaced-state`,
  `misplaced-derivation`, `derivation-id-mismatch`, `legacy-format` (a trusted producer's
  record in the 0.1.0 id format), `unanchored`, `malformed`.
- `unresolvedGrants` lists grant ids cited by trusted derivations whose owner address
  (compared case-insensitively) has no configured grants graph namespaced under it, and
  that no read found. A grant found in any read (even a graph namespaced under another
  address) is not unresolved; a forgery does not count as found. A grant missing from a
  configured grants graph that was read consistently is not unresolved either.
  Named limit of that rule: a grant read only from a graph namespaced under another
  address is judged on the states read there. A revocation its owner published into
  their own grants graph, which this reader does not configure, is not seen, and the
  grant is not listed as unresolved. `mandate revoke` publishes into the grantor's own
  grants graph, so configure the owner's graph wherever its grants are relied on.

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
- `grants`, `states`, `derivations` and `forgeries` must all be arrays; otherwise the
  request refuses at `read-inconsistent`.
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
- Edges are matched to the file's hash case-insensitively on both sides.
- Authentic copies of the cited grant are looked up first. When one was read, it is
  judged in full (duplicate, revocation, capability, window), and any finding is
  `TAINTED`, even if the grant is also listed in `knowledge.unresolvedGrants`; the
  unresolved listing only turns a would-be `CLEAR` into `UNKNOWN`. When no authentic copy
  was read, an edge citing an unresolved grant is `UNKNOWN` (the grant is recorded in a
  graph this verifier does not read), and any other is `TAINTED / UNAUTHORISED`.
- The file is `TAINTED` if any judgement is (the headline is the most serious
  sub-status, in the order listed above), otherwise `UNKNOWN` if any is, otherwise
  `CLEAR`. With no judgement at all it is `UNKNOWN`.
- `INCONCLUSIVE` when `consistency.ok` is not true, or `grants`, `states`,
  `derivations` or `forgeries` is not a list.
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

`src/scope.mjs`, exported from the package root with `consentScript` and `matchScript`. Two layers; only the first can confirm anything.

`checkSpokenScope(transcript, requested) → { checks, missing, contradicted, covered, total, empty, affirmative, unchecked, script, scriptMatch: { matched, missing, extra }, confirmed, note }`

`requested = { capability, useClass, territory, validUntil?, maxSpendUsd? }`.

**Closed world: the consent script.**

- `consentScript(requested)` is the only source of the expected words, built from
  `scriptPieces`: "I consent to <capabilities> of my likeness for <use classes> in
  <territory names> until <day month year>. Spending is capped at <amount> US dollars."
  With no capability it says "generated media"; the use class, territory, date and
  ceiling parts are left out when not requested; a parenthesis in a territory name is not
  spoken.
- `scriptWords(text)` puts script and transcript in one canonical form: lowercase,
  accents stripped, `&` to `and`, punctuation and hyphens split; `lipsync` to `lip sync`,
  `faceswap` to `face swap`, `St` to `saint`; `U.K.`/`UK` to `united kingdom`,
  `U.S.`/`US`/`USA` to `united states`; ordinals and number words to digits (including
  years said in pairs and "two thousand and twenty six"); `$5`, `5 dollars`, `five US
  dollars` and `5 USD` to `5 dollars`; decimals such as `2.50` and "two point five" to one
  form; dates in day-month-year order.
- `matchScript(transcript, requested)` aligns the two word lists (longest common
  subsequence, critical words weighted so they are never traded for others). `matched`
  only when no **critical** word is missing (`I`, `consent`, every capability, use class
  and territory word, `until`, the date, `capped`, the amount; stricter than the minimum,
  deliberately), at most `SCRIPT_MAX_MISSES` (2) other script words are missing, and
  every transcript word outside the alignment is filler: `um umm uh uhh er erm ah hmm mm
  hi hello hey so okay ok yes yeah well a an the`. No negators, conjunctions or
  conditionals are filler. `missing` lists the script words not found, `extra` the
  non-filler words not aligned. A transcript longer than 4 × script words + 64 is not
  aligned and never matches.
- `confirmed` is `scriptMatch.matched` with nothing contradicted. Anything else is
  UNCONFIRMED, however the heuristics read it, and needs a person.
- Named limits: the script's words are compared, not what the person meant by them (a
  territory name read from the script names what the grant names); up to two short
  non-critical words may be dropped.

**Open world: heuristics, for display and as a hard stop.**

- `checks[0]` is consent: matched only by an affirmative first-person clause (I or we,
  optionally an adverb, then consent, agree, authorise/authorize, allow, give
  [my/our] permission, am/are happy for). A question (including an auxiliary or wh-word
  before "I"), a conditional, a hedge or reported speech is not affirmative; "agree" and
  "consent" count only before "to", "for" or the end of the clause. `affirmative` is that
  match.
- Every check has `{ kind, term, matched, contradicted, heard, notes }`. A negation
  anywhere in a clause contradicts every term in that clause; a refusal, retraction or
  sign of coercion anywhere contradicts consent. `contradicted` is a hard stop: the CLI
  exits 8 even when the transcript is otherwise a reading of the script. Deliberate
  trade-off: some harmless phrasings are refused.
- A use or territory term counts as `matched` wherever it is said, not only inside the
  consent clause ("My cousin works in advertising"). That is harmless only because such a
  transcript is never a script match; `matched` never confirms anything.
- `unchecked` always lists `validity` and `ceiling`, plus `territory-unrestricted`,
  `use-class-unrestricted` or `capability-unrestricted` when that list is empty.

## Consent capture

`src/consent.mjs`: `captureConsent({ requested, kind, onLink, onPending, client? }) → { captured, pageUrl, url, mime, bytes, sha256, transcript, asrError, scope, raw }`
(or `{ captured: false, pageUrl, status }` when no clip arrived). `scope` is
`checkSpokenScope(transcript, requested)`, or `null` when there is no transcript.

- `awaitCapture` long-polls `get_upload` until the link expires. A transport error is
  retried. A tool error that says the link expired ends the wait as `expired`; one that
  says unknown, invalid, not found, unauthorized or forbidden, or five identical tool
  errors in a row, ends it as `failed`. An upload status that is neither a known wait nor
  finished ends the wait and is reported as itself. Deliberate trade-off: a new pending
  status ends the wait early, which costs a new link, never a false capture.
- `transcribe` accepts only a structured reply with `ok: true` that names its capability
  (`nemotron-asr`) and its clip (`source_url` or `inputs.audio_url`, the same resource as
  the clip). A failure marker (`ok: false`, `success: false`, `error`, or a status, state,
  job status or phase that is not done) at the top level or inside `result`, `output` or
  `run_output`, a platform status message in a transcript field, or plain text alone, is
  a `ConsentError` at stage `asr`, never speech.
- A transcript link must use https (plain http only to loopback), must not be the clip
  itself (compared after percent-decoding and collapsing slashes, before and after
  redirects), must be declared text or JSON, at most 1 MB, UTF-8 with no NUL byte. A JSON
  body is checked for its own failure fields; a text body that reads like a status is
  refused. A body that fails mid-read is a `ConsentError` at stage `asr`.

## Rendering

`src/execute.mjs`:

- `RenderError { kind: 'tool'|'payment'|'timeout'|'no-media'|'unknown-status', jobId, structured, mayHaveStarted }`.
  `mayHaveStarted` means the render may be running or billed; the caller keeps it
  recoverable. An inline call that times out on the client with no job id throws
  `kind 'timeout'`, `jobId null`, `mayHaveStarted true`.
  A platform error whose text says the render timed out or may still complete is
  `kind 'timeout'` with `mayHaveStarted true`. An error reply carrying a malformed job id
  is classified first and kept recoverable. This wording comes from plausible platform
  texts and has not been checked against a live timeout.
- `dispatchRender(client, { capability, inputs, prompt, sourceUrl, idempotencyKey, mode, onJob, poll }) → { url, jobId, replay, mode, servedCapability, costUsdEstimated, warnings }`.
  Poll options are validated before anything is sent (finite, non-negative, at most
  2147483647 ms). With a job id, the reply is the result only when its status is done and
  its structured URL is usable; otherwise the job is polled. Text is scanned for a URL
  only when there is no job id, and a queued reply whose job id is not in the accepted
  shape stops with `mayHaveStarted true` instead.
- `pollJob(client, jobId, { inputUrls, pollIntervalMs, maxWaitMs, sleep, now, onStatus, capability }) → { url, structured, text, status, capability, servedCapability, costUsdEstimated, warnings }`.
  A reply marked `isError` is never a result, whatever status it carries (the job id is
  kept). A reply, structured or in its status header, about another job is refused.
  Multi-word statuses ("in progress") are read whole. An unrecognised status throws
  `unknown-status`; a failed poll is retried until `maxWaitMs`.
- `servedCapability` is kept only if it matches the capability name pattern the graph
  writer accepts, and `costUsdEstimated` only if it can be written as a plain decimal;
  otherwise `null` with a warning. `served(structured, requested)` returns the platform's
  claim, the requested capability when it names none, and `null` when its claim is
  unusable.
- `extractMediaUrl(structured, text, inputUrls)` never returns one of the inputs,
  compared by lowercased host without a default port and the percent-decoded path with
  repeated slashes collapsed (scheme, query and fragment ignored). A structured URL that
  is present but unusable gives `null`, with no text scan. `collectInputUrls(value)` walks
  nested objects and arrays.
- `classifyFailure(structured, text)` removes URLs before matching. A numeric 402 is
  payment; a numeric 401 is payment unless the text names fetching an input; other
  numeric codes are tool errors. A recognised payment code is payment (except
  `unauthorized` on an input fetch); any other code is payment only for phrases that can
  mean nothing but money.

## DKG writes

`DkgNode.sealShareAnchor({ name, contextGraphId, quads, expectAuthor, resume = false, lastPublishUnknown = false }) → { name, ual, txHash, merkleRoot, … }`

- `DkgWriteError { name (the asset name, when known), assetName, stage, status, body, ual, txHash, mayHaveSent }`.
  Stages: `create`, `author`, `share`, `publish` (refused with a 4xx, before any chain
  call; `mayHaveSent: false`), `publish-transport` (the answer could not be trusted and
  a transaction may have been sent), `unbound` (minted but not bound to the graph;
  `mayHaveSent: true`), `resume-refused` (the node's record rules out continuing; never
  retried) and `resume-unverified` (it could not be judged now; retryable, never
  publishes).
- Without `resume`, an existing asset of that name is refused at `create`. With it:
  `wm-sealed` goes on to share and publish; `swm-shared` goes on to publish, unless
  `lastPublishUnknown` is true, when it throws `resume-unverified` with
  `mayHaveSent: true` instead; `vm-confirmed` with a verified anchor returns
  `{ name, ual, txHash: null, resumed: true }`, and one whose `_meta` cannot be read now
  (an error, a truncated read) throws `resume-unverified`; an author mismatch, a sealed
  or shared record that also names a published assertion, an anchor that fails the
  rules below, or any other status throws `resume-refused`. Resume finishes the content
  already sealed under that name, not the quads passed in. Deliberate trade-off: if an
  unknown publish in fact sent nothing, the asset stays unpublished until an operator
  checks.
- `vm/publish` answers are sorted by what they can prove. A 4xx is refused before any
  chain call (stage `publish`). Anything else that is not a `200` with
  `status: 'confirmed'` and a UAL (a 500, 502, 503 or 504, status 0, a body cut off,
  over the limit or unparseable, a `200` saying `pending` or `tentative`) is a lost
  response. A lost response is success only when the descriptor is `vm-confirmed` with a
  chain-confirmed (not tentative) UAL under the sealing author, its `vmCurrentAssertion`
  equals the sealed merkle root where exposed, and the `<cg>/_meta` rows about exactly
  that UAL pass `anchorsFromMeta` (`src/provenance.mjs`), the resolver's own anchor
  rules, for the UAL's graph. The writer's anchor query also asks for `dkg:merkleRoot`
  (a v10.0.16 node writes it on the UAL as bare hex); where the rows carry it, it must be
  exactly one value equal to the sealed root. A node that writes none leaves that
  comparison out. The resolver does not ask for it. The publishing node's token must be
  able to read that `_meta`. Otherwise `publish-transport` with `mayHaveSent: true`,
  carrying any UAL or transaction the node reported.
- Response bodies are capped at `maxResponseBytes` (default 32 MiB); a larger body
  throws `ResponseTooLargeError`, a `ReadTruncatedError`. A response with no readable
  stream is read only when a declared `content-length` bounds it (a null-body status
  reads as empty); otherwise it is refused unread.
- A missing or unreadable `auth.token` throws `NodeTokenError` when the token is first needed.

`recordDerivation(node, contextGraphId, { outputUrl | outputSha256, servedCapability, servedModelId?, authorizedUnder, billedUsd?, jobId?, derivedAt?, expectAuthor?, id?, name?, resume?, lastPublishUnknown?, fetchOptions? }) → { id, name, outputSha256, ual, txHash, … }`

- `id` and `name` from an earlier attempt must carry the output's hash prefix and one
  shared nonce; `billedUsd` must be null or an amount the graph writer can write
  (`decimalTerm`: finite, non-negative, not too large for a plain decimal);
  `lastPublishUnknown` must be a boolean and is passed to `sealShareAnchor`. All are
  checked before anything is fetched. On failure the error also carries `derivationId`.
- `reconcile({ billedJobs, derivations })` counts only derivations with `trusted === true`.

## CLI exit codes

| Code | Meaning |
|---|---|
| 0 | success, permitted, CLEAR; `help`, `-h`, `--help` and `--version`; `render --execute` over a render already `recorded`; `revoke` of a grant already revoked |
| 1 | usage or configuration error (`UsageError`, `TermError`, `ConfigError`, `PendingInvariantError`): a bad flag or graph id, a producer that is not trusted, `--at` with `--execute`, the "publish" confirmation needed off a terminal or with `--json` and no `--yes`, a gate `malformed-request`, an `--idempotency-key` that differs from the one a possibly billed render was sent with |
| 2 | refused by the gate; TAINTED or UNKNOWN; `revoke` of a grant not found or not this node's |
| 3 | consent not confirmed: no clip before the link expired, transcription failed, no affirmative first-person consent, a requested term not heard without `--force`, not a reading of the consent script with a typed confirmation not given or wrong, or a typed confirmation needed but impossible (off a terminal, or `--json`); `grant --with-consent` off a terminal, with or without `--yes`, before any link; `consent` on anything but a reading of the script. Nothing is published |
| 4 | render succeeded but its derivation failed to commit, at any stage (`create`, `share`, `author`, `publish`, `publish-transport`, `unbound`, `resume-refused`, `resume-unverified`); the result carries `stage`, `asset`, `derivationId`, `ual`, `txHash`, `mayHaveSent` |
| 5 | render failed (tool error, no media), or a rerun found the render `submitted` with a job id, `rendered`, or being dispatched by another process (`PendingConflictError`); `record` on a job that failed or a render that never produced a job |
| 6 | grant or revocation write failed before anchoring (`create`, `share`, `author`) |
| 7 | grant or revocation anchor not confirmed (`unbound`, `publish`, `publish-transport`, or any `mayHaveSent`); the result carries the grant id, state id for a revocation, asset name, stage and a `check` command |
| 8 | consent contradicted; never overridable |
| 9 | INCONCLUSIVE: node unreachable, stale or read inconsistent; `DkgHttpError`, `ReadTruncatedError`, `FetchBytesError`; an unreadable `auth.token` (`NodeTokenError`), local state file (`StateReadError`) or pending file (`PendingReadError`, which names the file); a Livepeer failure that is not about credentials; `RenderError` `unknown-status`; a render whose outcome is unknown, from `render --execute` (still `submitted` after the attempt) or `record` (no answer saved, or a poll that timed out) |
| 10 | Livepeer payment or credential problem, including `spend_cap` showing the estimate over the account's remaining 24 h budget |

Derivation failures are exit 4 whatever their stage, because the render exists and was
billed; the DKG stages decide exit 6 or 7 only for grants and revocations.

**Consent (grant).**

- A transcript that is a reading of the consent script (`scope.confirmed` and
  `scope.scriptMatch.matched`) with nothing contradicted needs no typed answer about its
  words; only what the script never states is typed (`none` for no ceiling, `anywhere`
  for no territory). Only such a grant is published with `consentClipSha256`.
- Anything else prints the script, the transcript and `scriptMatch.missing` and `extra`
  (to stderr too with `--json`). Without an affirmative first-person consent it is exit 3.
  Requested terms the heuristics did not hear are exit 3 unless `--force`. Otherwise the
  operator types `matches`, `consents`, then each `unchecked` item (the end date as
  `YYYY-MM-DD`, the ceiling or `none`, `anywhere`), and the grant is published **without**
  `consentClipSha256`.
- `--force` only lets unheard terms go on to that typed confirmation. It never overrides
  a failed transcription, a missing affirmative consent or a contradiction.
- `--yes` skips only the typed "publish" confirmation, never a consent answer. A typed
  answer that is needed off a terminal or with `--json` is exit 3 before publishing.
- The result's `consent` carries `sha256`, `forced`, `scriptMatched`, `confirmedBy`
  (`script` or `operator`) and `publishedClipHash`.

**Grant and revocation writes.** A `DkgWriteError` from `sealShareAnchor` is reported,
human and `--json`, with `outcome` (`unknown` when `mayHaveSent`, else `failed`), `error`,
`stage`, `grantId` (and `stateId` for a revocation), `assetName`, `contextGraphId`, `ual`,
`txHash`, `mayHaveSent`, `exitCode` and, when unknown, `check`: `mandate revoke --id
<grantId>`. For a grant it answers "not anchored" until the grant lands and then revokes
that same id; for a revocation it answers "already revoked" once it lands. The ids are
generated before the write, so a retry never needs a new one to find the first.

**Renders.**

- `render --at` decides as of another time and is refused with `--execute`.
- A render that may have been billed (`mayBeBilled`: `submitted`, `mayHaveStarted`, or
  a `dispatching` attempt marked sent with no outcome) is resumed by a rerun through
  `pending.beginAttempt`: the stored idempotency key is reused (omitting
  `--idempotency-key` sends it; a different one is exit 1 before sending), the attempt is
  added to `attempts[]`, and it stays in local pending spend until it is rendered and
  recorded. It is never saved as `failed`: a clean failure of a later attempt, or a
  `spend_cap` refusal, leaves it `submitted` and exits 9 (or 10 for the refusal).
- Local pending spend counts `dispatching`, `submitted` and `rendered` records and any
  that may be billed, at the larger of the platform cost and the estimate when both are
  known, otherwise by the same rule as the recorded `billedUsd` (an estimate scaled by
  `--seconds` counts as unknown, which refuses under a ceiling).

**Derivation retries (`record --pending`).** An attempt that stopped at `create`, `share`
or `author`, or at `publish` with a saved 4xx status, is continued. Any other attempt, or
one that reported a UAL, a transaction or `mayHaveSent`, counts as a publish of unknown
outcome: the CLI reads the descriptor first, continues only a sealed or already published
asset (the latter is only verified), or starts over when no asset exists and nothing
reported `mayHaveSent`, and passes `lastPublishUnknown: true`. A shared asset, a missing
one after `mayHaveSent`, or an unreadable descriptor is `resume-unverified` (retry later).
`unbound` and `resume-refused` are permanent: the asset is never published again, and the
render keeps counting against the ceiling on this machine.

## Local state

`~/.mandate` (`MANDATE_HOME` overrides). The `pending/` and `state/` directories are
mode 0700 and their files 0600, written atomically; `~/.mandate` itself is not changed.

- `pending/<key>.json` holds a render record written before dispatch. Status moves
  `dispatching` → `submitted` (with a job id, or `mayHaveStarted`) → `rendered` →
  `recorded`, or `failed`. Every dispatch is an entry in `attempts[]`
  (`{ n, startedAt, pid, idempotencyKey, sentAt?, endedAt?, status, jobId, errorKind, mayHaveStarted? }`).
- Three rules hold for any record: its idempotency key never changes once saved
  (`PendingInvariantError`); `attempts[]` is never shortened; and a record that may be
  billed is never saved as `failed` (it is saved `submitted` with `lastOutcome: 'failed'`;
  only `allowResolve` bypasses that). The coercion is deliberate: throwing would lose the
  error the caller is reporting.
- `beginAttempt(record) → { record, resumed, attempt }`: creates the record, or refuses
  one that is `recorded`, `rendered` or `submitted` with a job id (`PendingConflictError`)
  or being dispatched by a live process on this machine (`inFlight`), or resumes one that
  may be billed under its stored key, or starts a fresh attempt (which may use a new key)
  after a clean failure. `markSent(key)` is called immediately before `run_capability`.
  `finishAttempt(key, outcome)` closes the attempt. `create`, `beginAttempt`, `markSent`
  and `finishAttempt` run under an exclusive per-key lock file (`<key>.json.lock`), waited
  on for about 1 s and then refused as in flight; a lock from a dead process or older than
  30 s is cleared. Liveness is judged on this machine only: two machines sharing one
  `MANDATE_HOME` are not protected from each other.
- A record written before `attempts[]` existed is legacy; a legacy `dispatching` record
  counts as possibly billed. A pending file that exists but cannot be read throws
  `PendingReadError` naming it.
- `derivationAttempt` keeps the derivation's `id`, `name`, `ual`, `txHash`, `stage` and
  `mayHaveSent`; name and id never change once set, and `mayHaveSent` stays true. The
  record also keeps `derivationPublishStatus`, the HTTP status of a `publish` refusal.
- `state/<context-graph>.json` is
  `{ version: 1, knownUals: { <addr>: [ual] }, revocations: { <grantId>: { id, ual, txHash, publisher, stateOf, stateAt } } }`.
  It is updated only after a consistent read, and entries are never removed.
