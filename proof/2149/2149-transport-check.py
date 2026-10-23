import base64
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


host = module("host", "2149-transport-host.py")
stage = module("stage", "2149-transport-stage.py")


def log_lines(payload):
    raw = host.encoded(payload)
    b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    chunks = [b64[i : i + 40] for i in range(0, len(b64), 40)]
    lines = []
    for index in range(len(chunks) + 1):
        query = urlencode(
            {
                "v": "1",
                "run": "a" * 32,
                "e": "0",
                "k": "d" if index < len(chunks) else "end",
                "i": index,
                "n": len(chunks),
                "h": host.sha(raw),
                "l": len(raw),
                "b": chunks[index] if index < len(chunks) else "",
            }
        )
        lines.append(f'INFO: 127.0.0.1:1 - "GET /assets/private.txt?{query} HTTP/1.1" 200 OK')
    return lines


class Checks(unittest.TestCase):
    def test_chunk_integrity(self):
        payload = {"synthetic": True, "rows": ["x" * 150]}
        lines = log_lines(payload)
        args = "/assets/private.txt", "a" * 32, 0
        self.assertEqual(host.receipt("\n".join(reversed(lines)), *args)[0], payload)
        self.assertIsNone(host.receipt("\n".join(lines[:-1]), *args))
        self.assertIsNone(host.receipt("\n".join(lines[1:]), *args))
        with self.assertRaises(ValueError):
            host.receipt("\n".join(lines).replace("200 OK", "404 Not Found", 1), *args)
        with self.assertRaises(ValueError):
            host.receipt("\n".join([*lines, lines[0].replace("&b=", "&b=X")]), *args)

    def test_stage_preserves_original_and_refuses_overlap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "assets").mkdir()
            original = b'<html><head><meta charset="utf-8"><script type="module" src="/assets/app.js"></script></head></html>'
            (source / "index.html").write_bytes(original)
            (source / "assets/app.js").write_text("globalThis.app=true")
            manifest = stage.stage(
                source,
                root / "out",
                ROOT / "2149-next-nav-gate.js",
                ROOT / "2149-transport-bridge.js",
                "http://127.0.0.1:1/",
                "http://127.0.0.1:1/",
            )
            self.assertEqual(stage.inventory(source), manifest["original_files_sha256"])
            self.assertEqual(
                len(set(stage.inventory(root / "out")) - set(stage.inventory(source))), 3
            )
            self.assertEqual(
                (root / "out/index.html")
                .read_bytes()
                .replace(manifest["html_insertion"].encode(), b""),
                original,
            )
            self.assertEqual(
                json.loads((root / "out" / manifest["command_path"]).read_text())["epoch"], 0
            )
            with self.assertRaises(ValueError):
                stage.stage(
                    source,
                    source / "nested",
                    ROOT / "2149-next-nav-gate.js",
                    ROOT / "2149-transport-bridge.js",
                    "http://127.0.0.1:1/",
                    "http://127.0.0.1:1/",
                )

    def test_private_paths_and_all_condition_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            static = root / "static"
            command_name = "assets/qa2149-" + "a" * 32 + "-commands.json"
            command = static / command_name
            command.parent.mkdir(parents=True)
            host.atomic(
                command,
                {
                    "v": 1,
                    "run": "a" * 32,
                    "epoch": 0,
                    "prev": None,
                    "op": "export",
                    "label": "ready",
                },
            )
            manifest = {
                "run": "a" * 32,
                "output_dist": str(static),
                "command_path": command_name,
                "receipt_url": "http://localhost/assets/qa2149-" + "a" * 32 + "-receipt.txt",
            }
            h = host.Host(manifest, root / "log", root / "out")
            h.deadline = host.time.monotonic() + 100
            for condition in ["sham", "armed"]:
                with self.assertRaisesRegex(ValueError, "GESTURE PHASES DISABLED"):
                    h.exchange(condition, "must-refuse")
            self.assertEqual(json.loads(command.read_text())["epoch"], 0)
            h.expected_condition = "sham"
            h.await_receipt = lambda epoch: {
                "op": "mark",
                "label": "wrong-condition",
                "condition": "armed",
            }
            with self.assertRaisesRegex(ValueError, "condition mismatch"):
                h.exchange("mark", "wrong-condition")
            self.assertFalse(h.lock.is_relative_to(static))
            h.close(False)
            self.assertTrue(h.lock.exists())
            for bad in ["../outside", "/tmp/outside", "assets/app.js"]:
                broken = dict(manifest, command_path=bad)
                with self.assertRaisesRegex(ValueError, "exact private run asset"):
                    host.Host(broken, root / "log", root / ("out-" + host.sha(bad.encode())[:8]))
            with self.assertRaisesRegex(RuntimeError, "GESTURE PHASES DISABLED"):
                host.run(None, "compare")

    def test_real_js_receipts_reassemble(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "log"
            subprocess.run(["node", str(ROOT / "2149-transport-check.cjs"), str(log)], check=True)
            for epoch in range(4):
                data, digest = host.receipt(log.read_text(), "/assets/private.txt", "a" * 32, epoch)
                self.assertEqual(data["epoch"], epoch)
                self.assertEqual(len(digest), 64)


if __name__ == "__main__":
    unittest.main()
