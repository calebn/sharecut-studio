"""Tests for pipeline config meta, merge, skip, and analyze suggestions."""

from __future__ import annotations

from podcast_mcp.config import load_defaults
from podcast_mcp.pipeline.meta import (
    cascade_disable,
    expand_enable,
    ordered_step_metas,
    param_fields_payload,
)
from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES, PipelineRunner
from podcast_mcp.services.pipeline_config import (
    config_store,
    deep_merge,
    default_enabled_steps,
    merge_pipeline_config,
    reconcile_enabled_steps,
    skip_steps_from_enabled,
    suggest_pipeline_tuning,
    sync_editorial_enabled_steps,
    whitelist_overrides,
)


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
        get_by_path,
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
