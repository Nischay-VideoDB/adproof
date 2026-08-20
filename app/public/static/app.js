/* AdProof campaign and submission workspace. */

let currentUser = null;
let currentWorkspaces = [];
let campaigns = [];
let integrityData = null;
let pendingAuthIntent = null;
let continueToSubmission = false;

async function api(path, options = {}) {
  const request = () => fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let res = await request();
  if (res.status === 401 && (!currentUser || isDemoVisitor())) {
    const guest = await establishDemoSession();
    if (guest) res = await request();
  }
  if (res.status === 401) {
    openLogin("Your session expired. Log in again to continue your work.");
    throw new Error("unauthenticated");
  }
  return res;
}

function isDemoVisitor() {
  return Boolean(currentUser?.is_demo);
}

function openLogin(context, intent = null) {
  stopPlayback({ clearDetail: false, invalidateReport: false });
  if (intent) pendingAuthIntent = intent;
  $("login-context").textContent = context ||
    "Access your private workspace and continue your campaign work.";
  $("login-error").hidden = true;
  const dialog = $("login-dialog");
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $("login-email").focus());
}

function showApp() {
  document.getElementById("app-view").hidden = false;
}

async function establishDemoSession() {
  const response = await fetch("/api/auth/demo", {
    method: "POST",
    credentials: "same-origin",
  });
  return response.ok;
}

const STATE_LABEL = {
  pass: "Pass",
  fail: "Fail",
  uncertain: "Uncertain",
  not_evaluated: "Not evaluated",
  human_review_required: "Human review required",
  processing: "Still processing",
  error: "Error",
  changes_requested: "Changes requested",
  escalated: "Escalated",
  approved: "Approved",
  rejected: "Rejected",
};
const labelState = (state) => STATE_LABEL[state] || String(state || "").replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const effectiveState = (rule) => (rule.reviews || []).at(-1)?.human_state || rule.result?.state || "processing";
const reviewOverride = (rule) => {
  const review = (rule.reviews || []).at(-1);
  return review?.human_state && review.human_state !== rule.result?.state ? review : null;
};
const effectiveStateLabel = (rule) => {
  const state = effectiveState(rule);
  if (!reviewOverride(rule)) return labelState(state);
  if (state === "pass") return "Passed after review";
  if (state === "fail") return "Failed after review";
  return `${labelState(state)} after review`;
};


