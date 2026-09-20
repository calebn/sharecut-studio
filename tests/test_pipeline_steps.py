from __future__ import annotations

from podcast_mcp.config import load_defaults
from podcast_mcp.models import (
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps


def _project_with_host(minimal_project, sample_wav, tmp_workspace):
    proj = load_project(minimal_project)
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def test_merge_transcript_step(minimal_project, sample_wav, tmp_workspace):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="Hi", start=0.0, end=0.2)],
        )
    ]
    defaults = load_defaults()
    steps.merge_transcript(proj, defaults)
    assert proj.combined_transcript is not None
    assert (proj.transcripts_dir() / "combined.json").is_file()


def test_clean_and_compress_steps(minimal_project, sample_wav, tmp_workspace):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.clean_audio(proj, defaults)
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    assert any(e.effect == "highpass" for e in chain.effects)
    steps.compress_tracks(proj, defaults)
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    comp = next(e for e in chain.effects if e.effect == "acompressor")
    assert comp.params["attack_ms"] == defaults["compression"]["attack_ms"]
    assert comp.params["release_ms"] == defaults["compression"]["release_ms"]
    assert comp.params["makeup_db"] == defaults["compression"]["makeup_db"]


def test_clean_audio_preserves_existing_chain(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    proj.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(
                    effect="agate",
                    params={"threshold_db": -44, "release_ms": 120},
                )
            ],
        )
    ]
    steps.clean_audio(proj, load_defaults())
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    effects = [e.effect for e in chain.effects]
    assert effects == ["highpass", "agate"]


def test_analyze_and_tighten_steps(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.1, end=0.2),
                TranscriptWord(text="hi", start=2.0, end=2.2),
            ],
        )
    ]
    defaults = load_defaults()
    defaults.setdefault("tighten", {})["enabled"] = True
    steps.analyze_fillers_pauses(proj, defaults)
    assert len(proj.edit_decisions) > 0
    before = len(proj.edit_decisions)
    steps.tighten_from_transcript(proj, defaults)
    assert len(proj.edit_decisions) < before
    assert not any((e.reason or "").startswith(("filler:", "pause:")) for e in proj.edit_decisions)


def test_tighten_steps_skip_when_disabled(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.1, end=0.2),
                TranscriptWord(text="hi", start=2.0, end=2.2),
            ],
        )
    ]
    defaults = load_defaults()
    defaults.setdefault("tighten", {})["enabled"] = False
    assert steps.analyze_fillers_pauses(proj, defaults) == "skipped (tighten.enabled=false)"
    assert steps.tighten_from_transcript(proj, defaults) == "skipped (tighten.enabled=false)"
    assert proj.edit_decisions == []


def test_analyze_fillers_summary_counts_discourse_skips(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
                TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
                TranscriptWord(text="said", start=0.45, end=0.7, confidence=0.95),
                TranscriptWord(text="like", start=1.0, end=1.2, confidence=0.95),
                TranscriptWord(text="world", start=1.3, end=1.5, confidence=0.95),
            ],
        )
    ]
    defaults = load_defaults()
    defaults.setdefault("tighten", {})["enabled"] = True
    defaults["tighten"]["max_pause_sec"] = 99.0
    summary = steps.analyze_fillers_pauses(proj, defaults)
    assert "2 discourse kept" in (summary or "")
    assert not any((e.reason or "").startswith("filler:like") for e in proj.edit_decisions)
