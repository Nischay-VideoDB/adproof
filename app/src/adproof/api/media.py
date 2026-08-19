"""Authorized media proxy.

Closes the gap recorded as assumption A-10 and VERIFIED on 2026-07-26: VideoDB
playback URLs return 200 with no credential, so anyone who ever sees one can
watch unpublished creator media forever.

Nothing here trusts the client. Two independent controls guard every fetch:

  1. a short-lived, signed media token bound to BOTH the caller and one asset;
  2. an HMAC over the upstream URL, plus a strict host allowlist.

Without (2) the proxy would fetch arbitrary client-supplied URLs, turning it
into a server-side request forgery relay against anything the server can reach.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import EvidencePlaybackWindow, MediaAsset
from ..security import (
    TokenError,
    open_upstream_url,
    read_media_token,
    seal_upstream_url,
)
from ..states import CAN_READ
from .auth import Principal, authorized_media_asset, current_principal

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/media", tags=["media"])

#: The ONLY hosts this proxy will fetch from. Verified against the live service:
#: manifests and segments are served from play.videodb.io.
_ALLOWED_HOSTS = frozenset({"play.videodb.io"})

#: Manifests are small; segments stream. Bounded so a hostile upstream cannot
#: exhaust memory.
_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_SEGMENT_CHUNK = 64 * 1024


def _check_host(url: str) -> str:
    """Allowlist check, applied to EVERY upstream fetch without exception."""
    host = (urlparse(url).hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        logger.warning("blocked proxy attempt to non-allowlisted host %r", host)
        raise HTTPException(403, "Upstream host is not allowed.")
    if urlparse(url).scheme != "https":
        raise HTTPException(403, "Upstream must be HTTPS.")
    return url


def _open_upstream(sealed: str, media_asset_id: str) -> str:
    """Decrypt a client-held upstream reference, then allowlist its host.

    The reference is ciphertext, so the client never learns the provider URL
    and cannot bypass this proxy. Decryption is authenticated, so tampering
    fails closed. The host allowlist remains as an independent second control.
    """
    try:
        url = open_upstream_url(sealed, media_asset_id)
    except TokenError as exc:
        raise HTTPException(403, str(exc)) from exc
    return _check_host(url)


def _grant(token: str, session: Session, principal: Principal) -> MediaAsset:
    """Validate a media token and re-authorize its principal and asset."""
    try:
        grant = read_media_token(token)
    except TokenError as exc:
        raise HTTPException(403, f"Media access token is not valid: {exc}") from exc
    if grant.user_id != principal.user.id:
        raise HTTPException(403, "Media access token belongs to another account.")
    return authorized_media_asset(session, principal, grant.media_asset_id, CAN_READ)


def _proxied(
    request: Request, token: str, media_asset_id: str, kind: str, url: str
) -> str:
    """Build a URL pointing back at this proxy for a rewritten upstream URL."""
    base = str(request.base_url).rstrip("/")
    query = urlencode({"u": seal_upstream_url(url, media_asset_id)})
    return f"{base}/media/{token}/{kind}?{query}"


def _rewrite_manifest(
    body: str, request: Request, token: str, media_asset_id: str, next_kind: str
) -> str:
    """Rewrite absolute URLs in an HLS manifest to point back at this proxy.

    Both URI lines and URI attributes in HLS tags are rewritten. Unknown URI
    forms fail closed so an upstream locator can never survive in client text.
    """
    uri_attribute = re.compile(r'URI="([^"]+)"')
    out = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            out.append(line)
            continue
        if stripped.startswith("#"):
            def replace_uri(match: re.Match[str]) -> str:
                upstream_url = match.group(1)
                if not upstream_url.startswith("https://"):
                    raise HTTPException(
                        502, "Upstream manifest used an unexpected URI attribute."
                    )
                return f'URI="{_proxied(request, token, media_asset_id, next_kind, upstream_url)}"'

            # Refuse an absolute locator outside a parsed URI attribute.
            scrubbed = uri_attribute.sub('URI=""', line)
            if "https://" in scrubbed or "http://" in scrubbed:
                raise HTTPException(502, "Upstream manifest contained an unsafe URI.")
            rewritten = uri_attribute.sub(replace_uri, line)
            out.append(rewritten)
            continue
        if stripped.startswith("https://"):
            out.append(_proxied(request, token, media_asset_id, next_kind, stripped))
        else:
            # Relative URI. Not observed from this provider; refuse rather than
            # guess at a base and silently fetch the wrong thing.
            raise HTTPException(
                502, "Upstream manifest used an unexpected relative URI form."
            )
    return "\n".join(out) + "\n"


@router.get("/{token}/master.m3u8")
def master_playlist(
    token: str,
    request: Request,
    e: str | None = Query(default=None),
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> Response:
    asset = _grant(token, session, principal)
    playback_url = asset.provider_stream_url
    if e:
        window = session.get(EvidencePlaybackWindow, e)
        if window is None or window.media_asset_id != asset.id:
            raise HTTPException(404, "Evidence playback window not found.")
        playback_url = window.provider_stream_url
    if not playback_url:
        raise HTTPException(409, "No playable stream is recorded for this media.")
    # Sourced from our own database, so only the host allowlist applies.
    master_url = _check_host(playback_url)

    try:
        upstream = httpx.get(master_url, timeout=20.0)
        upstream.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("upstream media manifest fetch failed")
        raise HTTPException(502, "Could not fetch the media manifest.") from exc

    if len(upstream.content) > _MAX_MANIFEST_BYTES:
        raise HTTPException(502, "Upstream manifest is implausibly large.")

    body = _rewrite_manifest(
        upstream.text, request, token, asset.id, "variant.m3u8"
    )
    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/{token}/variant.m3u8")
def variant_playlist(
    token: str,
    request: Request,
    u: str = Query(...),
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> Response:
    asset = _grant(token, session, principal)
    url = _open_upstream(u, asset.id)
    try:
        upstream = httpx.get(url, timeout=20.0)
        upstream.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("upstream media playlist fetch failed")
        raise HTTPException(502, "Could not fetch the media playlist.") from exc

    if len(upstream.content) > _MAX_MANIFEST_BYTES:
        raise HTTPException(502, "Upstream playlist is implausibly large.")

    body = _rewrite_manifest(upstream.text, request, token, asset.id, "segment")
    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/{token}/segment")
def segment(
    token: str,
    u: str = Query(...),
    principal: Principal = Depends(current_principal),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Stream one media segment. Bytes are relayed, never buffered whole."""
    asset = _grant(token, session, principal)
    url = _open_upstream(u, asset.id)

    def stream():
        try:
            with httpx.stream("GET", url, timeout=30.0) as upstream:
                upstream.raise_for_status()
                yield from upstream.iter_bytes(_SEGMENT_CHUNK)
        except httpx.HTTPError as exc:
            logger.error("upstream media segment fetch failed")
            # The generator has already started; the connection simply ends.
            return

    return StreamingResponse(
        stream(),
        media_type="video/mp2t",
        headers={"Cache-Control": "private, no-store"},
    )


# -- token issuance --------------------------------------------------------


def issue_playback(
    session: Session,
    principal: Principal,
    media_asset_id: str,
    evidence_window_id: str | None = None,
) -> dict[str, str]:
    """Authorize the caller for one asset and return proxied playback details.

    The provider URL is deliberately NOT returned: handing it to the client
    would reinstate exactly the leak this module exists to close.
    """
    from ..security import issue_media_token

    authorized_media_asset(session, principal, media_asset_id, CAN_READ)
    token = issue_media_token(principal.user.id, media_asset_id)
    playback_url = f"/media/{token}/master.m3u8"
    if evidence_window_id:
        playback_url += "?" + urlencode({"e": evidence_window_id})
    return {
        "playback_url": playback_url,
        "access_control": "adproof_proxied_short_lived_token",
    }


__all__ = ["router", "issue_playback", "current_principal"]