let currentSubmissionId = null;
let currentCampaignId = null;
let selectedRuleId = null;
let currentReport = null;
let currentEvidenceId = null;
let hls = null;
let pollTimer = null;
let selectionEpoch = 0;
let mediaEpoch = 0;
let reportController = null;
let playbackController = null;
let campaignController = null;
let currentView = "review";
let campaignEpoch = 0;
let pendingMediaListeners = [];
let submissionListController = null;
let submissionListEpoch = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const fmtTime = (s) => {
  if (s === null || s === undefined) return "—";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${m}:${sec}`;
};
const EVIDENCE_TOKEN_LABELS = {
  ACTION_VISIBLE: "Action visible",
  NO_ACTION_MARKER: "No clear action marker",
  DISCLOSURE_PRESENT: "Disclosure present",
  DISCLOSURE_ABSENT: "Disclosure not visible or audible",
};
const displayEvidenceText = (value) => String(value ?? "").replace(
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g,
  (token) => EVIDENCE_TOKEN_LABELS[token] || `${token[0]}${token.slice(1).toLowerCase().replaceAll("_", " ")}`
);

async function loadIntegrity() {
  let data;
  try {
    const response = await api("/api/integrity");
    if (!response.ok) throw new Error(`integrity endpoint returned ${response.status}`);
    data = await response.json();
    integrityData = data;
  } catch (err) {
    return;
  }
  try {
    const directUpload = Boolean(data.input_capabilities?.direct_file_upload);
    const uploadField = $("file-upload-field");
    const fileInput = uploadField?.querySelector('input[name="file"]');
    const urlInput = document.querySelector(
      '#submission-form input[name="source_url"]'
    );
    if (uploadField) uploadField.hidden = !directUpload;
    if (fileInput) fileInput.disabled = !directUpload;
    if (urlInput) urlInput.required = !directUpload;
    if ($("input-guidance")) {
      $("input-guidance").textContent = directUpload
        ? "Submit a local video or a durable public URL."
        : data.input_capabilities?.production_guidance;
    }
  } catch (err) {
    console.warn("Integrity disclosure could not be rendered", err);
  }
}

function stopPlayback({ clearDetail = true, invalidateReport = true } = {}) {
  mediaEpoch += 1;
  if (invalidateReport) {
    selectionEpoch += 1;
    reportController?.abort();
    reportController = null;
  }
  playbackController?.abort();
  playbackController = null;
  const player = $("player");
  pendingMediaListeners.forEach(([type, listener]) => player?.removeEventListener(type, listener));
  pendingMediaListeners = [];
  player?.pause();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (player) {
    player.removeAttribute("src");
    player.dataset.src = "";
    player.load();
  }
  currentEvidenceId = null;
  document.querySelectorAll(".btn-play.active").forEach((button) => button.classList.remove("active"));
  $("detection-marker")?.setAttribute("hidden", "");
  if ($("player-note")) $("player-note").textContent = "Choose an evidence moment to play it.";
  if (clearDetail) {
    if ($("evidence-list")) $("evidence-list").innerHTML = "";
    if ($("requirement-measurement")) $("requirement-measurement").innerHTML = "";
    if ($("review-controls")) $("review-controls").innerHTML = "";
  }
  return mediaEpoch;
}

function clearReportView(message = "Choose a saved run to inspect its requirement evidence.") {
  stopPlayback();
  currentReport = null;
  selectedRuleId = null;
  $("report-body").hidden = true;
  $("report-placeholder").hidden = false;
  $("report-placeholder").textContent = message;
  $("report-title").textContent = "Submission";
  $("report-sub").textContent = "";
  $("submission-summary").innerHTML = "";
  $("source-attribution").hidden = true;
  $("adjudication-slot").innerHTML = "";
  $("requirement-picker").innerHTML = "";
  $("evidence-title").textContent = "Select a requirement";
  $("requirement-state").textContent = "";
}

function addPlayerListener(type, listener) {
  const player = $("player");
  pendingMediaListeners.push([type, listener]);
  player.addEventListener(type, listener, { once: true });
}

async function loadSubmissions() {
  submissionListController?.abort();
  submissionListController = new AbortController();
  const epoch = ++submissionListEpoch;
  let response;
  try {
    response = await api("/api/submissions", { signal: submissionListController.signal });
  } catch (error) {
    if (error.name === "AbortError") return;
    throw error;
  }
  const subs = await response.json();
  if (epoch !== submissionListEpoch) return;
  const selectedStillExists = subs.some((s) => s.id === currentSubmissionId);
  let shouldOpenFirst = false;
  if (!selectedStillExists) {
    clearReportView(subs.length ? "Loading saved verification run…" : "No submissions yet.");
    currentSubmissionId = subs[0]?.id || null;
    shouldOpenFirst = Boolean(currentSubmissionId);
  }
  $("submissions-empty").hidden = subs.length > 0;
  const picker = $("submission-picker");
  picker.innerHTML = subs
    .map(
      (s) => `<option value="${esc(s.id)}" ${s.id === currentSubmissionId ? "selected" : ""}>${esc(s.creator_reference)} — ${esc(s.campaign_name ?? "Campaign")} — ${esc(labelState(s.state))}</option>`
    )
    .join("");
  if (shouldOpenFirst) loadReport();
}

function selectSubmission(id, ruleId = null) {
  clearReportView("Loading saved verification run…");
  currentSubmissionId = id;
  selectedRuleId = ruleId;
  switchView("review");
  $("submission-picker").value = id;
  loadReport();
}

$("submission-picker").addEventListener("change", (event) => selectSubmission(event.target.value));

function renderEvidence(ev) {
  const label = ev.evidence_kind === "issue"
    ? "Potential issue"
    : ev.evidence_kind === "context"
      ? "Context"
      : "Measured proof";
  return `
    <button class="evidence evidence-${esc(ev.evidence_kind)} ${ev.id === currentEvidenceId ? "active" : ""} btn-play"
            data-evidence="${esc(ev.id)}" type="button">
      <span class="evidence-time">${fmtTime(ev.start_seconds)}${
            ev.end_seconds !== null && ev.end_seconds !== undefined
              ? " – " + fmtTime(ev.end_seconds)
              : ""
          }</span>
      <span class="evidence-copy"><strong>${label}</strong>${
        ev.text ? `<span>${esc(displayEvidenceText(ev.text))}</span>` : ""
      }</span>
      <span aria-hidden="true" class="evidence-arrow">→</span>
    </button>`;
}


const REASON_LABELS = {
  false_positive: "False positive — flagged something that isn't there",
  false_negative: "False negative — missed something that is there",
  insufficient_evidence: "Insufficient evidence to decide",
  wrong_timestamp: "Wrong timestamp",
  wrong_rule_interpretation: "Rule interpreted incorrectly",
  unsupported_rule: "Rule cannot be automated reliably",
  policy_disagreement: "Disagree with the policy outcome",
};

const DECISION_LABELS = {
  approve: "Approve",
  reject: "Reject",
  request_changes: "Request changes",
  escalate: "Escalate",
};
const FINAL_DECISION_LABELS = {
  approve: "Approved",
  reject: "Rejected",
  request_changes: "Changes requested",
  escalate: "Escalated",
};

function renderAdjudication(report) {
  const adj = report.adjudication;
  const permitted = new Set(adj.permitted_decisions);
  const effectiveState = (rule) =>
    (rule.reviews || []).at(-1)?.human_state || rule.result?.state;
  const failedRules = report.rules.filter((rule) => effectiveState(rule) === "fail");
  const attentionRules = report.rules.filter((rule) =>
    ["uncertain", "human_review_required"].includes(effectiveState(rule))
  );
  const presentationReasons = [...adj.reasons];
  if (failedRules.length) {
    presentationReasons.unshift(
      `${failedRules.length} requirement(s) are currently resolved as failed.`
    );
  } else if (attentionRules.length) {
    const allResolvedCopy = "Every requirement passed or was resolved by a reviewer.";
    const index = presentationReasons.indexOf(allResolvedCopy);
    if (index >= 0) presentationReasons.splice(index, 1);
    presentationReasons.unshift(
      `${attentionRules.length} requirement(s) remain marked uncertain after human review; the final routing decision is shown below.`
    );
  }

  const mayAct = (decision) =>
    decision === "approve" || decision === "reject"
      ? report.permissions.can_decide_final
      : report.permissions.can_route;
  const buttons = ["approve", "request_changes", "escalate", "reject"]
    .map((d) => {
      const enabled = permitted.has(d) && mayAct(d);
      return `<button class="btn decision-btn"
        data-decision="${d}" ${enabled ? "" : "disabled"}
        title="${enabled ? "" : "Not available until every requirement is resolved"}">
        ${esc(DECISION_LABELS[d])}
      </button>`;
    })
    .join("");
  const actions = report.permissions.read_only
    ? ""
    : `<div class="decision-actions">${buttons}</div>`;

  const history = report.decisions.length
    ? `<ul class="decision-history">${report.decisions
        .map(
          (d) => `<li>
            <strong>${esc(FINAL_DECISION_LABELS[d.decision] ?? d.decision)}</strong>
            by ${esc(d.decided_by)}
            <div class="decision-rationale">${esc(d.rationale)}</div>
          </li>`
        )
        .join("")}</ul>`
    : "";

  return `
    <div class="adjudication">
      <ul class="adj-reasons">${presentationReasons
        .map((r) => `<li>${esc(r)}</li>`)
        .join("")}</ul>
      ${actions}
      ${history}
    </div>`;
}

function renderRules(rules, permissions) {
  if (!rules.length) return;
  if (!rules.some((rule) => rule.id === selectedRuleId)) {
    const firstUnresolved = rules.find((rule) => {
      const latest = (rule.reviews || []).at(-1);
      const state = latest?.human_state || rule.result?.state;
      return ["uncertain", "human_review_required", "error", "processing"].includes(state);
    });
    selectedRuleId = (firstUnresolved || rules[0]).id;
  }
  $("requirement-picker").innerHTML = rules.map((rule) => {
    const state = effectiveState(rule);
    return `<option value="${esc(rule.id)}" ${rule.id === selectedRuleId ? "selected" : ""}>R${rule.ordinal + 1} · ${esc(rule.requirement_text)} · ${esc(labelState(state))}</option>`;
  }).join("");

  const rule = rules.find((item) => item.id === selectedRuleId);
  const res = rule.result;
  const effective = effectiveState(rule);
  const override = reviewOverride(rule);
  const subjectiveReview = rule.rule_type === "subjective_human_review";
  const measurementLabel = subjectiveReview
    ? "Review basis"
    : override
    ? (rule.rule_type === "required_spoken_phrase" ? "Automated exact match" : "Automated check")
    : "Measured proof";
  const measurement = subjectiveReview
    ? `<span>${measurementLabel}</span><strong>Full-source review</strong>`
    : res && res.measured_value !== null && res.measured_value !== undefined
    ? `<span>${measurementLabel}</span><strong>${esc(res.measured_value)} ${esc(res.measured_unit || "")}</strong>${res.threshold_value !== null && res.threshold_value !== undefined ? `<small>Requirement: ${esc(res.threshold_value)} ${esc(res.measured_unit || "")}</small>` : ""}`
    : `<span>${measurementLabel}</span><strong>${rule.evidence.length ? `${rule.evidence.length} cited moment${rule.evidence.length === 1 ? "" : "s"}` : "No cited moment"}</strong>`;
  const reviewedResolution = override
    ? `<p class="recorded-resolution"><strong>Recorded review: ${esc(labelState(override.human_state))}.</strong> ${esc(override.human_state === "pass" ? (rule.evidence.length ? "Reviewer confirmed this requirement in the cited evidence." : "Reviewer recorded this as met during full-source review.") : override.human_state === "fail" ? "Reviewer recorded that this requirement was not met." : "Reviewer kept this requirement unresolved.")}</p>`
    : "";
  const noHit = rule.no_hit_receipt && !override
    ? `<div class="no-hit"><strong>${esc({
        coverage_incomplete: "Coverage incomplete",
        no_qualifying_match: "No qualifying moment",
        missing_required_part: "A required part is missing",
        not_found: "No matching moment found",
      }[rule.no_hit_receipt.state] || "No qualifying moment")}</strong><p>${rule.no_hit_receipt.coverage_complete ? "The completed review recorded no qualifying moment for this requirement." : "The available coverage cannot support an absence conclusion."}</p></div>`
    : "";
  const reviewControls = res && permissions.can_review
    ? `<div class="review-actions"><button class="btn btn-small" data-confirm="${esc(rule.id)}">Confirm finding</button><button class="btn btn-small" data-override="${esc(rule.id)}">Record exception</button></div>`
    : "";
  $("requirement-number").textContent = `Requirement ${rule.ordinal + 1}`;
  $("evidence-title").textContent = rule.requirement_text;
  $("requirement-state").textContent = effectiveStateLabel(rule);
  $("requirement-state").className = `result-chip result-${effective}`;
  $("requirement-measurement").innerHTML = measurement + reviewedResolution;
  $("review-controls").innerHTML = reviewControls;

  const proof = rule.evidence.filter((item) => item.evidence_kind === "proof");
  const issues = rule.evidence.filter((item) => item.evidence_kind === "issue");
  const context = rule.evidence.filter((item) => item.evidence_kind === "context");
  const evidenceGroup = (title, items) => items.length ? `
    <section class="evidence-group"><h4>${title}</h4>${items.slice(0, 4).map(renderEvidence).join("")}
    ${items.length > 4 ? `<details><summary>${items.length - 4} additional moment(s)</summary>${items.slice(4).map(renderEvidence).join("")}</details>` : ""}</section>` : "";
  $("evidence-list").innerHTML = evidenceGroup("Measured moments", proof) + evidenceGroup("Potential issues", issues) + evidenceGroup("Context that may change the reading", context) + (!rule.evidence.length ? noHit : "");

  document.querySelectorAll(".btn-play").forEach((btn) => btn.addEventListener("click", () => playAt(btn.dataset.evidence)));
  document.querySelectorAll("[data-confirm]").forEach((btn) =>
    btn.addEventListener("click", () => submitReview(btn.dataset.confirm, "confirm"))
  );
  document.querySelectorAll("[data-override]").forEach((btn) =>
    btn.addEventListener("click", () => openOverride(btn.dataset.override))
  );
}

async function submitReview(ruleId, action, body = {}) {
  const selectedRule = currentReport?.rules?.find((rule) => rule.id === ruleId);
  const evidenceViewed = currentEvidenceId && selectedRule?.evidence?.some((item) => item.id === currentEvidenceId)
    ? [currentEvidenceId]
    : [];
  const res = await api(
    `/api/submissions/${currentSubmissionId}/rules/${ruleId}/review`,
    { method: "POST", body: JSON.stringify({ action, evidence_viewed: evidenceViewed, ...body }) }
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    alert(
      typeof detail.detail === "string"
        ? detail.detail
        : "Could not record that review."
    );
    return false;
  }
  loadReport();
  return true;
}

function openOverride(ruleId) {
  const dlg = $("override-dialog");
  dlg.dataset.rule = ruleId;
  $("override-form").reset();
  $("override-error").hidden = true;
  dlg.showModal();
}

function openDecision(decision) {
  if (decision === "request_changes") {
    // Route through the drafted, evidence-grounded message.
    openRevision();
    return;
  }
  const dlg = $("decision-dialog");
  dlg.dataset.decision = decision;
  $("decision-title").textContent = `${DECISION_LABELS[decision]} this submission`;
  $("decision-form").reset();
  $("decision-error").hidden = true;
  dlg.showModal();
}

function loadStream(url, onReady) {
  // The browser receives only an AdProof playback path.
  const player = $("player");
  if (player.dataset.src === url) {
    if (onReady) onReady();
    return;
  }
  player.dataset.src = url;
  if (window.Hls && window.Hls.isSupported()) {
    if (hls) hls.destroy();
    hls = new window.Hls();
    hls.loadSource(url);
    hls.attachMedia(player);
    if (onReady) hls.on(window.Hls.Events.MANIFEST_PARSED, onReady);
  } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = url;
    if (onReady) addPlayerListener("loadedmetadata", onReady);
  } else {
    $("player-note").textContent =
      "This browser cannot play HLS streams; evidence playback is unavailable.";
  }
}

async function fetchPlayback(evidenceId, epoch, submissionId, ruleId) {
  $("player-note").textContent = "Preparing a bounded evidence clip…";
  playbackController?.abort();
  playbackController = new AbortController();
  let res;
  try {
    res = await api(`/api/evidence/${evidenceId}/playback`, { signal: playbackController.signal });
  } catch (error) {
    if (error.name === "AbortError") return null;
    throw error;
  }
  if (epoch !== mediaEpoch || submissionId !== currentSubmissionId || ruleId !== selectedRuleId) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("player-note").textContent =
      body.detail ?? "Playback is unavailable for this evidence item.";
    return null;
  }
  return res.json();
}

async function playAt(evidenceId) {
  const submissionId = currentSubmissionId;
  const ruleId = selectedRuleId;
  const epoch = stopPlayback({ clearDetail: false, invalidateReport: false });
  const data = await fetchPlayback(evidenceId, epoch, submissionId, ruleId);
  if (!data) return;
  if (epoch !== mediaEpoch || submissionId !== currentSubmissionId || ruleId !== selectedRuleId) return;
  currentEvidenceId = evidenceId;
  document.querySelectorAll(".btn-play").forEach((button) =>
    button.classList.toggle("active", button.dataset.evidence === evidenceId)
  );
  const player = $("player");
  const fullSourceContext = data.playback_mode === "full_source_context";
  const stillCurrent = () => epoch === mediaEpoch && submissionId === currentSubmissionId && ruleId === selectedRuleId && evidenceId === currentEvidenceId;
  const start = () => {
    if (!stillCurrent()) return;
    player.currentTime = fullSourceContext ? data.detected_start_seconds : 0;
    player.play().catch(() => {});
  };
  loadStream(data.playback_url, start);
  if (player.dataset.src === data.playback_url && player.readyState >= 1) start();
  const marker = $("detection-marker");
  const renderMarker = (duration) => {
    if (!stillCurrent()) return;
    if (!Number.isFinite(duration) || duration <= 0) {
      marker.hidden = true;
      return;
    }
    const markerStartSeconds = fullSourceContext
      ? data.detected_start_seconds
      : data.marker_start_seconds;
    const markerEndSeconds = fullSourceContext
      ? data.detected_end_seconds
      : data.marker_end_seconds;
    marker.style.setProperty("--marker-start", `${(markerStartSeconds / duration) * 100}%`);
    marker.style.setProperty("--marker-width", `${Math.max(((markerEndSeconds - markerStartSeconds) / duration) * 100, 1.5)}%`);
    marker.hidden = false;
  };
  if (fullSourceContext) {
    renderMarker(player.duration);
    addPlayerListener("loadedmetadata", () => {
      if (stillCurrent()) renderMarker(player.duration);
    });
  } else {
    renderMarker(data.playback_end_seconds - data.playback_start_seconds);
  }
  $("player-note").textContent = fullSourceContext
    ? `Detected ${fmtTime(data.detected_start_seconds)}–${fmtTime(data.detected_end_seconds)} · showing full source context because duration was unavailable.`
    : `Detected ${fmtTime(data.detected_start_seconds)}–${fmtTime(data.detected_end_seconds)}${data.showing_surrounding_context ? " · showing surrounding context" : ""}.`;
}

async function loadReport() {
  if (!currentSubmissionId) return;
  // Report payloads can be large. If a reviewer selects another matrix cell
  // while an earlier request is in flight, the stale response must never
  // replace the newly selected submission or requirement.
  const requestedSubmissionId = currentSubmissionId;
  const requestedEpoch = selectionEpoch;
  reportController?.abort();
  reportController = new AbortController();
  $("report-panel")?.setAttribute("aria-busy", "true");
  const transitioning = currentReport?.submission?.id !== requestedSubmissionId;
  if (transitioning) {
    $("report-body").hidden = true;
    $("report-placeholder").hidden = false;
    $("report-placeholder").innerHTML = `<span class="skeleton-line"></span><span class="skeleton-line short"></span>`;
  }
  let res;
  try {
    res = await api(`/api/submissions/${requestedSubmissionId}/report`, { signal: reportController.signal });
  } catch (error) {
    if (error.name === "AbortError") return;
    throw error;
  }
  if (!res.ok) {
    if (currentSubmissionId === requestedSubmissionId && requestedEpoch === selectionEpoch) {
      $("report-body").hidden = true;
      $("report-placeholder").hidden = false;
      $("report-placeholder").textContent = "This saved run could not be loaded. Try again.";
      $("report-panel")?.setAttribute("aria-busy", "false");
    }
    return;
  }
  const data = await res.json();
  if (currentSubmissionId !== requestedSubmissionId || requestedEpoch !== selectionEpoch) return;
  currentReport = data;

  // Swap the placeholder for the report. `report-panel` is the always-visible
  // container; the report itself lives in `report-body`.
  $("report-placeholder").hidden = true;
  $("report-body").hidden = false;
  $("report-title").textContent = data.submission.creator_reference;
  $("report-sub").textContent = `${data.campaign.name ?? "Campaign"} · ${data.rules.length} requirements`;
  const chip = $("submission-state");
  chip.textContent = labelState(data.submission.state);
  chip.className = `state-chip state-${data.submission.state}`;

  const errBox = $("submission-error");
  if (data.submission.error_summary) {
    errBox.textContent = data.submission.error_summary;
    errBox.hidden = false;
  } else {
    errBox.hidden = true;
  }

  const hasTerminalFailure = data.stages.some(
    (s) => s.state === "failed_terminal"
  );
  $("retry-btn").hidden = !hasTerminalFailure || !data.permissions.can_retry;

  const counts = { pass: 0, fail: 0, uncertain: 0, human_review_required: 0 };
  data.rules.forEach((rule) => { const state = effectiveState(rule); if (state in counts) counts[state] += 1; });
  $("submission-summary").innerHTML = [
    ["Requirements", data.rules.length], ["Passed", counts.pass], ["Failed", counts.fail],
    ["Uncertain", counts.uncertain], ["Review required", counts.human_review_required],
  ].map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  const sourceBox = $("source-attribution");
  if (data.source_attribution) {
    const source = data.source_attribution;
    sourceBox.hidden = false;
    sourceBox.querySelector("div").innerHTML = `<dl><dt>Title</dt><dd>${esc(source.title)}</dd><dt>Author</dt><dd>${esc(source.author)}</dd><dt>Source</dt><dd><a href="${esc(source.source_page_url)}" target="_blank" rel="noopener noreferrer">${esc(source.source_page_url)}</a></dd><dt>License</dt><dd><a href="${esc(source.license_url)}" target="_blank" rel="noopener noreferrer">Licensed under ${esc(source.license_name)}</a></dd></dl><p>Independent source reviewed against this saved campaign brief. AdProof uses bounded excerpts and analytical overlays, did not commission the video, and no endorsement is implied.</p>`;
  } else {
    sourceBox.hidden = true;
  }

  $("adjudication-slot").innerHTML = renderAdjudication(data);
  renderRules(data.rules, data.permissions);
  document.querySelectorAll(".decision-btn").forEach((btn) => btn.addEventListener("click", () => openDecision(btn.dataset.decision)));
  $("report-panel")?.setAttribute("aria-busy", "false");

  clearTimeout(pollTimer);
  if (!data.processing_complete) {
    pollTimer = setTimeout(() => {
      loadSubmissions();
      loadReport();
    }, 3000);
  }
}

$("full-source-btn").addEventListener("click", async () => {
  if (!currentSubmissionId) return;
  const submissionId = currentSubmissionId;
  const ruleId = selectedRuleId;
  const epoch = stopPlayback({ clearDetail: false, invalidateReport: false });
  playbackController = new AbortController();
  let response;
  try {
    response = await api(`/api/submissions/${submissionId}/playback`, { signal: playbackController.signal });
  } catch (error) {
    if (error.name === "AbortError") return;
    if (epoch === mediaEpoch) $("player-note").textContent = "Full source playback is unavailable. Try again.";
    return;
  }
  if (epoch !== mediaEpoch || submissionId !== currentSubmissionId || ruleId !== selectedRuleId) return;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    $("player-note").textContent = body.detail ?? "Full source playback is unavailable. Try again.";
    return;
  }
  const data = await response.json();
  $("detection-marker").hidden = true;
  $("player-note").textContent = "Full source playback · evidence markers are shown only on bounded clips.";
  loadStream(data.playback_url);
});

$("retry-btn").addEventListener("click", async () => {
  await api(`/api/submissions/${currentSubmissionId}/retry`, { method: "POST" });
  loadReport();
});

/* ── views ──────────────────────────────────────────────────────────────── */

function switchView(view) {
  if (view === "analytics" && isDemoVisitor()) view = "review";
  if (view !== currentView) stopPlayback({ clearDetail: false, invalidateReport: false });
  currentView = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("view-review").hidden = view !== "review";
  $("view-campaigns").hidden = view !== "campaigns";
  $("view-analytics").hidden = view !== "analytics";
  if (view === "analytics") loadAnalytics();
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => switchView(tab.dataset.view))
);

/* ── campaigns ──────────────────────────────────────────────────────────── */

async function loadCampaigns() {
  campaigns = await (await api("/api/campaigns")).json();
  if (!campaigns.some((campaign) => campaign.id === currentCampaignId)) {
    currentCampaignId = campaigns[0]?.id || null;
  }
  $("campaigns-empty").hidden = campaigns.length > 0;
  $("campaign-picker").innerHTML = campaigns.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === currentCampaignId ? "selected" : ""}>${esc(c.name)}</option>`
  ).join("");
  const select = document.querySelector('#submission-form select[name="campaign_id"]');
  const writableCampaigns = campaigns.filter((c) => c.can_submit);
  select.innerHTML = writableCampaigns
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  // Demo calls to action stay enabled. Selecting one explains the value and
  // opens login in context instead of presenting a disabled dead end.
  $("new-submission").disabled = false;
  $("new-campaign").disabled = false;
  if (currentCampaignId) await loadCampaignDashboard(currentCampaignId);
}

