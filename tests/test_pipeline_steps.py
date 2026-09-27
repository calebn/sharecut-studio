from __future__ import annotations

import logging

from podcast_mcp.config import load_defaults
from podcast_mcp.effects.presets import add_effect, apply_preset_to_chain
from podcast_mcp.models import (
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
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


def test_compress_tracks_rerun_keeps_one_compressor(minimal_project, sample_wav, tmp_workspace):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.clean_audio(proj, defaults)
    steps.compress_tracks(proj, defaults)
    steps.compress_tracks(proj, defaults)
    steps.compress_tracks(proj, defaults)
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    assert [e.effect for e in chain.effects] == ["highpass", "acompressor"]


def test_compress_tracks_rerun_applies_new_params_and_keeps_bypass(
    minimal_project, sample_wav, tmp_workspace
):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.compress_tracks(proj, defaults)
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    comp = next(e for e in chain.effects if e.effect == "acompressor")
    comp.bypass = True

    d = load_defaults()
    d = {**d, "compression": {**d["compression"], "ratio": 5.0}}
    steps.compress_tracks(proj, d)

    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    compressors = [e for e in chain.effects if e.effect == "acompressor"]
    assert len(compressors) == 1
    assert compressors[0].params["ratio"] == 5.0
    assert compressors[0].bypass is True


def test_compress_tracks_heals_stacked_compressors(minimal_project, sample_wav, tmp_workspace):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    proj.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="highpass", params={"frequency": 90}),
                ProcessingEffect(effect="acompressor", params={"ratio": 2}),
                ProcessingEffect(effect="acompressor", params={"ratio": 3}),
                ProcessingEffect(effect="agate", params={}),
                ProcessingEffect(effect="acompressor", params={"ratio": 4}),
            ],
        )
    ]
    steps.compress_tracks(proj, load_defaults())
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    assert [e.effect for e in chain.effects] == ["highpass", "acompressor", "agate"]


def test_compress_tracks_overwrites_preset_compressor_and_warns(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    apply_preset_to_chain(proj, "host", "podcast_standard")
    d = load_defaults()
    d = {**d, "compression": {**d["compression"], "ratio": 5.0}}
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.pipeline.steps"):
        summary = steps.compress_tracks(proj, d)
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    assert [e.effect for e in chain.effects] == ["highpass", "acompressor", "loudnorm"]
    assert chain.effects[1].params["ratio"] == 5.0
    assert "overwrote params on 1" in summary
    assert "overwriting acompressor params on track host" in caplog.text


def test_compress_tracks_collapses_user_serial_compressors(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    add_effect(proj, "host", "acompressor", {"ratio": 8})
    add_effect(proj, "host", "acompressor", {"ratio": 8})
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.pipeline.steps"):
        summary = steps.compress_tracks(proj, load_defaults())
    chain = next(c for c in proj.processing_chains if c.track_id == "host")
    compressors = [e for e in chain.effects if e.effect == "acompressor"]
    assert len(compressors) == 1
    assert compressors[0].params["ratio"] == load_defaults()["compression"]["ratio"]
    assert "removed 1 extra" in summary
    assert "removed 1 extra acompressor(s) on track host" in caplog.text


def test_compress_tracks_rerun_same_params_is_quiet(
    minimal_project, sample_wav, tmp_workspace, caplog
):
    proj = _project_with_host(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.compress_tracks(proj, defaults)
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.pipeline.steps"):
        summary = steps.compress_tracks(proj, defaults)
    assert summary == "compressor on 1 dialogue tracks"
    assert "compress_tracks:" not in caplog.text


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


def test_analyze_fillers_step_honours_config_intensity(minimal_project):
    def hits(intensity: str) -> list[str]:
        proj = load_project(minimal_project)
        proj.transcripts = [
            Transcript(
                track_id="host",
                words=[
                    TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.95),
                    TranscriptWord(text="world", start=1.8, end=2.1, confidence=0.95),
                ],
            )
        ]
        defaults = load_defaults()
        defaults["tighten"]["enabled"] = True
        defaults["tighten"]["intensity"] = intensity
        steps.analyze_fillers_pauses(proj, defaults)
        return [e.reason or "" for e in proj.edit_decisions]

    assert any(r.startswith("pause:") for r in hits("medium"))
    assert not any(r.startswith("pause:") for r in hits("light"))
