"""Drive the host build of the sc_whisper_* shim (scripts/ios/build_whisper.sh host) through ctypes.

Manual check, needs a ggml model and a speech WAV; see gui/desktop/src-tauri/ios/whisper/README.md.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

CANCEL_GRACE_SEC = 5.0


class Shim:
    def __init__(self, path: Path) -> None:
        self.lib = ctypes.CDLL(str(path))
        self.lib.sc_whisper_abi_version.restype = ctypes.c_int
        self.lib.sc_whisper_start.restype = ctypes.c_int64
        self.lib.sc_whisper_start.argtypes = [
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        ]
        self.lib.sc_whisper_wait.restype = ctypes.c_int
        self.lib.sc_whisper_wait.argtypes = [ctypes.c_int64]
        self.lib.sc_whisper_cancel.restype = None
        self.lib.sc_whisper_cancel.argtypes = [ctypes.c_int64]

    def start(self, argv: list[str], err_fd: int = -1, out_fd: int = -1) -> int:
        encoded = [item.encode() for item in argv]
        array = (ctypes.c_char_p * (len(encoded) + 1))(*encoded, None)
        return int(self.lib.sc_whisper_start(len(encoded), array, -1, out_fd, err_fd))

    def run(self, argv: list[str], err_path: Path) -> tuple[int, str]:
        with open(err_path, "wb") as err:
            session = self.start(argv, err_fd=err.fileno())
            assert session >= 1, session
            code = int(self.lib.sc_whisper_wait(session))
        return code, err_path.read_text(encoding="utf-8", errors="replace")


def long_wav(source: Path, target: Path, seconds: int) -> None:
    with wave.open(str(source), "rb") as handle:
        params = handle.getparams()
        frames = handle.readframes(handle.getnframes())
    per = params.nframes / params.framerate
    with wave.open(str(target), "wb") as out:
        out.setparams(params)
        for _ in range(int(seconds / per) + 1):
            out.writeframes(frames)


def segments(path: Path) -> list[dict[str, object]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        {
            "offsets": item["offsets"],
            "text": item["text"],
            "tokens": [t["text"] for t in item["tokens"]],
        }
        for item in data["transcription"]
    ]


def check(condition: bool, label: str, report: dict[str, object], value: object = None) -> None:
    report[label] = value if value is not None else condition
    if not condition:
        print(json.dumps(report, indent=2, default=str))
        sys.exit("FAILED: " + label)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lib", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--host-cli", type=Path)
    parser.add_argument("--long-seconds", type=int, default=1800)
    args = parser.parse_args()

    report: dict[str, object] = {}
    shim = Shim(args.lib)
    check(shim.lib.sc_whisper_abi_version() == 1, "abi_version_is_1", report)
    pid = os.getpid()

    with tempfile.TemporaryDirectory(prefix="whisper-host-check-") as tmp_name:
        tmp = Path(tmp_name)
        base = ["whisper-cli", "-m", str(args.model), "-f", str(args.wav), "-ojf", "-np"]

        started = time.monotonic()
        code, _ = shim.run([*base, "-of", str(tmp / "a")], tmp / "a.err")
        report["transcribe_sec"] = round(time.monotonic() - started, 2)
        check(code == 0 and (tmp / "a.json").is_file(), "transcribe_exit_0_and_json", report)
        first = segments(tmp / "a.json")
        check(
            bool(first) and any(str(s["text"]).strip() for s in first),
            "transcript_not_empty",
            report,
        )
        report["transcript"] = " ".join(str(s["text"]).strip() for s in first)

        code, _ = shim.run([*base, "-of", str(tmp / "b")], tmp / "b.err")
        check(code == 0 and segments(tmp / "b.json") == first, "second_session_same_json", report)

        if args.host_cli:
            done = subprocess.run(
                [str(args.host_cli), *base[1:], "-ng", "-of", str(tmp / "h")],
                capture_output=True,
                check=False,
            )
            check(done.returncode == 0, "host_cli_ok", report)
            check(segments(tmp / "h.json") == first, "json_matches_host_cli", report)

        check(shim.start(["whisper", "-m", "x"]) == -errno.EINVAL, "bad_argv0_is_EINVAL", report)
        code = int(shim.lib.sc_whisper_wait(shim.start(["whisper-cli", "--version"])))
        check(code == 1, "unsupported_flag_exit_1", report, code)
        code, err = shim.run(
            [
                "whisper-cli",
                "-m",
                str(tmp / "missing.bin"),
                "-f",
                str(args.wav),
                "-ojf",
                "-of",
                str(tmp / "m"),
            ],
            tmp / "m.err",
        )
        check(
            code != 0 and "model file not found" in err,
            "missing_model_nonzero_no_exit",
            report,
            code,
        )
        code, err = shim.run(
            [
                "whisper-cli",
                "-m",
                str(args.model),
                "-f",
                str(args.wav),
                "-ojf",
                "-of",
                str(tmp / "v"),
            ],
            tmp / "v.err",
        )
        check(code == 0 and "system_info" in err, "logs_reach_the_session_stderr", report)
        code, _ = shim.run([*base, "-of", str(tmp / "l"), "-l", "zz"], tmp / "l.err")
        check(code == 1, "unknown_language_exit_1_no_process_exit", report, code)
        check(os.getpid() == pid, "process_still_alive", report)

        long_path = tmp / "long.wav"
        long_wav(args.wav, long_path, args.long_seconds)
        long_base = [
            "whisper-cli",
            "-m",
            str(args.model),
            "-f",
            str(long_path),
            "-ojf",
            "-np",
            "-of",
            str(tmp / "c"),
        ]
        latencies: list[float] = []
        for delay in (0.0, 1.0, 3.0):
            with open(tmp / "c.err", "wb") as err_file:
                session = shim.start(long_base, err_fd=err_file.fileno())
                assert session >= 1
                time.sleep(delay)
                began = time.monotonic()
                shim.lib.sc_whisper_cancel(session)
                shim.lib.sc_whisper_cancel(session)
                code = int(shim.lib.sc_whisper_wait(session))
                latencies.append(round(time.monotonic() - began, 3))
            check(code == 255, f"cancel_after_{delay}s_exit_255", report, code)
        report["cancel_latency_sec"] = latencies
        check(max(latencies) < CANCEL_GRACE_SEC, "cancel_within_grace", report)
        check(
            int(shim.lib.sc_whisper_wait(session)) == -errno.ESRCH,
            "wait_after_claim_is_ESRCH",
            report,
        )

        waiter: list[int] = []
        session = shim.start(long_base, err_fd=-1)
        thread = threading.Thread(
            target=lambda: waiter.append(int(shim.lib.sc_whisper_wait(session)))
        )
        thread.start()
        time.sleep(1.0)
        shim.lib.sc_whisper_cancel(session)
        thread.join(CANCEL_GRACE_SEC + 5)
        check(waiter == [255], "cancel_from_another_thread_while_waiting", report, waiter)

        code, _ = shim.run([*base, "-of", str(tmp / "d")], tmp / "d.err")
        check(
            code == 0 and segments(tmp / "d.json") == first,
            "session_after_cancel_still_works",
            report,
        )

    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
