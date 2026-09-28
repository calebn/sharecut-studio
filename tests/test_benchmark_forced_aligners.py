from __future__ import annotations

import json
import re
import sys
import wave
import weakref
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from ctc_fakes import FakeBackend
from podcast_mcp.engines.ctc_forced_align import CtcVocab
from podcast_mcp.util.file_locks import shared_file_lock
from script_loader import load_script

FIXTURES = Path(__file__).parent / "fixtures"
WORD_BOUNDARY = FIXTURES / "word_boundary"
SYNTH = FIXTURES / "word_boundary_synthetic"

bfa = load_script("benchmark_forced_aligners", register=True)


def _vocab_json(path: Path, token_map: dict[str, int]) -> None:
    path.write_text(json.dumps(token_map), encoding="utf-8")


def test_resolve_target_librispeech_lists_scored_items() -> None:
    items = bfa.resolve_target("librispeech")

    assert len(items) == 3
    for item in items:
        assert item.gold is not None and item.gold.exists()
        assert item.words is not None and item.words.exists()
        assert item.clip is None


def test_resolve_target_aligned_dialogue_is_agreement_only() -> None:
    items = bfa.resolve_target("aligned_dialogue")

    assert len(items) == 2
    for item in items:
        assert item.gold is None
        assert item.audio.exists()
        assert item.clip == (0.0, 60.0)


def test_resolve_target_lab_uses_env_and_glob(tmp_path, monkeypatch) -> None:
    lab_dir = tmp_path / "source" / "zoom_excerpt_pan"
    lab_dir.mkdir(parents=True)
    (lab_dir / "audio1.m4a").write_bytes(b"")
    (lab_dir / "audio2.m4a").write_bytes(b"")
    monkeypatch.setenv("LAB", str(tmp_path))

    items = bfa.resolve_target("lab")
    assert sorted(item.item_id for item in items) == ["lab-audio1", "lab-audio2"]

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(FileNotFoundError, match="set LAB"):
        bfa.resolve_target("lab", lab=empty)

    with pytest.raises(ValueError):
        bfa.resolve_target("not-a-target")


def test_runs_dir_refuses_lab_checkout_and_requires_a_location(tmp_path) -> None:
    with pytest.raises(ValueError, match="runs-dir"):
        bfa.resolve_runs_dir("lab", None, None)

    lab = tmp_path / "lab"
    lab.mkdir()
    inside = lab / "runs" / "align"
    with pytest.raises(ValueError, match="inside the lab checkout"):
        bfa.resolve_runs_dir("lab", inside, lab)

    outside = tmp_path / "outside"
    assert bfa.resolve_runs_dir("lab", outside, lab) == outside


def test_candidates_config_is_pinned_and_valid() -> None:
    candidates = bfa.load_candidates()

    assert {c.label for c in candidates} == {"onnx-base", "onnx-base-int8", "torch-large"}
    for c in candidates:
        assert len(c.revision) == 40
        int(c.revision, 16)
        if c.backend == "onnx":
            assert c.onnx_file in c.allow_patterns
        command = bfa.download_command(c)
        assert c.hf_repo in command
        assert c.revision in command

    with pytest.raises(ValueError):
        bfa.load_candidates(labels=["not-a-label"])


def test_resolve_model_dir_never_downloads(monkeypatch, tmp_path) -> None:
    import huggingface_hub
    from huggingface_hub.errors import LocalEntryNotFoundError

    def cache_miss(*args, **kwargs):
        assert kwargs.get("local_files_only") is True
        raise LocalEntryNotFoundError("no cached snapshot")

    monkeypatch.setattr(huggingface_hub, "snapshot_download", cache_miss)
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]

    with pytest.raises(FileNotFoundError, match=r"no cached snapshot.*uv run python"):
        bfa.resolve_model_dir(candidate, None)

    override = tmp_path / "cached"
    assert bfa.resolve_model_dir(candidate, override) == override


def test_resolve_model_dir_surfaces_other_hub_errors(monkeypatch) -> None:
    import huggingface_hub

    def denied(*args, **kwargs):
        raise PermissionError("cache index is not readable")

    monkeypatch.setattr(huggingface_hub, "snapshot_download", denied)
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]

    with pytest.raises(PermissionError, match="not readable"):
        bfa.resolve_model_dir(candidate, None)


def _fake_hub(
    candidate, *, sha=None, license=None, undeclared_license=False, files=None, error=None
):
    info = SimpleNamespace(
        sha=sha or candidate.revision,
        card_data=SimpleNamespace(
            license=None if undeclared_license else (license or candidate.license)
        ),
        siblings=[
            SimpleNamespace(rfilename=name)
            for name in (
                files
                if files is not None
                else ["vocab.json", "config.json", "preprocessor_config.json", "onnx/model.onnx"]
            )
        ],
    )

    def model_info(repo, revision):
        if error is not None:
            raise error
        return info

    return SimpleNamespace(model_info=model_info)


def _hub_error(cls, status=404):
    import httpx

    request = httpx.Request("GET", "https://huggingface.co/api/models/x/revision/y")
    return cls(f"{cls.__name__} for url", response=httpx.Response(status, request=request))