function matrixStatus(state, reviewed = false) {
  const icon = state === "pass" ? "✓" : state === "fail" ? "!" : state === "processing" ? "…" : "?";
  return `<span class="matrix-status result-${esc(state)}"><span aria-hidden="true">${icon}</span>${esc(STATE_LABEL[state] || state)}${reviewed ? " · reviewed" : ""}</span>`;
}

function renderDecisionStatus(decision) {
  if (!decision) return `<span class="matrix-status">Not decided</span>`;
  return `<span class="matrix-status decision-${esc(decision)}"><span aria-hidden="true">${decision === "approve" ? "✓" : decision === "reject" ? "!" : "↗"}</span>${esc(FINAL_DECISION_LABELS[decision] || labelState(decision))}</span>`;
}

async function loadCampaignDashboard(campaignId) {
  campaignController?.abort();
  campaignController = new AbortController();
  const epoch = ++campaignEpoch;
  const requestedId = campaignId;
  $("campaign-dashboard").setAttribute("aria-busy", "true");
  $("campaign-dashboard").innerHTML = `<p class="empty placeholder"><span class="skeleton-line"></span><span class="skeleton-line short"></span></p>`;
  let response;
  try {
    response = await api(`/api/campaigns/${campaignId}/dashboard`, { signal: campaignController.signal });
  } catch (error) {
    if (error.name === "AbortError") return;
    if (epoch === campaignEpoch) {
      $("campaign-dashboard").innerHTML = `<p class="empty">Campaign could not be loaded. Try again.</p>`;
      $("campaign-dashboard").setAttribute("aria-busy", "false");
    }
    return;
  }
  if (!response.ok) {
    if (epoch === campaignEpoch) {
      $("campaign-dashboard").innerHTML = `<p class="empty">Campaign could not be loaded. Try again.</p>`;
      $("campaign-dashboard").setAttribute("aria-busy", "false");
    }
    return;
  }
  const data = await response.json();
  if (requestedId !== currentCampaignId || epoch !== campaignEpoch) return;
  const requirements = data.requirements;
  const rows = data.submissions;
  const cells = rows.flatMap((row) => row.cells);
  const readyCount = cells.filter((cell) => cell.effective_state === "pass").length;
  const issueCount = cells.filter((cell) => cell.effective_state === "fail").length;
  const reviewCount = cells.filter((cell) => ["uncertain", "human_review_required"].includes(cell.effective_state)).length;
  $("campaign-dashboard").innerHTML = `
    <header class="dashboard-head">
      <div><span class="eyebrow">Saved campaign</span><h2>${esc(data.campaign.name)}</h2><p>${esc(data.campaign.brief || "No brief recorded.")}</p></div>
      <button id="dashboard-new-submission" class="btn btn-primary" type="button">Add creator submission</button>
    </header>
    <div class="dashboard-stats campaign-summary-stats">
      <div><strong>${data.summary.submission_count}</strong><span>Creator submission${data.summary.submission_count === 1 ? "" : "s"}</span></div>
      <div><strong>${requirements.length}</strong><span>Confirmed requirements</span></div>
      <div><strong>${readyCount}</strong><span>Passed checks</span></div>
      <div><strong>${issueCount}</strong><span>Failed checks</span></div>
      <div><strong>${reviewCount}</strong><span>Review needed</span></div>
    </div>
    <details class="campaign-requirements"><summary>Campaign requirements (${requirements.length})</summary><ol>${requirements.map((rule) => `<li><strong>R${rule.ordinal + 1}</strong> ${esc(rule.requirement_text)}</li>`).join("")}</ol></details>
    <section class="matrix-section"><div class="section-heading"><div><span class="eyebrow">Review operations</span><h3>Creator × requirement matrix</h3></div><span class="muted-inline">Select any result to open its evidence</span></div>
      ${rows.length ? `<div class="matrix-scroll"><table class="review-matrix"><thead><tr><th scope="col">Creator / submission</th>${requirements.map((rule) => `<th scope="col"><span>R${rule.ordinal + 1}</span>${esc(rule.requirement_text)}</th>`).join("")}<th scope="col">Decision</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row"><button type="button" data-submission="${esc(row.submission_id)}"><strong>${esc(row.creator_reference)}</strong><span>${esc(labelState(row.state))} · ${row.unresolved_count} unresolved</span></button></th>${row.cells.map((cell, index) => `<td><button type="button" class="matrix-cell" aria-label="${esc(row.creator_reference)} — requirement ${index + 1}: ${esc(requirements[index]?.requirement_text)} — ${esc(labelState(cell.effective_state))}" data-submission="${esc(row.submission_id)}" data-rule="${esc(cell.rule_id)}">${matrixStatus(cell.effective_state, cell.reviewed)}</button></td>`).join("")}<td>${renderDecisionStatus(row.final_decision)}</td></tr>`).join("")}</tbody></table></div><div class="matrix-cards">${rows.map((row) => `<article><h4>${esc(row.creator_reference)}</h4><div class="mobile-decision"><span>Final decision</span>${renderDecisionStatus(row.final_decision)}</div>${row.cells.map((cell, index) => `<button type="button" data-submission="${esc(row.submission_id)}" data-rule="${esc(cell.rule_id)}" aria-label="${esc(row.creator_reference)} — requirement ${index + 1}: ${esc(requirements[index]?.requirement_text)} — ${esc(labelState(cell.effective_state))}"><span>R${index + 1}</span>${matrixStatus(cell.effective_state, cell.reviewed)}</button>`).join("")}</article>`).join("")}</div>` : `<p class="empty">No creator submissions yet.</p>`}
    </section>
    ${data.campaign.is_showcase ? `<p class="source-disclosure">Independent sources reviewed against saved campaign briefs. AdProof did not commission the videos; no endorsement is implied.</p>` : ""}`;
  $("campaign-dashboard").setAttribute("aria-busy", "false");
  $("dashboard-new-submission").addEventListener("click", openNewSubmission);
  $("campaign-dashboard").querySelectorAll("[data-submission]").forEach((button) => button.addEventListener("click", () => selectSubmission(button.dataset.submission, button.dataset.rule || null)));
}

$("campaign-picker").addEventListener("change", (event) => {
  currentCampaignId = event.target.value;
  loadCampaignDashboard(currentCampaignId);
});

$("requirement-picker").addEventListener("change", (event) => {
  stopPlayback({ invalidateReport: false });
  selectedRuleId = event.target.value;
  renderRules(currentReport.rules, currentReport.permissions);
});

function openNewSubmission() {
  if (isDemoVisitor()) {
    openLogin(
      "Log in to add a submission. Your private workspace will open here without leaving saved runs.",
      "submission"
    );
    return;
  }
  if (!campaigns.some((c) => c.can_submit)) {
    continueToSubmission = true;
    openNewCampaign();
    return;
  }
  $("submission-dialog").showModal();
}

$("new-submission").addEventListener("click", openNewSubmission);
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

$("add-rule").addEventListener("click", addRuleRow);

function openNewCampaign() {
  if (isDemoVisitor()) {
    openLogin(
      "Log in to create a campaign and save its requirements in your private workspace.",
      "campaign"
    );
    return;
  }
  $("rule-rows").innerHTML = "";
  addRuleRow();
  $("campaign-error").hidden = true;
  $("campaign-dialog").showModal();
}

$("new-campaign").addEventListener("click", openNewCampaign);

$("campaign-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const res = await api("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      workspace_id: currentWorkspaces.find((w) => w.can_manage_campaigns)?.id,
      campaign_name: f.get("campaign_name"),
      brief_text: f.get("brief_text"),
      rules: collectRules(),
    }),
  });
  const err = $("campaign-error");
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    err.textContent =
      typeof d.detail === "string"
        ? d.detail
        : (d.detail?.[0]?.msg ?? "Could not create the campaign.");
    err.hidden = false;
    return;
  }
  err.hidden = true;
  $("campaign-dialog").close();
  e.target.reset();
  await loadCampaigns();
  if (continueToSubmission) {
    continueToSubmission = false;
    openNewSubmission();
  }
});

$("submission-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const file = f.get("file");
  const url = f.get("source_url");
  const err0 = $("submission-form-error");
  const directUpload = Boolean(integrityData?.input_capabilities?.direct_file_upload);
  if ((!directUpload || !file || !file.size) && !url) {
    err0.textContent = directUpload
      ? "Choose a video file or provide a URL."
      : "Provide a durable, publicly fetchable video URL.";
    err0.hidden = false;
    return;
  }
  const idem = `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let res;
  if (directUpload && file && file.size) {
    // Multipart upload. fetch directly: api() sets a JSON content-type, and
    // multipart needs the browser to set its own boundary header.
    const form = new FormData();
    form.append("campaign_id", f.get("campaign_id"));
    form.append("creator_reference", f.get("creator_reference"));
    form.append("idempotency_key", idem);
    form.append("file", file);
    res = await fetch("/api/submissions/upload", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (res.status === 401) {
      openLogin("Your session expired. Log in again to add this submission.", "submission");
      return;
    }
  } else {
    res = await api("/api/submissions", {
      method: "POST",
      body: JSON.stringify({
        campaign_id: f.get("campaign_id"),
        creator_reference: f.get("creator_reference"),
        source_url: url,
        idempotency_key: idem,
      }),
    });
  }
  const err = $("submission-form-error");
  if (!res.ok) {
    err.textContent = (await res.json()).detail ?? "Could not create the submission.";
    err.hidden = false;
    return;
  }
  err.hidden = true;
  $("submission-dialog").close();
  e.target.reset();
  loadSubmissions();
});

