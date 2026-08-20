"""Seed two live-provider creator-review showcase campaigns.

Every submission follows the authenticated API and normal durable job pipeline.
Run one source at a time for provider QA::

    python scripts/seed_showcase.py --apply --only biossance
    python scripts/seed_showcase.py --apply --only ninja
"""

from __future__ import annotations

import argparse
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

SHOWCASE_WORKSPACE = "AdProof Agency Showcase · Creator Review 2026-08 v3"
SEEDER_EMAIL = "adproof-showcase-curator@videodb.io"


@dataclass(frozen=True)
class Demo:
    slug: str
    campaign_name: str
    creator_reference: str
    source_url: str
    source_title: str
    source_author: str
    local_filename: str
    license_name: str
    license_url: str
    idempotency_key: str
    brief: str
    rules: tuple[dict, ...]

    @property
    def campaign_payload(self) -> dict:
        return {"campaign_name": self.campaign_name, "brief_text": self.brief,
                "auto_decide": False, "rules": list(self.rules)}


BIOSSANCE = Demo(
    "biossance",
    "Biossance Eye Cream — 45-Second Creator How-To",
    "Jessica Posh · eye-cream product demonstration",
    "https://www.youtube.com/watch?v=LToWCtEYyhM",
    "Biossance Squalane & Marine Algae Eye Cream | Product Demo",
    "Jessica Posh",
    "biossance-eye-cream-demo.mp4",
    "Creative Commons Attribution (CC BY)",
    "https://support.google.com/youtube/answer/2797468",
    "agency-showcase-2026-08-v3-biossance",
    "Create a concise tutorial for Squalane + Marine Algae Eye Cream. Name the "
    "product, show its packaging and texture, explain the ring-finger technique, "
    "demonstrate gentle under-eye application, and include a clear in-video "
    "advertising or affiliate disclosure at the opening. Keep the tutorial "
    "clear, concise, and easy to follow at normal playback speed.",
    (
        {"rule_type": "required_spoken_phrase", "requirement_text": "Say ‘Squalane and Marine Algae Eye Cream’ at least once.", "source_brief_excerpt": "name the product", "phrase": "Squalane and Marine Algae Eye Cream", "min_occurrences": 1, "absence_policy": "uncertain", "severity": "required"},
        {"rule_type": "required_spoken_phrase", "requirement_text": "Explain that the product is applied with the ring fingers.", "source_brief_excerpt": "explain the ring-finger technique", "phrase": "ring fingers", "min_occurrences": 1, "absence_policy": "uncertain", "severity": "required"},
        {"rule_type": "min_visual_duration", "requirement_text": "Keep the product package, bottle, or open green jar clearly visible for at least 12 seconds.", "source_brief_excerpt": "show its packaging and texture", "visual_concept": "Biossance eye cream packaging, bottle, or open green jar is clearly visible", "visual_domain": "product_presence", "min_duration_seconds": 12.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "required_visual_event", "requirement_text": "Show the open jar and exposed cream texture toward the camera between 12 and 28 seconds.", "source_brief_excerpt": "show its packaging and texture", "visual_concept": "creator holds an open eye cream jar with exposed cream texture toward the camera", "visual_domain": "product_use", "window_start_seconds": 12.0, "window_end_seconds": 28.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "required_visual_event", "requirement_text": "Demonstrate gently dabbing the cream beneath or around both eyes between 26 and 42 seconds.", "source_brief_excerpt": "demonstrate gentle under-eye application", "visual_concept": "creator gently dabs eye cream beneath or around both eyes", "visual_domain": "product_use", "window_start_seconds": 26.0, "window_end_seconds": 42.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "sequence", "requirement_text": "Show the product or package before demonstrating under-eye application.", "source_brief_excerpt": "show product before application", "sequence_first": "creator shows the eye cream product, jar, or package", "sequence_second": "creator applies or dabs cream beneath the eyes", "sequence_max_gap_seconds": 35.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "disclosure_present", "requirement_text": "Include an in-video advertising or affiliate disclosure in the first 8 seconds.", "source_brief_excerpt": "include clear in-video disclosure at the opening", "modality_requirement": "either", "window_start_seconds": 0.0, "window_end_seconds": 8.0, "visual_domain": "disclosure", "absence_policy": "fail_when_coverage_complete", "severity": "blocking"},
        {"rule_type": "subjective_human_review", "requirement_text": "Confirm one product-name view is readable at normal playback and the tutorial is easy to follow.", "source_brief_excerpt": "clear, concise tutorial", "reviewer_guidance": "Review normal-speed playback for product-name readability and instructional clarity. Do not infer efficacy or sentiment.", "severity": "required"},
    ),
)

