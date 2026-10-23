from __future__ import annotations

import importlib.util
import json
import tempfile
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("gate_stage", HERE / "2149-next-stage-document.py")
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Scripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[dict[str, str | None]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script":
            self.tags.append(dict(attrs))


with tempfile.TemporaryDirectory(prefix="2149-stage-safety-") as directory:
    root = Path(directory)
    source = root / "original"
    source.mkdir()
    (source / "assets").mkdir()
    html = (
        "<!doctype html><html><head><!-- é: example <script> -->\n"
        '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        '<script type="module" src="/assets/app.js"></script></head><body></body></html>'
    ).encode()
    (source / "index.html").write_bytes(html)
    (source / "assets/app.js").write_bytes(b'console.log("fixture only")')
    (source / "assets/app.css").write_bytes(b"body{}")
    output = root / "staged"
    manifest = module.stage(source, output, HERE / "2149-next-nav-gate.js")
    assert (source / "index.html").read_bytes() == html
    assert (output / "assets/app.js").read_bytes() == (source / "assets/app.js").read_bytes()
    assert manifest["reversible_insertion_only"]
    parsed = Scripts()
    parsed.feed((output / "index.html").read_text())
    assert len(parsed.tags) == 2
    assert parsed.tags[0].get("data-qa-2149") == "prebootstrap-nav-gate"
    assert parsed.tags[1].get("src") == "/assets/app.js"
    for bad_output in [output, source / "nested"]:
        try:
            module.stage(source, bad_output, HERE / "2149-next-nav-gate.js")
            raise AssertionError("Accepted an existing or overlapping output")
        except ValueError:
            pass
    (source / "index.html").write_bytes(
        b'<head><!-- <meta charset="UTF-8"> --><script src="app.js"></script></head>'
    )
    try:
        module.stage(source, root / "bad-charset", HERE / "2149-next-nav-gate.js")
        raise AssertionError("Accepted a commented-out charset")
    except ValueError:
        pass

print(
    json.dumps(
        {
            "result": "PASS",
            "checks": [
                "isolated staging",
                "original and assets unchanged",
                "reversible insertion",
                "commented script ignored",
                "UTF-8 offset preserved",
                "commented charset rejected",
                "existing and nested outputs refused",
            ],
            "limitation": "Fixture bytes only. No app build, browser or native efficacy run.",
        }
    )
)