$("override-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const ok = await submitReview($("override-dialog").dataset.rule, "override", {
    human_state: f.get("human_state"),
    reason_category: f.get("reason_category"),
    reason_text: f.get("reason_text"),
  });
  if (ok) $("override-dialog").close();
});

$("decision-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const res = await api(`/api/submissions/${currentSubmissionId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      decision: $("decision-dialog").dataset.decision,
      rationale: f.get("rationale"),
    }),
  });
  const err = $("decision-error");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    err.textContent =
      typeof detail.detail === "string" ? detail.detail : "Could not record that decision.";
    err.hidden = false;
    return;
  }
  $("decision-dialog").close();
  loadReport();
  loadSubmissions();
});


/* ── rule editor ────────────────────────────────────────────────────────── */

const RULE_TYPES = [
  { v: "required_spoken_phrase",  label: "Must say a phrase",            fields: ["phrase","min_occurrences"] },
  { v: "forbidden_spoken_claim",  label: "Must NOT say (prohibited claims)", fields: ["forbidden_phrases"] },
  { v: "min_visual_duration",     label: "Must be visible for at least", fields: ["visual_concept","min_duration_seconds","score_threshold"] },
  { v: "max_visual_duration",     label: "Must appear no longer than",   fields: ["visual_concept","max_duration_seconds","score_threshold"] },
  { v: "required_visual_event",   label: "Must happen on screen",        fields: ["visual_concept","window_start_seconds","window_end_seconds"] },
  { v: "forbidden_visual_event",  label: "Must NOT appear on screen",    fields: ["visual_concept","score_threshold"] },
  { v: "disclosure_present",      label: "Advertising disclosure",       fields: ["modality_requirement","window_start_seconds","window_end_seconds"] },
  { v: "sequence",                label: "One thing before another",     fields: ["sequence_first","sequence_second","sequence_max_gap_seconds"] },
  { v: "subjective_human_review", label: "Human judgement only",         fields: ["reviewer_guidance"] },
];

