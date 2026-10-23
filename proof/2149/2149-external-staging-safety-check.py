from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location(
    "external_stage", HERE / "2149-external-stage-document.py"
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Scripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[dict[str, str | None]] = []
        self.script_text: list[str] = []
        self.in_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script":
            self.tags.append(dict(attrs))
            self.in_script = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self.in_script = False

    def handle_data(self, data: str) -> None:
        if self.in_script:
            self.script_text.append(data)


def refused(callable_) -> None:
    try:
        callable_()
        raise AssertionError("Expected invalid fixture to be refused")
    except ValueError:
        pass


with tempfile.TemporaryDirectory(prefix="2149-external-safety-") as directory:
    root = Path(directory)
    source = root / "original"
    source.mkdir()
    (source / "assets").mkdir()
    html = (
        '<!doctype html><html><head><!-- é: <script> -->\n<meta charset="UTF-8">'
        '<base href="http://127.0.0.1:8123/nested/">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<script type="module" src="/assets/app.js"></script></head><body></body></html>'
    ).encode()
    (source / "index.html").write_bytes(html)
    (source / "assets/app.js").write_bytes(b"window.fixtureApp = true;")
    (source / "assets/app.css").write_bytes(b"body{}")
    before = module.inventory(source)
    output = root / "staged"
    url, base = "http://127.0.0.1:8123/", "http://127.0.0.1:8123/nested/"
    manifest = module.stage(source, output, HERE / "2149-next-nav-gate.js", url, base)
    assert module.inventory(source) == before
    assert set(module.inventory(output)) == set(before) | {manifest["added_gate_path"]}
    parsed = Scripts()
    parsed.feed((output / "index.html").read_text())
    assert len(parsed.tags) == 2 and not parsed.script_text
    assert parsed.tags[0] == {"data-qa-2149": "prebootstrap-nav-gate", "src": manifest["gate_url"]}
    assert parsed.tags[1].get("src") == "/assets/app.js"
    assert manifest["gate_sha256"] in manifest["added_gate_path"]
    assert module.origin(module.urljoin(base, manifest["gate_url"])) == module.origin(url)
    for bad in [output, source / "nested"]:
        refused(
            lambda bad=bad: module.stage(source, bad, HERE / "2149-next-nav-gate.js", url, base)
        )
    refused(
        lambda: module.stage(
            source, root / "cross", HERE / "2149-next-nav-gate.js", url, "https://other.invalid/"
        )
    )
    (root / "occupied-manifest.json").write_text("preserve")
    refused(
        lambda: module.stage(source, root / "occupied", HERE / "2149-next-nav-gate.js", url, base)
    )
    collision = source / manifest["added_gate_path"]
    collision.write_bytes(b"existing original asset")
    refused(
        lambda: module.stage(source, root / "collision", HERE / "2149-next-nav-gate.js", url, base)
    )
    assert collision.read_bytes() == b"existing original asset"
    collision.unlink()
    csp = ["default-src 'self'; script-src 'self'; object-src 'none'"]
    original_response = {
        "url": url,
        "final_url": url,
        "status": 200,
        "redirect_chain": [],
        "base_uri": base,
        "csp_headers": csp,
        "content_type": "text/html; charset=utf-8",
        "body_path": str(source / "index.html"),
    }
    evidence = {
        "original_document": original_response,
        "staged_document": {**original_response, "body_path": str(output / "index.html")},
        "gate": {
            "url": manifest["gate_url"],
            "final_url": manifest["gate_url"],
            "status": 200,
            "redirect_chain": [],
            "resolved_script_url": manifest["gate_url"],
            "csp_headers": csp,
            "content_type": "text/javascript; charset=utf-8",
            "body_path": str(output / manifest["added_gate_path"]),
        },
        "loaded_original_resource_paths": ["assets/app.js", "assets/app.css"],
        "loaded_original_assets": {n: str(source / n) for n in ["assets/app.js", "assets/app.css"]},
    }
    assert module.verify_archives(manifest, evidence)["result"] == "PASS"
    for section, key, value in [
        ("gate", "status", 404),
        ("gate", "redirect_chain", ["redirect"]),
        ("gate", "final_url", "https://other.invalid/gate.js"),
        ("gate", "content_type", "text/html"),
        ("gate", "csp_headers", ["script-src *"]),
        ("staged_document", "base_uri", "https://other.invalid/"),
        ("staged_document", "csp_headers", ["script-src 'unsafe-inline'"]),
    ]:
        bad = copy.deepcopy(evidence)
        bad[section][key] = value
        refused(lambda bad=bad: module.verify_archives(manifest, bad))
    bad = copy.deepcopy(evidence)
    bad["loaded_original_resource_paths"].append("assets/missing.js")
    refused(lambda: module.verify_archives(manifest, bad))
    (output / manifest["added_gate_path"]).write_bytes(b"wrong gate")
    refused(lambda: module.verify_archives(manifest, evidence))
    (source / "index.html").write_bytes(
        b'<head><!-- <meta charset="UTF-8"> --><script src="app.js"></script></head>'
    )
    refused(
        lambda: module.stage(
            source, root / "bad-charset", HERE / "2149-next-nav-gate.js", url, base
        )
    )

print(
    json.dumps(
        {
            "result": "PASS",
            "checks": [
                "external classic first script, no inline bytes",
                "same-origin absolute URL despite base path",
                "exact source inventory preserved",
                "only HTML insertion plus one hashed gate",
                "output, sidecar and source-asset collisions refused",
                "comment/UTF8 parsing",
                "status/redirect/origin/MIME/CSP/base/hash/resource failures rejected",
            ],
            "limitation": "Fixture files and metadata only; not actual HTTP, browser CSP enforcement, native zoom or acceptance.",
        }
    )
)