NANK = Demo(
    "nank",
    "Runner Diver2 Headphones — Gifted Creator Review",
    "Terence Eden · bone-conduction headphones review",
    "https://tube.tchncs.de/w/baf78162-e0c1-45c9-8617-2177ecc384ca",
    "Nank Runner Diver2 Bone Conduction Swimming Headphones",
    "Terence Eden / @edent · 16 Oct 2023",
    "nank-runner-diver2-review.mp4",
    "Attribution – Share Alike",
    "https://creativecommons.org/share-your-work/cclicenses/",
    "agency-showcase-2026-08-v3-nank",
    "Create a practical review of the Runner Diver2 swimming headphones. "
    "Disclose the supplied relationship at the opening, name the model, keep "
    "the product clearly visible, show the package reveal, then show how it is "
    "worn during swimming, showering, jogging, or exercise. Avoid unqualified "
    "underwater or waterproof guarantees. Make the product details and "
    "demonstration sequence easy to follow at normal playback speed.",
    (
        {"rule_type": "required_spoken_phrase", "requirement_text": "Say ‘Nank Runner Diver2’ at least once.", "source_brief_excerpt": "name the model", "phrase": "Nank Runner Diver2", "min_occurrences": 1, "absence_policy": "uncertain", "severity": "required"},
        {"rule_type": "forbidden_spoken_claim", "requirement_text": "Do not claim that Bluetooth works underwater, that the product is waterproof at any depth, or that it is completely waterproof.", "source_brief_excerpt": "avoid unqualified underwater or waterproof guarantees", "forbidden_phrases": ["Bluetooth works underwater", "waterproof at any depth", "completely waterproof"], "absence_policy": "fail_when_coverage_complete", "severity": "blocking"},
        {"rule_type": "min_visual_duration", "requirement_text": "Keep the identifiable headphones clearly visible for at least 60 seconds.", "source_brief_excerpt": "keep the product clearly visible", "visual_concept": "black wraparound Nank Runner Diver2 headphones clearly visible in the creator's hands", "visual_domain": "product_presence", "min_duration_seconds": 60.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "required_visual_event", "requirement_text": "Open the retail package and show the headphones or included accessories between 0 and 150 seconds.", "source_brief_excerpt": "show the package reveal", "visual_concept": "creator opens the retail package and reveals the headphones or included accessories", "visual_domain": "product_use", "window_start_seconds": 0.0, "window_end_seconds": 150.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "sequence", "requirement_text": "Show the closed retail box before showing the removed headphones close-up.", "source_brief_excerpt": "show package before product close-up", "sequence_first": "creator shows the closed retail box", "sequence_second": "creator shows the removed headphones close-up", "sequence_max_gap_seconds": 60.0, "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "required_visual_event", "requirement_text": "Show a person wearing the headphones while swimming, showering, jogging, or exercising.", "source_brief_excerpt": "show how it is worn during exercise or water use", "visual_concept": "person visibly wears the headphones while swimming, showering, jogging, running, or exercising", "visual_domain": "product_use", "score_threshold": 0.3, "absence_policy": "require_human_review", "severity": "required"},
        {"rule_type": "disclosure_present", "requirement_text": "Disclose that the product was supplied by Nank within the first 15 seconds.", "source_brief_excerpt": "disclose the supplied relationship at the opening", "modality_requirement": "either", "window_start_seconds": 0.0, "window_end_seconds": 15.0, "visual_domain": "disclosure", "absence_policy": "require_human_review", "severity": "blocking"},
        {"rule_type": "subjective_human_review", "requirement_text": "Confirm the brand/model is readable and the controls, charger, and accessories are clear at normal playback.", "source_brief_excerpt": "make product details clear", "reviewer_guidance": "Review normal-speed playback for readable brand/model text and clear controls, charger, and accessory close-ups. Do not infer product quality or sentiment.", "severity": "required"},
    ),
)

DEMOS = (BIOSSANCE, NANK)


def _preflight() -> None:
    missing = [n for n in ("ADPROOF_DATABASE_URL", "VIDEODB_API_KEY") if not os.getenv(n)]
    if missing:
        raise SystemExit("Missing required environment: " + ", ".join(missing))
    if "adproof_july_demo" not in os.environ["ADPROOF_DATABASE_URL"]:
        raise SystemExit("Refusing to seed outside adproof_july_demo.")


def _ensure_identity(password: str) -> str:
    from sqlalchemy import select
    from adproof.db import init_db, session_scope
    from adproof.models import Membership, User, Workspace
    from adproof.security import hash_password
    from adproof.states import Role
    init_db()
    with session_scope() as session:
        workspace = session.scalar(select(Workspace).where(Workspace.name == SHOWCASE_WORKSPACE))
        if workspace is None:
            workspace = Workspace(name=SHOWCASE_WORKSPACE); session.add(workspace); session.flush()
        user = session.scalar(select(User).where(User.email == SEEDER_EMAIL))
        if user is None:
            user = User(email=SEEDER_EMAIL, display_name="AdProof showcase curator", password_hash=hash_password(password)); session.add(user); session.flush()
        else:
            user.password_hash = hash_password(password); user.is_active = True
        membership = session.scalar(select(Membership).where(Membership.user_id == user.id, Membership.workspace_id == workspace.id))
        if membership is None:
            session.add(Membership(user_id=user.id, workspace_id=workspace.id, role=Role.workspace_admin))
        else:
            membership.role = Role.workspace_admin
        return workspace.id


def _campaign_id(client, workspace_id: str, demo: Demo) -> str:
    campaigns = client.get("/api/campaigns").json()
    existing = next((c["id"] for c in campaigns if c["workspace_id"] == workspace_id and c["name"] == demo.campaign_name), None)
    if existing:
        # Brief snapshots are immutable. Copy corrections become a new version;
        # the campaign/report projections already select the latest snapshot.
        from sqlalchemy import select
        from adproof.audit import record_audit
        from adproof.db import session_scope
        from adproof.models import BriefVersion
        with session_scope() as session:
            latest = session.scalar(
                select(BriefVersion)
                .where(BriefVersion.campaign_id == existing)
                .order_by(BriefVersion.version.desc())
            )
            if latest is None or latest.original_text != demo.brief:
                next_version = (latest.version if latest else 0) + 1
                session.add(BriefVersion(
                    campaign_id=existing,
                    version=next_version,
                    original_text=demo.brief,
                ))
                record_audit(
                    session,
                    workspace_id=workspace_id,
                    category="campaign.brief_version_added",
                    subject_type="campaign",
                    subject_id=existing,
                    actor=SEEDER_EMAIL,
                    detail={"version": next_version, "reason": "client-facing brief copy correction"},
                )
        return existing
    response = client.post("/api/campaigns", json={**demo.campaign_payload, "workspace_id": workspace_id})
    if response.status_code != 201:
        raise SystemExit(f"Campaign creation failed for {demo.slug}: {response.status_code} {response.text}")
    return response.json()["campaign_id"]


def _ensure_attribution(submission_id: str, demo: Demo) -> None:
    from sqlalchemy import select
    from adproof.db import session_scope
    from adproof.models import ShowcaseSourceAttribution
    with session_scope() as session:
        row = session.scalar(select(ShowcaseSourceAttribution).where(ShowcaseSourceAttribution.submission_id == submission_id))
        if row is None:
            session.add(ShowcaseSourceAttribution(submission_id=submission_id, title=demo.source_title, author=demo.source_author, source_page_url=demo.source_url, license_name=demo.license_name, license_url=demo.license_url))


def seed(selected: set[str]) -> None:
    from fastapi.testclient import TestClient
    from adproof.api.main import app
    from adproof.orchestrator.worker import run_version_until_idle
    password = secrets.token_urlsafe(32)
    workspace_id = _ensure_identity(password)
    with TestClient(app, base_url="https://adproof.local") as client:
        login = client.post("/api/auth/login", json={"email": SEEDER_EMAIL, "password": password})
        if login.status_code != 200:
            raise SystemExit(f"Seeder login failed: {login.status_code}")
        for demo in DEMOS:
            if selected and demo.slug not in selected:
                continue
            campaign_id = _campaign_id(client, workspace_id, demo)
            source_path = Path(__file__).resolve().parents[1] / "assets" / "showcase" / demo.local_filename
            if not source_path.is_file():
                raise SystemExit(f"Frozen source is missing for {demo.slug}: {source_path}")
            with source_path.open("rb") as source_file:
                response = client.post(
                    "/api/submissions/upload",
                    data={"campaign_id": campaign_id, "creator_reference": demo.creator_reference, "idempotency_key": demo.idempotency_key},
                    files={"file": (demo.local_filename, source_file, "video/mp4")},
                )
            if response.status_code != 201:
                raise SystemExit(f"Submission failed for {demo.slug}: {response.status_code} {response.text}")
            created = response.json()
            if created.get("submission_version_id"):
                run_version_until_idle(created["submission_version_id"])
            submission_id = created["submission_id"]
            _ensure_attribution(submission_id, demo)
            body = client.get(f"/api/submissions/{submission_id}/report").json()
            states = [r["result"]["state"] if r["result"] else "missing" for r in body["rules"]]
            count = sum(len(r["evidence"]) for r in body["rules"])
            print(f"{demo.slug}: state={body['submission']['state']} evidence={count} results={','.join(states)}")
    print(f"showcase_workspace_id={workspace_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--only", action="append", choices=[d.slug for d in DEMOS], default=[])
    args = parser.parse_args()
    if not args.apply:
        parser.error("--apply is required; no changes were made")
    _preflight()
    seed(set(args.only))


if __name__ == "__main__":
    main()
