# Mandate

**A consent rail for generative media.** No likeness or voice renders until the
depicted person's own agent has published a live, signed grant. Revoking it stops
the next render and lets anyone check whether a file already made is still clean.

Built for the **Livepeer Agent Hackathon 2026**, Track 2: **Livepeer Agent + OriginTrail DKG**.

```bash
npm install mandate-consent
```

---

## The problem

Generative media's real legal exposure is the **input**, not the output. An agent
that fine-tunes on someone's photos, or swaps their face into an ad, bakes that
person into a durable artifact that can be copied anywhere.

Consent today is a contract in a shared drive. It is not machine-readable, not
checkable at render time, not revocable, and **it is held by the party doing the
rendering**. A renderer vouching for its own permission is worth nothing.

That last point drives the whole design. *The party who grants consent is never
the party who runs the render.* A local database cannot work under that
condition, which is why Mandate uses a verifiable shared graph instead of a table
in someone's Postgres.

## What it does

An agent is asked to render a talking-head spot of a person. Before it spends a
cent, it looks up a grant on the OriginTrail DKG. The grant must cover:

- **that subject**
- **that exact Livepeer capability**
- **that use class**
- **that territory**
- **the current date**, and must **not be revoked**
- **the spend**, within its ceiling

No grant, no render. The refusal names the missing clause and the exact spend avoided.

The verifiable knowledge here produces a **refusal**, not an improvement. Delete the
DKG and you do not get a worse product. You get a render tool with a consent
checkbox, which is nothing.

## Why the graph has to be verifiable

Three properties a vendor database cannot provide:

1. **The permission is written by a party who will never run the render.**
   - `wm/finalize` returns an EIP-712 AuthorAttestation proving the grantor's
     address sealed the grant.
   - We tested the reverse: the producer's node **refuses** to seal on the
     grantor's behalf, with `authorAgentAddress … is not a registered local agent
     on this node`.
   - The node enforces authorship; it is not just our claim.
2. **Only the grantor can revoke, even though the graph is append-only.**
   - The DKG has no delete. A "revoked" and an "active" assertion coexist
     forever, and anyone can write either.
   - Mandate counts a state assertion **only when its author is the grantor named
     in the grant**. Without that one check, the producer writes its own "not
     revoked" and wins.
3. **Anyone can check a delivered file** without asking either party. They hash
   the bytes, follow the graph, and reach the same verdict.

## Demo

Every block below came from the **live Livepeer Agent API**, **two DKG v10 nodes**,
and **Base Sepolia**. The repo has no mock mode. Raw logs are in [`demo/`](demo/)
and the full investigation is in [`docs/SPIKES.md`](docs/SPIKES.md).

### Two parties, two nodes, one chain

Run end to end from the **producer's own node**, with nothing stubbed
([`demo/e2e.mjs`](demo/e2e.mjs)):

```
[ +71s] grant UAL:  did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/12
[ +71s] grant tx:   0x69b9a2ded0a6f604fa4bd94769daf3aae347ea50cc6b9f131cf50f842c49a738
[ +74s] producer, own node, after grant:  PERMITTED under urn:mandate:grant:dana-5i66
[+148s] revoke UAL: did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/13
[+152s] producer, own node, after revoke: REFUSED — clause: not-revoked
```

The producer never contacts the grantor. It learns about the revocation from the graph.

### A real render, before and after revocation

A `sync-lipsync-v3` video that Livepeer actually rendered
([`demo/media-verify.mjs`](demo/media-verify.mjs)):

```
grant UAL         did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/15
derivation        authored and anchored by the PRODUCER, in its own graph
derivation UAL    did:dkg:base:84532/0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5/1
file sha256       48a2c16d22920ce5ab051987c435bf5517e80bb7c1f50eb4b1b2e98efdbd9b88

verify            CLEAR   — authorised by did:dkg:agent:0xeD1e…0B69 under urn:mandate:grant:eve-e3wr
revoke UAL        did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/16
verify            TAINTED — the grant authorising this file was revoked … by did:dkg:agent:0xeD1e…0B69
file unchanged    yes
```

The bytes did not change between the two verdicts. The verdict changed because
someone else changed their mind, on a graph that neither the producer nor the
verifier controls.

### The forgery

```
⚠ ignored 1 state assertion(s) not authored by the grantor:
    "active" claimed by did:dkg:agent:0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5