const FIELD_DEFS = {
  phrase:                   { label: "Exact phrase", type: "text", ph: "AYUSH20" },
  min_occurrences:          { label: "Minimum times", type: "number", value: 1, min: 1 },
  forbidden_phrases:        { label: "Prohibited phrases (one per line)", type: "textarea", ph: "guaranteed weight loss\ncures fatigue" },
  visual_concept:           { label: "What must be seen", type: "text", ph: "PulseBar pack" },
  min_duration_seconds:     { label: "Minimum seconds", type: "number", value: 6, min: 0.5, step: 0.5 },
  max_duration_seconds:     { label: "Maximum seconds", type: "number", value: 2, min: 0.5, step: 0.5 },
  score_threshold:          { label: "Relevance cutoff (affects the measurement)", type: "number", value: 0.3, min: 0, max: 1, step: 0.05 },
  window_start_seconds:     { label: "Window starts at (s, optional)", type: "number", min: 0 },
  window_end_seconds:       { label: "Window ends at (s, optional)", type: "number", min: 0 },
  modality_requirement:     { label: "How it may be satisfied", type: "select",
                              options: [["either","Spoken or on screen"],["both","Both spoken and on screen"],
                                        ["spoken_only","Spoken only"],["visual_only","On screen only"]] },
  sequence_first:           { label: "This must come first", type: "text", ph: "demonstrating the product" },
  sequence_second:          { label: "Then this", type: "text", ph: "call to action" },
  sequence_max_gap_seconds: { label: "Largest gap allowed (s, optional)", type: "number", min: 1 },
  reviewer_guidance:        { label: "Guidance for the reviewer", type: "textarea", ph: "What should they look for?" },
};

