/* AdProof review UI.
 *
 * Rendering rules enforced here:
 *   - never render a stage as complete unless its job reached a terminal state;
 *   - never render "no evidence found" for a search that did not run;
 *   - always show absence class alongside a non-pass result;
 *   - always show provenance with every evidence item;
 *   - never receive or display a provider URL: playback goes through the
 *     authorized proxy.
 */

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

/* AdProof review UI - Phase 1 slice.
 *
 * Rendering rules enforced here:
 *   - never render a stage as complete unless its job reached a terminal state;
 *   - never render "no evidence found" for a search that did not run;
 *   - always show absence class alongside a non-pass result;
 *   - always show provenance with every evidence item.
 */

const STATE_LABEL = {
  pass: "Pass",
  fail: "Fail",
  uncertain: "Uncertain",
  not_evaluated: "Not evaluated",
  human_review_required: "Human review required",
  processing: "Still processing",
  error: "Error",
};

const ABSENCE_LABEL = {
  not_applicable: "",
  likely_absent: "No match in the completed index (likely absent, not proven)",
  low_confidence_absence: "No match found (low-confidence absence)",
  index_incomplete: "Index did not complete",
  query_insufficient: "Query returned nothing usable",
  unsupported_modality: "Modality not supported",
  media_quality_issue: "Media quality prevented retrieval",
  provider_failure: "Retrieval failed at the provider — nothing was searched",
};

const JOB_STATE_LABEL = {
  queued: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed_retryable: "Failed — will retry",
  failed_terminal: "Failed — needs attention",
};

const STAGE_LABEL = {
  ingest: "Upload & ingestion",
  index_spoken: "Spoken-word indexing",
  index_visual: "Visual indexing",
  retrieval: "Evidence retrieval",
  evaluation: "Deterministic evaluation",
};

let currentSubmissionId = null;
let currentCampaignId = null;
let selectedRuleId = null;
let currentReport = null;
let currentEvidenceId = null;
let hls = null;
let pollTimer = null;

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

async function loadIntegrity() {
  const badge = $("integrity-badge");
  let data;
  try {
    const response = await api("/api/integrity");
    if (!response.ok) throw new Error(`integrity endpoint returned ${response.status}`);
    data = await response.json();
    integrityData = data;
  } catch (err) {
    if (badge) {
      badge.textContent = "Integrity status unavailable";
      badge.className = "badge badge-error";
    }
    return;
  }

  // Provider integrity is the high-value status. A missing disclosure node or
  // an unexpected optional field must never overwrite a successful live check.
  if (badge && data.provider_configured) {
    badge.textContent = "Live provider — no fixture data";
    badge.className = "badge badge-live";
  } else if (badge) {
    badge.textContent = "VideoDB not configured — processing will fail";
    badge.className = "badge badge-error";
  }

  try {
    const list = $("disclosure-list");
    const limitations = Array.isArray(data.known_limitations)
      ? data.known_limitations
      : [];
    list.innerHTML = limitations
      .map((l) => `<li>${esc(l)}</li>`)
      .join("");
    if (data.confidence_disclosure) {
      list.insertAdjacentHTML(
        "beforeend",
        `<li>${esc(data.confidence_disclosure)}</li>`
      );
    }
    $("disclosure").hidden = false;

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
        ? "Submit a local video or a durable public URL. Processing time and cost scale with video length."
        : data.input_capabilities?.production_guidance;
    }
  } catch (err) {
    console.warn("Integrity disclosure could not be rendered", err);
  }
}

