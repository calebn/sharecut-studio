from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def atomic(path, value, temporary_dir=None):
    fd, name = tempfile.mkstemp(prefix=".2149-", dir=temporary_dir or path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def receipt(raw, path, run, epoch):
    chunks, end, meta = {}, False, None
    for line in raw.splitlines():
        match = re.search(r'"GET ([^" ]+) HTTP/1\.[01]" (\d{3})(?:\s|$)', line)
        if not match:
            continue
        target = urlsplit(match[1])
        if target.path != path:
            continue
        fields = parse_qs(target.query, keep_blank_values=True, strict_parsing=True)
        if any(len(values) != 1 for values in fields.values()):
            raise ValueError("Duplicate query key")
        q = {key: value[0] for key, value in fields.items()}
        if q.get("run") != run or q.get("e") != str(epoch):
            continue
        if set(q) != {"v", "run", "e", "k", "i", "n", "h", "l", "b"} or q["v"] != "1":
            raise ValueError("Malformed matching receipt query")
        if match[2] != "200":
            raise ValueError("Receipt request did not return 200")
        count, length, index = int(q["n"]), int(q["l"]), int(q["i"])
        if not (1 <= count <= 285 and 0 < length <= 192000) or not re.fullmatch(
            r"[a-f0-9]{64}", q["h"]
        ):
            raise ValueError("Unbounded receipt metadata")
        current = count, length, q["h"]
        if meta and meta != current:
            raise ValueError("Conflicting receipt metadata")
        meta = current
        if q["k"] == "end" and index == count and not q["b"]:
            end = True
        elif q["k"] == "d" and 0 <= index < count and re.fullmatch(r"[A-Za-z0-9_-]{1,900}", q["b"]):
            if index in chunks and chunks[index] != q["b"]:
                raise ValueError("Conflicting duplicate chunk")
            chunks[index] = q["b"]
        else:
            raise ValueError("Invalid receipt chunk")
    if not meta or not end or len(chunks) != meta[0]:
        return None
    b64 = "".join(chunks[i] for i in range(meta[0]))
    body = base64.b64decode(b64 + "=" * (-len(b64) % 4), altchars=b"-_", validate=True)
    if len(body) != meta[1] or sha(body) != meta[2]:
        raise ValueError("Truncated/corrupt receipt")
    return json.loads(body), meta[2]


class Host:
    def __init__(self, manifest, log, output):
        self.manifest = manifest
        self.log = log
        self.output = output
        static = Path(manifest["output_dist"]).resolve()
        self.static = static
        if output.resolve().is_relative_to(static) or log.resolve().is_relative_to(static):
            raise ValueError("Private output/log must be outside served static root")
        output.mkdir(mode=0o700, exist_ok=False)
        self.command_path = Path(manifest["output_dist"]) / manifest["command_path"]
        expected_command = f"assets/qa2149-{manifest['run']}-commands.json"
        if (
            not re.fullmatch(r"[a-f0-9]{32}", manifest["run"])
            or manifest["command_path"] != expected_command
            or not self.command_path.resolve().is_relative_to(static)
        ):
            raise ValueError("Command path must be the exact private run asset inside static")
        if self.command_path.is_symlink() or json.loads(self.command_path.read_text()) != {
            "v": 1,
            "run": manifest["run"],
            "epoch": 0,
            "prev": None,
            "op": "export",
            "label": "ready",
        }:
            raise ValueError(
                "Expected fresh lifecycle command file; never resume/retry uncertain run"
            )
        self.run = manifest["run"]
        self.path = urlsplit(manifest["receipt_url"]).path
        if self.path != f"/assets/qa2149-{self.run}-receipt.txt":
            raise ValueError("Receipt path must match private run asset")
        self.epoch, self.previous, self.instance = -1, None, None
        self.log_size = 0
        self.log_inode = None
        self.deadline = None
        self.last = None
        private = static.parent / (static.name + "-qa2149-private-" + self.run)
        if private.is_symlink():
            raise ValueError("Private state directory cannot be a symlink")
        private.mkdir(mode=0o700, exist_ok=True)
        if private.stat().st_mode & 0o077:
            raise ValueError("Private state directory must have0700 permissions")
        self.private = private
        self.lock = private / "host-lock"
        self.lock_fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)

    def close(self, success):
        os.close(self.lock_fd)
        if success:
            self.lock.unlink()
        else:
            self.lock.write_text(
                "STOP: uncertain/invalid lifecycle; preserve logs, no retry or phase advance\n"
            )

    def read_log(self):
        stat = self.log.stat()
        if self.log_inode is not None and (
            stat.st_ino != self.log_inode or stat.st_size < self.log_size
        ):
            raise ValueError("Access log rotated/truncated")
        if stat.st_size > 16000000:
            raise ValueError("Access log exceeds bounded private size")
        self.log_inode, self.log_size = stat.st_ino, stat.st_size
        return self.log.read_text(errors="strict")

    def await_receipt(self, epoch, timeout=6):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            found = receipt(self.read_log(), self.path, self.run, epoch)
            if found:
                data, digest = found
                if (
                    data["run"] != self.run
                    or data["epoch"] != epoch
                    or data["prev"] != self.previous
                ):
                    raise ValueError("Wrong command chain")
                if self.instance and data["instance"] != self.instance:
                    raise ValueError("Document/gate instance replaced")
                for actual, expected in [
                    ("document_identity", "document_url"),
                    ("base_identity", "base_uri"),
                ]:
                    url = self.manifest[expected]
                    parts = urlsplit(url)
                    identity = data[actual]
                    if (
                        identity["sha256"] != sha(url.encode())
                        or identity["pathname"] != parts.path
                    ):
                        raise ValueError("Document URL/base changed")
                if data["condition"] == "stopped" and not (
                    data["op"] == "remove" and data["cleanup"] and data["stopReason"] == "removed"
                ):
                    raise ValueError("Gate timed out/capped; invalid run")
                if data["touchCount"] or data["activePointerIds"]:
                    raise ValueError(
                        "Observed contact still active; native completion alone insufficient"
                    )
                if self.instance is None:
                    self.instance = data["instance"]
                    self.deadline = time.monotonic() + data["remaining_ms"] / 1000 - timeout
                if data["remaining_ms"] <= 0:
                    raise ValueError("Gate lifetime exhausted")
                self.previous, self.epoch, self.last = digest, epoch, data
                (self.output / f"ack-{epoch}.json").write_text(
                    json.dumps({"sha256": digest, "receipt": data}, indent=2) + "\n"
                )
                return data
            time.sleep(0.05)
        raise TimeoutError("No full status-200/hash/end receipt; parser/log capability unproved")

    def exchange(self, op, label):
        if time.monotonic() + 7 >= self.deadline:
            raise TimeoutError("Insufficient unchanged gate lifetime")
        if op in {"sham", "armed"}:
            raise ValueError(
                "GESTURE PHASES DISABLED: current Mac completion/release validator unavailable"
            )
        command = {
            "v": 1,
            "run": self.run,
            "epoch": self.epoch + 1,
            "prev": self.previous,
            "op": op,
            "label": label,
        }
        atomic(self.command_path, command, self.private)
        data = self.await_receipt(command["epoch"])
        if data["op"] != op or data["label"] != label:
            raise ValueError("Command ACK mismatch")
        expected = (
            op
            if op in {"sham", "armed"}
            else ("stopped" if op == "remove" else self.expected_condition)
        )
        if data["condition"] != expected:
            raise ValueError("Command ACK condition mismatch")
        self.expected_condition = expected
        return data


