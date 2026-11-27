"""Scenario tables for the golden-ear wire pins: build cases, CLI cases and score cases."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from golden_ear_wire_helpers import Case, _cpe, dec, key_pair

HEADER = "pair_id,prefer,leftover_consonant,notes\n"


def _stale_out(root: Path, out: Path, src: Path) -> None:
    (out / "listen" / "pair_000").mkdir(parents=True)
    (out / "listen" / "pair_000" / "1.wav").write_bytes(b"old")
    (out / "listen" / "answers.csv").write_text(HEADER + "pair_000,,,\n", encoding="utf-8")
    (out / "key.json").write_text('{"stale": true}', encoding="utf-8")
    (out / "stale.txt").write_text("x", encoding="utf-8")


def _filled_listen(root: Path, out: Path, src: Path) -> None:
    (out / "listen").mkdir(parents=True)
    (out / "listen" / "answers.csv").write_text(HEADER + "pair_000,1,no,\n", encoding="utf-8")
    (out / "key.json").write_text('{"stale": true}', encoding="utf-8")


def _filled_root(root: Path, out: Path, src: Path) -> None:
    out.mkdir(parents=True)
    (out / "answers.csv").write_text(HEADER + "pair_000,tie,no,\n", encoding="utf-8-sig")


def _blank_root_answers(root: Path, out: Path, src: Path) -> None:
    out.mkdir(parents=True)
    (out / "answers.csv").write_text(HEADER + "pair_000,  ,no,\n", encoding="utf-8")


def _filled_notes_only(root: Path, out: Path, src: Path) -> None:
    (out / "listen").mkdir(parents=True)
    (out / "listen" / "answers.csv").write_text(HEADER + "pair_000,,,note\n", encoding="utf-8")


def _empty_out(root: Path, out: Path, src: Path) -> None:
    out.mkdir(parents=True)


def _out_is_file(root: Path, out: Path, src: Path) -> None:
    out.write_text("not a dir", encoding="utf-8")


def _stale_staging(root: Path, out: Path, src: Path) -> None:
    staging = out.parent / f".{out.name}.staging"
    staging.mkdir(parents=True)
    (staging / "junk").write_text("x", encoding="utf-8")
    old = out.parent / f".{out.name}.old"
    old.mkdir()
    (old / "junk").write_text("y", encoding="utf-8")


def _stale_partial_workspace(root: Path, out: Path, src: Path) -> None:
    partial = out.parent / f".{out.name}.staging" / "workspace.partial"
    partial.mkdir(parents=True)
    (partial / "junk").write_text("x", encoding="utf-8")


def _nested_out(root: Path, out: Path, src: Path) -> None:
    shutil.rmtree(out, ignore_errors=True)


def _pre_existing_pair_dirs(root: Path, out: Path, src: Path) -> None:
    (out.parent / f".{out.name}.staging" / "listen" / "pair_000").mkdir(parents=True)
    (out.parent / f".{out.name}.staging" / "listen" / "pair_000" / "stale.wav").write_bytes(b"s")


def no_candidates() -> list:
    return [
        dec("a1", "filler:um", applied=True),
        dec("m1", "filler:um", dtype="mute"),
        dec("o1", "other:x"),
        dec("n1", None),
        dec("c1", "Filler:um"),
        dec("c2", "filler"),
        dec("c3", " pause:1s"),
    ]


def edge_reasons() -> list:
    return [
        dec("e1", "pause:", start=1.0, end=2.0),
        dec("e2", "filler:", track="guest", start=3.0, end=3.1),
        dec("e3", "restart:x:y", start=4.0, end=4.5),
        dec("e4", "repetition:é", track="guest", start=5.0, end=5.2),
    ]


def single() -> list:
    return [dec("f1", "filler:um", start=1.0, end=1.2)]


def ghost_track() -> list:
    return [dec("g1", "filler:um", track="ghost", start=1.0, end=1.2)]


def many() -> list:
    return [dec(f"x{i}", "filler:um", start=float(i), end=i + 0.2) for i in range(1, 9)]


def empty() -> list:
    return []


NONDET: dict[str, Case] = {
    "seed_none": Case(kwargs={"seed": None}),
    "seed_unset": Case(kwargs={}),
}
BUILD: dict[str, Case] = {}


def add(name: str, **kwargs: Any) -> None:
    BUILD[name] = Case(**kwargs)


def kw(**kwargs: Any) -> dict[str, Any]:
    return kwargs


add("default", kwargs=kw(seed=0))
add("detail_two", kwargs=kw(limit=2, classes="filler,pause", seed=0))
add("detail_all_classes", kwargs=kw(limit=40, seed=3, intensity="aggressive", pad_sec=1.5))
add(
    "detail_gated_mix",
    kwargs=kw(seed=1),
    join={
        1.0: {"risk": 0.12},
        2.0: {"risk": 0.55, "verdict": "review", "reasons": ["click"]},
        4.0: {"risk": 0.9, "verdict": "fail", "reasons": ["click", "level_jump"]},
    },
)
add(
    "detail_join_errors",
    kwargs=kw(seed=1),
    join={
        1.0: ValueError("no stem"),
        2.0: OSError("disk gone"),
        4.0: _cpe(),
    },
)
add("detail_diag_errors", kwargs=kw(limit=2, seed=0), astats="raise_oserror_first", hum="detected")
add("detail_context_error", kwargs=kw(limit=2, seed=0), context="valueerror")
add("detail_pad_short", kwargs=kw(limit=2, seed=0), preview="suggested_short")
add("detail_pad_current_short", kwargs=kw(limit=2, seed=0), preview="current_short")
add("detail_real_diagnostics", kwargs=kw(limit=1, seed=0), real_diagnostics=True)
add("detail_skipped", kwargs=kw(limit=3, seed=2), unsuggestable=frozenset({"f1", "p1"}))
add("detail_no_candidates", kwargs=kw(seed=0), decisions=no_candidates)
add("detail_edge_reasons", kwargs=kw(seed=0), decisions=edge_reasons)

for label, value in [
    ("none", None),
    ("filler", "filler"),
    ("pause", "pause"),
    ("filler_pause", "filler,pause"),
    ("repetition", "repetition"),
    ("restart", "restart"),
    ("rep_restart", "repetition,restart"),
    ("tuple", ("pause", "filler")),
    ("list", ["restart"]),
    ("messy", " Filler , PAUSE ,, "),
    ("upper", "FILLER"),
    ("dupes", "filler,filler"),
]:
    add(f"cls_{label}", kwargs=kw(seed=0, classes=value))

for label, value in [
    ("1", 1),
    ("2", 2),
    ("3", 3),
    ("5", 5),
    ("500", 500),
    ("str", "3"),
    ("float", 2.9),
]:
    add(f"lim_{label}", kwargs=kw(seed=0, limit=value))

for value in (0, 1, 2, 3, 7, 12345):
    add(f"seed_{value}", kwargs=kw(seed=value))
for value in (0, 1, 2, 5):
    add(f"seed_lim2_{value}", kwargs=kw(seed=value, limit=2))
add("seed_many_0", kwargs=kw(seed=0, limit=4), decisions=many)
add("seed_many_9", kwargs=kw(seed=9, limit=4), decisions=many)
add("seed_negative", kwargs=kw(seed=-1))

for label, value in [
    ("none", None),
    ("light", "light"),
    ("medium", "medium"),
    ("aggressive", "aggressive"),
    ("upper", "AGGRESSIVE"),
    ("blank", "  "),
    ("padded", " Light "),
]:
    add(f"int_{label}", kwargs=kw(seed=0, limit=2, intensity=value))

for label, value in [
    ("zero", 0.0),
    ("half", 0.5),
    ("int3", 3),
    ("five", 5.0),
    ("ten", 10.0),
    ("tiny", 0.001),
]:
    add(f"pad_{label}", kwargs=kw(seed=0, limit=2, pad_sec=value))

add("force_fresh", kwargs=kw(seed=0, limit=2, force=True))
add("force_stale", kwargs=kw(seed=0, limit=2, force=True), pre=_stale_out)
add("force_filled_listen", kwargs=kw(seed=0, limit=2, force=True), pre=_filled_listen)
add("force_filled_root", kwargs=kw(seed=0, limit=2, force=True), pre=_filled_root)
add("force_twice", kwargs=kw(seed=0, limit=2, force=True), twice=True)
add("refuse_stale", kwargs=kw(seed=0, limit=2), pre=_stale_out)
add("refuse_filled_listen", kwargs=kw(seed=0, limit=2), pre=_filled_listen)
add("refuse_filled_root", kwargs=kw(seed=0, limit=2), pre=_filled_root)
add("refuse_blank_root_nonempty", kwargs=kw(seed=0, limit=2), pre=_blank_root_answers)
add("refuse_blank_root_force", kwargs=kw(seed=0, limit=2, force=True), pre=_blank_root_answers)
add("notes_only_refuse", kwargs=kw(seed=0, limit=2), pre=_filled_notes_only)
add("empty_out_ok", kwargs=kw(seed=0, limit=2), pre=_empty_out)
add("out_is_file", kwargs=kw(seed=0, limit=2), pre=_out_is_file)
add("out_is_file_force", kwargs=kw(seed=0, limit=2, force=True), pre=_out_is_file)
add("nested_missing_parent", kwargs=kw(seed=0, limit=2), out_rel="a/b/golden")
add("stale_staging", kwargs=kw(seed=0, limit=2), pre=_stale_staging)
add("stale_partial_workspace", kwargs=kw(seed=0, limit=1), pre=_stale_partial_workspace)
add("stale_pair_partial", kwargs=kw(seed=0, limit=2), pre=_pre_existing_pair_dirs)
add("out_inside_source", kwargs=kw(seed=0, limit=2), copy_source=True, out_rel="src/nested")
add("copy_source", kwargs=kw(seed=0, limit=2), copy_source=True)

add("unsug_one", kwargs=kw(seed=0), unsuggestable=frozenset({"f1"}))
add("unsug_all", kwargs=kw(seed=0), unsuggestable=frozenset({"f1", "p1", "f2", "r1", "s1"}))
add("unsug_limit", kwargs=kw(seed=4, limit=2), unsuggestable=frozenset({"f2", "r1"}))
add("unsug_ignored_class", kwargs=kw(seed=0, classes="pause"), unsuggestable=frozenset({"f1"}))

add(
    "join_review",
    kwargs=kw(seed=0, limit=2),
    join={1.0: {"verdict": "review"}, 2.0: {"verdict": "review"}},
)
add(
    "join_fail",
    kwargs=kw(seed=0, limit=2),
    join={1.0: {"verdict": "fail"}, 2.0: {"verdict": "fail"}},
)
add(
    "join_valueerror",
    kwargs=kw(seed=0, limit=2),
    join={1.0: ValueError("no stem"), 2.0: ValueError("no stem")},
)
add(
    "join_oserror",
    kwargs=kw(seed=0, limit=2),
    join={1.0: OSError("disk gone"), 2.0: OSError("disk gone")},
)
add("join_cpe", kwargs=kw(seed=0, limit=2), join={1.0: _cpe(), 2.0: _cpe()})
add(
    "join_validation",
    kwargs=kw(seed=0, limit=2),
    join={1.0: {"ranker": "r1"}, 2.0: {"ranker": "r1"}},
)
add(
    "join_runtime",
    kwargs=kw(seed=0, limit=2),
    join={1.0: RuntimeError("x"), 2.0: RuntimeError("x")},
)
add(
    "join_filenotfound",
    kwargs=kw(seed=0, limit=2),
    join={1.0: FileNotFoundError("gone"), 2.0: FileNotFoundError("gone")},
)
add("join_pass_one", kwargs=kw(seed=0, limit=2), join={1.0: {"verdict": "pass", "risk": 0.01}})
add("join_ghost_track", kwargs=kw(seed=0), decisions=ghost_track)
add(
    "join_empty_reasons",
    kwargs=kw(seed=0, limit=1),
    decisions=single,
    join={1.0: {"reasons": ["a", "b"], "calibrated": True, "natural_p95": 0.4}},
)

for label in (
    "none_metrics",
    "empty",
    "partial",
    "multi",
    "raise_oserror",
    "raise_valueerror",
    "raise_cpe",
    "raise_runtime",
    "raise_keyerror",
    "raise_oserror_first",
    "raise_valueerror_first",
):
    add(f"astats_{label}", kwargs=kw(seed=0, limit=2), astats=label)
for label in ("detected", "raise_oserror", "raise_valueerror", "raise_cpe", "raise_runtime"):
    add(f"hum_{label}", kwargs=kw(seed=0, limit=2), hum=label)
for label in ("raise_oserror", "raise_valueerror", "raise_cpe", "raise_runtime"):
    add(f"wave_{label}", kwargs=kw(seed=0, limit=2), waveform=label)
for label in ("valueerror", "oserror", "cpe", "runtime"):
    add(f"ctx_{label}", kwargs=kw(seed=0, limit=2), context=label)
add(
    "astats_and_wave_error",
    kwargs=kw(seed=0, limit=1),
    astats="none_metrics",
    waveform="raise_oserror",
)

add("preview_suggested_short", kwargs=kw(seed=0, limit=2), preview="suggested_short")
add("preview_current_short", kwargs=kw(seed=0, limit=2), preview="current_short")
add(
    "preview_short_no_ffmpeg",
    kwargs=kw(seed=0, limit=2),
    preview="suggested_short",
    ffmpeg_available=False,
)
add("preview_equal_no_ffmpeg", kwargs=kw(seed=0, limit=2), ffmpeg_available=False)
add("preview_raises", kwargs=kw(seed=0, limit=2), preview="raise")
add("propose_oserror", kwargs=kw(seed=0), propose="oserror")
add("propose_valueerror", kwargs=kw(seed=0), propose="valueerror")
add("real_diagnostics", kwargs=kw(seed=0, limit=2), real_diagnostics=True)
add(
    "real_diagnostics_short",
    kwargs=kw(seed=0, limit=2),
    real_diagnostics=True,
    preview="suggested_short",
)

add("dec_empty", kwargs=kw(seed=0), decisions=empty)
add("dec_none_candidate", kwargs=kw(seed=0), decisions=no_candidates)
add("dec_single", kwargs=kw(seed=0), decisions=single)
add("dec_single_limit1", kwargs=kw(seed=0, limit=1), decisions=single)
add("dec_edge_reasons", kwargs=kw(seed=0), decisions=edge_reasons)
add("dec_edge_pause_only", kwargs=kw(seed=0, classes="pause"), decisions=edge_reasons)
add("dec_ghost_track", kwargs=kw(seed=0), decisions=ghost_track)
add("dec_many_limit_cap", kwargs=kw(seed=0, limit=500), decisions=many)

ERRORS: dict[str, dict[str, Any]] = {
    "classes_empty_string": kw(classes=""),
    "classes_commas": kw(classes=" , "),
    "classes_empty_list": kw(classes=[]),
    "classes_blank_tuple": kw(classes=("", " ")),
    "classes_unknown": kw(classes="hesitation"),
    "classes_unknown_mixed": kw(classes="filler,hesitation,other"),
    "classes_unknown_upper": kw(classes="Hesitation"),
    "limit_zero": kw(limit=0),
    "limit_negative": kw(limit=-5),
    "limit_over": kw(limit=501),
    "limit_str_bad": kw(limit="x"),
    "limit_none": kw(limit=None),
    "limit_float_zero": kw(limit=0.5),
    "intensity_unknown": kw(intensity="extreme"),
    "intensity_number": kw(intensity=3),
    "pad_negative": kw(pad_sec=-1.0),
    "pad_over": kw(pad_sec=10.5),
    "pad_nan": kw(pad_sec=float("nan")),
    "pad_inf": kw(pad_sec=float("inf")),
    "pad_str": kw(pad_sec="2"),
    "pad_bool": kw(pad_sec=True),
    "pad_none": kw(pad_sec=None),
    "order_classes_before_limit": kw(classes="x", limit=0, intensity="x", pad_sec=-1),
    "order_limit_before_intensity": kw(limit=0, intensity="x", pad_sec=-1),
    "order_intensity_before_pad": kw(intensity="x", pad_sec=-1),
}
for _name, _kwargs in ERRORS.items():
    add(f"err_{_name}", kwargs=kw(seed=0, **_kwargs))


@dataclass(frozen=True)
class CliCase:
    case: Case
    argv: list[str]


CLI: dict[str, CliCase] = {}


def add_cli(name: str, argv: list[str], case: Case | None = None) -> None:
    CLI[name] = CliCase(case or Case(), argv)


B = ["build", "--project", "{src}", "--out", "{out}"]
add_cli("build_default", [*B, "--seed", "3"])
add_cli("build_seed_limit", [*B, "--seed", "0", "--limit", "2"])
add_cli(
    "build_all_flags",
    [
        *B,
        "--seed",
        "5",
        "--limit",
        "3",
        "--classes",
        "filler,pause",
        "--intensity",
        "light",
        "--force",
    ],
)
add_cli(
    "build_intensity_aggressive", [*B, "--seed", "0", "--limit", "1", "--intensity", "aggressive"]
)
add_cli("build_classes_only", [*B, "--seed", "0", "--classes", "restart"])
add_cli("build_zero_pairs", [*B, "--seed", "0"], Case(decisions=empty))
add_cli("build_refuse_nonempty", [*B, "--seed", "0"], Case(pre=_stale_out))
add_cli("build_force_stale", [*B, "--seed", "0", "--limit", "1", "--force"], Case(pre=_stale_out))
add_cli("build_bad_class", [*B, "--classes", "nope"])
add_cli("build_bad_limit", [*B, "--limit", "0"])
add_cli("build_limit_not_int", [*B, "--limit", "x"])
add_cli("build_bad_intensity", [*B, "--intensity", "extreme"])
add_cli("build_missing_project_flag", ["build", "--out", "{out}"])
add_cli("build_missing_out_flag", ["build", "--project", "{src}"])
add_cli("build_unknown_flag", [*B, "--bogus"])
add_cli("build_seed_not_int", [*B, "--seed", "x"])
add_cli(
    "build_missing_project_dir",
    ["build", "--project", "/nonexistent/golden-ear-project", "--out", "{out}"],
)
add_cli("no_command", [])
add_cli("bad_command", ["frobnicate"])
add_cli("help_flag_build", ["build", "--help"])
add_cli("score_missing_dir_flag", ["score"])
add_cli("score_missing_dir", ["score", "--dir", "{out}"])
add_cli(
    "build_join_error",
    [*B, "--seed", "0", "--limit", "1"],
    Case(join={1.0: ValueError("no stem"), 2.0: ValueError("no stem")}),
)
add_cli(
    "build_unsuggestable",
    [*B, "--seed", "0"],
    Case(unsuggestable=frozenset({"f1", "p1", "f2", "r1", "s1"})),
)
add_cli("build_context_error", [*B, "--seed", "0", "--limit", "1"], Case(context="valueerror"))


@dataclass(frozen=True)
class ScoreCase:
    key: dict[str, Any]
    answers: str | None = None
    answers_arg: str = "answers.csv"
    place: str = "root"
    raw_key: str | None = None
    raw_answers: bytes | None = None


def K(pairs: list[dict[str, Any]], **head: Any) -> dict[str, Any]:
    return {"limit": 2, "min_gated_n": 2, "pair_count": len(pairs), "pairs": pairs, **head}


def two(**head: Any) -> dict[str, Any]:
    return K([key_pair("pair_000"), key_pair("pair_001", edit_file="2.wav")], **head)


def csv(*rows: str, header: str = HEADER) -> str:
    return header + "".join(row + "\n" for row in rows)


def ten(gated_edit: int, total: int = 10) -> tuple[dict[str, Any], str]:
    pairs = [key_pair(f"pair_{i:03d}") for i in range(total)]
    rows = [f"pair_{i:03d},{'1' if i < gated_edit else '2'},no," for i in range(total)]
    return K(pairs, limit=total, min_gated_n=2), csv(*rows)


SCORE: dict[str, ScoreCase] = {}


def add_score(name: str, key: dict[str, Any], answers: str | None = None, **kwargs: Any) -> None:
    SCORE[name] = ScoreCase(key, answers, **kwargs)


add_score("all_edit_pass", two(), csv("pair_000,1,no,", "pair_001,2,no,"))
add_score("all_leave_in", two(), csv("pair_000,2,no,", "pair_001,1,no,"))
add_score("one_edit_one_leave", two(), csv("pair_000,1,no,", "pair_001,1,no,"))
add_score("ties", two(), csv("pair_000,tie,no,", "pair_001,same,no,"))
add_score("tie_either", two(), csv("pair_000,either,no,", "pair_001, Tie ,no,"))
add_score("prefer_spacing", two(), csv("pair_000, 1 ,no,", "pair_001,2,no,"))
add_score("prefer_underscore", two(), csv("pair_000,t_ie,no,", "pair_001,e_ither,no,"))
add_score("prefer_invalid_words", two(), csv("pair_000,edit,no,", "pair_001,leave-in,no,"))
add_score("prefer_invalid_numbers", two(), csv("pair_000,3,no,", "pair_001,one,no,"))
add_score("prefer_blank", two(), csv("pair_000,,no,", "pair_001,  ,no,"))
add_score("leftover_yes_values", two(), csv("pair_000,1,yes,", "pair_001,2,Y,"))
add_score("leftover_true_one", two(), csv("pair_000,1,TRUE,", "pair_001,2,1,"))
add_score("leftover_no_values", two(), csv("pair_000,1,N,", "pair_001,2,false,"))
add_score("leftover_zero", two(), csv("pair_000,1,0,", "pair_001,2,no,"))
add_score("leftover_maybe", two(), csv("pair_000,1,maybe,", "pair_001,2,no,"))
add_score("leftover_blank", two(), csv("pair_000,1,,", "pair_001,2,,"))
add_score("leftover_whitespace_yes", two(), csv("pair_000,1, yes ,", "pair_001,2,no,"))
add_score("partial_one_row", two(), csv("pair_000,1,no,"))
add_score("partial_second_row", two(), csv("pair_001,2,no,"))
add_score("partial_header_only", two(), HEADER)
add_score("partial_prefer_only", two(), csv("pair_000,1,,", "pair_001,2,,"))
add_score("partial_mixed", two(), csv("pair_000,1,no,keep", "pair_001,,yes,why"))
add_score(
    "duplicates_first_wins",
    two(),
    csv("pair_000,1,no,first", "pair_000,2,yes,dup", "pair_001,2,no,"),
)
add_score(
    "unknown_and_blank_ids",
    two(),
    csv("unknown,1,no,", ",1,no,", "pair_000,1,no,", "pair_001,2,no,"),
)
add_score("id_whitespace", two(), csv(" pair_000 ,1,no,", "pair_001 ,2,no,"))
add_score("bom_header", two(), "﻿" + csv("pair_000,1,no,", "pair_001,2,no,"))
add_score("crlf_lines", two(), csv("pair_000,1,no,", "pair_001,2,no,").replace("\n", "\r\n"))
add_score(
    "extra_columns",
    two(),
    csv("pair_000,1,no,n,extra", "pair_001,2,no,n,extra", header=HEADER.strip() + ",other\n"),
)
add_score(
    "missing_notes_column",
    two(),
    csv("pair_000,1,no", "pair_001,2,no", header="pair_id,prefer,leftover_consonant\n"),
)
add_score(
    "missing_leftover_column", two(), csv("pair_000,1", "pair_001,2", header="pair_id,prefer\n")
)
add_score(
    "uppercase_header",
    two(),
    csv("pair_000,1,no,", "pair_001,2,no,", header="Pair_ID,Prefer,Leftover_Consonant,Notes\n"),
)
add_score("empty_answers_file", two(), "")
add_score("notes_pass_through", two(), csv('pair_000,1,no,"a, b ""q"""', "pair_001,2,no,line"))
add_score("notes_multiline", two(), csv('pair_000,1,no,"line1\nline2"', "pair_001,2,no,"))
add_score("unicode_notes", two(), csv("pair_000,1,no,café ☃", "pair_001,2,no,"))
add_score("short_rows", two(), csv("pair_000", "pair_001,2"))