async function loadSubmissions() {
  const list = $("submission-list");
  const subs = await (await api("/api/submissions")).json();
  if (!subs.length) {
    currentSubmissionId = null;
    $("report-body").hidden = true;
    $("report-placeholder").hidden = false;
    const player = $("player");
    player.pause();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    player.removeAttribute("src");
    player.dataset.src = "";
    player.load();
  }
  const selectedStillExists = subs.some((s) => s.id === currentSubmissionId);
  const shouldOpenFirst = subs.length > 0 && !selectedStillExists && !currentSubmissionId;
  if (shouldOpenFirst) currentSubmissionId = subs[0].id;
  $("submissions-empty").hidden = subs.length > 0;
  list.innerHTML = subs
    .map(
      (s) => `
      <li>
        <button class="submission-btn ${s.id === currentSubmissionId ? "active" : ""}"
                data-id="${esc(s.id)}">
          <span class="creator">${esc(s.creator_reference)}</span>
          <span class="campaign">${esc(s.campaign_name ?? "")}</span>
          <span class="submission-meta">
            <span class="tag ${s.is_showcase ? "tag-showcase" : "tag-sandbox"}">${esc(
              s.is_showcase ? "showcase" : s.workspace_name ?? "your sandbox"
            )}</span>
            <span class="state-chip state-${esc(s.state)}">${esc(s.state)}</span>
          </span>
        </button>
      </li>`
    )
    .join("");
  list.querySelectorAll(".submission-btn").forEach((btn) =>
    btn.addEventListener("click", () => selectSubmission(btn.dataset.id))
  );
  if (shouldOpenFirst) loadReport();
}

function selectSubmission(id, ruleId = null, autoplayEvidenceId = null) {
  currentSubmissionId = id;
  selectedRuleId = ruleId;
  loadSubmissions();
  loadReport(autoplayEvidenceId);
  switchView("review");
}

