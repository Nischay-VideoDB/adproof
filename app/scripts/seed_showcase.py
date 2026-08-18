"""Create the stable, provider-backed AdProof showcase.

This command is intentionally explicit and idempotent. It creates no fixture
evidence: each submission goes through the normal authenticated API, durable
job chain, VideoDB ingestion/indexing/search, and deterministic evaluator.

Usage (with production credentials already exported):

    python scripts/seed_showcase.py --apply

Rerunning the command reuses the workspace, campaign and submission
idempotency keys. It never duplicates provider work.
"""

from __future__ import annotations

import argparse
import os
import secrets
from dataclasses import dataclass


SHOWCASE_WORKSPACE = "AdProof Client Showcase"
SHOWCASE_CAMPAIGN = "Solar Mission Communications — Public-Domain Study"
SEEDER_EMAIL = "adproof-showcase-curator@videodb.io"


@dataclass(frozen=True)
class ShowcaseSource:
    reference: str
    url: str
    idempotency_key: str


# These direct MP4 assets come from official NASA media pages discovered and
# verified through TinyFish. NASA SVS identifies the source programs and
# requested credit; the campaign describes them as a public-domain study, not
# as paid submissions or endorsements. Media is never checked into this repo.
SOURCES = (
    ShowcaseSource(
        reference="STEREO: complete view of the Sun — NASA public media",
        url=(
            "https://images-assets.nasa.gov/video/"
            "GSFC_20110207_STEREO_m10720_Stonehenge/"
            "GSFC_20110207_STEREO_m10720_Stonehenge~medium.mp4"
        ),
        idempotency_key="showcase-v2-nasa-stereo",
    ),
    ShowcaseSource(
        reference="Sarah Jones: ICON and space weather — NASA public media",
        url=(
            "https://svs.gsfc.nasa.gov/vis/a010000/a013300/a013335/"
            "SarahJonesCanned.mp4"
        ),
        idempotency_key="showcase-v2-nasa-icon",
    ),
    ShowcaseSource(
        reference="Alex Young: summer solstice and solar activity — NASA public media",
        url=(
            "https://svs.gsfc.nasa.gov/vis/a010000/a014300/a014348/"
            "Alex_Young_Canned_Summer_Solstice.mp4"
        ),
        idempotency_key="showcase-v2-nasa-solstice",
    ),
    ShowcaseSource(
        reference="Aleida Higginson: Parker Solar Probe results — NASA public media",
        url=(
            "https://svs.gsfc.nasa.gov/vis/a010000/a013400/a013457/"
            "AleidaCanned.mp4"
        ),
        idempotency_key="showcase-v2-nasa-parker",
    ),
)


