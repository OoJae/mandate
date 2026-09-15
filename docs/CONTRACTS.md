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
  prefix whose `stateOf` cannot be read makes the read inconsistent, and so does any
  object there, whatever its types (untyped, or only `LikenessGrant`), with Mandate
  predicates and a `stateOf` value naming a current grant of the publisher that cannot be
  read as exactly one IRI (a literal, or several values): it is listed as unreadable and
  reported as a trusted `malformed` forgery.
- **A grantor's statement about its own grant is a state, whatever else it is.** In a
  grants graph, an object typed `GrantState` (with any other types), or any object whose
  one `stateOf` names a current grant owned by the anchoring publisher, is read as a state
  before it is considered as a grant. Other types on it (also `LikenessGrant`,
  `Derivation` or `Refusal`, no `GrantState` type, an unknown Mandate type) are problems,
  so the state is malformed and counts as a revocation.
- **Revocation is terminal per grant IRI.** `active` has no effect.
- **Tiers.** `vm` may permit or clear. `swm` revocations warn. A revocation seen
  only in the merged `<cg>/context/<id>` graph is honoured (tier `context`) unless it
  has a Verifiable Memory twin **under the grant owner's own prefix**: a state or forgery
  of the grantor read with that subject IRI, or a discovery row with that subject in a
  `_verifiable_memory/<owner>/` graph. A stranger's Verifiable Memory object reusing the
  subject IRI explains nothing, so it cannot cancel the view row. Trade-off: a non-active
  state a stranger published, if a node shows it in its merged view, is honoured there as
  a revocation, because its only twin is the stranger's. Live v10.0.16 nodes build views
  only from data they published, so only the stranger's own node shows it that way, and
  no stranger can block a grant on anyone else's node. For hand-built knowledge, the
  gate and verifier count a state from the grant's publisher with no tier or an
  unrecognised one, or a `vm` state whose `malformed` flag is anything but absent, `null`
  or `false` (so `1` or `"true"` counts), as a revocation whatever its `state` says. A
  state with neither a string `publisher` nor a `vm`, `context` or `swm` tier cannot be
  attributed: it is a knowledge problem, so the gate refuses at `read-inconsistent` and
  the verifier returns `INCONCLUSIVE`.
- **Deny list.** `PROHIBITED_USE_CLASSES` (`src/policy.mjs`): `adult`, `sexual`,
  `deceptive-impersonation` and synonyms. A request's use-class label is normalised
  (lowercase; spaces, underscores and dots become hyphens) and split into letter-only
  words at hyphens and digits. It is refused when any word, or any run of adjacent words
  joined together, is on the list, either as written or with one common inflection
  removed (`s`, `es`, `ing`, `ed`, `ised`, `ized`, `ly`, `ness`, `y` and similar, with and
  without a restored final `e`), or when any single word contains one of
  `PROHIBITED_STEMS` (`porn`, `sexual`, `sext`, `adult`, `deepfake`, `impersonat`, `nudi`,
  `nude`, `naked`, `erotic`, `explicit`, `nsfw`, `xxx`, `xrated`, `lewd`, `hentai`,
  `fetish`, `onlyfan`, `smut`, `kink`, `camgirl`, `undress`, `topless`, `bdsm`, `impostor`,
  `imposter`) as a substring. `stripper`, `striptease` and `catfish` are whole words only,
  so `comic-strip` passes and `catfishing` is refused. Deliberate trade-offs: innocent
  labels such as `adult-education`, `sextant`, `nudibranch` or `catfish-recipe` are
  refused. Named limits: it is a check on the declared label only; leetspeak that splits
  at a digit (`p0rn`, `s3x`) passes; and the list is incomplete (`lingerie`, `boudoir`,
  `scam`, `fraud` and `voice-clone` pass), so a grant's `permitsUseClass` is the control
  that holds.

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
an id the node does not hold, or holds in another case, is inconsistent. An entry counts
as held only when its `subscribed` flag is exactly `true` (a missing flag, or the string
`"false"`, is not a subscription). If the
subscriptions cannot be listed (a transport error, 404, 5xx, or an answer of an
unexpected shape), the empty read is inconsistent too. Deliberate trade-off (fail-open):
a 403, or a node with no subscriptions call, is only a warning, because a token without
node-admin rights gets 403 here and from reconcile, and refusing would block every
decision against a graph that is legitimately empty. On such a node a mis-typed or
unsubscribed graph id still reads as empty. `checkFreshness` is off unless the caller
sets it (the CLI does, unless `MANDATE_CHECK_FRESHNESS=0`). When it is not truthy, every
read adds the warning `freshness not checked: a node behind the chain can miss a
revocation or a render (checkFreshness is off)`, and `decide` passes it through.

