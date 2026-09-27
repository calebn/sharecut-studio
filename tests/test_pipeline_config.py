"""Tests for pipeline config meta, merge, skip, and analyze suggestions."""

from __future__ import annotations

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.pipeline.meta import (
    PARAM_FIELDS,
    cascade_disable,
    expand_enable,
    ordered_step_metas,
    param_fields_payload,
    step_noop_reason,
)
from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES, PipelineRunner
from podcast_mcp.services.pipeline_config import (
    asr_options_for,
    config_assignment_paths,
    config_assignments,
    config_store,
    deep_merge,
    default_enabled_steps,
    editorial_enabled_flags,
    merge_pipeline_config,
    parse_config_assignments,
    pipeline_step_states,
    reconcile_enabled_steps,
    skip_steps_from_enabled,
    suggest_pipeline_tuning,
    sync_editorial_enabled_steps,
    whitelist_overrides,
)
from podcast_mcp.util.dicts import get_by_path


def _put_enable_toggle(store, proj, step_id: str, enabled: bool) -> None:
    ws = store.get(proj)
    current = (
        set(default_enabled_steps(ws.config)) if ws.enabled_steps is None else set(ws.enabled_steps)
    )
    current = expand_enable(current | {step_id}) if enabled else cascade_disable(current, step_id)
    store.put(proj, enabled_steps=list(current))


def test_ordered_step_metas_covers_spine() -> None:
    metas = ordered_step_metas()
    assert len(metas) == len(ORDERED_STEP_NAMES)
    assert metas[0]["id"] == "ingest_tracks"
    assert any(m["id"] == "require_transcript_refine" and m["kind"] == "gate" for m in metas)
    reconcile = [m for m in metas if m["id"] == "reconcile_transcript"]
    assert len(reconcile) == 2


def test_param_fields_have_ranges() -> None:
    params = param_fields_payload()
    balance = next(p for p in params if p["path"] == "balance.dialogue_lufs")
    assert balance["minimum"] == -30.0
    assert balance["maximum"] == -10.0
    assert "LUFS" in (balance.get("unit") or "")
    model = next(p for p in params if p["path"] == "transcribe.model")
    assert model["type"] == "enum"
    assert model["default"] == "large-v3-turbo"
    assert "large-v3-turbo" in model["enum"]
    assert "small.en" in model["enum"]
    assert "base" in model["enum"]


def test_expand_enable_pulls_deps() -> None:
    expanded = expand_enable({"export_deliverables"})
    assert "master_loudness" in expanded
    assert "ingest_tracks" in expanded


def test_cascade_disable() -> None:
    enabled = expand_enable({"export_deliverables"})
    after = cascade_disable(enabled, "mix_with_music")
    assert "mix_with_music" not in after
    assert "master_loudness" not in after
    assert "export_deliverables" not in after
    assert "assemble_timeline" in after or "compress_tracks" in after


def test_cascade_disable_align_keeps_transcribe() -> None:
    enabled = set(default_enabled_steps())
    assert "align_tracks" in enabled
    assert "require_align_accept" in enabled
    assert "merge_transcript" in enabled
    after = cascade_disable(enabled, "align_tracks")
    assert "align_tracks" not in after
    assert "require_align_accept" not in after
    assert "transcribe_tracks" in after
    assert "merge_transcript" in after


def test_default_enabled_includes_align() -> None:
    enabled = default_enabled_steps()
    assert "align_tracks" in enabled
    assert "require_align_accept" in enabled


def test_whitelist_and_merge() -> None:
    assert whitelist_overrides({"evil": 1, "balance": {"dialogue_lufs": -18}}) == {
        "balance": {"dialogue_lufs": -18}
    }
    merged = merge_pipeline_config({"balance": {"dialogue_lufs": -18.0}})
    assert merged["balance"]["dialogue_lufs"] == -18.0
    assert merged["master"]["integrated_lufs"] == load_defaults()["master"]["integrated_lufs"]


def test_deep_merge_nested() -> None:
    base = {"a": {"b": 1, "c": 2}, "d": 3}
    assert deep_merge(base, {"a": {"b": 9}}) == {"a": {"b": 9, "c": 2}, "d": 3}


def test_default_enabled_skips_focus_tighten() -> None:
    enabled = default_enabled_steps()
    assert "analyze_focus_cuts" not in enabled
    assert "tighten_from_transcript" not in enabled
    assert "balance_tracks" in enabled


def test_skip_steps_from_enabled() -> None:
    enabled = ["ingest_tracks", "transcribe_tracks"]
    skip = skip_steps_from_enabled(enabled)
    assert "merge_transcript" in skip
    assert "ingest_tracks" not in skip


