# Spike results

Every claim below was produced by running the thing, not by reading documentation.
Sections are in the order they were run. Scratch output from the early spikes went to
`spikes/out/`, which is not committed; committed evidence is in
[`docs/evidence/`](evidence/) and the live fixtures the tests use in
[`test/fixtures/live/`](../test/fixtures/live/).

## Status

| Spike | Result | Where |
|---|---|---|
| S1 Livepeer capability registry | GREEN | below |
| S2 Consent capture link | GREEN for the link only: a link was minted and its page loaded. No real upload or transcription is committed; the phone capture in `demo/full.mjs --consent` is pending | below |
| S3 DKG v10 install | GREEN | below |
| S4 Two independent parties | GREEN | below |
| S5 Testnet anchoring | GREEN after manual funding | "S5 revisited" |
| S6 Author attestation, S6b forging it from the producer's node | GREEN: the producer's node refuses to seal as the grantor | "S6" |
| S6c Forgery of graph *content* from the producer's node | GREEN against 0.2.0 on all three nodes, the grantor's, the producer's and the read-only verifier's (re-recorded 14 Sep). That 0.1.0 would accept the same forgeries is shown by replaying them against 0.1.0's resolver in tests; no live 0.1.0 read of these assets was recorded | "S6c" |
| S7 Live render | GREEN inline (`sync-lipsync-v3`, 103 s); async worker abandons at ~128 s | "S7" |
| Graph omission in `/api/query` | reproduced on both nodes; handled by merged, checked reads | "DKG v10.0.16 leaves whole named graphs out" |
| Read-only verifier node | GREEN, no funded wallet | "A third, read-only verifier node" |

The table below is the day-zero snapshot, kept as it was.

| Spike | Result | Evidence |
|-------|--------|----------|
| **S1** Livepeer capability registry | **GREEN** | `/api/mcp/raw` = 23 tools (incl. `run_capability`, `request_upload`, `get_upload`, `spend_cap`, `describe_capability`, `get_pricing`, `get_cost_report`). `/api/mcp/full` = 206 tools (incl. `submit_lora_train`, `apply_lora`, `asset_lineage`, `import_asset`, `voice_create`, `publish_skill`). |
| **S2** Consent capture | **GREEN** | `request_upload {kind:"video"}` minted `https://agent.livepeer.org/u/7e339f0e63e77915ee34b1c8`, valid 30 min, 50 MB, HEIC auto-converted. Page returns HTTP 200. Works **keyless**. |
| **S3** DKG v10 install | **GREEN** | `@origintrail-official/dkg@10.0.16` installed on Node 26 with no native-build failure (`better-sqlite3` prebuilds resolved). No Docker required. |
| **S4** Two independent parties | **GREEN** | Two daemons, separate `DKG_HOME`, ports 9201/9202, **distinct agent DIDs and peer IDs**, running concurrently. |
| **S5** Testnet anchoring | **AMBER** | TRAC funded (1000 × 3 wallets) but **ETH gas = 0.0 on all four wallets — the faucet itself is out of Base Sepolia gas.** See below. |
| **S6** `preSignedAuthorAttestation` | pending | |
| **S7** Live render | pending | |

## Verified capability prices and availability (S1)

`describe_capability` answers in prose, not JSON — parse the header line.

| Capability | Availability | Price |
|---|---|---|
| `talking-head` | available | ~$0.168/second |
| `face-swap-image` | available | ~$0.009/image |
| `face-swap-video` | available | ~$0.024/second |
| `lipsync` | available | ~$0.14/second |
| `sync-lipsync-v3` | available | ~$0.13997/second |
| `heygen-twin` | available | ~$0.105/second |
| `nemotron-asr` | available | ~$0.00014/second |
| `flux-lora-training` | **experimental** | n/a |

`flux-lora-training` being experimental is why it sits on the **refusal** path only:
a refusal never invokes the capability, so that beat cannot fail on camera and
costs exactly $0.

## S5 — the faucet is out of gas

`dkg init --network testnet` calls the OriginTrail faucet automatically. It
delivered TRAC but every native ETH transfer failed:

```
insufficient funds for gas * price + value: have 924250320020391 want 1000550000000000
```

That is the **faucet's own wallet** being short — ~0.00092 ETH available against
~0.001 ETH required. Retrying will not help until it is topped up.

Consequences, precisely:

- **Unaffected:** Working Memory, Shared Working Memory (gossip), context graphs,
  SPARQL query, peer sync, and the entire gate. The daemon connects to testnet
  peers and reads Base Sepolia fine — only *writes* need gas.