**Hand-composed knowledge.** The gate and verifier believe `consistency.ok`. A caller that
builds knowledge from `anchorsFromMeta` and `reduceSlice` instead of `readKnowledge` must
itself apply `readPublisher`'s rules and set `ok: false` when any fails: `checkConsistency`
over each publisher prefix, no `anchorsFromMeta` problem, no content row with an
unreadable graph, an **empty `unreadable` list** from `reduceSlice` (a grantor's
revocation whose `stateOf` cannot be read lands there, not in `states`, and skipping the
rule loses it), and an empty read believed only when every attempt answered. Such
knowledge also lacks merged-view and shared-memory revocations, remembered anchors and
revocations, and the freshness check.

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
| More than one view graph of one context graph in state discovery | shown on different sets of attempts | read inconsistent (a node is expected to hold one view graph per context graph) |
| The one-row probe for whether the node holds any merged view of that graph, while no attempt has shown one | not answered on every attempt | read inconsistent |
| A state with any row whose value is not exactly `active` | `_shared_memory/…` | warning only |
| A state with any row whose value is not exactly `active` | merged view (`<cg>/context/<id>`) with no Verifiable Memory copy under the grant owner's own prefix | revocation, tier `context` |
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
- when a view is expected, discovery never stops after its first attempt, so a view left
  out of one answer has a second to show in; that costs one extra attempt (one backoff,
  250 ms with the defaults) on a node that holds the view;
- a node that leaves the view out of the probe and out of the state query on every single
  attempt is not caught, because nothing else distinguishes it from a node that holds no
  view. Remembering per node that a view was once seen would close that for later reads;
  it is not done;
- the check is per context graph, not per view graph. It assumes one merged view graph
  per context graph, as live v10.0.16 nodes materialise, and enforces only that several
  view graphs show on the same attempts: a node holding several view graphs that leaves
  the one holding the revocation out of every attempt, while another still shows, is not
  caught.

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
- A grant id held by more than one authentic grant is refused at `grant-exists`. A trusted
  forgery whose id is a grant IRI naming its own publisher (the grantor's own unreadable
  copy) counts as a copy too: the reason reads `(N copies, M of them unreadable)`. A copy
  published by any other address is a forgery, not a copy, and is not counted. The
  verifier applies the same rule (`unreadableGrantCopies` in `src/gate.mjs`, used by
  `judgeEdge`): a file made under such a grant verifies `TAINTED / MALFORMED` with the same
  `(N copies, M of them unreadable)` reason, and the unreadable copy is listed in the
  result's `forgeries`.
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
  NFKD with only the accents precomposed letters decompose into dropped (`ACCENT_MARKS`:
  U+0300–U+030C, U+030F, U+0311, U+0313, U+0314, U+031B, U+0323–U+0328, U+032D, U+032E,
  U+0330, U+0331, U+0333, U+0342, U+0345; not the U+0338 solidus, which strikes a letter
  out), `&` to `and`, punctuation and hyphens split; a question mark (`?`,
  `¿`, `؟`, `‽`, `⸮`, the Armenian `՞`, Ethiopic `፧`, Limbu, Old Nubian, Vai, Bamum,
  Chakma and Adlam marks, anything NFKD folds to `?`, and the Greek question mark U+037E,
  matched before NFKD folds it to `;`) kept as a word of its own; punctuation is closed
  world too: only `. , ; : ! ' "`, typographic quotes, hyphens and dashes, parentheses and
  brackets are dropped (NFKD turns an ellipsis into dots first), and every other character
  Unicode classes as punctuation (`\p{P}`, for example `/`, `*`, `%`, `@` or a medieval
  question mark) is a word of its own; every run of letters, digits, symbols, marks
  (including the overlays and strikes U+0334–U+0338, the grapheme joiner U+034F and any
  other mark not in `ACCENT_MARKS`), private-use (`\p{Co}`), unassigned (`\p{Cn}`, which
  depends on the running Node's Unicode version) or lone-surrogate code points that does
  not fold to a-z0-9 (another script, small capitals, emoji) kept as one word, and only
  spaces, controls and format characters (`\p{Z}`, `\p{Cc}`, `\p{Cf}`) dropped; `lipsync` to `lip sync`,
  `faceswap` to `face swap`, `St` to `saint`; `U.K.`/`UK` to `united kingdom`,
  `U.S.`/`US`/`USA` to `united states`; ordinals and number words to digits (including
  years said in pairs and "two thousand and twenty six"), except that a number phrase with
  an ordinal after `a`/`an` or right before a currency or `point` word stays as said, so
  `a fifth US dollars` is not `5`; every spoken form of US dollars (`US dollars`,
  `U.S. dollars`, `American dollars`, `United States dollars`, `USD`, `US$5`) to one word,
  `usdollars`, while a bare `dollars`, `dollar` or `$5` stays `dollars`, which is not the
  script's word; decimals such as `2.50` and "two point five" to one form; dates in
  day-month-year order.
- `matchScript(transcript, requested)` aligns the two word lists (longest common
  subsequence, critical words weighted so they are never traded for others). `matched`
  only when no **critical** word is missing, at most `SCRIPT_MAX_MISSES` (2) script words
  are missing, and every transcript word outside the alignment is filler. The filler is exactly: `hi hello a an the`
  (`SCRIPT_FILLER`): words that cannot say no alone or in any combination. **Hesitation
  sounds are not filler**: `um`, `uh`, `er`, `erm`, `ah`, `hmm`, `mm`, `mhm`, `nuh` and their
  spellings are extra, because hyphens are split before comparing and `uh-uh`, `mm-mm`,
  `hmm-mm`, `ah-ah` and `nuh-uh` are a spoken "no"; so are `yes`, `yeah`, `okay`, `ok`,
  `so`, `well` and `hey` (`yeah, yeah`, `well…`, `hey!`). A transcript with any of them is
  unconfirmed and needs a person. Only the joining
  words `to`, `of`, `for`, `in`, `and` (between listed terms), `is` and `at` are
  non-critical; every other script word is critical (`I`, `consent`, every capability,
  use class and territory word, `my`, `likeness`, `until`, each word of the date,
  `spending`, `capped`, the amount and `usdollars`). So a `?` or a word in another script
  is extra and blocks the match, and `of the likeness` or `is capped at 5` does not
  match. No negators, conjunctions or
  conditionals are filler. `missing` lists the script words not found, `extra` the
  non-filler words not aligned. A transcript longer than 4 × script words + 64 is not
  aligned and never matches.
- `confirmed` is `scriptMatch.matched`, with nothing contradicted, and `checks[0].matched`
  (the heuristics hear an affirmative first-person consent). Anything else is
  UNCONFIRMED and needs a person. The heuristics can only take a confirmation away.
  Trade-off: an article inside the consent clause (`I, the, consent to ...`) matches the
  script but is not heard as affirmative, so it needs a person.
- Named limits: the script's words are compared, not what the person meant by them (a
  territory name read from the script names what the grant names); up to two of the
  seven joining words listed above may be dropped; `a`, `an`, `the`, `hi` and `hello` are
  filler anywhere; and a use-class label that itself contains a negator makes the script contradict itself,
  so every reading of it is exit 8 (fails closed).
