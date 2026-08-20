"""Public-demo-first application shell contract."""

from pathlib import Path
import re


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


def test_application_shell_has_unique_ids():
    html = (ROOT / "public/app/index.html").read_text()
    ids = re.findall(r'\bid="([^"]+)"', html)
    assert len(ids) == len(set(ids))
    assert 'id="submission-form-error"' in html


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
    assert 'class="review-matrix"' in js
    assert 'id="requirement-picker"' in html
    assert 'id="evidence-workspace"' in html
    assert 'styles.css?v=21' in html
    assert 'app.js?v=21' in html
    assert "remain marked uncertain after human review" in js
    assert "requestedEpoch !== selectionEpoch" in js
    assert 'data.playback_mode === "full_source_context"' in js
    assert "player.currentTime = fullSourceContext ? data.detected_start_seconds : 0" in js
    assert 'evidence_viewed: evidenceViewed' in js


def test_saved_run_information_architecture_and_copy_contract():
    html = (ROOT / "public/app/index.html").read_text()
    js = (ROOT / "public/static/app.js").read_text()
    landing = (ROOT / "public/index.html").read_text()
    seed = (ROOT / "scripts/seed_showcase.py").read_text()

    assert html.index('data-view="review"') < html.index('data-view="campaigns"')
    assert 'class="tab active" role="tab" aria-selected="true" data-view="review"' in html
    assert 'id="submission-picker"' in html
    assert 'id="submission-summary"' in html
    assert 'id="requirement-picker"' in html
    assert 'id="requirement-measurement"' in html
    assert 'class="requirement-rail"' not in html
    assert 'id="campaign-picker"' in html
    assert 'class="review-matrix"' in js
    assert 'class="matrix-cards"' in js
    assert 'aria-label="${esc(row.creator_reference)} — requirement' in js
    assert '$("analytics-tab").hidden = true' in js
    assert 'if (view === "analytics" && isDemoVisitor()) view = "review"' in js
    assert "Continue with saved runs" in html
    assert 'href="/examples"' not in landing

    banned = (
        "What this build does and does not do",
        "Showcase · read only",
        "Curated demonstration",
        "live sandbox",
        "Processing and audit details",
        "How this check was evaluated",
        "Retrieved context did not qualify",
        "Viewing public demo",
        "computed in code, never by a language model",
        "There is no fixture data anywhere",
        "no silent fallback",
        "fictional curated",
        "not instructions from the creator",
        "Can we see how a result was produced?",
        "adproof.example",
        "No-hit receipt",
    )
    combined = html + js + landing + seed
    for phrase in banned:
        assert phrase not in combined


def test_selection_is_atomic_and_never_autoplays_on_navigation():
    js = (ROOT / "public/static/app.js").read_text()
    assert "let selectionEpoch = 0" in js
    assert "let mediaEpoch = 0" in js
    assert "reportController?.abort()" in js
    assert "playbackController?.abort()" in js
    assert "hls.destroy()" in js
    assert 'player.removeAttribute("src")' in js
    assert "requestedEpoch !== selectionEpoch" in js
    assert "submissionId !== currentSubmissionId || ruleId !== selectedRuleId" in js
    assert "preloadPlayer" not in js
    assert "targetEvidence" not in js
    assert 'loadStream(data.playback_url, () => $("player").play()' not in js
    assert '$("login-cancel").addEventListener("click", () => {' in js
    assert '$("requirement-picker").addEventListener("change"' in js
    assert "pendingMediaListeners" in js
    assert "removeEventListener(type, listener)" in js
    assert 'querySelectorAll(".btn-play.active")' in js
    assert "if (!stillCurrent()) return" in js
    assert 'if (view !== currentView) stopPlayback({ clearDetail: false, invalidateReport: false })' in js
    assert js.count('invalidateReport: false') >= 4
    assert "if (invalidateReport)" in js
    assert "epoch !== mediaEpoch" in js
    assert '"Full source playback is unavailable. Try again."' in js
    assert '"This saved run could not be loaded. Try again."' in js


def test_identity_and_campaign_boundaries_clear_stale_content():
    js = (ROOT / "public/static/app.js").read_text()
    assert "function clearReportView" in js
    assert "if (!selectedStillExists)" in js
    assert '$("report-body").hidden = true' in js
    assert '$("submission-summary").innerHTML = ""' in js
    assert '$("source-attribution").hidden = true' in js
    assert '$("adjudication-slot").innerHTML = ""' in js
    assert "submissionListController?.abort()" in js
    assert "campaignController?.abort()" in js
    assert "const epoch = ++campaignEpoch" in js
    assert '$("campaign-dashboard").setAttribute("aria-busy", "true")' in js
    assert "requestedId !== currentCampaignId || epoch !== campaignEpoch" in js


def test_campaign_decisions_remain_truthful_on_desktop_and_mobile():
    js = (ROOT / "public/static/app.js").read_text()
    assert 'request_changes: "Changes requested"' in js
    assert 'escalate: "Escalated"' in js
    assert 'class="mobile-decision"' in js
    assert "renderDecisionStatus(row.final_decision)" in js
    assert "FINAL_DECISION_LABELS[d.decision]" in js


def test_human_override_and_machine_measurement_are_not_conflated():
    js = (ROOT / "public/static/app.js").read_text()
    assert 'return "Passed after review"' in js
    assert '"Automated exact match"' in js
    assert '"Automated check"' in js
    assert '"Review basis"' in js
    assert "<strong>Full-source review</strong>" in js
    assert 'class="recorded-resolution"' in js
    assert "Reviewer confirmed this requirement in the cited evidence." in js
    assert "Reviewer recorded this as met during full-source review." in js
    assert "const noHit = rule.no_hit_receipt && !override" in js
    assert "EVIDENCE_TOKEN_LABELS" in js
    assert 'DISCLOSURE_ABSENT: "Disclosure not visible or audible"' in js
    assert "displayEvidenceText(ev.text)" in js


def test_mobile_topbar_height_allows_wrapped_navigation():
    css = (ROOT / "public/static/styles.css").read_text()
    final_relaunch = css.rsplit("/* ── saved-run hierarchy", 1)[-1]
    assert "@media (max-width: 900px)" in final_relaunch
    assert ".topbar { height: auto; min-height: 60px; padding-block: 10px; }" in final_relaunch


def test_matrix_header_does_not_cover_clickable_result_rows():
    css = (ROOT / "public/static/styles.css").read_text()
    final_relaunch = css.rsplit("/* ── saved-run hierarchy", 1)[-1]
    assert ".review-matrix thead th { top: 0; z-index: 2; }" in final_relaunch
    assert ".review-matrix thead th { top: 68px" not in final_relaunch