def test_runner_skip_steps() -> None:
    from podcast_mcp.models import EpisodeProject
    from podcast_mcp.pipeline import runner as runner_mod

    calls: list[str] = []

    def fake_ingest(project, defaults):
        calls.append("ingest_tracks")
        return "ok"

    def fake_merge(project, defaults):
        calls.append("merge_transcript")
        return "ok"

    project = EpisodeProject.create(name="t", workspace_dir="/tmp")
    runner = PipelineRunner(defaults={})
    orig_ingest = runner_mod._STEP_MAP["ingest_tracks"]
    orig_merge = runner_mod._STEP_MAP["merge_transcript"]
    try:
        runner_mod._STEP_MAP["ingest_tracks"] = fake_ingest
        runner_mod._STEP_MAP["merge_transcript"] = fake_merge
        # from ingest, skip merge - should still run ingest then later steps
        # Use only_step to keep the test narrow
        runner.run(project, only_step="ingest_tracks")
        assert calls == ["ingest_tracks"]
        calls.clear()
        selected = runner._select_steps("ingest_tracks", None, {"merge_transcript"})
        names = [n for n, _ in selected]
        assert "ingest_tracks" in names
        assert "merge_transcript" not in names
    finally:
        runner_mod._STEP_MAP["ingest_tracks"] = orig_ingest
        runner_mod._STEP_MAP["merge_transcript"] = orig_merge


def test_config_store_roundtrip(tmp_path) -> None:
    proj = tmp_path / "ep.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = config_store()
    store.put(proj, reset=True, unattended=False)
    store.put(proj, enabled_steps=[])
    store.put(
        proj,
        config={"balance": {"dialogue_lufs": -19.0}},
        enabled_steps=["export_deliverables"],
    )
    ws = store.get(proj)
    assert ws.unattended is False
    assert ws.config["balance"]["dialogue_lufs"] == -19.0
    assert "master_loudness" in (ws.enabled_steps or [])  # deps expanded
    assert "ingest_tracks" in (ws.enabled_steps or [])


def test_reconcile_uncheck_cascades_dependents() -> None:
    previous = expand_enable({"balance_tracks", "compress_tracks"})
    requested = set(previous) - {"clean_audio"}
    assert "clean_audio" in previous
    assert "balance_tracks" in requested  # client still had dependent checked
    after = reconcile_enabled_steps(previous, requested)
    assert "clean_audio" not in after
    assert "balance_tracks" not in after
    assert "compress_tracks" not in after


def test_sync_editorial_steps_from_focus_flag() -> None:
    enabled = set(default_enabled_steps())
    assert "analyze_focus_cuts" not in enabled
    on = sync_editorial_enabled_steps(enabled, {"focus": {"enabled": True}})
    assert "analyze_focus_cuts" in on
    assert "focus_from_transcript" in on
    off = sync_editorial_enabled_steps(set(on), {"focus": {"enabled": False}})
    assert "analyze_focus_cuts" not in off
    both = sync_editorial_enabled_steps(
        enabled,
        {"focus": {"enabled": True}, "tighten": {"enabled": True}},
    )
    assert "tighten_from_transcript" in both
    assert "analyze_fillers_pauses" in both


def test_suggest_preserves_working_set_knobs() -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject

    base = merge_pipeline_config({"balance": {"dialogue_lufs": -18.0}})
    project = EpisodeProject.create(name="t", workspace_dir="/tmp")

    def fake_analyze(project, *, policy=None, progress=None):
        return {"tracks": []}

    real = audio_audit.analyze_cleanup
    audio_audit.analyze_cleanup = fake_analyze  # type: ignore[assignment]
    try:
        result = suggest_pipeline_tuning(project, base_config=base)
        assert result["proposed_config"]["balance"]["dialogue_lufs"] == -18.0
    finally:
        audio_audit.analyze_cleanup = real  # type: ignore[assignment]


def test_config_put_syncs_focus_without_enabled_list(tmp_path) -> None:
    proj = tmp_path / "ep2.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = config_store()
    store.put(proj, reset=True)
    store.put(proj, config={"focus": {"enabled": True, "auto_apply": False}})
    ws = store.get(proj)
    assert "analyze_focus_cuts" in (ws.enabled_steps or [])