def test_verify_candidate_reports_revision_license_and_file_drift() -> None:
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    assert bfa.verify_candidate(candidate, _fake_hub(candidate)) == []

    problems = bfa.verify_candidate(
        candidate, _fake_hub(candidate, sha="f" * 40, license="mit", files=["vocab.json"])
    )
    assert any("revision resolves" in p for p in problems)
    assert any("license" in p for p in problems)
    assert any("onnx/model.onnx" in p for p in problems)


def test_verify_candidate_notes_undeclared_card_license() -> None:
    """An unset model-card license (None) is not drift, but it is reported as a note:
    the pinned license was not verified."""
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    hub = _fake_hub(candidate, undeclared_license=True)
    assert bfa.verify_candidate(candidate, hub) == []

    notes: list[str] = []
    assert bfa.verify_candidate(candidate, hub, notes=notes) == []
    assert notes == ["onnx-base: model card declares no license; pinned 'apache-2.0' not verified"]

    declared: list[str] = []
    assert bfa.verify_candidate(candidate, _fake_hub(candidate), notes=declared) == []
    assert declared == []


@pytest.mark.parametrize(
    ("error_name", "status", "wording"),
    [
        ("RevisionNotFoundError", 404, "no longer resolves"),
        ("RepositoryNotFoundError", 404, "no longer resolves"),
        ("GatedRepoError", 401, "is gated: needs an HF token"),
        ("HfHubHTTPError", 503, "could not verify"),
        ("HfHubHTTPError", 429, "could not verify"),
    ],
)
def test_verify_candidate_reports_hub_errors_by_kind(error_name, status, wording) -> None:
    import huggingface_hub.errors

    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    error = _hub_error(getattr(huggingface_hub.errors, error_name), status=status)

    problems = bfa.verify_candidate(candidate, _fake_hub(candidate, error=error))

    assert len(problems) == 1
    assert problems[0].startswith("onnx-base: ")
    assert wording in problems[0]
    assert error_name in problems[0]
    if wording != "no longer resolves":
        assert "no longer resolves" not in problems[0]


def test_verify_candidate_reports_network_failures_without_aborting() -> None:
    import httpx

    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    request = httpx.Request("GET", "https://huggingface.co/api/models/x")
    for error in (
        httpx.ConnectError("refused", request=request),
        httpx.ReadTimeout("slow", request=request),
    ):
        problems = bfa.verify_candidate(candidate, _fake_hub(candidate, error=error))
        assert len(problems) == 1
        assert "could not verify" in problems[0]
        assert "no longer resolves" not in problems[0]
        assert type(error).__name__ in problems[0]


def test_main_verify_candidates_exit_code(monkeypatch, capsys) -> None:
    import huggingface_hub

    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda: _fake_hub(candidate))
    assert bfa.main(["verify-candidates", "--candidate", "onnx-base"]) == 0
    assert "all candidates verified" in capsys.readouterr().out

    monkeypatch.setattr(huggingface_hub, "HfApi", lambda: _fake_hub(candidate, license="mit"))
    assert bfa.main(["verify-candidates", "--candidate", "onnx-base"]) == 1

    from huggingface_hub.errors import RevisionNotFoundError

    capsys.readouterr()
    monkeypatch.setattr(
        huggingface_hub,
        "HfApi",
        lambda: _fake_hub(candidate, error=_hub_error(RevisionNotFoundError)),
    )
    assert (
        bfa.main(["verify-candidates", "--candidate", "onnx-base", "--candidate", "torch-large"])
        == 1
    )
    out = capsys.readouterr().out
    assert "onnx-base: revision" in out
    assert "torch-large: revision" in out


def test_main_verify_candidates_prints_notes_without_failing(monkeypatch, capsys) -> None:
    import huggingface_hub

    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    monkeypatch.setattr(
        huggingface_hub, "HfApi", lambda: _fake_hub(candidate, undeclared_license=True)
    )
    assert bfa.main(["verify-candidates", "--candidate", "onnx-base"]) == 0
    out = capsys.readouterr().out
    assert "note: onnx-base: model card declares no license" in out
    assert "no drift found (see notes above)" in out
    assert "all candidates verified" not in out


def test_main_verify_candidates_prints_notes_before_problems_and_fails(monkeypatch, capsys) -> None:
    """One candidate yields a note (undeclared card license) and another yields real
    drift: notes print first, then problems, the exit code is 1, and no summary
    line is printed."""
    import huggingface_hub

    onnx, torch = bfa.load_candidates(labels=["onnx-base", "torch-large"])
    hubs = {
        onnx.hf_repo: _fake_hub(onnx, undeclared_license=True),
        torch.hf_repo: _fake_hub(torch, license="mit", files=["config.json", "pytorch_model.bin"]),
    }
    api = SimpleNamespace(model_info=lambda repo, revision: hubs[repo].model_info(repo, revision))
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda: api)

    assert (
        bfa.main(["verify-candidates", "--candidate", "onnx-base", "--candidate", "torch-large"])
        == 1
    )
    assert capsys.readouterr().out.splitlines() == [
        "note: onnx-base: model card declares no license; pinned 'apache-2.0' not verified",
        "torch-large: model card license 'mit', pinned 'apache-2.0'",
    ]


