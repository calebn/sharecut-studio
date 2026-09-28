from __future__ import annotations

import json
import sys
import wave
import weakref
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.engines.ctc_forced_align import CtcVocab, log_softmax
from script_loader import load_script

FIXTURES = Path(__file__).parent / "fixtures"
WORD_BOUNDARY = FIXTURES / "word_boundary"
SYNTH = FIXTURES / "word_boundary_synthetic"

bfa = load_script("benchmark_forced_aligners", register=True)


def _vocab_json(path: Path, token_map: dict[str, int]) -> None:
    path.write_text(json.dumps(token_map), encoding="utf-8")


class FakeBackend:
    """Deterministic backend: fixed logits regardless of the sample chunk."""

    def __init__(self, vocab: CtcVocab, hot: dict[int, int], frames: int, vocab_size: int) -> None:
        self._vocab = vocab
        self._hot = hot
        self._frames = frames
        self._vocab_size = vocab_size

    def log_probs(self, samples: np.ndarray) -> np.ndarray:
        lp = np.full((self._frames, self._vocab_size), np.log(0.01))
        lp[:, self._vocab.blank_id] = np.log(0.9)
        for frame, token in self._hot.items():
            lp[frame, :] = np.log(0.01)
            lp[frame, token] = np.log(0.9)
        return log_softmax(lp)


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


def _fake_hub(candidate, *, sha=None, license=None, files=None, error=None):
    info = SimpleNamespace(
        sha=sha or candidate.revision,
        card_data=SimpleNamespace(license=license or candidate.license),
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


def test_verify_candidate_ignores_undeclared_card_license() -> None:
    """An unset model-card license (None) is not drift: the pin may still be correct,
    the Hub just never recorded a license for that repo."""
    candidate = bfa.load_candidates(labels=["onnx-base"])[0]
    # _fake_hub falls back to candidate.license when license= is falsy, so build the
    # card_data by hand to force an explicit None (undeclared license upstream).
    info = SimpleNamespace(
        sha=candidate.revision,
        card_data=SimpleNamespace(license=None),
        siblings=[
            SimpleNamespace(rfilename=name)
            for name in ["vocab.json", "config.json", "preprocessor_config.json", "onnx/model.onnx"]
        ],
    )
    hub = SimpleNamespace(model_info=lambda repo, revision: info)
    assert bfa.verify_candidate(candidate, hub) == []


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


def test_onnx_backend_names_missing_onnxruntime(monkeypatch, tmp_path) -> None:
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    with pytest.raises(RuntimeError, match="onnxruntime"):
        bfa.OnnxBackend(tmp_path, "onnx/model.onnx", 1)


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
