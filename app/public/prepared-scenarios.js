"use strict";

// This file is deliberately a browser-only prepared walkthrough. It has no API
// calls, credentials, mutable server state, or provider execution path.
const scenarios = [
  {
    id: "A",
    label: "A - requirements observed",
    submission: "PB-REP-A",
    creator: "Creator A - representative",
    state: "Ready for review",
    stateClass: "ready",
    outcome: "Machine findings support every representative requirement",
    outcomeClass: "pass",
    machine: "passed",
    human: "not yet recorded",
    report: "Prepared report complete",
    summary: "The prepared review contains direct speech, visual-duration, and disclosure observations. A human still owns the decision.",
    evidence: [
      {
        kind: "support",
        role: "Machine support",
        time: "00:04.2 - 00:05.1",
        text: "Prepared transcript reading: “Use code AYUSH20.”",
        note: "Speech rule - direct phrase match in the prepared scenario."
      },
      {
        kind: "support",
        role: "Machine support",
        time: "00:10.0 - 00:17.4",
        text: "Prepared visual reading: PulseBar protein bar package remains visible for 7.4 seconds.",
        note: "Visual duration rule - above the representative 6-second threshold."
      },
      {
        kind: "support",
        role: "Machine support",
        time: "00:01.0 - 00:03.0",
        text: "Prepared visual reading: paid-partnership disclosure is legible on screen.",
        note: "Disclosure rule - visible evidence, not an inferred keyword."
      },
      {
        kind: "conflict",
        role: "Conflicting candidate",
        time: "00:20.8 - 00:21.4",
        text: "A brief product glimpse is recorded separately but does not change the measured 7.4-second interval.",
        note: "Kept for reviewer context; it is not additional duration."
      }
    ]
  },
  {
    id: "B",
    label: "B - disclosure needs review",
    submission: "PB-REP-B",
    creator: "Creator B - representative",
    state: "Ready for review",
    stateClass: "review",
    outcome: "Disclosure is not established from the prepared evidence",
    outcomeClass: "review",
    machine: "human review required",
    human: "not yet recorded",
    report: "Prepared report complete - absence remains unresolved",
    summary: "A search miss is not proof that a disclosure is absent. This scenario routes a potentially missing disclosure to a reviewer instead of manufacturing a pass or fail.",
    evidence: [
      {
        kind: "support",
        role: "Machine support",
        time: "00:05.0 - 00:05.8",
        text: "Prepared transcript reading: “Use code AYUSH20.”",
        note: "The speech requirement is satisfied in this representative scenario."
      },
      {
        kind: "absence",
        role: "Absence assessment",
        time: "00:00.0 - 00:27.0",
        text: "No prepared disclosure marker was retained for the reviewed window.",
        note: "This is an absence assessment, not evidence that a disclosure does not exist."
      },
      {
        kind: "conflict",
        role: "Conflicting candidate",
        time: "00:14.2 - 00:15.0",
        text: "A low-legibility on-screen label could be an advertising disclosure.",
        note: "The prepared scenario retains the candidate so a human can inspect the source."
      }
    ]
  },
  {
    id: "C",
    label: "C - blocking claim finding",
    submission: "PB-REP-C",
    creator: "Creator C - representative",
    state: "Escalated for reviewer decision",
    stateClass: "block",
    outcome: "A prohibited health-claim finding blocks automatic approval",
    outcomeClass: "block",
    machine: "failed",
    human: "required before escalation outcome",
    report: "Prepared report complete - decision not automated",
    summary: "A high-confidence candidate is preserved with contextual evidence. The prepared status is blocking, not a legal or final determination.",
    evidence: [
      {
        kind: "support",
        role: "Machine support",
        time: "00:12.4 - 00:14.1",
        text: "Prepared transcript reading: “PulseBar cures fatigue.”",
        note: "Prohibited health-claim candidate in the representative rule set."
      },
      {
        kind: "conflict",
        role: "Conflicting context",
        time: "00:14.1 - 00:15.2",
        text: "Prepared transcript reading: “Results vary from person to person.”",
        note: "Context is retained for a human; it does not erase the candidate phrase."
      },
      {
        kind: "support",
        role: "Machine support",
        time: "00:03.5 - 00:04.4",
        text: "Prepared transcript reading: “Use code AYUSH20.”",
        note: "A satisfied rule remains visible beside the blocking finding."
      }
    ]
  },
  {
    id: "D",
    label: "D - duration is uncertain",
    submission: "PB-REP-D",
    creator: "Creator D - representative",
    state: "Ready for review",
    stateClass: "review",
    outcome: "Package-duration measurement is inside the review margin",
    outcomeClass: "uncertain",
    machine: "uncertain",
    human: "not yet recorded",
    report: "Prepared report complete - measurement needs confirmation",
    summary: "The measured interval is close to the 6-second requirement and the representative sampling resolution prevents an automatic conclusion.",
    evidence: [
      {
        kind: "uncertainty",
        role: "Measurement uncertainty",
        time: "00:05.0 - 00:10.4",
        text: "Prepared visual interval: package visible for 5.4 seconds against a 6-second requirement.",
        note: "The interval is within the representative sampling margin."
      },
      {
        kind: "conflict",
        role: "Conflicting candidate",
        time: "00:09.3 - 00:11.0",
        text: "A transition-frame candidate may extend the product appearance but is not accepted as a clean interval.",
        note: "A human should inspect the transition rather than accept a guessed duration."
      },
      {
        kind: "support",
        role: "Machine support",
        time: "00:01.7 - 00:02.7",
        text: "Prepared visual reading: paid-partnership disclosure is legible on screen.",
        note: "Other rule outcomes remain separate from the uncertain measurement."
      }
    ]
  }
];

