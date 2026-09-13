# Mandate

**A consent rail for generative media.** No likeness or voice renders until the
depicted person's own agent has published a live, signed grant — and revoking it
stops the next render and names everything already made under it.

Built for the **Livepeer Agent Hackathon 2026** · **Track 2 — Livepeer Agent + OriginTrail DKG**

---

## The problem

Generative media's real legal exposure is the **input**, not the output. An agent
that fine-tunes a LoRA on someone's photos, or swaps their likeness into a spot,
bakes that person into a durable, redistributable artifact.

Consent today is a contract in a Drive folder. It is not machine-readable, not
queryable at render time, not revocable, and — fatally — **stored by the party
doing the rendering**. A renderer attesting to its own permission is worth
nothing.

That last point is the whole design. *The party who grants consent is never the
party who runs the render.* That is precisely the condition under which a local
database cannot work, and it is why this is a verifiable shared graph rather than
a table in someone's Postgres.

## What it does

An agent is asked to render a talking-head spot using a photo of a person. Before
spending a cent, it resolves the OriginTrail DKG for a grant covering **that
subject, that exact Livepeer capability, that use class, that territory, in date,
not revoked, within a spend ceiling**. No grant, no render — and the refusal
names the missing clause and the exact spend avoided.

The effect of the verifiable knowledge is **refusal**, not improvement. Delete the
DKG and you do not get a worse product; you get a render tool with a consent
checkbox, which is nothing.

## Why the graph has to be verifiable

Three properties a vendor database cannot provide:

1. **The permission is authored by a party who will never run the app.** The
   EIP-712 AuthorAttestation returned by `wm/finalize` proves the grantor's
   address sealed it. We tested the inverse: the producer's node **refuses** to
   seal on the grantor's behalf — `authorAgentAddress … is not a registered local
   agent on this node`. Authorship is enforced by the node, not asserted by us.

2. **Revocation is decided by the grantor, on an append-only graph.** The DKG has
   no delete, so a "revoked" and an "active" assertion coexist forever and anyone
   can write either. Mandate counts a state assertion **only when its author is
   the grantor named in the grant**. Without that single check the producer simply
   writes its own "not revoked" and wins. We demo the forgery being rejected.

3. **A third party can check a delivered file** without talking to either side.

## Status — what actually works

Everything below was produced by running it against the **live Livepeer Agent
API** and **two real DKG v10 testnet daemons**. There is no mock mode in this
repo. See [`docs/SPIKES.md`](docs/SPIKES.md) for raw evidence.

| Area | State |
|---|---|
| Gate: 7 clauses, fails closed | **working**, 26 tests |
| Grant authored, sealed and **anchored on Base Sepolia** | **working** — real UALs, confirmed txs |
| Producer permits from **its own node**, under a grant it did not author | **working** |
| Revocation propagates **across independent nodes** | **working** — measured 30–60s |
| Forged state assertion rejected | **working** — see below |
| EIP-712 authorship, and un-forgeability | **working** |
| Consent capture via phone link | **working** (`request_upload`, keyless) |
| Derivation ledger + reconciliation | **working** |
| Third-party verify from the bytes alone | **working** — CLEAR, then TAINTED after revocation |
| Live identity render | **working inline**; the platform's async worker is broken — see Limitations |

### Two parties, two nodes, one chain

A fresh subject, run end to end from the **producer's own daemon** with nothing
stubbed ([`demo/e2e.mjs`](demo/e2e.mjs)):

```
[ +32s] grant UAL: did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/10
[ +32s] grant tx:  0x818d2c13b71e1eae797fad7cbf6460b2098fcd12d9ceb79ed6454102d8d22464
[ +49s] producer, own node, after grant:  PERMITTED under urn:mandate:grant:dana-w0io
[ +79s] revoke UAL: did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/11
[+106s] producer, own node, after revoke: REFUSED — clause: not-revoked
```

Both UALs resolve on the Base Sepolia explorer. The producer never talks to the
grantor; it learns about the revocation from the graph.

### The beat that matters

```
⚠ ignored 1 state assertion(s) not authored by the grantor:
    "active" claimed by did:dkg:agent:0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5

REFUSED — clause: not-revoked
grant urn:mandate:grant:ana-001 was revoked at 2026-09-12T09:14:29.146Z
  by did:dkg:agent:0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69