KEY_BOTH = K(
    [
        key_pair("pair_000", edit_file="1.wav", gated=True),
        key_pair("pair_001", edit_file="2.wav", gated=True, reason="filler:uh"),
        key_pair(
            "pair_002",
            edit_file="1.wav",
            gated=False,
            klass="pause",
            reason="pause:1.4s",
            track_id="guest",
        ),
    ],
    limit=2,
    min_gated_n=2,
)
add_score("three_pass", KEY_BOTH, csv("pair_000,1,no,", "pair_001,2,no,", "pair_002,2,no,"))
add_score(
    "three_leftover_fail",
    KEY_BOTH,
    csv("pair_000,1,yes,click", "pair_001,tie,no,", "pair_002,1,no,"),
)
add_score(
    "three_missing_two", KEY_BOTH, csv("pair_000,1,no,", "pair_001,,no,", "pair_002,edit,no,")
)
add_score(
    "three_blank_leftover", KEY_BOTH, csv("pair_000,1,,", "pair_001,2,maybe,", "pair_002,2,no,")
)
add_score("three_all_blank", KEY_BOTH, HEADER)
add_score(
    "three_ungated_only_edit", KEY_BOTH, csv("pair_000,2,no,", "pair_001,1,no,", "pair_002,1,no,")
)