def test_align_prediction_accepts_words_out_of_start_order() -> None:
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "H": 2, "I": 3, "B": 4, "Y": 5, "E": 6})
    words = [
        {"text": "bye", "start": 0.7, "end": 1.2},
        {"text": "hi", "start": 0.0, "end": 0.5},
    ]
    hot = {0: 2, 1: 3, 3: 1, 4: 4, 5: 5, 6: 6}
    backend = FakeBackend(vocab, hot, frames=7, vocab_size=7)
    samples = np.zeros(round(1.2 * bfa.SAMPLE_RATE), dtype=np.float32)

    output, stats, _ = bfa.align_prediction(samples, words, backend, vocab)

    assert [w["text"] for w in output] == ["bye", "hi"]
    assert output[0]["start"] == pytest.approx(0.08)
    assert output[0]["end"] == pytest.approx(0.14)
    assert output[1]["start"] == pytest.approx(0.0)
    assert output[1]["end"] == pytest.approx(0.04)
    assert stats["aligned_words"] == 2


def test_align_prediction_retimes_words_and_keeps_native_for_unalignable() -> None:
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "H": 2, "I": 3, "B": 4, "Y": 5, "E": 6})
    words = [
        {"text": "hi", "start": 0.0, "end": 0.5},
        {"text": "42", "start": 0.5, "end": 0.7},
        {"text": "bye", "start": 0.7, "end": 1.2},
    ]
    hot = {0: 2, 1: 3, 3: 1, 4: 4, 5: 5, 6: 6}
    backend = FakeBackend(vocab, hot, frames=7, vocab_size=7)
    samples = np.zeros(round(1.2 * bfa.SAMPLE_RATE), dtype=np.float32)

    output, stats, runtime_sec = bfa.align_prediction(samples, words, backend, vocab)

    assert output[0]["start"] == pytest.approx(0.0)
    assert output[0]["end"] == pytest.approx(0.04)
    assert output[0]["aligned"] is True
    assert output[1]["start"] == pytest.approx(0.5)
    assert output[1]["end"] == pytest.approx(0.7)
    assert output[1]["aligned"] is False
    assert output[2]["start"] == pytest.approx(0.08)
    assert output[2]["end"] == pytest.approx(0.14)
    assert output[2]["aligned"] is True
    assert stats == {
        "windows": 1,
        "failed_windows": 0,
        "aligned_words": 2,
        "unaligned_words": 1,
        "dropped_zero_duration": 0,
    }
    assert runtime_sec >= 0


def test_write_wav16_and_load_audio_clip(tmp_path) -> None:
    path = tmp_path / "out.wav"
    samples = np.zeros(bfa.SAMPLE_RATE, dtype=np.float32)
    bfa.write_wav16(path, samples)

    with wave.open(str(path), "rb") as handle:
        assert handle.getframerate() == bfa.SAMPLE_RATE
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2

    clipped = bfa.load_audio(path, (0.25, 0.75))
    assert len(clipped) == 8000
    assert clipped.dtype == np.float32
    assert len(bfa.load_audio(path, None)) == bfa.SAMPLE_RATE

    with pytest.raises(ValueError, match="empty audio clip"):
        bfa.load_audio(path, (0.0, 0.0))


def test_agreement_drops_zero_duration_words_and_ranks_disagreements() -> None:
    reference = {
        "audio_sha256": "a" * 64,
        "words": [
            {"text": "one", "start": 0.0, "end": 0.2},
            {"text": "zero", "start": 0.2, "end": 0.2},
            {"text": "two", "start": 0.3, "end": 0.5},
        ],
    }
    prediction = {
        "audio_sha256": "a" * 64,
        "provenance": {"runtime_sec": 1.5, "realtime_factor": 0.5},
        "words": [
            {"text": "one", "start": 0.0, "end": 0.2},
            {"text": "two", "start": 0.4, "end": 0.5},
        ],
    }

    result = bfa.agreement(reference, {"cand": prediction})

    entry = result["comparisons"]["cand"]
    assert entry["dropped_zero_duration"] == {"reference": 1, "prediction": 0}
    assert entry["metrics"]["matched_words"] == 2
    assert entry["largest_disagreements"][0]["text"] == "two"
    assert entry["largest_disagreements"][0]["max_error_ms"] == pytest.approx(100.0)
    assert entry["runtime_sec"] == 1.5
    assert entry["realtime_factor"] == 0.5


def test_agreement_counts_upstream_zero_duration_drops() -> None:
    words = [{"text": "one", "start": 0.0, "end": 0.2}]
    reference = {
        "audio_sha256": "a" * 64,
        "provenance": {"alignment_stats": {"dropped_zero_duration": 1}},
        "words": [*words, {"text": "zero", "start": 0.3, "end": 0.3}],
    }
    prediction = {
        "audio_sha256": "a" * 64,
        "provenance": {"alignment_stats": {"dropped_zero_duration": 2}},
        "words": words,
    }

    entry = bfa.agreement(reference, {"cand": prediction})["comparisons"]["cand"]

    assert entry["dropped_zero_duration"] == {"reference": 2, "prediction": 2}


