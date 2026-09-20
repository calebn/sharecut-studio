from __future__ import annotations

import importlib.util
import json
import shutil
import wave
from pathlib import Path

import pytest

from podcast_mcp.edits.pending_preview import PendingPreviewWindow
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EditDecision, EditDecisionType
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.golden_ear import (
    LISTEN_DIRNAME,
    bound_limit,
    build_golden_ear,
    copy_relocated_project,
    parse_classes,
    resolve_project_file,
    score_golden_ear,
    source_fingerprint,
)
from podcast_mcp.services.play import PlayResult, PlayService

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "aligned_dialogue"
SCRIPT = ROOT / "scripts" / "golden_ear_harness.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("golden_ear_harness", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _decision(
    *,
    edit_id: str = "e1",
    reason: str = "filler:um",
    applied: bool = False,
    dtype: EditDecisionType = EditDecisionType.REMOVE,
) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="reference",
        type=dtype,
        start=1.0,
        end=1.2,
        reason=reason,
        review_required=False,
        applied=applied,
    )


def _window(*, can_skip: bool = True) -> PendingPreviewWindow:
    return PendingPreviewWindow(
        edit_id="e1",
        timeline_start=1.0,
        timeline_end=1.2,
        play_start=0.0,
        play_end=3.2,
        can_skip=can_skip,
        skip_reason=None if can_skip else "too short",
    )


def _fixture_files() -> set[Path]:
    return {p.relative_to(FIXTURE) for p in FIXTURE.rglob("*") if p.is_file()}


def _shorten_wav(src: Path, dest: Path, seconds: float) -> None:
    with wave.open(str(src), "rb") as inn, wave.open(str(dest), "wb") as out:
        params = inn.getparams()
        out.setparams(params)
        out.writeframes(inn.readframes(int(params.framerate * seconds)))


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / float(handle.getframerate())


def _patch_harness(
    monkeypatch: pytest.MonkeyPatch,
    sample_wav: Path,
    decisions: list[EditDecision],
    *,
    can_skip: bool = True,
    join: dict | Exception | None = None,
    suggested_wav: Path | None = None,
) -> None:
    def propose(self, edit_mode: str | None = None):
        self.ws.project.edit_decisions = list(decisions)
        return list(decisions)

    def preview(self, edit_id: str, *, mode: str = "suggested", pad_sec: float = 0.5, **kwargs):
        dest = Path(self.project.workspace_dir) / "artifacts" / f"{edit_id}_{mode}.wav"
        dest.parent.mkdir(parents=True, exist_ok=True)
        src = suggested_wav if mode == "suggested" and suggested_wav is not None else sample_wav
        dest.write_bytes(src.read_bytes())
        return PlayResult(
            wav_path=dest,
            player_cmd=None,
            source_label=f"pending:{mode}",
            start_sec=0.0,
            end_sec=pad_sec * 2,
            tier="pending",
        )

    def join_quality(self, **kwargs):
        if isinstance(join, Exception):
            raise join
        return dict(join or {"verdict": "pass", "risk": 0.12})

    monkeypatch.setattr(EditService, "propose_tighten", propose)
    monkeypatch.setattr(PlayService, "play_pending_preview", preview)
    monkeypatch.setattr(EditService, "join_quality", join_quality)
    monkeypatch.setattr(
        "podcast_mcp.services.golden_ear.resolve_pending_preview",
        lambda *args, **kwargs: _window(can_skip=can_skip),
    )


def test_parse_and_bound_helpers():
    assert parse_classes(None) == ("filler", "pause")
    assert parse_classes("filler") == ("filler",)
    assert parse_classes(["pause"]) == ("pause",)
    with pytest.raises(ValueError, match="at least one"):
        parse_classes("  , ")
    with pytest.raises(ValueError, match="unsupported"):
        parse_classes("hesitation")
    assert bound_limit(40) == 40
    with pytest.raises(ValueError, match="between"):
        bound_limit(0)
    with pytest.raises(ValueError, match="between"):
        bound_limit(501)
    with pytest.raises(FileNotFoundError):
        resolve_project_file(Path("/tmp/missing-golden-ear-project/episode.project.json"))