- **Blocked:** `vm/publish`, which is what mints a UAL and anchors on-chain.

The hackathon rules explicitly allow an Edge-Node-only submission, so this is a
degraded rather than fatal path. Resolving it needs Base Sepolia ETH from a
public faucet into the operational wallets.

## Environment footguns confirmed by running into them

- `dkg init` really does default to **`mainnet-gnosis`**, where there is no
  faucet. Always pass `--network testnet`.
- `dkg init` is interactive even with flags; it must be driven through a pty
  (`spikes/drive-init.py`). Piped stdin dies with `ERR_USE_AFTER_CLOSE`, and the
  prompt line ends in an ANSI cursor escape, so strip ANSI before matching it.
- `dkg status` reports "not running" even when the daemon is up, because it does
  not honour `DKG_HOME` for the PID file. Check the port instead.
- `auth.token` has a `#` comment on the first line — strip comments before use.
- `describe_capability` takes `name`, not `capability`.
- The documented `X-Livepeer Agent-Tool-Profile` header contains a space, making
  it an invalid header name that is silently ignored. The working header is
  `X-Storyboard-Tool-Profile: lean`. Applying it to `/full` trims 206 tools to
  26, hiding the LoRA verbs — so send it only to `/raw`.

---

## What works without gas, and what does not (measured)

Established by running each step on two live DKG v10 testnet nodes.

**Works with zero gas:**

- `context-graph create` — the CLI states plainly it is "free, P2P — no chain transaction".
- `ka create` → `write` → `finalize` → `share` (Working Memory → Shared Working Memory).
  A real grant sealed with Merkle root `0x6733f000f2be5a51bf4ea29ed5366fb47f4e0fca588b750f433069a59961ae0f`,
  status `swm-shared`.
- SPARQL over the result, **provided you pass `--include-shared-memory`** — without it a
  freshly shared KA returns "No results", which looks like data loss and is not.
- Reading Base Sepolia. The daemon polls chain events and resolves contracts fine;
  only *writes* need funding.

**Blocked without gas:**

- `context-graph register` (on-chain registration). Measured requirement:
  `have 0 want 510752000000` — about **0.0000005 ETH** for the transaction.
- `vm/publish`, and therefore UAL minting.
- **Cross-node sync of a user-created context graph.** This is the consequential one.
  Both nodes connect and sync the system graphs (`agents`, `ontology`) happily, but
  the producer's catch-up on `mandate-grants` fails and `query-remote` returns
  `ACCESS_DENIED — Context graph is not queryable`. The grantor's log gives the reason:

  ```
  RFC-64 catalog replay incomplete for ".../mandate-grants" after VVzrndHL connected [WARN]
  ```

  An unregistered context graph has no on-chain catalog entry, so a peer cannot
  validate it and refuses to serve it. Registration needs gas.

So gas sits on the critical path for the **two-party** demo, not merely for anchoring —
which is more than the plan assumed. The amount required is trivially small; the faucet
simply has none to give.

### Direct peer connection is still required regardless

Two nodes on one machine do not find each other through the public relays. The producer
must dial the grantor explicitly:

```
dkg connect /ip4/127.0.0.1/tcp/<grantor-listen-port>/p2p/<grantor-peer-id>
```

The grantor's listen port is random (`listenPort: 0`) and is printed in its `daemon.log`.

---

## M1 proven against live DKG data

> **Superseded as evidence, kept as it was run (12 Sep, 0.1.0).** Scenario E below
> does not show forgery rejection. The forger wrote its **own** DID as
> `stateAuthor`, the assertion was sealed and shared but never anchored, under the
> old `mandate.build` namespace, and it was judged by the 0.1.0 resolver, which
> compared `stateAuthor`. A forger that wrote the grantor's DID would have been
> accepted, which is what the adversarial study found. The run against 0.2.0 is
> "S6c" below.

Five scenarios, run end to end against two real DKG v10 testnet daemons. No
mocks anywhere in this path.

| # | Scenario | Result |
|---|----------|--------|
| A | Producer's own view, grant not synced | `REFUSED — grant-exists`, $1.0080 avoided |
| B | Grant visible, every clause satisfied | `PERMITTED under urn:mandate:grant:ana-001` |
| C | `face-swap-video` requested, grant permits `face-swap-image` | `REFUSED — capability-permitted` (exact match, never by family) |
| D | Ana revokes on her own node | `REFUSED — not-revoked`, citing her DID and the timestamp |
| E | **Producer forges a newer "active" state** | **`REFUSED` — forgery reported and ignored** |