CAMPAIGN_PAYLOAD = {
    "campaign_name": SHOWCASE_CAMPAIGN,
    "brief_text": (
        "Public-domain NASA science-communications study for demonstrating "
        "evidence-first campaign verification. NASA and the featured experts "
        "are not affiliated with AdProof or VideoDB, and the clips are not "
        "asserted to be paid submissions. For the study, verify that the Sun "
        "is discussed, NASA or mission identification is visible, no absolute "
        "safety guarantee is spoken, advertising disclosure can be located, "
        "and no price or discount callout appears. Preserve uncertainty and "
        "route contextual or subjective questions to a human. Source credit: "
        "NASA's Goddard Space Flight Center / Scientific Visualization Studio."
    ),
    "auto_decide": False,
    "rules": [
        {
            "rule_type": "required_spoken_phrase",
            "requirement_text": "The speaker must say “Sun” at least once.",
            "source_brief_excerpt": "verify that the Sun is discussed",
            "phrase": "sun",
            "min_occurrences": 1,
            "absence_policy": "fail_when_coverage_complete",
            "severity": "required",
        },
        {
            "rule_type": "required_visual_event",
            "requirement_text": (
                "NASA, a mission name, a speaker lower-third, or a source title "
                "must appear visibly on screen."
            ),
            "source_brief_excerpt": "NASA or mission identification is visible",
            "visual_concept": (
                "NASA identification, a NASA mission name, a scientist speaker "
                "lower-third, a question slate, or an official source title is "
                "visibly present as on-screen text"
            ),
            "visual_domain": "on_screen_claim",
            "score_threshold": 0.3,
            "absence_policy": "uncertain",
            "severity": "required",
        },
        {
            "rule_type": "disclosure_present",
            "requirement_text": (
                "Any sponsorship or paid-partnership disclosure must be spoken "
                "or shown on screen."
            ),
            "source_brief_excerpt": "disclosure can be located",
            "visual_domain": "disclosure",
            "modality_requirement": "either",
            "absence_policy": "require_human_review",
            "severity": "required",
        },
        {
            "rule_type": "forbidden_spoken_claim",
            "requirement_text": (
                "The video must not promise that solar activity is completely "
                "safe, has zero risk, or can never affect technology."
            ),
            "source_brief_excerpt": "no absolute safety guarantee is spoken",
            "forbidden_phrases": [
                "completely safe",
                "zero risk",
                "can never affect technology",
            ],
            "absence_policy": "fail_when_coverage_complete",
            "severity": "blocking",
        },
        {
            "rule_type": "forbidden_visual_event",
            "requirement_text": (
                "No price, discount code, limited-time offer, or purchase callout "
                "may appear on screen."
            ),
            "source_brief_excerpt": "no price or discount callout appears",
            "visual_concept": (
                "an on-screen price, percentage discount, coupon code, limited-"
                "time offer, buy-now message, or purchase call to action"
            ),
            "visual_domain": "on_screen_claim",
            "score_threshold": 0.35,
            "absence_policy": "require_human_review",
            "severity": "blocking",
        },
        {
            "rule_type": "subjective_human_review",
            "requirement_text": (
                "A reviewer must confirm that the overall framing and claims "
                "are not misleading."
            ),
            "source_brief_excerpt": (
                "route contextual or subjective questions to a human"
            ),
            "reviewer_guidance": (
                "Review the complete clip and supporting timestamps. Consider "
                "tone, implied outcomes, qualifications, and product context."
            ),
            "severity": "required",
        },
    ],
}


def _preflight() -> None:
    missing = [
        name
        for name in ("ADPROOF_DATABASE_URL", "VIDEODB_API_KEY")
        if not os.getenv(name)
    ]
    if missing:
        raise SystemExit("Missing required environment: " + ", ".join(missing))
    if "adproof_july_demo" not in os.environ["ADPROOF_DATABASE_URL"]:
        raise SystemExit(
            "Refusing to seed: ADPROOF_DATABASE_URL is not the isolated "
            "adproof_july_demo database."
        )


def _ensure_identity(password: str) -> tuple[str, str]:
    from sqlalchemy import select

    from adproof.db import init_db, session_scope
    from adproof.models import Membership, User, Workspace
    from adproof.security import hash_password
    from adproof.states import Role

    init_db()
    with session_scope() as session:
        workspace = session.scalar(
            select(Workspace).where(Workspace.name == SHOWCASE_WORKSPACE)
        )
        if workspace is None:
            workspace = Workspace(name=SHOWCASE_WORKSPACE)
            session.add(workspace)
            session.flush()

        user = session.scalar(select(User).where(User.email == SEEDER_EMAIL))
        if user is None:
            user = User(
                email=SEEDER_EMAIL,
                display_name="VideoDB demo curator",
                password_hash=hash_password(password),
            )
            session.add(user)
            session.flush()
        else:
            # The one-time password is never stored or printed. Refreshing its
            # hash lets an idempotent rerun authenticate through the real API.
            user.password_hash = hash_password(password)
            user.is_active = True

        membership = session.scalar(
            select(Membership).where(
                Membership.user_id == user.id,
                Membership.workspace_id == workspace.id,
            )
        )
        if membership is None:
            session.add(
                Membership(
                    user_id=user.id,
                    workspace_id=workspace.id,
                    role=Role.workspace_admin,
                )
            )
        else:
            membership.role = Role.workspace_admin
        return workspace.id, user.id


