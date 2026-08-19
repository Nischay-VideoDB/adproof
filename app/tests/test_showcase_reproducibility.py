"""The public showcase must exercise the product, never a demo-only evaluator."""

from __future__ import annotations

import ast
from pathlib import Path


APP = Path(__file__).resolve().parents[1]
SEEDER = APP / "scripts" / "seed_showcase.py"


def test_showcase_seeder_only_creates_inputs_then_invokes_the_normal_worker():
    source = SEEDER.read_text()
    tree = ast.parse(source)
    forbidden_models = {
        "EvaluationResult",
        "EvidenceItem",
        "RetrievalRun",
        "RuleReview",
        "SubmissionDecision",
        "ProcessingJob",
    }
    referenced_names = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    }
    imported_names = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    }
    assert not forbidden_models & (referenced_names | imported_names)
    assert "run_version_until_idle" in referenced_names
    assert 'client.post("/api/campaigns"' in source
    assert 'client.post(\n                    "/api/submissions/upload"' in source
    assert "evidence_ids" not in source


def test_pipeline_has_no_showcase_or_source_specific_result_branch():
    pipeline_roots = [
        APP / "src" / "adproof" / "evaluation",
        APP / "src" / "adproof" / "retrieval",
        APP / "src" / "adproof" / "orchestrator",
        APP / "src" / "adproof" / "providers",
    ]
    forbidden_markers = {
        "biossance",
        "nank runner",
        "jessica posh",
        "terence eden",
        "creator review 2026-08",
        "biossance-eye-cream-demo.mp4",
        "nank-runner-diver2-review.mp4",
        "109314104a453c71554b7a6f1b52f803b2479fc231e34f404e3c34d5374a170a",
        "6091fb0d4be5394756237df28a122a3b75abaa53e7186618f706ef9b40371e91",
        "adproof_showcase_workspace_id",
    }
    for root in pipeline_roots:
        for path in root.rglob("*.py"):
            lowered = path.read_text().lower()
            assert not (forbidden_markers & {m for m in forbidden_markers if m in lowered}), path


def test_report_projects_persisted_pipeline_and_append_only_review_rows():
    source = (APP / "src" / "adproof" / "api" / "main.py").read_text()
    report_body = source[source.index('def get_report('):source.index('@app.get("/api/submissions/{submission_id}/audit")')]
    for model in ("RetrievalRun", "EvidenceItem", "EvaluationResult", "RuleReview"):
        assert f"select({model})" in report_body
    assert '"reviews": [' in report_body
    assert '"result": (' in report_body


def test_readme_states_the_real_reproducibility_boundary():
    readme = " ".join((APP / "README.md").read_text().lower().split())
    assert "deterministic given the same persisted evidence" in readme
    assert "fresh provider upload or re-index is not promised" in readme
    assert "seven of eight final machine states matched" in readme