- The heuristics do not hear a refusal made only of sounds (`uh-uh`, `mm-mm`): it is never
  `contradicted`. It is kept from confirmation only because those sounds are not filler, so
  on the typed path the person watching the clip is what catches it. The heuristics'
  `normalise` also drops text outside Latin letters; the script match compensates, since
  such text is always extra there.

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
  `kind 'timeout'` with `mayHaveStarted true`; that includes an `ok: false` reply whose
  error or text says it timed out, the deadline was exceeded, or the render continues in
  the background. An error reply carrying a malformed job id
  is classified first and kept recoverable. This wording comes from plausible platform
  texts and has not been checked against a live timeout.
- `dispatchRender(client, { capability, inputs, prompt, sourceUrl, idempotencyKey, mode, onJob, poll }) → { url, jobId, replay, mode, servedCapability, costUsdEstimated, warnings }`.
  Poll options are validated before anything is sent (finite, non-negative, at most
  2147483647 ms). With a job id, the reply is the result only when its status is done and
  its structured URL is usable; otherwise the job is polled. Text is scanned for a URL
  only when there is no job id, and a queued reply whose job id is not in the accepted
  shape stops with `mayHaveStarted true` instead. A structured `url` counts as the media
  only when its path ends in a media file extension (`.mp4`, `.webm`, `.png`, `.wav` and
  the rest of `MEDIA_EXT`) or it is under `agent.livepeer.org/a/`; a job or status page is
  polled when there is a job id, and is `no-media` otherwise. `poll: null` is the same as
  no poll options; a `poll` that is not an object, or an `onStatus` or `now` that is not a
  function, is refused before dispatch. Once a job id exists, any error that is not
  already a `RenderError` (an `onJob` callback that throws, a clock that returns a
  non-number) becomes a `RenderError` `kind 'tool'` carrying that job id and
  `mayHaveStarted true`. Reply content that is not a list, or holds non-objects, is read
  as no text.
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
- In the CLI, a `servedCapability` of `null` (the platform's claim was unusable) is saved
  as `servedCapabilityUnknown: true`, never replaced by the requested capability, and
  `commitDerivation` anchors nothing for it: exit 4, stage `served-unknown`, URL withheld.
  Trade-off: the render stays billed and unrecorded and keeps counting against the
  ceiling on this machine.
- `extractMediaUrl(structured, text, inputUrls)` never returns one of the inputs,
  compared by lowercased host without a default port and the percent-decoded path with
  repeated slashes collapsed (scheme, query and fragment ignored). A structured URL that
  is present but unusable gives `null`, with no text scan. `collectInputUrls(value)` walks
  nested objects and arrays.
- `classifyFailure(structured, text)` removes URLs before matching. A numeric 402 is
  payment; a numeric 401 is payment unless the text names fetching an input; other
  numeric codes are tool errors, unless the text uses a phrase that can mean nothing but
  money (so `{ status_code: 500 }` or `403` with such text is payment); for a 401 or 403
  about fetching an input, only account wording counts. A recognised payment code is payment (except
  `unauthorized` on an input fetch); any other code is payment only for phrases that can
  mean nothing but money.

## DKG writes

`DkgNode.sealShareAnchor({ name, contextGraphId, quads, expectAuthor, resume = false, lastPublishUnknown = false }) → { name, ual, txHash, merkleRoot, … }`

- `DkgWriteError { name (the asset name, when known), assetName, stage, status, body, ual, txHash, mayHaveSent }`.
  Stages: `create`, `author`, `share`, `publish` (refused with a 4xx; `mayHaveSent:
  false`, meaning no mint can follow, not that nothing reached the chain: see below), `publish-transport` (the answer could not be trusted and
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
- `vm/publish` answers are sorted by what they can prove. A 4xx whose body was read is
  refused (stage `publish`; an unread 4xx body, such as one over the size limit, is a lost
  response): it never follows a successful mint, so republishing cannot mint twice. It
  does not prove nothing was sent. On v10.0.16 a `400 NO_FUNDED_PUBLISHER_WALLET` can
  come after the node's TRAC approve transaction or a publish that reverted, and a 400
  from context graph auto-registration can come after a registration transaction. Either
  may have spent gas; neither mints. Anything else that is not a `200` with
  `status: 'confirmed'` (a 500, 502, 503 or 504, status 0, a body cut off, over the limit
  or unparseable, a `200` saying `pending` or `tentative`) is a lost response, and so is
  a confirmed `200` whose UAL is missing or not chain-confirmed, names another author
  than the sealing one, or whose reported `merkleRoot` is not the sealed root. A lost response is success only when the descriptor is `vm-confirmed` with a
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

## CLI configuration

`bin/config.mjs`. Nothing is loaded at import time. `main()` calls
`loadMandateEnv({ flag: flags.envPath })` before every command and prints its warnings on
stderr; `scripts/nodes.mjs` and `scripts/publish-skill.mjs` call it the same way.
`scripts/publish-ontology.mjs` and the spikes that read `bin/config.mjs` (`s6`, `s6b`, `s6c`)
call `loadScriptEnv(argv)` first: the same `--env-path` lookup and `--env-file` refusal,
printing `env file: <path>` or `env file: none (looked for …)`, exit 1 on a bad flag or an
unreadable named file. `s6c` hands the file it loaded to every CLI call with `--env-path`.

- `envFileLocation({ flag, env }) → { path, source, explicit }`, first match wins:
  `--env-path <path>` (source `--env-path`, explicit), `MANDATE_ENV_FILE` (explicit),
  `$MANDATE_HOME/.env` with `MANDATE_HOME` from the real environment, default
  `~/.mandate/.env` (source `MANDATE_HOME`, not explicit). A leading `~` in `MANDATE_HOME`
  or `MANDATE_ENV_FILE` is expanded to the home directory and an empty value counts as
  unset; any other relative value (including `MANDATE_HOME` set inside the env file) is a
  `ConfigError` (exit 1), because it would be read from whatever directory Mandate runs in.
  `mandateHome(env)` in `src/state-store.mjs` is the one resolver for the state and pending
  directories too. **A `.env` in the working directory is never read.**
- `homeDirectory()` in `src/state-store.mjs` is the one source of the home directory: the
  default `~/.mandate` and every `~` expansion (`MANDATE_HOME`, `MANDATE_ENV_FILE`,
  `--env-path`, a DKG node home in `src/dkg.mjs` and `scripts/nodes.mjs`) go through it.
  It throws `ConfigError` ("HOME is empty or relative; set MANDATE_HOME to an absolute
  path", exit 1) unless `os.homedir()` is absolute, since Node returns an empty or relative
  `HOME` as it is. A DKG node home is expanded when the node is configured (`new
  DkgNode`), so its `ConfigError` comes before any request rather than as an unreadable
  token. An absolute `MANDATE_HOME` needs no home directory.
- `loadMandateEnv` returns (and keeps in `envLoad`) `{ path, source, searched, loaded,
  ignored, warnings }`. An explicit file that is missing, unreadable or not a regular file
  is a `ConfigError` (exit 1); a missing default file is not, and `path` stays `null`. A
  file with any group or world write bit (`mode & 0o022`) is loaded with a warning to
  `chmod 600` it.
- Only keys matching `ENV_KEY` (`MANDATE_*`, `LIVEPEER_AGENT_KEY`) are copied, and only when
  unset in the environment: the real environment wins. Other keys are listed in `ignored`.
- `--env-file` and `--env-file-if-exists` are refused by `parseArgs` (and by both scripts),
  exit 1, pointing to `--env-path`: Node.js scans the whole argv for `--env-file`, even
  after the script name, and applies a `NODE_OPTIONS` from that file before any Mandate
  code runs.
- `status` and `verify` print the configuration in effect and put it in the JSON result as
  `config: { envFile, envFileSource, envFileSearched, envKeysLoaded, envFileWarnings,
  trustedProducers, grantsCgs, derivationsCgs, checkFreshness }`. With the freshness check
  off they print a yellow `FRESHNESS CHECK OFF` notice.
- `demo/full.mjs` passes `--env-path <repo>/.env` (overridable with its own `--env-path`) to
  every `mandate` and `scripts/nodes.mjs` child.

## CLI exit codes

| Code | Meaning |
|---|---|
| 0 | success, permitted, CLEAR; `help`, `-h`, `--help` and `--version`; `render --execute` over a render already `recorded`; `revoke` of a grant already revoked by a `vm`-tier revocation (a revocation seen only in this node's merged view, tier `context`, is warned about and an anchored one is published) |
| 1 | usage or configuration error (`UsageError`, `TermError`, `ConfigError`, `PendingInvariantError`): a bad flag or graph id, a producer that is not trusted (`render --execute` before dispatch; `record --pending` before hashing or publishing, leaving the record as it was), an env file named with `--env-path` or `MANDATE_ENV_FILE` that is missing, unreadable or not a file, `--env-file` or `--env-file-if-exists` (refused in favour of `--env-path`), `--at` with `--execute`, the "publish" confirmation needed off a terminal or with `--json` and no `--yes`, a gate `malformed-request`, an `--idempotency-key` that differs from the one a possibly billed render was sent with |
| 2 | refused by the gate; TAINTED or UNKNOWN; `revoke` of a grant not found or not this node's |
| 3 | consent not confirmed: no clip before the link expired, transcription failed, no affirmative first-person consent, a requested term not heard without `--force`, a transcript too long to review in full (over 4000 characters, or 50 or more extra words) on the unconfirmed path, not a reading of the consent script with a typed confirmation not given or wrong, or a typed confirmation needed but impossible (off a terminal, or `--json`); `grant --with-consent` off a terminal, with or without `--yes`, before any link, and with `--json` for a grant with no ceiling or no territory (which must be typed), before any link; `consent` on anything but a reading of the script. Nothing is published |
| 4 | render succeeded but its derivation failed to commit, at any stage (`create`, `share`, `author`, `publish`, `publish-transport`, `unbound`, `resume-refused`, `resume-unverified`, or `served-unknown` when the serving capability could not be recorded); the result carries `stage`, `asset`, `derivationId`, `ual`, `txHash`, `mayHaveSent` |
| 5 | render failed (tool error, no media), or a rerun found the render `submitted` with a job id, `rendered`, or being dispatched by another process (`PendingConflictError`); a `render --execute` or `record --pending` whose key's lease another live process holds (at once, `inFlight: true`; `record` also `outcome: 'in-use'`); a render that waited over about 15 s for the grant lock, or whose in-lock decision permits under another grant (`decisionChanged: true`); `record` on a job that failed (settled as `failed-confirmed` when the platform reports that job id failed) or a render that never produced a job |
| 6 | grant or revocation write failed before anchoring (`create`, `share`, `author`) |
| 7 | grant or revocation anchor not confirmed (`unbound`, `publish`, `publish-transport`, or any `mayHaveSent`); the result carries the grant id, state id for a revocation, asset name, stage and a `check` command |
| 8 | consent contradicted; never overridable |
| 9 | INCONCLUSIVE: node unreachable, stale or read inconsistent; `DkgHttpError`, `ReadTruncatedError`, `FetchBytesError`; an unreadable `auth.token` (`NodeTokenError`), local state file (`StateReadError`) or pending file (`PendingReadError`, which names the file); a Livepeer failure that is not about credentials; `RenderError` `unknown-status`; a render whose outcome is unknown, from `render --execute` (still `submitted` after the attempt, including a rerun refused by `spend_cap`) or `record` (no answer saved, or a poll that timed out) |
| 10 | Livepeer payment or credential problem, including `spend_cap` showing the estimate over the account's remaining 24 h budget, unless an earlier attempt of that render may have been billed: then the record stays `submitted`, the result carries `outcome: 'unknown'`, and the exit is 9 |

`scripts/nodes.mjs doctor` sets exit 9 when a node is unreachable, or a configured graph
is not current (behind, or freshness unknown) or not subscribed. When listing
subscriptions answers 403, each graph's subscription is reported as unknown, which does
not set 9, and freshness is still checked.

Derivation failures are exit 4 whatever their stage, because the render exists and was
billed; the DKG stages decide exit 6 or 7 only for grants and revocations.

**Consent (grant).**

- Before any link is requested (`request_upload`), `grant --with-consent` checks
  everything that could stop the publish: the terms serialise, the grants graph is this
  node's, a `--valid-from` is not in the past (exit 1: a grant with a consent clip cannot
  start before the clip is recorded), the terminal and `--json` rules, `readConfig()`
  (so an unset `MANDATE_DERIVATIONS_CG` is exit 1) and a consistent `readKnowledge` of the
  grantor's grants for the clip-reuse check (`readClipHistory`; an inconsistent read is
  exit 9, `reason: 'consent clip reuse not checked'`). Only the hash comparison
  (`clipAlreadyUsed(history, sha256)`) runs after capture.
- When the clip has arrived, a `validFrom` earlier than that moment (the default, which
  is the command's start, or a `--valid-from` that passed during capture) is set to it,
  with a notice when it was given. A `validUntil` that passed during capture is exit 1.
  A grant without `--with-consent` may start in the past.
- A transcript that is a reading of the consent script (`scope.confirmed` and
  `scope.scriptMatch.matched`) with nothing contradicted needs no typed answer about its
  words; only what the script never states is typed (`none` for no ceiling, `anywhere`
  for no territory). Only such a grant is published with `consentClipSha256`.
- The transcript is printed before the heuristics' checks (over the limit below, only its
  length), and a contradiction (exit 8) is decided first. Anything else prints the script, the transcript and `scriptMatch.missing`
  and `extra` (to stderr too with `--json`), **in full**: control characters are removed and
  tabs and line breaks become spaces, and nothing is cut. A transcript over
  `TRANSCRIPT_REVIEW_MAX` (4000 characters, after that cleaning), a missing or extra list
  over 4000 characters, or 50 or more extra words (`matchScript` lists at most 50 for a
  transcript it does not align, so such a list may be cut) is exit 3, `TOO LONG TO REVIEW`,
  before any question, with `reason: 'transcript too long to review'` in the summary.
  Without an affirmative first-person consent it is exit 3.
  Requested terms the heuristics did not hear are exit 3 unless `--force`. Otherwise the
  operator types `matches`, `consents`, then each `unchecked` item (the end date as
  `YYYY-MM-DD`, the ceiling or `none`, `anywhere`), and the grant is published **without**
  `consentClipSha256`.
- A consent clip answers one capture. Before capture, the grantor's own anchored grants
  are read, and a clip whose SHA-256 already backs one of them, revoked or not and for any
  subject, is exit 3 (`reason: 'consent clip reused'`, `usedBy` naming the grant). If the
  grants graph cannot be read consistently the grant is exit 9 before capture. A clip used
  for an operator-confirmed grant (published without its hash), a grant the grantor node
  has not yet read back, or one anchored after that read (while this clip was being
  captured), cannot be matched.
- `--force` only lets unheard terms go on to that typed confirmation. It never overrides
  a failed transcription, a missing affirmative consent or a contradiction.
- `--yes` skips only the typed "publish" confirmation, never a consent answer. A typed
  answer that is needed off a terminal or with `--json` is exit 3 before publishing.
- The result's `consent` carries `sha256`, `forced`, `scriptMatched`, `confirmedBy`
  (`script` or `operator`) and `publishedClipHash`.

**Grant and revocation writes.** A `DkgWriteError` from `sealShareAnchor` is reported,
human and `--json`, with `outcome` (`unknown` when `mayHaveSent`, else `failed`), `error`,
`stage`, `grantId` (and `stateId` for a revocation), `assetName`, `contextGraphId`, `ual`,
`txHash`, `mayHaveSent`, `exitCode` and, when unknown, `check`: `mandate blast-radius --grant
<grantId>`, which only reads (from the producer node, which may lag): "not found in the
grants graph" until a grant lands, its UAL once it has, and "revoked" once a revocation
lands. The check never publishes; revoking a landed grant, or publishing a second
(harmless) revocation, is a separate `mandate revoke --id <grantId>`. The ids are
generated before the write, so a retry never needs a new one to find the first.

**Renders.**

- `render --at` decides as of another time and is refused with `--execute`.
- A render that may have been billed (`mayBeBilled`: `submitted`, `mayHaveStarted`, or
  a `dispatching` attempt marked sent with no outcome) is resumed by a rerun through
  `pending.beginAttempt`: the stored idempotency key is reused (omitting
  `--idempotency-key` sends it; a different one is exit 1 before sending), the attempt is
  added to `attempts[]`, and it stays in local pending spend until it is rendered and
  recorded. It is never saved as `failed`: a clean failure of a later attempt, or a
  `spend_cap` refusal, leaves it `submitted` with `outcome: 'unknown'` and exits 9 (the
  refusal included; a `spend_cap` refusal with no earlier attempt open is 10).
- Local pending spend counts `dispatching`, `submitted` and `rendered` records, any that
  may be billed, and a `recorded` record whose derivation id is not among the knowledge's
  derivations (knowledge read before another local render finished), at the larger of the
  platform cost and the estimate when both are known, otherwise by the same rule as the
  recorded `billedUsd` (an estimate scaled by `--seconds` counts as unknown, which refuses
  under a ceiling).
- **Concurrency.** `render --execute`, after the first permit and the trusted-producer
  check, takes the key's lease (`pending.acquireLease(key)`), then runs inside
  `pending.withGrantLock(grantId)`: it reads `pending.list()` again, rebuilds local pending
  spend, calls `decide` again on the same knowledge, and saves the `dispatching` record with
  `beginAttempt` before the lock is released. A refusal there prints `REFUSED` with the
  clause (exit 2, 9 or 1 as for any refusal); a permit under a different grant is not
  dispatched (exit 5, `decisionChanged: true`). The lease is held through dispatch,
  polling and `commitDerivation`, and released in `finally`. `record --pending <key>` takes
  the same lease before loading the record. A second process that finds the lease held
  does not wait: `render` exits 5 with `inFlight: true`, `record` exits 5 with
  `inFlight: true, outcome: 'in-use'`. So the ceiling holds across concurrent processes on
  one machine that share `MANDATE_HOME`. It is not enforced across machines (or separate
  `MANDATE_HOME`s): their renders count only once their derivations are read from the graph.
- **`--seconds`.** When the decision has a ceiling, `--seconds` was given and the price unit
  is `second` or `character`, `price.note` (human output and every JSON result that carries
  `price`) says the estimate is the unit price times `--seconds`, taken as given, not sent to
  Livepeer or checked against the inputs, and billed for the real length.
- **Record.** `commitDerivation` reads the producer identity first and throws `ConfigError`
  (exit 1: nothing recorded, the record left as it was, media URL withheld) when the
  address is not in `trustedProducers`; an unreachable node is exit 4. For an idempotent
  replay, an existing derivation is reused only when it is trusted, under the same grant,
  has `outputSha256` equal to the hash of the released bytes, and does not carry a job id
  different from the record's; otherwise a new derivation is anchored.
- **Revoke.** Publishing is skipped only when `revocationOf(...).all` has a `vm`-tier state
  (local-state memory is `vm` too). A revocation only in the merged view (tier `context`)
  is warned about and an anchored revocation is published.

**Derivation retries (`record --pending`).** An attempt that stopped at `create`, `share`
or `author`, or at `publish` with a saved 4xx status, is continued. Any other attempt, or
one that reported a UAL, a transaction or `mayHaveSent`, counts as a publish of unknown
outcome: the CLI reads the descriptor first, continues only a sealed or already published
asset (the latter is only verified), or starts over when no asset exists and nothing
reported `mayHaveSent`, and passes `lastPublishUnknown: true`. A shared asset, a missing
one after `mayHaveSent`, or an unreadable descriptor is `resume-unverified` (retry later).
`unbound` and `resume-refused` are permanent: the asset is never published again, and the
render keeps counting against the ceiling on this machine.

**A job that failed for certain.** When `pollJob` throws a `RenderError` (`tool` or
`payment`) for the record's own job id whose structured status is a failed one (`failed`,
`cancelled`, `expired`, `timed_out` and the rest of `src/execute.mjs`'s set) and names no
other job, `record --pending` saves the record as `failed-confirmed` with
`allowResolve`, keeping its attempts, and exits 5 (10 for payment). `mayBeBilled` is
false for it, so it leaves local pending spend, and `beginAttempt` starts a fresh attempt
for a rerun. A timeout, an unrecognised status, no media or a reply about another job
leaves the record as it was. Named trade-off: a job the platform called failed may still
be billed, and that amount is then not counted against the ceiling on this machine.

## Local state

`~/.mandate` (`MANDATE_HOME` overrides). The `pending/` and `state/` directories are
mode 0700 and their files 0600, written atomically; `~/.mandate` itself is not changed.

- `pending/<key>.json` holds a render record written before dispatch. Status moves
  `dispatching` → `submitted` (with a job id, or `mayHaveStarted`) → `rendered` →
  `recorded`, or `failed`, or `failed-confirmed` (set only by `record` for a job the
  platform reported failed). Every dispatch is an entry in `attempts[]`
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
  after a clean failure. That fresh attempt starts clean: `jobId`, `mediaUrl`,
  `lastOutcome`, `error`, `errorKind`, `jobStatus`, `failedConfirmedAt`, `stage`,
  `servedCapability`, `servedCapabilityUnknown`, `costUsdEstimated`, `replay`, `renderMs`,
  `resumedFrom`, `mayHaveStarted`, `derivation`, `derivationAttempt` and
  `derivationPublishStatus` are removed from the record, and any that were set are kept
  under the previous attempt's `settled`. `markSent(key)` is called immediately before
  `run_capability`. `finishAttempt(key, outcome)` closes the attempt.
- Three kinds of lock file, all in the pending directory, all created with `wx` and
  carrying `{ pid, at, token }`:
  - **key lock** `<key>.json.lock`: `create`, `beginAttempt`, `markSent` and
    `finishAttempt` run under it. Held for milliseconds; a waiter tries for about 1 s
    (40 × 25 ms) and is then refused as in flight.
  - **grant lock** `grant-<sha256>.lock` (the first 32 hex characters of the SHA-256 of
    the grant id; `grantLockPath(dir, grantId)`): `withGrantLock(grantId, fn)` runs a
    synchronous `fn` under it. A waiter tries for about 15 s (600 tries), then gets
    `PendingConflictError` with `inFlight: true`.
  - **key lease** `<key>.json.lease`: `acquireLease(key) → { release() }`. The waiter makes
    only the short key-lock wait (about 1 s) and then gets `PendingConflictError`
    (`inFlight: true`, "in use by another mandate process"). The holder touches the file
    every 5 s on an unref'd timer.
  A lock or lease whose holder is alive on this machine is never taken over, however old:
  a suspended process (Ctrl-Z, a debugger) keeps it. It is taken over when its holder's pid
  is not alive on this machine, or, when the holder cannot be judged (another host, or an
  unparseable file), once the file is older than `UNKNOWN_HOLDER_STALE_MS` (1 hour). A
  crashed holder whose pid has since been reused by a live process leaves the lock until
  that process exits or the file is removed. The same pid rule is not applied to a record
  under a held lease: `beginAttempt` refuses a `dispatching` record whose last attempt is
  unfinished and whose pid is alive (`inFlight: true`) only while this store does not hold
  the key's lease. Every render and record of a key holds the lease, so while it is held
  here no other process is dispatching the key, and a live pid on a crashed attempt is a
  reused one: the record is resumed. Takeover happens only under
  `<lock>.takeover`, and only if the file still holds what was judged stale; release removes
  it only while it holds the caller's own token. Two machines sharing one `MANDATE_HOME`
  are not protected from each other.
- Every write to `pending/<key>.json` increments `revision`, and `load()` gives a record
  without one revision 0. A save from a copy whose `revision` no longer matches the file
  (`PendingStaleCopyError`), or made after this process lost the key's lease (`PendingLeaseLostError`), writes nothing
  and exits 5, so a finished record is never overwritten by a stale copy.
- A record written before `attempts[]` existed is legacy; a legacy `dispatching` record
  counts as possibly billed. A pending file that exists but cannot be read throws
  `PendingReadError` naming it.
- `derivationAttempt` keeps the derivation's `id`, `name`, `ual`, `txHash`, `stage` and
  `mayHaveSent`; name and id never change once set, and `mayHaveSent` stays true. The
  saved stage is never replaced by what a later attempt did not learn: a generic `error`
  (a retry that failed before or outside the write) is kept only as `lastErrorStage`; a
  permanent stage (`unbound`, `resume-refused`) is replaced only by another permanent one;
  and an attempt that may have sent is never relabelled `create`, `share` or `author`. The
  record also keeps `derivationPublishStatus`, the HTTP status of a `publish` refusal.
- `state/<context-graph>.json` is
  `{ version: 1, knownUals: { <addr>: [ual] }, revocations: { <grantId>: { id, ual, txHash, publisher, stateOf, stateAt } } }`.
  It is updated only after a consistent read, and entries are never removed.

## Named limits left open

Found in the final review of 0.2.0 and not fixed in it. Each is written here so that an
operator, a library caller or a later version does not rely on the opposite.

- **Spend across machines.** The grant lock, the key lease and local pending spend live in
  one `MANDATE_HOME` on one machine. Renders under one grant on several machines count
  against each other only once their derivations are anchored and read, so concurrent
  renders there can exceed a ceiling.
- **`--seconds` is taken as given** for a per-second or per-character estimate under a
  ceiling (see Renders). The recorded spend is unknown unless the platform reports a cost.
- **Consent matching.** Sounds-only refusals are not `contradicted` (see Spoken scope).
- **Upload text fallback.** When `get_upload` returns no structured URL, `getUpload` takes
  a single `agent.livepeer.org/a/` link from the reply text if the text says the upload
  arrived and nothing says it is waiting or did not arrive. Text such as "upload failed",
  "rejected" or "empty" beside such a link is not recognised as a failure. A structured URL
  on the host `agent.livepeer.org.` (trailing dot) is not recognised as the capture page.
  Either can only hash the wrong object: the transcript must still be a reading of the
  script, or be confirmed by a person.
- **`finishAttempt` for library callers.** `finishAttempt(key, { status: 'failed' })` with
  `mayHaveStarted` left out records the attempt without saying whether it was sent, which
  can drop a sent attempt from "may be billed". The CLI always passes a boolean.
- **No lease below the CLI.** The lease is taken by `render --execute` and `record --pending`,
  not by the store's own methods: a library caller that writes records for a key without
  `acquireLease` gets none of that protection, and `save` does
  not refuse to drop `derivationAttempt` or to move a `recorded` record to another status.
- **Hand-built states.** A state with tier `vm` but no string `publisher` is ignored by the
  gate and verifier rather than counted or treated as unattributed. `readKnowledge` never
  produces one.
- **Later vocabulary versions.** A trusted producer's record written only in a later vocabulary version's
  namespace (no `ns/v1` terms at all) is not recognised as a Mandate object, so its spend is
  not counted and its file is not judged. A record that keeps any v1 predicate is reported
  as a trusted `malformed` forgery instead.