spend avoided: $1.0080 (exact — the capability was never invoked)
```

The discarded assertion is a genuine sealed Knowledge Asset with its own Merkle
root and a timestamp deliberately **newer** than the revocation. A resolver that
took the newest assertion would have permitted the render.

## How Livepeer Agent is used

Livepeer is load-bearing here, not a swappable image API.

- **`run_capability` on `/api/mcp/raw`** — every gated dispatch goes through the
  raw surface *specifically because it never substitutes models*. The creative
  surface is documented to substitute. A gate the harness can route around to an
  uncleared sibling model is not a gate.
- **`request_upload`** — mints a 30-minute phone-openable link, works with no API
  key. This is what turns consent from an out-of-band email chain into a step
  inside the conversation. It is the least-known primitive on the platform and
  the reason this product is pleasant rather than bureaucratic.
- **`describe_capability`** — supplies the capability→availability→price mapping
  the grant vocabulary is written against.
- **`nemotron-asr`** ($0.00014/s) — transcribes the spoken consent clip so the
  spoken scope can be diffed against the requested scope.
- **`get_cost_report` / `spend_cap`** — spend reporting, and a second belt under
  our own ceiling check.
- Gated capabilities, all verified live: `talking-head`, `face-swap-image`,
  `face-swap-video`, `lipsync`, `sync-lipsync-v3`, `heygen-twin`.

## Data classification (Track 2 requirement)

| Where | What |
|---|---|
| **Local — Working Memory, never transmitted** | consent video bytes, reference images, real names, prompts, output URLs |
| **Shared — SWM** | drafts and derivation edges on the authoring node |
| **Published — Verifiable Memory, Base Sepolia** | grant clauses and revocations. Hashes, DIDs, capability names, dates, ceilings |

Grants and revocations **must** be published to Verifiable Memory. We measured
that SWM content for the context graph did not reach the other party, while
Verifiable Memory synced durably — so a revocation left in SWM leaves the
producer rendering. `grant` and `revoke` anchor by default, and `revoke` fails
loudly if it cannot.

No faces, no biometrics, no media bytes, and no real names are required on chain.

**We deliberately do not do biometric identification.** There is no face-embedding
capability among Livepeer's live capabilities, and a "salted, non-invertible hash
of a face embedding that is stable across photos" is self-contradictory — hashing
destroys the metric space that matching needs. The subject identifier is
**declared**, and the consent clip is human-auditable evidence bound to it by
SHA-256. Declining to do biometrics is a product decision, not a gap.

## Run it

Requires Node ≥ 22.13 (see `.nvmrc`). No Docker.

```bash
npm install
npm test                       # 17 tests, no network needed

# two DKG v10 nodes, as two separate parties
npm run nodes:init             # driven through a pty; dkg init is interactive
npm run nodes:start

node bin/mandate.mjs status    # two distinct agent DIDs
node bin/mandate.mjs grant --subject ana-7f3c --capability talking-head
node bin/mandate.mjs render --subject ana-7f3c --capability talking-head
node bin/mandate.mjs revoke --id urn:mandate:grant:ana-7f3c
node bin/mandate.mjs render --subject ana-7f3c --capability talking-head   # refused
```

`LIVEPEER_AGENT_KEY` is optional — the keyless demo tier works for everything
except sustained rendering.

## Known limitations

Stated plainly, because a judge should be able to tell a working path from a
planned one.

- **Revocation is not instant across parties.** Measured at 30–60 seconds from
  revoke to refusal on an independent node: ~13s of chain confirmation plus
  durable sync. During that window a producer resolving from its own node may
  still permit. The sub-second refusal only holds on the grantor's own node, and
  we do not claim it for the cross-party case.
- **Shared Working Memory did not cross nodes** for the registered context graph;
  the grantor logs `RFC-64 authority bootstrap incomplete … ERC721NonexistentToken`.
  Only Verifiable Memory synced, so every grant and revocation costs a (tiny)
  Base Sepolia transaction.
- **The OriginTrail testnet faucet was out of Base Sepolia gas** on 2026-09-12. It
  delivered TRAC but no ETH; the wallets were funded manually.
- **The Livepeer async worker abandons jobs at ~128 seconds.** Three submissions
  across `talking-head` and `sync-lipsync-v3` all died with `runner_abandoned`.
  The same `sync-lipsync-v3` render **succeeded inline in 103 seconds**, so gated
  renders run with `async: false`. `face-swap-image` failed separately with a
  closed provider stream. Structural mitigation: **a refusal never invokes the
  capability**, so every refusal beat is immune to provider failures.
- **`talking-head` is audio-driven.** It rejects a bare text prompt with
  `missing field audio_url`; speech has to be synthesised first.
- **Subject linkage is a declared identifier**, not identity proof and not a legal
  determination.
- **Revocation propagates in seconds, not instantly.** There is a window; the
  honest system surfaces it rather than pretending it is zero.
- **DKG v10 has no revocation primitive.** Ours is an application-level convention
  over an append-only graph. The vocabulary is part of the contribution.
- **Costs are list-price estimates**, not invoices, and failed renders are still
  billed. The one exact figure is *spend avoided by a refusal* — nothing was
  called.
- The two nodes run on one machine with separate `DKG_HOME`s and separate keys. The producer never holds the grantor's key — but they are
  not two organisations.

## Licence

Apache-2.0
