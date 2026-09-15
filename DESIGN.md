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
| **Verifier** — a distributor, platform or auditor | a read-only node | hashes a delivered file and follows the graph; accepts it only if it verifies CLEAR, and treats UNKNOWN as unverified |

Each party writes only to a graph it owns. This is least authority by construction.
It also matches what was observed in S6c: the producer's node could seal an asset into
the grantor's graph, but all four attempts to share each of two such assets were
refused with "A promote prerequisite is temporarily unavailable". That is one run's
observation, not a guarantee from the network, and nothing depends on it: a grant or
revocation anchored by the wrong address is rejected wherever it sits
(`test/adversarial.test.mjs`).

**Custody.** The grantor node holds a signing key on the depicted person's behalf. In
practice that is an agency, a union or a hosted consent service; the person only
opens a phone link and records a clip. Mandate does not prescribe who.

## The gate is opt-in

The gate binds only producers that choose to run it. A producer that calls Livepeer
directly spends nothing on Mandate and is not stopped; its files have no derivation and
verify UNKNOWN. So the gate is half of the design and the verifier is the other half:
enforcement happens where files are accepted, by rejecting anything that does not
verify CLEAR. Binding every producer would take a check inside Livepeer's own dispatch
(see "Known limits and next steps").

## Trust assumption

A verifier trusts:

1. **The chain**, for which address anchored each Knowledge Asset. The Knowledge
   Asset id is `(author << 96) | n`, and its Verifiable Memory graph is
   `…/_verifiable_memory/<author>/<n>`.
2. **Its own DKG node**, to report that graph and its `_meta` anchor faithfully. The
   resolver does not trust the node to return everything: it checks each read for
   completeness and, when the node's admin token allows it, compares the node's copy
   with the chain head.
3. **A list of producers**, whose derivation records it is willing to believe, and
   **a list of grants graphs** to read their grants from. Both are this machine's
   configuration: the environment plus one env file (`--env-path`, else
   `MANDATE_ENV_FILE`, else `~/.mandate/.env`). A `.env` in the working directory is never
   read, because a folder someone sends a verifier must not choose whom it trusts, and
   `status` and `verify` print the file, the trusted producers, the graphs and the
   freshness setting in effect.

It trusts nothing written inside the graph about authorship. `mandate:grantor` and
`mandate:stateAuthor` are descriptive; a grant whose `mandate:grantor` disagrees with
the anchoring address is rejected.

## How the DKG v10 memory model is used

- **Context Graphs.** Two user graphs, each registered on-chain by its owner (Base
  Sepolia, graphs 430 and 431), plus the system `ontology` graph for the vocabulary.
  A reader may be configured with several of each.
- **Knowledge Assets.** Every grant, revocation and derivation is its own Knowledge
  Asset with its own IRI, written through the node's HTTP API: create and seal in
  Working Memory, share to Shared Working Memory, publish to Verifiable Memory. A
  write is reported as done only when the chain has confirmed it and it is bound to
  the graph; a minted but unbound asset is a failure that names its UAL and
  transaction. Only a publish refused with a 4xx is known to have sent nothing. Any
  other failure (a 5xx, a lost connection, a `200` that is not confirmed) is treated as
  possibly sent: success is reported only if the node's record shows a chain-confirmed
  UAL for the sealed content and a `_meta` anchor that passes the resolver's own anchor
  rules. A `mandate record --pending` retry of a derivation resumes the same asset
  rather than minting another, and never publishes again after a publish whose outcome
  is unknown: it waits for the node to show the asset published, and then only verifies
  it. A grant or revocation whose outcome is unknown is reported with its id and asset
  name, so the operator checks that exact id instead of publishing a second one.
- **`_meta`.** Each anchored asset's record (`kaUal`, `status "confirmed"`,
  `assertionGraph`, `publicTripleCount`, `transactionHash`) is what the resolver
  checks a graph against. `prov:wasAttributedTo` exists only on the publishing node,
  so authorship comes from the graph path.
- **Reconcile.** `POST /api/context-graph/reconcile` reports how many assets are bound
  to a graph on-chain and how many the node holds. The CLI calls it before every
  decision, which needs the node's admin token.

## Promotion path

| Stage | What | Why it stops or continues |
|---|---|---|
| **Working Memory** | Clause data, hashes and identifiers are written and sealed on the authoring node. Consent video, reference images, prompts and media never enter the DKG; they go to Livepeer Agent and its providers to be transcribed and rendered. | Only clause data proceeds. |
| **Shared Working Memory** | The sealed asset is shared to the owning graph. | A staging step. Measured: SWM content for these graphs did not reach the other party, and SWM paths are not authenticated. A revocation seen only in SWM is a warning, never a decision. |
| **Verifiable Memory** | Grants, revocations and derivations are published and anchored. | Required. Only anchored assets can permit a render or clear a file. |

