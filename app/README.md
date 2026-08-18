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

Public visitors receive two scopes through the same authorization layer:

- `AdProof Client Showcase` — analyst/read-only access to four completed,
  curated, provider-backed NASA public-domain studies.
- `Public AdProof test` — an isolated writable sandbox for defining a campaign
  and processing a durable public video URL.

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
./.venv/bin/python scripts/seed_showcase.py --apply --curate
```

The command is idempotent. It creates the showcase workspace and campaign,
submits four official NASA direct-MP4 sources through the normal authenticated
API, runs genuine VideoDB indexing/retrieval/evaluation, then appends the
curator reviews and final approvals. It never inserts fixture evidence or
duplicates provider work. Configure `ADPROOF_SHOWCASE_WORKSPACE_ID` to the ID it
prints.

`/examples` remains a separate browser-only prepared walkthrough. It is useful
for explaining outcome shapes, but is explicitly labelled and never presented
as provider output.

## Tests

```bash
createdb adproof_test
./.venv/bin/python -m pytest
```

Postgres-backed tests skip automatically if no database is reachable.

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