def test_agreement_rejects_mismatched_audio() -> None:
    reference = {"audio_sha256": "a" * 64, "words": []}
    prediction = {"audio_sha256": "b" * 64, "words": []}
    with pytest.raises(ValueError, match="audio_sha256"):
        bfa.agreement(reference, {"cand": prediction})


def test_candidate_payload_is_a_valid_benchmark_prediction(tmp_path) -> None:
    gold_path = WORD_BOUNDARY / "1988-147956-0023.gold.json"
    native_path = WORD_BOUNDARY / "1988-147956-0023.native-base.json"
    native = json.loads(native_path.read_text(encoding="utf-8"))
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]

    payload = bfa.candidate_payload(
        candidate,
        audio_sha256=native["audio_sha256"],
        words=[dict(w, aligned=False) for w in native["words"]],
        stats={
            "windows": 0,
            "failed_windows": 0,
            "aligned_words": 0,
            "unaligned_words": len(native["words"]),
        },
        runtime_sec=0.1,
        load_sec=0.1,
        audio_sec=5.0,
        threads=1,
        model_dir=tmp_path,
    )
    pred_path = tmp_path / "prediction.json"
    with open(pred_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)

    benchmark_word_boundaries = load_script("benchmark_word_boundaries")
    report = benchmark_word_boundaries.benchmark(
        gold_path, prediction_path=pred_path, native_model=None
    )
    native_report = json.loads(native_path.read_text(encoding="utf-8"))
    assert report["metrics"] == native_report["metrics"]
    assert payload["provenance"]["peak_rss_scope"] == "process"


def test_peak_rss_is_none_without_resource_module(monkeypatch) -> None:
    assert isinstance(bfa._peak_rss_mb(), float)
    monkeypatch.setitem(sys.modules, "resource", None)
    assert bfa._peak_rss_mb() is None


def test_run_suite_end_to_end_with_fakes(tmp_path) -> None:
    gold_path = SYNTH / "tones.gold.json"
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))

    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=gold_path, words=None, clip=None
    )

    def fake_native(audio_path, model):
        return {"words": prediction["words"], "provenance": prediction["provenance"]}

    model_dir = tmp_path / "model"
    model_dir.mkdir()
    _vocab_json(model_dir / "vocab.json", {"<pad>": 0, "|": 1, "A": 2})
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "A": 2})

    def backend_factory(candidate, resolved_dir, threads):
        return FakeBackend(vocab, {}, frames=1, vocab_size=3)

    candidates = bfa.load_candidates(labels=["onnx-base"])
    runs_dir = tmp_path / "runs"

    summary = bfa.run_suite(
        [item],
        candidates,
        runs_dir=runs_dir,
        target="synthetic",
        model_dirs={"onnx-base": model_dir},
        backend_factory=backend_factory,
        native=fake_native,
    )

    assert (runs_dir / "tones.native.json").exists()
    assert (runs_dir / "tones.onnx-base.pred.json").exists()
    assert (runs_dir / "tones.onnx-base.report.json").exists()
    assert (runs_dir / "tones.agree.json").exists()
    assert (runs_dir / "summary.json").exists()
    assert summary["scored"]["onnx-base"]["items"] == 1


def test_run_suite_releases_each_backend_before_the_next(tmp_path) -> None:
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )

    def fake_native(audio_path, model):
        return {"words": prediction["words"], "provenance": prediction["provenance"]}

    model_dir = tmp_path / "model"
    model_dir.mkdir()
    _vocab_json(model_dir / "vocab.json", {"<pad>": 0, "|": 1, "A": 2})
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "A": 2})
    refs: list[weakref.ref] = []

    def backend_factory(candidate, resolved_dir, threads):
        assert all(ref() is None for ref in refs)
        backend = FakeBackend(vocab, {}, frames=1, vocab_size=3)
        refs.append(weakref.ref(backend))
        return backend

    labels = ["onnx-base", "onnx-base-int8"]
    bfa.run_suite(
        [item],
        bfa.load_candidates(labels=labels),
        runs_dir=tmp_path / "runs",
        model_dirs={label: model_dir for label in labels},
        backend_factory=backend_factory,
        native=fake_native,
    )

    assert len(refs) == 2


