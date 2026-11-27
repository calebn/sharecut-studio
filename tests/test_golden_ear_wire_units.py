"""Pin the helpers behind build_golden_ear and score_golden_ear, and the real harness script."""

from __future__ import annotations

import csv
import json
import random
import shutil
from types import SimpleNamespace

import pytest

import join_quality_fixtures
from golden_ear_wire_cases import SCORE
from golden_ear_wire_helpers import (
    FIXTURE_ROOT,
    Case,
    _apply_diagnostic_stubs,
    _error,
    dec,
    dump,
    run_score,
    run_script,
    standard_decisions,
)
from podcast_mcp.models import EditDecisionType
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document import golden_ear as ge
from podcast_mcp.services.document.golden_ear import (
    _candidate_decisions,
    _gated,
    _join_metrics,
    _normalize_leftover,
    _normalize_prefer,
    _out_has_content,
    _pair_audio_diagnostics,
    _pair_audition_context,
    _pair_id,
    _read_answers,
    _reason_class,
    _render_pair_wavs,
    _write_answers_template,
    answers_have_preferences,
    bound_limit,
    copy_relocated_project,
    min_gated_n_for,
    parse_classes,
    resolve_project_file,
    source_fingerprint,
)
from podcast_mcp.util.process import CalledProcessError
from test_golden_ear_harness import FIXTURE, _window

pytestmark = pytest.mark.unscoped_ok

ALL = ["filler", "pause", "repetition", "restart"]
CPE = "Command '['ffmpeg', '-i', 'x.wav']' returned non-zero exit status 1."


def outcome(fn, *args, **kwargs):
    try:
        return {"value": fn(*args, **kwargs)}
    except Exception as exc:
        return {"raised": _error(exc)}


def coded(code, message, kind="CodedValueError"):
    return {"raised": {"type": kind, "code": code, "message": message}}


REQUIRED = "classes must include at least one of filler, pause, repetition, restart"
UNSUPPORTED = "unsupported classes {!r}; use filler,pause,repetition,restart"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, {"value": ["filler", "pause", "repetition", "restart"]}),
        ("filler", {"value": ["filler"]}),
        ("Filler,PAUSE", {"value": ["filler", "pause"]}),
        (" restart , repetition ", {"value": ["restart", "repetition"]}),
        ("filler,filler", {"value": ["filler", "filler"]}),
        (("pause", "filler"), {"value": ["pause", "filler"]}),
        (["restart"], {"value": ["restart"]}),
        (["Pause", " "], {"value": ["pause"]}),
        ("", coded("golden_ear_classes_required", REQUIRED)),
        (" , ", coded("golden_ear_classes_required", REQUIRED)),
        ([], coded("golden_ear_classes_required", REQUIRED)),
        ((" ",), coded("golden_ear_classes_required", REQUIRED)),
        ("nope", coded("golden_ear_classes_unsupported", UNSUPPORTED.format(["nope"]))),
        (
            "filler,nope,x",
            coded("golden_ear_classes_unsupported", UNSUPPORTED.format(["nope", "x"])),
        ),
        ("Hesitation", coded("golden_ear_classes_unsupported", UNSUPPORTED.format(["hesitation"]))),
        ([1], coded("golden_ear_classes_unsupported", UNSUPPORTED.format(["1"]))),
    ],
)
def test_parse_classes_wire(raw, expected):
    result = outcome(parse_classes, raw)
    if "value" in result:
        result = {"value": list(result["value"])}
        assert type(parse_classes(raw)) is tuple
    assert dump(result) == dump(expected)


LIMIT_MSG = "limit must be between 1 and 500"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (1, {"value": 1}),
        (40, {"value": 40}),
        (500, {"value": 500}),
        ("7", {"value": 7}),
        (2.9, {"value": 2}),
        (True, {"value": 1}),
        (0, coded("golden_ear_limit_out_of_range", LIMIT_MSG)),
        (-1, coded("golden_ear_limit_out_of_range", LIMIT_MSG)),
        (501, coded("golden_ear_limit_out_of_range", LIMIT_MSG)),
        (0.9, coded("golden_ear_limit_out_of_range", LIMIT_MSG)),
        (
            "x",
            {
                "raised": {
                    "type": "ValueError",
                    "code": None,
                    "message": "invalid literal for int() with base 10: 'x'",
                }
            },
        ),
        (
            None,
            {
                "raised": {
                    "type": "TypeError",
                    "code": None,
                    "message": "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
                }
            },
        ),
    ],
)
def test_bound_limit_wire(raw, expected):
    assert dump(outcome(bound_limit, raw)) == dump(expected)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(0, 1), (1, 1), (1.9, 1), ("1", 1), (2, 2), (3, 2), (40, 2), (500, 2), (-4, 1)],
)
def test_min_gated_n_wire(raw, expected):
    assert dump(min_gated_n_for(raw)) == dump(expected)


