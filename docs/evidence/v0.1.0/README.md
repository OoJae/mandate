# Runs recorded with v0.1.0

Kept as a record. These runs used the v0.1.0 resolver, which trusted
self-declared authors (see the security notice in the main README), and the
scripts that produced them have been replaced by [`demo/full.mjs`](../../../demo/full.mjs).

- `e2e-dana-w0io.json` — grant, producer PERMITTED, revoke, producer REFUSED, on
  two nodes, under the old `mandate.build` namespace (grant UAL `…0b69/10`,
  revocation `…0b69/11`). Refused 27 s after the revoke command returned.
- `e2e-dana-5i66.json` — the same flow after the namespace moved to
  `https://oojae.github.io/mandate/ns/v1#` (grant UAL `…0b69/12`, revocation
  `…0b69/13`). Refused at most 4 s after the revoke command returned. The files
  label both figures "cross-node revocation latency"; they are measured on the
  producer's own node from the moment the grantor's revoke command returned.
- `media-verify-eve-e3wr.json` — a real `sync-lipsync-v3` render verified CLEAR,
  then TAINTED after revocation (grant `…0b69/15`, derivation `…0cb5/1`, revocation
  `…0b69/16`). The render itself was not gated: the MP4 came from a spike on
  12 Sep and had first been verified under another grant (`cara-9d2f`). The script
  created grant `eve-e3wr` on 13 Sep and wrote a derivation linking the existing file
  to it, with `derivedAt` set to the time of writing. The run crashed downloading the
  file between the revocation and the second verdict, which was taken afterwards
  against the same anchored graphs. Its `billedUsd` of 0.6999 was a failed async
  job's reservation, not the cost of this render.

Under 0.2.0 the derivation `…0cb5/1` has a 0.1.0-format id, so the resolver reports
it as a trusted `legacy-format` record and the file verifies `TAINTED / MALFORMED`.