## Consent evidence

A grant is the grantor's statement. The consent clip is the evidence behind it, and the
design keeps two kinds of evidence apart:

- **Checked by construction.** The CLI generates a script from the grant's own terms,
  and the person reads it on their phone. A transcript that is a reading of that script
  (word for word after normalising ASR spellings, with every term, the date and the
  amount exact, at most two of the joining words `to`, `of`, `for`, `in`, `and`, `is`,
  `at` missing, nothing extra but a greeting or an article (`hi`, `hello`, `a`, `an`,
  `the`), and heard as affirmative first-person consent) is confirmed without anyone
  judging what the words mean. The ignorable words are the ones that cannot say no in any
  combination. Hesitation sounds (`um`, `uh`, `mm`, `hmm`) and `yes`, `yeah`, `okay`, `so`,
  `well` and `hey` are not ignorable: `uh-uh` and `mm-mm` are a spoken "no", and a clip
  with any of them goes to a person. Only such a grant carries `mandate:consentClipSha256`.
- **Judged by a person.** Anything else, however consent-like, is unconfirmed. The CLI
  shows the whole transcript, never a cut one, and refuses (re-record) a transcript over
  4000 characters or with 50 or more words outside the script, because nobody can be asked
  to confirm words they were not shown. An operator watching the clip must type that the
  transcript is accurate, that it is consent to exactly these terms with no condition,
  exclusion, coercion or retraction, and each term the words were not compared with. That
  grant is published without the clip hash.

Refusal heuristics sit beside both. They can stop a clip outright (a refusal, exclusion,
retraction or sign of coercion anywhere), but never confirm one: no list of the ways
people decline is complete, so an open-world check that passes is not evidence of
consent.

## The rules a resolver must follow

1. **Authorship is the anchoring address.** A grant counts only when anchored by the
   address in its subject (`0x<address>:<name>`), which must also be the address in
   its id and its `mandate:grantor`; a revocation only when anchored by the address
   that anchored its grant; a derivation only when anchored by a trusted producer.
   Anything else is reported as a forgery, with its UAL.
2. **Knowledge Assets never merge.** Objects are grouped per asset and per subject;
   a duplicated single-valued property makes the object malformed. A grant id
   published more than once is refused.