REFUSED — clause: not-revoked
spend avoided: $1.0080 (exact — the capability was never invoked)
```

The discarded assertion is a genuine sealed Knowledge Asset. Its timestamp is
deliberately **newer** than the revocation, so a resolver that trusted the newest
assertion would have allowed the render.

## Use it

### The core: zero dependencies

The gate, the vocabulary, Turtle serialisation, verification, blast radius and
reconciliation all run with **no npm packages installed**. The CI smoke test
installs the published tarball with `--omit=peer` to prove it. Drop it into any
render pipeline:

```js
import { decide, verifyKnowledge } from 'mandate-consent'

const d = decide(
  { subject: 'ana-7f3c', capability: 'talking-head', useClass: 'advertising',
    territory: 'GB', at: new Date().toISOString(), estimatedUsd: 1.008 },
  { grants, assertions, priorSpendUsd },          // whatever your graph returned
)
if (!d.permit) throw new Error(`refused: ${d.clause} — ${d.reason}`)
```

The adapters that talk to real services are separate subpaths, each with an
**optional peer**:

| Import | What | Peer |
|---|---|---|
| `mandate-consent` | gate, vocabulary, verify, RDF | none |
| `mandate-consent/dkg` | DKG v10 node client (public CLI and HTTP API only) | `@origintrail-official/dkg` |
| `mandate-consent/livepeer` | Livepeer Agent MCP client | `@modelcontextprotocol/sdk` |
| `mandate-consent/consent` | consent capture through a phone link | `@modelcontextprotocol/sdk` |

### The CLI

Requires Node ≥ 22.13 and two DKG v10 nodes, one per party. Docker is not needed.

```bash
npm install mandate-consent @origintrail-official/dkg @modelcontextprotocol/sdk
cp node_modules/mandate-consent/.env.example .env     # or set the variables yourself