def test_config_put_preserves_focus_uncheck_when_flag_unchanged(tmp_path) -> None:
    from podcast_mcp.services.pipeline_config import FOCUS_STEPS

    proj = tmp_path / "ep3.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = config_store()
    store.put(proj, reset=True)
    store.put(proj, config={"focus": {"enabled": True, "auto_apply": False}})
    ws = store.get(proj)
    without_focus = [s for s in (ws.enabled_steps or []) if s not in FOCUS_STEPS]
    store.put(proj, enabled_steps=without_focus)
    assert "analyze_focus_cuts" not in (store.get(proj).enabled_steps or [])
    store.put(
        proj,
        config={
            "focus": {"enabled": True, "auto_apply": False},
            "balance": {"dialogue_lufs": -18.0},
        },
    )
    assert "analyze_focus_cuts" not in (store.get(proj).enabled_steps or [])
    assert store.get(proj).config["balance"]["dialogue_lufs"] == -18.0


def test_default_enabled_includes_focus_tighten_when_on() -> None:
    cfg = merge_pipeline_config({"focus": {"enabled": True}, "tighten": {"enabled": True}})
    enabled = default_enabled_steps(cfg)
    assert "analyze_focus_cuts" in enabled
    assert "focus_from_transcript" in enabled
    assert "analyze_fillers_pauses" in enabled
    assert "tighten_from_transcript" in enabled


def test_apply_enable_toggle_enable_and_disable(tmp_path) -> None:
    proj = tmp_path / "ep_toggle.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = config_store()
    store.put(proj, reset=True, enabled_steps=["ingest_tracks", "transcribe_tracks"])
    _put_enable_toggle(store, proj, "merge_transcript", True)
    assert "merge_transcript" in (store.get(proj).enabled_steps or [])
    assert "ingest_tracks" in (store.get(proj).enabled_steps or [])
    _put_enable_toggle(store, proj, "transcribe_tracks", False)
    enabled = store.get(proj).enabled_steps or []
    assert "transcribe_tracks" not in enabled
    assert "merge_transcript" not in enabled


def test_component_status_shape() -> None:
    from podcast_mcp.services.pipeline_config import component_status

    status = component_status()
    assert "ffmpeg" in status
    assert "ok" in status["ffmpeg"]
    assert "whisper" in status
    assert "rnnoise" in status


def test_component_status_whisper_requires_cached_weights(tmp_path, monkeypatch) -> None:
    from podcast_mcp.services import pipeline_config as pc

    cache = tmp_path / "whisper-cache"
    cache.mkdir()
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)

    status = pc.component_status(whisper_model="large-v3-turbo")
    assert status["whisper"]["ok"] is False
    assert status["whisper"]["model"] == "large-v3-turbo"
    assert "not downloaded" in status["whisper"]["hint"]

    blob = cache / "models--Systran--faster-whisper-large-v3-turbo" / "blobs" / "model.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    status_ok = pc.component_status(whisper_model="large-v3-turbo")
    assert status_ok["whisper"]["ok"] is True


def test_build_config_payload_includes_whisper_models(tmp_path, monkeypatch) -> None:
    from podcast_mcp.services import pipeline_config as pc

    cache = tmp_path / "whisper-cache"
    cache.mkdir()
    monkeypatch.setattr("podcast_mcp.config.whisper_cache_dir", lambda: cache)
    proj = tmp_path / "ep.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = pc.config_store()
    store.put(
        proj,
        config={"transcribe": {"model": "small.en"}},
        enabled_steps=["ingest_tracks", "transcribe_tracks"],
    )
    payload = pc.build_config_payload(proj)
    assert isinstance(payload["whisper_models"], list)
    assert any(m["id"] == "small.en" for m in payload["whisper_models"])
    assert all("cached" in m for m in payload["whisper_models"])
    assert payload["components"]["whisper"]["ok"] is False
    assert payload["components"]["whisper"]["model"] == "small.en"