3. **Revocation is terminal.** Any counted revocation ends a grant, even one whose
   other fields are malformed, and even one also typed as something else. A revocation
   that appears only in a merged view with no Verifiable Memory copy is honoured,
   because its publisher cannot be established. A node can leave that view out of an
   answer. When the grantor has published a state about the grant, the resolver requires
   the view once the node has shown it, and believes "no view" only when the node's probe
   for it answered empty on every attempt. A node that leaves the view out of every
   answer on every attempt cannot be told apart from one that holds none. The check
   assumes one merged view graph per context graph, as live nodes build: several view
   graphs showing on different attempts make the read inconsistent, but one left out of
   every attempt while another shows is not caught (`docs/CONTRACTS.md`, "Read
   consistency"). Only a Verifiable Memory copy under the grant owner's prefix explains a
   view row away.
4. **Capabilities match exactly**, never by family, and **a forbid beats a permit**.
   Requests whose declared use-class label is on the deny list (adult, sexual,
   deceptive impersonation and synonyms, matched through common inflections, joined
   words and prohibited stems inside a word) are refused whatever a grant says. This checks the label a producer declares;
   it cannot see the prompt or the media.
5. **Every trusted derivation for a file is judged.** A file is TAINTED if any trusted
   record is (including a trusted producer's record that cannot be read), otherwise
   UNKNOWN if any cites a grant in a grants graph the verifier does not read, otherwise
   CLEAR. A new grant can authorise new renders; it cannot clear an artifact whose
   authorisation was withdrawn.
6. **The gate fails closed.** A malformed request, a failed, truncated, partial or
   empty-after-errors read, an overflowing discovery query, a node behind the chain,
   an unreadable date or ceiling, and, under a ceiling, an unknown cost or an unreadable
   trusted record under the grant all refuse. The verifier answers INCONCLUSIVE instead
   of guessing. One gap remains by construction, the **revocation window**: a read that
   is complete but comes from a node that has not yet received a revocation still
   permits. The freshness check narrows it to the time before the revocation is bound
   on-chain, but only when it can run; with a token that lacks admin rights it is a
   warning, and with the check turned off every read says `freshness not checked`.
   The spend ceiling is decided one render at a time per grant on one machine: a render
   takes the grant's lock, decides again with this machine's pending renders counted, and
   saves its record before releasing it. Renders on other machines count only once their
   derivations are read from the graph, so the ceiling is not enforced across machines
   running at the same time, and a per-second estimate relies on the `--seconds` the
   operator typed.
7. **CLEAR is narrower than a permit.** A derivation records the output hash, the
   serving capability, the grant and the render time. So CLEAR establishes the grant's
   publisher, that it is not revoked, the capability, and the validity window (now and
   the producer-recorded render time), and says nothing about use class, territory,
   prohibited uses or the spend ceiling. Those are the gate's alone. EXPIRED means the
   grant lapsed after a render recorded inside its window, not that consent was
   withdrawn.

The provenance reducer (`src/provenance.mjs`), the gate (`src/gate.mjs`) and the
verifier (`src/verify-core.mjs`) are pure functions, so these rules can be read and
tested in isolation. The attacks from the adversarial study are replayed as tests in
`test/adversarial.test.mjs` and the unit tests beside it, and `npm run test:mutation`
removes each security guard listed in `scripts/mutations.json` in turn and fails if no
test notices. A mutant whose tests only hang or time out counts as a failure, not a
kill, so every such test carries a deadline of its own. The list also covers the
checker's own rules (including how `runMutant` treats a hang, and that the CI shards
together run every entry) and the workflow promises. The check takes `--budget-minutes`
for the whole run: a mutant it could not reach or finish inside the budget is reported
UNFINISHED, never killed or a timeout, and fails the run, so a slow CI shard cannot pass
by being cut off. `test/release.test.mjs` parses both
workflows with a strict parser for the YAML subset they use (anchors, flow mappings and
duplicate keys are refused) and checks their structure, not lines of text: every action
pinned to a commit and no checkout keeping credentials; allow-lists for the keys at every
level (workflow, job, step, `with`, strategy), so no top-level `env`, `container`,
`services` or `working-directory` gets in, every job runs on `ubuntu-latest`, and a step's
`env` may only carry the pack job's tarball name and digest; no `if:`, `continue-on-error`,
`shell` or `defaults` that could let a failing step pass; step lists compared by their
`run` commands, never by a step's name; and a scan of every run that refuses `||`, a
background `&`, `set +`/`set -`, `trap`, `nohup`, `disown`, `eval`, `exec`, a forced success
(`true`, `:`, `exit 0`), writes to `GITHUB_ENV`, `GITHUB_PATH` or `.npmrc`, and any pipe
that does not end in the digest check, `wc -l` or `cut`; pack runs only the listed pack commands after a lifecycle-script guard
that the test executes against each hook; test repacks and checks the digest before
installing with `--ignore-scripts`; publish needs pack and test, runs in the `npm`
environment, holds the only `id-token`, installs nothing but the pinned npm, and
publishes the checked tarball; and CI's namespace documents check, run in a scratch git
repository, fails on a modified or untracked file. What the parser does not model (how
GitHub evaluates expressions, or a repository setting such as the `npm` environment's
reviewers) is not checked.

## Security

- **Network egress:**
  - `agent.livepeer.org` (Livepeer Agent MCP), which receives the consent clip,
    reference media URLs and prompts, and returns render outputs.
  - The local DKG nodes.
  - Media URLs that are hashed: those an operator passes to `verify`, the output URLs
    Livepeer returns, and the uploaded consent clip's URL from `get_upload`. Hashing
    streams with one size cap and one deadline across retries, and accepts http(s)
    only. It does not restrict hosts and follows redirects, so run it where internal
    services are unreachable, or pass a `fetch` that enforces an allow-list.
  - A transcript link returned by `nemotron-asr`: https only (plain http to loopback
    alone), never the clip itself, declared as text or JSON, capped at 1 MB.
- **Credentials:** each DKG node's API token, read from its home, and an optional
  `LIVEPEER_AGENT_KEY`. The CLI's freshness check calls `reconcile` with the node's
  token on every decision, so that token needs node-admin rights for the check to run.
  Mandate never reads wallet keystores. Only `MANDATE_*` keys and `LIVEPEER_AGENT_KEY`
  are read from the env file, by the CLI, `scripts/nodes.mjs`,
  `scripts/publish-skill.mjs`, `scripts/publish-ontology.mjs` and the live spikes. That file is the one named with `--env-path`, else by
  `MANDATE_ENV_FILE`, else `$MANDATE_HOME/.env` (`~/.mandate/.env`); a `.env` in the
  working directory is never read. A group- or world-writable env file is loaded with a
  warning. `--env-file` is refused: Node.js reads that flag itself from anywhere on the
  command line and would apply a `NODE_OPTIONS` from the file before Mandate runs.
- **Write authority:** the Knowledge Asset routes on the operator's own nodes, and
  Verifiable Memory publishing for grants, revocations and derivations. Setup uses
  `context-graph create`, `register` and `subscribe`; `scripts/nodes.mjs` also calls
  `reconcile` and `fetch-assets`. `scripts/publish-ontology.mjs` publishes the
  vocabulary from the grantor's node into the DKG's shared system `ontology` graph,
  which the grantor does not own; it is run once per vocabulary version, by hand.
- **Local state:** `~/.mandate/state` holds the anchors and revocations already seen,
  and `~/.mandate/pending` the renders in flight, with a lock file per grant (the
  ceiling decision) and a lease file per render key (held for a render's or record's
  whole life, so a second process on the same key exits 5 at once). Those two directories
  are set to mode 0700 and their files to 0600. `~/.mandate` itself is never changed, so
  one that already exists keeps its mode; `~/.mandate/.env` is the operator's, and should
  be `chmod 600`.
- **Package:** no install scripts and no runtime dependencies in the core. CI's
  `npm audit --omit=dev --omit=peer` therefore covers nothing beyond the package itself.
  The optional peer (`@modelcontextprotocol/sdk`) is audited by whoever installs it.
  The DKG node (`@origintrail-official/dkg`, a dev dependency used to run local nodes)
  carries advisories in its own dependency tree (libp2p gossipsub, undici, jsonld at
  the time of writing); they affect the nodes an operator runs, not the published
  package.
- **Releases:** `.github/workflows/release.yml` packs the tarball straight from the
  tagged checkout, before anything is installed and with lifecycle scripts refused, and
  records its SHA-256. No dependency code has run when the digest is fixed. A separate
  test job repacks its own clean checkout, requires the same digest, then installs with
  `--ignore-scripts` and runs the tests. It uploads nothing. The publish job, in the
  protected `npm` environment with the only `id-token` permission, installs nothing from
  the project and publishes the packed tarball, fetched by artifact id and checked
  against the digest, with provenance. The repack check assumes `npm pack` is
  reproducible, and fails closed if it is not.

## Known limits and next steps

- **Opt-in gate.** Next: a Livepeer-side pre-flight, where `run_capability` for a
  likeness capability requires a `consent_ual` and dispatches only if it resolves to a
  live grant. That needs Livepeer; Mandate cannot add it from outside.
- **Producer binding.** A grant does not name the producers allowed to render under it.
  Next: a `mandate:permitsProducer` list, checked against the derivation's anchoring
  address.
- **Discovery.** A verifier is configured with the graphs and producers it reads. Next:
  a directory graph where producers announce their derivations graphs, and the
  derivation UAL carried in C2PA or XMP metadata as a pointer.
- **Exact bytes.** Verification is by SHA-256 of the delivered file, for the intake hop,
  and a grant's blast radius lists exact bytes only: a re-encoded copy of a file made
  under a revoked grant is not on the list. Next: a perceptual hint that can only raise
  suspicion (flag a likely re-encode of a recorded file for review), never clear a file.
- **Revocation timing and action.** A render made before a revocation and one recorded
  after it both verify TAINTED / REVOKED, and nothing tells anyone holding a file that its
  grant was revoked. Next: split the verdict by the recorded render time against the
  revocation's anchor, and a `watch` command that re-verifies accepted files.
- **Renders made outside the gate cannot be recorded.** `mandate record` finishes only a
  render `render --execute` started. Next: `mandate record --url --grant --capability`.
- **Verifier independence is configuration.** Nothing checks that the node a verifier
  reads from is not the producer's own.
- **Unknown mints.** A publish whose answer was lost, and that the node never shows as
  published, is left unpublished and reported with its asset and any transaction; a mint
  the node never records cannot be found from this client.
- **DKG literal handling.** v10.0.16 cannot publish a double quote or a line break in a
  literal. Mandate refuses such values rather than rewriting them.
- **The ceiling across machines.** Locks and pending records are per machine (per
  `MANDATE_HOME`), so renders under one grant on several machines at once can exceed the
  ceiling until their derivations sync.
- **Operator-typed durations.** Under a ceiling a per-second estimate uses `--seconds` as
  typed; it is never sent to Livepeer. The CLI warns, and the recorded spend is unknown
  unless the platform reports a cost.
- **Consent matching.** A spoken "no" made of sounds (`uh-uh`) is never confirmed
  automatically, but the refusal heuristics do not flag it, so on the typed path the
  operator is what catches it.