def test_module_constants_wire():
    constants = {
        "DEFAULT_LIMIT": ge.DEFAULT_LIMIT,
        "MAX_LIMIT": ge.MAX_LIMIT,
        "DEFAULT_PAD_SEC": ge.DEFAULT_PAD_SEC,
        "ALLOWED_CLASSES": list(ge.ALLOWED_CLASSES),
        "PREFER_EDIT_GATED_MIN": ge.PREFER_EDIT_GATED_MIN,
        "GATED_N_FLOOR": ge.GATED_N_FLOOR,
        "ANSWERS_FIELDS": list(ge.ANSWERS_FIELDS),
        "LISTEN_DIRNAME": ge.LISTEN_DIRNAME,
        "SOURCE_FP_NAME": ge.SOURCE_FP_NAME,
    }
    assert dump(constants) == dump(
        {
            "DEFAULT_LIMIT": 40,
            "MAX_LIMIT": 500,
            "DEFAULT_PAD_SEC": 2.0,
            "ALLOWED_CLASSES": ["filler", "pause", "repetition", "restart"],
            "PREFER_EDIT_GATED_MIN": 0.9,
            "GATED_N_FLOOR": 2,
            "ANSWERS_FIELDS": ["pair_id", "prefer", "leftover_consonant", "notes"],
            "LISTEN_DIRNAME": "listen",
            "SOURCE_FP_NAME": ".golden_ear_source.json",
        }
    )


def test_source_fingerprint_wire(tmp_path):
    real = tmp_path / "real.sharecut"
    real.write_text("0123456789", encoding="utf-8")
    link = tmp_path / "link.sharecut"
    link.symlink_to(real)
    for given in (real, link):
        fp = source_fingerprint(given)
        stat = real.stat()
        assert list(fp) == ["path", "mtime_ns", "size"]
        assert dump(fp["path"]) == dump(str(real.resolve()))
        assert dump(fp["size"]) == dump(10)
        assert type(fp["mtime_ns"]) is int
        assert dump(fp["mtime_ns"]) == dump(stat.st_mtime_ns)


def test_source_fingerprint_missing_wire(tmp_path):
    result = outcome(source_fingerprint, tmp_path / "gone.sharecut")
    assert result["raised"]["type"] == "FileNotFoundError"
    assert result["raised"]["code"] is None


def test_source_fingerprint_tracks_content_size(tmp_path):
    path = tmp_path / "p.sharecut"
    path.write_text("a", encoding="utf-8")
    first = source_fingerprint(path)
    path.write_text("abcdef", encoding="utf-8")
    assert dump(source_fingerprint(path)["size"]) == dump(6)
    assert dump(first["size"]) == dump(1)


@pytest.mark.parametrize(
    ("reason", "classes", "expected"),
    [
        ("filler:um", ge.ALLOWED_CLASSES, "filler"),
        ("pause:1.4s", ge.ALLOWED_CLASSES, "pause"),
        ("repetition:a a", ge.ALLOWED_CLASSES, "repetition"),
        ("restart:so", ge.ALLOWED_CLASSES, "restart"),
        ("filler:um", ("pause",), None),
        ("Filler:um", ge.ALLOWED_CLASSES, None),
        ("filler", ge.ALLOWED_CLASSES, None),
        ("filler:", ge.ALLOWED_CLASSES, "filler"),
        (" filler:um", ge.ALLOWED_CLASSES, None),
        ("", ge.ALLOWED_CLASSES, None),
        (None, ge.ALLOWED_CLASSES, None),
        ("pause:1", ("filler", "pause"), "pause"),
        ("pause:1", (), None),
    ],
)
def test_reason_class_wire(reason, classes, expected):
    assert dump(_reason_class(reason, classes)) == dump(expected)


@pytest.mark.parametrize(
    ("report", "expected"),
    [
        ({"verdict": "pass"}, True),
        ({"verdict": "review"}, False),
        ({"verdict": "fail"}, False),
        ({"verdict": "error", "error": "x"}, False),
        ({"verdict": None}, False),
        ({"verdict": "PASS"}, False),
        ({"verdict": " pass"}, False),
        ({}, False),
    ],
)
def test_gated_wire(report, expected):
    assert dump(_gated(report)) == dump(expected)


@pytest.mark.parametrize(
    ("index", "expected"),
    [(0, "pair_000"), (7, "pair_007"), (42, "pair_042"), (999, "pair_999"), (1000, "pair_1000")],
)
def test_pair_id_wire(index, expected):
    assert dump(_pair_id(index)) == dump(expected)


def test_candidate_decisions_wire():
    decisions = [
        *standard_decisions(),
        dec("x1", "pause:2s", dtype="mute"),
        dec("x2", "Pause:2s"),
    ]
    assert dump([row.id for row in _candidate_decisions(decisions, ge.ALLOWED_CLASSES)]) == dump(
        ["f1", "p1", "f2", "r1", "s1"]
    )
    assert dump([row.id for row in _candidate_decisions(decisions, ("pause",))]) == dump(["p1"])
    assert dump([row.id for row in _candidate_decisions(decisions, ())]) == dump([])
    assert dump([row.id for row in _candidate_decisions([], ge.ALLOWED_CLASSES)]) == dump([])
    kinds = {row.id: row.type for row in decisions}
    assert kinds["m1"] == EditDecisionType.MUTE


EDIT = {"edit_file": "1.wav", "leave_file": "2.wav"}


