# Mandate

**A consent rail for generative media.** A producer running Mandate does not render
a likeness or voice until the depicted person's own agent has published a live grant
on the OriginTrail DKG. Revoking the grant stops that producer's next render, and lets
anyone holding a delivered file, and the ids of the graphs it was recorded in, check
whether it is still covered.

Built for the **Livepeer Agent Hackathon 2026**, Track 2: **Livepeer Agent + OriginTrail DKG**.

## Install

**0.2.0 is not on npm yet.** `npm install mandate-consent` currently installs 0.1.0,
which is superseded (below). Until `npm view mandate-consent version` prints `0.2.0`,
install from the repository:

```bash
npm install github:OoJae/mandate
```

> **0.1.0 is superseded.** An adversarial review found that its resolver decided
> authorship from self-declared values inside the graph, so anyone able to publish
> could invent a grant or un-revoke one. 0.2.0 attributes every grant, revocation
> and derivation to the address that anchored it on-chain. The attacks from that
> review are replayed as tests in [`test/adversarial.test.mjs`](test/adversarial.test.mjs)
> and the unit tests beside it, and the producer-side forgery was run live on Base
> Sepolia (below). A mutation check (`npm run test:mutation`, run in CI on pull
> requests) removes each listed security guard in turn and fails if no test notices.

---

## The problem

Generative media's real legal exposure is the **input**, not the output. An agent
that swaps someone's face into an ad, or lip-syncs their portrait to a script, bakes
that person into a durable artifact that can be copied anywhere.

Consent today is a contract in a shared drive. It is not machine-readable, not
checkable at render time, not revocable, and **it is held by the party doing the
rendering**. A renderer vouching for its own permission is worth nothing.

That last point drives the design. *The party who grants consent is never the party
who runs the render,* and a third party who trusts neither must be able to check.
A database controlled by either side cannot do that, which is why Mandate uses a
verifiable shared graph.

## What it does

An agent is asked to render a lip-synced spot of a person. Before it spends a cent,
it reads the DKG. A grant must cover:

- **that subject**, and be published by the address that subject belongs to
- **that exact Livepeer capability** (never a family: `face-swap-image` is not `face-swap-video`)
- **that use class**, with a forbid overriding a permit
- **that territory**
- **now**, inside the validity window, and **not revoked**
- **the spend**, within its ceiling, counting what trusted producers already recorded

For a producer running the gate: no grant, no render. A refusal names the clause and
costs nothing, because the capability is never invoked. Some declared use classes are
refused whatever a grant says: `adult`, `sexual`, `deceptive-impersonation` and their
common synonyms (the list is `PROHIBITED_USE_CLASSES` in
[`src/policy.mjs`](src/policy.mjs)). That is a check on the **label the producer
declares**, nothing more: it never looks at the prompt or the media, so a sexual render
labelled `advertising` is not caught by it.

After a render, the producer anchors a **derivation**: the output's SHA-256, the
capability that served it, the grant it was made under and the time it says it
rendered. The CLI releases the media URL only once that record is on-chain. A platform
that receives the file hashes it, finds the derivation, follows it to the grant, and
gets one of:

| Verdict | Meaning |
|---|---|
| `CLEAR` | every trusted producer's record for these bytes traces to a grant published by the subject's own address, not revoked, that permitted the serving capability, and whose validity window covers both now and the render time the producer recorded |
| `TAINTED / REVOKED` | the grant was revoked |
| `TAINTED / UNAUTHORISED` | no entitled publisher published the grant, the capability was not permitted, or the producer records the render after the grant ended |
| `TAINTED / MALFORMED` | the grant or a trusted producer's record for these bytes cannot be read, or the grant id is published more than once |
| `TAINTED / NOT_YET_VALID` | the grant's window had not started, now or at the recorded render time |
| `TAINTED / EXPIRED` | the render was recorded inside the window, but the grant has since lapsed. It does not mean consent was withdrawn; it means the grant no longer covers any use of the file. The in-window render time is the producer's own claim. |
| `UNKNOWN` | no trusted record for these bytes (not made through a Mandate gate, re-encoded, or recorded by a producer or in a graph this verifier does not read), or the grant it cites is kept in a grants graph this verifier does not read |
| `INCONCLUSIVE` | the read behind the answer was incomplete |