def test_run_suite_drops_zero_duration_native_words(tmp_path) -> None:
    gold_path = SYNTH / "tones.gold.json"
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))
    words = list(prediction["words"])
    words.insert(3, {"text": "uh", "start": 1.0, "end": 1.0})

    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=gold_path, words=None, clip=None
    )

    def fake_native(audio_path, model):
        return {"words": words, "provenance": prediction["provenance"]}

    model_dir = tmp_path / "model"
    model_dir.mkdir()
    _vocab_json(model_dir / "vocab.json", {"<pad>": 0, "|": 1, "A": 2})
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "A": 2})

    def backend_factory(candidate, resolved_dir, threads):
        return FakeBackend(vocab, {}, frames=1, vocab_size=3)

    runs_dir = tmp_path / "runs"
    labels = ["onnx-base", "onnx-base-int8"]
    summary = bfa.run_suite(
        [item],
        bfa.load_candidates(labels=labels),
        runs_dir=runs_dir,
        target="synthetic",
        model_dirs={label: model_dir for label in labels},
        backend_factory=backend_factory,
        native=fake_native,
    )

    pred = json.loads((runs_dir / "tones.onnx-base.pred.json").read_text(encoding="utf-8"))
    assert "uh" not in [w["text"] for w in pred["words"]]
    assert pred["provenance"]["alignment_stats"]["dropped_zero_duration"] == 1
    report = json.loads((runs_dir / "tones.onnx-base.report.json").read_text(encoding="utf-8"))
    assert report["metrics"]["boundary_mae_ms"] == pytest.approx(45.0)
    assert summary["agreement"]["onnx-base"]["matched_words"] == 5
    agree = json.loads((runs_dir / "tones.agree.json").read_text(encoding="utf-8"))
    assert agree["comparisons"]["onnx-base"]["dropped_zero_duration"] == {
        "reference": 1,
        "prediction": 1,
    }
    # Pairwise candidate~candidate: both sides are harness preds that already
    # dropped the zero-duration word upstream, so each side reports it once.
    assert agree["comparisons"]["onnx-base~onnx-base-int8"]["dropped_zero_duration"] == {
        "reference": 1,
        "prediction": 1,
    }


def test_aggregate_weights_by_matched_words() -> None:
    reports = [
        {
            "metrics": {
                "matched_words": 1,
                "reference_words": 1,
                "words_over_150ms": 0,
                "boundary_mae_ms": 10.0,
                "mean_start_error_ms": 0.0,
                "mean_end_error_ms": 0.0,
            },
            "provenance": {},
        },
        {
            "metrics": {
                "matched_words": 3,
                "reference_words": 3,
                "words_over_150ms": 0,
                "boundary_mae_ms": 50.0,
                "mean_start_error_ms": 0.0,
                "mean_end_error_ms": 0.0,
            },
            "provenance": {},
        },
    ]

    result = bfa.aggregate(reports)
    assert result["boundary_mae_ms"] == pytest.approx(40.0)


def test_aggregate_runtime_is_all_or_nothing() -> None:
    metrics = {
        "matched_words": 1,
        "reference_words": 1,
        "words_over_150ms": 0,
        "boundary_mae_ms": 10.0,
        "mean_start_error_ms": 0.0,
        "mean_end_error_ms": 0.0,
    }
    timed = {"metrics": metrics, "provenance": {"runtime_sec": 1.0, "audio_sec": 4.0}}
    untimed = {"metrics": metrics, "provenance": {"runtime_sec": 2.0}}

    both = bfa.aggregate([timed, timed])
    assert both["runtime_sec"] == pytest.approx(2.0)
    assert both["audio_sec"] == pytest.approx(8.0)
    assert both["realtime_factor"] == pytest.approx(0.25)

    mixed = bfa.aggregate([timed, untimed])
    assert mixed["runtime_sec"] is None
    assert mixed["audio_sec"] is None
    assert mixed["realtime_factor"] is None
    assert mixed["boundary_mae_ms"] == pytest.approx(10.0)


def test_native_prediction_provenance_is_prediction_compatible(monkeypatch) -> None:
    bw = load_script("benchmark_word_boundaries")

    class Stub:
        def __init__(self, model_size: str) -> None:
            self.model_size = model_size

        def transcribe_file(self, path):
            return SimpleNamespace(
                words=[
                    SimpleNamespace(text="one", start=0.0, end=0.2),
                    SimpleNamespace(text="two", start=0.2, end=0.4),
                ]
            )

    monkeypatch.setattr(bw, "TranscriptionEngine", Stub)

    result = bw.native_prediction(Path("unused.wav"), "base")

    assert [w["text"] for w in result["words"]] == ["one", "two"]
    provenance = result["provenance"]
    assert provenance["model"] and provenance["version"] and provenance["license"]
    assert isinstance(provenance["settings"], dict)
    assert provenance["runtime_sec"] >= 0


def test_main_plan_and_download_commands_print_json(capsys) -> None:
    assert bfa.main(["plan", "--target", "librispeech"]) == 0
    printed = capsys.readouterr().out
    items = json.loads(printed)
    assert len(items) == 3

    assert bfa.main(["download-commands"]) == 0
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 3


class _FakeAligner:
    """Stands in for ``WordAligner``: same ``.align`` signature, no ONNX runtime."""

    def __init__(self, spans, stats, runtime_sec: float = 0.02) -> None:
        self.model = SimpleNamespace(hf_repo="fake/repo", revision="deadbeef", onnx_file="m.onnx")
        self.calls = 0
        self._spans = spans
        self._stats = stats
        self._runtime_sec = runtime_sec

    def align(self, audio_path, words):
        from podcast_mcp.engines.word_align import WordAlignResult

        self.calls += 1
        return WordAlignResult(list(self._spans), self._stats, self._runtime_sec)


def _retime_stats(**overrides):
    from podcast_mcp.engines.ctc_forced_align import RetimeStats

    defaults = {"windows": 1, "failed_windows": 0, "aligned_words": 0, "unaligned_words": 0}
    return RetimeStats(**{**defaults, **overrides})