def test_copy_rejects_out_inside_source(tmp_path):
    with pytest.raises(ValueError, match="inside the source"):
        copy_relocated_project(FIXTURE, FIXTURE / "nested-out")
    dest = tmp_path / "ws"
    dest.mkdir()
    with pytest.raises(FileExistsError, match="without project file"):
        copy_relocated_project(FIXTURE, dest)


def test_copy_rejects_samefile_symlink(tmp_path):
    dest = tmp_path / "linked"
    dest.symlink_to(FIXTURE)
    with pytest.raises(ValueError, match="source project"):
        copy_relocated_project(FIXTURE, dest)


def test_copy_reuses_matching_fingerprint_and_refuses_mismatch(tmp_path):
    dest = tmp_path / "ws"
    first = copy_relocated_project(FIXTURE, dest)
    assert first.is_file()
    assert (dest / "artifacts" / "premix.wav").is_file() or not (
        FIXTURE / "artifacts" / "premix.wav"
    ).is_file()
    again = copy_relocated_project(FIXTURE, dest)
    assert again == first
    marker = dest / ".golden_ear_source.json"
    marker.write_text(json.dumps({"path": "other", "mtime_ns": 1, "size": 1}), encoding="utf-8")
    with pytest.raises(FileExistsError, match="different source fingerprint"):
        copy_relocated_project(FIXTURE, dest)
    assert source_fingerprint(FIXTURE / "episode.project.json")["size"] > 0


def test_build_on_aligned_dialogue_is_blinded_and_does_not_write_fixture(
    tmp_path, sample_wav, monkeypatch
):
    fixture_json = FIXTURE / "episode.project.json"
    before = fixture_json.read_bytes()
    mtime = fixture_json.stat().st_mtime_ns
    before_files = _fixture_files()
    _patch_harness(
        monkeypatch,
        sample_wav,
        [
            _decision(edit_id="e1", reason="filler:um"),
            _decision(edit_id="e2", reason="pause:1.4s"),
            _decision(edit_id="e3", reason="filler:uh"),
            _decision(edit_id="skip_applied", reason="filler:uh", applied=True),
            _decision(edit_id="skip_mute", reason="filler:um", dtype=EditDecisionType.MUTE),
        ],
    )
    out = tmp_path / "golden"
    result = build_golden_ear(
        FIXTURE,
        out,
        limit=2,
        classes="filler,pause",
        seed=0,
    )
    assert result["pair_count"] == 2
    workspace = Path(result["workspace"]).resolve()
    assert workspace == (out / "workspace").resolve()
    assert workspace != FIXTURE.resolve()
    assert FIXTURE.resolve() not in workspace.parents
    assert fixture_json.read_bytes() == before
    assert fixture_json.stat().st_mtime_ns == mtime
    assert _fixture_files() == before_files
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    manifest = json.loads((out / LISTEN_DIRNAME / "manifest.json").read_text(encoding="utf-8"))
    dumped = json.dumps(manifest)
    assert "edit_file" not in dumped
    assert "verdict" not in dumped
    assert "risk" not in dumped
    files = {row["edit_file"] for row in key["pairs"]}
    assert files <= {"1.wav", "2.wav"}
    listen = out / LISTEN_DIRNAME
    for index, row in enumerate(key["pairs"]):
        assert row["id"] == f"pair_{index:03d}"
        pair = listen / row["id"]
        assert (pair / "1.wav").is_file()
        assert (pair / "2.wav").is_file()
        assert row["edit_file"] != row["leave_file"]
        assert row["gated"] is True
    answers = (listen / "answers.csv").read_text(encoding="utf-8")
    assert answers.splitlines()[0] == "pair_id,prefer,leftover_consonant,notes"
    with pytest.raises(FileExistsError, match="non-empty"):
        build_golden_ear(FIXTURE, out, limit=2, seed=0)
    filled = listen / "answers.csv"
    filled.write_text(
        "pair_id,prefer,leftover_consonant,notes\npair_000,1,no,\n",
        encoding="utf-8",
    )
    with pytest.raises(FileExistsError, match="filled answers"):
        build_golden_ear(FIXTURE, out, limit=2, seed=0)
    again = build_golden_ear(FIXTURE, out, limit=2, seed=0, force=True)
    assert again["pair_count"] == 2
    filler_only = build_golden_ear(
        FIXTURE, tmp_path / "filler-only", limit=8, classes="filler", seed=0
    )
    assert filler_only["pair_count"] == 2


