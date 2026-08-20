import json
import os
import subprocess
import sys

import pytest


def _registry_payload(prepared, spec, *, url="https://play.videodb.io/v1/frozen.m3u8"):
    manifest_hash = prepared._key([spec.registry_key])
    row = {
        "k": spec.registry_key,
        "w": spec.workspace_id,
        "a": spec.media_asset_id,
        "t": spec.playback_kind,
        "s": spec.playback_start_seconds,
        "e": spec.playback_end_seconds,
        "u": url,
        "b": spec.provider_binding_hash,
    }
    entry = prepared.FrozenPlaybackEntry(
        registry_key=row["k"], workspace_id=row["w"], media_asset_id=row["a"],
        playback_kind=row["t"], playback_start_seconds=row["s"],
        playback_end_seconds=row["e"], provider_stream_url=row["u"],
        provider_binding_hash=row["b"],
    )
    return json.dumps(
        {
            "v": 1,
            "manifest_hash": manifest_hash,
            "registry_digest": prepared._registry_digest([entry]),
            "entries": [row],
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def test_frozen_registry_validates_schema_membership_and_binding(monkeypatch):
    from adproof import showcase_playback as prepared

    spec = prepared.PlaybackSpec(
        registry_key="frozen-key",
        workspace_id="workspace",
        media_asset_id="asset",
        provider_video_id="provider-video",
        provider_collection_id=None,
        playback_kind="evidence",
        playback_start_seconds=1.0,
        playback_end_seconds=11.0,
    )
    manifest_hash = prepared._key([spec.registry_key])
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_MANIFEST_HASH", manifest_hash)
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_ENTRY_COUNT", 1)
    raw = _registry_payload(prepared, spec)
    digest = json.loads(raw)["registry_digest"]
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_REGISTRY_DIGEST", digest)
    monkeypatch.setenv(prepared.REGISTRY_ENV, raw)
    prepared._parse_registry.cache_clear()

    entry = prepared.find_prepared_entry(spec)
    assert entry is not None
    assert entry.registry_key == spec.registry_key
    assert entry.media_asset_id == spec.media_asset_id
    assert entry.provider_stream_url.startswith("https://play.videodb.io/")

    changed_binding = prepared.PlaybackSpec(
        **{**spec.__dict__, "provider_video_id": "different-provider-video"}
    )
    assert prepared.find_prepared_entry(changed_binding) is None

    mutated = json.loads(raw)
    mutated["entries"][0]["u"] = "https://play.videodb.io/v1/wrong.m3u8"
    monkeypatch.setenv(prepared.REGISTRY_ENV, json.dumps(mutated))
    prepared._parse_registry.cache_clear()
    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.prepared_registry()


def test_frozen_registry_fails_closed_when_absent_or_malformed(monkeypatch):
    from adproof import showcase_playback as prepared

    monkeypatch.delenv(prepared.REGISTRY_ENV, raising=False)
    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.prepared_registry()
    monkeypatch.setenv(prepared.REGISTRY_ENV, "not-json")
    prepared._parse_registry.cache_clear()
    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.prepared_registry()


def test_health_check_reads_frozen_registry_without_generation(monkeypatch):
    from adproof import showcase_playback as prepared

    spec = prepared.PlaybackSpec(
        registry_key="health-key",
        workspace_id="workspace",
        media_asset_id="asset",
        provider_video_id="provider-video",
        provider_collection_id=None,
        playback_kind="full_source",
    )
    manifest_hash = prepared._key([spec.registry_key])
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_MANIFEST_HASH", manifest_hash)
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_ENTRY_COUNT", 1)
    raw = _registry_payload(prepared, spec)
    monkeypatch.setattr(prepared, "PINNED_SHOWCASE_REGISTRY_DIGEST", json.loads(raw)["registry_digest"])
    monkeypatch.setenv(prepared.REGISTRY_ENV, raw)
    prepared._parse_registry.cache_clear()
    monkeypatch.setattr(
        prepared,
        "preflight_showcase_playback",
        lambda *_a, **_k: {"ready": True},
    )
    monkeypatch.setattr(
        prepared,
        "build_showcase_manifest",
        lambda *_a: prepared.ShowcaseManifest((spec,), 0, 0, 1, 0),
    )
    checked = []
    result = prepared.health_check_showcase_playback(
        object(), "workspace", validator=lambda url: checked.append(url) or "ok"
    )
    assert result == {"ready": True, "healthy_count": 1, "unhealthy_count": 0}
    assert len(checked) == 1


def test_registry_cli_has_no_generation_refresh_or_schema_mutation():
    from pathlib import Path

    script = (Path(__file__).parents[1] / "scripts" / "prepare_showcase_playback.py").read_text()
    assert "--health-check" in script
    assert "--refresh" not in script
    assert "init_db" not in script
    assert "VideoDBAdapter" not in script
    assert "generate_stream" not in script


def test_release_gate_requires_pinned_workspace_and_exact_live_contract(monkeypatch):
    from adproof import showcase_playback as prepared

    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.assert_showcase_release_ready(object(), None)
    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.assert_showcase_release_ready(object(), "wrong-workspace")

    monkeypatch.setattr(
        prepared,
        "preflight_showcase_playback",
        lambda *_a, **_k: {
            "ready": True,
            "source_count": 2,
            "clip_count": 21,
        },
    )
    prepared.assert_showcase_release_ready(
        object(), prepared.PINNED_SHOWCASE_WORKSPACE_ID
    )


def test_cold_start_gate_is_local_registry_only(monkeypatch):
    from adproof import showcase_playback as prepared

    monkeypatch.setattr(prepared, "prepared_registry", lambda: {str(i): object() for i in range(23)})
    prepared.assert_showcase_registry_configured(prepared.PINNED_SHOWCASE_WORKSPACE_ID)
    with pytest.raises(prepared.PreparedPlaybackError):
        prepared.assert_showcase_registry_configured("wrong-workspace")


def test_production_startup_never_runs_schema_bootstrap(monkeypatch):
    import adproof.api.main as main

    monkeypatch.setenv("ADPROOF_ENV", "production")
    monkeypatch.setenv("ADPROOF_SHOWCASE_WORKSPACE_ID", "workspace")
    calls = []
    monkeypatch.setattr(main, "init_db", lambda: calls.append("ddl"))
    monkeypatch.setattr(
        main, "assert_showcase_registry_configured", lambda workspace: calls.append(workspace)
    )
    main._startup()
    assert calls == ["workspace"]


def test_production_engine_does_not_retain_serverless_connections():
    env = {
        **os.environ,
        "ADPROOF_ENV": "production",
        "ADPROOF_DATABASE_URL": "sqlite+pysqlite:///:memory:",
    }
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from adproof.db import engine; print(type(engine.pool).__name__)",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.stdout.strip() == "NullPool"


def test_pinned_saved_workspace_cannot_fall_through_when_env_is_missing(monkeypatch):
    from adproof import showcase_playback as prepared

    monkeypatch.delenv("ADPROOF_SHOWCASE_WORKSPACE_ID", raising=False)
    assert prepared.is_saved_run_workspace(prepared.PINNED_SHOWCASE_WORKSPACE_ID)
    assert not prepared.is_saved_run_workspace("private-workspace")