def test_pipeline_prediction_retimes_words_and_drops_zero_duration() -> None:
    """#715 T4: pipeline_prediction drives WordAligner.align + apply_word_spans."""
    words = [
        {"text": "hi", "start": 0.0, "end": 0.5},
        {"text": "uh", "start": 0.5, "end": 0.5},  # zero-duration: dropped after retiming
        {"text": "bye", "start": 0.5, "end": 1.0},
    ]
    aligner = _FakeAligner(
        spans=[(0.1, 0.3), (0.5, 0.5), (0.6, 0.9)],
        stats=_retime_stats(aligned_words=3),
        runtime_sec=0.02,
    )

    output, stats, runtime_sec = bfa.pipeline_prediction(Path("clip.wav"), words, aligner)

    assert [w["text"] for w in output] == ["hi", "bye"]
    assert output[0]["start"] == pytest.approx(0.1)
    assert output[0]["end"] == pytest.approx(0.3)
    assert output[0]["aligned"] is True
    assert output[1]["start"] == pytest.approx(0.6)
    assert output[1]["end"] == pytest.approx(0.9)
    assert stats["aligned_words"] == 3
    assert stats["dropped_zero_duration"] == 1
    assert runtime_sec == pytest.approx(0.02)
    assert aligner.calls == 1


def test_pipeline_prediction_clamps_unaligned_word_between_aligned_neighbours() -> None:
    """#715 T5: an unaligned word keeps Whisper's times, clamped between its retimed neighbours."""
    words = [
        {"text": "a", "start": 0.0, "end": 0.3},
        {"text": "b", "start": 0.3, "end": 0.6},
        {"text": "c", "start": 0.6, "end": 0.9},
    ]
    aligner = _FakeAligner(
        spans=[(0.1, 0.4), None, (0.5, 0.8)],
        stats=_retime_stats(aligned_words=2, unaligned_words=1),
    )

    output, stats, _ = bfa.pipeline_prediction(Path("clip.wav"), words, aligner)

    b = output[1]
    assert (b["start"], b["end"]) == pytest.approx((0.4, 0.5))
    assert b["aligned"] is False
    assert stats["unaligned_words"] == 1
    assert stats["dropped_zero_duration"] == 0


def test_main_pipeline_dispatches_to_run_pipeline_pass(monkeypatch, tmp_path) -> None:
    """#715 T5b: the ``pipeline`` subcommand resolves the target and calls run_pipeline_pass."""
    calls: list[dict] = []

    def fake_run_pipeline_pass(items, **kwargs):
        calls.append({"items": items, **kwargs})
        return {"target": kwargs["target"]}

    monkeypatch.setattr(bfa, "run_pipeline_pass", fake_run_pipeline_pass)

    runs_dir = tmp_path / "runs"
    assert (
        bfa.main(
            [
                "pipeline",
                "--target",
                "librispeech",
                "--runs-dir",
                str(runs_dir),
                "--threads",
                "2",
            ]
        )
        == 0
    )

    assert len(calls) == 1
    assert calls[0]["target"] == "librispeech"
    assert calls[0]["runs_dir"] == runs_dir
    assert calls[0]["threads"] == 2
    assert len(calls[0]["items"]) == 3


@pytest.mark.parametrize("error", [ValueError("native words mismatch"), TimeoutError("lock held")])
def test_main_reports_refusals_without_a_traceback(monkeypatch, tmp_path, capsys, error) -> None:
    """#715: a cache/lock refusal prints one error line and exits 2."""

    def refuse(items, **kwargs):
        raise error

    monkeypatch.setattr(bfa, "run_pipeline_pass", refuse)
    code = bfa.main(["pipeline", "--target", "librispeech", "--runs-dir", str(tmp_path / "runs")])
    assert code == 2
    assert capsys.readouterr().err == f"error: {error}\n"


def test_prepare_items_reuses_cached_native_words(tmp_path) -> None:
    """#715: a second pass into the same runs dir reuses <id>.native.json instead of re-running Whisper."""
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    calls: list[str] = []

    def fake_native(audio_path, model):
        calls.append(model)
        return {
            "words": prediction["words"],
            "provenance": {**prediction["provenance"], "model": model, "runtime_sec": 1.5},
        }

    runs_dir = tmp_path / "runs"
    _, first = bfa.prepare_items([item], runs_dir=runs_dir, native=fake_native)
    _, second = bfa.prepare_items([item], runs_dir=runs_dir, native=fake_native)
    assert calls == ["base"]
    assert second["tones"] == first["tones"]

    # A cached file for different audio is stale: re-run Whisper and overwrite it.
    native_path = runs_dir / "tones.native.json"
    stale = json.loads(native_path.read_text(encoding="utf-8"))
    native_path.write_text(json.dumps({**stale, "audio_sha256": "0" * 64}), encoding="utf-8")
    bfa.prepare_items([item], runs_dir=runs_dir, native=fake_native)
    assert calls == ["base", "base"]