def test_build_skips_unsuggestable_and_records_join_error(tmp_path, sample_wav, monkeypatch):
    _patch_harness(
        monkeypatch,
        sample_wav,
        [_decision(edit_id="skip"), _decision(edit_id="keep")],
        can_skip=False,
        join=ValueError("no stem"),
    )
    out = tmp_path / "skip"
    result = build_golden_ear(FIXTURE, out, limit=1, seed=1)
    assert result["pair_count"] == 0
    assert result["skipped_unsuggestable"] == 2

    def maybe_skip(edit_id: str, **kwargs):
        return _window(can_skip=edit_id != "skip")

    _patch_harness(
        monkeypatch,
        sample_wav,
        [_decision(edit_id="skip"), _decision(edit_id="keep")],
        can_skip=True,
        join=ValueError("no stem"),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.golden_ear.resolve_pending_preview",
        lambda _project, edit_id, **kwargs: maybe_skip(edit_id),
    )
    out2 = tmp_path / "joinerr"
    built = build_golden_ear(FIXTURE, out2, limit=1, seed=2)
    assert built["pair_count"] == 1
    key = json.loads((out2 / "key.json").read_text(encoding="utf-8"))
    assert key["pairs"][0]["id"] == "pair_000"
    assert key["pairs"][0]["edit_id"] == "keep"
    assert key["pairs"][0]["join_quality"]["verdict"] == "error"
    assert key["pairs"][0]["gated"] is False


def test_build_pads_suggested_to_current_duration(tmp_path, sample_wav, monkeypatch):
    short = tmp_path / "short.wav"
    _shorten_wav(sample_wav, short, 0.4)
    _patch_harness(
        monkeypatch,
        sample_wav,
        [_decision()],
        suggested_wav=short,
    )
    out = tmp_path / "pad"
    result = build_golden_ear(FIXTURE, out, limit=1, seed=0)
    assert result["pair_count"] == 1
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    pair = out / LISTEN_DIRNAME / key["pairs"][0]["id"]
    leave = pair / key["pairs"][0]["leave_file"]
    edited = pair / key["pairs"][0]["edit_file"]
    assert abs(_wav_duration(leave) - _wav_duration(edited)) < 0.05