def test_suggest_pipeline_tuning_heuristic_branches() -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject

    base = merge_pipeline_config(
        {
            "effects": {
                "gate": [
                    {"type": "gate", "params": {"threshold_db": -30.0}},
                    {"type": "gate", "params": {"ratio": 2}},
                ],
            },
            "compression": {"makeup_db": 3.0},
        }
    )
    project = EpisodeProject.create(name="t", workspace_dir="/tmp")

    def fake_analyze(project, *, policy=None, progress=None):
        return {
            "tracks": [
                {
                    "track_id": "host",
                    "health": {
                        "hum": {
                            "hum_detected": True,
                            "recommendation": "raise HPF",
                        },
                        "noise_floor_db": -40.0,
                        "flat_factor": 2.0,
                        "peak_count": 1,
                    },
                    "gate_analysis": {
                        "risk": "high",
                        "issues": ["over-gate"],
                    },
                    "high_bleed_warning": "bleed on host",
                },
                {
                    "track_id": "guest",
                    "health": {"hum": "not-a-dict", "noise_floor_db": "na"},
                    "gate_analysis": {"risk": "low", "issues": []},
                },
            ]
        }

    real = audio_audit.analyze_cleanup
    audio_audit.analyze_cleanup = fake_analyze  # type: ignore[assignment]
    try:
        result = suggest_pipeline_tuning(project, base_config=base)
        result_defaults = suggest_pipeline_tuning(project)
    finally:
        audio_audit.analyze_cleanup = real  # type: ignore[assignment]

    codes = {r["code"] for r in result["reasons"]}
    assert codes >= {"hum", "noise_floor", "gate_overreach", "bleed", "clipping"}
    assert "noise_reduction" in (result["proposed_config"].get("effects") or {})
    gate_nodes = (result["proposed_config"].get("effects") or {}).get("gate") or []
    assert gate_nodes
    assert gate_nodes[0]["params"]["threshold_db"] == -36.0
    assert result["proposed_config"]["compression"]["makeup_db"] == 0.0
    assert result["report_summary"]["reason_count"] == len(result["reasons"])

    by_code = {r["code"]: r for r in result["reasons"]}
    assert by_code["noise_floor"]["evidence"] == {
        "noise_floor_db": -40.0,
        "threshold_db": -50.0,
    }
    assert by_code["gate_overreach"]["evidence"]["risk"] == "high"
    assert by_code["gate_overreach"]["evidence"]["issue_count"] == 1
    assert by_code["clipping"]["evidence"]["flat_factor"] == 2.0
    assert "dominant_frequency" in by_code["hum"]["evidence"]
    tracks = result["report_summary"]["tracks"]
    assert [t["track_id"] for t in tracks] == ["host", "guest"]
    assert tracks[0]["noise_floor_db"] == -40.0

    from podcast_mcp.effects.presets import get_preset

    default_fx = result_defaults["proposed_config"].get("effects") or {}
    assert default_fx["noise_reduction"] == get_preset("noise_reduction")
    assert default_fx["gate"][0]["params"]["threshold_db"] == -36.0
    assert "effects" in result_defaults["patches"]
    assert result_defaults["report_summary"]["track_count"] == 2


def test_suggest_pipeline_tuning_seeds_gate_when_base_effects_omit_it(monkeypatch) -> None:
    import copy

    from podcast_mcp.effects import presets as presets_mod
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject

    my_chain = [{"effect": "highpass", "params": {"frequency": 100}}]
    base = merge_pipeline_config({"effects": {"my_chain": my_chain}})
    assert "gate" not in base["effects"]
    project = EpisodeProject.create(name="t", workspace_dir="/tmp")

    def fake_analyze(project, *, policy=None, progress=None):
        return {
            "tracks": [
                {
                    "track_id": "host",
                    "health": {},
                    "gate_analysis": {"risk": "high", "issues": ["over-gate"]},
                }
            ]
        }

    def no_reload():
        raise AssertionError("presets must resolve from the defaults already loaded")

    monkeypatch.setattr(audio_audit, "analyze_cleanup", fake_analyze)
    monkeypatch.setattr(presets_mod, "load_defaults", no_reload)

    result = suggest_pipeline_tuning(project, base_config=base)

    expected_gate = copy.deepcopy(presets_mod._BUILTIN_PRESETS["gate"])
    expected_gate[0]["params"]["threshold_db"] = -36.0
    assert result["patches"]["effects"]["gate"] == expected_gate
    assert result["patches"]["effects"]["my_chain"] == my_chain
    assert result["proposed_config"]["effects"]["gate"] == expected_gate
    gate_reasons = [r for r in result["reasons"] if r["code"] == "gate_overreach"]
    assert gate_reasons == [
        {
            "code": "gate_overreach",
            "track_id": "host",
            "message": "host: gate overreach findings - proposed a milder gate threshold (-6 dB)",
            "evidence": {"risk": "high", "issue_count": 1, "issues_sample": ["over-gate"]},
        }
    ]


