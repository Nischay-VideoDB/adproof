# AdProof — evidence-first campaign verification

Proves one thing end to end: **a real video can be ingested into VideoDB,
indexed for speech and vision, searched for real timestamped evidence,
deterministically evaluated, and reviewed by opening the real video at the
retrieved moment** — with processing, empty-result, and failure states all
represented honestly.

Provider behaviour was verified before implementation. See
[`../docs/VIDEODB_VERIFIED_BEHAVIOR.md`](../docs/VIDEODB_VERIFIED_BEHAVIOR.md).

## What is in the hosted product

The production app includes authenticated, workspace-isolated campaigns;
nine structured rule types; URL submission; durable Postgres jobs; real
VideoDB speech and focused visual indexes; timestamped evidence and proxied
HLS playback; confirm/override review actions; request-changes, escalation,
approval and rejection decisions; audit history; revision drafts; and campaign
analytics.

Public visitors and authenticated operators use the same application URL:

- With no account session, `/app` automatically issues a stable guest session
  with analyst access to two completed, provider-backed creator product reviews:
  Biossance eye cream and Nank swimming headphones. Each source carries its
  reuse terms and no-endorsement notice.
- Creating a campaign or adding a submission opens login in context. Successful
  login replaces the guest cookie and resumes the requested action against the
  operator's persistent private workspace.

The showcase is additive. It does not replace or disable the live workflow.

There is **no fixture data anywhere in this build.** `EvidenceOrigin` has a
single member, `live_provider`, so fixture evidence is not representable. If
VideoDB is unavailable, processing fails visibly and no report is produced.

## Setup

```bash
python3 -m venv .venv && ./.venv/bin/pip install -e ".[dev]"
createdb adproof
cp .env.example .env      # then set VIDEODB_API_KEY
```

## Verify the provider first (recommended)

```bash
VIDEODB_API_KEY=... ./.venv/bin/python scripts/verify_videodb_spike.py \
  "https://example.com/your-video.mp4" "a phrase in the audio" "something visible"
```

Prints the real provider responses and resolves the open assumptions listed in
`VIDEODB_VERIFIED_BEHAVIOR.md` s4. It writes nothing to the database.

## Run locally

The local developer workflow uses two processes because provider calls block.
The Vercel route drains one bounded durable job chain inside the request.

```bash
# terminal 1 — API + UI
VIDEODB_API_KEY=... ./.venv/bin/uvicorn adproof.api.main:app --reload

# terminal 2 — worker
VIDEODB_API_KEY=... ./.venv/bin/python -m adproof.orchestrator.worker

# terminal 3 — seed one campaign + submission
./.venv/bin/python scripts/seed_slice.py "https://example.com/video.mp4" \
    --phrase AYUSH20 --concept "PulseBar protein bar package" --seconds 6
```

Open <http://127.0.0.1:8000/> and select the submission.

Expect ingestion and indexing to take minutes. Visual indexing runs a VLM over
a frame every 2 seconds, so cost scales with video length — start short.

## Populate the production showcase

With production credentials exported, run:

```bash
./.venv/bin/python scripts/seed_showcase.py --apply
```

The command is idempotent. It creates two curated creator-review campaigns,
submits the frozen reuse-permitted source files through the normal authenticated
upload API, and invokes the same durable VideoDB worker used by private
submissions. The seeder creates only input-side workspace, identity, campaign,
rule, submission, and source-attribution records. It never constructs evidence,
retrieval runs, evaluation results, reviews, decisions, timestamps, states, or
evidence IDs. Curator reviews and decisions are appended separately after the
real reports and playback are inspected. Configure
`ADPROOF_SHOWCASE_WORKSPACE_ID` to the fully validated workspace ID it prints.

### Showcase reproducibility boundary

Rule evaluation is deterministic given the same persisted evidence: the pure
`evaluation/` package has no network or model access. A fresh provider upload or
re-index is not promised to reproduce the same candidate set, scene boundaries,
or model verdict because VideoDB and the verdict model may return different
retrieval candidates. The immutable retrieval receipt records what each run
actually used; the append-only human review stays separate from the machine
result.

Two independent Biossance provider runs were compared without rerunning either
source. Their measured-value vector matched exactly
`[1, 2, 0, 0, 0, null, 0, null]`; seven of eight final machine states matched.
The application-event rule was `fail` in the first run and `uncertain` in the
second as the provider/model candidate layer varied. Evidence counts were 47
and 46. This is an observed example of the boundary above, not a result tuned by
the showcase seeder.

### Prepared playback for fixed saved runs

