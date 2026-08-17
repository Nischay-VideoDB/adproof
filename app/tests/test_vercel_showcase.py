"""Static deployment boundary for the public prepared-review walkthrough."""

import json
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parent.parent
PUBLIC = APP_ROOT / "public"


def test_vercel_deploys_only_the_static_prepared_showcase():
    config = json.loads((APP_ROOT / "vercel.json").read_text())
    assert config["outputDirectory"] == "public"
    assert config["rewrites"] == [
        {"source": "/favicon.ico", "destination": "/adproof-mark.svg"}
    ]
    assert not (APP_ROOT / "api").exists()


def test_favicon_is_explicitly_linked_and_available_from_the_static_output():
    page = (PUBLIC / "index.html").read_text()
    icon = PUBLIC / "adproof-mark.svg"
    assert 'rel="icon" href="/adproof-mark.svg" type="image/svg+xml"' in page
    assert 'rel="shortcut icon" href="/favicon.ico"' in page
    assert icon.is_file()
    assert "<title id=\"title\">AdProof</title>" in icon.read_text()


def test_prepared_review_covers_the_four_documented_outcome_shapes():
    page = (PUBLIC / "index.html").read_text()
    scenarios = (PUBLIC / "prepared-scenarios.js").read_text()
    for label in (
        "A - requirements observed",
        "B - disclosure needs review",
        "C - blocking claim finding",
        "D - duration is uncertain",
    ):
        assert label in scenarios
    assert "Representative data - read only" in page
    assert "write to a database" in page


def test_public_showcase_has_no_provider_or_mutation_path():
    combined = "\n".join(path.read_text() for path in PUBLIC.iterdir() if path.is_file())
    for forbidden in (
        "VIDEODB_API_KEY",
        "ADPROOF_DATABASE_URL",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "FormData",
        "/api/submissions",
        "<input",
        "<form",
    ):
        assert forbidden not in combined
    assert "localReviews" in combined
    assert "localReviews.clear" in combined