A file with several trusted records is TAINTED if any is, otherwise UNKNOWN if any is,
otherwise CLEAR.

**What CLEAR does not establish.** A derivation does not record the use class,
territory or spend, so CLEAR says nothing about **use class, territory, prohibited uses
or the spend ceiling**. Those are enforced only by the producer's gate at render time.

**The gate is opt-in.** It binds producers that choose to run it. A producer that calls
Livepeer directly is not stopped; its files verify `UNKNOWN`. That is why the check
belongs at distribution too: accept a file only if it verifies `CLEAR`.

## How authorship is established

Nothing in Mandate believes a value written inside the graph about who wrote it.

1. **Publisher, not claims.** Every Knowledge Asset lives in
   `did:dkg:context-graph:<cg>/_verifiable_memory/<address>/<n>`, and the chain binds
   that address to the asset's author. The resolver reads that path, checks the
   asset's `_meta` anchor (confirmed, the declared triple count, the transaction), and
   attributes the asset to it. `mandate:grantor` must agree with the publisher or the
   grant is reported as a forgery.
2. **Self-certifying subjects.** A subject is `0x<grantor address>:<name>`. Only that
   address can grant for it, and a revocation counts when that address anchored it, so
   nobody else can speak for Ana by writing her name. One exception fails the other
   way: a revocation that appears only in a node's merged view of the grants graph,
   with no Verifiable Memory copy from which to read its publisher, is honoured,
   because refusing is the safe side of not knowing.
3. **Revocation is terminal.** Any revocation anchored by the grant's publisher ends
   the grant for good, even when its other fields (time, author, value) are malformed;
   "active" has no effect. Renewal is a new grant.
4. **Knowledge Assets never merge.** Triples are grouped per asset, so one extra
   triple elsewhere cannot widen a grant, and a duplicated value makes an object
   malformed rather than picking one.
5. **Incomplete reads refuse.** DKG v10.0.16 sometimes leaves whole graphs out of a
   query result. Reads are merged across attempts and accepted only when complete by
   the node's own count and every anchor's declared size, and when every anchor seen
   before is still there. A failed, empty-after-errors, truncated or partial read
   refuses, and so does a discovery query that returns more rows than the limit (a
   stranger writing into an open graph can cause that: service is denied, a permit is
   never obtained).
6. **A node behind the chain refuses, when the check can run.** Before deciding, the
   CLI asks the node, through `POST /api/context-graph/reconcile`, how many assets the
   chain has bound to each graph and how many it holds. A node that is behind, ahead,
   or cannot answer refuses. The call needs the node's **admin** token; with a token
   that lacks admin rights (403) the check is skipped with a warning, and a node that
   is consistent but has not yet received a revocation can still permit. That is the
   revocation window (see Known limitations).