Scenario E is the one that matters. The forged assertion is a real sealed
Knowledge Asset with its own Merkle root (`0x02b3bfb7…`), a timestamp deliberately
newer than Ana's revocation, sitting in the same append-only graph. A resolver
that took the newest assertion would permit the render. Mandate refuses, and
says which assertion it discarded and who wrote it:

```
⚠ ignored 1 state assertion(s) not authored by the grantor:
    "active" claimed by did:dkg:agent:0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5

REFUSED — clause: not-revoked
grant urn:mandate:grant:ana-001 was revoked at 2026-09-12T09:14:29.146Z
  by did:dkg:agent:0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69

spend avoided: $1.0080 (exact — the capability was never invoked)
```

### Operational note: SWM share can fail transiently

`ka create --share` returned `phase=swm-share A promote prerequisite is
temporarily unavailable`, leaving the asset sealed in Working Memory but not
shared. A plain `dkg ka share <name> -c <cg>` afterwards succeeded. Any
automation must treat share as retryable rather than assuming create-with-share
is atomic.

---

## S6 — authorship (GREEN)

`POST /api/knowledge-assets/{name}/wm/finalize` returns a real EIP-712
AuthorAttestation:

```json
{
  "assertionUri": "did:dkg:context-graph:0xeD1e…/mandate-grants/assertion/0xeD1e…/grant-s6-ed1eeb",
  "merkleRoot":   "0xf8530182778518fb6fd883918af6cb29b5b290f777e1abf9dd734c4c148bc7ac",
  "authorAddress":"0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69",
  "schemeVersion": 1,
  "chainId": "84532",
  "kav10Address": "0x835F921A0fC8D6365C34A0bB9b37D10C98C1B8c3",
  "eip712Digest": "0x4ea28ae497e5f7a63760b5a4de1781dfe5672b9683cb2ba8c592626c3fa21709"
}
```

`authorAddress` is the grantor's, and is not the producer's.

### S6b — the producer cannot forge it

A seal naming the right author only means something if the other party cannot
produce one saying the same thing. Attempting exactly that from the producer's
node, passing Ana's address as `authorAgentAddress`:

```
500 assertionFinalize: authorAgentAddress 0xeD1eeB64…0B69
    is not a registered local agent on this node
```

The node will not sign for an agent whose key it does not hold. Two consequences:

1. A seal naming the grantor as author cannot be produced from the producer's
   node. That is all this shows. It does not stop the producer writing a triple
   that *names* the grantor, which 0.1.0 believed; 0.2.0 attributes every object
   to the address in its anchored Verifiable Memory path instead (S6c).
2. It only holds because the grantor runs a **separate daemon**. The red-team
   warning about custodial mode is real — a single node with two registered
   agents would hold both keys, and the claim would collapse. Mandate uses two
   `DKG_HOME`s precisely so the producer never has Ana's key.

---

## S7 — rendering, and a reproducible platform bug

The success path needs one real, paid, identity-bearing render. Getting one
surfaced a platform-side defect worth reporting upstream.

### What works reliably

| Capability | Result |
|---|---|
| `flux-schnell` | **works**, p50 1.8s, ~$0.003/MP. Used to generate the synthetic reference portrait. |
| `inworld-tts` | **works**, returned a `.wav` immediately |
| `nemotron-asr` | available, $0.00014/s |

The reference likeness in this repo is **synthetic**, generated by `flux-schnell`.
A demo about consent should not use a real person's face to make its point, and
it keeps the repository free of anyone's biometrics.

### The async worker abandons jobs at ~128 seconds

Three separate submissions, three different capabilities, one failure mode:

| Job | Capability | Outcome |
|---|---|---|
| `mjob_93244be79885` | `talking-head` | `failed (126s)` — `runner_abandoned`, no heartbeat for 125s |
| `mjob_640913486506` | `talking-head` | `failed (129s)` — `runner_abandoned`, no heartbeat for 128s |
| `mjob_1cec6bfe884c` | `sync-lipsync-v3` | `failed (128s)` — `runner_abandoned`, no heartbeat for 127s, `http 200` |

> The background worker running this job stopped responding (no heartbeat for
> 127s after it started). No media was produced.

Same ~127–128s boundary across different models and providers, with the runner
reporting HTTP 200 in one case, points at the platform's async job worker rather
than any one capability. `async: true` is the *default* for capabilities whose
p95 exceeds ~90s — which is exactly the set of capabilities this bug destroys.

