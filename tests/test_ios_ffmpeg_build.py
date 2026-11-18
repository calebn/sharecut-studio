"""Cloud-side pins of the iOS FFmpeg build: script text, contract patches, glue files, forced-include headers."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GLUE_DIR = ROOT / "gui" / "desktop" / "src-tauri" / "ios" / "ffmpeg"
PATCH_DIR = GLUE_DIR / "patches"
SCRIPT = ROOT / "scripts" / "ios" / "build_ffmpeg.sh"
CONTRACT = ROOT / "contracts" / "ffmpeg-build.json"
FAKE_GLUE = ROOT / "tests" / "data" / "ios_ffmpeg_shim" / "fake_glue.c"
TARBALL_ENV = "SC_FFMPEG_SOURCE_TARBALL"
COMPILER = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
NEEDS_CC = pytest.mark.skipif(
    COMPILER is None or sys.platform == "win32", reason="needs a POSIX C compiler"
)
OWN_C_FILES = [
    "sc_ffmpeg_glue.c",
    "sc_ffmpeg_tool.c",
    "sc_ffprobe_tool.c",
    "sc_fftools_stdio.h",
    "sc_exit_map.h",
]
DO_FLAGS = [
    "do_analyze_frames",
    "do_bitexact",
    "do_count_frames",
    "do_count_packets",
    "do_read_frames",
    "do_read_packets",
    "do_show_chapters",
    "do_show_error",
    "do_show_format",
    "do_show_frames",
    "do_show_packets",
    "do_show_programs",
    "do_show_stream_groups",
    "do_show_stream_group_components",
    "do_show_streams",
    "do_show_stream_disposition",
    "do_show_stream_group_disposition",
    "do_show_data",
    "do_show_program_version",
    "do_show_library_versions",
    "do_show_pixel_formats",
    "do_show_pixel_format_flags",
    "do_show_pixel_format_components",
    "do_show_log",
    "do_show_chapter_tags",
    "do_show_format_tags",
    "do_show_frame_tags",
    "do_show_program_tags",
    "do_show_stream_group_tags",
    "do_show_stream_tags",
    "do_show_packet_tags",
]
EXPORTED = ["sc_ffmpeg_abi_version", "sc_ffmpeg_start", "sc_ffmpeg_wait", "sc_ffmpeg_cancel"]


def contract() -> dict:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def function_body(text: str, signature: str) -> str:
    start = text.index(signature)
    while re.match(r"[^;{]*;", text[start + len(signature) :]):
        start = text.index(signature, start + 1)
    depth = 0
    for index in range(text.index("{", start), len(text)):
        depth += {"{": 1, "}": -1}.get(text[index], 0)
        if depth == 0:
            return text[start : index + 1]
    raise AssertionError(f"unbalanced braces after {signature}")


def test_build_script_is_repo_relative_pinned_and_portable() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines[0] == "#!/bin/bash"
    assert lines[1].startswith("# ")
    assert "set -euo pipefail" in text
    assert os.access(SCRIPT, os.X_OK)
    assert "$HOME" not in text and "~/" not in text and "/Users/" not in text
    assert not re.search(r"\bsed\b", text)
    assert "perl -pi" in text
    assert "contracts/ffmpeg-build.json" in text
    assert "python3 -I" in text
    assert '"--proto", "=https"' in text
    assert text.index("sha256") < text.index("tar -xf")
    assert "patch -p1 --dry-run" in text
    for flag in ("-ffile-prefix-map", "-fdebug-prefix-map", "-exported_symbols_list"):
        assert flag in text
    assert "-include sc_fftools_stdio.h -include sc_exit_map.h" in text
    assert "--extra-cflags=" in text
    assert "-arch arm64" in text and "x86_64" not in text
    assert "MINOS=17.0" in text
    assert "studio.sharecut.ffmpeg" in text and "<string>FMWK</string>" in text
    assert "ios-payload" not in text and 'cp -R "$FW' not in text
    for symbol in EXPORTED:
        assert f"_{symbol}" in text
    for source in ("sc_ffmpeg_core.c", "sc_ffmpeg_glue.c", "sc_ffmpeg_tool.c", "sc_ffprobe_tool.c"):
        assert source in text
    assert "-Dmain=sc_ffmpeg_main" in text and "-Dmain=sc_ffprobe_main" in text
    assert "-Dexit" not in text


def test_build_script_parses_and_rejects_bad_arguments() -> None:
    bash = shutil.which("bash")
    assert bash is not None
    assert subprocess.run([bash, "-n", str(SCRIPT)], check=False).returncode == 0
    for args in ([], ["bogus"], ["x86_64"]):
        done = subprocess.run(
            [bash, str(SCRIPT), *args], capture_output=True, text=True, check=False
        )
        assert done.returncode == 2 and "usage" in done.stderr


def test_exported_names_match_the_core_header() -> None:
    header = (GLUE_DIR / "sc_ffmpeg_core.h").read_text(encoding="utf-8")
    assert re.findall(r"SC_EXPORT \w+\s+\**(sc_ffmpeg_\w+)\(", header) == EXPORTED


def test_contract_pins_the_patches_by_sha256() -> None:
    patches = contract()["patches"]
    assert [p["name"] for p in patches] == ["ffmpeg-opt-reset", "ffprobe-no-exit"]
    on_disk = sorted(p.name for p in PATCH_DIR.glob("*.patch"))
    assert on_disk == sorted(f"{p['name']}.patch" for p in patches)
    for patch in patches:
        path = ROOT / patch["path"]
        assert path.parent == PATCH_DIR and path.name == f"{patch['name']}.patch"
        assert re.fullmatch(r"[0-9a-f]{64}", patch["sha256"])
        assert sha256(path) == patch["sha256"]
        assert patch["applies_to"] == "ffmpeg"


def test_contract_keeps_the_desktop_pins_the_ios_script_reads() -> None:
    recipe = contract()
    for key in ("lame_configure", "opus_configure", "ffmpeg_configure", "version"):
        assert key in recipe
    for name in ("ffmpeg", "lame", "opus"):
        assert {"url", "sha256", "archive", "directory"} <= set(recipe["sources"][name])
    assert "--enable-gpl" not in recipe["ffmpeg_configure"]
    assert "--enable-nonfree" not in recipe["ffmpeg_configure"]


def test_patches_use_only_the_pinned_files_and_remove_every_ffprobe_exit() -> None:
    reset = (PATCH_DIR / "ffmpeg-opt-reset.patch").read_text(encoding="utf-8")
    probe = (PATCH_DIR / "ffprobe-no-exit.patch").read_text(encoding="utf-8")
    assert re.findall(r"^\+\+\+ (\S+)", reset, re.M) == ["b/fftools/ffmpeg_opt.c"]
    assert re.findall(r"^\+\+\+ (\S+)", probe, re.M) == ["b/fftools/ffprobe.c"]
    assert "+void sc_ffmpeg_opt_reset(void)" in reset
    assert len(re.findall(r"^-\s+exit\(1\);", probe, re.M)) == 5
    assert not re.findall(r"^\+.*\bexit\(", probe, re.M)


@pytest.mark.skipif(shutil.which("patch") is None, reason="needs patch(1)")
def test_patches_apply_cleanly_to_the_pinned_tree(tmp_path: Path) -> None:
    cached = os.environ.get(TARBALL_ENV)
    if not cached or not Path(cached).is_file():
        pytest.skip(f"set {TARBALL_ENV} to a cached ffmpeg-9.0.2.tar.xz")
    pinned = contract()["sources"]["ffmpeg"]
    assert sha256(Path(cached)) == pinned["sha256"]
    tree = tmp_path / "tree"
    with tarfile.open(cached, "r:xz") as archive:
        for name in ("fftools/ffmpeg_opt.c", "fftools/ffprobe.c"):
            member = archive.getmember(f"{pinned['directory']}/{name}")
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = archive.extractfile(member)
            assert extracted is not None
            target.write_bytes(extracted.read())
    for patch in contract()["patches"]:
        path = str(ROOT / patch["path"])
        for extra in (["--dry-run"], []):
            done = subprocess.run(
                ["patch", "-p1", "--batch", *extra, "-i", path],
                cwd=tree,
                capture_output=True,
                text=True,
                check=False,
            )
            assert done.returncode == 0, done.stdout + done.stderr
    assert "void sc_ffmpeg_opt_reset(void)" in (tree / "fftools/ffmpeg_opt.c").read_text()
    assert not re.search(r"^\s+exit\(1\);", (tree / "fftools/ffprobe.c").read_text(), re.M)


def test_glue_and_wrapper_files_exist_with_one_header_line_only() -> None:
    for name in OWN_C_FILES:
        text = (GLUE_DIR / name).read_text(encoding="utf-8")
        assert text.startswith("/* ") and text.splitlines()[0].endswith(" */"), name
        assert "/*" not in "\n".join(text.splitlines()[1:]), name
        assert "//" not in text, name
    for name in ("README.md", "sc_ffmpeg_core.c", "sc_ffmpeg_core.h"):
        assert (GLUE_DIR / name).is_file()


def test_forced_include_headers_define_the_macros() -> None:
    stdio = (GLUE_DIR / "sc_fftools_stdio.h").read_text(encoding="utf-8")
    for line in (
        "#define stdout (sc_out())",
        "#define stderr (sc_err())",
        "#define printf(...) sc_session_printf(__VA_ARGS__)",
        "#define puts(s) sc_session_puts(s)",
        "#define putchar(c) sc_session_putchar(c)",
        "#define perror(s) sc_session_perror(s)",
        "#define setvbuf(f, buf, mode, size) sc_session_setvbuf(f, buf, mode, size)",
    ):
        assert line in stdio
    assert "#ifndef __ASSEMBLER__" in stdio
    exit_map = (GLUE_DIR / "sc_exit_map.h").read_text(encoding="utf-8")
    assert "#define exit(code) sc_tool_exit(code)" in exit_map
    assert "#ifndef __ASSEMBLER__" in exit_map
    assert not re.search(r"#define exit\s", exit_map)


def test_wrapper_translation_units_reset_what_the_architect_listed() -> None:
    tool = (GLUE_DIR / "sc_ffmpeg_tool.c").read_text(encoding="utf-8")
    assert tool.index("#define term_init sc_term_init_unused") < tool.index(
        '#include "fftools/ffmpeg.c"'
    )
    assert "void term_init(void) {}" in tool
    reset = function_body(tool, "void sc_ffmpeg_tool_reset(void)")
    for name in (
        "received_sigterm",
        "received_nb_signals",
        "transcode_init_done",
        "ffmpeg_exited",
        "restore_tty",
        "copy_ts_first_pts = AV_NOPTS_VALUE",
        "vstats_file = NULL",
        "nb_input_files = 0",
        "nb_output_files = 0",
        "nb_filtergraphs = 0",
        "nb_decoders = 0",
        "stdin_interaction = 1",
        "print_graphs = 0",
        "filter_hw_device = NULL",
        "sc_ffmpeg_opt_reset();",
    ):
        assert name in reset, name
    interrupt = function_body(tool, "void sc_ffmpeg_tool_interrupt(void)")
    assert "SIGTERM" in interrupt and "&received_nb_signals, 2" in interrupt
    probe = (GLUE_DIR / "sc_ffprobe_tool.c").read_text(encoding="utf-8")
    assert '#include "fftools/ffprobe.c"' in probe
    probe_reset = function_body(probe, "void sc_ffprobe_tool_reset(void)")
    for name in ("show_private_data = 1", "find_stream_info = 1", "read_intervals_nb = 0"):
        assert name in probe_reset, name
    for flag in DO_FLAGS:
        assert f"{flag} = 0;" in probe_reset, flag


def test_glue_reset_never_calls_back_into_the_core() -> None:
    glue = (GLUE_DIR / "sc_ffmpeg_glue.c").read_text(encoding="utf-8")
    for signature in ("void sc_glue_reset(void)", "void sc_glue_interrupt(void)"):
        body = function_body(glue, signature)
        for forbidden in ("sc_out", "sc_err", "sc_tool_exit", "sc_ffmpeg_start", "sc_ffmpeg_wait"):
            assert forbidden not in body, (signature, forbidden)
    assert "av_log_set_callback(sc_log)" in glue
    assert "sc_err()" in function_body(glue, "static void sc_log(")
    run = function_body(glue, "int sc_glue_run(")
    assert "avio_closep(&progress_avio)" in run and "vstats_file = NULL" in run


def test_makefile_targets_and_gitignore() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    phony = makefile.splitlines()[0]
    for target, argument in (("ios-ffmpeg-device", "device"), ("ios-ffmpeg-sim", "sim")):
        assert target in phony.split()
        assert re.search(
            rf"^{target}:\n\t\./scripts/ios/build_ffmpeg\.sh {argument}$", makefile, re.M
        )
    assert "ios-ffmpeg" in phony.split()
    assert re.search(r"^ios-ffmpeg: ios-ffmpeg-device ios-ffmpeg-sim$", makefile, re.M)
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    for name in ("src", "build", "out"):
        assert f"gui/desktop/src-tauri/ios-ffmpeg/{name}/" in ignored


def test_source_offer_matches_the_contract() -> None:
    offer = (ROOT / "LICENSES" / "FFMPEG-SOURCE.txt").read_text(encoding="utf-8")
    recipe = contract()
    for name in ("ffmpeg", "lame", "opus"):
        assert recipe["sources"][name]["sha256"] in offer
        assert recipe["sources"][name]["url"] in offer
    for patch in recipe["patches"]:
        assert patch["sha256"] in offer
    assert "scripts/ios/build_ffmpeg.sh" in offer
    assert "pending" in offer


def _cc(args: list[str], tmp: Path) -> None:
    assert COMPILER is not None
    done = subprocess.run(
        [COMPILER, "-fPIC", "-g", "-O1", "-pthread", "-Wall", "-Wextra", "-Werror", *args],
        cwd=tmp,
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr


@NEEDS_CC
def test_core_and_fake_glue_still_build_without_warnings(tmp_path: Path) -> None:
    _cc(
        [
            "-shared",
            "-I",
            str(GLUE_DIR),
            "-o",
            "libcore.so",
            str(GLUE_DIR / "sc_ffmpeg_core.c"),
            str(FAKE_GLUE),
        ],
        tmp_path,
    )
    assert (tmp_path / "libcore.so").is_file()


SMOKE_C = textwrap.dedent(
    """
    #include <errno.h>
    #include <stdio.h>
    #include <stdlib.h>

    int smoke_entry(int argc, char **argv) {
        printf("printf %d\\n", argc);
        puts("puts");
        putchar('c');
        putchar('\\n');
        fprintf(stdout, "fprintf-stdout\\n");
        fputs("fputs-stderr\\n", stderr);
        fprintf(stderr, "fprintf-stderr\\n");
        errno = ENOENT;
        perror("smoke");
        setvbuf(stderr, NULL, _IOFBF, 4096);
        fprintf(stderr, "after-setvbuf\\n");
        if (argc > 1 && argv[1][0] == 'x') exit(7);
        return 3;
    }
    """
)

SMOKE_GLUE_C = textwrap.dedent(
    """
    #include "sc_ffmpeg_core.h"
    int smoke_entry(int argc, char **argv);
    int sc_glue_run(int tool, int argc, char **argv) { (void)tool; return smoke_entry(argc, argv); }
    void sc_glue_reset(void) {}
    void sc_glue_interrupt(void) {}
    """
)

SMOKE_DRIVER = textwrap.dedent(
    """
    import ctypes, json, os, sys
    lib = ctypes.CDLL(sys.argv[1])
    lib.sc_ffmpeg_start.restype = ctypes.c_int64
    lib.sc_ffmpeg_start.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)] + [ctypes.c_int] * 3
    lib.sc_ffmpeg_wait.argtypes = [ctypes.c_int64]
    result = {}
    for mode in ("ret", "x"):
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        argv = [b"ffprobe", mode.encode(), None]
        array = (ctypes.c_char_p * 3)(*argv)
        session = lib.sc_ffmpeg_start(2, array, -1, out_w, err_w)
        os.close(out_w)
        os.close(err_w)
        code = lib.sc_ffmpeg_wait(session)
        chunks = []
        for fd in (out_r, err_r):
            data = b""
            while True:
                block = os.read(fd, 65536)
                if not block:
                    break
                data += block
            os.close(fd)
            chunks.append(data.decode())
        result[mode] = [code, chunks[0], chunks[1]]
    sys.stdout.write(json.dumps(result))
    """
)


@NEEDS_CC
def test_forced_includes_route_output_through_the_session_and_exit_to_the_core(
    tmp_path: Path,
) -> None:
    (tmp_path / "smoke.c").write_text(SMOKE_C, encoding="utf-8")
    (tmp_path / "smoke_glue.c").write_text(SMOKE_GLUE_C, encoding="utf-8")
    include = ["-I", str(GLUE_DIR)]
    _cc(
        [
            "-c",
            *include,
            "-include",
            "sc_fftools_stdio.h",
            "-include",
            "sc_exit_map.h",
            "-o",
            "smoke.o",
            "smoke.c",
        ],
        tmp_path,
    )
    _cc(
        [
            "-shared",
            *include,
            "-o",
            "libsmoke.so",
            str(GLUE_DIR / "sc_ffmpeg_core.c"),
            "smoke_glue.c",
            "smoke.o",
        ],
        tmp_path,
    )
    driver = tmp_path / "driver.py"
    driver.write_text(SMOKE_DRIVER, encoding="utf-8")
    done = subprocess.run(
        [sys.executable, "-I", str(driver), str(tmp_path / "libsmoke.so")],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    result = json.loads(done.stdout)
    out = "printf 2\nputs\nc\nfprintf-stdout\n"
    err = "fputs-stderr\nfprintf-stderr\nsmoke: No such file or directory\nafter-setvbuf\n"
    assert result["ret"] == [3, out, err]
    assert result["x"] == [7, out, err]


@NEEDS_CC
def test_the_headers_do_nothing_when_assembling(tmp_path: Path) -> None:
    source = tmp_path / "asm.S"
    source.write_text('#include "sc_fftools_stdio.h"\n#include "sc_exit_map.h"\n', "utf-8")
    assert COMPILER is not None
    done = subprocess.run(
        [COMPILER, "-E", "-I", str(GLUE_DIR), str(source)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert "sc_session_printf" not in done.stdout