def test_suggest_pipeline_tuning_shifts_gate_once_for_multiple_tracks(monkeypatch) -> None:
    import copy

    from podcast_mcp.effects import presets as presets_mod
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject

    base = merge_pipeline_config({"effects": {}})
    assert "gate" not in base["effects"]
    project = EpisodeProject.create(name="t", workspace_dir="/tmp")
    track_ids = ["host", "guest1", "guest2"]

    def fake_analyze(project, *, policy=None, progress=None):
        return {
            "tracks": [
                {"track_id": tid, "health": {}, "gate_analysis": {"risk": "high", "issues": []}}
                for tid in track_ids
            ]
        }

    monkeypatch.setattr(audio_audit, "analyze_cleanup", fake_analyze)

    result = suggest_pipeline_tuning(project, base_config=base)

    expected_gate = copy.deepcopy(presets_mod._BUILTIN_PRESETS["gate"])
    expected_gate[0]["params"]["threshold_db"] = -36.0
    assert result["patches"]["effects"]["gate"] == expected_gate
    assert result["proposed_config"]["effects"]["gate"] == expected_gate
    gate_reasons = [r for r in result["reasons"] if r["code"] == "gate_overreach"]
    assert [r["track_id"] for r in gate_reasons] == track_ids


def test_deep_merge_skips_underscore_keys() -> None:
    assert deep_merge({"a": 1}, {"_secret": 2, "a": 3}) == {"a": 3}


def test_component_status_error_branches(monkeypatch) -> None:
    from podcast_mcp.services import pipeline_config as pc

    def boom_ffmpeg():
        raise RuntimeError("no ffmpeg")

    def boom_rnnoise():
        raise RuntimeError("no rnnoise")

    monkeypatch.setattr(
        "podcast_mcp.util.binaries.resolve_ffmpeg",
        boom_ffmpeg,
    )
    monkeypatch.setattr(
        "podcast_mcp.util.model_assets.resolve_rnnoise_model",
        boom_rnnoise,
    )
    status = pc.component_status()
    assert status["ffmpeg"]["ok"] is False
    assert "no ffmpeg" in status["ffmpeg"]["hint"]
    assert status["rnnoise"]["ok"] is False
    assert "bootstrap" in status["rnnoise"]


def test_apply_enable_toggle_when_enabled_steps_none(tmp_path) -> None:
    proj = tmp_path / "ep_none.project.json"
    proj.write_text("{}", encoding="utf-8")
    store = config_store()
    store.put(proj, reset=True)
    store.get(proj).enabled_steps = None
    _put_enable_toggle(store, proj, "export_deliverables", True)
    assert "export_deliverables" in (store.get(proj).enabled_steps or [])
    store.get(proj).enabled_steps = None
    store.put(proj, config={"balance": {"dialogue_lufs": -21.0}})
    assert store.get(proj).config["balance"]["dialogue_lufs"] == -21.0


def test_meta_path_helpers_and_unknown_step() -> None:
    from podcast_mcp.pipeline.meta import (
        set_by_path,
        step_meta,
        transitive_depends_on,
    )

    data: dict = {"a": {"b": 1}}
    assert get_by_path(data, "a.b") == 1
    assert get_by_path(data, "a.missing") is None
    assert get_by_path(data, "gone.x") is None
    set_by_path(data, "a.c.d", 9)
    assert data["a"]["c"]["d"] == 9
    deps = transitive_depends_on("export_deliverables")
    assert "master_loudness" in deps
    unknown = transitive_depends_on("not_a_real_step")
    assert "not_a_real_step" in unknown
    try:
        step_meta("not_a_real_step")
        raise AssertionError("expected KeyError")
    except KeyError:
        pass


def test_tighten_intensity_param_field() -> None:
    row = next(p for p in param_fields_payload() if p["path"] == "tighten.intensity")
    assert row["type"] == "enum"
    assert list(row["enum"]) == ["light", "medium", "aggressive"]
    assert row["default"] == "medium"
    assert row["section"] == "tighten"
    merged = merge_pipeline_config({})
    assert merged["tighten"]["intensity"] == "medium"
    assert merged["tighten"]["repetition_candidates"] is True


def test_suggest_flags_equal_duration_dialogue(monkeypatch) -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

    monkeypatch.setattr(
        audio_audit,
        "analyze_cleanup",
        lambda project, *, policy=None, progress=None: {"tracks": []},
    )

    def build(second: float) -> EpisodeProject:
        p = EpisodeProject.create(name="t", workspace_dir="/tmp")
        for tid, dur in (("host", 1689.58), ("guest", second)):
            p.tracks.append(
                Track(
                    id=tid,
                    label=tid,
                    role=TrackRole.DIALOGUE,
                    media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=dur),
                )
            )
        return p

    same = suggest_pipeline_tuning(build(1689.58))
    pre_reasons = [r for r in same["reasons"] if r["code"] == "pre_aligned"]
    assert len(pre_reasons) == 1
    assert pre_reasons[0]["evidence"] == {
        "track_ids": ["guest", "host"],
        "duration_sec": 1689.58,
        "tolerance_sec": 0.05,
    }
    assert pre_reasons[0]["suggested_skip_steps"] == ["align_tracks"]
    assert "align" not in same["patches"]
    diff = suggest_pipeline_tuning(build(1600.0))
    assert not any(r["code"] == "pre_aligned" for r in diff["reasons"])