def run(host, mode):
    if mode == "compare":
        raise RuntimeError(
            "GESTURE PHASES DISABLED: need actual Mac per-invocation completion/release receipts and validated parser; exit0 is process-only"
        )
    ready = host.await_receipt(0)
    host.expected_condition = "sham"
    if ready["op"] != "export" or ready["condition"] != "sham":
        raise ValueError("Expected first SHAM ready receipt")
    metadata = ready["metadata"]
    if (
        metadata["readyState"] != "loading"
        or metadata["currentScriptMarker"] != "prebootstrap-nav-gate"
        or len(metadata["scriptsAtInstall"]) != 1
    ):
        raise ValueError("Gate not first/parser-loading")
    if mode == "preflight":
        try:
            host.exchange("armed", "must-refuse")
        except ValueError as error:
            if "GESTURE PHASES DISABLED" not in str(error):
                raise
        else:
            raise AssertionError("Premature ARMED accepted")
        host.exchange("mark", "preflight-mark")
        host.exchange("export", "preflight-export")
        host.exchange("remove", "preflight-remove")
        report = {
            "result": "PASS",
            "native_release_validation": "UNAVAILABLE-NOT-RUN",
            "run": host.run,
            "instance": host.instance,
            "gate_sha256": host.manifest["gate_sha256"],
            "final_ack_sha256": host.previous,
            "tool_sha256": host.manifest["tool_sha256"],
            "limit": "No gestures. Exit0 is process-only, NOT native release validation. Gesture phases disabled pending actual Mac per-invocation receipt/parser.",
        }
        (host.output / "preflight-report.json").write_text(json.dumps(report, indent=2) + "\n")
        return "NO-GESTURE transport PASS; no native subprocess, release validation or gesture efficacy"


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["preflight", "compare"])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--access-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "compare":
        parser.error(
            "GESTURE PHASES DISABLED: actual current-invocation Mac completion/release validator is not available"
        )
    manifest = json.loads(args.manifest.read_text())
    actual_tools = {
        path.name: sha(path.read_bytes())
        for path in sorted(Path(__file__).parent.iterdir())
        if path.is_file() and path.suffix in {".js", ".cjs", ".py", ".md"}
    }
    if actual_tools != manifest["tool_sha256"]:
        parser.error("Tool/package bytes changed since staging; stale preflight refused")
    host = Host(manifest, args.access_log, args.output)
    success = False
    try:
        print(run(host, args.mode))
        success = True
    finally:
        host.close(success)