@pytest.mark.parametrize(
    ("raw", "meta", "expected"),
    [
        ("1", EDIT, "edit"),
        ("2", EDIT, "leave-in"),
        (" 1 ", EDIT, "edit"),
        ("3", EDIT, None),
        ("", EDIT, None),
        ("  ", EDIT, None),
        ("tie", EDIT, "tie"),
        ("TIE", EDIT, "tie"),
        ("Same", EDIT, "tie"),
        (" either ", EDIT, "tie"),
        ("e ither", EDIT, "tie"),
        ("t_ie", EDIT, None),
        ("edit", EDIT, None),
        ("leave-in", EDIT, None),
        ("leave_in", EDIT, None),
        ("1", {"edit_file": "x.wav", "leave_file": "y.wav"}, None),
        ("1", {}, None),
        ("2", {"edit_file": None, "leave_file": "2.wav"}, "leave-in"),
        ("1", {"edit_file": "2.wav", "leave_file": "1.wav"}, "leave-in"),
        ("2", {"edit_file": "2.wav", "leave_file": "1.wav"}, "edit"),
        ("1", {"edit_file": "1.wav", "leave_file": "1.wav"}, "edit"),
    ],
)
def test_normalize_prefer_wire(raw, meta, expected):
    assert dump(_normalize_prefer(raw, meta)) == dump(expected)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("yes", True),
        ("Y", True),
        (" TRUE ", True),
        ("1", True),
        ("no", False),
        ("N", False),
        ("false", False),
        ("0", False),
        ("", None),
        ("maybe", None),
        ("yes please", None),
        ("2", None),
    ],
)
def test_normalize_leftover_wire(raw, expected):
    assert dump(_normalize_leftover(raw)) == dump(expected)


ANSWER_FILES = {
    "plain": "pair_id,prefer,leftover_consonant,notes\npair_000,1,no,a\npair_001,2,yes,b\n",
    "bom": "﻿pair_id,prefer,leftover_consonant,notes\npair_000,1,no,a\n",
    "duplicates": "pair_id,prefer,leftover_consonant,notes\np,1,no,first\np,2,yes,second\n",
    "blank_ids": "pair_id,prefer,leftover_consonant,notes\n,1,no,a\n  ,1,no,b\nq,2,no,c\n",
    "padded_id": "pair_id,prefer,leftover_consonant,notes\n p ,1,no,a\n",
    "short_row": "pair_id,prefer,leftover_consonant,notes\np,1\n",
    "long_row": "pair_id,prefer\np,1,no,extra\n",
    "header_only": "pair_id,prefer,leftover_consonant,notes\n",
    "empty": "",
    "no_id_column": "prefer,leftover_consonant\n1,no\n",
}
ANSWER_ROWS = {
    "plain": {
        "pair_000": {
            "pair_id": "pair_000",
            "prefer": "1",
            "leftover_consonant": "no",
            "notes": "a",
        },
        "pair_001": {
            "pair_id": "pair_001",
            "prefer": "2",
            "leftover_consonant": "yes",
            "notes": "b",
        },
    },
    "bom": {
        "pair_000": {
            "pair_id": "pair_000",
            "prefer": "1",
            "leftover_consonant": "no",
            "notes": "a",
        }
    },
    "duplicates": {
        "p": {"pair_id": "p", "prefer": "1", "leftover_consonant": "no", "notes": "first"}
    },
    "blank_ids": {"q": {"pair_id": "q", "prefer": "2", "leftover_consonant": "no", "notes": "c"}},
    "padded_id": {"p": {"pair_id": " p ", "prefer": "1", "leftover_consonant": "no", "notes": "a"}},
    "short_row": {"p": {"pair_id": "p", "prefer": "1", "leftover_consonant": None, "notes": None}},
    "long_row": {"p": {"pair_id": "p", "prefer": "1", "None": ["no", "extra"]}},
    "header_only": {},
    "empty": {},
    "no_id_column": {},
}


@pytest.mark.parametrize("name", sorted(ANSWER_FILES))
def test_read_answers_wire(name, tmp_path):
    path = tmp_path / "answers.csv"
    path.write_bytes(ANSWER_FILES[name].encode("utf-8"))
    rows = _read_answers(path)
    shaped = {key: {str(k): v for k, v in row.items()} for key, row in rows.items()}
    assert list(rows) == list(ANSWER_ROWS[name])
    assert dump(shaped) == dump(ANSWER_ROWS[name])


def test_read_answers_missing_wire(tmp_path):
    result = outcome(_read_answers, tmp_path / "gone.csv")
    assert result["raised"]["type"] == "FileNotFoundError"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (None, False),
        ("pair_id,prefer\npair_000,\n", False),
        ("pair_id,prefer\npair_000,1\n", True),
        ("pair_id,prefer\npair_000,  \n", False),
        ("pair_id,prefer,notes\npair_000,,hello\n", False),
        ("﻿pair_id,prefer\npair_000,tie\n", True),
        ("pair_id,prefer\npair_000,\npair_001,2\n", True),
        ("pair_id\npair_000\n", False),
        ("", False),
    ],
)
def test_answers_have_preferences_wire(text, expected, tmp_path):
    path = tmp_path / "answers.csv"
    if text is not None:
        path.write_bytes(text.encode("utf-8"))
    assert dump(answers_have_preferences(path)) == dump(expected)


def test_answers_have_preferences_directory_wire(tmp_path):
    assert dump(answers_have_preferences(tmp_path)) == dump(False)


@pytest.mark.parametrize(
    ("ids", "expected"),
    [
        ([], b"pair_id,prefer,leftover_consonant,notes\r\n"),
        (
            ["pair_000", "pair_001"],
            b"pair_id,prefer,leftover_consonant,notes\r\npair_000,,,\r\npair_001,,,\r\n",
        ),
        (["a,b"], b'pair_id,prefer,leftover_consonant,notes\r\n"a,b",,,\r\n'),
    ],
)
def test_write_answers_template_wire(ids, expected, tmp_path):
    path = tmp_path / "deep" / "dir" / "answers.csv"
    _write_answers_template(path, ids)
    assert path.read_bytes() == expected
    with path.open(encoding="utf-8", newline="") as handle:
        assert [row["pair_id"] for row in csv.DictReader(handle)] == ids