let ruleSeq = 0;

function fieldHtml(name) {
  const f = FIELD_DEFS[name];
  const id = `f-${name}-${ruleSeq}`;
  if (f.type === "select") {
    return `<label>${esc(f.label)}<select data-field="${name}">${f.options
      .map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select></label>`;
  }
  if (f.type === "textarea") {
    return `<label>${esc(f.label)}<textarea data-field="${name}" rows="3" placeholder="${esc(f.ph || "")}"></textarea></label>`;
  }
  const attrs = ["min","max","step"].filter(a => f[a] !== undefined)
    .map(a => `${a}="${f[a]}"`).join(" ");
  return `<label>${esc(f.label)}<input data-field="${name}" type="${f.type}" ${attrs}
    ${f.value !== undefined ? `value="${f.value}"` : ""} placeholder="${esc(f.ph || "")}" /></label>`;
}

function renderRuleFields(row) {
  const type = row.querySelector("[data-field=rule_type]").value;
  const def = RULE_TYPES.find(r => r.v === type);
  row.querySelector(".rule-fields").innerHTML = def.fields.map(fieldHtml).join("");
  // Subjective rules never carry an absence policy: nothing is searched.
  row.querySelector(".policy-wrap").hidden = type === "subjective_human_review";
}

function addRuleRow() {
  ruleSeq += 1;
  const row = document.createElement("div");
  row.className = "rule-row";
  row.innerHTML = `
    <div class="rule-row-head">
      <select data-field="rule_type">${RULE_TYPES
        .map(r => `<option value="${r.v}">${esc(r.label)}</option>`).join("")}</select>
      <button type="button" class="btn btn-small remove-rule" aria-label="Remove requirement">Remove</button>
    </div>
    <label>Requirement, as a reviewer will read it
      <input data-field="requirement_text" required placeholder="Creator must state the code AYUSH20" /></label>
    <div class="rule-fields"></div>
    <div class="rule-row-foot">
      <label>Severity
        <select data-field="severity">
          <option value="required" selected>Required (asks for changes)</option>
          <option value="blocking">Blocking (recommends rejection)</option>
          <option value="optional">Optional (does not block)</option>
        </select></label>
      <label class="policy-wrap">If nothing is found
        <select data-field="absence_policy">
          <option value="uncertain" selected>Mark uncertain</option>
          <option value="require_human_review">Require human review</option>
          <option value="fail_when_coverage_complete">Fail (exact matches only)</option>
        </select></label>
    </div>`;
  row.querySelector("[data-field=rule_type]").addEventListener("change", () => renderRuleFields(row));
  row.querySelector(".remove-rule").addEventListener("click", () => {
    if (document.querySelectorAll(".rule-row").length > 1) row.remove();
  });
  $("rule-rows").appendChild(row);
  renderRuleFields(row);
}