def test_prepare_items_refuses_to_overwrite_native_words_from_another_model(tmp_path) -> None:
    """#715: a --native-model mismatch in a shared runs dir raises instead of re-pairing preds."""
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    calls: list[str] = []
    fake_native = _tones_native(calls)
    runs_dir = tmp_path / "runs"
    bfa.prepare_items([item], runs_dir=runs_dir, native_model="small", native=fake_native)
    native_path = runs_dir / "tones.native.json"
    before = native_path.read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="Whisper model 'small', not 'base'"):
        bfa.prepare_items([item], runs_dir=runs_dir, native=fake_native)
    assert calls == ["small"]
    assert native_path.read_text(encoding="utf-8") == before


def test_prepare_items_refuses_cached_native_words_without_a_model(tmp_path) -> None:
    """#715: a cached file for this audio with no provenance.model raises a usable message."""
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    calls: list[str] = []
    runs_dir = tmp_path / "runs"
    bfa.prepare_items([item], runs_dir=runs_dir, native=_tones_native(calls))
    native_path = runs_dir / "tones.native.json"
    payload = json.loads(native_path.read_text(encoding="utf-8"))
    del payload["provenance"]["model"]
    native_path.write_text(json.dumps(payload), encoding="utf-8")
    before = native_path.read_text(encoding="utf-8")

    with pytest.raises(ValueError, match=r"no provenance\.model") as excinfo:
        bfa.prepare_items([item], runs_dir=runs_dir, native=_tones_native(calls))
    assert "--native-model" not in str(excinfo.value)
    assert calls == ["base"]
    assert native_path.read_text(encoding="utf-8") == before


def test_prepare_items_checks_cached_faster_whisper_version(tmp_path) -> None:
    """#715: cached faster-whisper words are reused only under the installed version."""
    from importlib.metadata import version

    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    calls: list[str] = []

    def whisper_native(library_version):
        def fake_native(audio_path, model):
            calls.append(model)
            return {
                "words": prediction["words"],
                "provenance": {
                    **prediction["provenance"],
                    "model": model,
                    "library": "faster-whisper",
                    "library_version": library_version,
                    "runtime_sec": 1.5,
                },
            }

        return fake_native

    installed = version("faster-whisper")
    current_dir = tmp_path / "current"
    bfa.prepare_items([item], runs_dir=current_dir, native=whisper_native(installed))
    bfa.prepare_items([item], runs_dir=current_dir, native=whisper_native(installed))
    assert calls == ["base"]

    stale_dir = tmp_path / "stale"
    bfa.prepare_items([item], runs_dir=stale_dir, native=whisper_native("0.0.0-stale"))
    with pytest.raises(ValueError, match=re.escape("faster-whisper 0.0.0-stale")):
        bfa.prepare_items([item], runs_dir=stale_dir, native=whisper_native(installed))
    assert calls == ["base", "base"]


def test_prepare_items_checks_any_recorded_native_library(tmp_path) -> None:
    """#715: the version guard applies to whatever library the cached words name."""
    from importlib.metadata import version

    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    calls: list[str] = []
    inner = _tones_native(calls)

    def library_native(library, library_version):
        def fake_native(audio_path, model):
            payload = inner(audio_path, model)
            payload["provenance"].update(library=library, library_version=library_version)
            return payload

        return fake_native

    numpy_version = version("numpy")
    same_dir = tmp_path / "same"
    bfa.prepare_items([item], runs_dir=same_dir, native=library_native("numpy", numpy_version))
    bfa.prepare_items([item], runs_dir=same_dir, native=library_native("numpy", numpy_version))
    assert calls == ["base"]

    stale_dir = tmp_path / "stale"
    bfa.prepare_items([item], runs_dir=stale_dir, native=library_native("numpy", "0.0.0"))
    with pytest.raises(
        ValueError, match=re.escape(f"numpy 0.0.0, but {numpy_version} is installed")
    ):
        bfa.prepare_items([item], runs_dir=stale_dir, native=library_native("numpy", numpy_version))

    missing_dir = tmp_path / "missing"
    gone = "sharecut-no-such-native-backend"
    bfa.prepare_items([item], runs_dir=missing_dir, native=library_native(gone, "1.0"))
    with pytest.raises(ValueError, match="it is not installed"):
        bfa.prepare_items([item], runs_dir=missing_dir, native=library_native(gone, "1.0"))
    assert calls == ["base", "base", "base"]


def test_prepare_items_holds_the_native_lock_while_resolving(tmp_path) -> None:
    """#715: the cache check, Whisper run and write happen under <id>.native.lock."""
    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    runs_dir = tmp_path / "runs"
    lock_path = runs_dir / "tones.native.lock"
    held: list[bool] = []
    inner = _tones_native()

    def fake_native(audio_path, model):
        held.append(shared_file_lock(lock_path).is_locked)
        return inner(audio_path, model)

    bfa.prepare_items([item], runs_dir=runs_dir, native=fake_native)
    assert held == [True]
    assert not shared_file_lock(lock_path).is_locked