K10, A10 = ten(9)
add_score("gated_boundary_9_of_10", K10, A10)
K8, A8 = ten(8, 9)
add_score("gated_below_8_of_9", K8, A8)
K10b, A10b = ten(10)
add_score("gated_all_10", K10b, A10b)
add_score(
    "gated_floor_one_pair",
    K([key_pair("pair_000")], limit=40, min_gated_n=2),
    csv("pair_000,1,no,"),
)
add_score(
    "gated_floor_limit_one",
    K([key_pair("pair_000")], limit=1, min_gated_n=1),
    csv("pair_000,1,no,"),
)
add_score(
    "gated_floor_derived_limit_one",
    {"limit": 1, "pair_count": 1, "pairs": [key_pair("pair_000")]},
    csv("pair_000,1,no,"),
)
add_score(
    "gated_floor_derived_default",
    {"pair_count": 2, "pairs": [key_pair("pair_000"), key_pair("pair_001")]},
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "gated_floor_min_three",
    K([key_pair("pair_000"), key_pair("pair_001")], limit=40, min_gated_n=3),
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "min_gated_zero_falls_back",
    K([key_pair("pair_000")], limit=1, min_gated_n=0),
    csv("pair_000,1,no,"),
)
add_score(
    "limit_zero_falls_back",
    K([key_pair("pair_000"), key_pair("pair_001")], limit=0, min_gated_n=0),
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "limit_and_counts_as_strings",
    K([key_pair("pair_000")], limit="1", min_gated_n="1", pair_count="7"),
    csv("pair_000,1,no,"),
)
add_score(
    "pair_count_missing",
    {"limit": 2, "min_gated_n": 2, "pairs": [key_pair("pair_000"), key_pair("pair_001")]},
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "pair_count_larger_than_pairs",
    K([key_pair("pair_000"), key_pair("pair_001")], pair_count=9),
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "pair_count_zero_falls_back",
    K([key_pair("pair_000"), key_pair("pair_001")], pair_count=0),
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score("no_pairs", K([], pair_count=0), HEADER)
add_score("pairs_null", {"limit": 2, "min_gated_n": 2, "pair_count": 0, "pairs": None}, HEADER)
add_score("pairs_missing", {"limit": 2}, HEADER)
add_score("empty_key_object", {}, HEADER)
add_score(
    "no_gated_pairs",
    K([key_pair("pair_000", gated=False), key_pair("pair_001", gated=False)]),
    csv("pair_000,1,no,", "pair_001,2,no,"),
)
add_score(
    "gated_flag_variants",
    K(
        [
            key_pair("pair_000", gated=None),
            {**key_pair("pair_001"), "gated": 1},
            {**key_pair("pair_002"), "gated": "yes"},
            {**key_pair("pair_003"), "gated": 0},
        ]
    ),
    csv("pair_000,1,no,", "pair_001,1,no,", "pair_002,1,no,", "pair_003,1,no,"),
)
add_score(
    "classes_all_four",
    K(
        [
            key_pair("pair_000", klass="filler"),
            key_pair("pair_001", klass="pause", reason="pause:1s"),
            key_pair("pair_002", klass="repetition", reason="repetition:a a"),
            key_pair("pair_003", klass="restart", reason="restart:so"),
        ],
        limit=4,
    ),
    csv("pair_000,1,no,", "pair_001,2,no,", "pair_002,tie,no,", "pair_003,1,yes,"),
)
add_score(
    "class_unknown_and_missing",
    K(
        [
            key_pair("pair_000", klass="mystery", reason="mystery:x"),
            key_pair("pair_001", klass=None, reason=None, track_id=None),
        ]
    ),
    csv("pair_000,1,no,", "pair_001,1,no,"),
)
add_score(
    "reasons_and_tracks_sorted",
    K(
        [
            key_pair("pair_000", reason="pause:2.0s", klass="pause", track_id="guest"),
            key_pair("pair_001", reason="filler:um", track_id="reference"),
            key_pair("pair_002", reason="filler:uh", track_id="guest"),
            key_pair("pair_003", reason="filler:um", track_id="reference", edit_file="2.wav"),
        ],
        limit=4,
    ),
    csv("pair_000,1,no,", "pair_001,2,no,", "pair_002,2,no,", "pair_003,2,yes,"),
)
add_score(
    "thirds_rate",
    K([key_pair(f"pair_{i:03d}") for i in range(3)], limit=3, min_gated_n=2),
    csv("pair_000,1,no,", "pair_001,2,no,", "pair_002,2,no,"),
)
add_score(
    "duplicate_pair_ids_in_key",
    K([key_pair("pair_000", edit_file="1.wav"), key_pair("pair_000", edit_file="2.wav")]),
    csv("pair_000,2,no,"),
)
add_score(
    "pair_without_files",
    K([{"id": "pair_000", "gated": True}, {"id": "pair_001", "gated": True}]),
    csv("pair_000,1,no,", "pair_001,2,no,"),
)
add_score(
    "pair_numeric_id",
    K([{"id": 7, "edit_file": "1.wav", "leave_file": "2.wav", "gated": True}]),
    csv("7,1,no,"),
)
add_score("answers_in_listen_dir", two(), csv("pair_000,1,no,", "pair_001,2,no,"), place="listen")
add_score(
    "answers_listen_default_arg",
    two(),
    csv("pair_000,1,no,", "pair_001,2,no,"),
    answers_arg="<default>",
    place="listen",
)
add_score(
    "answers_home_expansion", two(), csv("pair_000,1,no,", "pair_001,2,no,"), answers_arg="~/h.csv"
)
add_score(
    "answers_other_name_no_fallback",
    two(),
    csv("pair_000,1,no,", "pair_001,2,no,"),
    answers_arg="other.csv",
    place="listen",
)
add_score(
    "answers_named_other", two(), csv("pair_000,1,no,", "pair_001,2,no,"), answers_arg="my.csv"
)
add_score("answers_subdir", two(), csv("pair_000,1,no,", "pair_001,2,no,"), answers_arg="sub/a.csv")
add_score("answers_absolute", two(), csv("pair_000,1,no,", "pair_001,2,no,"), answers_arg="<abs>")
add_score("answers_missing", two(), None)
add_score("answers_missing_other", two(), None, answers_arg="gone.csv")
add_score("answers_is_directory", two(), None, answers_arg="adir")
add_score("key_missing", {}, csv("pair_000,1,no,"), raw_key="<absent>")
add_score("key_corrupt", {}, csv("pair_000,1,no,"), raw_key="{nope")
add_score("key_is_list", {}, csv("pair_000,1,no,"), raw_key="[1, 2]")
add_score("key_pair_without_id", {"pairs": [{"edit_file": "1.wav"}]}, csv("pair_000,1,no,"))
add_score("key_pair_count_bad", {"pairs": [], "pair_count": "x"}, HEADER)
add_score("key_limit_bad", {"pairs": [], "limit": "x"}, HEADER)
add_score("key_pair_count_float", {"pairs": [], "pair_count": 2.7, "limit": 2}, HEADER)
add_score("key_pairs_not_iterable", {"pairs": 5}, HEADER)
add_score("key_pairs_strings", {"pairs": ["a"]}, HEADER)
add_score("answers_invalid_utf8", two(), None, raw_answers=b"pair_id,prefer\n\xff\xfe,1\n")
add_score("answers_nul_byte", two(), None, raw_answers=b"pair_id,prefer\npair_000\x00,1\n")
add_score("answers_utf16_bom", two(), None, raw_answers="pair_id,prefer\n".encode("utf-16"))

PreFn = Callable[[Path, Path, Path], None]


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")