def test_suggest_reports_track_evidence_without_reasons(monkeypatch) -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject

    def fake_analyze(project, *, policy=None, progress=None):
        return {
            "tracks": [
                {
                    "track_id": "host",
                    "health": {"noise_floor_db": -70.0, "peak_level_db": -6.0, "flat_factor": 0.0},
                    "gate_analysis": {"risk": "none", "issues": []},
                    "bleed_ratio": 0.01,
                }
            ]
        }

    monkeypatch.setattr(audio_audit, "analyze_cleanup", fake_analyze)
    project = EpisodeProject.create(name="t", workspace_dir="/tmp")

    result = suggest_pipeline_tuning(project)

    assert result["reasons"] == []
    assert result["patches"] == {}
    tracks = result["report_summary"]["tracks"]
    assert len(tracks) == 1
    assert tracks[0]["noise_floor_db"] == -70.0
    assert tracks[0]["peak_level_db"] == -6.0
    assert tracks[0]["bleed_ratio"] == 0.01


def test_suggest_flags_digital_silence_and_vad(monkeypatch, tmp_path) -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

    monkeypatch.setattr(
        audio_audit,
        "analyze_cleanup",
        lambda project, *, policy=None, progress=None: {"tracks": []},
    )

    host_wav = tmp_path / "host.wav"
    guest_wav = tmp_path / "guest.wav"
    host_wav.write_bytes(b"\x00")
    guest_wav.write_bytes(b"\x00")

    def build() -> EpisodeProject:
        p = EpisodeProject.create(name="t", workspace_dir=str(tmp_path))
        p.tracks.append(
            Track(
                id="host",
                label="host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=str(host_wav), duration_sec=10.0),
            )
        )
        p.tracks.append(
            Track(
                id="guest",
                label="guest",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=str(guest_wav), duration_sec=10.0),
            )
        )
        p.tracks.append(
            Track(
                id="missing",
                label="missing",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=str(tmp_path / "missing.wav"), duration_sec=10.0),
            )
        )
        return p

    fractions = {"host": 0.85, "guest": 0.2}

    def fake_fraction(path, *, peak_dbfs):
        return fractions[path.stem]

    monkeypatch.setattr("podcast_mcp.engines.asr_silence.digital_silence_fraction", fake_fraction)

    result = suggest_pipeline_tuning(build())
    silence_reasons = [r for r in result["reasons"] if r["code"] == "digital_silence"]
    assert len(silence_reasons) == 1
    reason = silence_reasons[0]
    assert reason["track_id"] == "host"
    assert reason["evidence"]["silent_fraction"] == 0.85
    assert reason["evidence"]["threshold_fraction"] == 0.8
    assert reason["evidence"]["peak_dbfs"] == -60.0
    assert reason["evidence"]["vad_enabled"] is True
    assert "transcribe" not in result["patches"]
    tracks_by_id = {t["track_id"]: t for t in result["report_summary"]["tracks"]}
    assert tracks_by_id["host"]["digital_silence_fraction"] == 0.85
    assert tracks_by_id["guest"]["digital_silence_fraction"] == 0.2
    assert tracks_by_id["missing"]["digital_silence_fraction"] is None
    assert tracks_by_id["missing"]["digital_silence_skipped"] == "missing_audio"
    assert "digital_silence_skipped" not in tracks_by_id["host"]

    off_result = suggest_pipeline_tuning(
        build(), base_config=merge_pipeline_config({"transcribe": {"vad": {"enabled": False}}})
    )
    assert off_result["patches"]["transcribe"]["vad"]["enabled"] is True
    assert off_result["proposed_config"]["transcribe"]["vad"]["enabled"] is True


def test_suggest_reports_undecodable_dialogue_track(monkeypatch, tmp_path) -> None:
    from podcast_mcp.engines import audio_audit
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

    monkeypatch.setattr(
        audio_audit,
        "analyze_cleanup",
        lambda project, *, policy=None, progress=None: {"tracks": []},
    )

    host_wav = tmp_path / "host.wav"
    host_wav.write_bytes(b"\x00")

    p = EpisodeProject.create(name="t", workspace_dir=str(tmp_path))
    p.tracks.append(
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(host_wav), duration_sec=10.0),
        )
    )

    monkeypatch.setattr(
        "podcast_mcp.engines.asr_silence.digital_silence_fraction",
        lambda path, *, peak_dbfs: None,
    )

    result = suggest_pipeline_tuning(p)
    tracks_by_id = {t["track_id"]: t for t in result["report_summary"]["tracks"]}
    assert tracks_by_id["host"]["digital_silence_fraction"] is None
    assert tracks_by_id["host"]["digital_silence_skipped"] == "decode_failed"
    assert not any(r["code"] == "digital_silence" for r in result["reasons"])