function renderStages(stages) {
  $("stages").innerHTML = stages
    .map((s) => {
      const elapsed =
        s.elapsed_seconds !== null && s.elapsed_seconds !== undefined
          ? ` · ${s.elapsed_seconds.toFixed(1)}s`
          : "";
      const attempts =
        s.attempt_count > 1 ? ` · attempt ${s.attempt_count}/${s.max_attempts}` : "";
      const err = s.error_summary
        ? `<div class="stage-error">${esc(s.error_summary)}</div>`
        : "";
      return `
        <li class="stage stage-${esc(s.state)}">
          <span class="stage-name">${esc(STAGE_LABEL[s.stage] ?? s.stage)}</span>
          <span class="stage-state">${esc(
            JOB_STATE_LABEL[s.state] ?? s.state
          )}${elapsed}${attempts}</span>
          ${err}
        </li>`;
    })
    .join("");
}

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
        ev.text ? `<span>${esc(ev.text)}</span>` : ""
      }</span>
      <span aria-hidden="true" class="evidence-arrow">→</span>
    </button>`;
}


// Who concluded this rule. When the reading model and the deterministic
// measurement disagree, both answers are shown -- the reviewer sees the
// conflict rather than a single number that hides it.
function renderVerdict(res) {
  if (!res || res.decided_by !== "verdict_model") return "";
  const disagrees =
    res.deterministic_state && res.deterministic_state !== res.state;
  return `
    <div class="verdict${disagrees ? " verdict-split" : ""}">
      <p class="verdict-head">
        <span class="source-tag">read by ${esc(res.verdict_model || "model")}</span>
        ${
          disagrees
            ? `<span class="verdict-warn">disagrees with the measurement, which said “${esc(
                res.deterministic_state
              )}”</span>`
            : `<span class="verdict-ok">agrees with the measurement</span>`
        }
      </p>
      ${
        res.verdict_reasoning
          ? `<p class="verdict-why">${esc(res.verdict_reasoning)}</p>`
          : ""
      }
    </div>`;
}

function renderRuns(runs) {
  return runs
    .map((r) => {
      let outcome;
      if (!r.executed && r.error_summary) {
        outcome = `<span class="run-notrun">did not run — ${esc(
          r.error_summary
        )}</span>`;
      } else if (r.result_count === 0) {
        outcome = `<span class="run-empty">ran, returned 0 results</span>`;
      } else if (r.result_truncated) {
        outcome = `<span class="run-truncated">ran, returned ${r.result_count}
          result(s) — HIT THE RETRIEVAL LIMIT of ${r.result_threshold},
          so more evidence may exist and the measurement understates</span>`;
      } else {
        outcome = `<span class="run-ok">ran, returned ${r.result_count} result(s)</span>`;
      }
      return `
        <li>
          <code>${esc(r.query)}</code>
          <span class="run-meta">${esc(r.search_type)} / ${esc(
            r.index_type
          )} · ${esc(r.role)} · ${
            r.counts_toward_measurement ? "counted" : "context only"
          }</span>
          ${outcome}
        </li>`;
    })
    .join("");
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

function renderAdjudication(report) {
  const adj = report.adjudication;
  const permitted = new Set(adj.permitted_decisions);
  const rec = adj.machine_recommendation;
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
    ? `<div class="read-only-note">This is a stable showcase record. Decisions are visible, but editing is disabled.</div>`
    : `<div class="decision-actions">${buttons}</div>`;

  const history = report.decisions.length
    ? `<ul class="decision-history">${report.decisions
        .map(
          (d) => `<li>
            <strong>${esc(DECISION_LABELS[d.decision] ?? d.decision)}</strong>
            by ${esc(d.decided_by)}
            <span class="muted-inline">· machine suggested ${esc(
              d.machine_recommendation ?? "nothing"
            )} · ${d.agreed_with_machine ? "agreed" : "disagreed"}</span>
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
      <p class="note">
        A person owns the final decision. The automated recommendation is
        recorded for audit (${esc(rec ?? "none")}) but is not presented as the answer.
      </p>
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
  $("rules").innerHTML = rules.map((rule) => {
    const latest = (rule.reviews || []).at(-1);
    const state = latest?.human_state || rule.result?.state || "processing";
    return `<button type="button" class="requirement-item ${rule.id === selectedRuleId ? "active" : ""}"
      data-rule-select="${esc(rule.id)}" aria-current="${rule.id === selectedRuleId ? "true" : "false"}">
      <span class="result-dot result-${esc(state)}" aria-hidden="true"></span>
      <span><strong>${esc(rule.requirement_text)}</strong><small>${esc(STATE_LABEL[state] || state)}${latest ? " · reviewed" : ""}</small></span>
    </button>`;
  }).join("");

  const rule = rules.find((item) => item.id === selectedRuleId);
  const res = rule.result;
  const latest = (rule.reviews || []).at(-1);
  const effective = latest?.human_state || res?.state || "processing";
  const measurement = res && res.measured_value !== null && res.measured_value !== undefined
    ? `<div class="proof-card"><span>Measured proof</span><strong>${esc(res.measured_value)} ${esc(res.measured_unit || "")}</strong><p>Required threshold: ${esc(res.threshold_value)} ${esc(res.measured_unit || "")}${res.measurement_resolution_seconds ? ` · ±${esc(res.measurement_resolution_seconds)}s sampling resolution` : ""}</p></div>`
    : `<div class="proof-card"><span>Measured proof</span><strong>No numeric threshold</strong><p>This check is resolved from observed evidence and its configured policy.</p></div>`;
  const noHit = rule.no_hit_receipt
    ? `<div class="no-hit"><strong>${esc({
        coverage_incomplete: "Coverage incomplete",
        no_qualifying_match: "Retrieved context did not qualify",
        missing_required_part: "A required part is missing",
        not_found: "No matching moment found",
      }[rule.no_hit_receipt.state] || "Evidence receipt")}</strong><p>${esc(rule.no_hit_receipt.meaning)}</p><small>${rule.no_hit_receipt.searches_completed} of ${rule.no_hit_receipt.searches_expected} required searches completed.</small></div>`
    : "";
  const reviewControls = res && permissions.can_review
    ? `<div class="review-actions"><button class="btn btn-small" data-confirm="${esc(rule.id)}">Confirm finding</button><button class="btn btn-small" data-override="${esc(rule.id)}">Record exception</button></div>`
    : "";
  const humanBlock = latest
    ? `<div class="human-verdict"><span class="eyebrow">Human position</span><strong>${esc(STATE_LABEL[latest.human_state] || latest.human_state)}</strong><p>${latest.reason_text ? esc(latest.reason_text) : "Reviewer confirmed the recorded finding."}</p></div>`
    : "";
  $("requirement-detail").innerHTML = `
    <span class="eyebrow">Requirement ${rule.ordinal + 1}</span>
    <div class="requirement-result"><span class="result-chip result-${esc(effective)}">${esc(STATE_LABEL[effective] || effective)}</span><h2>${esc(rule.requirement_text)}</h2></div>
    ${measurement}
    ${res ? `<div class="why-card"><span>Why this result</span><p>${esc(res.explanation)}</p></div>` : `<p class="empty">Evaluation has not completed.</p>`}
    ${res?.absence_class && res.absence_class !== "not_applicable" ? `<p class="absence">${esc(ABSENCE_LABEL[res.absence_class])}</p>` : ""}
    ${noHit}${humanBlock}${reviewControls}
    <details class="secondary-disclosure"><summary>How this check was evaluated</summary><p class="note">${esc(rule.source_brief_excerpt || "Confirmed requirement")}</p><ul class="run-list">${renderRuns(rule.retrieval_runs)}</ul></details>`;

  const proof = rule.evidence.filter((item) => item.evidence_kind === "proof");
  const issues = rule.evidence.filter((item) => item.evidence_kind === "issue");
  const context = rule.evidence.filter((item) => item.evidence_kind === "context");
  const evidenceGroup = (title, items) => items.length ? `
    <section class="evidence-group"><h4>${title}</h4>${items.slice(0, 4).map(renderEvidence).join("")}
    ${items.length > 4 ? `<details><summary>${items.length - 4} additional moment(s)</summary>${items.slice(4).map(renderEvidence).join("")}</details>` : ""}</section>` : "";
  $("evidence-title").textContent = rule.requirement_text;
  $("evidence-list").innerHTML = evidenceGroup("Measured moments", proof) + evidenceGroup("Potential issues", issues) + evidenceGroup("Context that may change the reading", context) + (!rule.evidence.length ? noHit : "");

  document.querySelectorAll("[data-rule-select]").forEach((btn) => btn.addEventListener("click", () => {
    selectedRuleId = btn.dataset.ruleSelect;
    currentEvidenceId = null;
    renderRules(rules, permissions);
    const first = rules.find((item) => item.id === selectedRuleId)?.evidence.find((item) => item.evidence_kind !== "context");
    if (first) playAt(first.id);
  }));
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
  // url points at AdProof's own proxy, never at the provider.
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
    if (onReady) player.addEventListener("loadedmetadata", onReady, { once: true });
  } else {
    $("player-note").textContent =
      "This browser cannot play HLS streams; evidence playback is unavailable.";
  }
}

async function fetchPlayback(evidenceId) {
  $("player-note").textContent = "Preparing a bounded evidence clip…";
  const res = await api(`/api/evidence/${evidenceId}/playback`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("player-note").textContent =
      body.detail ?? "Playback is unavailable for this evidence item.";
    return null;
  }
  return res.json();
}

// Attach the stream as soon as the report opens, so the native play button
// works without first clicking an evidence timestamp.
async function preloadPlayer(evidenceId) {
  const data = await fetchPlayback(evidenceId);
  if (data) loadStream(data.playback_url);
}

async function playAt(evidenceId) {
  const data = await fetchPlayback(evidenceId);
  if (!data) return;
  currentEvidenceId = evidenceId;
  document.querySelectorAll(".btn-play").forEach((button) =>
    button.classList.toggle("active", button.dataset.evidence === evidenceId)
  );
  const player = $("player");
  const fullSourceContext = data.playback_mode === "full_source_context";
  const start = () => {
    player.currentTime = fullSourceContext ? data.detected_start_seconds : 0;
    player.play().catch(() => {});
  };
  loadStream(data.playback_url, start);
  if (player.dataset.src === data.playback_url && player.readyState >= 1) start();
  const marker = $("detection-marker");
  const renderMarker = (duration) => {
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
    player.addEventListener("loadedmetadata", () => renderMarker(player.duration), { once: true });
  } else {
    renderMarker(data.playback_end_seconds - data.playback_start_seconds);
  }
  $("player-note").textContent = fullSourceContext
    ? `Detected ${fmtTime(data.detected_start_seconds)}–${fmtTime(data.detected_end_seconds)} · showing full source context because duration was unavailable.`
    : `Detected ${fmtTime(data.detected_start_seconds)}–${fmtTime(data.detected_end_seconds)}${data.showing_surrounding_context ? " · showing surrounding context" : ""}.`;
}

async function loadReport(autoplayEvidenceId = null) {
  if (!currentSubmissionId) return;
  // Report payloads can be large. If a reviewer selects another matrix cell
  // while an earlier request is in flight, the stale response must never
  // replace the newly selected submission or requirement.
  const requestedSubmissionId = currentSubmissionId;
  const res = await api(`/api/submissions/${requestedSubmissionId}/report`);
  if (!res.ok) return;
  const data = await res.json();
  if (currentSubmissionId !== requestedSubmissionId) return;
  currentReport = data;

  // Swap the placeholder for the report. `report-panel` is the always-visible
  // container; the report itself lives in `report-body`.
  $("report-placeholder").hidden = true;
  $("report-body").hidden = false;
  $("report-title").textContent = data.submission.creator_reference;
  $("report-sub").textContent = `${data.campaign.name ?? "Campaign"} · version ${data.version.version}`;
  const access = $("report-access");
  access.hidden = false;
  access.className = `report-access ${data.permissions.read_only ? "is-read-only" : "is-writable"}`;
  access.innerHTML = data.permissions.read_only
    ? `<strong>Curated demonstration · read only.</strong> Inspect each requirement, its measurement, exact clip, and recorded human decision.`
    : `<strong>Your live sandbox.</strong> Create campaigns, submit public media URLs, review findings and record decisions here.`;
  const chip = $("submission-state");
  chip.textContent = data.submission.state;
  chip.className = `state-chip state-${data.submission.state}`;

  const errBox = $("submission-error");
  if (data.submission.error_summary) {
    errBox.textContent = data.submission.error_summary;
    errBox.hidden = false;
  } else {
    errBox.hidden = true;
  }

  renderStages(data.stages);

  const hasTerminalFailure = data.stages.some(
    (s) => s.state === "failed_terminal"
  );
  $("retry-btn").hidden = !hasTerminalFailure || !data.permissions.can_retry;

  if (data.media) {
    $("media-info").innerHTML = `
      <dl>
        <dt>Duration</dt><dd>${
          data.media.duration_seconds === null ||
          data.media.duration_seconds === undefined
            ? "not available"
            : data.media.duration_seconds.toFixed(2) + "s"
        }</dd>
        <dt>Playback</dt><dd>${data.media.playable ? "Available through authenticated AdProof media access" : "Not ready"}</dd>
      </dl>`;
  } else {
    $("media-info").innerHTML =
      `<p class="empty">No media reference recorded yet. Ingestion has not completed.</p>`;
  }
  if (data.source_attribution) {
    const source = data.source_attribution;
    $("media-info").insertAdjacentHTML("beforeend", `<details class="source-license"><summary>Source &amp; license</summary><dl><dt>Title</dt><dd>${esc(source.title)}</dd><dt>Author</dt><dd>${esc(source.author)}</dd><dt>Source</dt><dd><a href="${esc(source.source_page_url)}" target="_blank" rel="noopener noreferrer">${esc(source.source_page_url)}</a></dd><dt>License</dt><dd><a href="${esc(source.license_url)}" target="_blank" rel="noopener noreferrer">Licensed under ${esc(source.license_name)}</a></dd></dl><p>AdProof uses bounded excerpts and analytical overlays from this independently published video. This is a fictional, curated campaign; AdProof did not commission the video, and no creator, brand, retailer, platform, or uploader endorsement is implied.</p></details>`);
  }

  $("adjudication-slot").innerHTML = renderAdjudication(data);
  renderRules(data.rules, data.permissions);
  document.querySelectorAll(".decision-btn").forEach((btn) => btn.addEventListener("click", () => openDecision(btn.dataset.decision)));
  const targetEvidence = autoplayEvidenceId || data.rules.find((r) => r.id === selectedRuleId)?.evidence.find((e) => e.evidence_kind !== "context")?.id;
  if (targetEvidence) playAt(targetEvidence);

  const auditRes = await api(`/api/submissions/${requestedSubmissionId}/audit`);
  if (auditRes.ok) {
    const events = await auditRes.json();
    if (currentSubmissionId !== requestedSubmissionId) return;
    $("audit-list").innerHTML = `<h4>Audit trail</h4><ol class="audit-list">${events.map((event) => `<li><strong>${esc(event.category.replaceAll(".", " "))}</strong><span>${esc(event.actor)} · ${esc(new Date(event.at).toLocaleString())}</span></li>`).join("")}</ol>`;
  }

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
  const response = await api(`/api/submissions/${currentSubmissionId}/playback`);
  if (!response.ok) return;
  const data = await response.json();
  $("detection-marker").hidden = true;
  $("player-note").textContent = "Full source playback · evidence markers are shown only on bounded clips.";
  loadStream(data.playback_url, () => $("player").play().catch(() => {}));
});

$("retry-btn").addEventListener("click", async () => {
  await api(`/api/submissions/${currentSubmissionId}/retry`, { method: "POST" });
  loadReport();
});

/* ── views ──────────────────────────────────────────────────────────────── */

function switchView(view) {
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

$("disclosure-toggle").addEventListener("click", () => {
  const list = $("disclosure-list");
  list.hidden = !list.hidden;
  $("disclosure-toggle").setAttribute("aria-expanded", String(!list.hidden));
});

/* ── campaigns ──────────────────────────────────────────────────────────── */

async function loadCampaigns() {
  campaigns = await (await api("/api/campaigns")).json();
  if (!campaigns.some((campaign) => campaign.id === currentCampaignId)) {
    currentCampaignId = campaigns[0]?.id || null;
  }
  $("campaigns-empty").hidden = campaigns.length > 0;
  $("campaign-list").innerHTML = campaigns
    .map(
      (c) => `<li><button type="button" class="campaign-row ${c.id === currentCampaignId ? "active" : ""}" data-campaign="${esc(c.id)}">
        <span class="campaign-card-top"><strong>${esc(c.name)}</strong><span aria-hidden="true">→</span></span>
        <span>${esc(c.workspace_name ?? "Workspace")} · ${esc(c.is_showcase ? "curated demo" : "private campaign")}</span>
        <small>${esc(c.rule_set_version ? `Confirmed rule set v${c.rule_set_version}` : "Rules not confirmed")}</small>
      </button></li>`
    )
    .join("");
  $("campaign-list").querySelectorAll("[data-campaign]").forEach((button) => button.addEventListener("click", () => {
    currentCampaignId = button.dataset.campaign;
    loadCampaigns();
  }));
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

async function loadCampaignDashboard(campaignId) {
  const response = await api(`/api/campaigns/${campaignId}/dashboard`);
  if (!response.ok) return;
  const data = await response.json();
  const requirements = data.requirements;
  const rows = data.submissions;
  $("campaign-dashboard").innerHTML = `
    <header class="dashboard-head">
      <div><span class="eyebrow">${data.campaign.is_showcase ? "Curated demonstration campaign" : "Campaign workspace"}</span><h2>${esc(data.campaign.name)}</h2><p>${esc(data.campaign.brief || "No brief recorded.")}</p></div>
      <button id="dashboard-new-submission" class="btn btn-primary" type="button">Add creator submission</button>
    </header>
    <div class="dashboard-stats">
      <div><strong>${data.summary.submission_count}</strong><span>Creator submission${data.summary.submission_count === 1 ? "" : "s"}</span></div>
      <div><strong>${requirements.length}</strong><span>Confirmed requirements</span></div>
      <div><strong>${data.summary.unresolved_count}</strong><span>Checks needing attention</span></div>
    </div>
    <section class="requirements-overview"><div class="section-heading"><div><span class="eyebrow">Confirmed before review</span><h3>Campaign requirements</h3></div><span class="confirmed-note">✓ Confirmed ${data.campaign.confirmed_at ? new Date(data.campaign.confirmed_at).toLocaleDateString() : ""}</span></div>
      <ol>${requirements.map((rule) => `<li><span>${rule.ordinal + 1}</span><p><strong>${esc(rule.requirement_text)}</strong><small>${esc(rule.severity)} requirement</small></p></li>`).join("")}</ol>
    </section>
    <section class="matrix-section"><div class="section-heading"><div><span class="eyebrow">Review operations</span><h3>Creator × requirement matrix</h3></div><span class="muted-inline">Select any result to open its evidence</span></div>
      ${rows.length ? `<div class="matrix-scroll"><table class="review-matrix"><thead><tr><th scope="col">Creator / submission</th>${requirements.map((rule) => `<th scope="col"><span>R${rule.ordinal + 1}</span>${esc(rule.requirement_text)}</th>`).join("")}<th scope="col">Decision</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row"><button type="button" data-submission="${esc(row.submission_id)}"><strong>${esc(row.creator_reference)}</strong><span>${esc(row.state.replaceAll("_", " "))} · ${row.unresolved_count} unresolved</span></button></th>${row.cells.map((cell) => `<td><button type="button" class="matrix-cell" data-submission="${esc(row.submission_id)}" data-rule="${esc(cell.rule_id)}" data-evidence="${esc(cell.evidence_id || "")}">${matrixStatus(cell.effective_state, cell.reviewed)}</button></td>`).join("")}<td>${row.final_decision ? matrixStatus(row.final_decision === "approve" ? "pass" : row.final_decision === "reject" ? "fail" : "uncertain", true) : `<span class="matrix-status">Not decided</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No creator submissions yet.</p>`}
    </section>
    ${data.campaign.is_showcase ? `<p class="source-disclosure">These are curated demonstration campaigns built from independently published, reuse-permitted creator videos. They are not commissioned brand submissions or endorsements of AdProof.</p>` : ""}`;
  $("dashboard-new-submission").addEventListener("click", openNewSubmission);
  $("campaign-dashboard").querySelectorAll("[data-submission]").forEach((button) => button.addEventListener("click", () => selectSubmission(button.dataset.submission, button.dataset.rule || null, button.dataset.evidence || null)));
}

function openNewSubmission() {
  if (isDemoVisitor()) {
    openLogin(
      "Log in to add a submission. Your private workspace will open here without leaving the showcase.",
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
  const err0 = $("submission-error");
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
  const err = $("submission-error");
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
                 A cluster here usually means the rule or the retrieval is wrong, not the creator.</div>`
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
  pendingAuthIntent = null;
  $("login-dialog").close();
});
$("login-dialog").addEventListener("close", () => {
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
      openLogin("The public showcase is temporarily unavailable. Log in to access your workspace.");
      return;
    }
    me = await res.json();
  } catch {
    showApp();
    openLogin("The public showcase is temporarily unavailable. Log in to access your workspace.");
    return;
  }
  if (location.search) history.replaceState({}, "", "/app");
  currentUser = me.user;
  currentWorkspaces = me.workspaces;
  const showcase = currentWorkspaces.find((w) => w.is_showcase);
  if (isDemoVisitor()) {
    $("who").textContent = "Viewing public demo";
    $("auth-action").textContent = "Log in";
    $("workspace-banner-copy").textContent =
      "Explore completed evidence immediately. When you want to create a campaign or add a submission, log in and continue on this same page.";
    $("workspace-capability").textContent = "Log in to create";
    $("workspace-banner").hidden = false;
  } else {
    $("who").textContent = me.user.name || me.user.email;
    $("auth-action").textContent = "Sign out";
    $("workspace-banner").hidden = !showcase;
  }
  showApp();
  await Promise.all([loadIntegrity(), loadCampaigns(), loadSubmissions()]);
}

boot();
setInterval(() => {
  if (currentUser) loadSubmissions();
}, 10000);
