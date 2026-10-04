from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
    TranscriptWord,
    load_project,
    save_project,
)


def test_speaker_ingest_alignment_shift_round_trip():
    raw = SpeakerIngestAlignment(session_start_in_file_sec=4.0, content_align_sec=1.5)
    assert raw.source_to_timeline_shift_sec == pytest.approx(-2.5)
    late = SpeakerIngestAlignment.from_source_to_timeline_shift(3.0, align_method="gap")
    assert (late.session_start_in_file_sec, late.content_align_sec) == (0.0, 3.0)
    assert late.align_method == "gap"
    lead = SpeakerIngestAlignment.from_source_to_timeline_shift(-2.5, align_method="bleed")
    assert (lead.session_start_in_file_sec, lead.content_align_sec) == (2.5, 0.0)
    assert lead.source_to_timeline_shift_sec == pytest.approx(-2.5)
    assert "source_to_timeline_shift_sec" not in lead.model_dump()


def test_automation_point_id_is_stable():
    point = AutomationPoint(id="point", time=0.0, value=1.0)
    assert point.id
    with pytest.raises(ValueError, match="Field is frozen"):
        point.id = "different"


def test_serialized_envelope_points_require_ids():
    with pytest.raises(ValueError, match="id"):
        AutomationEnvelope.model_validate(
            {
                "track_id": "host",
                "points": [{"time": 0, "value": 1}],
            }
        )


def test_saved_envelope_ids_round_trip_and_missing_ids_fail(envelope_project):
    raw = json.loads(envelope_project.read_text(encoding="utf-8"))
    raw["mix"]["automation_envelopes"] = [
        {
            "track_id": "host",
            "points": [
                {"id": "first", "time": 0, "value": 1},
                {"id": "last", "time": 5, "value": 0.5},
            ],
        }
    ]
    envelope_project.write_text(json.dumps(raw), encoding="utf-8")
    project = load_project(envelope_project)
    assert [p.id for p in project.automation_envelopes[0].points] == ["first", "last"]
    save_project(project, envelope_project)
    assert [p.id for p in load_project(envelope_project).automation_envelopes[0].points] == [
        "first",
        "last",
    ]
    del raw["mix"]["automation_envelopes"][0]["points"][0]["id"]
    envelope_project.write_text(json.dumps(raw), encoding="utf-8")
    before = envelope_project.read_bytes()
    with pytest.raises(ValueError, match="id"):
        load_project(envelope_project)
    assert envelope_project.read_bytes() == before


def test_transcript_word_resolve_auto_suppression_honors_lock() -> None:
    """#781: automatic writers must not flip a locked word's suppressed state."""
    locked_unsuppressed = TranscriptWord(text="hi", start=0.0, end=0.2, audibility_locked=True)
    assert locked_unsuppressed.resolve_auto_suppression(True) is False

    locked_suppressed = TranscriptWord(
        text="hi", start=0.0, end=0.2, suppressed=True, audibility_locked=True
    )
    assert locked_suppressed.resolve_auto_suppression(False) is True

    unlocked = TranscriptWord(text="hi", start=0.0, end=0.2)
    assert unlocked.resolve_auto_suppression(True) is True
    assert unlocked.resolve_auto_suppression(False) is False


def test_clip_timeline_end_property():
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=2.0,
        source_end=5.0,
        timeline_start=1.0,
    )
    assert clip.timeline_end == 4.0


def test_save_load_roundtrip(minimal_project):
    loaded = load_project(minimal_project)
    assert loaded.name == "test_episode"
    assert loaded.workspace_dir


def test_track_add_and_probe(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=str(sample_wav)),
        )
    )
    path = save_project(proj, minimal_project)
    again = load_project(path)
    assert again.track_by_id("host") is not None


def test_source_by_id(minimal_project):
    from podcast_mcp.models import SourceRecording

    proj = load_project(minimal_project)
    proj.sources.append(SourceRecording(id="src-a", path="raw/a.wav"))
    found = proj.source_by_id("src-a")
    assert found is not None and found.path == "raw/a.wav"
    assert proj.source_by_id("missing") is None


def test_edit_segments():
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    eng = FFmpegEngine()
    edits = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=0.8,
            applied=True,
        )
    ]
    segs = eng.segments_after_edits(2.0, edits, "host")
    assert len(segs) == 2
    assert segs[0].start == 0.0 and segs[0].end == 0.5
    assert segs[1].start == 0.8 and segs[1].end == 2.0


_ARTIFACTS = "artifacts"
_PATH_JOIN_CALLS = frozenset({"join", "joinpath", "Path", "PurePath", "PosixPath"})


def _is_artifacts_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value == _ARTIFACTS


def _joins_artifacts(node: ast.AST) -> bool:
    """True for a path join whose appended segment is the literal ``"artifacts"``."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        return _is_artifacts_literal(node.right)
    if isinstance(node, ast.Call):
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if name not in _PATH_JOIN_CALLS:
            return False
        # joinpath's args are all appended segments; join/Path's first arg is the base.
        segments = node.args if name == "joinpath" else node.args[1:]
        return any(_is_artifacts_literal(arg) for arg in segments)
    if isinstance(node, ast.JoinedStr):
        return any(
            isinstance(part, ast.Constant)
            and isinstance(part.value, str)
            and part.value.startswith("/artifacts")
            for part in node.values
        )
    return False


def test_workspace_artifacts_dir_is_the_only_artifacts_join() -> None:
    src = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
    offenders = [
        f"{path.relative_to(src)}:{node.lineno}"
        for path in sorted(src.rglob("*.py"))
        if path.name != "episode.py" or path.parent.name != "models"
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        if _joins_artifacts(node)
    ]
    assert offenders == [], "use models.workspace_artifacts_dir: " + ", ".join(offenders)


@pytest.mark.parametrize(
    ("snippet", "flagged"),
    [
        ('ws / "artifacts"', True),
        ('os.path.join(ws, "artifacts")', True),
        ('Path(ws, "artifacts")', True),
        ('ws.joinpath("artifacts")', True),
        ('f"{ws}/artifacts/x"', True),
        ('WORKSPACE_COPY_IGNORE = ("artifacts", "history")', False),
        ('Path("artifacts")', False),
        ('url = "/api/artifacts"', False),
    ],
)
def test_artifacts_join_scan_catches_every_spelling(snippet: str, flagged: bool) -> None:
    assert any(_joins_artifacts(n) for n in ast.walk(ast.parse(snippet))) is flagged