`face-swap-image` failed differently, with a closed provider stream:

> SDK /inference failed: stream ended before returning a result

Billing note, taken from the platform's own messages: the daily-cap reservation
was released on these failures, but "the provider may still have billed us for
the attempt, not you."

### Two timeouts, and a money bug

`talking-head` also rejects a bare text prompt — it is omnihuman v1.5, which is
audio-driven and requires `audio_url`. Speech has to be synthesised first.

More importantly, the first inline attempt died at exactly 60s with
`McpError -32001: Request timed out`. That is the **MCP SDK's own request
timeout**, entirely separate from the `timeout` argument passed to
`run_capability`, which is the server-side render budget. When the SDK timeout
fires the render keeps going and is still billed, so the two must never be
conflated. `runCapability` now always gives the transport more room than the
render budget.

A second inline attempt then hit undici's 300s HTTP/2 stream limit — a third
clock, in Node itself.

### Consequence for the demo

The demo is structurally insulated from all of this, by design rather than luck:
**a refusal never invokes the capability.** Every refusal beat — missing grant,
wrong capability, forbidden use class, expired window, revocation, and the
forgery rejection — is free, instant, and cannot be broken by provider
flakiness. Only the single success beat depends on a render completing.

---

## End to end, with real media (S7 GREEN)

The async path is unusable, but **the inline path works**. `sync-lipsync-v3`
(`fal-ai/sync-lipsync/v3/image-to-video`, $0.13997/s) completed inline in **103
seconds** and returned a real MP4. The loop below used real services, on 0.1.0, but
**the render was not gated**: the spike called the capability directly, and the
derivation edge was written by the spike script afterwards, not by a gate.

1. `flux-schnell` generates a **synthetic** reference portrait (~$0.003)
2. `inworld-tts` generates the speech
3. `sync-lipsync-v3` renders the video inline — real MP4, ~$0.84
4. The derivation edge is committed to the DKG, content-addressed
   `sha256 48a2c16d22920ce5ab051987c435bf5517e80bb7c1f50eb4b1b2e98efdbd9b88`
5. A third party, given the URL and the configured graph ids, hashes the bytes and returns
   **`CLEAR — authorised by did:dkg:agent:0xeD1e…0B69 under urn:mandate:grant:cara-9d2f,
   served by "sync-lipsync-v3"`**
6. Cara revokes on her own node
7. **The same file, the same bytes** now verifies **`TAINTED — the grant
   authorising this file was revoked at 2026-09-12T10:38:01.137Z`**
8. A fresh render request is refused: `not-revoked`, $0.8398 avoided

Nothing about the file changed between 5 and 7. The verdict changed because
somebody else changed their mind, on a graph neither the producer nor the
verifier controls.

### Two more operational findings

**`ka create --share` poisons its own name on partial failure.** After a failed
SWM promote the asset is sealed in Working Memory, and re-running `ka create`
with the same name fails with `private/public partition differs from its
existing seal`. The KA name is only a local handle, so `recordDerivation` now
uses a fresh name per attempt while the derivation's identity stays the content
hash.

