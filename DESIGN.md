# Mandate — design brief

## Problem

Generative media's legal exposure is the **input**. Rendering someone's likeness
or voice requires their permission, and today that permission lives in a
contract held by the party doing the rendering. It cannot be checked at render
time, cannot be revoked, and cannot be verified by anyone downstream.

The design follows from one fact: **the party who grants consent is never the
party who runs the render.** Any record controlled by the renderer is worthless
as evidence of the grantor's intent. The permission has to be authored by the
grantor, readable by the renderer, and checkable by a third party who trusts
neither.

## Parties

| Party | Owns | Does |
|---|---|---|
| **Grantor** — the depicted person's agent | a grants context graph | authors grants and revocations |
| **Producer** — the rendering agent | a derivations context graph | resolves grants before spending; records what it produced |
| **Verifier** — a distributor, platform or auditor | nothing | hashes a delivered file and follows the graph |

Each party writes only to a graph it owns. Readers subscribe to both. This is
least-authority by construction, and it is also what the network permits: we
measured that a peer holding a synced copy of another party's graph cannot write
into it.

## How the DKG v10 memory model is used

- **Context Graphs.** Two user graphs, each registered on-chain by its owner
  (Base Sepolia, graphs 430 and 431), plus the system `ontology` graph for the
  vocabulary.
- **Assertions and Knowledge Assets.** Every grant, state change and derivation is
  its own Knowledge Asset, written through the public lifecycle: create → write →
  finalize → share → publish. Nothing is written to SPARQL directly.
- **Authorship.** `wm/finalize` returns an EIP-712 AuthorAttestation. The
  producer's node refuses to finalize with the grantor's address as author
  (`not a registered local agent on this node`), so a grant's author cannot be
  forged by the party that profits from rendering.
- **UALs.** Anchored grants, revocations and derivations are addressable by UAL,
  and a verifier can check any of them on the Base Sepolia explorer.

## Promotion path

| Stage | What | Why it stops or continues |
|---|---|---|
| **Working Memory** | Drafts are written and finalized on the authoring node. Consent video, reference images, real names, prompts and media never leave this layer. | Private by construction. Only clause data proceeds. |
| **Shared Working Memory** | The finalized asset is shared to the owning graph. | A staging step on the authoring node. Measured: SWM content for these graphs **did not reach the other party**. |
| **Verifiable Memory** | Grants, revocations and derivations are published and anchored. | Required, not optional. A revocation left in SWM was never seen by the producer, which kept permitting. After anchoring, the producer's own node refused within 4–49 seconds across three runs. |

We expected SWM to carry revocations quickly, with VM as a slower confirmation.
The measurements reversed that: for cross-party consent, **Verifiable Memory is the
only layer that works**. The cost is one small Base Sepolia transaction per grant,
revocation or derivation. Mandate's CLI anchors by default and fails loudly if it
cannot.

## The rules a resolver must follow

1. **State is counted only when written by the grantor.** The graph is
   append-only, so "active" and "revoked" coexist, and anyone can write either.
   The newest assertion *written by the grant's grantor* wins; every other
   assertion is ignored and reported.
2. **Capabilities match exactly**, never by family. A grant for `face-swap-image`
   does not cover `face-swap-video`.
3. **A forbid beats a permit.**
4. **Every derivation edge for a file is judged.** A file is CLEAR only if all of
   them are. A new grant can authorise new renders; it cannot clear an artifact
   whose authorisation was withdrawn.
5. **The gate fails closed.** An empty or partial read refuses. It never permits.

The gate (`src/gate.mjs`) and the verifier (`src/verify-core.mjs`) are pure
functions with no I/O, so these rules can be read and tested in isolation.

## Security

- **Network egress:** `agent.livepeer.org` (Livepeer Agent MCP), the local DKG
  nodes, and media URLs the operator supplies for hashing.
- **Credentials:** each DKG node's API token, read from its `DKG_HOME`, and an
  optional `LIVEPEER_AGENT_KEY`. Mandate never reads wallet keystores.
- **Write authority:** the Knowledge Asset lifecycle routes on the operator's own
  nodes, and `vm/publish` (Curator authority) for grants, revocations and
  derivations. Setup also uses `context-graph/create`, `register` and `subscribe`.
- **Package:** no install scripts, zero runtime dependencies in the core, and
  `npm audit --omit=dev` is clean.

## Known limits and next steps

- **Producer binding.** A CLEAR verdict proves every edge for the bytes points to a
  live grant, but not that a producer the grantor chose wrote the edge. Next step:
  a `mandate:permitsProducer` allowlist, checked against the derivation's seal
  author.
- **Revocation latency.** The cross-party window is seconds to about a minute.
  Every decision should carry an explicit trust tier (anchored, shared-only, stale).
- **DKG literal handling.** v10.0.16 cannot publish a double quote or a line break
  in a literal. Mandate refuses such values rather than rewriting them.
- **Independent verifier.** The demo verifies from the grantor's node. A third,
  read-only node needs no gas and is the natural next demonstration.
