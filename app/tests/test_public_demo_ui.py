"""Public-demo-first application shell contract."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_deployed_and_source_web_assets_are_identical():
    pairs = (
        ("public/static/app.js", "src/adproof/web/app.js"),
        ("public/static/styles.css", "src/adproof/web/styles.css"),
        ("public/app/index.html", "src/adproof/web/index.html"),
        ("public/index.html", "src/adproof/web/landing.html"),
    )
    for public, source in pairs:
        assert (ROOT / public).read_bytes() == (ROOT / source).read_bytes()


def test_same_app_url_opens_demo_and_write_ctas_escalate_to_login():
    html = (ROOT / "public/app/index.html").read_text()
    js = (ROOT / "public/static/app.js").read_text()
    landing = (ROOT / "public/index.html").read_text()

    assert 'id="login-view"' not in html
    assert 'id="login-dialog"' in html
    assert 'id="auth-action"' in html
    assert 'href="/app?demo=1"' not in landing
    assert 'href="/app"' in landing

    assert "establishDemoSession()" in js
    assert '$("auth-action").textContent = "Log in"' in js
    assert 'openLogin(' in js
    assert '"submission"' in js
    assert '"campaign"' in js
    assert '$("new-submission").disabled = false' in js
    assert '$("new-campaign").disabled = false' in js
    assert "showLogin" not in js
