# Mandate

**A consent rail for generative media.** A producer running Mandate does not render
a likeness or voice until the depicted person's own agent has published a live grant
on the OriginTrail DKG. Revoking the grant stops that producer's next render, and lets
anyone holding a delivered file check whether it is still covered.

Built for the **Livepeer Agent Hackathon 2026**, Track 2: **Livepeer Agent + OriginTrail DKG**.

```bash
npm install mandate-consent
```

> **0.1.0 is superseded.** An adversarial review found that its resolver decided
> authorship from self-declared values inside the graph, so anyone able to publish
> could invent a grant or un-revoke one. 0.2.0 attributes every grant, revocation
> and derivation to the address that anchored it on-chain, and the attacks are
> replayed in [`test/adversarial.test.mjs`](test/adversarial.test.mjs) (all 17 fail
> against 0.1.0 and pass on 0.2.0) and live on Base Sepolia (below).

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

No grant, no render. A refusal names the clause and costs nothing, because the
capability is never invoked. Sexual content and deceptive impersonation are refused
whatever a grant says.

After a render, the producer anchors a **derivation**: the output's SHA-256, the
capability that served it, and the grant it was made under. The media URL is released
only once that record is on-chain. A platform that receives the file hashes it, finds
the derivation, follows it to the grant, and gets `CLEAR`, `TAINTED`, `UNKNOWN` or
`INCONCLUSIVE`.

The gate binds producers that choose to run it. A producer that calls Livepeer
directly is not stopped; its files verify `UNKNOWN`. That is why the check belongs at
distribution too: accept a file only if it verifies `CLEAR`.

## How authorship is established

Nothing in Mandate believes a value written inside the graph about who wrote it.

1. **Publisher, not claims.** Every Knowledge Asset lives in
   `did:dkg:context-graph:<cg>/_verifiable_memory/<address>/<n>`, and the chain binds
   that address to the asset's author. The resolver reads that path, checks the
   asset's `_meta` anchor (confirmed, the declared triple count, the transaction), and
   attributes the asset to it. `mandate:grantor` and `mandate:stateAuthor` must agree
   with the publisher or the object is reported as a forgery.
2. **Self-certifying subjects.** A subject is `0x<grantor address>:<name>`. Only that
   address can grant or revoke for it, so nobody else can speak for Ana by writing
   her name.
3. **Revocation is terminal.** Any revocation anchored by the grant's publisher ends
   the grant for good; "active" has no effect. Renewal is a new grant.
4. **Knowledge Assets never merge.** Triples are grouped per asset, so one extra
   triple elsewhere cannot widen a grant, and a duplicated value makes an object
   malformed rather than picking one.
5. **Incomplete reads refuse.** DKG v10.0.16 sometimes leaves whole graphs out of a
   query result. Reads are merged across attempts and accepted only when complete by
   the node's own count and every anchor's declared size, and when every anchor seen
   before is still there. Before deciding, the CLI also asks the node how many assets
   the chain has bound to each graph; a node that is behind refuses rather than
   deciding from a stale view.

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

Resolved independently on the grantor's node, the producer's node, and a third
read-only verifier node:

```
talking-head     PERMITTED under G2 only
face-swap-video  REFUSED — capability-permitted
G1 revoked       yes
forgery misplaced-state  0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/3  tx 0xaedeab9c…deebd0
forgery misplaced-grant  0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/4
forgery misplaced-grant  0x8eaa…0cb5  did:dkg:base:84532/0x8eaa…0cb5/6  tx 0x56411263…a943e0d
```

The producer's node could not anchor (a) or (c) into the grantor's graph: it sealed
them, then every share failed, because a peer holds only a stub of another party's
graph. They went into the producer's own graph, where grants and states are never
accepted. `test/adversarial.test.mjs` covers the same forgeries inside the grants
graph.

### End to end

[`demo/full.mjs`](demo/full.mjs) runs the whole product through the CLI: phone consent,
grant, a refused capability, a gated `render --execute`, its derivation, `verify`
CLEAR on the independent node, revoke, the producer refusing, `verify` TAINTED, and
the blast radius. Each run is written to `demo/runs/<timestamp>/`.

Runs recorded with 0.1.0 are kept in [`docs/evidence/v0.1.0/`](docs/evidence/v0.1.0/).

### On-chain (Base Sepolia, chain `base:84532`)