def test_out_has_content_wire(tmp_path):
    missing = tmp_path / "missing"
    empty = tmp_path / "empty"
    empty.mkdir()
    full = tmp_path / "full"
    full.mkdir()
    (full / "x").write_text("x", encoding="utf-8")
    nested_empty = tmp_path / "nested"
    (nested_empty / "inner").mkdir(parents=True)
    got = [_out_has_content(p) for p in (missing, empty, full, nested_empty)]
    assert dump(got) == dump([False, False, True, True])
    plain = tmp_path / "plain"
    plain.write_text("x", encoding="utf-8")
    assert outcome(_out_has_content, plain)["raised"]["type"] == "NotADirectoryError"


def test_resolve_project_file_wire(tmp_path):
    missing = outcome(resolve_project_file, tmp_path / "missing")
    assert dump(missing) == dump(
        {
            "raised": {
                "type": "ValueError",
                "code": None,
                "message": "expected episode.sharecut, got 'missing'",
            }
        }
    )
    empty = tmp_path / "emptydir"
    empty.mkdir()
    result = outcome(resolve_project_file, empty)
    assert dump(result) == dump(
        {
            "raised": {
                "type": "CodedFileNotFoundError",
                "code": "project_not_found",
                "message": f"no episode.sharecut in {empty}",
            }
        }
    )
    found = resolve_project_file(FIXTURE)
    assert dump(str(found).replace(FIXTURE_ROOT, "<fixture>")) == dump("<fixture>/episode.sharecut")
    direct = resolve_project_file(FIXTURE / "episode.sharecut")
    assert dump(str(direct).replace(FIXTURE_ROOT, "<fixture>")) == dump(
        "<fixture>/episode.sharecut"
    )


def test_copy_relocated_project_errors_wire(tmp_path):
    src = tmp_path / "src"
    shutil.copytree(FIXTURE, src)
    root = {str(tmp_path.resolve()): "<tmp>", str(tmp_path): "<tmp>"}

    def err(dest):
        raised = outcome(copy_relocated_project, src, dest)["raised"]
        message = raised["message"]
        for path, token in root.items():
            message = message.replace(path, token)
        return {**raised, "message": message}

    inside = err(src / "nested")
    assert dump(inside) == dump(
        {
            "type": "CodedValueError",
            "code": "golden_ear_output_inside_source",
            "message": "output workspace must not be inside the source project",
        }
    )
    same = err(src)
    assert dump(same) == dump(
        {
            "type": "CodedValueError",
            "code": "golden_ear_output_is_source",
            "message": "output workspace must not be the source project",
        }
    )
    link = tmp_path / "link"
    link.symlink_to(src)
    assert dump(err(link)) == dump(same)
    bare = tmp_path / "bare"
    bare.mkdir()
    assert dump(err(bare)) == dump(
        {
            "type": "FileExistsError",
            "code": None,
            "message": "workspace exists without project file: <tmp>/bare",
        }
    )
    done = tmp_path / "done"
    copy_relocated_project(src, done)
    (done / ".golden_ear_source.json").write_text("{}", encoding="utf-8")
    assert dump(err(done)) == dump(
        {
            "type": "FileExistsError",
            "code": None,
            "message": "workspace exists with a different source fingerprint: <tmp>/done",
        }
    )


def test_copy_relocated_project_layout_wire(tmp_path):
    src = tmp_path / "src"
    shutil.copytree(FIXTURE, src)
    premix = src / "artifacts" / "premix.wav"
    premix.parent.mkdir(exist_ok=True)
    premix.write_bytes(b"RIFFpremix")
    (src / "artifacts" / "premix.hash").write_text("h1\n", encoding="utf-8")
    dest = tmp_path / "dest"
    project = copy_relocated_project(src, dest)
    assert dump(str(project.relative_to(tmp_path.resolve()))) == dump("dest/episode.sharecut")
    assert dump((dest / "artifacts" / "premix.wav").read_bytes().decode()) == dump("RIFFpremix")
    assert dump((dest / "artifacts" / "premix.hash").read_text(encoding="utf-8")) == dump("h1\n")
    marker = json.loads((dest / ".golden_ear_source.json").read_text(encoding="utf-8"))
    assert list(marker) == ["path", "mtime_ns", "size"]
    assert dump(marker["path"]) == dump(str((src / "episode.sharecut").resolve()))
    meta = json.loads(project.read_text(encoding="utf-8"))["meta"]
    assert dump(meta["workspace_dir"]) == dump(str(dest.resolve()))
    assert not (tmp_path / "dest.partial").exists()
    again = copy_relocated_project(src, dest)
    assert dump(str(again)) == dump(str(project))
    assert dump(sorted(p.name for p in tmp_path.iterdir())) == dump(["dest", "src"])


@pytest.fixture
def wavs(tmp_path, sample_wav):
    pair = tmp_path / "listen" / "pair_000"
    pair.mkdir(parents=True)
    shutil.copy2(sample_wav, pair / "1.wav")
    shutil.copy2(sample_wav, pair / "2.wav")
    return pair, {"leave_file": "1.wav", "edit_file": "2.wav"}, tmp_path / "diagnostics"


def diag_case(**kwargs):
    return Case(**kwargs)


def entry(file, **fields):
    return {"file": file, **fields}