function collectRules() {
  return [...document.querySelectorAll(".rule-row")].map((row) => {
    const rule = {};
    row.querySelectorAll("[data-field]").forEach((el) => {
      const name = el.dataset.field;
      let v = el.value;
      if (v === "" || v === null) return;
      if (name === "forbidden_phrases") {
        v = v.split("\n").map(x => x.trim()).filter(Boolean);
        if (!v.length) return;
      } else if (el.type === "number") {
        v = Number(v);
      }
      rule[name] = v;
    });
    return rule;
  });
}


/* ── analytics ──────────────────────────────────────────────────────────── */

const pct = (v) => (v === null || v === undefined ? "not available" : `${Math.round(v * 100)}%`);

async function loadAnalytics() {
  const sel = $("analytics-campaign");
  sel.innerHTML = campaigns
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  if (!campaigns.length) {
    $("analytics-body").innerHTML =
      `<p class="empty">No campaigns yet. Analytics appear once submissions have been processed.</p>`;
    return;
  }
  renderAnalytics(sel.value || campaigns[0].id);
}

async function renderAnalytics(campaignId) {
  const res = await api(`/api/campaigns/${campaignId}/analytics`);
  if (!res.ok) return;
  const a = await res.json();
  const t = a.totals;

  const stat = (label, value, note) => `
    <div class="stat">
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}
    </div>`;

  const patterns = a.failure_patterns.length
    ? a.failure_patterns.map((p) => `
        <li>
          <div class="pattern-head">
            <span>${esc(p.requirement_text)}</span>
            <span class="muted-inline">${p.machine_failures.count} machine failure(s)</span>
          </div>
          ${
            p.overridden_away.count
              ? `<div class="pattern-warn">Reviewers overturned ${p.overridden_away.count} of these.
                 ${Object.entries(p.override_reasons).map(([r, n]) => `${esc(r)} x${n}`).join(", ")}.
                 A cluster here usually means the requirement needs review, not that every creator is wrong.</div>`
              : ""
          }
          <div class="analytics-links">${p.machine_failures.submission_ids
            .map((id) => `<button type="button" class="btn btn-small" data-open-submission="${esc(id)}" data-open-rule="${esc(p.rule_id)}">Open submission</button>`).join(" ") || ""}</div>
        </li>`).join("")
    : `<li class="empty">No failures recorded yet.</li>`;

  const trends = a.creator_trends.filter((c) => Object.keys(c.repeated_failures).length);
  $("analytics-body").innerHTML = `
    <div class="stat-row">
      ${stat("Submissions", t.submissions)}
      ${stat("Included", t.included.count, `${t.excluded_incomplete.count} excluded as incomplete`)}
      ${stat("Machine pass rate", pct(a.machine_pass_rate), "every requirement passed automatically")}
      ${stat("Final approval rate", pct(a.final_approval_rate), "of submissions that were decided")}
      ${stat("Override rate", pct(a.override_rate), "reviewed rules where a human disagreed")}
      ${stat("Unresolved", t.unresolved.count)}
    </div>
    <p class="note">
      Machine and human outcomes are reported separately on purpose. A gap
      between them is the signal, not an inconsistency.
    </p>

    <h3>Where submissions fail</h3>
    <ul class="pattern-list">${patterns}</ul>

    <h3>Creators with repeated failures</h3>
    ${
      trends.length
        ? `<ul class="pattern-list">${trends.map((c) => `
            <li><div class="pattern-head"><span>${esc(c.creator_reference)}</span>
              <span class="muted-inline">${c.submissions.count} submission(s)</span></div>
              <div class="muted-inline">${Object.entries(c.repeated_failures)
                .map(([r, n]) => `${esc(r)} failed ${n}x`).join(" · ")}</div></li>`).join("")}</ul>`
        : `<p class="empty">No creator has failed the same requirement twice yet.</p>`
    }

    ${
      Object.keys(a.unavailable).length
        ? `<h3>Not measurable yet</h3><ul class="unavailable-list">${Object.entries(a.unavailable)
            .map(([k, v]) => `<li><strong>${esc(k)}</strong>: ${esc(v)}</li>`).join("")}</ul>`
        : ""
    }`;
  $("analytics-body").querySelectorAll("[data-open-submission]").forEach((button) => button.addEventListener("click", () => selectSubmission(button.dataset.openSubmission, button.dataset.openRule)));
}

