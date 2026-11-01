from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import evidence_records, track_evidence
from podcast_mcp.engines.decoded_source import SPILL_HEADROOM_BYTES
from podcast_mcp.models import save_project
from test_audio_eval import _project

ROOT = Path(__file__).resolve().parents[1]
_RECORD_RESERVE_BYTES = 32 << 20
_CHILD = """
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import evidence_records, track_evidence
from podcast_mcp.engines.decoded_source import SPILL_HEADROOM_BYTES
from podcast_mcp.models import load_project

root = Path(sys.argv[3]).resolve()
source = Path(track_evidence.__file__).resolve()
assert source == root / "src/podcast_mcp/engines/track_evidence.py"
assert SPILL_HEADROOM_BYTES == evidence_records.SPILL_HEADROOM_BYTES == 2 << 30
events = io.StringIO()
handler = logging.StreamHandler(events)
logger = logging.getLogger(track_evidence.__name__)
logger.setLevel(logging.INFO)
logger.addHandler(handler)
samples = track_evidence.rms(load_project(Path(sys.argv[1])), "caleb", load_defaults()).samples
np.save(sys.argv[2], samples, allow_pickle=False)
print(json.dumps({
    "pid": os.getpid(),
    "source": str(source),
    "source_sha": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
    "sample_sha256": hashlib.sha256(samples.tobytes()).hexdigest(),
    "events": events.getvalue().splitlines(),
}))
"""


def test_native_producer_record_is_reused_in_a_fresh_process(
    tmp_path: Path, record_property: Callable[[str, object], None]
) -> None:
    required = SPILL_HEADROOM_BYTES + _RECORD_RESERVE_BYTES
    free = shutil.disk_usage(tmp_path).free
    if free <= required:
        pytest.skip(
            f"Native evidence recording needs {required} bytes including its unchanged "
            f"{SPILL_HEADROOM_BYTES}-byte headroom; only {free} bytes are free."
        )
    project = _project(tmp_path, "crossfade joins")
    project_file = save_project(project)
    sources = sorted(
        path for path in (project.workspace_path() / "raw").iterdir() if path.is_file()
    )
    deadline = time.monotonic() + 10
    tick = threading.Event()
    while any(
        time.time_ns() - max(path.stat().st_mtime_ns, path.stat().st_ctime_ns)
        < track_evidence.RACY_SECONDS * 1e9
        for path in sources
    ):
        assert time.monotonic() < deadline, (
            "The disposable sources did not become old enough to record."
        )
        tick.wait(0.02)
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT / "src"),
        "PODCAST_CONFIG_DIR": str(tmp_path / "config"),
        "PODCAST_MCP_CACHE": str(tmp_path / "cache"),
        "PODCAST_SHARE_REGISTRY": str(tmp_path / "registry.sqlite"),
        "PODCAST_SHARE_IDENTITY": str(tmp_path / "identity.sqlite"),
        "PODCAST_WORKSPACE_ROOT": str(tmp_path),
        "PODCAST_EVIDENCE_KEEP_MB": "64",
        "PODCAST_EVIDENCE_VERIFY": "0",
        "TMPDIR": str(tmp_path / "temp"),
    }
    Path(env["TMPDIR"]).mkdir()
    source_sha = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True
    ).strip()

    def run(name: str) -> dict:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                _CHILD,
                str(project_file),
                str(tmp_path / f"{name}.npy"),
                str(ROOT),
            ],
            cwd=ROOT,
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return json.loads(result.stdout)

    producer = run("producer")
    records = list((project.artifacts_dir() / evidence_records.RECORD_DIR).glob("*.evd"))
    assert len(records) == 1
    record_bytes = records[0].read_bytes()
    assert any(event.startswith("evidence build rates=") for event in producer["events"])
    assert not any(event.startswith("evidence read from record") for event in producer["events"])

    consumer = run("consumer")

    assert producer["pid"] != consumer["pid"]
    assert producer["source_sha"] == consumer["source_sha"] == source_sha
    assert (
        producer["source"]
        == consumer["source"]
        == str(ROOT / "src/podcast_mcp/engines/track_evidence.py")
    )
    assert any(event.startswith("evidence read from record") for event in consumer["events"])
    assert not any(event.startswith("evidence build rates=") for event in consumer["events"])
    assert records[0].read_bytes() == record_bytes
    built = np.load(tmp_path / "producer.npy", allow_pickle=False)
    read = np.load(tmp_path / "consumer.npy", allow_pickle=False)
    assert built.dtype == read.dtype == np.float32
    np.testing.assert_array_equal(read.view(np.uint32), built.view(np.uint32))
    assert producer["sample_sha256"] == consumer["sample_sha256"]
    proof = {
        "producer_pid": producer["pid"],
        "consumer_pid": consumer["pid"],
        "source_sha": source_sha,
        "sample_sha256": producer["sample_sha256"],
        "record_sha256": hashlib.sha256(record_bytes).hexdigest(),
        "record_count": len(records),
    }
    for name, value in proof.items():
        record_property(name, value)
    print("native_evidence_process_proof " + json.dumps(proof, sort_keys=True))