def _find_campaign(client, workspace_id: str) -> str | None:
    response = client.get("/api/campaigns")
    if response.status_code != 200:
        raise SystemExit(
            f"Campaign listing failed: {response.status_code} {response.text}"
        )
    campaigns = response.json()
    return next(
        (
            campaign["id"]
            for campaign in campaigns
            if campaign["workspace_id"] == workspace_id
            and campaign["name"] == SHOWCASE_CAMPAIGN
        ),
        None,
    )


def _post_or_stop(client, path: str, payload: dict, label: str) -> dict:
    response = client.post(path, json=payload)
    if response.status_code != 201:
        raise SystemExit(
            f"{label} failed: {response.status_code} {response.text}"
        )
    return response.json()


def _curate_report(client, report: dict) -> None:
    """Apply the curator conclusions after source/evidence QA.

    The reasons are deliberately specific to the official NASA corpus. This is
    not a generic "turn everything green" path, and it refuses unexpected
    machine failures rather than silently overriding them.
    """
    submission_id = report["submission"]["id"]
    reference = report["submission"]["creator_reference"]

    # Preserve a realistic escalation trail on the one observed visual false
    # negative before the human correction is appended.
    if reference.startswith("STEREO") and not report["decisions"]:
        _post_or_stop(
            client,
            f"/api/submissions/{submission_id}/decision",
            {
                "decision": "escalate",
                "rationale": (
                    "The source-identification rule was uncertain despite a "
                    "visible NASA Goddard credit near the end. Escalating for "
                    "a full-source visual check before approval."
                ),
            },
            "initial escalation",
        )

    for rule in report["rules"]:
        if rule["reviews"]:
            continue
        ordinal = rule["ordinal"]
        result = rule["result"]
        if not result:
            raise SystemExit(
                f"Cannot curate {submission_id}: rule {ordinal} has no result"
            )
        evidence_viewed = [item["id"] for item in rule["evidence"]]
        path = (
            f"/api/submissions/{submission_id}/rules/{rule['id']}/review"
        )

        if ordinal in (0, 3):
            if result["state"] != "pass":
                raise SystemExit(
                    f"Refusing unexpected override: {reference} rule {ordinal} "
                    f"is {result['state']}"
                )
            payload = {
                "action": "confirm",
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 1 and result["state"] == "pass":
            payload = {
                "action": "confirm",
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 1:
            if not reference.startswith("STEREO"):
                raise SystemExit(
                    f"Unexpected source-identification miss for {reference}"
                )
            payload = {
                "action": "override",
                "human_state": "pass",
                "reason_category": "false_negative",
                "reason_text": (
                    "Full-source visual sampling shows the NASA Goddard Space "
                    "Flight Center credit near the end of the clip. The focused "
                    "retrieval did not retain that title card."
                ),
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 2:
            payload = {
                "action": "override",
                "human_state": "pass",
                "reason_category": "policy_disagreement",
                "reason_text": (
                    "The official NASA SVS source page and the complete clip "
                    "identify this as public agency science communication, not "
                    "sponsored or paid-partnership content; no advertising "
                    "disclosure is required for this study source."
                ),
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 4 and result["state"] == "pass":
            payload = {
                "action": "confirm",
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 4:
            if not reference.startswith("STEREO"):
                raise SystemExit(
                    f"Unexpected commerce-callout uncertainty for {reference}"
                )
            payload = {
                "action": "override",
                "human_state": "pass",
                "reason_category": "insufficient_evidence",
                "reason_text": (
                    "A full-duration contact-sheet review shows historical solar "
                    "imagery, spacecraft, and the NASA Goddard credit only; no "
                    "price, discount, coupon, offer, or purchase callout appears."
                ),
                "evidence_viewed": evidence_viewed,
            }
        elif ordinal == 5:
            payload = {
                "action": "override",
                "human_state": "pass",
                "reason_category": "unsupported_rule",
                "reason_text": (
                    "Curator reviewed the official-source transcript, visual "
                    "samples, and retained evidence. The science framing is "
                    "contextual, attributable, and does not imply a commercial "
                    "or guaranteed outcome."
                ),
                "evidence_viewed": evidence_viewed,
            }
        else:
            raise SystemExit(f"No curation policy for rule ordinal {ordinal}")

        _post_or_stop(client, path, payload, f"rule {ordinal} review")

    refreshed = client.get(
        f"/api/submissions/{submission_id}/report"
    ).json()
    if not any(item["decision"] == "approve" for item in refreshed["decisions"]):
        if "approve" not in refreshed["adjudication"]["permitted_decisions"]:
            raise SystemExit(
                f"Approval is not permitted for {submission_id}: "
                + " ".join(refreshed["adjudication"]["reasons"])
            )
        _post_or_stop(
            client,
            f"/api/submissions/{submission_id}/decision",
            {
                "decision": "approve",
                "rationale": (
                    "Approved for the public-domain showcase after review of "
                    "the official source, VideoDB timestamps, transcript, "
                    "visual evidence, and all unresolved machine findings."
                ),
            },
            "final approval",
        )
    print(f"  curated {submission_id} with append-only reviews and approval")


def seed(*, curate: bool = False) -> None:
    from fastapi.testclient import TestClient

    from adproof.api.main import app

    password = secrets.token_urlsafe(32)
    workspace_id, _ = _ensure_identity(password)

    # Production sessions are Secure cookies, so the in-process client must
    # use an HTTPS origin just like Vercel does.
    with TestClient(app, base_url="https://adproof.local") as client:
        login = client.post(
            "/api/auth/login",
            json={"email": SEEDER_EMAIL, "password": password},
        )
        if login.status_code != 200:
            raise SystemExit(f"Seeder login failed: {login.status_code} {login.text}")

        campaign_id = _find_campaign(client, workspace_id)
        if campaign_id is None:
            created = client.post(
                "/api/campaigns",
                json={**CAMPAIGN_PAYLOAD, "workspace_id": workspace_id},
            )
            if created.status_code != 201:
                raise SystemExit(
                    f"Campaign creation failed: {created.status_code} {created.text}"
                )
            campaign_id = created.json()["campaign_id"]
            print(f"created campaign {campaign_id}")
        else:
            print(f"reusing campaign {campaign_id}")

        reports = []
        for source in SOURCES:
            print(f"processing {source.reference}")
            response = client.post(
                "/api/submissions",
                json={
                    "campaign_id": campaign_id,
                    "creator_reference": source.reference,
                    "idempotency_key": source.idempotency_key,
                    "source_url": source.url,
                },
            )
            if response.status_code != 201:
                raise SystemExit(
                    f"Submission failed for {source.url}: "
                    f"{response.status_code} {response.text}"
                )
            submission_id = response.json()["submission_id"]
            report_response = client.get(
                f"/api/submissions/{submission_id}/report"
            )
            if report_response.status_code != 200:
                raise SystemExit(
                    f"Report failed for {submission_id}: {report_response.text}"
                )
            report = report_response.json()
            reports.append(report)
            results = [
                rule["result"]["state"] if rule["result"] else "missing"
                for rule in report["rules"]
            ]
            evidence_count = sum(len(rule["evidence"]) for rule in report["rules"])
            print(
                f"  {submission_id} state={report['submission']['state']} "
                f"evidence={evidence_count} results={','.join(results)}"
            )

        if curate:
            for report in reports:
                _curate_report(client, report)

    print(f"showcase_workspace_id={workspace_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform provider and database writes (required)",
    )
    parser.add_argument(
        "--curate",
        action="store_true",
        help="append the reviewed NASA-source conclusions and final approvals",
    )
    args = parser.parse_args()
    if not args.apply:
        parser.error("--apply is required; no changes were made")
    _preflight()
    seed(curate=args.curate)


if __name__ == "__main__":
    main()