def good(file, number=-3.0):
    return {
        "file": file,
        "astats": {"peak_level_db": number, "file": file},
        "hum": {"hum_detected": False},
        "waveform_png": f"diagnostics/pair_000/{'current' if file == '1.wav' else 'suggested'}.png",
    }


DIAG_EXPECTED = {
    "default": {
        "source": "rendered_pair_wavs",
        "current": good("1.wav"),
        "suggested": good("2.wav"),
    },
    "multi": {
        "source": "rendered_pair_wavs",
        "current": {
            **good("1.wav"),
            "astats": {
                "peak_level_db": -3.0,
                "rms_level_db": -20.25,
                "dc_offset": 0.0,
                "file": "1.wav",
            },
        },
        "suggested": {
            **good("2.wav"),
            "astats": {
                "peak_level_db": -3.0,
                "rms_level_db": -20.25,
                "dc_offset": 0.0,
                "file": "2.wav",
            },
        },
    },
    "none_metrics": {
        "source": "rendered_pair_wavs",
        "current": {
            **good("1.wav"),
            "astats": {"peak_level_db": None, "rms_level_db": None},
            "error": "astats unavailable: no metrics",
        },
        "suggested": {
            **good("2.wav"),
            "astats": {"peak_level_db": None, "rms_level_db": None},
            "error": "astats unavailable: no metrics",
        },
    },
    "empty": {
        "source": "rendered_pair_wavs",
        "current": {**good("1.wav"), "astats": {}, "error": "astats unavailable: no metrics"},
        "suggested": {**good("2.wav"), "astats": {}, "error": "astats unavailable: no metrics"},
    },
    "partial": {
        "source": "rendered_pair_wavs",
        "current": {**good("1.wav"), "astats": {"peak_level_db": -1.5, "rms_level_db": None}},
        "suggested": {**good("2.wav"), "astats": {"peak_level_db": -1.5, "rms_level_db": None}},
    },
    "raise_oserror": {
        "source": "rendered_pair_wavs",
        "current": {"file": "1.wav", "error": "OSError: disk gone"},
        "suggested": {"file": "2.wav", "error": "OSError: disk gone"},
    },
    "raise_valueerror": {
        "source": "rendered_pair_wavs",
        "current": {"file": "1.wav", "error": "ValueError: bad value"},
        "suggested": {"file": "2.wav", "error": "ValueError: bad value"},
    },
    "raise_cpe": {
        "source": "rendered_pair_wavs",
        "current": {"file": "1.wav", "error": f"CalledProcessError: {CPE}"},
        "suggested": {"file": "2.wav", "error": f"CalledProcessError: {CPE}"},
    },
    "raise_oserror_first": {
        "source": "rendered_pair_wavs",
        "current": {"file": "1.wav", "error": "OSError: disk gone"},
        "suggested": good("2.wav"),
    },
}


@pytest.mark.parametrize("mode", sorted(DIAG_EXPECTED))
def test_pair_audio_diagnostics_astats_wire(mode, wavs, monkeypatch):
    pair, names, diagnostics = wavs
    _apply_diagnostic_stubs(monkeypatch, diag_case(astats=mode), [])
    result = _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    assert dump(result) == dump(DIAG_EXPECTED[mode])
    assert list(result) == ["source", "current", "suggested"]


HUM = {"hum_detected": True, "hum_hz": 50.0, "harmonics": [50.0, 100.0]}


def test_pair_audio_diagnostics_hum_wire(wavs, monkeypatch):
    pair, names, diagnostics = wavs
    _apply_diagnostic_stubs(monkeypatch, diag_case(hum="detected"), [])
    result = _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    assert dump(result) == dump(
        {
            "source": "rendered_pair_wavs",
            "current": {**good("1.wav"), "hum": HUM},
            "suggested": {**good("2.wav"), "hum": HUM},
        }
    )
    assert list(result["current"]) == ["file", "astats", "hum", "waveform_png"]


@pytest.mark.parametrize(
    ("hum", "message"),
    [
        ("raise_oserror", "OSError: disk gone"),
        ("raise_valueerror", "ValueError: bad value"),
        ("raise_cpe", f"CalledProcessError: {CPE}"),
    ],
)
def test_pair_audio_diagnostics_hum_failure_wire(hum, message, wavs, monkeypatch):
    pair, names, diagnostics = wavs
    _apply_diagnostic_stubs(monkeypatch, diag_case(hum=hum), [])
    result = _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    expected = {
        "file": "1.wav",
        "astats": {"peak_level_db": -3.0, "file": "1.wav"},
        "error": message,
    }
    assert dump(result["current"]) == dump(expected)
    assert list(result["current"]) == ["file", "astats", "error"]
    assert not diagnostics.exists()


@pytest.mark.parametrize(
    ("waveform", "message"),
    [
        ("raise_oserror", "OSError: disk gone"),
        ("raise_valueerror", "ValueError: bad value"),
        ("raise_cpe", f"CalledProcessError: {CPE}"),
    ],
)
def test_pair_audio_diagnostics_waveform_failure_wire(waveform, message, wavs, monkeypatch):
    pair, names, diagnostics = wavs
    _apply_diagnostic_stubs(monkeypatch, diag_case(waveform=waveform), [])
    result = _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    expected = {
        "file": "1.wav",
        "astats": {"peak_level_db": -3.0, "file": "1.wav"},
        "hum": {"hum_detected": False},
        "error": message,
    }
    assert dump(result["current"]) == dump(expected)
    assert list(result["current"]) == ["file", "astats", "hum", "error"]
    assert sorted(p.name for p in diagnostics.rglob("*")) == []