@pytest.mark.parametrize("field", PARAM_FIELDS, ids=lambda f: f.path)
def test_param_field_default_matches_yaml(field) -> None:
    assert get_by_path(load_defaults(), field.path) == field.default


def test_transcribe_asr_yaml_keys_have_param_fields() -> None:
    cfg = load_defaults()["transcribe"]
    leaves = {
        f"transcribe.{sec}.{key}" for sec in ("vad", "decode", "silence_filter") for key in cfg[sec]
    }
    fields = {f.path for f in PARAM_FIELDS}
    # temperature is a list; ParamField has no list type (yaml / config_json only).
    assert leaves - fields == {"transcribe.decode.temperature"}


def test_align_module_constants_match_yaml() -> None:
    from podcast_mcp.edits import conversation_align as ca

    align = load_defaults()["align"]
    assert align["large_move_sec"] == ca.LARGE_MOVE_SEC
    assert align["large_move_min_peak"] == ca.LARGE_MOVE_MIN_PEAK
    assert align["min_bleed_matches"] == ca.MIN_BLEED_MATCHES
    assert align["bleed_min_share"] == ca.BLEED_MIN_SHARE
    assert align["bleed_identity_sec"] == ca.BLEED_IDENTITY_SEC
    assert align["realign"] is False


def test_transcribe_overwrite_param_and_run_only_helper() -> None:
    from podcast_mcp.pipeline.meta import PARAM_FIELDS
    from podcast_mcp.services.pipeline_config import transcribe_run_config

    field = next(f for f in PARAM_FIELDS if f.path == "transcribe.overwrite")
    assert field.type == "boolean" and field.group == "advanced"
    assert load_defaults()["transcribe"]["overwrite"] is False
    forced = transcribe_run_config({"balance": {"dialogue_lufs": -17.0}}, force=True)
    assert forced["transcribe"]["overwrite"] is True
    assert forced["balance"]["dialogue_lufs"] == -17.0
    assert transcribe_run_config(None, force=True)["transcribe"]["overwrite"] is True
    assert transcribe_run_config({"a": 1}, force=False) == {"a": 1}
    assert transcribe_run_config(None, force=False) is None
    assert transcribe_run_config(None, force=True)["transcribe"]["overwrite_edited"] is False
    # overwrite_edited is a confirmation for a forced run only; alone it changes nothing.
    assert transcribe_run_config({"a": 1}, force=False, overwrite_edited=True) == {"a": 1}
    assert transcribe_run_config(None, force=False, overwrite_edited=True) is None
    confirmed = transcribe_run_config(None, force=True, overwrite_edited=True)
    assert confirmed["transcribe"]["overwrite_edited"] is True
    assert load_defaults()["transcribe"]["overwrite"] is False


def test_balance_depends_on_compress() -> None:
    from podcast_mcp.pipeline.meta import cascade_disable, expand_enable

    assert "compress_tracks" in expand_enable({"balance_tracks"})
    left = cascade_disable(expand_enable({"assemble_timeline"}), "compress_tracks")
    assert "balance_tracks" not in left and "assemble_timeline" not in left


def test_premix_peak_ceiling_default_is_defined_once() -> None:
    from podcast_mcp.config import DEFAULT_PREMIX_PEAK_CEILING_DB, mix_peak_ceiling_db

    field = next(f for f in PARAM_FIELDS if f.path == "mix.premix_peak_ceiling_db")
    assert field.default == DEFAULT_PREMIX_PEAK_CEILING_DB
    assert load_defaults()["mix"]["premix_peak_ceiling_db"] == DEFAULT_PREMIX_PEAK_CEILING_DB
    assert mix_peak_ceiling_db({}) == DEFAULT_PREMIX_PEAK_CEILING_DB
    assert mix_peak_ceiling_db({"mix": {"premix_peak_ceiling_db": -3}}) == -3.0


def test_asr_options_for_unstaged_project_uses_defaults_without_staging(tmp_path):
    proj = tmp_path / "ep.project.json"
    proj.write_text("{}", encoding="utf-8")
    assert config_store().peek(proj) is None
    opts = asr_options_for(proj)
    assert opts.vad_enabled is True
    assert config_store().peek(proj) is None


