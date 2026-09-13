# Mandate — design brief

## Problem

Generative media's legal exposure is the **input**. Rendering someone's likeness
or voice requires their permission, and today that permission lives in a
contract held by the party doing the rendering. It cannot be checked at render
time, cannot be revoked, and cannot be verified by anyone downstream.

The design follows from one fact: **the party who grants consent is never the
party who runs the render.** Any record controlled by the renderer is worthless
as evidence of the grantor's intent. The permission has to be published by the
grantor, readable by the renderer, and checkable by a third party who trusts
neither.

## Parties

| Party | Owns | Does |
|---|---|---|
| **Grantor** — the depicted person's agent | a grants context graph | publishes grants and revocations |
| **Producer** — the rendering agent | a derivations context graph | resolves grants before spending; records what it produced |
| **Verifier** — a distributor, platform or auditor | a read-only node | hashes a delivered file and follows the graph |

Each party writes only to a graph it owns. This is least authority by construction,
and it is also what the network allows: a peer holding a synced copy of another
party's graph can seal an asset into it but cannot share or anchor it (S6c).

**Custody.** The grantor node holds a signing key on the depicted person's behalf. In
practice that is an agency, a union or a hosted consent service; the person only
opens a phone link and records a clip. Mandate does not prescribe who.

## Trust assumption

A verifier trusts:

1. **The chain**, for which address anchored each Knowledge Asset. The Knowledge
   Asset id is `(author << 96) | n`, and its Verifiable Memory graph is
   `…/_verifiable_memory/<author>/<n>`.
2. **Its own DKG node**, to report that graph and its `_meta` anchor faithfully. The
   resolver does not trust the node to return everything: it checks each read for
   completeness and compares the node's copy with the chain head.
3. **A list of producers**, whose derivation records it is willing to believe.

It trusts nothing written inside the graph about authorship. `mandate:grantor` and
`mandate:stateAuthor` are descriptive and must agree with the anchoring address.

## How the DKG v10 memory model is used

- **Context Graphs.** Two user graphs, each registered on-chain by its owner (Base
  Sepolia, graphs 430 and 431), plus the system `ontology` graph for the vocabulary.
- **Knowledge Assets.** Every grant, revocation and derivation is its own Knowledge
  Asset with its own IRI, written through the node's HTTP API: create and seal in
  Working Memory, share to Shared Working Memory, publish to Verifiable Memory. A
  write is reported as done only when the chain has confirmed it and it is bound to
  the graph; a minted but unbound asset is a failure that names its UAL and
  transaction.
- **`_meta`.** Each anchored asset's record (`kaUal`, `status "confirmed"`,
  `assertionGraph`, `publicTripleCount`, `transactionHash`) is what the resolver
  checks a graph against. `prov:wasAttributedTo` exists only on the publishing node,
  so authorship comes from the graph path.
- **Reconcile.** `POST /api/context-graph/reconcile` reports how many assets are bound
  to a graph on-chain and how many the node holds. The CLI checks it before every
  decision.

## Promotion path

| Stage | What | Why it stops or continues |
|---|---|---|
| **Working Memory** | Clause data, hashes and identifiers are written and sealed on the authoring node. Consent video, reference images, prompts and media never enter the DKG; they go to Livepeer Agent and its providers to be transcribed and rendered. | Only clause data proceeds. |
| **Shared Working Memory** | The sealed asset is shared to the owning graph. | A staging step. Measured: SWM content for these graphs did not reach the other party, and SWM paths are not authenticated. A revocation seen only in SWM is a warning, never a decision. |
| **Verifiable Memory** | Grants, revocations and derivations are published and anchored. | Required. Only anchored assets can permit a render or clear a file. |

## The rules a resolver must follow

1. **Authorship is the anchoring address.** A grant counts only when anchored by the
   address in its subject (`0x<address>:<name>`); a revocation only when anchored by
   the address that anchored its grant; a derivation only when anchored by a trusted
   producer. Anything else is reported as a forgery, with its UAL.
2. **Knowledge Assets never merge.** Objects are grouped per asset and per subject;
   a duplicated single-valued property makes the object malformed.
3. **Revocation is terminal.** Any counted revocation ends a grant. A revocation that
   appears only in a merged view with no Verifiable Memory copy is honoured, because
   its publisher cannot be established.
4. **Capabilities match exactly**, never by family, and **a forbid beats a permit**.
   Sexual content and deceptive impersonation are refused whatever a grant says.
5. **Every trusted derivation for a file is judged.** A file is CLEAR only if all are.
   A new grant can authorise new renders; it cannot clear an artifact whose
   authorisation was withdrawn.
6. **The gate fails closed.** A malformed request, an incomplete or truncated read, a
   node behind the chain, an unreadable date or ceiling, or an unknown cost under a
   ceiling all refuse. The verifier answers INCONCLUSIVE instead of guessing.

The provenance reducer (`src/provenance.mjs`), the gate (`src/gate.mjs`) and the
verifier (`src/verify-core.mjs`) are pure functions, so these rules can be read and
tested in isolation. `test/adversarial.test.mjs` replays every attack from the
adversarial study against them.

## Security

- **Network egress:** `agent.livepeer.org` (Livepeer Agent MCP), which receives the
  consent clip, reference media URLs and prompts; the local DKG nodes; and media URLs
  that are hashed — those an operator passes to `verify`, and the output URLs Livepeer
  returns. Hashing streams with a size cap and a timeout and accepts http(s) only.
- **Credentials:** each DKG node's API token, read from its home, and an optional
  `LIVEPEER_AGENT_KEY`. Mandate never reads wallet keystores. Only `MANDATE_*` keys
  and `LIVEPEER_AGENT_KEY` are read from `.env`.
- **Write authority:** the Knowledge Asset routes on the operator's own nodes, and
  Verifiable Memory publishing for grants, revocations and derivations. Setup uses
  `context-graph create`, `register` and `subscribe`; `scripts/nodes.mjs` also calls
  `reconcile` and `fetch-assets`, which need a node-admin token.
- **Local state:** `~/.mandate` (mode 0700) holds the anchors and revocations already
  seen and the renders in flight (files mode 0600).
- **Package:** no install scripts and no runtime dependencies in the core. CI's
  `npm audit --omit=dev` therefore covers nothing beyond the package itself; the
  optional peers (`@modelcontextprotocol/sdk`) are audited by whoever installs them.

## Known limits and next steps

- **Producer binding.** A grant does not name the producers allowed to render under it.
  Next: a `mandate:permitsProducer` list, checked against the derivation's anchoring
  address.
- **Discovery.** A verifier is configured with the graphs and producers it reads. Next:
  a directory graph where producers announce their derivations graphs, and the
  derivation UAL carried in C2PA or XMP metadata as a pointer.
- **Exact bytes.** Verification is by SHA-256 of the delivered file, for the intake hop.
- **DKG literal handling.** v10.0.16 cannot publish a double quote or a line break in a
  literal. Mandate refuses such values rather than rewriting them.