def test_pair_audio_diagnostics_runtime_error_propagates_wire(wavs, monkeypatch):
    pair, names, diagnostics = wavs
    _apply_diagnostic_stubs(monkeypatch, diag_case(astats="raise_runtime"), [])
    result = outcome(_pair_audio_diagnostics, pair, names, diagnostics, "pair_000")
    assert dump(result) == dump(
        {"raised": {"type": "RuntimeError", "code": None, "message": "unexpected"}}
    )


def test_pair_audio_diagnostics_images_and_calls_wire(wavs, monkeypatch):
    pair, names, diagnostics = wavs
    calls: list = []
    _apply_diagnostic_stubs(monkeypatch, diag_case(), calls)
    _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    assert dump(sorted(p.name for p in diagnostics.iterdir())) == dump(
        ["current.png", "suggested.png"]
    )
    assert dump(calls) == dump(
        [
            ["astats", "pair_000", "1.wav"],
            ["detect_mains_hum", "pair_000", "1.wav"],
            ["render_showwavespic", "pair_000", "current.png"],
            ["astats", "pair_000", "2.wav"],
            ["detect_mains_hum", "pair_000", "2.wav"],
            ["render_showwavespic", "pair_000", "suggested.png"],
        ]
    )


def test_pair_audio_diagnostics_real_ffmpeg_shape_wire(wavs):
    pair, names, diagnostics = wavs
    result = _pair_audio_diagnostics(pair, names, diagnostics, "pair_000")
    shaped = {
        role: {
            "keys": list(result[role]),
            "astats": {k: type(v).__name__ for k, v in result[role]["astats"].items()},
            "hum": {k: type(v).__name__ for k, v in result[role]["hum"].items()},
        }
        for role in ("current", "suggested")
    }
    side = {
        "keys": ["file", "astats", "hum", "waveform_png"],
        "astats": {
            "dc_offset": "float",
            "peak_level_db": "float",
            "rms_level_db": "float",
            "crest_factor": "float",
            "flat_factor": "float",
            "peak_count": "int",
            "noise_floor_db": "float",
            "dynamic_range_db": "float",
        },
        "hum": {
            "hum_detected": "bool",
            "dominant_frequency": "str",
            "energy_ratios": "dict",
            "threshold_ratio": "float",
            "recommendation": "NoneType",
        },
    }
    assert dump(shaped) == dump({"current": side, "suggested": side})
    assert (diagnostics / "current.png").stat().st_size > 0
    assert result["current"]["waveform_png"] == "diagnostics/pair_000/current.png"


def _edit():
    return dec("f1", "filler:um", start=1.0, end=1.2)


def _report(**over):
    return join_quality_fixtures.report(**over)


JOIN_PASS = {
    "track_id": "host",
    "mode": "existing_join",
    "join_sec": 1.0,
    "timebase": "timeline",
    "risk": 0.1,
    "invisibility": 0.9,
    "verdict": "pass",
    "reasons": [],
    "detectors": [],
    "calibrated": False,
    "natural_p95": None,
    "side_sec": 0.05,
    "disclaimer": "x",
    "ranker": None,
}


@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        (None, {"value": JOIN_PASS}),
        (ValueError("no stem"), {"value": {"verdict": "error", "error": "ValueError: no stem"}}),
        (OSError("disk gone"), {"value": {"verdict": "error", "error": "OSError: disk gone"}}),
        (
            FileNotFoundError("gone"),
            {"value": {"verdict": "error", "error": "FileNotFoundError: gone"}},
        ),
        (
            CalledProcessError(1, ["ffmpeg", "-i", "x.wav"], output="o", stderr="boom"),
            {"value": {"verdict": "error", "error": f"CalledProcessError: {CPE}"}},
        ),
        (KeyError("k"), {"raised": {"type": "KeyError", "code": None, "message": "'k'"}}),
        (RuntimeError("x"), {"raised": {"type": "RuntimeError", "code": None, "message": "x"}}),
    ],
)
def test_join_metrics_wire(raised, expected, monkeypatch):
    seen: list = []

    def join_quality(self, **kwargs):
        seen.append(kwargs)
        if raised is not None:
            raise raised
        return _report()

    monkeypatch.setattr(TimelineService, "join_quality", join_quality)
    svc = SimpleNamespace(ws=SimpleNamespace(project=None))
    monkeypatch.setattr(ge, "TimelineService", lambda ws: TimelineService.__new__(TimelineService))
    result = outcome(_join_metrics, svc, _edit(), None)
    assert dump(result) == dump(expected)
    assert dump(seen) == dump(
        [
            {
                "track_id": "reference",
                "cut_start": 1.0,
                "cut_end": 1.2,
                "timebase": "source",
                "audio_caches": None,
            }
        ]
    )


def test_join_metrics_validation_error_propagates_wire(monkeypatch):
    def join_quality(self, **kwargs):
        return _report(ranker="r1")

    monkeypatch.setattr(TimelineService, "join_quality", join_quality)
    svc = SimpleNamespace(ws=None)
    monkeypatch.setattr(ge, "TimelineService", lambda ws: TimelineService.__new__(TimelineService))
    result = outcome(_join_metrics, svc, _edit(), {})
    assert result["raised"]["type"] == "ValidationError"
    assert result["raised"]["message"].splitlines()[:2] == [
        "1 validation error for JoinQualityReport",
        "ranker",
    ]


