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
