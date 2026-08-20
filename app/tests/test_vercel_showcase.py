"""Vercel serves the real app and retires the legacy walkthrough."""

import json
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parent.parent
PUBLIC = APP_ROOT / "public"


def test_vercel_deploys_fastapi_with_bounded_duration():
    config = json.loads((APP_ROOT / "vercel.json").read_text())
    assert config["functions"]["api/index.py"]["maxDuration"] == 1800
    assert config["rewrites"][-2] == {
        "source": "/api/:path*",
        "destination": "/api/index.py",
    }
    assert (APP_ROOT / "api" / "index.py").is_file()


def test_favicon_is_explicitly_linked_and_available_from_the_static_output():
    page = (PUBLIC / "app" / "index.html").read_text()
    icon = PUBLIC / "adproof-mark.svg"
    assert 'rel="icon"' in page
    assert icon.is_file()
    assert "<title id=\"title\">AdProof</title>" in icon.read_text()


def test_legacy_examples_are_not_a_public_static_page():
    config = json.loads((APP_ROOT / "vercel.json").read_text())
    redirects = {(item["source"], item["destination"]) for item in config["rewrites"]}
    assert ("/examples", "/app") in redirects
    assert ("/examples.html", "/app") in redirects
    assert not (PUBLIC / "examples.html").exists()
