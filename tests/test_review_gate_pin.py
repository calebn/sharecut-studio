"""Characterization of the align-accept and transcript-refine review gates.

Both gates share one vocabulary: a status sidecar, a fingerprint, ``mark_*``
transitions, a report, and the pipeline's ``require_or_waive_unattended``. Each
case runs against both gates and pins the sidecar bytes, report shape and gate
summaries literally.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits.align_accept_status import ALIGN_GATE, AlignAcceptRequiredError
from podcast_mcp.edits.conversation_align import align_artifact_path
from podcast_mcp.edits.transcript_refine_status import (
    REFINE_GATE,
    TranscriptRefineRequiredError,
    reviewed_transcript_fingerprint,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProjectMeta,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


@dataclass(frozen=True)
class Ops:
    name: str
    filename: str
    fingerprint_key: str
    mode_key: str
    pending_source: str
    pending_notes: str
    error: type[Exception]
    off_summary: str
    path: Any
    load: Any
    pending: Any
    done: Any
    waive: Any
    clear: Any
    report: Any
    gate: Any
    mode: Any

    def defaults(self, mode: str, **extra: Any) -> dict[str, Any]:
        outer, inner = self.mode_key.rsplit(".", 1)
        cfg: dict[str, Any] = {inner: {"mode": mode}}
        for part in reversed(outer.split(".")):
            cfg = {part: cfg}
        return {**cfg, **extra}


ALIGN = Ops(
    name="align",
    filename="align_accept_status.json",
    fingerprint_key="align_fingerprint",
    mode_key="align.accept",
    pending_source="align",
    pending_notes="reset after align_tracks",
    error=AlignAcceptRequiredError,
    off_summary="skipped (align.accept.mode=off)",
    path=ALIGN_GATE.path,
    load=ALIGN_GATE.load,
    pending=ALIGN_GATE.mark_pending,
    done=ALIGN_GATE.mark_done,
    waive=ALIGN_GATE.mark_waived,
    clear=ALIGN_GATE.is_clear,
    report=ALIGN_GATE.report,
    gate=ALIGN_GATE.require_or_waive_unattended,
    mode=ALIGN_GATE.mode,
)
REFINE = Ops(
    name="refine",
    filename="transcript_refine_status.json",
    fingerprint_key="transcript_fingerprint",
    mode_key="analysis.transcript_refine",
    pending_source="precorrect",
    pending_notes="reset after precorrect apply",
    error=TranscriptRefineRequiredError,
    off_summary="skipped (analysis.transcript_refine.mode=off)",
    path=REFINE_GATE.path,
    load=REFINE_GATE.load,
    pending=REFINE_GATE.mark_pending,
    done=REFINE_GATE.mark_done,
    waive=REFINE_GATE.mark_waived,
    clear=REFINE_GATE.is_clear,
    report=REFINE_GATE.report,
    gate=REFINE_GATE.require_or_waive_unattended,
    mode=REFINE_GATE.mode,
)


def _project(tmp_path: Path) -> EpisodeProject:
    p = EpisodeProject(meta=ProjectMeta(name="g", workspace_dir=str(tmp_path)))
    p.tracks.append(
        Track(
            id="a",
            label="A",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=10.0),
        )
    )
    p.clips.append(
        Clip(id="c1", track_id="a", source_start=0.0, source_end=10.0, timeline_start=0.0)
    )
    p.transcripts = [
        Transcript(
            track_id="a",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2),
                TranscriptWord(text="world", start=0.3, end=0.5),
            ],
        )
    ]
    p.ensure_dirs()
    return p


def _invalidate(ops: Ops, p: EpisodeProject) -> None:
    if ops is ALIGN:
        p.clips[0].timeline_start = 5.0
    else:
        p.transcripts[0].words[0].text = "hullo"


def _fingerprint(ops: Ops, p: EpisodeProject) -> str:
    if ops is ALIGN:
        from podcast_mcp.edits.conversation_align import alignment_fingerprint

        return alignment_fingerprint(p)
    return reviewed_transcript_fingerprint(p)


def _sidecar(ops: Ops, p: EpisodeProject) -> dict[str, Any]:
    return json.loads(ops.path(p).read_text(encoding="utf-8"))


def _write_artifact(p: EpisodeProject, plans: list[dict[str, Any]]) -> None:
    path = align_artifact_path(p)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"plans": plans}), encoding="utf-8")


@pytest.fixture(params=[ALIGN, REFINE], ids=lambda o: o.name)
def ops(request: pytest.FixtureRequest) -> Ops:
    return request.param


@pytest.fixture(autouse=True)
def _gate_on(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BATCH", raising=False)


@pytest.mark.refine_gate
def test_sidecar_path_and_missing_load(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    assert ops.path(p) == p.artifacts_dir() / ops.filename
    assert ops.load(p) is None
    assert ops.clear(p) is False


@pytest.mark.refine_gate
def test_report_without_sidecar(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    report = ops.report(p, defaults=ops.defaults("require"))
    fp = _fingerprint(ops, p)
    keys = [
        "status",
        "stored_status",
        "clear",
        "stale",
        "mode",
        "fingerprint",
        "stored_fingerprint",
        "fingerprint_match",
        "source",
        "notes",
        "updated_at",
        "path",
    ]
    if ops is ALIGN:
        keys += ["align_artifact", "plans", "large_move_sec", "large_moves"]
    assert list(report) == [*keys, "hint"]
    assert report["status"] == "pending"
    assert report["stored_status"] is None
    assert report["clear"] is False
    assert report["stale"] is False
    assert report["mode"] == "require"
    assert report["fingerprint"] == fp
    assert report["stored_fingerprint"] is None
    assert report["fingerprint_match"] is False
    assert report["source"] is None
    assert report["notes"] == ""
    assert report["updated_at"] is None
    assert report["path"] == f"artifacts/{ops.filename}"
    assert isinstance(report["hint"], str)
    assert report["hint"].startswith(
        "Conversation alignment needs review" if ops is ALIGN else "Transcript refine is required"
    )
    if ops is ALIGN:
        assert report["align_artifact"] is None
        assert report["plans"] == []
        assert report["large_moves"] == []


@pytest.mark.refine_gate
def test_report_hint_is_absent_when_off_or_clear(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    assert ops.report(p, defaults=ops.defaults("off"))["hint"] is None
    ops.done(p)
    assert ops.report(p, defaults=ops.defaults("require"))["hint"] is None


@pytest.mark.refine_gate
def test_mark_pending_defaults(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    payload = ops.pending(p)
    fp = _fingerprint(ops, p)
    stored = _sidecar(ops, p)
    assert stored == payload
    assert list(payload) == ["status", "updated_at", "source", "notes", ops.fingerprint_key]
    assert payload["status"] == "pending"
    assert payload["source"] == ops.pending_source
    assert payload["notes"] == ops.pending_notes
    assert payload[ops.fingerprint_key] == fp
    assert payload["updated_at"].endswith("+00:00")
    assert ops.clear(p) is False
    report = ops.report(p, defaults={})
    assert (report["status"], report["stored_status"], report["stale"]) == (
        "pending",
        "pending",
        False,
    )
    assert report["fingerprint_match"] is True


@pytest.mark.refine_gate
def test_mark_pending_explicit_source_and_notes(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    payload = ops.pending(p, source="cli", notes="again")
    assert (payload["source"], payload["notes"]) == ("cli", "again")


@pytest.mark.refine_gate
def test_mark_done_then_clear(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    payload = ops.done(p)
    assert payload["status"] == "done"
    assert payload["source"] == "agent"
    assert payload["notes"] == ""
    assert payload[ops.fingerprint_key] == _fingerprint(ops, p)
    if ops is ALIGN:
        assert list(payload) == [
            "status",
            "updated_at",
            "source",
            "notes",
            "align_fingerprint",
            "accepted_drift",
        ]
        assert payload["accepted_drift"] == []
    else:
        assert list(payload) == [
            "status",
            "updated_at",
            "source",
            "notes",
            "transcript_fingerprint",
        ]
    assert _sidecar(ops, p) == payload
    assert ops.clear(p) is True
    report = ops.report(p, defaults={})
    assert (report["status"], report["clear"], report["stale"]) == ("done", True, False)
    assert report["source"] == "agent"
    assert report["updated_at"] == payload["updated_at"]
    assert ops.done(p, source="mcp", notes="ok")["notes"] == "ok"
    assert _sidecar(ops, p)["source"] == "mcp"


@pytest.mark.refine_gate
def test_done_goes_stale_when_fingerprint_changes(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    ops.done(p)
    stored_fp = _fingerprint(ops, p)
    _invalidate(ops, p)
    assert ops.clear(p) is False
    report = ops.report(p, defaults={})
    assert report["status"] == "pending"
    assert report["stored_status"] == "done"
    assert report["stale"] is True
    assert report["clear"] is False
    assert report["fingerprint_match"] is False
    assert report["stored_fingerprint"] == stored_fp
    assert report["fingerprint"] != stored_fp


@pytest.mark.refine_gate
def test_pending_is_never_stale(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    ops.pending(p)
    _invalidate(ops, p)
    report = ops.report(p, defaults={})
    assert (report["status"], report["stale"], report["fingerprint_match"]) == (
        "pending",
        False,
        False,
    )


@pytest.mark.refine_gate
def test_waive_records_stripped_reason(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    payload = ops.waive(p, reason="  reviewed by ear  ")
    assert payload["status"] == "waived"
    assert payload["source"] == "user"
    assert payload["notes"] == "reviewed by ear"
    assert ops.clear(p) is True
    assert _sidecar(ops, p) == payload
    if ops is ALIGN:
        assert payload["accepted_drift"] == []
    assert ops.waive(p, reason="x", source="cli")["source"] == "cli"


@pytest.mark.refine_gate
@pytest.mark.parametrize("reason", ["", "   ", None])
def test_waive_requires_reason(ops: Ops, tmp_path: Path, reason: str | None) -> None:
    p = _project(tmp_path)
    with pytest.raises(ValueError, match=f"^{ops.name} waive requires a non-empty reason$"):
        ops.waive(p, reason=reason)
    assert not ops.path(p).exists()


@pytest.mark.refine_gate
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("require", "require"),
        (" Require ", "require"),
        ("WAIVE_UNATTENDED", "waive_unattended"),
        ("off", "off"),
        ("nope", "waive_unattended"),
        ("", "waive_unattended"),
    ],
)
def test_mode_parsing(ops: Ops, raw: str, expected: str) -> None:
    assert ops.mode(ops.defaults(raw)) == expected


@pytest.mark.refine_gate
def test_mode_defaults_when_unconfigured(ops: Ops) -> None:
    assert ops.mode({}) == "waive_unattended"
    assert ops.mode(ops.defaults("require") | {}) == "require"


@pytest.mark.refine_gate
def test_corrupt_and_non_object_sidecar_raise(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    ops.path(p).write_text("{not-json", encoding="utf-8")
    with pytest.raises(ValueError, match="corrupt"):
        ops.load(p)
    ops.path(p).write_text("[1]", encoding="utf-8")
    with pytest.raises(ValueError, match="JSON object"):
        ops.load(p)


@pytest.mark.refine_gate
def test_gate_off_skips_without_a_sidecar(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    assert ops.gate(p, defaults=ops.defaults("off")) == ops.off_summary
    assert not ops.path(p).exists()


@pytest.mark.refine_gate
@pytest.mark.parametrize("status", ["done", "waived"])
def test_gate_reports_a_clear_sidecar(ops: Ops, tmp_path: Path, status: str) -> None:
    p = _project(tmp_path)
    if status == "done":
        ops.done(p)
    else:
        ops.waive(p, reason="r")
    assert ops.gate(p, defaults=ops.defaults("require")) == f"{status} (fingerprint ok)"


@pytest.mark.refine_gate
@pytest.mark.parametrize("mode", ["require", "waive_unattended"])
def test_gate_blocks_interactive_pending(ops: Ops, tmp_path: Path, mode: str) -> None:
    p = _project(tmp_path)
    with pytest.raises(ops.error) as exc:
        ops.gate(p, defaults=ops.defaults(mode))
    assert str(exc.value) == ops.report(p, defaults={})["hint"]
    assert not ops.path(p).exists()
    ops.pending(p)
    with pytest.raises(ops.error):
        ops.gate(p, defaults=ops.defaults(mode))


@pytest.mark.refine_gate
def test_gate_blocks_a_stale_sidecar(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    ops.done(p)
    _invalidate(ops, p)
    with pytest.raises(ops.error):
        ops.gate(p, defaults=ops.defaults("require"))


@pytest.mark.refine_gate
def test_gate_require_mode_does_not_waive_unattended(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    with pytest.raises(ops.error):
        ops.gate(p, defaults=ops.defaults("require", _pipeline_unattended=True))
    with pytest.raises(ops.error):
        ops.gate(p, defaults=ops.defaults("require"), unattended=True)


@pytest.mark.refine_gate
@pytest.mark.parametrize("how", ["defaults", "flag", "env"])
def test_gate_waives_unattended(
    ops: Ops, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, how: str
) -> None:
    p = _project(tmp_path)
    defaults = ops.defaults("waive_unattended")
    kwargs: dict[str, Any] = {}
    if how == "defaults":
        defaults["_pipeline_unattended"] = True
    elif how == "flag":
        kwargs["unattended"] = True
    else:
        monkeypatch.setenv("PODCAST_BATCH", "yes")
    assert ops.gate(p, defaults=defaults, **kwargs) == "waived (unattended)"
    stored = _sidecar(ops, p)
    assert stored["status"] == "waived"
    assert stored["source"] == "unattended"
    assert stored["notes"] == "unattended pipeline"
    assert "accepted_drift" not in stored
    assert ops.clear(p) is True
    assert ops.gate(p, defaults=defaults, **kwargs) == "waived (fingerprint ok)"


@pytest.mark.refine_gate
def test_gate_unattended_default_mode_is_waive_unattended(ops: Ops, tmp_path: Path) -> None:
    p = _project(tmp_path)
    assert ops.gate(p, defaults={"_pipeline_unattended": True}) == "waived (unattended)"


@pytest.mark.refine_gate
def test_refine_assert_clear(tmp_path: Path) -> None:
    p = _project(tmp_path)
    REFINE_GATE.assert_clear(p, defaults=REFINE.defaults("off"))
    with pytest.raises(TranscriptRefineRequiredError):
        REFINE_GATE.assert_clear(p, defaults=REFINE.defaults("require"))
    REFINE_GATE.mark_done(p)
    REFINE_GATE.assert_clear(p, defaults=REFINE.defaults("require"))
    _invalidate(REFINE, p)
    with pytest.raises(TranscriptRefineRequiredError):
        REFINE_GATE.assert_clear(p, defaults=REFINE.defaults("waive_unattended"))


def test_refine_fingerprint_counts_archived_words_and_ignores_flags(tmp_path: Path) -> None:
    p = _project(tmp_path)
    before = reviewed_transcript_fingerprint(p)
    p.transcripts[0].words[0].suspect_hallucination = True
    assert reviewed_transcript_fingerprint(p) == before
    p.transcripts[0].words[1].text = "there"
    assert reviewed_transcript_fingerprint(p) != before


def test_align_done_records_plan_digest_and_goes_stale_with_the_artifact(
    tmp_path: Path,
) -> None:
    p = _project(tmp_path)
    plans: list[dict[str, Any]] = [
        {"track_id": "a", "clip_id": "c1", "method": "bleed", "offset_sec": 0.5}
    ]
    _write_artifact(p, plans)
    payload = ALIGN_GATE.mark_done(p)
    digest = hashlib.sha256(json.dumps(plans, sort_keys=True, separators=(",", ":")).encode())
    assert payload["accepted_plan_digest"] == digest.hexdigest()
    assert list(payload)[-2:] == ["accepted_drift", "accepted_plan_digest"]
    assert ALIGN_GATE.is_clear(p) is True
    _write_artifact(p, [{**plans[0], "offset_sec": 3.0}])
    assert ALIGN_GATE.is_clear(p) is False
    report = ALIGN_GATE.report(p, defaults=ALIGN.defaults("require"))
    assert (report["status"], report["stale"], report["clear"]) == ("pending", True, False)
    assert report["fingerprint_match"] is True
    assert report["align_artifact"] == "artifacts/alignment/conversation_align.json"
    assert report["plans"] == [{**plans[0], "offset_sec": 3.0}]
    with pytest.raises(AlignAcceptRequiredError):
        ALIGN_GATE.require_or_waive_unattended(p, defaults=ALIGN.defaults("require"))


def test_align_unattended_waive_omits_drift_and_pending_has_no_plan_digest(
    tmp_path: Path,
) -> None:
    p = _project(tmp_path)
    _write_artifact(p, [])
    assert "accepted_plan_digest" not in ALIGN_GATE.mark_pending(p)
    waived = ALIGN_GATE.mark_waived(p, reason="x", source="unattended")
    assert "accepted_drift" not in waived
    assert waived["accepted_plan_digest"] == hashlib.sha256(b"[]").hexdigest()


def test_align_accept_without_artifact_goes_stale_when_one_appears(tmp_path: Path) -> None:
    p = _project(tmp_path)
    ALIGN_GATE.mark_done(p)
    assert ALIGN_GATE.is_clear(p) is True
    _write_artifact(p, [])
    assert ALIGN_GATE.is_clear(p) is False


def test_align_unreadable_artifact_blocks_unattended_waive(tmp_path: Path) -> None:
    p = _project(tmp_path)
    path = align_artifact_path(p)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(AlignAcceptRequiredError, match="unreadable; re-run align_tracks"):
        ALIGN_GATE.require_or_waive_unattended(
            p, defaults=ALIGN.defaults("waive_unattended", _pipeline_unattended=True)
        )
    assert not ALIGN_GATE.path(p).exists()


def test_align_large_move_blocks_unattended_waive(tmp_path: Path) -> None:
    p = _project(tmp_path)
    _write_artifact(p, [{"track_id": "a", "clip_id": "c1", "method": "bleed", "offset_sec": 40.0}])
    with pytest.raises(AlignAcceptRequiredError, match=r"a \+40\.00s \(bleed\)"):
        ALIGN_GATE.require_or_waive_unattended(
            p, defaults=ALIGN.defaults("waive_unattended", _pipeline_unattended=True)
        )
    assert not ALIGN_GATE.path(p).exists()