The rules, data shapes and exit codes are in [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Evidence

### Forgery from the producer's own node, live

[`spikes/s6c-forgery.mjs`](spikes/s6c-forgery.mjs), recorded in
[`docs/evidence/s6c-forgery.json`](docs/evidence/s6c-forgery.json). The grantor
granted G1 and G2 for subject `0xed1e…0b69:ana-s6c` and revoked G1, through the CLI.
The producer then anchored three forgeries straight through the DKG API, each naming
the grantor or its subject:

| | Claim | UAL |
|---|---|---|
| a | G1 is "active" again, `stateAuthor` = the grantor | `…0cb5/3` |
| b | a grant naming the grantor, permitting `face-swap-video`, $1000 ceiling | `…0cb5/4` |
| c | a grant naming the producer as grantor, permitting `face-swap-video` | `…0cb5/6` |

Resolved on all three nodes, the producer's, the grantor's and the read-only verifier's,
on 14 Sep (the recorded read in [`docs/evidence/s6c-forgery.txt`](docs/evidence/s6c-forgery.txt)):

```
talking-head     PERMITTED under G2 only
face-swap-video  REFUSED — capability-permitted
G1 revoked       yes
forgery legacy-format    trusted 0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/1  tx 0x8d980314…91a1b581
forgery misplaced-state  trusted 0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/3  tx 0xaedeab9c…deebd0
forgery misplaced-grant  trusted 0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/4
forgery misplaced-grant  trusted 0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/6  tx 0x56411263…a943e0d
```

The three forgeries are rejected on every node. The fourth record, `…0cb5/1`, is the
producer's own derivation from the 0.1.0 runs, whose id is in the old format. A trusted
producer's record that cannot be read is reported (`legacy-format`) rather than
ignored.

The producer's node could not anchor (a) or (c) into the grantor's graph: it sealed
them, then every share failed. The likely reason is that a peer holds only a stub of
another party's graph (see S6c in `docs/SPIKES.md`). They went into the producer's own graph, where grants and states are never
accepted. `test/adversarial.test.mjs` covers the same forgeries inside the grants
graph; that path was not exercised live.

### End to end

[`demo/full.mjs`](demo/full.mjs) runs the whole product through the CLI: phone consent,
grant, a refused capability, a gated `render --execute`, its derivation, `verify`
CLEAR on the independent node, revoke, the producer refusing, `verify` TAINTED, and
the blast radius. Each run is written to `demo/runs/<timestamp>/` (git-ignored), with
transcripts reduced to a length and hash and every URL except block-explorer links
replaced by a hash.

**No run of it has been committed yet.** Until one is, the gated render, its
derivation and phone consent capture are tested only against recorded platform
responses, and no 0.2.0 end-to-end run is claimed here.

Runs recorded with 0.1.0 are kept in [`docs/evidence/v0.1.0/`](docs/evidence/v0.1.0/).

### On-chain (Base Sepolia, chain `base:84532`)

| What | UAL | Transaction |
|---|---|---|
| grant G1 (`ana-s6c`) | `did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/27` | [`0xaedb52c8…6e44fd2`](https://sepolia.basescan.org/tx/0xaedb52c832d7dcf5830cba8464d926f1f23dd1621224b7327156ec7816e44fd2) |
| grant G2 (`ana-s6c`), valid until 2026-12-12 | `…0b69/28` | [`0xf1bd5875…fa4b34`](https://sepolia.basescan.org/tx/0xf1bd587515aa5b22ddf5c534b6f58ad52153f104a5f5522a81ab703719fa4b34) |
| revocation of G1 | `…0b69/29` | [`0x61636412…c74d39`](https://sepolia.basescan.org/tx/0x616364129dd87e6d8dfedbe165832b2f5ed4d04d3d6dd4d0c31e48e492c74d39) |
| forgery (a) | `did:dkg:base:84532/0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5/3` | [`0xaedeab9c…deebd0`](https://sepolia.basescan.org/tx/0xaedeab9cf4456c117d851c4fa52e7eb6de2af8bd60bab5f8ef7b013720deebd0) |
| forgery (b) | `…0cb5/4` | [`0xd18895bd…aa3adf`](https://sepolia.basescan.org/tx/0xd18895bdec0f1af1a250db71722a31541f2888f7eb9b97cb118db4f6f6aa3adf) |
| forgery (c) | `…0cb5/6` | [`0x56411263…a943e0d`](https://sepolia.basescan.org/tx/0x564112634c5fa49e654c379f80ab339d5e0cdb97c3715760d57492c61a943e0d) |
| ontology 1.1.0 | `…0b69/30` | [`0x824da77b…9bad9b`](https://sepolia.basescan.org/tx/0x824da77be0835b10efe070d0322e7250447132b173197f25202dd832ee9bad9b) |
| ontology 1.0.0 (superseded) | `…0b69/26` | [`0x94ba6ea1…5f1dbaa`](https://sepolia.basescan.org/tx/0x94ba6ea19e437c7afefbe920052a9069a1810554145c637bcad173a0f5f1dbaa) |

Grants and revocations are in context graph `0xeD1e…0B69/mandate-grants` (on-chain
430), derivations in `0x8EaA…0CB5/mandate-derivations` (431).

## What works, what is partial, what is planned

| | Status |
|---|---|
| Provenance resolver, gate, verifier (pure functions; the attacks from the adversarial review are replayed as tests, and CI's mutation check fails when a listed guard can be removed unnoticed) | working |
| Grant, revoke and derivation writes, reported only once anchored | working, live |
| Forgery rejection from the producer's own node | working, live; recorded on the grantor's and producer's nodes, observed but not recorded on the verifier |
| Read-only verifier node with no funded wallet | working, live |
| Stale-node refusal (chain head vs local copy) | working, live |
| `render --execute`: inline or polled, media released only after its derivation anchors, pending-render recovery | built and tested with recorded platform responses; live run pending |
| Consent capture on a phone, transcription, spoken-scope check | built and tested with recorded responses; live run pending |
| Directory of producers' derivation graphs, so a verifier can discover them | planned |
| A grant naming which producers may render under it | planned |
| Derivation UAL carried in C2PA or XMP metadata | planned |
| A Livepeer-side pre-flight: `run_capability` refusing a likeness capability unless given a `consent_ual` that resolves to a live grant | planned (needs Livepeer; the gate cannot bind producers that skip it from outside) |
| A perceptual hint for re-encoded copies, which can only raise suspicion (point a reviewer at a likely original), never clear a file | planned |

## Use it

### The core: no dependencies

The gate, resolver, verifier, vocabulary, RDF writers and the DKG HTTP client run with
**no npm packages installed**. CI installs the packed tarball with `--omit=peer` to
check it.

```js
import { readKnowledge, decide, verifyKnowledge, fileStateStore } from 'mandate-consent'
import { DkgNode } from 'mandate-consent/dkg'

const node = new DkgNode({ port: 9202, home: '~/.dkg-mandate-producer' })
const cfg = {
  grantsCgs: ['0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'],
  derivationsCgs: ['0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5/mandate-derivations'],
  stateStore: fileStateStore(),
  checkFreshness: true,
}
const subject = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69:ana-s6c'
const k = await readKnowledge(node, cfg, { subject })
const d = decide({ subject, capability: 'talking-head', useClass: 'advertising',
  territory: 'GB', at: new Date().toISOString(), estimatedUsd: 0.84 }, k)
if (!d.permit) throw new Error(`refused: ${d.clause} — ${d.reason}`)
```

The demo grant G2 is valid until **2026-12-12**; after that this refuses at
`validity-window`. Pass an earlier `at` to reproduce the documented decision.

| Import | What | Needs |
|---|---|---|
| `mandate-consent` | gate, resolver, verifier, vocabulary, RDF | nothing |
| `mandate-consent/dkg` | DKG v10 node client over its HTTP API | a running node |
| `mandate-consent/livepeer` | Livepeer Agent MCP client | `@modelcontextprotocol/sdk` (optional peer) |
| `mandate-consent/consent` | consent capture through a phone link | `@modelcontextprotocol/sdk` (optional peer) |

### Try it without funding anything

A read-only node can read the demo's public graphs and run every check. It never
publishes, so it needs no wallet funds.

```bash
git clone https://github.com/OoJae/mandate && cd mandate && npm install
npm test && npm run smoke:pack                  # no network needed

cp .env.example .env    # then set the two graph ids to the read-only ones listed in it
node scripts/nodes.mjs up verifier              # first boot takes ~2 min; catching up took ~10
node scripts/nodes.mjs doctor verifier          # subscribed, and current with the chain

# Resolve the forgery subject on your own node: PERMITTED under G2, with the rejected
# records listed. G2 is valid until 2026-12-12; after that add --at 2026-10-01T00:00:00Z.
MANDATE_PRODUCER_PORT=9203 MANDATE_PRODUCER_HOME=~/.dkg-mandate-verifier \
  node bin/mandate.mjs render --subject 0xed1eeb64cac09874257f05fd6b51a55695ad0b69:ana-s6c \
  --capability talking-head --use-class advertising --territory GB --seconds 5

# Verify a file by its hash: the 0.1.0 render, whose only trusted record is in the
# old id format, so it cannot be read and verifies TAINTED / MALFORMED.
node bin/mandate.mjs verify --sha256 48a2c16d22920ce5ab051987c435bf5517e80bb7c1f50eb4b1b2e98efdbd9b88
```

`render` without `--execute` never dispatches anything, and reads only. `--at` decides
as of another time and is refused together with `--execute`.

### Run both parties

Requires Node ≥ 22.13, and on the grantor's and producer's wallets **Base Sepolia ETH**
for gas (a publish cost about 0.000005 ETH) and **testnet TRAC**: registering a context
graph needs gas and a TRAC deposit (or a Publishing Conviction Account waiver), and
publishing uses TRAC. `scripts/nodes.mjs init` does not request faucet funds the way the
interactive `dkg init --network testnet` does, so fund the wallets yourself.

```bash
cp .env.example .env
# 1. Start the nodes. Graph ids do not exist yet, so `up` stops after starting them.
node scripts/nodes.mjs up grantor producer verifier

# 2. Fund the grantor and producer: this lists each node's wallet addresses and balances.
DKG_HOME=~/.dkg-mandate-grantor  npx dkg wallet
DKG_HOME=~/.dkg-mandate-producer npx dkg wallet

# 3. One context graph per party, created and registered on-chain from its own node.
#    `create` prefixes the id with that node's agent address.
DKG_HOME=~/.dkg-mandate-grantor  npx dkg context-graph create mandate-grants
DKG_HOME=~/.dkg-mandate-grantor  npx dkg context-graph register 0x<grantor>/mandate-grants --publish-policy 1
DKG_HOME=~/.dkg-mandate-producer npx dkg context-graph create mandate-derivations
DKG_HOME=~/.dkg-mandate-producer npx dkg context-graph register 0x<producer>/mandate-derivations --publish-policy 1

# 4. Put both ids in .env (MANDATE_GRANTS_CG, MANDATE_DERIVATIONS_CG), then:
node scripts/nodes.mjs subscribe && node scripts/nodes.mjs connect && node scripts/nodes.mjs sync
node scripts/nodes.mjs doctor

node bin/mandate.mjs status
node bin/mandate.mjs grant  --subject ana --capability sync-lipsync-v3 --use-class advertising --territory GB --max-spend 5 [--with-consent]
node bin/mandate.mjs render --subject 0x<grantor>:ana --capability sync-lipsync-v3 --use-class advertising --territory GB --seconds 5 \
  [--execute --image-url <url> --audio-url <url>]
node bin/mandate.mjs verify --url <delivered file>
node bin/mandate.mjs revoke --id <grant id>
node bin/mandate.mjs blast-radius --grant <grant id>
node bin/mandate.mjs record                      # renders whose derivation did not commit
```

Once installed as a package, the same commands are `npx mandate …`. `mandate help
[command]`, `--help` or `-h` on any command lists its flags, and `--json` prints one
result object. The resolver does not rely on the graphs' publish policy: open graphs
are safe to read.

`MANDATE_GRANTS_CG` and `MANDATE_DERIVATIONS_CG` each accept a comma-separated list.
Readers read every listed graph; `grant` and `revoke` publish to the one grants graph
namespaced under the grantor node's address, and derivations go to the one derivations
graph under the producer's address (none or several is a configuration error). A reader
configured with several grants graphs can verify files made under other grantors'
grants; an edge citing a grant whose owner has no configured grants graph verifies
`UNKNOWN`.

**Subject names are published.** `grant --subject ana` publishes `0x<grantor>:ana`
permanently. Use a pseudonym that means nothing outside the relationship, and remember
that the grantor address links every subject it has granted for.

#### Consent capture

`grant --with-consent` must run at a terminal, because a person has to confirm the clip;
off a terminal it exits 3 before any link is requested. The CLI mints a phone link,
waits for the clip, transcribes it, and checks the words:

- The clip needs an **affirmative first-person consent** ("I consent", "I agree",
  "I give permission", "we authorise", "I'm happy for"). Questions, conditionals and
  reported speech are not consent. Without it: exit 3, and `--force` does not help.
- A refusal or exclusion ("no", "not for", "except", "apart from", "I withdraw") is a
  contradiction: exit 8, never overridable. A negation contradicts every term in its
  clause, so "I agree to a talking head for advertising, not for political use" is
  refused as a whole. The check errs towards refusing; re-record in plain, separate
  sentences.
- Requested capabilities, use classes and territories that were not said: exit 3.
  `--force` publishes anyway, but the grant then carries **no clip hash**, so on the
  graph a clip hash always means the words were checked.
- A failed transcription is exit 3; `--force` never overrides it.

The words are never compared with the **validity date**, the **spend ceiling**, or an
**unrestricted territory**. After the check, the operator types `matches` to confirm the
transcript, then the end date (`YYYY-MM-DD`), the ceiling amount or `none`, and
`anywhere` for an unrestricted territory. Neither `--yes` nor `--force` skips this;
`--yes` skips only the final "publish" confirmation.

#### Exit codes

| Exit | Meaning |
|---|---|
| 0 | success, permitted, CLEAR; `help` and `--version` |
| 1 | usage or configuration error (a bad flag, a missing or malformed `MANDATE_*` graph id, no graph under the node's own address) |
| 2 | refused by the gate; TAINTED or UNKNOWN |
| 3 | consent not confirmed: transcription failed, no first-person consent, terms missing, or the typed consent confirmation not given or not possible |
| 4 | rendered, but its derivation failed to commit (run `mandate record --pending <key>`) |
| 5 | render failed, or a rerun found the render already submitted or rendered |
| 6 | DKG write failed before anchoring |
| 7 | DKG anchor not confirmed: minted but unbound, unknown after send, or an earlier asset the node would not let a retry resume |
| 8 | consent contradicted; never overridable |
| 9 | INCONCLUSIVE: node unreachable, stale or read incomplete; a media download, node token or `~/.mandate` state file that could not be read; a Livepeer failure that is not about credentials; a render whose outcome is unknown |
| 10 | Livepeer payment or credential problem |

## How Livepeer Agent is used

| Tool | What Mandate does with it |
|---|---|
| `run_capability` on `/api/mcp/raw` | Every gated render. The raw surface **never substitutes models**, so a render cannot be routed to a sibling model nobody consented to; if the platform reports another capability served it, that is what the derivation records. Inline (`async:false`, 280 s budget, under Node's 300 s stream limit) unless `describe_capability` reports a p95 over 200 s. |
| `get_create_media` | Polls background jobs to a result, never treating one of the render's own inputs as its output; `mandate record --pending` uses it to finish a render after a crash. |
| `describe_capability` | Reads the p95 latency that chooses inline or background. Most gated capabilities report none, or a static figure, so they run inline. |
| `get_pricing` | The list price behind an estimate, labelled as live, or as Livepeer's static fallback when the platform says so; a local static table is used when it cannot be read. An unknown price under a ceiling refuses. |
| `spend_cap` | Read only: a render whose estimate is over the account's remaining 24 h budget is not dispatched. When the budget cannot be evaluated (no numeric `remaining_usd`, an unknown estimate, a failed read) the render still goes ahead and the result says the budget was not checked. Mandate never changes the cap. |
| `request_upload`, `get_upload` | A 30-minute link the depicted person opens on their own phone to record consent. No API key needed. |
| `nemotron-asr` (via `run_capability`) | Transcribes the clip, so the spoken words are checked against the grant's clauses. |

Every call above is keyless on the demo tier. Each render carries an idempotency key
derived from the grant and inputs, so that a retried request returns the first result
instead of billing again; that replay is Livepeer's behaviour, and Mandate has not yet
exercised it live. A render whose request timed out on the client with no job id may
still be rendering: it is saved as `submitted`, and rerunning the same command recovers
it under the same key. A rerun never dispatches again a render already submitted with a
job id, rendered, or recorded.

Recorded spend is the platform's reported cost when it gives one. Without one, a
per-second estimate is not recorded as spend (it scales with a number the operator
typed); `billedUsd` is left unknown, and later renders under a ceiling refuse. Renders
on this machine not yet recorded on the graph also count against the ceiling here.

## The vocabulary

Namespace **<https://oojae.github.io/mandate/ns/v1#>**, version **1.1.1** (comments
only since 1.1.0, so 1.1.0 stays the version anchored on the DKG). The namespace IRI
resolves to a spec page generated from the ontology, and each version has a copy at
`ns/v1/<version>/`. The site is served from the `main` branch, so a version's page
resolves only once that version is merged there.

- [`vocab/mandate.ttl`](vocab/mandate.ttl): 4 classes, 28 properties, each with a
  label, comment, domain and range. [`vocab/context.jsonld`](vocab/context.jsonld): a
  JSON-LD context.
- Version 1.1.0 is anchored in the DKG's system `ontology` graph (UALs above), so any
  DKG node can read it without trusting this repository's host. That publish was made
  from the grantor's node into a shared system graph the grantor does not own.
- DKG v10 has no revocation primitive, so Mandate defines one. The rule a resolver must
  follow is stated on `mandate:stateAuthor`: attribute by the anchoring address, never by
  that value. Version 1.0.0 stated it the other way round.

## Where the data lives (Track 2 requirement)

| Where | What | Who can see it |
|---|---|---|
| **This machine** | `.env`, DKG node API tokens and keys, `~/.mandate` (anchors and revocations seen, pending renders) | this machine |
| **Livepeer Agent and its providers** | the consent clip (uploaded through `request_upload`, transcribed by `nemotron-asr`), its transcript, reference images and audio, prompts, and the rendered output | Livepeer and the provider serving the call. Uploads and outputs sit at URLs anyone holding the link can fetch; retention follows Livepeer's policy. |
| **DKG Verifiable Memory (permanent, public)** | subject identifier (including the name you give it), DIDs, grant clauses, dates, ceiling, consent-clip SHA-256, output SHA-256, serving capability and model id when given, job id, billed amount | anyone who syncs the graph |

No faces, biometrics, media bytes or transcripts are published to the DKG. The subject
name is, verbatim. Each party writes only to a graph it owns: grants and revocations to
the grantor's, derivations to the producer's. The ontology is the exception: it was
published to the DKG's shared system `ontology` graph. Shared Working Memory did not
reach the other party for these graphs, so everything that matters is anchored in
Verifiable Memory.

Who runs the grantor node is a deployment choice: an agency, a union or a hosted consent
service holding the key on the person's behalf. The depicted person only opens a link
and records a clip.

**Mandate does not do biometric identification.** Livepeer has no face-embedding
capability, and a "stable, non-invertible hash of a face" contradicts itself: hashing
destroys the distances face matching depends on. The subject is **declared**, and the
consent clip is evidence bound to the grant by SHA-256.

## Known limitations

- **The gate is opt-in.** It binds producers that run it. Enforcement has to happen where
  files are accepted, or inside Livepeer's own dispatch (planned above as a `consent_ual`
  pre-flight), which Mandate cannot add from outside.
- **CLEAR is narrower than the gate.** It does not check use class, territory,
  prohibited uses or the spend ceiling; derivations do not record them.
- **The deny list checks declared labels.** A producer that labels a sexual or
  impersonating render as something else is not caught by it.
- **Verification matches exact bytes.** Any re-encode, trim or recompression gives a new
  hash and verifies `UNKNOWN`, and `blast-radius` lists exact bytes only: re-encoded
  copies of a file made under a revoked grant are not on its list. It is meant for the
  delivery or intake hop, and complements embedded provenance such as C2PA rather than
  replacing it.
- **A verifier has to know which graphs to read, and whose derivations to trust.** Both
  are configuration (`MANDATE_GRANTS_CG`, `MANDATE_DERIVATIONS_CG`,
  `MANDATE_TRUSTED_PRODUCERS`). A producer outside that list verifies `UNKNOWN`.
- **A grant does not yet name its producers.** A trusted producer can record a render
  under any live grant that permits the capability. The producer also chooses which
  subject a request is for; nothing checks the reference image is the subject's face.
- **Everything linked to a subject is public and permanent.** Output hashes, capabilities,
  dates and costs can be tied to a subject and never erased. A pseudonym still links
  every output under it, and the grantor address links every pseudonym it grants for.
- **Revocation is not instant.** Other nodes refuse once they have synced the revocation's
  anchor. A publish took 82–109 s end to end in the S6c run. A node that stops syncing
  refuses once the chain shows it is behind, but only when the freshness check can run:
  it calls `reconcile` with the node's admin token before every decision, and without
  admin rights it only warns.
- **A verdict about a render does not say when it happened relative to a revocation.**
  A render made lawfully and revoked later, and one recorded after the revocation, both
  verify `TAINTED / REVOKED`.
- **The spend ceiling is enforced by the producer's gate**, from the platform's reported
  cost or list-price estimates and trusted producers' records in the derivations graphs
  it reads. It is advisory, not a platform limit, and estimates are not invoices; failed
  renders can still be billed by the provider.
- **Every render costs a DKG publish as well.** Each derivation is its own anchored
  Knowledge Asset, paid in gas and TRAC by the producer, on top of the Livepeer render.
- **Large graphs are read in pages**, up to `MANDATE_READ_MAX_ROWS` rows per publisher
  (default 250000, `MANDATE_READ_MAX` rows per page, default 5000); past that a read
  refuses rather than decide from part of it.
- **DKG v10.0.16 cannot publish a literal containing a double quote or a line break**,
  however it is escaped. Mandate refuses such values with an error naming the field.
- **Livepeer's background worker abandoned jobs at about 128 s** in three attempts
  (`runner_abandoned`). Renders run inline where they can for that reason.
- **All three nodes ran on one machine**, with separate homes and keys. The producer never
  holds the grantor's key, but they are not separate organisations.
- **The interface is a terminal.** There is no web UI.

## Beyond this repo

- **npm:** [`mandate-consent`](https://www.npmjs.com/package/mandate-consent). Only 0.1.0
  is published so far; see Install.
- **OriginTrail DKG integrations registry:** listing submitted as a draft,
  [OriginTrail/dkg-integrations#31](https://github.com/OriginTrail/dkg-integrations/pull/31).
  The draft still describes 0.1.0 until it is updated for this release.
- **Livepeer community skill:** [`skills/likeness-consent.md`](skills/likeness-consent.md)
  carries the consent norm for any Livepeer agent: explicit, current, scoped consent; no
  identifying people from their faces; refuse and say what is missing; honour withdrawal.
  **A skill asks an agent to behave; the gate is what stops the spend.** Publishing it
  needs a PymtHouse key (Livepeer Agent retired Daydream `sk_` keys in September 2026):
  `node scripts/publish-skill.mjs --publish`.

The investigation behind every number here is in [`docs/SPIKES.md`](docs/SPIKES.md), and
the internal contracts in [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Licence

Apache-2.0