npx mandate status                                    # two nodes, two distinct agent DIDs
npx mandate grant  --subject ana-7f3c --capability talking-head   # runs on the grantor's node
npx mandate render --subject ana-7f3c --capability talking-head   # decides; add --execute to spend
npx mandate revoke --id urn:mandate:grant:ana-7f3c
npx mandate verify --url https://…/delivered.mp4
```

To work on the repo itself: `npm install`, then `npm test` (36 tests, no network
needed), then `npm run smoke:pack`.

## The vocabulary

Namespace: **<https://oojae.github.io/mandate/ns/v1#>**. The IRI resolves to a
spec page generated from the ontology.

- [`vocab/mandate.ttl`](vocab/mandate.ttl) is the ontology: 4 classes and 28
  properties, each with a label, comment, domain and range.
- [`vocab/context.jsonld`](vocab/context.jsonld) is a JSON-LD context.
- **The ontology is itself published on the DKG, in the system Ontology Registry.**
  - UAL `did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/26`
  - tx `0x94ba6ea19e437c7afefbe920052a9069a1810554145c637bcad173a0f5f1dbaa`
  - Any DKG node can query it.

DKG v10 has no Knowledge Asset revocation primitive, so Mandate defines one.
`mandate:stateAuthor` states the rule normatively: a resolver **must** ignore any
state assertion not written by the grant's grantor.

## How Livepeer Agent is used

Livepeer carries weight here. It is not a swappable image API.

- **`run_capability` on `/api/mcp/raw`.** Every gated render goes through the raw
  surface *because it never substitutes models*. The creative surface is
  documented to substitute. A gate the pipeline can route around, to a sibling
  model nobody cleared, is not a gate.
- **`request_upload`.** It mints a 30-minute link that opens on a phone, and it
  needs no API key. Consent becomes a step inside the conversation instead of an
  email chain.
- **`nemotron-asr`** transcribes the spoken consent clip. The words spoken are
  compared with the scope requested; the result is reported for a person to review,
  not decided automatically.
- **`describe_capability`, `get_cost_report`, `spend_cap`** supply capability
  metadata, spend reporting, and a second limit behind our own ceiling check.
- **Gated capabilities**, all verified live: `talking-head`, `face-swap-image`,
  `face-swap-video`, `lipsync`, `sync-lipsync-v3`, `heygen-twin`.

## Beyond this repo

- **npm:** [`mandate-consent`](https://www.npmjs.com/package/mandate-consent). The
  core has zero dependencies; the adapters' packages are optional peers.
- **OriginTrail DKG integrations registry:** listing submitted as a draft,
  [OriginTrail/dkg-integrations#31](https://github.com/OriginTrail/dkg-integrations/pull/31).
  It was validated locally with the registry's own `validate.mjs` and
  `security-checks.mjs`.
- **Livepeer community skill:** [`skills/likeness-consent.md`](skills/likeness-consent.md)
  carries the consent norm for any Livepeer agent: explicit, current, scoped
  consent; no identifying people from their faces; refuse and say what is missing;
  honour withdrawal. The skill catalogue permits style and domain guidance only, so
  **a skill asks an agent to behave, while the gate is what actually stops the
  spend.** Publishing is pending an API key: `node scripts/publish-skill.mjs --publish`.
  Daydream `sk_` keys were retired partway through the hackathon, and Livepeer Agent
  now requires a PymtHouse composite key issued to a registered developer app.
  Mandate itself runs on the keyless tier.

## Where the data lives (Track 2 requirement)

Each party writes only to a graph it owns. Verifiers read both.

| Graph | Owner | Holds | Layer |
|---|---|---|---|
| grants (on-chain CG 430) | grantor | grant clauses, revocations | published to Verifiable Memory |
| derivations (on-chain CG 431) | producer | output hash, serving capability, authorising grant | published to Verifiable Memory |
| system `ontology` | — | the Mandate vocabulary | published to Verifiable Memory |

**Stays local and is never sent anywhere:** consent video bytes, reference images,
real names, prompts, and media files.

**Published:** hashes, DIDs, capability names, dates and ceilings. No faces,
biometrics, media bytes or real names are needed on chain.

Grants, revocations and derivations **must** be published to Verifiable Memory.
We measured that Shared Working Memory for these graphs did not reach the other
party, so a revocation left there would leave the producer still rendering.

**Mandate deliberately does not do biometric identification.** There is no
face-embedding capability on Livepeer. A "salted, non-invertible hash of a face
embedding that stays stable across photos" also contradicts itself: hashing
destroys the distances that face matching depends on. The subject identifier is
**declared**, and the consent clip is evidence bound to it by SHA-256.

## Known limitations

These are stated plainly so a judge can tell what works from what is planned.

- **A CLEAR verdict does not yet bind the producer.**
  - What it proves: every derivation edge for those bytes links to a live grant
    that permits the capability that served it.
  - What it does not prove: that the edge was written by a producer the grantor
    chose. A grant does not yet name its permitted producers.
  - Consequence: someone could write an edge linking an unauthorised render to a
    live grant.
  - Planned fix: a `mandate:permitsProducer` allowlist, checked against the
    derivation's seal author.
  - Already covered: laundering a file made under a *revoked* grant is blocked,
    because every edge is judged and one tainted edge taints the file.
- **Revocation is not instant across parties.** After the revocation is anchored,
  the independent producer node refused within 4, 27 and 49 seconds across three
  runs. The revoke command itself (seal, share, anchor) takes 13–75 seconds. During
  that window a producer reading its own node may still permit.
- **DKG v10.0.16 cannot publish a literal that contains a double quote or a line
  break**, however it is escaped. The node unescapes its input, re-serialises
  without re-escaping, and fails to parse its own output. We confirmed this with
  probe drafts. Mandate refuses such literals with an error naming the field, and
  never silently rewrites them.
- **A peer cannot write into another party's context graph.** It holds only a stub
  of the graph definition, and the grantor's node logs `RFC-64 authority bootstrap
  incomplete … ERC721NonexistentToken`. This is why derivations live in the
  producer's own graph.
- **Livepeer's async worker abandons jobs at about 128 seconds.** Three submissions
  died this way with `runner_abandoned`. The same render **succeeded inline in 103
  seconds**, so gated renders run with `async: false`. A refusal never invokes the
  capability, so no refusal can be broken by a provider failure.
- **`talking-head` is audio-driven.** It rejects a text-only prompt, so speech has
  to be synthesised first.
- **The subject is a declared identifier.** It is not proof of identity and not a
  legal determination.
- **Costs are list-price estimates**, not invoices, and failed renders are still
  billed. The one exact figure is *spend avoided by a refusal*, because nothing was
  called.
- **Both nodes run on one machine**, with separate `DKG_HOME`s and separate keys. The
  producer never holds the grantor's key, but they are not two organisations.
- **UALs `…/4` to `…/11` in `docs/SPIKES.md` predate the move from the
  `mandate.build` namespace** and are superseded by the ones above.

## Licence

Apache-2.0
