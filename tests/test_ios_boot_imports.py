"""The engine boots and serves a project on only the packages the iOS payload keeps.

Runs the real boot line in a child interpreter with the top-level modules of every package the
payload plan drops made unimportable, then walks the routes the phone shell uses.
"""

from __future__ import annotations

import importlib.metadata as metadata
import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

from script_loader import load_script

payload = load_script("ios/build_payload", register=True)
ROOT = Path(__file__).resolve().parents[1]

CHILD = textwrap.dedent(
    """
    import json, sys, urllib.request
    for name in json.loads(sys.argv[1]):
        sys.modules[name] = None
    from podcast_mcp.gui import embedded_boot
    line = embedded_boot.boot_line()
    kind, _, rest = line.partition(" ")
    assert kind == "ok", line
    base = f"http://127.0.0.1:{rest.split()[0]}"

    def call(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            base + path, data=data, method="GET" if body is None else "POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())

    print(json.dumps({
        "health": call("/api/health"),
        "audio": call("/api/bootstrap/status"),
        "created": bool(call("/api/project/create", {"name": "Boot check"})),
    }))
    """
)


def dropped_modules() -> list[str]:
    uv = shutil.which("uv")
    assert uv is not None
    contract = payload.load_contract()
    export = subprocess.run(
        [uv, "export", *contract.uv_export_args, "--format", "requirements.txt"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    plan = payload.plan_packages(
        payload.parse_export(export),
        payload.parse_lock((ROOT / "uv.lock").read_text(encoding="utf-8")),
        contract,
    )
    dropped = {pkg.name for pkg in plan.of(payload.PackageClass.EXCLUDED)}
    modules: set[str] = set()
    for top, distributions in metadata.packages_distributions().items():
        if {payload.canonicalize_name(name) for name in distributions} & dropped:
            modules.add(top)
    return sorted(modules)


def test_the_engine_boots_and_creates_a_project_without_the_dropped_packages(
    tmp_path: Path,
) -> None:
    blocked = dropped_modules()
    assert {"mcp", "cryptography", "rpds", "boto3", "botocore"} <= set(blocked)
    home = tmp_path / "home"
    home.mkdir()
    result = subprocess.run(
        [sys.executable, "-I", "-c", CHILD, json.dumps(blocked)],
        capture_output=True,
        text=True,
        timeout=120,
        env={
            "HOME": str(home),
            "PODCAST_MCP_CACHE": str(tmp_path / "cache"),
            "PODCAST_CONFIG_DIR": str(tmp_path / "config"),
            "PATH": "/usr/bin:/bin",
        },
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    answers = json.loads(result.stdout.strip().splitlines()[-1])
    assert answers["health"] == {"ok": True}
    assert answers["created"] is True