Public saved runs never generate a provider stream in response to a viewer.
The server derives a manifest from immutable `EvaluationResult.evidence_ids`
plus append-only `RuleReview.evidence_viewed`, deduplicates identical padded
windows, and resolves only the exact frozen entries in the sensitive
`ADPROOF_SHOWCASE_PLAYBACK_REGISTRY_JSON` server environment through the
principal/asset-bound AdProof proxy. The public repository and client bundles
contain no provider locators. Private workspaces retain lazy clip generation.

The current release contract is 22 cited evidence references, 21 unique clip
windows, two full sources, and manifest SHA-256
`68e48c51e0cf854037158bdfe9949bb3692227d2c098e2c2de28f7c82a9e5e58`.
Each frozen entry also carries a server-only digest of its VideoDB
video/collection binding. A production cold start fails closed unless the
configured workspace, live DB citation graph (22 references / 21 clips / two
sources), manifest hash, exact 23-entry registry, asset/window bindings, and
provider-binding digests all agree.
Operations are explicit:

```bash
# zero writes and zero provider calls
./.venv/bin/python scripts/prepare_showcase_playback.py --inspect

# validate every prepared HLS chain; zero writes and zero provider generation
./.venv/bin/python scripts/prepare_showcase_playback.py --health-check

# mandatory manifest/registry release gate; zero provider calls and zero writes
./.venv/bin/python scripts/prepare_showcase_playback.py
```

VideoDB's live Generate Video Stream API reference says stream URLs remain
valid while the video is stored and that existing streams are returned without
reprocessing. AdProof does not infer validity from elapsed time. Provider
locators remain in one encrypted Vercel server environment value, playback
stays behind the scoped proxy, and release operations run the pinned registry
gate plus the explicit read-only HLS health check. Browser traffic never invokes
provider generation. If a stored video is removed or a health check fails, an
operator must prepare and validate a replacement registry outside the request
path before changing the sensitive environment value.

## Tests

```bash
createdb adproof_test
./.venv/bin/python -m pytest
```

Postgres-backed tests skip automatically if no database is reachable. Schema,
authorization, and advisory-lock changes require a fresh isolated Postgres run.

| File | Covers |
| --- | --- |
| `test_intervals.py` | merge, dedupe, clamping, idempotency, no double counting |
| `test_evaluators.py` | pass/fail paths, every absence class, every absence policy |
| `test_integrity.py` | no fixture fallback, no invented SDK usage, measurement purity, mandatory provenance, forbidden UI language |
| `test_persistence.py` | idempotency and DB-enforced immutability |
| `test_api.py` | contracts, plus a provider failure driven through the real worker |

## Architecture

```
api/main.py         HTTP + integrity disclosure + static UI
orchestrator/       durable job queue; blocking provider calls run here
  jobs.py           claim/succeed/fail, bounded retries, dedupe
  steps.py          ingest → index → retrieve → evaluate
  worker.py         loop; one transaction per job
providers/          the ONLY module importing the VideoDB SDK
retrieval/plan.py   rule → versioned, reproducible searches
evaluation/         PURE. intervals, absence, confidence, evaluators
models.py           schema; immutability enforced by DB triggers
```

Pipeline stages are chained forward only after genuine success, so no stage can
appear to start on the strength of a stage that failed.

### Where the integrity guarantees live

| Guarantee | Enforced by |
| --- | --- |
| No fixture evidence | `EvidenceOrigin` has one member; `test_integrity.py` |
| No silent fallback | Adapter never returns data from an `except` block; asserted by AST test |
| No invented SDK usage | Every method and constant asserted against the pinned SDK |
| Deterministic measurement | `evaluation/` is pure; AST test forbids network/model identifiers |
| Absence ≠ failure | `absence.py`; a semantic miss can never fail |
| Provenance on all evidence | Provenance columns are `NOT NULL` |
| Immutable audit artifacts | Postgres triggers, not application convention |
| Idempotency | Unique constraints on `dedupe_key` and `idempotency_key` |

## Known gaps in this build

1. **Coarse async state.** No progress percentage, because VideoDB gives this
   SDK version no progress signal.
2. **Uncalibrated confidence.** Bands are provisional and labelled as such.
3. **Field validation is partial.** All nine rule types are implemented and
   tested; required spoken phrase and minimum visual duration have the deepest
   real-media validation. The UI and `/api/integrity` disclose this.
4. **Direct browser uploads are local-only.** The serverless production demo
   accepts durable public video URLs; its UI does not offer a file control.
5. **Re-evaluation is not supported.** Results are immutable and a second
   evaluation is skipped rather than overwriting history; report versioning is
   future work.
6. **Evidence reels and exports are not implemented.** Exact evidence moments
   remain playable through the authenticated HLS proxy.