def test_join_metrics_forwards_audio_caches_wire(monkeypatch):
    seen: list = []

    def join_quality(self, **kwargs):
        seen.append(kwargs["audio_caches"])
        return _report(verdict="review", reasons=["click"], risk=0.5)

    monkeypatch.setattr(TimelineService, "join_quality", join_quality)
    monkeypatch.setattr(ge, "TimelineService", lambda ws: TimelineService.__new__(TimelineService))
    caches = {"guest": object()}
    value = _join_metrics(SimpleNamespace(ws=None), _edit(), caches)
    assert seen[0] is caches
    assert dump(value) == dump(
        {**JOIN_PASS, "risk": 0.5, "verdict": "review", "reasons": ["click"]}
    )
    assert list(value) == list(JOIN_PASS)


class _Context:
    def __init__(self, fail=None):
        self.fail = fail
        self.calls = []

    def audition_context(self, start, end, **kwargs):
        self.calls.append([start, end, kwargs])
        if self.fail is not None:
            raise self.fail
        return {"schema": "audition_context.v2", "window": [start, end]}


@pytest.mark.parametrize(
    ("fail", "expected"),
    [
        (None, [{"schema": "audition_context.v2", "window": [0.5, 3.25]}, None]),
        (ValueError("bad"), [None, "ValueError: bad"]),
        (OSError("io"), [None, "OSError: io"]),
        (
            CalledProcessError(1, ["ffmpeg", "-i", "x.wav"]),
            [None, f"CalledProcessError: {CPE}"],
        ),
    ],
)
def test_pair_audition_context_wire(fail, expected):
    play = _Context(fail)
    result = _pair_audition_context(play, {"play_start": 0.5, "play_end": "3.25"})
    assert dump(list(result)) == dump(expected)
    assert dump(play.calls) == dump([[0.5, 3.25, {"detail": "summary", "include_dsp": False}]])


def test_pair_audition_context_runtime_error_propagates_wire():
    result = outcome(
        _pair_audition_context,
        _Context(RuntimeError("boom")),
        {"play_start": 0.0, "play_end": 1.0},
    )
    assert dump(result) == dump(
        {"raised": {"type": "RuntimeError", "code": None, "message": "boom"}}
    )


class _Play:
    def __init__(self, wav, project=None):
        self.wav = wav
        self.project = project
        self.calls = []

    def play_pending_preview(self, edit_id, **kwargs):
        from podcast_mcp.services.document.play import PlayResult

        self.calls.append([edit_id, kwargs])
        return PlayResult(
            wav_path=self.wav,
            player_cmd=None,
            source_label="pending",
            start_sec=0.0,
            end_sec=1.0,
            tier="pending",
        )


@pytest.mark.parametrize(
    ("seed", "leave", "edit"),
    [
        (0, "1.wav", "2.wav"),
        (1, "2.wav", "1.wav"),
        (2, "2.wav", "1.wav"),
        (3, "2.wav", "1.wav"),
        (5, "1.wav", "2.wav"),
    ],
)
def test_render_pair_wavs_wire(seed, leave, edit, tmp_path, sample_wav, monkeypatch):
    monkeypatch.setattr(ge, "resolve_pending_preview", lambda *a, **k: _window())
    play = _Play(sample_wav)
    pair_dir = tmp_path / "pair_000"
    result = _render_pair_wavs(play, _edit(), pair_dir, pad_sec=0.5, rng=random.Random(seed))
    assert dump(result) == dump(
        {"leave_file": leave, "edit_file": edit, "play_start": 0.0, "play_end": 3.2}
    )
    assert list(result) == ["leave_file", "edit_file", "play_start", "play_end"]
    assert dump(sorted(p.name for p in pair_dir.iterdir())) == dump(["1.wav", "2.wav"])
    assert dump(play.calls) == dump(
        [
            ["f1", {"mode": "current", "pad_sec": 0.5, "dry_run": True, "rerender": False}],
            ["f1", {"mode": "suggested", "pad_sec": 0.5, "dry_run": True, "rerender": False}],
        ]
    )


def test_render_pair_wavs_unsuggestable_wire(tmp_path, sample_wav, monkeypatch):
    monkeypatch.setattr(ge, "resolve_pending_preview", lambda *a, **k: _window(suggestable=False))
    play = _Play(sample_wav)
    result = _render_pair_wavs(
        play, _edit(), tmp_path / "pair_000", pad_sec=0.5, rng=random.Random(0)
    )
    assert result is None
    assert play.calls == []
    assert sorted(p.name for p in tmp_path.iterdir()) == []


@pytest.mark.parametrize("name", sorted(SCORE))
def test_score_cases_leave_directory_untouched(name, tmp_path):
    record = run_score(SCORE[name], tmp_path / "root", cli=False)
    assert record["tree_unchanged"] is True


def script_roots(tmp_path):
    return {str(tmp_path.resolve()): "<tmp>", str(tmp_path): "<tmp>", FIXTURE_ROOT: "<fixture>"}