$("analytics-campaign").addEventListener("change", (e) => renderAnalytics(e.target.value));

/* ── request changes ────────────────────────────────────────────────────── */

async function openRevision() {
  const res = await api(`/api/submissions/${currentSubmissionId}/revision-draft`);
  if (!res.ok) {
    alert("Could not draft revision instructions.");
    return;
  }
  const d = await res.json();
  $("revision-form").querySelector("[name=message]").value = d.message;
  $("revision-excluded").innerHTML = d.excluded.length
    ? `<p class="note"><strong>Left out of the draft:</strong> ${d.excluded
        .map((x) => esc(x.reason)).join(" ")}</p>`
    : "";
  $("revision-error").hidden = true;
  $("revision-dialog").showModal();
}

$("revision-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = new FormData(e.target).get("message");
  const res = await api(`/api/submissions/${currentSubmissionId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision: "request_changes", rationale: message }),
  });
  const err = $("revision-error");
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    err.textContent = typeof d.detail === "string" ? d.detail : "Could not record that.";
    err.hidden = false;
    return;
  }
  $("revision-dialog").close();
  loadReport();
  loadSubmissions();
});

/* ── auth ───────────────────────────────────────────────────────────────── */

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: $("login-email").value,
      password: $("login-password").value,
    }),
  });
  if (!res.ok) {
    const err = $("login-error");
    err.textContent = "Email or password is incorrect.";
    err.hidden = false;
    return;
  }
  const intent = pendingAuthIntent;
  pendingAuthIntent = null;
  $("login-password").value = "";
  $("login-dialog").close();
  await boot();
  if (intent === "campaign") openNewCampaign();
  if (intent === "submission") openNewSubmission();
});

$("login-cancel").addEventListener("click", () => {
  stopPlayback({ clearDetail: false, invalidateReport: false });
  pendingAuthIntent = null;
  $("login-dialog").close();
});
$("login-dialog").addEventListener("close", () => {
  stopPlayback({ clearDetail: false, invalidateReport: false });
  pendingAuthIntent = null;
});

$("auth-action").addEventListener("click", async () => {
  if (isDemoVisitor()) {
    openLogin("Log in to access your private campaigns, submissions, and review history.");
    return;
  }
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  currentUser = null;
  currentWorkspaces = [];
  campaigns = [];
  await boot();
});

async function boot() {
  clearReportView("Loading saved verification runs…");
  switchView("review");
  submissionListController?.abort();
  submissionListEpoch += 1;
  let me;
  try {
    let res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) {
      if (await establishDemoSession()) {
        res = await fetch("/api/auth/me", { credentials: "same-origin" });
      }
    }
    if (!res.ok) {
      showApp();
      openLogin("Saved runs are temporarily unavailable. Log in to access your workspace.");
      return;
    }
    me = await res.json();
  } catch {
    showApp();
    openLogin("Saved runs are temporarily unavailable. Log in to access your workspace.");
    return;
  }
  if (location.search) history.replaceState({}, "", "/app");
  currentUser = me.user;
  currentWorkspaces = me.workspaces;
  if (isDemoVisitor()) {
    $("who").textContent = "Viewing saved runs";
    $("auth-action").textContent = "Log in";
    $("analytics-tab").hidden = true;
    if (currentView === "analytics") currentView = "review";
  } else {
    $("who").textContent = me.user.name || me.user.email;
    $("auth-action").textContent = "Sign out";
    $("analytics-tab").hidden = false;
  }
  showApp();
  await Promise.all([loadIntegrity(), loadCampaigns(), loadSubmissions()]);
  switchView("review");
}

boot();
setInterval(() => {
  if (currentUser) loadSubmissions();
}, 10000);