def test_score_math_pass_fail_and_script(tmp_path):
    harness = _load_script()

    key = {
        "limit": 2,
        "min_gated_n": 2,
        "pair_count": 3,
        "pairs": [
            {
                "id": "pair_000",
                "class": "filler",
                "gated": True,
                "edit_file": "1.wav",
                "leave_file": "2.wav",
            },
            {
                "id": "pair_001",
                "class": "filler",
                "gated": True,
                "edit_file": "2.wav",
                "leave_file": "1.wav",
            },
            {
                "id": "pair_002",
                "class": "pause",
                "gated": False,
                "edit_file": "1.wav",
                "leave_file": "2.wav",
            },
        ],
    }
    (tmp_path / "key.json").write_text(json.dumps(key), encoding="utf-8")
    answers = tmp_path / "answers.csv"
    answers.write_text(
        "\ufeffpair_id,prefer,leftover_consonant,notes\n"
        "pair_000,1,no,\n"
        "pair_000,2,yes,dup\n"
        "pair_001,2,no,\n"
        "pair_002,2,no,\n"
        "unknown,1,no,\n"
        ",1,no,\n",
        encoding="utf-8",
    )
    report = score_golden_ear(tmp_path, Path("answers.csv"))
    assert report["pass"] is True
    assert report["missing_n"] == 0
    assert report["pair_count"] == 3
    assert report["prefer_edit_gated"] == pytest.approx(1.0)
    assert report["per_class"]["filler"]["n"] == 2
    assert report["per_class"]["pause"]["prefer_edit"] == pytest.approx(0.0)

    answers.write_text(
        "pair_id,prefer,leftover_consonant,notes\n"
        "pair_000,1,yes,click\n"
        "pair_001,tie,no,\n"
        "pair_002,1,no,\n",
        encoding="utf-8",
    )
    failed = score_golden_ear(tmp_path, answers)
    assert failed["pass"] is False
    assert failed["leftover_consonant_fails"] == 1
    assert failed["prefer_edit_gated"] == pytest.approx(0.5)
    assert harness.main(["score", "--dir", str(tmp_path), "--answers", str(answers)]) == 1

    answers.write_text(
        "pair_id,prefer,leftover_consonant,notes\n"
        "pair_000,1,no,\n"
        "pair_001,,no,\n"
        "pair_002,edit,no,\n",
        encoding="utf-8",
    )
    incomplete = score_golden_ear(tmp_path, answers)
    assert incomplete["pass"] is False
    assert incomplete["missing_n"] == 2
    assert any("missing_n=" in reason for reason in incomplete["fail_reasons"])

    answers.write_text(
        "pair_id,prefer,leftover_consonant,notes\npair_000,1,,\npair_001,2,no,\npair_002,2,no,\n",
        encoding="utf-8",
    )
    blank_leftover = score_golden_ear(tmp_path, answers)
    assert blank_leftover["pass"] is False
    assert blank_leftover["leftover_consonant_fails"] == 1

    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "key.json").write_text(
        json.dumps({"pairs": [], "limit": 2, "min_gated_n": 2, "pair_count": 0}),
        encoding="utf-8",
    )
    (empty / "answers.csv").write_text(
        "pair_id,prefer,leftover_consonant,notes\n", encoding="utf-8"
    )
    none = score_golden_ear(empty, empty / "answers.csv")
    assert none["pass"] is False
    assert "no gated answers" in none["fail_reasons"]
    with pytest.raises(FileNotFoundError):
        score_golden_ear(tmp_path / "missing", answers)