SCRIPT_CASES = {
    "no_args": (
        [],
        {
            "exit": 2,
            "stdout": "",
            "stderr_last": "golden_ear_harness.py: error: the following arguments are required: cmd",
        },
    ),
    "unknown_command": (
        ["frobnicate"],
        {
            "exit": 2,
            "stdout": "",
            "stderr_last": "golden_ear_harness.py: error: argument cmd: invalid choice: 'frobnicate' (choose from 'build', 'score')",
        },
    ),
    "build_bad_intensity": (
        ["build", "--project", "p", "--out", "o", "--intensity", "extreme"],
        {
            "exit": 2,
            "stdout": "",
            "stderr_last": "golden_ear_harness.py build: error: argument --intensity: invalid choice: 'extreme' (choose from 'light', 'medium', 'aggressive')",
        },
    ),
    "build_missing_out": (
        ["build", "--project", "p"],
        {
            "exit": 2,
            "stdout": "",
            "stderr_last": "golden_ear_harness.py build: error: the following arguments are required: --out",
        },
    ),
    "score_missing_dir_flag": (
        ["score"],
        {
            "exit": 2,
            "stdout": "",
            "stderr_last": "golden_ear_harness.py score: error: the following arguments are required: --dir",
        },
    ),
    "build_missing_project": (
        ["build", "--project", "<tmp>/nope", "--out", "<tmp>/out"],
        {
            "exit": 1,
            "stdout": "",
            "stderr_last": "ValueError: expected episode.sharecut, got 'nope'",
        },
    ),
    "build_unknown_class": (
        ["build", "--project", "<fixture>", "--out", "<tmp>/out", "--classes", "nope"],
        {
            "exit": 1,
            "stdout": "",
            "stderr_last": "podcast_mcp.util.coded_error.CodedValueError: unsupported classes ['nope']; use filler,pause,repetition,restart",
        },
    ),
    "build_limit_zero": (
        ["build", "--project", "<fixture>", "--out", "<tmp>/out", "--limit", "0"],
        {
            "exit": 1,
            "stdout": "",
            "stderr_last": "podcast_mcp.util.coded_error.CodedValueError: limit must be between 1 and 500",
        },
    ),
    "score_missing_dir": (
        ["score", "--dir", "<tmp>/nope"],
        {
            "exit": 1,
            "stdout": "",
            "stderr_last": "FileNotFoundError: missing key.json in <tmp>/nope",
        },
    ),
}


@pytest.mark.parametrize("name", sorted(SCRIPT_CASES))
def test_script_error_paths_wire(name, tmp_path):
    argv, expected = SCRIPT_CASES[name]
    argv = [a.replace("<tmp>", str(tmp_path)).replace("<fixture>", FIXTURE_ROOT) for a in argv]
    result = run_script(argv, tmp_path, script_roots(tmp_path))
    result.pop("stderr_lines")
    assert dump(result) == dump(expected)
    assert not (tmp_path / "out").exists()


SCRIPT_SCORE = {
    "all_edit_pass": 0,
    "all_leave_in": 1,
    "partial_one_row": 1,
    "ties": 1,
    "gated_boundary_9_of_10": 0,
    "no_pairs": 1,
}


@pytest.mark.parametrize("name", sorted(SCRIPT_SCORE))
def test_script_score_subprocess_wire(name, tmp_path):
    case = SCORE[name]
    inproc = run_score(case, tmp_path / "root", cli=True)
    assert inproc["tree_unchanged"] is True
    result = run_script(
        ["score", "--dir", str(tmp_path / "root"), "--answers", "answers.csv"],
        tmp_path,
        script_roots(tmp_path),
    )
    assert dump(result["exit"]) == dump(SCRIPT_SCORE[name])
    assert dump(result["exit"]) == dump(inproc["exit"])
    assert result["stdout"] == inproc["stdout"]
    assert result["stderr_last"] == ""


def test_script_score_listen_default_wire(tmp_path):
    case = SCORE["answers_listen_default_arg"]
    run_score(case, tmp_path / "root", cli=True)
    result = run_script(["score", "--dir", str(tmp_path / "root")], tmp_path, {})
    report = json.loads(result["stdout"])
    assert dump({"exit": result["exit"], "pass": report["pass"], "n": report["n_answers"]}) == dump(
        {"exit": 0, "pass": True, "n": 2}
    )


def test_script_build_subprocess_real_pipeline_wire(tmp_path):
    out = tmp_path / "golden"
    result = run_script(
        ["build", "--project", FIXTURE_ROOT, "--out", str(out), "--limit", "1", "--seed", "0"],
        tmp_path,
        script_roots(tmp_path),
    )
    assert dump({"exit": result["exit"], "stdout": result["stdout"]}) == dump(
        {"exit": 1, "stdout": ""}
    )
    assert result["stderr_last"] == (
        "podcast_mcp.edits.transcript_refine_status.TranscriptRefineRequiredError: "
        "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine "
        "(whole-episode pass), then `podcast transcript refine-done` / `transcript_refine_done_tool`, "
        "or `podcast transcript refine-waive --reason ...` / `transcript_refine_waive_tool`."
    )
    assert dump(sorted(p.name for p in tmp_path.iterdir())) == dump([".golden.staging"])
    assert dump(sorted(p.name for p in (tmp_path / ".golden.staging").iterdir())) == dump(
        ["workspace"]
    )


def test_script_build_refuses_nonempty_out_wire(tmp_path):
    out = tmp_path / "golden"
    out.mkdir()
    (out / "keep.txt").write_text("x", encoding="utf-8")
    result = run_script(
        ["build", "--project", FIXTURE_ROOT, "--out", str(out)], tmp_path, script_roots(tmp_path)
    )
    assert dump({"exit": result["exit"], "last": result["stderr_last"]}) == dump(
        {
            "exit": 1,
            "last": "FileExistsError: non-empty --out; pass force=True to rebuild: <tmp>/golden",
        }
    )
    assert dump(sorted(p.name for p in out.iterdir())) == dump(["keep.txt"])