| What | UAL | Transaction |
|---|---|---|
| grant G1 (`ana-s6c`) | `did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/27` | [`0xaedb52c8…6e44fd2`](https://sepolia.basescan.org/tx/0xaedb52c832d7dcf5830cba8464d926f1f23dd1621224b7327156ec7816e44fd2) |
| grant G2 (`ana-s6c`) | `…0b69/28` | [`0xf1bd5875…fa4b34`](https://sepolia.basescan.org/tx/0xf1bd587515aa5b22ddf5c534b6f58ad52153f104a5f5522a81ab703719fa4b34) |
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
| Provenance resolver, gate, verifier (pure functions; the test suite replays every reported attack) | working |
| Grant, revoke and derivation writes, reported only once anchored | working, live |
| Forgery rejection on three independent nodes | working, live |
| Read-only verifier node with no funded wallet | working, live |
| Stale-node refusal (chain head vs local copy) | working, live |
| `render --execute`: inline or polled, media released only after its derivation anchors, pending-render recovery | built and tested with recorded platform responses; live run in `demo/full.mjs` |
| Consent capture on a phone, transcription, spoken-scope check | built and tested with recorded responses; live capture in `demo/full.mjs --consent` |
| Directory of producers' derivation graphs, so a verifier can discover them | planned |
| A grant naming which producers may render under it | planned |
| Derivation UAL carried in C2PA or XMP metadata | planned |

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
  grantsCg: '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants',
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

# Resolve the forgery subject on your own node: PERMITTED under G2, three forgeries reported.
MANDATE_PRODUCER_PORT=9203 MANDATE_PRODUCER_HOME=~/.dkg-mandate-verifier \
  node bin/mandate.mjs render --subject 0xed1eeb64cac09874257f05fd6b51a55695ad0b69:ana-s6c \
  --capability talking-head --use-class advertising --territory GB --seconds 5
```

`render` without `--execute` never dispatches anything, and reads only.

### Run both parties

Requires Node ≥ 22.13 and Base Sepolia ETH on the grantor's and producer's wallets
(a publish costs about 0.000005 ETH).

```bash
cp .env.example .env
node scripts/nodes.mjs up grantor producer verifier

# One context graph per party, created and registered on-chain from its own node.
# `create` prefixes the id with that node's agent address; put both ids in .env.
DKG_HOME=~/.dkg-mandate-grantor  npx dkg context-graph create mandate-grants
DKG_HOME=~/.dkg-mandate-grantor  npx dkg context-graph register 0x<grantor>/mandate-grants --publish-policy 1
DKG_HOME=~/.dkg-mandate-producer npx dkg context-graph create mandate-derivations
DKG_HOME=~/.dkg-mandate-producer npx dkg context-graph register 0x<producer>/mandate-derivations --publish-policy 1
node scripts/nodes.mjs subscribe && node scripts/nodes.mjs sync

node bin/mandate.mjs status
node bin/mandate.mjs grant  --subject ana --capability sync-lipsync-v3 --use-class advertising --territory GB --max-spend 5 [--with-consent]
node bin/mandate.mjs render --subject 0x<grantor>:ana --capability sync-lipsync-v3 --use-class advertising --territory GB --seconds 5 \
  [--execute --image-url <url> --audio-url <url>]
node bin/mandate.mjs verify --url <delivered file>
node bin/mandate.mjs revoke --id <grant id>
node bin/mandate.mjs blast-radius --grant <grant id>
node bin/mandate.mjs record                      # renders whose derivation did not commit
```

Installed from npm, the same commands are `npx mandate …`. `--help` on any command lists
its flags, and `--json` prints one result object. The resolver does not rely on the graphs'
publish policy: open graphs are safe to read.

| Exit | Meaning |
|---|---|
| 0 | success, permitted, CLEAR |
| 1 | usage error |
| 2 | refused by the gate; TAINTED or UNKNOWN |
| 3 | consent not confirmed (transcription failed, or terms missing) |
| 4 | rendered, but its derivation failed to commit (run `mandate record`) |
| 5 | render failed |
| 6 | DKG write failed before anchoring |
| 7 | DKG anchor not confirmed (minted but unbound, or unknown after send) |
| 8 | consent contradicted; never overridable |
| 9 | node unreachable, stale, or read incomplete (INCONCLUSIVE) |
| 10 | Livepeer payment or credential problem |

## How Livepeer Agent is used

| Tool | What Mandate does with it |
|---|---|
| `run_capability` on `/api/mcp/raw` | Every gated render. The raw surface **never substitutes models**, so a render cannot be routed to a sibling model nobody consented to. Inline (`async:false`, 280 s budget, under Node's 300 s stream limit) unless the capability's measured p95 is over 200 s. |
| `get_create_media` | Polls background jobs to a result; `mandate record` uses it to finish a render after a crash. |
| `describe_capability` | Reads the measured p95 that chooses inline or background. |
| `get_pricing` | The live list price behind every estimate; an unknown price under a ceiling refuses. |
| `spend_cap` | Read only: a render over the account's remaining 24 h budget is not dispatched. Mandate never changes the cap. |
| `request_upload`, `get_upload` | A 30-minute link the depicted person opens on their own phone to record consent. No API key needed. |
| `nemotron-asr` (via `run_capability`) | Transcribes the clip, so the spoken words are checked against the grant's clauses. |

Every call above is keyless on the demo tier. Idempotency keys derived from the grant and
inputs mean a retried render returns the first result instead of billing again.

## The vocabulary

Namespace **<https://oojae.github.io/mandate/ns/v1#>**, version **1.1.0**. The
namespace IRI resolves to a spec page generated from the ontology, and each version
has a fixed copy at `ns/v1/<version>/`.

- [`vocab/mandate.ttl`](vocab/mandate.ttl): 4 classes, 28 properties, each with a
  label, comment, domain and range. [`vocab/context.jsonld`](vocab/context.jsonld): a
  JSON-LD context.
- Anchored in the DKG's system `ontology` graph (UALs above), so any DKG node can read
  it without trusting this repository's host.
- DKG v10 has no revocation primitive, so Mandate defines one. The rule a resolver must
  follow is stated on `mandate:stateAuthor`: attribute by the anchoring address, never by
  that value. Version 1.0.0 stated it the other way round.

## Where the data lives (Track 2 requirement)

| Where | What | Who can see it |
|---|---|---|
| **This machine** | `.env`, DKG node API tokens and keys, `~/.mandate` (anchors seen, pending renders) | this machine |
| **Livepeer Agent and its providers** | the consent clip (uploaded through `request_upload`, transcribed by `nemotron-asr`), its transcript, reference images and audio, prompts, and the rendered output | Livepeer and the provider serving the call. Uploads and outputs sit at URLs anyone holding the link can fetch; retention follows Livepeer's policy. |
| **DKG Verifiable Memory (permanent, public)** | subject identifier, DIDs, grant clauses, dates, ceiling, consent-clip SHA-256, output SHA-256, serving capability, job id, cost estimate | anyone who syncs the graph |

No faces, biometrics, media bytes, transcripts or real names are published to the DKG.
Each party writes only to a graph it owns: grants and revocations to the grantor's,
derivations to the producer's. Shared Working Memory did not reach the other party for
these graphs, so everything that matters is anchored in Verifiable Memory.

Who runs the grantor node is a deployment choice: an agency, a union or a hosted consent
service holding the key on the person's behalf. The depicted person only opens a link
and records a clip.

**Mandate does not do biometric identification.** Livepeer has no face-embedding
capability, and a "stable, non-invertible hash of a face" contradicts itself: hashing
destroys the distances face matching depends on. The subject is **declared**, and the
consent clip is evidence bound to the grant by SHA-256.

## Known limitations

- **The gate is opt-in.** It binds producers that run it. Enforcement has to happen where
  files are accepted, or inside Livepeer's own dispatch, which Mandate cannot add from
  outside.
- **Verification matches exact bytes.** Any re-encode, trim or recompression gives a new
  hash and verifies `UNKNOWN`. It is meant for the delivery or intake hop, and complements
  embedded provenance such as C2PA rather than replacing it.
- **A verifier has to know which graphs to read, and whose derivations to trust.** Both
  are configuration (`MANDATE_DERIVATIONS_CG`, `MANDATE_TRUSTED_PRODUCERS`). A producer
  outside that list verifies `UNKNOWN`.
- **A grant does not yet name its producers.** A trusted producer can record a render
  under any live grant that permits the capability. The producer also chooses which
  subject a request is for; nothing checks the reference image is the subject's face.
- **Everything linked to a subject is public and permanent.** Output hashes, capabilities,
  dates and costs can be tied to a subject and never erased. Use a subject name that means
  nothing outside the relationship.
- **Revocation is not instant.** Other nodes refuse once they have synced the revocation's
  anchor. A publish took 82–109 s end to end in the S6c run. A node that stops syncing
  now refuses once the chain shows it is behind, but only when the freshness check can run
  (it needs the node's admin token).
- **The spend ceiling is enforced by the producer's gate**, from list-price estimates and
  trusted producers' records. It is advisory, not a platform limit, and estimates are not
  invoices; failed renders can still be billed by the provider.
- **DKG v10.0.16 cannot publish a literal containing a double quote or a line break**,
  however it is escaped. Mandate refuses such values with an error naming the field.
- **Livepeer's background worker abandoned jobs at about 128 s** in three attempts
  (`runner_abandoned`). Renders run inline where they can for that reason.
- **All three nodes ran on one machine**, with separate homes and keys. The producer never
  holds the grantor's key, but they are not separate organisations.

## Beyond this repo

- **npm:** [`mandate-consent`](https://www.npmjs.com/package/mandate-consent).
- **OriginTrail DKG integrations registry:** listing submitted as a draft,
  [OriginTrail/dkg-integrations#31](https://github.com/OriginTrail/dkg-integrations/pull/31).
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
