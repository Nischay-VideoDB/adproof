"""Frozen server-only playback registry for the fixed public saved runs.

The real campaign, evidence, evaluation, and review graph remains in Postgres.
Only the 23 already-generated delivery locators live in one sensitive JSON
environment value. Public requests authorize against the database first, then
resolve an exact manifest-bound locator here; they never generate provider
streams. Authenticated private workspaces retain their on-demand path.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
import os
import re
from typing import Callable
from urllib.parse import urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    EvidenceItem,
    EvaluationResult,
    MediaAsset,
    RetrievalRun,
    RuleReview,
    Submission,
    SubmissionVersion,
)


PADDING_POLICY_VERSION = "evidence-context/v1-10s"
PINNED_SHOWCASE_MANIFEST_HASH = "68e48c51e0cf854037158bdfe9949bb3692227d2c098e2c2de28f7c82a9e5e58"
PINNED_SHOWCASE_REGISTRY_DIGEST = "9c2fee8221b889577ca182b3cab50678c67eba368c23f359c78e56a7978114fe"
PINNED_SHOWCASE_ENTRY_COUNT = 23
PINNED_SHOWCASE_WORKSPACE_ID = "079250a1-aeb8-4d55-9f75-088670e0e167"
REGISTRY_ENV = "ADPROOF_SHOWCASE_PLAYBACK_REGISTRY_JSON"
_ALLOWED_STREAM_HOSTS = frozenset({"play.videodb.io", "stream.videodb.io"})
_URI_ATTRIBUTE = re.compile(r'URI="([^"]+)"')


class PreparedPlaybackError(RuntimeError):
    """A public playback receipt could not be generated or validated."""


@dataclass(frozen=True)
class PlaybackSpec:
    registry_key: str
    workspace_id: str
    media_asset_id: str
    provider_video_id: str
    provider_collection_id: str | None
    playback_kind: str
    evidence_item_id: str | None = None
    detected_start_seconds: float | None = None
    detected_end_seconds: float | None = None
    playback_start_seconds: float | None = None
    playback_end_seconds: float | None = None

    @property
    def timeline(self) -> list[tuple[float, float]] | None:
        if self.playback_kind == "full_source":
            return None
        assert self.playback_start_seconds is not None
        assert self.playback_end_seconds is not None
        return [(self.playback_start_seconds, self.playback_end_seconds)]

    @property
    def provider_binding_hash(self) -> str:
        return provider_binding_hash(
            self.provider_video_id, self.provider_collection_id
        )


@dataclass(frozen=True)
class ShowcaseManifest:
    specs: tuple[PlaybackSpec, ...]
    cited_reference_count: int
    missing_cited_reference_count: int
    source_count: int
    clip_count: int

    @property
    def manifest_hash(self) -> str:
        return _key([spec.registry_key for spec in self.specs])


def clip_window(
    detected_start: float,
    detected_end: float,
    source_duration: float,
    target_seconds: float = 10.0,
) -> tuple[float, float]:
    """Pad a short canonical interval without changing or cropping it."""
    if detected_end - detected_start >= target_seconds:
        return detected_start, detected_end
    missing = target_seconds - (detected_end - detected_start)
    playback_start = max(0.0, detected_start - missing / 2)
    playback_end = min(source_duration, detected_end + missing / 2)
    if playback_end - playback_start < target_seconds:
        if playback_start == 0.0:
            playback_end = min(source_duration, target_seconds)
        else:
            playback_start = max(0.0, source_duration - target_seconds)
    return playback_start, playback_end


def _key(parts: list[str]) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def provider_binding_hash(
    provider_video_id: str, provider_collection_id: str | None
) -> str:
    """Return the server-only binding used to reject stale prepared locators."""
    return _key([provider_video_id, provider_collection_id or ""])


def full_source_spec(workspace_id: str, asset: MediaAsset) -> PlaybackSpec:
    if not asset.provider_video_id:
        raise PreparedPlaybackError("A public media asset has no provider video binding.")
    return PlaybackSpec(
        registry_key=_key(
            [PADDING_POLICY_VERSION, workspace_id, asset.id, "full_source"]
        ),
        workspace_id=workspace_id,
        media_asset_id=asset.id,
        provider_video_id=asset.provider_video_id,
        provider_collection_id=asset.provider_collection_id,
        playback_kind="full_source",
    )


def evidence_spec(
    workspace_id: str, asset: MediaAsset, item: EvidenceItem
) -> PlaybackSpec:
    if not asset.provider_video_id or not asset.duration_seconds:
        raise PreparedPlaybackError(
            "A public evidence clip lacks a video binding or source duration."
        )
    detected_end = (
        item.end_seconds if item.end_seconds is not None else item.start_seconds
    )
    tolerance = 0.05
    if (
        item.start_seconds < 0
        or detected_end < item.start_seconds
        or detected_end > asset.duration_seconds + tolerance
    ):
        raise PreparedPlaybackError(
            "A public evidence interval falls outside its source duration."
        )
    source_duration = max(asset.duration_seconds, detected_end)
    playback_start, playback_end = clip_window(
        item.start_seconds, detected_end, source_duration
    )
    return PlaybackSpec(
        registry_key=_key([
            PADDING_POLICY_VERSION,
            workspace_id,
            asset.id,
            "evidence",
            str(round(playback_start * 1000)),
            str(round(playback_end * 1000)),
        ]),
        workspace_id=workspace_id,
        media_asset_id=asset.id,
        provider_video_id=asset.provider_video_id,
        provider_collection_id=asset.provider_collection_id,
        playback_kind="evidence",
        evidence_item_id=item.id,
        detected_start_seconds=item.start_seconds,
        detected_end_seconds=detected_end,
        playback_start_seconds=playback_start,
        playback_end_seconds=playback_end,
    )


def build_showcase_manifest(
    session: Session, workspace_id: str
) -> ShowcaseManifest:
    """Enumerate full sources and immutable result/review-cited evidence only."""
    rows = session.execute(
        select(Submission, SubmissionVersion, MediaAsset)
        .join(SubmissionVersion, SubmissionVersion.submission_id == Submission.id)
        .join(MediaAsset, MediaAsset.submission_version_id == SubmissionVersion.id)
        .where(Submission.workspace_id == workspace_id)
        .order_by(Submission.id, SubmissionVersion.version.desc())
    ).all()
    latest: dict[str, tuple[SubmissionVersion, MediaAsset]] = {}
    for submission, version, asset in rows:
        latest.setdefault(submission.id, (version, asset))

    specs: dict[str, PlaybackSpec] = {}
    cited_references: set[str] = set()
    found_references: set[str] = set()
    source_count = 0
    for version, asset in latest.values():
        source = full_source_spec(workspace_id, asset)
        specs[source.registry_key] = source
        source_count += 1
        cited_ids: set[str] = set()
        for result in session.scalars(
            select(EvaluationResult).where(
                EvaluationResult.submission_version_id == version.id
            )
        ):
            cited_ids.update(result.evidence_ids or [])
        for review in session.scalars(
            select(RuleReview).where(RuleReview.submission_version_id == version.id)
        ):
            cited_ids.update(review.evidence_viewed or [])
        cited_references.update(cited_ids)
        if cited_ids:
            items = session.scalars(
                select(EvidenceItem)
                .join(RetrievalRun, RetrievalRun.id == EvidenceItem.retrieval_run_id)
                .where(
                    RetrievalRun.submission_version_id == version.id,
                    EvidenceItem.id.in_(cited_ids),
                )
                .order_by(EvidenceItem.id)
            )
            for item in items:
                found_references.add(item.id)
                spec = evidence_spec(workspace_id, asset, item)
                specs.setdefault(spec.registry_key, spec)
    ordered = tuple(specs[key] for key in sorted(specs))
    return ShowcaseManifest(
        specs=ordered,
        cited_reference_count=len(cited_references),
        missing_cited_reference_count=len(cited_references - found_references),
        source_count=source_count,
        clip_count=len(ordered) - source_count,
    )


def enumerate_showcase_specs(session: Session, workspace_id: str) -> list[PlaybackSpec]:
    return list(build_showcase_manifest(session, workspace_id).specs)


def inspect_showcase_manifest(session: Session, workspace_id: str) -> dict[str, object]:
    """Read only the immutable citation graph; never touches receipt storage."""
    manifest = build_showcase_manifest(session, workspace_id)
    return {
        "cited_reference_count": manifest.cited_reference_count,
        "missing_cited_reference_count": manifest.missing_cited_reference_count,
        "source_count": manifest.source_count,
        "clip_count": manifest.clip_count,
        "expected_count": len(manifest.specs),
        "registry_manifest_hash": manifest.manifest_hash,
        "padding_policy_version": PADDING_POLICY_VERSION,
    }


@dataclass(frozen=True)
class FrozenPlaybackEntry:
    registry_key: str
    workspace_id: str
    media_asset_id: str
    playback_kind: str
    playback_start_seconds: float | None
    playback_end_seconds: float | None
    provider_stream_url: str
    provider_binding_hash: str


def _registry_digest(entries: list[FrozenPlaybackEntry]) -> str:
    rows = [
        {
            "k": entry.registry_key,
            "w": entry.workspace_id,
            "a": entry.media_asset_id,
            "t": entry.playback_kind,
            "s": entry.playback_start_seconds,
            "e": entry.playback_end_seconds,
            "b": entry.provider_binding_hash,
            "u": entry.provider_stream_url,
        }
        for entry in sorted(entries, key=lambda item: item.registry_key)
    ]
    canonical = json.dumps(rows, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def entry_matches_spec(entry: FrozenPlaybackEntry, spec: PlaybackSpec) -> bool:
    if entry.registry_key != spec.registry_key:
        return False
    if entry.provider_binding_hash != spec.provider_binding_hash:
        return False
    fields = (
        "workspace_id",
        "media_asset_id",
        "playback_kind",
        "playback_start_seconds",
        "playback_end_seconds",
    )
    for field in fields:
        left, right = getattr(entry, field), getattr(spec, field)
        if isinstance(left, float) or isinstance(right, float):
            if left is None or right is None or abs(left - right) > 1e-6:
                return False
        elif left != right:
            return False
    return True


@lru_cache(maxsize=4)
def _parse_registry(raw: str) -> dict[str, FrozenPlaybackEntry]:
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise PreparedPlaybackError("The saved playback registry is malformed.") from exc
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise PreparedPlaybackError("The saved playback registry has an unsupported schema.")
    if payload.get("manifest_hash") != PINNED_SHOWCASE_MANIFEST_HASH:
        raise PreparedPlaybackError("The saved playback registry manifest does not match this release.")
    if payload.get("registry_digest") != PINNED_SHOWCASE_REGISTRY_DIGEST:
        raise PreparedPlaybackError("The saved playback registry content does not match this release.")
    rows = payload.get("entries")
    if not isinstance(rows, list) or len(rows) != PINNED_SHOWCASE_ENTRY_COUNT:
        raise PreparedPlaybackError("The saved playback registry has the wrong entry count.")
    entries: dict[str, FrozenPlaybackEntry] = {}
    try:
        for row in rows:
            entry = FrozenPlaybackEntry(
                registry_key=row["k"],
                workspace_id=row["w"],
                media_asset_id=row["a"],
                playback_kind=row["t"],
                playback_start_seconds=row.get("s"),
                playback_end_seconds=row.get("e"),
                provider_stream_url=_checked_url(row["u"]),
                provider_binding_hash=row["b"],
            )
            if entry.playback_kind not in {"full_source", "evidence"}:
                raise ValueError("invalid kind")
            if entry.registry_key in entries:
                raise ValueError("duplicate key")
            entries[entry.registry_key] = entry
    except (KeyError, TypeError, ValueError) as exc:
        raise PreparedPlaybackError("The saved playback registry contains an invalid entry.") from exc
    if _key(sorted(entries)) != PINNED_SHOWCASE_MANIFEST_HASH:
        raise PreparedPlaybackError("The saved playback registry membership does not match this release.")
    if _registry_digest(list(entries.values())) != PINNED_SHOWCASE_REGISTRY_DIGEST:
        raise PreparedPlaybackError("The saved playback registry entries do not match this release.")
    return entries


def prepared_registry() -> dict[str, FrozenPlaybackEntry]:
    raw = os.getenv(REGISTRY_ENV)
    if not raw:
        raise PreparedPlaybackError("The saved playback registry is not configured.")
    return _parse_registry(raw)


def find_prepared_entry(spec: PlaybackSpec) -> FrozenPlaybackEntry | None:
    entry = prepared_registry().get(spec.registry_key)
    return entry if entry is not None and entry_matches_spec(entry, spec) else None


def is_saved_run_workspace(workspace_id: str) -> bool:
    """Recognize the pinned release even when deployment config is absent.

    This positive identity prevents a missing/mistyped environment variable
    from routing fixed public assets into the private lazy-generation path.
    """
    configured = os.getenv("ADPROOF_SHOWCASE_WORKSPACE_ID")
    return workspace_id == PINNED_SHOWCASE_WORKSPACE_ID or (
        bool(configured) and workspace_id == configured
    )


def _checked_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in _ALLOWED_STREAM_HOSTS:
        raise PreparedPlaybackError("Playback validation encountered an unexpected host.")
    if (
        not re.fullmatch(r"/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+", parsed.path)
        or ".." in parsed.path.split("/")
    ):
        raise PreparedPlaybackError("Playback validation encountered an unexpected path.")
    return url


def _manifest_uris(body: str) -> list[str]:
    if not body.lstrip().startswith("#EXTM3U"):
        raise PreparedPlaybackError("Playback validation did not receive an HLS manifest.")
    uris: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            uris.extend(match.group(1) for match in _URI_ATTRIBUTE.finditer(line))
        else:
            uris.append(stripped)
    if not uris:
        raise PreparedPlaybackError("Playback validation found no HLS media URI.")
    return [_checked_url(uri) for uri in uris]


def validate_hls_chain(stream_url: str) -> str:
    """Validate master -> rendition -> segment without retaining media bytes."""
    master_url = _checked_url(stream_url)
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        master = client.get(master_url)
        master.raise_for_status()
        master_uris = _manifest_uris(master.text)
        first = master_uris[0]
        digest = hashlib.sha256(master.content)
        if urlparse(first).path.endswith(".m3u8"):
            rendition = client.get(first)
            rendition.raise_for_status()
            digest.update(rendition.content)
            segment_url = _manifest_uris(rendition.text)[0]
        else:
            segment_url = first
        with client.stream("GET", segment_url) as segment:
            segment.raise_for_status()
            first_chunk = next(segment.iter_bytes(4096), b"")
            if not first_chunk:
                raise PreparedPlaybackError("Playback validation received an empty segment.")
            digest.update(first_chunk)
    return digest.hexdigest()


def preflight_showcase_playback(
    session: Session,
    workspace_id: str,
    *,
    expected_cited_references: int | None = None,
    expected_receipts: int | None = None,
    expected_manifest_hash: str | None = None,
) -> dict[str, object]:
    manifest = build_showcase_manifest(session, workspace_id)
    specs = list(manifest.specs)
    registry_manifest_hash = manifest.manifest_hash
    try:
        entries = prepared_registry()
    except PreparedPlaybackError:
        entries = {}
    missing = misbound = 0
    for spec in specs:
        entry = entries.get(spec.registry_key)
        if entry is None:
            missing += 1
        elif not entry_matches_spec(entry, spec):
            misbound += 1
    contract_matches = (
        manifest.missing_cited_reference_count == 0
        and (expected_cited_references is None or manifest.cited_reference_count == expected_cited_references)
        and (expected_receipts is None or len(specs) == expected_receipts)
        and (expected_manifest_hash is None or registry_manifest_hash == expected_manifest_hash)
    )
    return {
        "ready": contract_matches and not (missing or misbound),
        "expected_count": len(specs),
        "cited_reference_count": manifest.cited_reference_count,
        "missing_cited_reference_count": manifest.missing_cited_reference_count,
        "source_count": manifest.source_count,
        "clip_count": manifest.clip_count,
        "contract_matches": contract_matches,
        "prepared_count": len(specs) - missing - misbound,
        "missing_count": missing,
        "misbound_count": misbound,
        "padding_policy_version": PADDING_POLICY_VERSION,
        "registry_manifest_hash": registry_manifest_hash,
    }


def assert_showcase_release_ready(session: Session, workspace_id: str | None) -> None:
    """Fail a production cold start unless DB truth and frozen JSON agree."""
    if not workspace_id or workspace_id != PINNED_SHOWCASE_WORKSPACE_ID:
        raise PreparedPlaybackError(
            "The saved-run workspace is missing or does not match this release."
        )
    result = preflight_showcase_playback(
        session,
        workspace_id,
        expected_cited_references=22,
        expected_receipts=PINNED_SHOWCASE_ENTRY_COUNT,
        expected_manifest_hash=PINNED_SHOWCASE_MANIFEST_HASH,
    )
    if not result["ready"] or result["source_count"] != 2 or result["clip_count"] != 21:
        raise PreparedPlaybackError(
            "The saved-run database and playback registry do not match this release."
        )


def assert_showcase_registry_configured(workspace_id: str | None) -> None:
    """Cold-start gate using only deterministic server-local configuration.

    Serverless instances must never run schema DDL or the full database graph
    preflight while handling viewer traffic. The deploy/operator preflight
    remains authoritative for DB membership and HLS health; each playback
    request still authorizes and verifies its exact asset/provider binding.
    """
    if not workspace_id or workspace_id != PINNED_SHOWCASE_WORKSPACE_ID:
        raise PreparedPlaybackError(
            "The saved-run workspace is missing or does not match this release."
        )
    entries = prepared_registry()
    if len(entries) != PINNED_SHOWCASE_ENTRY_COUNT:
        raise PreparedPlaybackError(
            "The saved playback registry does not match this release."
        )


def health_check_showcase_playback(
    session: Session,
    workspace_id: str,
    *,
    validator: Callable[[str], str] = validate_hls_chain,
    expected_cited_references: int | None = None,
    expected_receipts: int | None = None,
    expected_manifest_hash: str | None = None,
) -> dict[str, object]:
    """Validate every pinned locator without writes or provider generation."""
    preflight = preflight_showcase_playback(
        session,
        workspace_id,
        expected_cited_references=expected_cited_references,
        expected_receipts=expected_receipts,
        expected_manifest_hash=expected_manifest_hash,
    )
    if not preflight["ready"]:
        return {**preflight, "healthy_count": 0, "unhealthy_count": 0}
    entries = prepared_registry()
    manifest = build_showcase_manifest(session, workspace_id)
    healthy = unhealthy = 0
    for spec in manifest.specs:
        entry = entries[spec.registry_key]
        try:
            validator(entry.provider_stream_url)
            healthy += 1
        except Exception:  # noqa: BLE001
            unhealthy += 1
    return {
        **preflight,
        "ready": bool(preflight["ready"] and unhealthy == 0),
        "healthy_count": healthy,
        "unhealthy_count": unhealthy,
    }