def test_prepare_items_waits_for_another_pass_holding_the_native_lock(
    tmp_path, monkeypatch
) -> None:
    """#715: a pass whose item lock is held elsewhere times out without running Whisper."""
    from filelock import FileLock

    item = bfa.BenchItem(
        item_id="tones", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    monkeypatch.setattr(bfa, "NATIVE_CACHE_LOCK_TIMEOUT_SEC", 0.05)
    calls: list[str] = []
    other_pass = FileLock(str(runs_dir / "tones.native.lock"))
    with other_pass, pytest.raises(TimeoutError):
        bfa.prepare_items([item], runs_dir=runs_dir, native=_tones_native(calls))
    assert calls == []
    assert not (runs_dir / "tones.native.json").exists()


def _tones_native(calls: list[str] | None = None):
    prediction = json.loads((SYNTH / "tones.prediction.json").read_text(encoding="utf-8"))

    def fake_native(audio_path, model):
        if calls is not None:
            calls.append(model)
        return {
            "words": prediction["words"],
            "provenance": {**prediction["provenance"], "model": model, "runtime_sec": 1.5},
        }

    return fake_native


# tones.prediction.json has 5 words (one, two, um, three, four); these spans put
# one/two/three/four exactly on tones.gold.json, so the scored MAE is 0.
_TONES_SPANS = [(0.2, 0.5), (0.6, 0.9), (0.92, 0.98), (1.0, 1.4), (1.5, 1.8)]


def test_run_pipeline_pass_end_to_end_with_fakes(tmp_path) -> None:
    """#715: run_pipeline_pass writes preds/reports/summary and aggregates scored + agreement."""
    gold = bfa.BenchItem(
        item_id="tones",
        audio=SYNTH / "tones.wav",
        gold=SYNTH / "tones.gold.json",
        words=None,
        clip=None,
    )
    agree_only = bfa.BenchItem(
        item_id="tones-agree", audio=SYNTH / "tones.wav", gold=None, words=None, clip=None
    )
    aligner = _FakeAligner(
        spans=_TONES_SPANS, stats=_retime_stats(aligned_words=5), runtime_sec=0.02
    )
    runs_dir = tmp_path / "runs"

    summary = bfa.run_pipeline_pass(
        [gold, agree_only],
        runs_dir=runs_dir,
        target="synthetic",
        aligner=aligner,
        native=_tones_native(),
    )

    label = bfa.PIPELINE_LABEL
    assert (runs_dir / f"tones.{label}.pred.json").exists()
    assert (runs_dir / f"tones.{label}.report.json").exists()
    assert (runs_dir / f"tones-agree.{label}.pred.json").exists()
    assert not (runs_dir / f"tones-agree.{label}.report.json").exists()
    assert (runs_dir / "tones.native.json").exists()
    assert not (runs_dir / "summary.json").exists()
    written = json.loads((runs_dir / bfa.PIPELINE_SUMMARY).read_text(encoding="utf-8"))
    assert written == json.loads(json.dumps(summary))

    pred = json.loads((runs_dir / f"tones.{label}.pred.json").read_text(encoding="utf-8"))
    assert pred["provenance"]["settings"]["pass"] == bfa.PIPELINE_PASS

    assert aligner.calls == 2
    assert summary["label"] == label
    assert summary["items"] == ["tones", "tones-agree"]
    assert summary["scored"]["items"] == 1
    assert summary["scored"]["matched_words"] == 4
    assert summary["scored"]["reference_words"] == 5
    assert summary["scored"]["boundary_mae_ms"] == pytest.approx(0.0, abs=1e-6)
    assert summary["agreement"]["items"] == 2
    assert summary["asr_runtime_sec"] == pytest.approx(3.0)
    assert summary["align_runtime_sec"] == pytest.approx(0.04)
    assert set(summary["duration_profile"]) == {"tones", "tones-agree"}
    profile = summary["duration_profile"]["tones"]
    assert profile["words"] == 5
    assert profile["max_sec"] == pytest.approx(0.4)
    assert profile["over_sec"]["1.00"] == 0


def test_run_pipeline_pass_after_run_suite_shares_native_words_and_keeps_summary(tmp_path) -> None:
    """#715: run then pipeline into one runs dir run Whisper once and keep both summaries."""
    item = bfa.BenchItem(
        item_id="tones",
        audio=SYNTH / "tones.wav",
        gold=SYNTH / "tones.gold.json",
        words=None,
        clip=None,
    )
    calls: list[str] = []
    fake_native = _tones_native(calls)
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    _vocab_json(model_dir / "vocab.json", {"<pad>": 0, "|": 1, "A": 2})
    vocab = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "A": 2})
    runs_dir = tmp_path / "runs"

    def backend_factory(candidate, resolved_dir, threads):
        return FakeBackend(vocab, {}, frames=1, vocab_size=3)

    bfa.run_suite(
        [item],
        bfa.load_candidates(labels=["onnx-base"]),
        runs_dir=runs_dir,
        target="synthetic",
        model_dirs={"onnx-base": model_dir},
        backend_factory=backend_factory,
        native=fake_native,
    )
    bfa.run_pipeline_pass(
        [item],
        runs_dir=runs_dir,
        target="synthetic",
        aligner=_FakeAligner(spans=_TONES_SPANS, stats=_retime_stats(aligned_words=5)),
        native=fake_native,
    )

    assert calls == ["base"]
    run_summary = json.loads((runs_dir / "summary.json").read_text(encoding="utf-8"))
    assert set(run_summary["scored"]) == {"onnx-base"}
    assert (runs_dir / bfa.PIPELINE_SUMMARY).exists()