def test_score_gated_floor(tmp_path):
    (tmp_path / "key.json").write_text(
        json.dumps(
            {
                "limit": 40,
                "min_gated_n": 2,
                "pair_count": 1,
                "pairs": [
                    {
                        "id": "pair_000",
                        "class": "filler",
                        "gated": True,
                        "edit_file": "1.wav",
                        "leave_file": "2.wav",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    answers = tmp_path / "answers.csv"
    answers.write_text(
        "pair_id,prefer,leftover_consonant,notes\npair_000,1,no,\n",
        encoding="utf-8",
    )
    report = score_golden_ear(tmp_path, answers)
    assert report["pass"] is False
    assert report["prefer_edit_gated"] == pytest.approx(1.0)
    assert any("min_gated_n" in reason for reason in report["fail_reasons"])


def test_script_build_invokes_service(tmp_path, monkeypatch):
    harness = _load_script()

    called: dict = {}

    def fake_build(project, out, **kwargs):
        called["project"] = Path(project)
        called["out"] = Path(out)
        called["limit"] = kwargs["limit"]
        called["classes"] = kwargs["classes"]
        called["seed"] = kwargs["seed"]
        called["force"] = kwargs["force"]
        return {"out_dir": str(out), "pair_count": 0, "skipped_unsuggestable": 0}

    monkeypatch.setattr(harness, "build_golden_ear", fake_build)
    dest = tmp_path / "out"
    code = harness.main(
        [
            "build",
            "--project",
            str(FIXTURE),
            "--out",
            str(dest),
            "--limit",
            "3",
            "--classes",
            "filler",
            "--seed",
            "9",
            "--force",
        ]
    )
    assert code == 0
    assert called["limit"] == 3
    assert called["classes"] == "filler"
    assert called["seed"] == 9
    assert called["project"] == FIXTURE
    assert called["out"] == dest
    assert called["force"] is True


def test_build_real_aligned_dialogue_smoke(tmp_path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    before_files = _fixture_files()
    out = tmp_path / "golden-real"
    result = build_golden_ear(FIXTURE, out, limit=1, seed=0, classes="filler,pause")
    workspace = Path(result["workspace"]).resolve()
    assert workspace == (out / "workspace").resolve()
    assert workspace != FIXTURE.resolve()
    assert _fixture_files() == before_files
    if result["pair_count"] == 0:
        pytest.skip("no suggestable tighten pairs on aligned_dialogue")
    pair = out / LISTEN_DIRNAME / "pair_000"
    assert (pair / "1.wav").is_file()
    assert (pair / "2.wav").is_file()
    assert abs(_wav_duration(pair / "1.wav") - _wav_duration(pair / "2.wav")) < 0.08
    assert (out / "key.json").is_file()
    assert not (out / LISTEN_DIRNAME / "key.json").exists()


def test_copy_premix_partial_and_project_symlink(tmp_path, sample_wav):
    src = tmp_path / "src"
    src.mkdir()
    shutil.copytree(FIXTURE, src, dirs_exist_ok=True)
    premix = src / "artifacts" / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    dest = tmp_path / "ws"
    partial = dest.with_name(dest.name + ".partial")
    partial.mkdir()
    (partial / "stale.txt").write_text("x", encoding="utf-8")
    copied = copy_relocated_project(src, dest)
    assert copied.is_file()
    assert (dest / "artifacts" / "premix.wav").is_file()
    linked = tmp_path / "linked-file"
    linked.mkdir()
    (linked / "episode.project.json").symlink_to(src / "episode.project.json")
    with pytest.raises(ValueError, match="source project"):
        copy_relocated_project(src, linked)


def test_pad_and_workspace_helpers(tmp_path, sample_wav, monkeypatch):
    from podcast_mcp.services.golden_ear import (
        _normalize_prefer,
        _out_has_content,
        _pad_edit_to_leave,
        _publish_pair_dir,
        _reuse_workspace,
        _wav_duration_sec,
        answers_have_preferences,
        min_gated_n_for,
    )

    assert _wav_duration_sec(tmp_path / "missing.wav") is None
    junk = tmp_path / "junk.wav"
    junk.write_text("not a wav", encoding="utf-8")
    assert _wav_duration_sec(junk) is None

    class _ZeroRate:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def getframerate(self):
            return 0

        def getnframes(self):
            return 10

    monkeypatch.setattr("podcast_mcp.services.golden_ear.wave.open", lambda *a, **k: _ZeroRate())
    assert _wav_duration_sec(sample_wav) is None
    monkeypatch.undo()
    assert min_gated_n_for(1) == 1
    assert answers_have_preferences(tmp_path / "nope.csv") is False
    empty = tmp_path / "empty-out"
    empty.mkdir()
    assert _out_has_content(empty) is False
    assert _out_has_content(tmp_path / "missing-out") is False
    assert _pad_edit_to_leave(junk, sample_wav) is True
    monkeypatch.setattr(FFmpegEngine, "check_available", lambda self: (False, "missing"))
    short = tmp_path / "short.wav"
    _shorten_wav(sample_wav, short, 0.3)
    assert _pad_edit_to_leave(sample_wav, short) is False
    monkeypatch.setattr(FFmpegEngine, "check_available", lambda self: (True, "ok"))

    def boom(self, *args, **kwargs):
        raise ValueError("pad fail")

    monkeypatch.setattr(FFmpegEngine, "pad_end_silence", boom)
    assert _pad_edit_to_leave(sample_wav, short) is False
    staging = tmp_path / "pair.partial"
    staging.mkdir()
    (staging / "1.wav").write_bytes(b"a")
    dest = tmp_path / "pair"
    dest.mkdir()
    (dest / "old.wav").write_bytes(b"b")
    _publish_pair_dir(staging, dest)
    assert (dest / "1.wav").is_file()
    assert not dest.joinpath("old.wav").exists()
    src_file = FIXTURE / "episode.project.json"
    assert _reuse_workspace(src_file, tmp_path / "no-ws", tmp_path / "dest-a") is None
    linked_ws = tmp_path / "sym-ws"
    linked_ws.symlink_to(FIXTURE)
    assert _reuse_workspace(src_file, linked_ws, tmp_path / "dest-b") is None
    alias = tmp_path / "alias-ws"
    alias.mkdir()
    (alias / "episode.project.json").symlink_to(src_file)
    assert _reuse_workspace(src_file, alias, tmp_path / "dest-alias") is None
    other = tmp_path / "other-ws"
    copy_relocated_project(FIXTURE, other)
    (other / ".golden_ear_source.json").write_text(
        json.dumps({"path": "nope", "mtime_ns": 1, "size": 1}), encoding="utf-8"
    )
    assert _reuse_workspace(src_file, other, tmp_path / "dest-c") is None
    good = tmp_path / "good-ws"
    copy_relocated_project(FIXTURE, good)
    existing_dest = tmp_path / "dest-d"
    existing_dest.mkdir()
    reused = _reuse_workspace(src_file, good, existing_dest)
    assert reused is not None
    assert reused.is_file()
    assert _normalize_prefer("1", {"edit_file": "x.wav", "leave_file": "y.wav"}) is None


def test_score_listens_for_answers_csv(tmp_path):
    (tmp_path / "key.json").write_text(
        json.dumps(
            {
                "limit": 2,
                "min_gated_n": 2,
                "pair_count": 2,
                "pairs": [
                    {
                        "id": "pair_000",
                        "class": "filler",
                        "gated": True,
                        "edit_file": "1.wav",
                        "leave_file": "2.wav",
                    },
                    {
                        "id": "pair_001",
                        "class": "filler",
                        "gated": True,
                        "edit_file": "1.wav",
                        "leave_file": "2.wav",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    listen = tmp_path / LISTEN_DIRNAME
    listen.mkdir()
    (listen / "answers.csv").write_text(
        "pair_id,prefer,leftover_consonant,notes\npair_000,1,no,\npair_001,1,no,\n",
        encoding="utf-8",
    )
    report = score_golden_ear(tmp_path, Path("answers.csv"))
    assert report["pass"] is True
    with pytest.raises(FileNotFoundError, match="answers file"):
        score_golden_ear(tmp_path, Path("missing.csv"))


def test_build_clears_leftover_staging(tmp_path, sample_wav, monkeypatch):
    _patch_harness(monkeypatch, sample_wav, [_decision()])
    out = tmp_path / "golden-stale"
    stale = tmp_path / ".golden-stale.staging"
    stale.mkdir()
    (stale / "junk").write_text("x", encoding="utf-8")
    old = tmp_path / ".golden-stale.old"
    old.mkdir()
    (old / "junk").write_text("y", encoding="utf-8")
    out.mkdir()
    (out / "stale.txt").write_text("z", encoding="utf-8")
    result = build_golden_ear(FIXTURE, out, limit=1, seed=0, force=True)
    assert result["pair_count"] == 1
    assert not stale.exists()
    assert not old.exists()


def test_render_clears_partial_and_skips_pad_failure(tmp_path, sample_wav, monkeypatch):
    import random

    from podcast_mcp.services.golden_ear import _render_pair_wavs

    class _Play:
        project = object()

        def play_pending_preview(self, *args, **kwargs):
            return PlayResult(
                wav_path=sample_wav,
                player_cmd=None,
                source_label="pending",
                start_sec=0.0,
                end_sec=1.0,
                tier="pending",
            )

    monkeypatch.setattr(
        "podcast_mcp.services.golden_ear.resolve_pending_preview",
        lambda *args, **kwargs: _window(),
    )
    pair_dir = tmp_path / "pair_000"
    partial = tmp_path / "pair_000.partial"
    partial.mkdir()
    (partial / "stale").write_text("x", encoding="utf-8")
    rendered = _render_pair_wavs(_Play(), _decision(), pair_dir, pad_sec=0.5, rng=random.Random(0))
    assert rendered is not None
    assert not partial.exists()
    monkeypatch.setattr(
        "podcast_mcp.services.golden_ear._pad_edit_to_leave", lambda *args, **kwargs: False
    )
    skipped_dir = tmp_path / "pair_001"
    skipped = _render_pair_wavs(
        _Play(), _decision(), skipped_dir, pad_sec=0.5, rng=random.Random(1)
    )
    assert skipped is None
    assert not skipped_dir.exists()