const localReviews = new Set();
let activeScenarioId = "A";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function activeScenario() {
  return scenarios.find((scenario) => scenario.id === activeScenarioId) || scenarios[0];
}

function renderScenarioList() {
  const list = document.querySelector("#scenario-list");
  list.innerHTML = scenarios.map((scenario) => `
    <button class="scenario-button" type="button" role="tab"
      aria-selected="${scenario.id === activeScenarioId}"
      aria-controls="report" data-scenario-id="${scenario.id}">
      <strong>${escapeHtml(scenario.label)}</strong>
      <span>${escapeHtml(scenario.outcome)}</span>
    </button>
  `).join("");

  list.querySelectorAll("[data-scenario-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeScenarioId = button.dataset.scenarioId;
      render();
    });
  });
}

function evidenceCard(evidence) {
  return `
    <article class="evidence-card ${escapeHtml(evidence.kind)}">
      <header>
        <span class="role ${escapeHtml(evidence.kind)}">${escapeHtml(evidence.role)}</span>
        <time class="timestamp">${escapeHtml(evidence.time)}</time>
      </header>
      <p>${escapeHtml(evidence.text)}</p>
      <small>${escapeHtml(evidence.note)}</small>
    </article>
  `;
}

function renderReport() {
  const scenario = activeScenario();
  const locallyReviewed = localReviews.has(scenario.id);
  document.querySelector("#report").innerHTML = `
    <div class="report-header">
      <div>
        <p class="eyebrow">Submission ${escapeHtml(scenario.submission)}</p>
        <div class="report-title">
          <h2>${escapeHtml(scenario.label)}</h2>
          <span class="status-pill ${escapeHtml(scenario.stateClass)}">${escapeHtml(scenario.state)}</span>
        </div>
        <p class="report-meta">${escapeHtml(scenario.creator)} - ${escapeHtml(scenario.report)}</p>
      </div>
      <span class="chip neutral">Prepared data</span>
    </div>

    <ol class="timeline" aria-label="Prepared review steps">
      <li class="stage">
        <span class="stage-dot">1</span>
        <div>
          <h3>Scope the submission</h3>
          <div class="stage-card">
            <header><strong>Campaign and confirmed rule set</strong><span class="state neutral">Prepared</span></header>
            <p>PulseBar launch - PB-LAUNCH-01. The representative brief requires AYUSH20, a 6-second product appearance, an advertising disclosure, and no prohibited health claim.</p>
            <div class="facts">
              <div class="fact"><span>Submission status</span><strong>${escapeHtml(scenario.state)}</strong></div>
              <div class="fact"><span>Machine state</span><strong>${escapeHtml(scenario.machine)}</strong></div>
              <div class="fact"><span>Human state</span><strong>${locallyReviewed ? "reviewed in this browser" : escapeHtml(scenario.human)}</strong></div>
            </div>
          </div>
        </div>
      </li>
      <li class="stage">
        <span class="stage-dot">2</span>
        <div>
          <h3>Inspect supporting and conflicting moments</h3>
          <p>Prepared observations are separated by role. They are not a substitute for the source media.</p>
          <div class="evidence-grid">${scenario.evidence.map(evidenceCard).join("")}</div>
          <div class="media-boundary">
            <strong>Playback boundary:</strong>
            <span>No checked-in or authorized public media URL is available for this prepared scenario, so this walkthrough does not pretend to offer playback.</span>
          </div>
        </div>
      </li>
      <li class="stage">
        <span class="stage-dot">3</span>
        <div>
          <h3>Keep the rule outcome distinct from the evidence</h3>
          <div class="verdict">
            <div>
              <h4>${escapeHtml(scenario.outcome)}</h4>
              <p>${escapeHtml(scenario.summary)}</p>
            </div>
            <span class="state ${escapeHtml(scenario.outcomeClass)}">${escapeHtml(scenario.machine)}</span>
          </div>
        </div>
      </li>
      <li class="stage">
        <span class="stage-dot">4</span>
        <div>
          <h3>Record a reviewer position</h3>
          <div class="review-controls">
            <div>
              <p>${locallyReviewed ? "This prepared scenario is marked reviewed only in the current browser session." : "Marking this scenario reviewed is available only as a local walkthrough control."}</p>
              <p class="local-note">It writes no database record, triggers no workflow, and resets with this page.</p>
            </div>
            <div class="button-row">
              <button class="action" id="mark-reviewed" type="button">${locallyReviewed ? "Marked reviewed locally" : "Mark reviewed locally"}</button>
              <button class="action secondary" id="reset-local-review" type="button">Reset local review</button>
            </div>
          </div>
        </div>
      </li>
    </ol>
  `;

  document.querySelector("#mark-reviewed").addEventListener("click", () => {
    localReviews.add(scenario.id);
    renderReport();
  });
  document.querySelector("#reset-local-review").addEventListener("click", () => {
    localReviews.clear();
    render();
  });
}

function render() {
  renderScenarioList();
  renderReport();
}

render();
