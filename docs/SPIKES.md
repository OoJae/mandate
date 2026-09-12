# Day-zero spike results

Every claim below was produced by running the thing, not by reading documentation.
Raw fixtures are in `spikes/out/`.

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

The node will not sign for an agent whose key it does not hold. Two consequences
worth stating plainly in the README:

1. The "written by the depicted person, not the renderer" claim is enforced by
   the node, not merely asserted by the schema.
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