**A read concurrent with a share can return a partial view.** One render
transiently saw zero grants and refused with `grant-exists` instead of
`not-revoked`. That one happened to fail closed. 0.2.0 makes an empty, partial or
failed read refuse by construction (every graph is checked against its anchor's
declared triple count and the node's graph count; `test/resolve.test.mjs`). One case
still permits: a read that is complete but comes from a node that has not yet
received a later revocation. The freshness check against the chain head catches that
once the revocation is bound on-chain, and only when the node's admin token lets it
run.

**Unpriced capabilities report unknown, not zero.** `sync-lipsync-v3` was
initially missing from the local price table and a refusal claimed `$0.0000`
avoided, which understates the refusal. Unknown is now reported as unknown.

---

## S5 revisited — funded, and what cross-node actually requires

All four wallets funded with 0.01 Base Sepolia ETH on 2026-09-13.

### On-chain, for real

| Step | Result |
|---|---|
| `context-graph register` | on-chain context graph **430** |
| grant published to VM | UAL `did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/4`, tx `0x16b4a73b…489f`, confirmed |
| agent profiles | both published on-chain |
| revocation published to VM | UAL `…/9`, tx `0x47827947…7b36`, confirmed in **13s** |

### The producer reads the grant from its own node

With the graph registered and the grant anchored, `mandate render` run against
the **producer's own daemon** — no `--resolver` stand-in — returns:

```
resolving grant knowledge from mandate-producer… 1 grant(s)
PERMITTED under urn:mandate:grant:bella-4a1e
authored by did:dkg:agent:0xeD1e…0B69 — a node this producer does not control
```

### Only Verifiable Memory crossed nodes — SWM did not

This overturns an assumption in the plan. The producer saw exactly one grant,
`bella-4a1e`: the one published to Verifiable Memory. Grants that existed only in
the grantor's Shared Working Memory never arrived, even though the grantor's log
shows it answering the producer's sync requests (`Sync responder SWM data …
auth=0ms`). The grantor also logs, repeatedly:

```
RFC-64 authority bootstrap incomplete for ".../mandate-grants":
  execution reverted: ERC721NonexistentToken(uint256)
```

— an on-chain authority lookup failing for the registered graph, which is the
most likely reason SWM content is not accepted by the peer.

**Consequence, and it is a correctness issue rather than a performance one:** the
plan called for revocation to be "SWM-first, chain-second" for a sub-two-second
refusal. Measured, a revocation left in SWM **never reaches the producer**:

```
Ana revokes (SWM only)  ->  producer: 0 state assertion(s) -> PERMITTED
```

A consent gate whose revocations do not propagate is worse than none. `grant`
and `revoke` now publish to Verifiable Memory, and `revoke` exits non-zero and
says so plainly if the anchor fails.

### The real revocation window: about one minute

After publishing the revocation to VM, polling the producer's own node:

```
[+17s] 0 state assertion(s) -> PERMITTED
[+32s] 0 state assertion(s) -> PERMITTED
[+47s] 0 state assertion(s) -> PERMITTED
[+62s] 1 state assertion(s) -> REFUSED — clause: not-revoked
```

13s of that is chain confirmation; the rest is durable sync. The sub-two-second
figure only ever held on a single node. This one run put the window at about 49 s
after confirmation; the later runs below measured less, so no single figure is
claimed.

---

## M6 step 3 — re-anchoring under the owned namespace

The namespace moved from `mandate.build` (not ours, does not resolve) to
`https://oojae.github.io/mandate/ns/v1#`. Existing anchored grants use the old
IRIs, so the resolver stopped recognising them — `0 grant(s)`, refused
`grant-exists` — which is the fail-closed behaviour working as designed. Every
UAL above this section is superseded.

### Producer-node run (`docs/evidence/v0.1.0/e2e-dana-5i66.json`)

| | |
|---|---|
| grant | UAL `…/12`, tx `0x69b9a2de…a738` |
| producer, own node | PERMITTED 3s after the grant anchored |
| revocation | UAL `…/13` |
| producer, own node | REFUSED — `not-revoked`, **4s** after the revocation anchored |

Anchor-to-refusal on the producer's node, stated precisely (these runs used 0.1.0):

- **At most 4 s after the revoke command returned** in `e2e-dana-5i66` (grant `…/12`,
  revocation `…/13`): the first poll after that was already refused. The log records
  it as "4s from revoke command returning".
- **27 s after the revoke command returned** in `e2e-dana-w0io` (grant `…/10`,
  revocation `…/11`), under the old `mandate.build` namespace.
- **About 49 s** in the earlier SWM-versus-VM run above: the refusal came at +62 s
  after the revoke command started, of which about 13 s was chain confirmation. That
  run left no separate log.

So the window ranged from under 4 s to about a minute, and it is unbounded if the
producer's node stops syncing, which 0.2.0 now detects.

### A peer cannot write into another party's graph

The first real-media attempt had the producer write its derivation into the
grantor's graph. It failed:

```
Unknown contextGraphId ".../mandate-grants". Write operations must target an existing context graph.
```

The producer lists the graph but holds only a stub of it — no name, no
description, no creator; `context-graph/exists` returns `false`; the
subscription reports `synced: false`. It can read the grant data anchored in
Verifiable Memory but not the graph definition, consistent with the grantor's
repeated `RFC-64 authority bootstrap incomplete … ERC721NonexistentToken`.

Resolution, and the better design regardless: **each party writes to a graph it
owns.** The producer created and registered `mandate-derivations` (on-chain
**431**); the grantor subscribed to it. Readers query both graphs.

### Real media under the new namespace (`docs/evidence/v0.1.0/media-verify-eve-e3wr.json`)

| | |
|---|---|
| grant | UAL `…/15` |
| derivation | authored and anchored on the **producer's own graph**, UAL `did:dkg:base:84532/0x8eaa…/1` |
| verify from the grantor node | **CLEAR** at +165s |
| revocation | UAL `…/16` |
| verify, same bytes | **TAINTED** |
| file re-fetched and re-hashed | unchanged, `48a2c16d…9b88` |

The run crashed between the revocation and the second verdict: the media host
closed the connection mid-download (`UND_ERR_SOCKET: other side closed`), and
`hashUrl` had no retry. The TAINTED verdict and the unchanged-bytes check were
taken afterwards against the same anchored graphs; the JSON records that
honestly rather than presenting it as one uninterrupted run.

Two more things this run does not show, noted by the adversarial review:

- **The render was not gated.** The MP4 came from the S7c spike on 12 Sep and had
  first been verified under another grant (`cara-9d2f`). The script created a new
  grant (`eve-e3wr`) on 13 Sep and wrote a derivation linking the existing file to it,
  with `derivedAt` set to the time of writing.
- **Its `billedUsd` of 0.6999** is the reservation of the failed async job
  `mjob_1cec6bfe884c`, not the cost of the inline render that produced the file
  (about $0.84 at list price for 6 s).

`demo/full.mjs` replaces this with a single gated run.

### Two verifier defects found and fixed

- **`hashUrl` gave up on one dropped connection.** It now retries transient
  network failures with backoff and still treats an HTTP error status as final.
- **The verdict depended on SPARQL row order.** The same bytes had acquired more
  than one derivation edge, and `verifyKnowledge` used `.find()` — whichever row
  came back first decided the verdict. That also allowed laundering: link the hash
  of a file made under a revoked grant to some unrelated live grant, and it could
  verify CLEAR. Every edge is now judged, sorted deterministically, and a file is
  CLEAR only if every edge is. (That fix was incomplete in 0.1.0: edges shared an
  IRI derived from the output hash, so a second `authorizedUnder` merged into the
  first edge. 0.2.0 gives every derivation its own IRI and never merges assets.)

### DKG v10.0.16 cannot publish a double quote or a line break

Publishing the ontology to the DKG failed twice with parser errors reported at
line and column positions that did not exist in our file — they were in the
node's own re-serialised output. Probe drafts (Working Memory only, no gas), one
literal each:

| Literal | Result |
|---|---|
| `"hello"` | accepted |
| `"say \"hi\""` | **rejected** — `The subject of a triple must be an IRI or a blank node` |
| `"a\nb"` | **rejected** — `Line jumps are not allowed in string literals` |
| `"a\tb"` | accepted |
| `"a\\b"` | accepted |
| `"say “hi”"` | accepted |
| `"it's"` | accepted |

Correctly escaped input is unescaped by the node and re-serialised to N-Quads
without re-escaping, which it then cannot parse. Consequences in Mandate:

- The ontology uses single-line literals and typographic quotes.
- `src/rdf.mjs` refuses a literal containing `"` or a line break with an
  `UnpublishableLiteralError` naming the field. It never rewrites the value —
  silently altering someone's consent transcript would be worse than failing.

### The ontology is on the DKG

Published into the **system `ontology` context graph** — the registry intended
for shared vocabularies — and anchored:

- UAL `did:dkg:base:84532/0xed1eeb64cac09874257f05fd6b51a55695ad0b69/26`
- tx `0x94ba6ea19e437c7afefbe920052a9069a1810554145c637bcad173a0f5f1dbaa`
- 154 triples, Merkle root `0xc2efbb47…0046`

Queried from the **producer's** node on the first attempt:

```
SELECT ?label WHERE { mandate:stateAuthor rdfs:label ?label }   ->   "state author"
```

---

## Livepeer Agent retired Daydream `sk_` keys (2026-09-13)

A freshly created Daydream `sk_` key, well-formed (67 characters, no whitespace),
was rejected before any tool ran. The MCP transport itself returned 401:

```
Daydream `sk_` API keys are retired and can no longer pay for inference on this network.
Use a pymthouse composite key instead — Authorization: Bearer app_<appId>_pmth_<token>
(see docs/pymthouse-oauth.SKILL.md to mint one). Retrying with an sk_ key will fail identically.
```

What that means in practice:

- **A present-but-retired key is worse than no key.** With it in `.env`, every
  Livepeer call Mandate makes fails at connection time, including calls that work
  keyless. Removing it restored `describe_capability` and `request_upload`
  immediately.
- **The platform contradicts itself.** The keyless `me` response still says to get a
  key "at https://app.daydream.live", and the hackathon's get-started page still
  documents `sk_` keys.
- **The replacement is not self-serve.** PymtHouse is a billing and identity
  platform for developer apps. Its quickstart says the `app_…` client id and
  `pmth_…` credentials come from "your registered developer app … ask your platform
  admin". The referenced `pymthouse-oauth.SKILL.md` is not published at any
  `agent.livepeer.org` path we tried, and the public Livepeer Agent source
  (`eliteprox/storyboard`, `lib/mcp-server/key-validation.ts`) still lists `sk_` as
  an accepted scheme, so the live deployment is ahead of its public code.

Consequences: Mandate runs entirely on the keyless demo tier, which is unaffected.
The only thing blocked is publishing the community skill under an owner key.
`scripts/publish-skill.mjs` now refuses an `sk_` key with that explanation instead
of failing with an opaque 401.

## DKG v10.0.16 leaves whole named graphs out of query results (2026-09-13)

Found while capturing resolver fixtures (`scripts/capture-fixtures.mjs`,
`test/fixtures/live/*.json`, which record every observed row count). Identical
read-only `POST /api/query` requests, seconds apart, with no writes in between:

| Node | Query | Row counts over repeated requests |
|---|---|---|
| grantor (publisher) | one KA's graph, read explicitly | full in 6 of 8, **0** in 2 of 8 |
| producer (synced) | `_meta`, filtered to one publisher | 125, **0**, 125, **0** |
| producer | `COUNT(DISTINCT ?g)` over a publisher prefix | **0**, 1, **0**, 1 |
| producer | whole publisher prefix | **0**, 77, 77 |

A graph is either returned whole or not at all; nothing is invented. The likely
cause is in `dkg-storage/dist/graph-set-index-store.js`: the index of which named
graphs exist drops a graph after a failed existence probe, so a query sees an
incomplete graph set until the index recovers.

For Mandate this is a correctness problem, not a performance one. A read that
silently omits the graph holding a revocation looks exactly like a grant that was
never revoked. `src/resolve.mjs` therefore:

- reads one publisher's Verifiable Memory at a time, together with its `_meta`
  anchors and the node's own graph count;
- merges repeated attempts (safe, because anchored data is append-only and the
  fault only omits);
- accepts the read only when every anchored graph returned exactly the
  `publicTripleCount` its anchor declares, no graph lacks an anchor, the graph
  count matches, and every anchor this machine has seen before (`~/.mandate/state`)
  is still present;
- believes an empty answer only when every attempt agrees.

Otherwise the gate refuses with `read-inconsistent` and the verifier answers
`INCONCLUSIVE`. With four attempts, live reads on both nodes settle within 2–9
seconds. `test/resolve.test.mjs` replays the fault.

## S6c — forgery from the producer's own node, live (2026-09-13)

The adversarial study showed that v0.1.0 believed self-declared authors. This spike
runs that attack on Base Sepolia against the 0.2.0 resolver
([`spikes/s6c-forgery.mjs`](../spikes/s6c-forgery.mjs); full record in
[`docs/evidence/s6c-forgery.json`](evidence/s6c-forgery.json) and
[`.txt`](evidence/s6c-forgery.txt)).

**Genuine, from the grantor's node, through the CLI** (subject `0xed1e…0b69:ana-s6c`):

| | UAL | tx |
|---|---|---|
| grant G1 (`talking-head`) | `…0b69/27` | `0xaedb52c8…6e44fd2` |
| grant G2 (`talking-head`) | `…0b69/28` | `0xf1bd5875…fa4b34` |
| revoke G1 | `…0b69/29` | `0x61636412…c74d39` |

**Forged, from the producer's node, straight to the DKG API.** All three were written
to name the grantor or its subject, and use the grantor's own id format:

| | What it claims | UAL | tx |
|---|---|---|---|
| a | G1 is `active` again, `stateAuthor` = the grantor's DID | `…0cb5/3` | `0xaedeab9c…deebd0` |
| b | a grant for `ana-s6c`, `grantor` = the grantor's DID, permitting `face-swap-video`, $1000 ceiling | `…0cb5/4` | `0xd18895bd…aa3adf` |
| c | a grant for `ana-s6c`, `grantor` = the producer, permitting `face-swap-video` | `…0cb5/6` | `0x56411263…a943e0d` |

**Result.** The committed record ([`s6c-forgery.txt`](evidence/s6c-forgery.txt))
holds reads from all three nodes, re-recorded on 14 Sep with `--reread`. The
verifier has never published anything.

| Request | Grantor node | Producer node | Verifier node |
|---|---|---|---|
| `talking-head` for `ana-s6c` | PERMITTED under G2 only | PERMITTED under G2 only | PERMITTED under G2 only |
| `face-swap-video` for `ana-s6c` | REFUSED `capability-permitted` | REFUSED `capability-permitted` | REFUSED `capability-permitted` |
| G1 revoked? | yes, despite (a) | yes, despite (a) | yes, despite (a) |
| forgeries reported | 3, with UAL and publisher (plus `legacy-format` `…0cb5/1`, below) | the same | the same |

Under the current resolver the same reads list a fourth rejected record, `…0cb5/1`:
the producer's own derivation from the 0.1.0 media run, whose id is in the 0.1.0
format. A trusted producer's record that cannot be read is now a trusted
`legacy-format` record rather than a warning, so a file it names verifies
`TAINTED / MALFORMED`. The three forgeries are still rejected.

Three more things this run established:

- **A peer cannot anchor into another party's context graph, even an open one.**
  The producer's node sealed (a) and (c) into the grantor's graph (`201 wm-sealed`),
  then failed every share with `A promote prerequisite is temporarily unavailable`,
  including after retries (`test/fixtures/live/s6c-producer-writes.json`). Its
  node holds only a stub of that graph. The forgeries therefore went into the
  producer's own graph, where the resolver reports them as `misplaced-grant` and
  `misplaced-state`. The resolver would reject them in the grants graph as well
  (`grant-not-by-subject`, `state-not-by-grantor`; see `test/adversarial.test.mjs`),
  but that path could not be exercised live from this node.
- **A subscribed node can silently stop receiving another party's anchors.** After
  a restart the producer stayed at 9 of the grantor's assets for over ten minutes,
  with `synced: false`, while the grantor kept receiving the producer's. Its reads
  were internally consistent, just stale. `POST /api/context-graph/reconcile`
  confirmed it (`headOrdinal 12`, `watermark 9`, `unresolvedOrdinals 3`) but could
  not fetch them. `POST /api/context-graph/fetch-assets` with the UALs and the
  grantor's peer id fetched all three in 13.5 s. A stale node refusing is luck; a
  stale node missing only a revocation would permit. This is the case for a
  freshness check against the chain's head ordinal.
- **Not every confirmed anchor records a transaction.** `…0cb5/4` was confirmed on
  the `finalized-materialization` lane and its `_meta` has no `transactionHash`,
  although the publish response returned one.

## A third, read-only verifier node (2026-09-13)

`node scripts/nodes.mjs up verifier` stood up `mandate-verifier` on :9203 from an
empty home: it wrote a four-line `config.json`, started the daemon, subscribed to
graphs 430 and 431, dialled the other two nodes, and caught up with the chain. It
has an agent identity (`0xacD6…C9CA`) and no funded wallet, and it never
publishes. `mandate verify` now reads from it by default.

What it took, for anyone repeating it:

- **The first boot takes about two minutes** before the API binds; `dkg start`
  itself gives up waiting after 15 s while the daemon keeps starting.
- **Public Base Sepolia RPC endpoints time out often.** The new node's context
  graph authority bootstrap failed on all three default endpoints at first
  (`getContextGraphAuthoritySnapshot … TIMEOUT`), and until it succeeded,
  `subscribe` answered `503 … read authority is temporarily unavailable` and
  `reconcile` answered `404 … does not exist or is not subscribed locally`. Both
  cleared on their own within minutes.
- **`reconcile` is the freshness signal.** It reports `headOrdinal` (assets bound
  to the graph on-chain) and the node's watermark, in about 2 s when current. The
  resolver now calls it before every CLI decision; a node behind the chain is an
  inconsistent read.
- **`fetch-assets` is strict:** 1–10 UALs per request, and one UAL that belongs to
  another graph (`409 … is not registered to a Context Graph`) or has no coherent
  version snapshot fails the whole request. In this run the node's own
  chain-driven reconciliation, not the probes, brought it from 0 to 12/12 and 4/4
  in about ten minutes.

On 13 Sep the verifier then resolved the S6c subject in 16 s with the same verdict as
the other two nodes; that first read was observed, not saved. The 14 Sep `--reread`
recorded a verifier read with the same verdict, which is the one in the S6c table above
and in [`s6c-forgery.txt`](evidence/s6c-forgery.txt).
