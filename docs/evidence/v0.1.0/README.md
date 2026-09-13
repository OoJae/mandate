# Runs recorded with v0.1.0

Kept as a record. These runs used the v0.1.0 resolver, which trusted
self-declared authors (see the security notice in the main README), and the
scripts that produced them have been replaced by [`demo/full.mjs`](../../../demo/full.mjs).

- `e2e-dana-5i66.json`, `e2e-dana-w0io.json` — grant, producer PERMITTED, revoke,
  producer REFUSED, on two nodes (grant UAL `…0b69/12`, revocation `…0b69/13`).
- `media-verify-eve-e3wr.json` — a real `sync-lipsync-v3` render verified CLEAR,
  then TAINTED after revocation. The render itself was not gated (it came from a
  spike), and the derivation was recorded by hand.