def test_asr_options_for_reads_staged_config(tmp_path):
    proj = tmp_path / "ep2.project.json"
    proj.write_text("{}", encoding="utf-8")
    try:
        config_store().put(proj, config={"transcribe": {"vad": {"enabled": False}}})
        assert asr_options_for(proj).vad_enabled is False
    finally:
        config_store()._by_path.pop(config_store()._key(proj), None)


def test_step_noop_reason():
    cfg = load_defaults()
    assert step_noop_reason("analyze_focus_cuts", cfg) == "focus.enabled=false"
    assert step_noop_reason("focus_from_transcript", cfg) == "focus.auto_apply=false"
    assert step_noop_reason("analyze_fillers_pauses", cfg) == "tighten.enabled=false"
    assert step_noop_reason("tighten_from_transcript", cfg) == "tighten.enabled=false"
    assert step_noop_reason("ingest_tracks", cfg) is None
    on_cfg = deep_merge(cfg, {"focus": {"enabled": True}})
    assert step_noop_reason("analyze_focus_cuts", on_cfg) is None


def test_parse_config_assignments_types_and_nesting() -> None:
    result = parse_config_assignments(
        [
            "focus.enabled=true",
            "focus.episode_promise=null",
            "transcribe.decode.temperature=[0.0, 0.2]",
            'effects.gate=[{"type": "gate", "params": {"threshold_db": -30}}]',
        ]
    )
    assert result["focus"]["enabled"] is True
    assert result["focus"]["episode_promise"] is None
    assert result["transcribe"]["decode"]["temperature"] == [0.0, 0.2]
    assert result["effects"]["gate"] == [{"type": "gate", "params": {"threshold_db": -30}}]


@pytest.mark.parametrize(
    "assignment",
    [
        "no-equals-sign",
        "=1",
        "bogus_top_level.thing=1",
        "focus.not_a_real_key=1",
        "focus..enabled=1",
        "focus.enabled=[unclosed",
    ],
)
def test_parse_config_assignments_rejects(assignment: str) -> None:
    with pytest.raises(ValueError):
        parse_config_assignments([assignment])


def test_config_assignments_round_trips() -> None:
    patches = {"focus": {"enabled": True}, "transcribe": {"vad": {"enabled": False}}}
    assignments = config_assignments(patches)
    assert set(assignments) == {"focus.enabled=true", "transcribe.vad.enabled=false"}
    round_tripped = parse_config_assignments(assignments)
    assert round_tripped == patches
    assert config_assignments({}) == []


def test_config_assignment_paths() -> None:
    patches = {
        "focus": {"enabled": True},
        "effects": {"gate": [{"effect": "agate"}]},
        "a=b": {"c": 1},
    }
    assert config_assignment_paths(patches) == ["focus.enabled", "effects.gate", "a=b.c"]
    assert config_assignment_paths({}) == []


def test_pipeline_step_states_rows():
    rows = pipeline_step_states()
    by_id = {row["id"]: row for row in rows}
    assert by_id["analyze_focus_cuts"]["enabled"] is False
    assert by_id["analyze_focus_cuts"]["noop_reason"] == "focus.enabled=false"
    assert by_id["ingest_tracks"]["enabled"] is True
    assert by_id["ingest_tracks"]["noop_reason"] is None


def test_editorial_gates_follow_noop_unless():
    cfg = deep_merge(load_defaults(), {"tighten": {"enabled": True}, "focus": {"enabled": True}})
    assert editorial_enabled_flags(cfg) == (True, True)
    enabled = default_enabled_steps(cfg)
    rows = {r["id"]: r for r in pipeline_step_states(cfg)}
    for step_id in ("analyze_fillers_pauses", "tighten_from_transcript"):
        assert step_id in enabled
        assert rows[step_id]["enabled"] is True
        assert rows[step_id]["noop_reason"] is None
    assert "analyze_focus_cuts" in enabled and "focus_from_transcript" in enabled


def test_tighten_gate_agrees_when_enabled_key_missing():
    cfg = load_defaults()
    cfg.setdefault("tighten", {}).pop("enabled", None)
    assert editorial_enabled_flags(cfg)[1] is False
    rows = {r["id"]: r for r in pipeline_step_states(cfg)}
    for step_id in ("analyze_fillers_pauses", "tighten_from_transcript"):
        assert rows[step_id]["enabled"] is False
        assert rows[step_id]["noop_reason"] == "tighten.enabled=false"
